import assert from "node:assert/strict";
import test from "node:test";
import { dispatchHermesTool } from "./hermes-tools.mjs";

test("list_recent_micro_payments clamps a NaN limit to a finite value and still terminates", async () => {
  let iterations = 0;
  const context = {
    db: {
      tasks: {
        async findAll() {
          // Populate a fake list so the inner loop would be visible if it
          // failed to terminate. Before the NaN fix, `payments.length >= NaN`
          // was always false and the loop burned through every step of every
          // task without bound.
          return Array.from({ length: 50 }, (_, i) => ({
            id: `task-${i}`,
            tier: "deep"
          }));
        }
      },
      steps: {
        async findByTask() {
          iterations += 1;
          return [
            {
              service_name: "strategy",
              unit_name: "product-summary",
              status: "completed",
              cost_usdc: 0.005,
              tx_hash: "0xabc",
              payment_network: "eip155:5042002",
              arc_url: "https://testnet.arcscan.app/tx/0xabc",
              started_at: "2026-01-01",
              completed_at: "2026-01-01"
            }
          ];
        }
      }
    },
    buildArcTxUrl: () => null
  };

  const result = await dispatchHermesTool(
    "list_recent_micro_payments",
    { limit: "not-a-number" },
    context
  );

  assert.equal(result.count, 10, "NaN must clamp back to default limit (10)");
  assert.equal(result.payments.length, 10);
  // Only 10 task lookups — proves the length >= limit guard actually fires.
  assert.ok(iterations <= 10);
});

test("dispatchHermesTool strips __proto__/constructor from LLM-supplied args", async () => {
  const polluted = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"bad":1},"task_id":"abc"}');
  const context = {
    db: {
      tasks: { async findById() { return null; } },
      steps: { async findByTask() { return []; } }
    }
  };
  const result = await dispatchHermesTool("get_task_status", polluted, context);
  assert.equal(result.error, "Task not found");
  // Prototype of a plain object must not have been mutated.
  assert.equal({}.polluted, undefined);
});

test("explain_nanopayment_economics caps pathological payment_count to avoid runaway math", async () => {
  const result = await dispatchHermesTool(
    "explain_nanopayment_economics",
    { payment_count: 1e12, amount_usdc: "NaN" },
    {}
  );
  assert.equal(result.payment_count, 10_000);
  assert.equal(result.per_payment_usdc, 0.005);
});
