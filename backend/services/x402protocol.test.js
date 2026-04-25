import assert from "node:assert/strict";
import test from "node:test";
import { createCircleWalletClient } from "./circleWallet.js";
import {
  buildPaymentRequired,
  createPaymentMiddleware
} from "./x402protocol.js";

process.env.MOCK_X402 = "true";

function createMockResponse() {
  return {
    headers: new Map(),
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers.set(name, value);
      return this;
    },
    get(name) {
      return this.headers.get(name) || null;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test("createPaymentMiddleware defers settlement until finalizePayment is called", async () => {
  const config = {
    facilitatorUrl: "https://gateway-api-testnet.circle.com",
    payments: {
      "/execute": {
        maxAmountRequired: "5000",
        asset: "0x3600000000000000000000000000000000000000",
        payTo: "0xAAA0000000000000000000000000000000000000",
        description: "Mock paid resource"
      }
    }
  };
  const unsignedRequest = {
    originalUrl: "/execute",
    path: "/execute",
    idempotencyKey: "task-1:strategy:product-summary"
  };
  const walletClient = createCircleWalletClient({
    walletAddress: "0xFEE0000000000000000000000000000000000000",
    walletId: "wallet-1"
  });
  const paymentRequired = buildPaymentRequired(config, unsignedRequest);
  const paymentPayload = await walletClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = walletClient.encodePaymentSignatureHeader(paymentPayload);
  const req = {
    ...unsignedRequest,
    get(name) {
      return paymentHeaders[name] || null;
    }
  };
  const res = createMockResponse();
  let nextCalled = false;
  const middleware = createPaymentMiddleware(config);

  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.payment, undefined);
  assert.equal(typeof req.finalizePayment, "function");
  assert.equal(req.verifiedPayment.payer, "0xFEE0000000000000000000000000000000000000");
  assert.equal(res.get("PAYMENT-RESPONSE"), null);

  const payment = await req.finalizePayment();

  assert.equal(req.payment.txHash, payment.txHash);
  assert.ok(/^0x/i.test(payment.txHash));
  assert.equal(
    res.get("PAYMENT-RESPONSE") !== null,
    true,
    "Settlement confirmation header should only appear after finalizePayment()"
  );
});

test("mock x402 rejects a replayed signed authorization (same nonce twice)", async () => {
  const config = {
    payments: {
      "/execute": {
        maxAmountRequired: "5000",
        asset: "0x3600000000000000000000000000000000000000",
        payTo: "0xAAA0000000000000000000000000000000000000",
        description: "Replay test"
      }
    }
  };
  const request = {
    originalUrl: "/execute",
    path: "/execute",
    idempotencyKey: "task-replay:strategy:product-summary"
  };
  const walletClient = createCircleWalletClient({
    walletAddress: "0xFEE0000000000000000000000000000000000000",
    walletId: "wallet-replay"
  });
  const paymentRequired = buildPaymentRequired(config, request);
  const paymentPayload = await walletClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = walletClient.encodePaymentSignatureHeader(paymentPayload);
  const middleware = createPaymentMiddleware(config);

  const firstReq = { ...request, get: (name) => paymentHeaders[name] || null };
  const firstRes = createMockResponse();
  let firstNext = false;
  await middleware(firstReq, firstRes, () => { firstNext = true; });
  assert.equal(firstNext, true, "first submission must pass");

  const secondReq = { ...request, get: (name) => paymentHeaders[name] || null };
  const secondRes = createMockResponse();
  let secondNext = false;
  await middleware(secondReq, secondRes, () => { secondNext = true; });

  assert.equal(secondNext, false, "second submission with same nonce must be rejected");
  assert.equal(secondRes.statusCode, 402);
  const errorMessage = String(secondRes.body?.error || "");
  assert.match(errorMessage, /nonce has already been used/i);
});

test("mock x402 rejects a payment whose timestamp is outside the skew window", async () => {
  const previousSkew = process.env.MOCK_X402_MAX_SKEW_MS;
  process.env.MOCK_X402_MAX_SKEW_MS = "60000";

  // Reload the module with the new env so the skew constant is recomputed.
  const freshModule = await import(`./x402protocol.js?stale=${Date.now()}`);
  try {
    const config = {
      payments: {
        "/execute": {
          maxAmountRequired: "5000",
          asset: "0x3600000000000000000000000000000000000000",
          payTo: "0xAAA0000000000000000000000000000000000000",
          description: "Stale test"
        }
      }
    };
    const request = {
      originalUrl: "/execute",
      path: "/execute",
      idempotencyKey: "task-stale:strategy:product-summary"
    };

    const paymentRequired = freshModule.buildPaymentRequired(config, request);
    // Forge a signature that uses a stale timestamp. We use the same mock
    // scheme but backdate the payload by an hour so freshness fails.
    const stalePayload = await createCircleWalletClient({
      walletAddress: "0xFEE0000000000000000000000000000000000000",
      walletId: "wallet-stale"
    }).createPaymentPayload(paymentRequired);
    stalePayload.payload.timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const middleware = freshModule.createPaymentMiddleware(config);
    const req = {
      ...request,
      get: (name) =>
        name === "PAYMENT-SIGNATURE"
          ? Buffer.from(JSON.stringify(stalePayload)).toString("base64")
          : null
    };
    const res = createMockResponse();
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false, "stale authorization must not pass through");
    assert.equal(res.statusCode, 402);
  } finally {
    if (previousSkew === undefined) {
      delete process.env.MOCK_X402_MAX_SKEW_MS;
    } else {
      process.env.MOCK_X402_MAX_SKEW_MS = previousSkew;
    }
  }
});
