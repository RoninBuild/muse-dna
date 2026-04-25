/**
 * Muse Agent Registry — ERC-8004-inspired trust layer.
 *
 * Modes:
 *   - on-chain:  REGISTRY_CONTRACT_ADDRESS is set → all reads/writes go to
 *                the deployed Vyper contract on Arc Testnet.
 *   - in-process: contract not deployed → we still expose the same API
 *                 surface backed by an in-memory store so the demo works
 *                 even before the contract is live.
 *
 * The `record_payment` entrypoint is called by the orchestrator after every
 * settled micro-unit. The result is a running reputation counter per agent
 * that the UI (and Gemini) can query.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getContract, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ABI_PATH = path.resolve(here, "..", "..", "infrastructure", "contracts", "MuseAgentRegistry.abi.json");

let abiCache = null;
async function loadAbi() {
  if (abiCache) return abiCache;
  const raw = await fs.readFile(ABI_PATH, "utf-8");
  try {
    abiCache = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MuseAgentRegistry ABI at ${ABI_PATH} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(abiCache)) {
    throw new Error(`MuseAgentRegistry ABI at ${ABI_PATH} must be an array`);
  }
  return abiCache;
}

function getChainId() {
  return Number(process.env.ARC_CHAIN_ID || process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5_042_002);
}

function getRpcUrl() {
  return (
    process.env.ARC_RPC_URL ||
    process.env.NEXT_PUBLIC_ARC_RPC_URL ||
    "https://rpc.testnet.arc.network"
  );
}

function getContractAddress() {
  return process.env.REGISTRY_CONTRACT_ADDRESS || "";
}

function isOnChainMode() {
  return /^0x[0-9a-fA-F]{40}$/.test(getContractAddress());
}

function arcChain() {
  return defineChain({
    id: getChainId(),
    name: "Arc Testnet",
    network: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [getRpcUrl()] }, public: { http: [getRpcUrl()] } }
  });
}

function getPrivateKey() {
  const key = (
    process.env.MUSE_BUYER_PRIVATE_KEY ||
    process.env.MUSE_GATEWAY_PRIVATE_KEY ||
    process.env.ORCHESTRATOR_PRIVATE_KEY ||
    ""
  ).trim();
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
}

// ---------------- In-process store ----------------

const memoryStore = {
  agents: new Map(),         // address → { service, label, metadata_uri, registered_at, active }
  stats: new Map(),          // address → { txCount, totalSettledMicro }
  order: []                  // address[] in registration order
};

function memoryRegister({ agent, service, label, metadataUri }) {
  const key = agent.toLowerCase();
  const existing = memoryStore.agents.get(key);
  if (!existing) memoryStore.order.push(key);
  memoryStore.agents.set(key, {
    service,
    label,
    metadata_uri: metadataUri || null,
    registered_at: existing?.registered_at || Date.now(),
    active: true
  });
  if (!memoryStore.stats.has(key)) {
    memoryStore.stats.set(key, { txCount: 0, totalSettledMicro: 0n });
  }
}

function memoryRecordPayment(agent, amountMicro) {
  const key = agent.toLowerCase();
  const row = memoryStore.stats.get(key);
  if (!row) throw new Error(`Agent not registered: ${agent}`);
  row.txCount += 1;
  row.totalSettledMicro += BigInt(amountMicro);
  return { txCount: row.txCount, totalSettledMicro: row.totalSettledMicro };
}

function memoryListAll() {
  return memoryStore.order.map((addr) => {
    const a = memoryStore.agents.get(addr);
    const s = memoryStore.stats.get(addr);
    return {
      address: addr,
      service: a.service,
      label: a.label,
      metadataUri: a.metadata_uri,
      registeredAt: new Date(a.registered_at).toISOString(),
      active: a.active,
      txCount: s.txCount,
      totalSettledUsdc: Number(s.totalSettledMicro) / 1_000_000
    };
  });
}

// ---------------- On-chain clients ----------------

const REGISTRY_RPC_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.REGISTRY_RPC_TIMEOUT_MS || 12_000)
);

/**
 * Race a promise against a hard timeout. Without this a hung RPC endpoint
 * pins every /api/registry call and every orchestrator recordPayment until
 * the client eventually errors out minutes later.
 */
function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`registry ${label} timed out after ${REGISTRY_RPC_TIMEOUT_MS}ms`));
    }, REGISTRY_RPC_TIMEOUT_MS);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

let publicClient = null;
let walletClient = null;

async function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({ chain: arcChain(), transport: http() });
  }
  return publicClient;
}

async function getWalletClient() {
  const key = getPrivateKey();
  if (!key) throw new Error("No MUSE_BUYER_PRIVATE_KEY configured for registry writes");
  if (!walletClient) {
    const account = privateKeyToAccount(key);
    walletClient = createWalletClient({ account, chain: arcChain(), transport: http() });
  }
  return walletClient;
}

async function getReadContract() {
  const address = getContractAddress();
  if (!address) throw new Error("REGISTRY_CONTRACT_ADDRESS not set");
  return getContract({ address, abi: await loadAbi(), client: await getPublicClient() });
}

async function getWriteContract() {
  const address = getContractAddress();
  if (!address) throw new Error("REGISTRY_CONTRACT_ADDRESS not set");
  return getContract({ address, abi: await loadAbi(), client: await getWalletClient() });
}

// ---------------- Public API ----------------

export function registryMode() {
  return isOnChainMode() ? "on-chain" : "in-process";
}

export async function registerAgent({ agent, service, label, metadataUri = "" }) {
  if (!agent || typeof agent !== "string") throw new Error("agent address required");

  if (!isOnChainMode()) {
    memoryRegister({ agent, service, label, metadataUri });
    return { mode: "in-process", agent };
  }

  const contract = await getWriteContract();
  const hash = await withTimeout(
    contract.write.register_agent([agent, service || "", label || "", metadataUri || ""]),
    "register_agent"
  );
  const client = await getPublicClient();
  await withTimeout(client.waitForTransactionReceipt({ hash }), "waitForTransactionReceipt");
  return { mode: "on-chain", agent, txHash: hash };
}

export async function recordPayment({ agent, amountUsdc }) {
  const amountMicro = BigInt(Math.round(Number(amountUsdc || 0) * 1_000_000));
  if (amountMicro <= 0n) return { skipped: true };

  if (!isOnChainMode()) {
    // Auto-register the agent the first time we see a payment to it, so the
    // orchestrator does not have to babysit registration for demo purposes.
    if (!memoryStore.stats.has(agent.toLowerCase())) {
      memoryRegister({ agent, service: "unknown", label: agent, metadataUri: "" });
    }
    const stats = memoryRecordPayment(agent, amountMicro);
    return { mode: "in-process", ...stats };
  }

  // The on-chain Vyper contract's `record_payment` validates `registered_at`
  // but NOT the `active` flag — a deactivated agent can still accumulate
  // reputation. Until we redeploy the contract, defend at the JS layer:
  // read the agent record, reject the write if `active` is false.
  try {
    const readContract = await getReadContract();
    const onChainAgent = await withTimeout(readContract.read.agents([agent]), "agents");
    // viem returns a tuple shaped per the ABI — the `active` flag's index
    // depends on the struct order. We dereference defensively (named field
    // first, positional last) so a future ABI shape change doesn't silently
    // bypass the check.
    const isActive =
      onChainAgent && (onChainAgent.active !== undefined
        ? onChainAgent.active
        : Array.isArray(onChainAgent) ? Boolean(onChainAgent[onChainAgent.length - 1]) : true);
    if (!isActive) {
      console.warn(`[agentRegistry] skipping record_payment for deactivated agent ${agent}`);
      return { mode: "on-chain", agent, skipped: true, reason: "agent-deactivated" };
    }
  } catch (readErr) {
    // If the read fails (RPC blip, agent not registered) we let the write
    // attempt proceed — the contract's own `registered_at` check will
    // reject unregistered agents, and a transient RPC error is normal.
    console.warn(`[agentRegistry] active-flag check failed for ${agent}: ${readErr?.message || readErr}`);
  }

  const contract = await getWriteContract();
  const hash = await withTimeout(
    contract.write.record_payment([agent, amountMicro]),
    "record_payment"
  );
  return { mode: "on-chain", agent, amountMicro: amountMicro.toString(), txHash: hash };
}

export async function listAgents() {
  if (!isOnChainMode()) {
    return memoryListAll();
  }
  const contract = await getReadContract();
  const count = Number(await withTimeout(contract.read.agent_count(), "agent_count"));
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const address = await withTimeout(contract.read.agent_at([BigInt(i)]), "agent_at");
    const [rep, agent] = await Promise.all([
      withTimeout(contract.read.reputation([address]), "reputation"),
      withTimeout(contract.read.agents([address]), "agents")
    ]);
    results.push({
      address,
      service: agent.service,
      label: agent.label,
      metadataUri: agent.metadata_uri,
      registeredAt: new Date(Number(agent.registered_at) * 1000).toISOString(),
      active: Boolean(rep[2]),
      txCount: Number(rep[0]),
      totalSettledUsdc: Number(rep[1]) / 1_000_000
    });
  }
  return results;
}

/**
 * Seed the registry with the four canonical Muse sub-agents. Idempotent —
 * safe to call on every backend startup.
 */
export async function seedMuseAgents() {
  const defaults = [
    { env: "STRATEGY_AGENT_WALLET", service: "strategy", label: "Strategy DNA Agent" },
    { env: "FAST_SEARCH_WALLET", service: "search", label: "Fast Search Agent" },
    { env: "COPY_AGENT_WALLET", service: "copy", label: "Copy Pulse Agent" },
    { env: "IMAGE_AGENT_WALLET", service: "image", label: "Visual Frame Agent" }
  ];

  const results = [];
  for (const row of defaults) {
    const addr = process.env[row.env];
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
    try {
      const r = await registerAgent({
        agent: addr,
        service: row.service,
        label: row.label,
        metadataUri: `https://muse.dna/${row.service}`
      });
      results.push({ ...r, service: row.service });
    } catch (error) {
      results.push({ service: row.service, error: String(error?.message || error) });
    }
  }
  return results;
}
