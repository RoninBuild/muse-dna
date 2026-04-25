import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_VERSION
} from "@circle-fin/x402-batching";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader
} from "@x402/core/http";

export const X402_VERSION = 2;
export const ARC_CHAIN_ID = Number(
  process.env.ARC_CHAIN_ID || process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5_042_002
);
export const ARC_CAIP2_NETWORK =
  process.env.ARC_CAIP2_NETWORK || `eip155:${ARC_CHAIN_ID}`;
export const ARC_EXPLORER_TX_BASE =
  process.env.ARC_EXPLORER_TX_BASE || "https://testnet.arcscan.app/tx";
export const ARC_USDC_TOKEN_ADDRESS =
  process.env.USDC_TOKEN_ADDRESS ||
  process.env.USDC_CONTRACT ||
  "0x3600000000000000000000000000000000000000";
export const ARC_GATEWAY_WALLET_CONTRACT =
  process.env.GATEWAY_WALLET_CONTRACT ||
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
export const X402_PAYMENT_MAX_TIMEOUT_SECONDS = Math.max(
  60,
  Number(process.env.X402_PAYMENT_MAX_TIMEOUT_SECONDS || 345_600)
);

let gatewayFacilitator = null;

// Replay cache for mock-mode nonces. Each entry holds the accepted nonce and
// an expiry so the cache cannot grow unbounded. Only the mock transport uses
// this; real Circle Gateway enforces replay protection on-chain via EIP-712.
const MOCK_NONCE_TTL_MS = Math.max(
  60_000,
  Number(process.env.MOCK_X402_NONCE_TTL_MS || 15 * 60 * 1000)
);
const MOCK_TIMESTAMP_SKEW_MS = Math.max(
  30_000,
  Number(process.env.MOCK_X402_MAX_SKEW_MS || 10 * 60 * 1000)
);
const DEFAULT_MOCK_SEED = "muse-local-demo";
const mockNonceRegistry = new Map();

function rememberMockNonce(nonce) {
  const now = Date.now();
  // Opportunistic sweep — keep the registry bounded without a separate timer.
  if (mockNonceRegistry.size > 0 && mockNonceRegistry.size % 256 === 0) {
    for (const [key, expiresAt] of mockNonceRegistry) {
      if (expiresAt <= now) {
        mockNonceRegistry.delete(key);
      }
    }
  }
  mockNonceRegistry.set(nonce, now + MOCK_NONCE_TTL_MS);
}

function mockNonceSeen(nonce) {
  const expiresAt = mockNonceRegistry.get(nonce);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    mockNonceRegistry.delete(nonce);
    return false;
  }
  return true;
}

function isMockX402Enabled() {
  return process.env.MOCK_X402 === "true";
}

function getMockX402Seed() {
  const seed = process.env.MOCK_X402_SEED || DEFAULT_MOCK_SEED;
  // Defence in depth: if someone accidentally turns on mock mode in a
  // non-development environment while leaving the demo seed, refuse to sign.
  // Predictable seeds let anyone who reads this repo forge valid mock
  // signatures for every amount.
  if (seed === DEFAULT_MOCK_SEED && process.env.NODE_ENV === "production") {
    throw new Error(
      "MOCK_X402 is enabled in production with the default demo seed. " +
      "Set MOCK_X402_SEED to a private value or disable MOCK_X402."
    );
  }
  return seed;
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function createDigest(input) {
  return createHash("sha256").update(input).digest("hex");
}

function jsonSafeStringify(value) {
  return JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current
  );
}

function getGatewayFacilitator() {
  if (!gatewayFacilitator) {
    const rawUrl = process.env.GATEWAY_API_BASE_URL || "";
    const gatewayUrl = rawUrl.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
    gatewayFacilitator = new BatchFacilitatorClient(
      gatewayUrl ? { url: gatewayUrl } : {}
    );
  }

  return gatewayFacilitator;
}

function resolvePaymentConfig(config, req) {
  if (typeof config.resolvePayment === "function") {
    const resolved = config.resolvePayment(req);

    if (!resolved) {
      throw new Error("Unable to resolve payment configuration for request.");
    }

    return resolved;
  }

  const configuredPath = Object.keys(config.payments || {})[0];
  const resolved = configuredPath ? config.payments[configuredPath] : null;

  if (!resolved) {
    throw new Error("Unable to resolve payment configuration for request.");
  }

  return resolved;
}

function buildResourceInfo(paymentConfig, req) {
  return {
    url: req.originalUrl || req.path || "/execute",
    description: paymentConfig.description || "Paid resource",
    mimeType: "application/json"
  };
}

function buildAcceptedRequirement(paymentConfig) {
  const baseRequirement = {
    scheme: "exact",
    network: paymentConfig.network || ARC_CAIP2_NETWORK,
    asset: paymentConfig.asset || ARC_USDC_TOKEN_ADDRESS,
    amount: String(paymentConfig.maxAmountRequired),
    payTo: paymentConfig.payTo,
    maxTimeoutSeconds: X402_PAYMENT_MAX_TIMEOUT_SECONDS
  };

  if (isMockX402Enabled()) {
    return {
      ...baseRequirement,
      extra: {}
    };
  }

  return {
    ...baseRequirement,
    extra: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      verifyingContract: ARC_GATEWAY_WALLET_CONTRACT
    }
  };
}

function buildMuseExtensions(req, config) {
  return {
    muse: {
      idempotencyKey: req.idempotencyKey || null,
      facilitatorUrl: config.facilitatorUrl || null,
      settlementMode: isMockX402Enabled() ? "mock" : "gateway"
    }
  };
}

function normalizeRequirementForSigning(requirement) {
  return {
    scheme: requirement.scheme,
    network: requirement.network,
    asset: requirement.asset,
    amount: String(requirement.amount),
    payTo: requirement.payTo,
    maxTimeoutSeconds: Number(requirement.maxTimeoutSeconds),
    extra: requirement.extra || {}
  };
}

function createMockSigningPayload({
  walletId,
  walletAddress,
  paymentRequirements,
  idempotencyKey,
  nonce,
  timestamp,
  mode
}) {
  return jsonSafeStringify({
    walletId,
    walletAddress,
    accepted: normalizeRequirementForSigning(paymentRequirements),
    idempotencyKey: idempotencyKey || null,
    nonce,
    timestamp,
    seed: getMockX402Seed(),
    mode
  });
}

function buildArcReceiptUrl(transaction, network) {
  if (!transaction || network !== ARC_CAIP2_NETWORK || !String(transaction).startsWith("0x")) {
    return null;
  }

  return `${ARC_EXPLORER_TX_BASE}/${transaction}`;
}

function createPaymentRecord({
  transaction,
  amount,
  network,
  payer = null,
  note = null,
  paymentResponse
}) {
  const normalizedAmount = String(amount);
  const normalizedTransaction = String(transaction);

  return {
    txHash: normalizedTransaction,
    transaction: normalizedTransaction,
    amount: normalizedAmount,
    amountUsdc: Number(normalizedAmount) / 1_000_000,
    network,
    payer,
    walletAddress: payer,
    arcUrl: buildArcReceiptUrl(normalizedTransaction, network),
    note,
    paymentResponse
  };
}

function requirementsMatch(left, right) {
  if (!left || !right) {
    return false;
  }

  const keys = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"];
  for (const key of keys) {
    if (String(left[key]) !== String(right[key])) {
      return false;
    }
  }

  const leftExtra = left.extra || {};
  const rightExtra = right.extra || {};
  const extraKeys = new Set([...Object.keys(leftExtra), ...Object.keys(rightExtra)]);

  for (const key of extraKeys) {
    if (String(leftExtra[key] ?? "") !== String(rightExtra[key] ?? "")) {
      return false;
    }
  }

  return true;
}

function buildChallengeBody(paymentRequired, error = null) {
  return error ? { ...paymentRequired, error } : paymentRequired;
}

function sendPaymentChallenge(res, paymentRequired, error = null, statusCode = 402) {
  res.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
  return res.status(statusCode).json(buildChallengeBody(paymentRequired, error));
}

function extractExpectedRequirement(paymentRequired, paymentPayload) {
  const accepted = paymentPayload?.accepted;
  if (!accepted) {
    return null;
  }

  return paymentRequired.accepts.find((requirement) =>
    requirementsMatch(requirement, accepted)
  ) || null;
}

function validateMockPayment(paymentPayload, paymentRequirements, paymentRequired) {
  const payload = paymentPayload?.payload;
  const idempotencyKey = paymentRequired.extensions?.muse?.idempotencyKey || null;

  if (!payload || typeof payload !== "object") {
    throw new Error("Missing x402 payment payload");
  }

  const requiredKeys = [
    "walletId",
    "walletAddress",
    "nonce",
    "timestamp",
    "signature",
    "txHash",
    "mode"
  ];

  for (const key of requiredKeys) {
    if (!payload[key]) {
      throw new Error(`Missing mock payment field: ${key}`);
    }
  }

  if (payload.mode !== "mock") {
    throw new Error("Unsupported mock payment mode");
  }

  if (!requirementsMatch(paymentPayload.accepted, paymentRequirements)) {
    throw new Error("Payment requirements do not match this x402 challenge");
  }

  if (paymentPayload.resource?.url !== paymentRequired.resource.url) {
    throw new Error("Payment resource does not match this x402 challenge");
  }

  if (
    idempotencyKey &&
    paymentPayload.extensions?.muse?.idempotencyKey !== idempotencyKey
  ) {
    throw new Error("Payment idempotency key does not match this x402 challenge");
  }

  // Timestamp freshness — reject signatures outside the skew window so
  // attackers cannot capture-and-replay a weeks-old mock authorization. The
  // window intentionally covers both directions to tolerate clock drift.
  const parsedTimestamp = Date.parse(String(payload.timestamp));
  if (!Number.isFinite(parsedTimestamp)) {
    throw new Error("Invalid mock x402 timestamp");
  }
  if (Math.abs(Date.now() - parsedTimestamp) > MOCK_TIMESTAMP_SKEW_MS) {
    throw new Error("Mock x402 payment timestamp is outside the accepted window");
  }

  // Per-nonce replay protection — mock mode is not backed by an on-chain
  // settlement, so we must reject any nonce we have already honoured.
  if (mockNonceSeen(payload.nonce)) {
    throw new Error("Mock x402 payment nonce has already been used");
  }

  const signingPayload = createMockSigningPayload({
    walletId: payload.walletId,
    walletAddress: payload.walletAddress,
    paymentRequirements,
    idempotencyKey,
    nonce: payload.nonce,
    timestamp: payload.timestamp,
    mode: payload.mode
  });
  const expectedSignature = `sig_${createDigest(signingPayload)}`;
  const expectedTxHash = `0x${createDigest(`${expectedSignature}:${payload.nonce}`).slice(0, 64)}`;

  if (!timingSafeStringEqual(payload.signature, expectedSignature)) {
    throw new Error("Invalid mock x402 signature");
  }

  if (!timingSafeStringEqual(payload.txHash, expectedTxHash)) {
    throw new Error("Invalid mock x402 transaction reference");
  }

  // Commit the nonce only after the signature and tx hash have been
  // validated — otherwise an attacker could burn arbitrary nonces just by
  // sending random bytes.
  rememberMockNonce(payload.nonce);

  const paymentResponse = {
    success: true,
    payer: payload.walletAddress,
    amount: String(paymentRequirements.amount),
    network: paymentRequirements.network,
    transaction: payload.txHash
  };

  return createPaymentRecord({
    transaction: payload.txHash,
    amount: paymentRequirements.amount,
    network: paymentRequirements.network,
    payer: payload.walletAddress,
    note: "Mock x402 payment verified locally",
    paymentResponse
  });
}

function isRetryableGatewayError(error) {
  const message = String(error?.message || "");
  return /Unexpected token|rate.?limit|429|503|502|504|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|aborted/i.test(message);
}

async function withGatewayRetry(operation, description, maxAttempts = 5, baseDelayMs = 3_000) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableGatewayError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1_000);
      console.warn(`${description} retry ${attempt}/${maxAttempts} after transient Gateway error: ${error.message.slice(0, 120)} (backing off ${delayMs}ms)`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

async function settleGatewayPayment(paymentPayload, paymentRequirements) {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const settleResult = await withGatewayRetry(
    () => getGatewayFacilitator().settle(paymentPayload, paymentRequirements),
    "Gateway settlement"
  );

  if (!settleResult?.success) {
    throw new Error(
      settleResult?.errorMessage ||
      settleResult?.errorReason ||
      "Circle Gateway settlement failed"
    );
  }

  // Gateway success must carry a non-empty transaction reference — anything
  // else is an ambiguous receipt we refuse to persist.
  if (!settleResult.transaction || typeof settleResult.transaction !== "string" || !settleResult.transaction.trim()) {
    throw new Error("Circle Gateway returned success with no transaction reference");
  }

  const payer =
    settleResult.payer ||
    paymentPayload?.payload?.authorization?.from ||
    null;
  const amount = settleResult.amount || paymentRequirements.amount;
  const paymentResponse = {
    success: true,
    payer,
    amount: String(amount),
    network: settleResult.network || paymentRequirements.network,
    transaction: settleResult.transaction
  };

  return createPaymentRecord({
    transaction: settleResult.transaction,
    amount,
    network: settleResult.network || paymentRequirements.network,
    payer,
    note: "Circle Gateway accepted the x402 payment",
    paymentResponse
  });
}

async function verifyGatewayPayment(paymentPayload, paymentRequirements) {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const verifyResult = await withGatewayRetry(
    () => getGatewayFacilitator().verify(paymentPayload, paymentRequirements),
    "Gateway verify"
  );

  if (!verifyResult?.isValid) {
    throw new Error(
      verifyResult?.invalidReason ||
      "Circle Gateway payment verification failed"
    );
  }

  return {
    payer:
      verifyResult.payer ||
      paymentPayload?.payload?.authorization?.from ||
      null,
    amount: String(paymentRequirements.amount),
    network: paymentRequirements.network
  };
}


export function toMicroUsdc(amountUsdc) {
  return String(Math.round(Number(amountUsdc || 0) * 1_000_000));
}

export function createMockX402Scheme({ walletId, walletAddress }) {
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version, paymentRequirements, context = {}) {
      const nonce = randomUUID();
      const timestamp = new Date().toISOString();
      const idempotencyKey = context.extensions?.muse?.idempotencyKey || null;
      const signingPayload = createMockSigningPayload({
        walletId,
        walletAddress,
        paymentRequirements,
        idempotencyKey,
        nonce,
        timestamp,
        mode: "mock"
      });
      const signature = `sig_${createDigest(signingPayload)}`;
      const txHash = `0x${createDigest(`${signature}:${nonce}`).slice(0, 64)}`;

      return {
        x402Version,
        payload: {
          mode: "mock",
          walletId,
          walletAddress,
          nonce,
          timestamp,
          signature,
          txHash
        }
      };
    }
  };
}

export function buildPaymentRequired(config, req) {
  const paymentConfig = resolvePaymentConfig(config, req);
  const paymentRequirements = buildAcceptedRequirement(paymentConfig);

  return {
    x402Version: X402_VERSION,
    resource: buildResourceInfo(paymentConfig, req),
    accepts: [paymentRequirements],
    extensions: buildMuseExtensions(req, config)
  };
}

export function createPaymentMiddleware(config) {
  return async (req, res, next) => {
    let paymentRequired;

    try {
      paymentRequired = buildPaymentRequired(config, req);
    } catch (error) {
      return res.status(400).json({
        error: error.message || "Unable to build payment requirements"
      });
    }

    const paymentSignature = req.get("PAYMENT-SIGNATURE");

    if (!paymentSignature) {
      return sendPaymentChallenge(res, paymentRequired);
    }

    let paymentPayload;
    try {
      paymentPayload = decodePaymentSignatureHeader(paymentSignature);
    } catch {
      return sendPaymentChallenge(res, paymentRequired, "Invalid PAYMENT-SIGNATURE");
    }

    const paymentRequirements = extractExpectedRequirement(paymentRequired, paymentPayload);
    if (!paymentRequirements) {
      return sendPaymentChallenge(
        res,
        paymentRequired,
        "Payment requirements do not match this x402 challenge"
      );
    }

    let verifiedPayment = null;
    try {
      verifiedPayment = isMockX402Enabled()
        ? validateMockPayment(paymentPayload, paymentRequirements, paymentRequired)
        : await verifyGatewayPayment(paymentPayload, paymentRequirements);
    } catch (error) {
      return sendPaymentChallenge(
        res,
        paymentRequired,
        error.message || "Payment verification failed"
      );
    }

    req.verifiedPayment = verifiedPayment;
    req.finalizePayment = async () => {
      try {
        if (req.payment) {
          return req.payment;
        }

        const payment = isMockX402Enabled()
          ? verifiedPayment
          : await settleGatewayPayment(paymentPayload, paymentRequirements);

        req.payment = payment;
        res.set(
          "PAYMENT-RESPONSE",
          encodePaymentResponseHeader(payment.paymentResponse)
        );

        return payment;
      } catch (error) {
        const paymentError = new Error(error.message || "Payment verification failed");
        paymentError.sendPaymentChallenge = () =>
          sendPaymentChallenge(
            res,
            paymentRequired,
            paymentError.message || "Payment verification failed"
          );
        throw paymentError;
      }
    };

    return next();
  };
}

export function createPaymentResponse(payment, note = null) {
  return {
    txHash: payment.txHash,
    transaction: payment.transaction,
    amountUsdc: Number(payment.amount) / 1_000_000,
    arcUrl: payment.arcUrl,
    network: payment.network,
    payer: payment.payer || null,
    note: note || payment.note || null
  };
}

export function attachPaymentResponseHeader(res, payment) {
  if (payment?.paymentResponse) {
    res.set(
      "PAYMENT-RESPONSE",
      encodePaymentResponseHeader(payment.paymentResponse)
    );
  }
}
