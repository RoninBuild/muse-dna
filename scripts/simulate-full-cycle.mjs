#!/usr/bin/env node
/**
 * simulate-full-cycle.mjs
 *
 * End-to-end simulation of the Muse x402 workflow using the configured
 * ORCHESTRATOR_PRIVATE_KEY and Circle credentials from .env.
 *
 * Steps:
 *   1. Check backend health
 *   2. Create (or reuse) an orchestrator wallet
 *   3. Check Gateway balance
 *   4. Submit a task (AutoCRM launch)
 *   5. Poll task status until terminal (completed / failed)
 *   6. Print ledger summary + DNA blocks + receipts
 *
 * Usage:
 *   node scripts/simulate-full-cycle.mjs
 */

import "../shared/load-env.mjs";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:3001";
const MAIN_WALLET_ADDRESS = "0x2705Db53C77e0967e10B131cc6fA2B7F79F45D03"; // derived from ORCHESTRATOR_PRIVATE_KEY

const PRESET_PROMPT =
  "Create a Twitter post and banner for AutoCRM, an AI dashboard for sales teams.";

const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_ATTEMPTS = 120;

async function api(method, path, body) {
  const url = `${BACKEND_URL}${path}`;
  const init = {
    method,
    headers: { "content-type": "application/json" }
  };
  if (body) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${data?.error || data?.detail || text || res.statusText}`);
  }
  return data;
}

function logStep(step, message, extra = "") {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
  console.log(`[${timestamp}] ${String(step).padStart(2, "0")}. ${message}${extra ? " " + extra : ""}`);
}

async function runSimulation() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Muse Full-Cycle Simulation");
  console.log("  Wallet:", MAIN_WALLET_ADDRESS);
  console.log("  Mode:", process.env.MOCK_X402 === "true" ? "MOCK x402" : "LIVE Circle Gateway");
  console.log("═══════════════════════════════════════════════════\n");

  // ── Step 1: Health check ──
  logStep(1, "Backend health check...");
  const health = await api("GET", "/health");
  if (health.status !== "ok" && health.status !== "degraded") {
    throw new Error(`Backend unhealthy: ${JSON.stringify(health)}`);
  }
  logStep(1, "Backend is", health.status.toUpperCase());

  // ── Step 2: Wallet status ──
  logStep(2, "Checking wallet runtime mode...");
  const status = await api("GET", "/api/wallet/status");
  logStep(2, "Mode:", `${status.mode} | fundingEnabled: ${status.fundingEnabled}`);

  // ── Step 3: Create / reuse orchestrator ──
  logStep(3, "Creating session orchestrator...");
  const wallets = await api("POST", "/api/wallet/create", {
    mainWalletAddress: MAIN_WALLET_ADDRESS
  });
  const payerId = wallets.payer?.id;
  const payerAddress = wallets.payer?.address;
  logStep(3, "Orchestrator created:", `${payerId} @ ${payerAddress}`);

  // ── Step 4: Check balance ──
  logStep(4, "Fetching Gateway balance...");
  const balance = await api("GET", `/api/wallet/${payerId}/balance`);
  logStep(
    4,
    "Balance:",
    `${balance.gatewayAvailable || balance.balance} USDC (mode: ${balance.mode || "circle"})`
  );

  // ── Step 5: Submit task ──
  logStep(5, "Submitting task...");
  // After the per-user orchestrator refactor, /api/tasks REQUIRES `mainWallet`
  // (or admin token + MUSE_SKIP_PREFLIGHT for headless). The old call form
  // here passed `sessionWallets` and `budgetUsdc` only — it now returns
  // 400 MAIN_WALLET_REQUIRED before the task is even created. We pass the
  // env-derived test wallet as `mainWallet` so the simulator stays headless
  // but routes through the canonical pre-flight + per-user signing path.
  const task = await api("POST", "/api/tasks", {
    prompt: PRESET_PROMPT,
    taskType: "twitter_post",
    budgetUsdc: 2.0,
    sessionWallets: wallets,
    mainWallet: MAIN_WALLET_ADDRESS,
    // Headless to skip the room-ready guard. The backend cross-checks this
    // against MUSE_SKIP_PREFLIGHT or x-muse-admin-token — without one of
    // those server-side opt-ins the flag is ignored, so it's safe to keep
    // here unconditionally.
    headless: true
  });
  const taskId = task.taskId;
  logStep(5, "Task created:", `ID = ${taskId}`);
  console.log(`       → Open in UI: http://localhost:3000/task/${taskId}\n`);

  // ── Step 6: Poll until terminal ──
  logStep(6, "Polling task status...");
  let terminal = false;
  let lastStepsCount = 0;
  let attempts = 0;

  while (!terminal && attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const snapshot = await api("GET", `/api/tasks/${taskId}`);
    const { task: t, steps } = snapshot;

    if (steps.length !== lastStepsCount) {
      lastStepsCount = steps.length;
      const pending = steps.filter((s) => s.status === "running").length;
      const done = steps.filter((s) => s.status === "completed").length;
      const failed = steps.filter((s) => s.status === "failed").length;
      const reused = steps.filter((s) => s.reused_from_dna).length;
      logStep(
        6,
        `Progress: ${done} done, ${failed} failed, ${reused} reused, ${pending} pending`
      );
    }

    if (t.status === "completed" || t.status === "failed") {
      terminal = true;
      logStep(6, "Task terminal:", t.status.toUpperCase());

      console.log("\n═══════════════════════════════════════════════════");
      console.log("  RESULT SUMMARY");
      console.log("═══════════════════════════════════════════════════");
      console.log(`  Brand name      : ${t.brand_name || "N/A"}`);
      console.log(`  Total spent     : ${Number(t.total_spent_usdc || 0).toFixed(6)} USDC`);
      console.log(`  Estimated cost  : ${Number(t.estimated_cost_usdc || 0).toFixed(6)} USDC`);
      console.log(`  Savings         : ${Number(t.savings_usdc || 0).toFixed(6)} USDC`);
      console.log(`  DNA created     : ${t.dna_file_created || "N/A"}`);
      console.log(`  Steps completed : ${steps.filter((s) => s.status === "completed").length}`);
      console.log(`  Steps failed    : ${steps.filter((s) => s.status === "failed").length}`);
      console.log(`  Steps reused    : ${steps.filter((s) => s.reused_from_dna).length}`);

      const paidSteps = steps.filter((s) => s.status === "completed" && !s.reused_from_dna);
      if (paidSteps.length > 0) {
        console.log("\n  PAID MICRO-RECEIPTS");
        for (const s of paidSteps.slice(0, 8)) {
          const txRef = s.tx_hash ? `${s.tx_hash.slice(0, 18)}...` : "N/A";
          console.log(
            `    - ${s.service_name}.${s.unit_name}  ${Number(s.cost_usdc || 0).toFixed(6)} USDC  →  ${txRef}`
          );
        }
        if (paidSteps.length > 8) {
          console.log(`    ... and ${paidSteps.length - 8} more`);
        }
      }

      if (t.result?.text) {
        console.log("\n  GENERATED COPY (first 240 chars):");
        console.log("    " + t.result.text.slice(0, 240).replace(/\n/g, "\n    "));
      }

      if (t.result?.imageUrl) {
        console.log("\n  GENERATED IMAGE:");
        console.log("    " + t.result.imageUrl);
      }

      if (t.error_log) {
        console.log("\n  ERROR LOG:");
        console.log("    " + t.error_log);
      }

      console.log("\n═══════════════════════════════════════════════════");
      console.log("  Simulation complete.");
      console.log("═══════════════════════════════════════════════════");
    }
  }

  if (!terminal) {
    throw new Error("Task did not reach terminal status within poll timeout.");
  }
}

runSimulation().catch((err) => {
  console.error("\nSimulation failed:", err.message);
  process.exit(1);
});
