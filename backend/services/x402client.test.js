import assert from "node:assert/strict";
import test from "node:test";
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader
} from "@x402/core/http";
import { createCircleWalletClient } from "./circleWallet.js";
import { callAgentWithX402 } from "./x402client.js";

process.env.MOCK_X402 = "true";

test("callAgentWithX402 performs the 402 retry flow with signed proof", async () => {
  const requests = [];
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: "/execute",
      description: "Mock agent payment",
      mimeType: "application/json"
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:5042002",
        asset: "0xusdc",
        amount: "50000",
        payTo: "0xpayee",
        maxTimeoutSeconds: 345600,
        extra: {}
      }
    ],
    extensions: {
      muse: {
        idempotencyKey: "task-1:search:news-scan",
        settlementMode: "mock"
      }
    }
  };

  const fetchImpl = async (_url, options) => {
    requests.push(options);

    if (requests.length === 1) {
      return {
        status: 402,
        ok: false,
        headers: {
          get(name) {
            if (name === "PAYMENT-REQUIRED") {
              return encodePaymentRequiredHeader(paymentRequired);
            }

            return null;
          }
        },
        async json() {
          return paymentRequired;
        }
      };
    }

    return {
      ok: true,
      headers: {
        get(name) {
          if (name === "PAYMENT-RESPONSE") {
            return encodePaymentResponseHeader({
              success: true,
              payer: "0xwallet",
              amount: "50000",
              network: "eip155:5042002",
              transaction: "0xverified"
            });
          }

          return null;
        }
      },
      async json() {
        return {
          success: true,
          payment: {
            amountUsdc: 0.05
          }
        };
      }
    };
  };

  const result = await callAgentWithX402({
    url: "http://localhost:3102/execute",
    payload: {
      brandName: "AutoCRM",
      idempotencyKey: "task-1:search:news-scan"
    },
    agentName: "fast_search",
    fetchImpl,
    circleWalletClient: createCircleWalletClient({
      walletAddress: "0xwallet",
      walletId: "wallet-1"
    })
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers["content-type"], "application/json");
  assert.ok(requests[1].headers["PAYMENT-SIGNATURE"]);
  const proof = JSON.parse(
    Buffer.from(requests[1].headers["PAYMENT-SIGNATURE"], "base64").toString("utf8")
  );
  assert.equal(proof.payload.walletAddress, "0xwallet");
  assert.equal(proof.extensions.muse.idempotencyKey, "task-1:search:news-scan");
  assert.equal(result.success, true);
  assert.equal(result.payment.txHash, "0xverified");
  assert.equal(result.payment.network, "eip155:5042002");
});

test("callAgentWithX402 can require an x402 challenge", async () => {
  await assert.rejects(
    () =>
      callAgentWithX402({
        url: "http://localhost:3102/execute",
        payload: { brandName: "AutoCRM" },
        agentName: "fast_search",
        requireChallenge: true,
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              success: true,
              payment: {
                txHash: "0xverified",
                amountUsdc: 0.05
              }
            };
          }
        })
      }),
    /without an x402 payment challenge/
  );
});

test("callAgentWithX402 rejects challenges for an unexpected seller wallet", async () => {
  await assert.rejects(
    () =>
      callAgentWithX402({
        url: "http://localhost:3102/execute",
        payload: {
          brandName: "AutoCRM",
          idempotencyKey: "task-1:search:news-scan"
        },
        agentName: "fast_search",
        agentWalletAddress: "0xexpected",
        fetchImpl: async () => ({
          status: 402,
          ok: false,
          headers: {
            get(name) {
              if (name === "PAYMENT-REQUIRED") {
                return encodePaymentRequiredHeader({
                  x402Version: 2,
                  resource: {
                    url: "/execute",
                    description: "Mock agent payment",
                    mimeType: "application/json"
                  },
                  accepts: [
                    {
                      scheme: "exact",
                      network: "eip155:5042002",
                      asset: "0xusdc",
                      amount: "50000",
                      payTo: "0xunexpected",
                      maxTimeoutSeconds: 345600,
                      extra: {}
                    }
                  ]
                });
              }

              return null;
            }
          },
          async json() {
            return null;
          }
        })
      }),
    /unexpected wallet/
  );
});

test("callAgentWithX402 times out stalled requests", async () => {
  await assert.rejects(
    () =>
      callAgentWithX402({
        url: "http://localhost:3102/execute",
        payload: { brandName: "AutoCRM" },
        agentName: "fast_search",
        timeoutMs: 20,
        fetchImpl: async (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              const error = new Error("This operation was aborted");
              error.name = "AbortError";
              reject(error);
            });
          })
      }),
    /payment discovery timed out/
  );
});

test("callAgentWithX402 times out stalled response bodies after headers arrive", async () => {
  await assert.rejects(
    () =>
      callAgentWithX402({
        url: "http://localhost:3102/execute",
        payload: { brandName: "AutoCRM" },
        agentName: "fast_search",
        timeoutMs: 20,
        fetchImpl: async () => ({
          status: 402,
          ok: false,
          headers: {
            get() {
              return null;
            }
          },
          async json() {
            return new Promise(() => {});
          }
        })
      }),
    /payment challenge body timed out/
  );
});

test("circle wallet mock receipts stay unique for repeated identical payloads", async () => {
  const wallet = createCircleWalletClient({
    walletAddress: "0xwallet",
    walletId: "wallet-1"
  });

  const first = await wallet.signForX402({
    amount: "5000",
    asset: "0xusdc",
    payTo: "0xpayee",
    network: "eip155:5042002",
    resource: "/execute",
    description: "repeatable payload"
  });

  const second = await wallet.signForX402({
    amount: "5000",
    asset: "0xusdc",
    payTo: "0xpayee",
    network: "eip155:5042002",
    resource: "/execute",
    description: "repeatable payload"
  });

  assert.notEqual(first.txHash, second.txHash);
  assert.notEqual(first.nonce, second.nonce);
});
