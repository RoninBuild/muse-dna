import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Per-user orchestrator wallet mapping.
 *
 * Every MetaMask main wallet is pinned 1:1 to a single self-managed EVM
 * orchestrator for the lifetime of the account. The backend holds the private
 * key so it can both settle x402 micro-payments to sub-agents (during task
 * execution) and broadcast a withdraw back to the user's main wallet whenever
 * they ask for it. Without backend-side signing authority, withdraw is
 * impossible — which is why the derived-address-only design had to go.
 *
 * Storage: Postgres when reachable, in-memory Map otherwise. Private keys are
 * stored in plaintext. For a testnet hackathon demo with mock USDC this is
 * acceptable — in production you'd wrap them with KMS or an entity-secret
 * envelope before writing.
 */

const { Pool } = pg;
const DEFAULT_DATABASE_URL = "postgresql://muse:muse@localhost:5432/muse";
const pool = new Pool({ connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL });

/** @type {Map<string, {walletId: string, address: string, privateKey: string, mode: string, createdAt: string}>} */
const memoryMap = new Map();

let schemaEnsured = false;
let useMemoryOnly = false;

// ── File-backed persistence for when Postgres isn't available ──
// Without this, a backend restart would wipe the in-memory Map and mint a new
// orchestrator private key for the same MetaMask — exactly the bug the user
// hit. Writing to disk keeps the 1:1 pairing stable forever, even on a laptop
// running the demo without Docker/Postgres.
//
// Anchor the default to backend/data/ regardless of where node is started
// from. Previously this resolved relative to process.cwd(), so launching
// `node backend/index.js` from the repo root pointed at `Muse/data/...` while
// `nodemon` from inside `backend/` (the npm workspace default) pointed at
// `Muse/backend/data/...` — silently splitting the orchestrator key store
// into two files and breaking on-chain settlement for any wallet only
// written to the "wrong" half.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ORCH_STORE_PATH = resolve(__dirname, "..", "data", "orchestrator-wallets.json");
const ORCH_STORE_PATH = process.env.ORCH_WALLETS_FILE
  ? resolve(process.env.ORCH_WALLETS_FILE)
  : DEFAULT_ORCH_STORE_PATH;

function hydrateFromFile() {
  try {
    if (!existsSync(ORCH_STORE_PATH)) return;
    const raw = readFileSync(ORCH_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      let count = 0;
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === "object" && typeof (value).address === "string") {
          memoryMap.set(key, /** @type {any} */ (value));
          count += 1;
        }
      }
      if (count > 0) {
        console.log(`[orchestratorWallets] Hydrated ${count} mapping(s) from ${ORCH_STORE_PATH}`);
      }
    }
  } catch (err) {
    console.warn(`[orchestratorWallets] Failed to hydrate from ${ORCH_STORE_PATH}:`, err?.message);
  }
}
hydrateFromFile();

function flushToFile() {
  try {
    mkdirSync(dirname(ORCH_STORE_PATH), { recursive: true });
    const snapshot = Object.fromEntries(memoryMap.entries());
    // Synchronous write is fine here — this file only ever grows by one
    // entry per unique MetaMask, so writes are rare and tiny.
    writeFileSync(ORCH_STORE_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[orchestratorWallets] Failed to flush to ${ORCH_STORE_PATH}:`, err?.message);
  }
}

const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002);
const ARC_RPC_URL =
  process.env.ARC_RPC_URL ||
  process.env.NEXT_PUBLIC_ARC_RPC_URL ||
  "https://rpc.testnet.arc.network";
const ARC_EXPLORER_TX_BASE =
  process.env.ARC_EXPLORER_TX_BASE || "https://testnet.arcscan.app/tx";

const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } }
});

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC_URL) });

async function ensureSchema() {
  if (schemaEnsured || useMemoryOnly) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS orchestrator_wallets (
      main_wallet TEXT PRIMARY KEY,
      circle_wallet_id TEXT NOT NULL,
      address TEXT NOT NULL,
      private_key TEXT,
      mode VARCHAR(24) NOT NULL DEFAULT 'self-managed',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Idempotent migration — add private_key column if the table pre-dates it.
    await pool.query(`ALTER TABLE orchestrator_wallets ADD COLUMN IF NOT EXISTS private_key TEXT`);
    schemaEnsured = true;
  } catch {
    useMemoryOnly = true;
  }
}

// If the pool emits a fatal error (connection lost, bad auth after a
// restart, etc.), reset the flags so the next readMapping/writeMapping
// re-runs the schema check. Without this, a Postgres that goes down and
// comes back in a different shape would stay in memory-only mode until
// the backend is manually restarted.
pool.on("error", (err) => {
  console.warn(`[orchestratorWallets] pg pool error: ${err?.message || err}`);
  schemaEnsured = false;
  useMemoryOnly = false;
});

function normalizeMainWallet(addr) {
  if (typeof addr !== "string") throw new Error("mainWallet must be a string");
  const trimmed = addr.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw new Error("mainWallet is not a valid EVM address");
  return trimmed.toLowerCase();
}

function deriveMockAddress(mainWallet) {
  const hex = createHash("sha256").update(`muse-orchestrator-v1|${mainWallet.toLowerCase()}`).digest("hex");
  return `0x${hex.slice(-40)}`;
}

async function readMapping(mainWallet) {
  if (memoryMap.has(mainWallet)) return memoryMap.get(mainWallet);
  // Fall back to the on-disk store on a miss even when memory-only mode is
  // on — otherwise a mapping written to the file after backend start (e.g.
  // by an operator scripting the E2E flow) stays invisible until restart.
  const fileMapping = readFromFile(mainWallet);
  if (fileMapping) {
    memoryMap.set(mainWallet, fileMapping);
    return fileMapping;
  }
  if (useMemoryOnly) return null;
  try {
    const res = await pool.query(
      "SELECT circle_wallet_id, address, private_key, mode, created_at FROM orchestrator_wallets WHERE main_wallet = $1",
      [mainWallet]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    const mapping = {
      walletId: row.circle_wallet_id,
      address: row.address,
      privateKey: row.private_key || null,
      mode: row.mode,
      createdAt: row.created_at?.toISOString?.() || String(row.created_at)
    };
    memoryMap.set(mainWallet, mapping);
    return mapping;
  } catch {
    useMemoryOnly = true;
    return null;
  }
}

function readFromFile(mainWallet) {
  try {
    if (!existsSync(ORCH_STORE_PATH)) return null;
    const raw = readFileSync(ORCH_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const found = parsed[mainWallet] || parsed[mainWallet.toLowerCase()];
    if (found && /^0x[0-9a-fA-F]{40}$/.test(String(found.address || ""))) {
      return {
        walletId: found.walletId || "self-managed-file",
        address: found.address,
        privateKey: found.privateKey || null,
        mode: found.mode || "self-managed",
        createdAt: found.createdAt || new Date().toISOString()
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeMapping(mainWallet, mapping) {
  memoryMap.set(mainWallet, mapping);
  // Always persist to disk too — this keeps the mapping stable even when
  // Postgres isn't running, which is the normal local-dev setup.
  flushToFile();
  if (useMemoryOnly) return;
  try {
    await pool.query(
      `INSERT INTO orchestrator_wallets (main_wallet, circle_wallet_id, address, private_key, mode)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (main_wallet) DO UPDATE SET
           circle_wallet_id = EXCLUDED.circle_wallet_id,
           address = EXCLUDED.address,
           private_key = EXCLUDED.private_key,
           mode = EXCLUDED.mode`,
      [mainWallet, mapping.walletId, mapping.address, mapping.privateKey, mapping.mode]
    );
  } catch {
    useMemoryOnly = true;
  }
}

/**
 * Per-MetaMask creation lock so two parallel `POST /api/wallet/orchestrator`
 * calls (e.g. double-click on DEPLOY) cannot both reach the
 * `generatePrivateKey()` branch and mint two different signers for the same
 * user — the second `writeMapping` would clobber the first on disk, but the
 * first caller's response would still hold the now-orphaned privkey, and
 * any in-flight task it kicked off would sign x402 with a key the saved
 * mapping no longer owns.
 *
 * The lock is keyed off the normalised MetaMask address. Once the first
 * call resolves, every queued caller falls through `readMapping` and gets
 * the canonical record — no more clobbering.
 */
// Each entry is { tail: Promise, refCount: number }. refCount tracks how
// many getOrCreateOrchestrator invocations are still pending on this chain;
// pruneOrchCreationLocks must NEVER drop an entry while refCount > 0,
// otherwise a parallel caller would start a fresh chain that races
// readMapping/writeMapping against the in-flight one and both branches
// could call generatePrivateKey, with the second writeMapping clobbering
// the first.
const orchCreationLocks = new Map();
const ORCH_LOCK_MAP_CAP = Math.max(64, Number(process.env.MUSE_ORCH_LOCK_CAP || 4_096));

function pruneOrchCreationLocks() {
  if (orchCreationLocks.size <= ORCH_LOCK_MAP_CAP) return;
  // Drop oldest entries (Map preserves insertion order) — but ONLY entries
  // whose chain is fully settled (refCount === 0). Skipping live entries
  // is a soft-cap: in the pathological case where every entry has an
  // in-flight caller, the Map can briefly exceed ORCH_LOCK_MAP_CAP. That's
  // fine — those promises will resolve quickly and the next prune pass
  // will reclaim them.
  const evictTarget = Math.max(1, Math.floor(orchCreationLocks.size / 4));
  let evicted = 0;
  for (const [key, entry] of orchCreationLocks) {
    if (evicted >= evictTarget) break;
    if (!entry || entry.refCount === 0) {
      orchCreationLocks.delete(key);
      evicted += 1;
    }
  }
}

/**
 * Idempotent get-or-create: always returns the same self-managed orchestrator
 * for a given MetaMask. On first call we mint a fresh 256-bit private key and
 * persist it. On subsequent calls we return the existing record.
 */
export async function getOrCreateOrchestrator(mainWalletRaw) {
  const mainWallet = normalizeMainWallet(mainWalletRaw);

  // Reuse / extend the per-wallet lock chain. Every caller appends; whoever
  // is at the head of the chain mints (if needed) and writes; subsequent
  // chained calls see the already-persisted record via `readMapping`.
  const existing = orchCreationLocks.get(mainWallet);
  const previous = existing?.tail || Promise.resolve();
  const next = previous
    .catch(() => null) // never let a prior rejection block future calls
    .then(() => createOrLoadOrchestrator(mainWallet));

  // Bump refCount BEFORE storing so a concurrent prune pass sees this
  // entry as live. Decrement once `next` settles.
  const entry = existing || { tail: null, refCount: 0 };
  entry.refCount += 1;
  entry.tail = next.catch(() => null);
  orchCreationLocks.set(mainWallet, entry);

  next.finally(() => {
    entry.refCount -= 1;
  });

  pruneOrchCreationLocks();

  return next;
}

async function createOrLoadOrchestrator(mainWallet) {
  await ensureSchema();

  const existing = await readMapping(mainWallet);
  // Existing record that pre-dates private-key storage — treat as missing so
  // we mint a fresh signer. The address will change, but this is only the
  // migration path for old demo data.
  if (existing && existing.privateKey) return existing;

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const mapping = {
    walletId: `self-managed-${mainWallet.slice(2, 10)}`,
    address: account.address,
    privateKey,
    mode: "self-managed",
    createdAt: new Date().toISOString()
  };
  await writeMapping(mainWallet, mapping);

  // Re-read to make sure we return whatever physically landed in the store —
  // a parallel call queued on the same lock chain might have raced to write
  // first; we want every caller to converge on the SAME canonical mapping.
  const canonical = await readMapping(mainWallet);
  if (canonical?.privateKey) {
    if (canonical.address.toLowerCase() !== mapping.address.toLowerCase()) {
      console.warn(
        `[orchestratorWallets] mint race: queued caller's mint (${mapping.address}) was superseded by ${canonical.address}`
      );
    }
    return canonical;
  }

  console.log(`[orchestratorWallets] Minted self-managed orchestrator ${account.address} for ${mainWallet}`);
  return mapping;
}

export async function getOrchestratorBalance(mainWalletRaw) {
  const mainWallet = normalizeMainWallet(mainWalletRaw);
  const mapping = await readMapping(mainWallet);
  if (!mapping) return { address: null, balanceUsdc: 0 };
  try {
    const raw = await publicClient.getBalance({ address: mapping.address });
    return {
      address: mapping.address,
      balanceUsdc: Number(formatUnits(raw, 18))
    };
  } catch {
    return { address: mapping.address, balanceUsdc: 0 };
  }
}

/**
 * Estimate the exact on-chain cost of a withdraw (gas * gasPrice) for a given
 * orchestrator. Used both by the `max` path and by the UI's MAX button so the
 * user never types an amount that would fail on-chain.
 *
 * Returns the raw wei fee (BigInt) — caller formats as needed.
 */
async function estimateWithdrawFeeWei(account, destination) {
  // Ask the node for the current gas price + the gas cost of a simple value
  // transfer. 21000 is the fixed gas for a pure-value send on EVM, but the
  // node will return the correct value for the chain — Arc Testnet may have
  // its own floor.
  let gasUnits;
  try {
    gasUnits = await publicClient.estimateGas({
      account: account.address,
      to: destination,
      value: 1n
    });
  } catch {
    gasUnits = 21_000n;
  }
  let gasPrice;
  try {
    gasPrice = await publicClient.getGasPrice();
  } catch {
    gasPrice = 1_000_000_000n; // 1 gwei fallback
  }
  // 3× safety multiplier — Arc Testnet has bursty priority fees. 3× a normal
  // send fee is still sub-cent in USDC on 18-decimal native so users don't
  // lose anything meaningful to the reserve.
  return (gasUnits * gasPrice * 3n);
}

export async function getMaxWithdrawable(mainWalletRaw) {
  const mainWallet = normalizeMainWallet(mainWalletRaw);
  const mapping = await readMapping(mainWallet);
  if (!mapping?.privateKey) return { maxWithdrawableUsdc: 0, gasReserveUsdc: 0, balanceUsdc: 0 };
  const account = privateKeyToAccount(mapping.privateKey);
  const [balance, feeWei] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    estimateWithdrawFeeWei(account, mainWallet)
  ]);
  const maxWei = balance > feeWei ? balance - feeWei : 0n;
  return {
    balanceUsdc: Number(formatUnits(balance, 18)),
    gasReserveUsdc: Number(formatUnits(feeWei, 18)),
    maxWithdrawableUsdc: Number(formatUnits(maxWei, 18))
  };
}

/**
 * Broadcast a real on-chain USDC transfer from the orchestrator back to the
 * user's main wallet. Amount is always denominated in USDC; the backend
 * converts to 18-decimal wei before signing.
 *
 * Pass `amountUsdc: "max"` to drain the wallet: backend computes
 * balance - estimated_gas and sends exactly that.
 *
 * Security: the recipient is hard-coded to the mainWallet that owns this
 * orchestrator — the caller cannot redirect funds elsewhere.
 */
export async function withdrawOrchestrator({ mainWallet: mainWalletRaw, amountUsdc }) {
  const mainWallet = normalizeMainWallet(mainWalletRaw);
  // Serialize withdraw through the same per-wallet queue as micro-payments
  // so two concurrent "withdraw max" calls can't both read the same balance,
  // estimate the same gas, and broadcast two txs that each drain the
  // wallet. Queue guarantees one in-flight tx per signing address.
  return enqueueSend(mainWallet, () =>
    withdrawOrchestratorUnsafe({ mainWallet, amountUsdc })
  );
}

async function withdrawOrchestratorUnsafe({ mainWallet, amountUsdc }) {
  const mapping = await readMapping(mainWallet);
  if (!mapping) {
    throw new Error("No orchestrator wallet found — connect first to create one.");
  }
  if (!mapping.privateKey) {
    const err = new Error(
      "This orchestrator has no signing key. Disconnect and reconnect to mint a fresh self-managed orchestrator."
    );
    err.code = "NO_KEY";
    throw err;
  }

  const account = privateKeyToAccount(mapping.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(ARC_RPC_URL)
  });

  const [currentBalance, feeWei] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    estimateWithdrawFeeWei(account, mainWallet)
  ]);

  if (currentBalance <= feeWei) {
    throw new Error(
      `Orchestrator balance (${Number(formatUnits(currentBalance, 18)).toFixed(6)} USDC) is below the gas reserve (${Number(formatUnits(feeWei, 18)).toFixed(6)} USDC).`
    );
  }

  let valueWei;
  if (amountUsdc === "max" || amountUsdc === null || amountUsdc === undefined || amountUsdc === "") {
    valueWei = currentBalance - feeWei;
  } else {
    const amountNum = Number(amountUsdc);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new Error("amountUsdc must be a positive number or \"max\"");
    }
    valueWei = parseUnits(String(amountNum), 18);
    if (valueWei + feeWei > currentBalance) {
      const maxUsdc = Number(formatUnits(currentBalance - feeWei, 18));
      throw new Error(
        `Amount + gas exceeds balance. Max withdrawable: ${maxUsdc.toFixed(6)} USDC (balance ${Number(formatUnits(currentBalance, 18)).toFixed(6)} − gas reserve ${Number(formatUnits(feeWei, 18)).toFixed(6)}).`
      );
    }
  }

  // Arc Testnet mempool sometimes returns "txpool is full" under load. That
  // error is transient — the tx is legit, we just lost the race for a slot.
  // Retry up to twice with exponential backoff before surfacing to the user.
  const txHash = await (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await walletClient.sendTransaction({
          to: /** @type {`0x${string}`} */ (mainWallet),
          value: valueWei
        });
      } catch (err) {
        lastErr = err;
        // Same cause-chain walk as sendMicroPaymentOnArc — viem nests the
        // transient reason under `details` while `shortMessage` is generic.
        const parts = [];
        let cur = err;
        // viem nests up to 5-6 wrapper levels; bumped to 8 for safety.
        for (let i = 0; i < 8 && cur; i += 1) {
          if (cur.shortMessage) parts.push(String(cur.shortMessage));
          if (cur.details) parts.push(String(cur.details));
          if (cur.message) parts.push(String(cur.message));
          cur = cur.cause;
        }
        const msg = parts.join(" | ");
        const retryable = /txpool is full|already known|nonce too low|replacement transaction underpriced|timeout|ECONNRESET|ENETUNREACH|fetch failed/i.test(msg);
        if (!retryable || attempt === 2) throw err;
        const waitMs = 1200 * (attempt + 1);
        console.warn(`[orchestrator] withdraw retry ${attempt + 1}/2 after transient error in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    // Unreachable — loop either returns or throws — but keep TS/linters happy.
    throw lastErr;
  })();

  return {
    txHash,
    source: account.address,
    destination: mainWallet,
    amountUsdc: Number(formatUnits(valueWei, 18)),
    gasReserveUsdc: Number(formatUnits(feeWei, 18)),
    explorerUrl: `${ARC_EXPLORER_TX_BASE}/${txHash}`
  };
}

/** Expose the signing account for internal callers (e.g. x402 micro-payment path). */
export async function getOrchestratorSigner(mainWalletRaw) {
  const mainWallet = normalizeMainWallet(mainWalletRaw);
  const mapping = await readMapping(mainWallet);
  if (!mapping?.privateKey) return null;
  return {
    address: mapping.address,
    privateKey: mapping.privateKey,
    account: privateKeyToAccount(mapping.privateKey),
    walletClient: createWalletClient({
      account: privateKeyToAccount(mapping.privateKey),
      chain: arcTestnet,
      transport: http(ARC_RPC_URL)
    })
  };
}

/**
 * Per-orchestrator-wallet serialization queue. Arc Testnet's RPC returns
 * the same `getTransactionCount` to parallel callers until a tx actually
 * includes — so firing 5 sendTransaction calls in parallel guarantees 4
 * of them blow up with `nonce too low` / `already known`. We serialize
 * every outgoing tx per signing address: one in flight at a time, next
 * queued. Fixes the "grey unclickable hashes" (Circle UUIDs that remained
 * because direct settlement threw before getting a real 0x hash).
 */
const sendQueues = new Map(); // normalizedMainWallet → { tail: Promise, lastTouched: number }
const SEND_QUEUE_IDLE_TTL_MS = Number(process.env.MUSE_SEND_QUEUE_IDLE_TTL_MS || 10 * 60 * 1000);

function pruneIdleQueues() {
  // Drop queues that haven't been touched in TTL. The tail promise is
  // already resolved at this point (enqueueSend replaces `tail` on every
  // call), so dropping the Map entry is safe — a future enqueueSend for
  // the same key starts from Promise.resolve().
  const now = Date.now();
  for (const [key, entry] of sendQueues.entries()) {
    if (!entry || now - entry.lastTouched > SEND_QUEUE_IDLE_TTL_MS) {
      sendQueues.delete(key);
    }
  }
}

function enqueueSend(key, task) {
  const existing = sendQueues.get(key);
  const prev = existing?.tail || Promise.resolve();
  const next = prev.then(task, task); // run regardless of prior outcome
  // Keep the queue alive even if a task threw — next callers shouldn't
  // inherit the rejection.
  sendQueues.set(key, {
    tail: next.catch(() => null),
    lastTouched: Date.now()
  });
  // Prune opportunistically so we don't need a separate timer.
  if (sendQueues.size > 32) pruneIdleQueues();
  return next;
}

// Periodic sweep — covers the case where total queue count stays below
// the size-based trigger but individual entries are well past their TTL.
// .unref() so this timer doesn't hold the event loop open at shutdown.
const sendQueueSweep = setInterval(pruneIdleQueues, Math.min(SEND_QUEUE_IDLE_TTL_MS, 5 * 60 * 1000));
if (typeof sendQueueSweep.unref === "function") sendQueueSweep.unref();

/**
 * Broadcast a real on-chain native-USDC transfer from the orchestrator to
 * an agent wallet for the amount the x402 payment authorised. Returns the
 * Arc Testnet tx hash so the UI can link it on ArcScan.
 *
 * Serialized per signing wallet via `enqueueSend` so we never race the
 * nonce counter.
 */
export async function sendMicroPaymentOnArc({ mainWalletRaw, toAddress, amountUsdc }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(toAddress || ""))) {
    throw new Error(`sendMicroPaymentOnArc: invalid toAddress ${toAddress}`);
  }
  const amountNum = Number(amountUsdc);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new Error(`sendMicroPaymentOnArc: invalid amountUsdc ${amountUsdc}`);
  }
  const mainWallet = normalizeMainWallet(mainWalletRaw);

  return enqueueSend(mainWallet, async () => {
    const mapping = await readMapping(mainWallet);
    if (!mapping?.privateKey) {
      throw new Error("sendMicroPaymentOnArc: no orchestrator private key available");
    }
    const account = privateKeyToAccount(mapping.privateKey);
    const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_RPC_URL) });

    // Arc Testnet native currency uses 18-decimal wei but the project
    // denominates everything in 6-decimal USDC — convert carefully.
    // Use parseUnits for exact fixed-point (string-based) math so tiny
    // amounts like 0.000001 don't lose precision through float rounding.
    // Cap fractional digits at 6 to match our USDC denomination before
    // parsing — parseUnits rejects extra decimals.
    const normalizedStr = amountNum.toFixed(6);
    const valueWei = parseUnits(normalizedStr, 18);

    // Explicit nonce tracking: we read the pending nonce for every tx
    // instead of relying on viem's implicit counter. Even though the
    // queue prevents concurrent sends, `getTransactionCount(pending)`
    // gives us a clean snapshot that includes still-in-mempool txs.
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });

    let txHash;
    let lastErr;
    // Track nonce bump separately from attempt count: only bump when the
    // error says the nonce itself was the problem (already known, nonce
    // too low). For pure rate-limit / network errors, the tx never got
    // into the mempool — reusing the SAME nonce is correct, and bumping
    // would create a nonce gap that stalls every subsequent send from
    // this wallet.
    let nonceBump = 0;
    const MAX_ATTEMPTS = 6;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        txHash = await walletClient.sendTransaction({
          to: toAddress,
          value: valueWei,
          nonce: nonce + nonceBump
        });
        break;
      } catch (err) {
        lastErr = err;
        // viem buries the real reason in `details` (e.g. "txpool is full")
        // while `shortMessage` stays a generic "Transaction creation failed."
        // Walk the cause chain so the retry regex can see whichever level of
        // the wrapped error carries the transient signal.
        const parts = [];
        let cur = err;
        // viem nests up to 5-6 wrapper levels; bumped to 8 for safety.
        for (let i = 0; i < 8 && cur; i += 1) {
          if (cur.shortMessage) parts.push(String(cur.shortMessage));
          if (cur.details) parts.push(String(cur.details));
          if (cur.message) parts.push(String(cur.message));
          cur = cur.cause;
        }
        const msg = parts.join(" | ");
        const nonceIssue = /already known|nonce too low|replacement transaction underpriced/i.test(msg);
        const retryable = nonceIssue || /txpool is full|fetch failed|timeout|ECONNRESET|ENETUNREACH|ENOTFOUND|HTTP request failed|rate.?limit|429|503|502/i.test(msg);
        if (!retryable || attempt === MAX_ATTEMPTS - 1) throw err;
        if (nonceIssue) nonceBump += 1;
        // Exponential-ish backoff — 600, 1200, 2000, 3500, 6000, 10000ms.
        // Last slot extended to 10s so rate-limit buckets that meter on a
        // ~10s window have time to refill before the final retry.
        const delays = [600, 1200, 2000, 3500, 6000, 10000];
        await new Promise((r) => setTimeout(r, delays[Math.min(attempt, delays.length - 1)]));
      }
    }
    if (!txHash) throw lastErr || new Error("sendMicroPaymentOnArc: no tx hash");

    return {
      txHash,
      arcUrl: `${ARC_EXPLORER_TX_BASE}/${txHash}`,
      from: account.address,
      to: toAddress,
      amountUsdc: amountNum
    };
  });
}
