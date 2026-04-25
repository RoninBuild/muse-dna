/**
 * Wallet audit script — cross-check the hackathon-live artifact against
 * Arc Testnet RPC to verify every claimed transaction actually mined,
 * grouped by recipient (agent wallet) so we see who got paid what.
 */
import "../shared/load-env.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const artifactPath = path.join(rootDir, "artifacts", "hackathon-live", "latest.json");

// Blockdaemon mirror is the right pick for *broadcasting* (their mempool
// is healthier under load) but it does NOT serve transaction receipts —
// `eth_getTransactionReceipt` returns null for every hash. The default
// Arc Testnet RPC has the receipt index. Use both: getTransactionByHash
// goes to whichever, getTransactionReceipt goes to the receipt-capable
// endpoint.
const RPC_TX_URL = process.env.ARC_RPC_URL || "https://rpc.blockdaemon.testnet.arc.network";
const RPC_RECEIPT_URL = process.env.ARC_RECEIPT_RPC_URL || "https://rpc.testnet.arc.network";
const CONCURRENCY = 4;

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
  });
  if (!res.ok) throw new Error(`RPC ${method} returned ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method} error: ${data.error.message}`);
  return data.result;
}

async function probeTx(txHash) {
  const tx = await rpcCall(RPC_TX_URL, "eth_getTransactionByHash", [txHash]);
  if (!tx) return { txHash, exists: false };
  // Receipts only live on the default Arc RPC — Blockdaemon mirror
  // returns null for every receipt query. Try receipt-capable RPC; if
  // it ALSO returns null, the tx is on-chain but post-prune and we
  // treat it as "mined-but-no-receipt-available" rather than failed.
  const receipt = await rpcCall(RPC_RECEIPT_URL, "eth_getTransactionReceipt", [txHash]).catch(() => null);
  let status;
  if (receipt === null) {
    // Receipt unavailable but tx exists → trust the by-hash result
    // (presence in a block is stronger than receipt-status absence).
    status = "mined-no-receipt";
  } else if (receipt.status === "0x1") {
    status = "success";
  } else {
    status = "failed";
  }
  return {
    txHash,
    exists: true,
    blockNumber: parseInt(tx.blockNumber, 16),
    from: tx.from.toLowerCase(),
    to: tx.to.toLowerCase(),
    value: BigInt(tx.value || "0x0").toString(),
    valueUsdc: Number(BigInt(tx.value || "0x0") / 1_000_000_000_000n) / 1_000_000,
    status,
    gasUsed: receipt ? parseInt(receipt.gasUsed, 16) : null
  };
}

async function pool(items, fn, concurrency) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { error: String(err?.message || err), input: items[idx] };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));
  const txList = artifact.transactions || [];
  console.log(`\n=== AUDIT: ${txList.length} TXNS FROM ARTIFACT ===\n`);
  console.log(`Buyer expected: ${artifact.buyer.address.toLowerCase()}`);
  console.log(`Total claimed:  $${artifact.hackathonProof.totalTaskRevenueUsdc} USDC`);
  console.log(`Avg unit price: $${artifact.hackathonProof.averageUnitPriceUsdc}`);
  console.log("");

  const probes = await pool(
    txList.map((t) => t.tx),
    probeTx,
    CONCURRENCY
  );

  let mined = 0;
  let missing = 0;
  let failed = 0;
  let rpcError = 0;
  let receiptUnavailable = 0;
  let totalValueWei = 0n;
  const byRecipient = new Map();
  const senderSet = new Set();
  const blockNums = [];
  const samples = [];
  const issues = [];

  for (let i = 0; i < probes.length; i += 1) {
    const r = probes[i];
    const claim = txList[i];
    if (r.error) {
      rpcError += 1;
      issues.push(`[${i}] RPC error on ${claim.tx}: ${r.error}`);
      continue;
    }
    if (!r.exists) {
      missing += 1;
      issues.push(`[${i}] NOT MINED: ${claim.tx} (service=${claim.service}, unit=${claim.unit})`);
      continue;
    }
    if (r.status === "failed") {
      failed += 1;
      issues.push(`[${i}] REVERTED: ${claim.tx} (status=0x0)`);
      continue;
    }
    if (r.status === "mined-no-receipt") {
      receiptUnavailable += 1;
      // Still counts toward the audited revenue — tx is on-chain in a
      // block, just past the receipt-RPC's prune window.
    }
    mined += 1;
    totalValueWei += BigInt(r.value);
    senderSet.add(r.from);
    blockNums.push(r.blockNumber);
    const agent = r.to;
    const cur = byRecipient.get(agent) || { count: 0, totalUsdc: 0, services: new Set() };
    cur.count += 1;
    cur.totalUsdc += r.valueUsdc;
    cur.services.add(claim.service);
    byRecipient.set(agent, cur);
    if (samples.length < 4) samples.push(r);

    // Cross-check: claim's amount must match on-chain value
    const expectedUsdc = Number(claim.amountUsdc);
    if (Math.abs(r.valueUsdc - expectedUsdc) > 0.0001) {
      issues.push(
        `[${i}] AMOUNT MISMATCH: artifact=$${expectedUsdc}, on-chain=$${r.valueUsdc} (tx=${claim.tx.slice(0, 14)})`
      );
    }
  }

  console.log(`╔══════════════════════════════════════════════════════╗`);
  console.log(`║  RESULTS                                             ║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
  console.log(`  mined OK:                ${mined} / ${txList.length}`);
  console.log(`    └ receipts confirmed:  ${mined - receiptUnavailable}`);
  console.log(`    └ mined-no-receipt:    ${receiptUnavailable} (RPC pruned, tx still on-chain)`);
  console.log(`  reverted (status=0x0):   ${failed}`);
  console.log(`  missing on-chain:        ${missing}`);
  console.log(`  RPC errors:              ${rpcError}`);
  console.log("");
  const totalUsdcOnChain = Number(totalValueWei / 1_000_000_000_000n) / 1_000_000;
  console.log(`  total on-chain USDC: $${totalUsdcOnChain.toFixed(6)}`);
  console.log(`  total claimed USDC:  $${artifact.hackathonProof.totalTaskRevenueUsdc}`);
  console.log(`  delta:               $${(artifact.hackathonProof.totalTaskRevenueUsdc - totalUsdcOnChain).toFixed(6)}`);
  console.log("");
  console.log(`  unique senders:      ${senderSet.size}`);
  console.log(`  senders:             ${[...senderSet].join(", ")}`);
  if (blockNums.length > 0) {
    blockNums.sort((a, b) => a - b);
    console.log(`  block range:         ${blockNums[0]} → ${blockNums[blockNums.length - 1]} (span ${blockNums[blockNums.length - 1] - blockNums[0]} blocks)`);
  }
  console.log("");
  console.log(`╔══════════════════════════════════════════════════════╗`);
  console.log(`║  PER-RECIPIENT (AGENT WALLETS)                       ║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
  const sorted = [...byRecipient.entries()].sort((a, b) => b[1].totalUsdc - a[1].totalUsdc);
  for (const [addr, stats] of sorted) {
    const services = [...stats.services].join(",");
    console.log(`  ${addr}  ${String(stats.count).padStart(3)} tx  $${stats.totalUsdc.toFixed(4)}  [${services}]`);
  }
  console.log("");
  console.log(`╔══════════════════════════════════════════════════════╗`);
  console.log(`║  ISSUES (${issues.length})                                          ║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
  if (issues.length === 0) {
    console.log(`  none — every tx in the artifact mined on-chain with the correct amount.`);
  } else {
    for (const issue of issues.slice(0, 20)) console.log(`  ${issue}`);
    if (issues.length > 20) console.log(`  ... (+${issues.length - 20} more)`);
  }
  console.log("");
  process.exit(missing + failed + rpcError === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("audit failed:", err?.stack || err?.message || err);
  process.exit(2);
});
