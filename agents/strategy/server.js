import "../../shared/load-env.mjs";
import express from "express";
import { getUnitDefinition } from "../../backend/services/microeconomy.js";
import {
  attachPaymentResponseHeader,
  createPaymentMiddleware,
  createPaymentResponse,
  toMicroUsdc
} from "./payment.js";
import { runStrategyUnit } from "./researcher.js";
import { createLruCache } from "../../shared/lru-cache.js";

const SERVICE_NAME = "strategy";
const app = express();
const port = Number(process.env.PORT || 3101);
const responseCache = createLruCache(200);

function assertAgentWalletConfigured() {
  if (process.env.MOCK_X402 === "true") return;
  const wallet = process.env.STRATEGY_AGENT_WALLET;
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    console.error(
      "FATAL: STRATEGY_AGENT_WALLET must be set to a valid Arc Testnet address when MOCK_X402 is not true."
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
      process.env.STRATEGY_AGENT_WALLET ||
      "0xAAA0000000000000000000000000000000000000",
    description: `Muse strategy unit: ${unitDefinition.unit}`
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
    return res.status(400).json({ error: "Unsupported strategy unit." });
  }

  req.unitDefinition = unitDefinition;
  return next();
});
app.use("/execute", (req, res, next) => {
  const { brandName } = req.body;

  if (!brandName?.trim()) {
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
// SAME idempotency string for a different unit (programmer bug or attacker
// trying to grab a stale response from a cheaper unit) gets a fresh
// execution instead of unrelated cached output.
function buildCacheKey(req) {
  if (!req.idempotencyKey) return null;
  return `${req.idempotencyKey}|${SERVICE_NAME}|${req.unitDefinition.unit}`;
}

app.use("/execute", (req, res, next) => {
  const cacheKey = buildCacheKey(req);
  if (cacheKey && responseCache.has(cacheKey)) {
    const cached = responseCache.get(cacheKey);

    // Cache hit MUST positively match the payer. The previous form short-
    // circuited to false on null cached.payer and silently served the
    // cached response to a different payer — a cross-payer cache-poisoning
    // hole. Now: re-execute on any payer ambiguity, only return cache on
    // a confirmed match.
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
    const { brandName, prompt, tier, orchestratorBrief } = req.body;

    const output = await runStrategyUnit({
      brandName: brandName.trim(),
      prompt,
      unit: req.unitDefinition.unit,
      tier,
      orchestratorBrief
    });
    const payment = await req.finalizePayment();

    const payload = {
      success: true,
      service: SERVICE_NAME,
      unit: req.unitDefinition.unit,
      output,
      payment: createPaymentResponse(
        payment,
        `${req.unitDefinition.label} payment accepted`
      )
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

    console.error("Strategy agent failed:", error.message);
    return res.status(500).json({
      error: "Strategy agent failed."
    });
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Strategy unhandledRejection:", reason?.stack || reason?.message || reason);
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  console.error("Strategy uncaughtException:", error?.stack || error?.message || error);
  process.exit(1);
});

const server = app.listen(port, () => {
  console.log(`Strategy agent listening on :${port}`);
});
server.on("error", (err) => {
  console.error(`Strategy failed to bind :${port}: ${err.code || err.message}`);
  process.exit(1);
});
