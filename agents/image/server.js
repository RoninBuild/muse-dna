import "../../shared/load-env.mjs";
import express from "express";
import { getUnitDefinition } from "../../backend/services/microeconomy.js";
import {
  attachPaymentResponseHeader,
  createPaymentMiddleware,
  createPaymentResponse,
  toMicroUsdc
} from "./payment.js";
import { runImageUnit } from "./generator.js";
import { createLruCache } from "../../shared/lru-cache.js";

const SERVICE_NAME = "image";
const app = express();
const port = Number(process.env.PORT || 3104);
const responseCache = createLruCache(200);

function assertAgentWalletConfigured() {
  if (process.env.MOCK_X402 === "true") return;
  const wallet = process.env.IMAGE_AGENT_WALLET;
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    console.error(
      "FATAL: IMAGE_AGENT_WALLET must be set to a valid Arc Testnet address when MOCK_X402 is not true."
    );
    process.exit(1);
  }
}
assertAgentWalletConfigured();

function resolveUnitDefinition(unitName) {
  const definition = getUnitDefinition(unitName);
  return definition?.service === SERVICE_NAME ? definition : null;
}

function createPaymentConfig(unitDefinition) {
  return {
    maxAmountRequired: toMicroUsdc(unitDefinition.price),
    asset:
      process.env.USDC_TOKEN_ADDRESS ||
      process.env.USDC_CONTRACT ||
      "0x3600000000000000000000000000000000000000",
    payTo:
      process.env.IMAGE_AGENT_WALLET ||
      "0xDDD0000000000000000000000000000000000000",
    description: `Muse image unit: ${unitDefinition.unit}`
  };
}

app.use(express.json({ limit: "256kb" }));
app.use("/execute", (req, res, next) => {
  const idempotencyKey = typeof req.body?.idempotencyKey === "string"
    ? req.body.idempotencyKey.trim()
    : "";

  req.idempotencyKey = idempotencyKey || null;
  return next();
});
app.use("/execute", (req, res, next) => {
  const unitDefinition = resolveUnitDefinition(req.body?.unit);

  if (!unitDefinition) {
    return res.status(400).json({ error: "Unsupported image unit." });
  }

  req.unitDefinition = unitDefinition;
  return next();
});
app.use("/execute", (req, res, next) => {
  const { prompt, brandName } = req.body || {};

  // Strict typeof check — `!prompt?.trim()` lets `{prompt:{trim:1}}`
  // through and crashes downstream. Match the orchestrator gateway's
  // input contract.
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt required" });
  }

  if (typeof brandName !== "string" || !brandName.trim()) {
    return res.status(400).json({ error: "brandName required" });
  }

  return next();
});
app.use(
  "/execute",
  createPaymentMiddleware({
    facilitatorUrl:
      process.env.GATEWAY_API_BASE_URL ||
      process.env.X402_FACILITATOR_URL ||
      "https://gateway-api-testnet.circle.com",
    resolvePayment: (req) => createPaymentConfig(req.unitDefinition)
  })
);
// Cache key binds idempotencyKey + service + unit so a caller reusing the
// same idempotency string across different units gets a fresh execution.
function buildCacheKey(req) {
  if (!req.idempotencyKey) return null;
  return `${req.idempotencyKey}|${SERVICE_NAME}|${req.unitDefinition.unit}`;
}

app.use("/execute", (req, res, next) => {
  const cacheKey = buildCacheKey(req);
  if (cacheKey && responseCache.has(cacheKey)) {
    const cached = responseCache.get(cacheKey);

    // Positive payer match required — null cached.payer would otherwise
    // bypass the comparison and serve cache to a different payer.
    const cachedPayer = cached.payment?.payer
      ? String(cached.payment.payer).toLowerCase()
      : null;
    const reqPayer = req.verifiedPayment?.payer
      ? String(req.verifiedPayment.payer).toLowerCase()
      : null;
    if (!cachedPayer || !reqPayer || cachedPayer !== reqPayer) {
      return next();
    }

    attachPaymentResponseHeader(res, cached.payment);
    return res.json(cached.payload);
  }

  return next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    port
  });
});

app.post("/execute", async (req, res) => {
  try {
    const { prompt, brandName, taskType, copyText, newsContext, tier } = req.body;

    const output = await runImageUnit({
      prompt: prompt.trim(),
      brandName: brandName.trim(),
      taskType: taskType || "visual",
      copyText,
      newsContext,
      unit: req.unitDefinition.unit,
      tier
    });
    const payment = await req.finalizePayment();

    const payload = {
      success: true,
      service: SERVICE_NAME,
      unit: req.unitDefinition.unit,
      output,
      payment: createPaymentResponse(payment)
    };

    const cacheKey = buildCacheKey(req);
    if (cacheKey) {
      responseCache.set(cacheKey, {
        payload,
        payment
      });
    }

    return res.json(payload);
  } catch (error) {
    if (typeof error?.sendPaymentChallenge === "function") {
      return error.sendPaymentChallenge();
    }

    console.error("Image agent failed:", error.message);
    return res.status(500).json({
      error: "Image agent failed."
    });
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Image unhandledRejection:", reason?.stack || reason?.message || reason);
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  console.error("Image uncaughtException:", error?.stack || error?.message || error);
  process.exit(1);
});

const server = app.listen(port, () => {
  console.log(`Image agent listening on :${port}`);
});
server.on("error", (err) => {
  console.error(`Image failed to bind :${port}: ${err.code || err.message}`);
  process.exit(1);
});
