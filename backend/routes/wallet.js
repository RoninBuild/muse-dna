import express from "express";
import crypto from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";
import { formatUnits, isAddress, maxUint256, pad, parseUnits, zeroAddress } from "viem";
import { stringifyTypedDataForCircle, hasCircleWalletCredentials, getCircleClient } from "../services/circleWallet.js";
import {
  getOrCreateOrchestrator,
  withdrawOrchestrator,
  getOrchestratorBalance,
  getMaxWithdrawable,
  getOrchestratorSigner
} from "../services/orchestratorWallets.js";
import { museProxy } from "../../shared/load-env.mjs";
import { requireAdminAuth } from "../middleware/adminAuth.js";

const router = express.Router();
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
const ARC_BLOCKCHAIN = process.env.ARC_BLOCKCHAIN || "ARC-TESTNET";
const ARC_EXPLORER_TX_BASE =
  process.env.ARC_EXPLORER_TX_BASE || "https://testnet.arcscan.app/tx";
const ARC_GATEWAY_CHAIN = process.env.ARC_GATEWAY_CHAIN || "arcTestnet";
const GATEWAY_API_BASE_URL =
  process.env.GATEWAY_API_BASE_URL ||
  (ARC_GATEWAY_CHAIN === "arcTestnet"
    ? "https://gateway-api-testnet.circle.com/v1"
    : "https://gateway-api.circle.com/v1");
const DEFAULT_WITHDRAW_MAX_FEE_USDC =
  process.env.GATEWAY_WITHDRAW_MAX_FEE_USDC || "0.05";

let cachedWalletSetId = process.env.USER_WALLET_SET_ID || null;
// Cap the in-memory mock session cache so a bot flooding /create with random
// addresses cannot blow up RAM. 500 entries is far above any realistic
// demo / multi-tenant dev load.
const MAX_MOCK_SESSIONS = Math.max(50, Number(process.env.MUSE_MAX_MOCK_SESSIONS || 500));
const mockWalletSessions = new Map();
function rememberMockWalletSession(key, value) {
  if (mockWalletSessions.size >= MAX_MOCK_SESSIONS && !mockWalletSessions.has(key)) {
    // Evict the oldest insertion — Map iteration order is insertion order.
    const firstKey = mockWalletSessions.keys().next().value;
    if (firstKey !== undefined) mockWalletSessions.delete(firstKey);
  }
  mockWalletSessions.set(key, value);
}
let cachedCircleAccessProbe = null;
let cachedCircleAccessProbeTimestamp = 0;
const PROBE_TTL_SUCCESS_MS = 60_000;
const PROBE_TTL_FAILURE_MS = 10_000;

// Simple mutex to prevent concurrent wallet creation races.
let walletCreationLock = Promise.resolve();

function isMockX402Enabled() {
  return process.env.MOCK_X402 === "true";
}

// L1-L2: hasCircleWalletCredentials and getCircleClient are now imported
// from circleWallet.js to avoid duplicate definitions.

function hasSelfManagedKey() {
  const key =
    process.env.MUSE_BUYER_PRIVATE_KEY ||
    process.env.MUSE_GATEWAY_PRIVATE_KEY ||
    process.env.ORCHESTRATOR_PRIVATE_KEY ||
    "";
  return /^0x[0-9a-fA-F]{64}$/.test(String(key).trim());
}

function getSelfManagedAddress() {
  const key =
    process.env.MUSE_BUYER_PRIVATE_KEY ||
    process.env.MUSE_GATEWAY_PRIVATE_KEY ||
    process.env.ORCHESTRATOR_PRIVATE_KEY ||
    "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(key).trim())) {
    return null;
  }
  try {
    return privateKeyToAccount(String(key).trim()).address;
  } catch {
    console.error("Failed to derive address from self-managed private key (key is malformed).");
    return null;
  }
}

function getWalletRuntimeMode() {
  if (isMockX402Enabled()) {
    return "mock";
  }

  if (hasCircleWalletCredentials()) {
    return "circle";
  }

  if (hasSelfManagedKey()) {
    return "self-managed";
  }

  return "unconfigured";
}

function normalizeMainWalletAddress(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "anonymous";
}

function createDemoAddress(seed) {
  return `0x${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
}

function getConfiguredAgentWallet(envKey, fallbackAddress) {
  const configured = process.env[envKey];
  // strict: false — placeholder addresses like 0xAAA…000 fail EIP-55 checksum
  // in strict mode but are still valid hex addresses for demo wiring.
  if (configured && isAddress(configured, { strict: false })) {
    return configured;
  }
  // Demo/mock mode may use placeholder addresses.
  if (isMockX402Enabled()) {
    return fallbackAddress;
  }
  // In any real mode, a missing agent wallet is a fatal config error.
  throw new Error(
    `Missing or invalid ${envKey}. Set it in .env to a real Arc Testnet address. ` +
    `This is required when MOCK_X402 is not true.`
  );
}

export function buildSessionWalletsResponse({
  payerId,
  payerAddress,
  balance = "0.00",
  mode = "circle",
  fundingDisabled = false
}) {
  return {
    mode,
    fundingDisabled,
    payer: {
      id: payerId,
      address: payerAddress,
      balance
    },
    strategy: {
      id: `seller-strategy-${mode}`,
      address: getConfiguredAgentWallet(
        "STRATEGY_AGENT_WALLET",
        "0xAAA0000000000000000000000000000000000000"
      )
    },
    search: {
      id: `seller-search-${mode}`,
      address: getConfiguredAgentWallet(
        "FAST_SEARCH_WALLET",
        "0xBBB0000000000000000000000000000000000000"
      )
    },
    copy: {
      id: `seller-copy-${mode}`,
      address: getConfiguredAgentWallet(
        "COPY_AGENT_WALLET",
        "0xCCC0000000000000000000000000000000000000"
      )
    },
    image: {
      id: `seller-image-${mode}`,
      address: getConfiguredAgentWallet(
        "IMAGE_AGENT_WALLET",
        "0xDDD0000000000000000000000000000000000000"
      )
    }
  };
}

export function createMockSessionWallets(mainWalletAddress) {
  const normalizedMainWalletAddress = normalizeMainWalletAddress(mainWalletAddress);
  const cached = mockWalletSessions.get(normalizedMainWalletAddress);

  if (cached) {
    return cached;
  }

  const sessionKey = crypto
    .createHash("sha256")
    .update(`muse-mock-wallets:${normalizedMainWalletAddress}`)
    .digest("hex");

  const sessionWallets = buildSessionWalletsResponse({
    payerId: `mock-payer-${sessionKey.slice(0, 12)}`,
    payerAddress: createDemoAddress(`${normalizedMainWalletAddress}:payer`),
    balance: "0.00",
    mode: "mock",
    fundingDisabled: true
  });

  rememberMockWalletSession(normalizedMainWalletAddress, sessionWallets);
  return sessionWallets;
}

/**
 * Per-user session wallet provisioning.
 *
 * Connects MetaMask address (`mainWalletAddress`) to a backend-managed
 * orchestrator wallet that signs micro-payments on the user's behalf.
 * Each MetaMask gets ITS OWN orchestrator (1:1, persisted in
 * orchestrator-wallets.json) — no cross-user sharing, no env wallet leak.
 *
 * Returns sessionWallets with payer.address = the user's orchestrator
 * address, so every downstream x402 / direct-settle path signs with
 * THAT user's key, not the shared CI test key.
 */
export async function createSelfManagedSessionWallets(mainWalletAddress) {
  const normalizedMainWalletAddress = normalizeMainWalletAddress(mainWalletAddress);
  if (normalizedMainWalletAddress === "anonymous") {
    throw new Error("mainWalletAddress is required to create a session — please connect a wallet.");
  }

  // Mint or load this user's dedicated orchestrator (per-MetaMask 1:1).
  // The backend holds the privkey so it can sign 50+ micropayments per task
  // without 50 MetaMask popups, but the address is bound to this MetaMask
  // and only THIS MetaMask can later withdraw the funds back.
  const mapping = await getOrCreateOrchestrator(normalizedMainWalletAddress);

  // Cache key is now keyed off both the MetaMask address AND the mapped
  // orchestrator address — if the operator wipes the mapping store and
  // we re-mint a fresh orchestrator, the stale cached payer entry must
  // not survive into the new session.
  const cacheKey = `${normalizedMainWalletAddress}|${mapping.address.toLowerCase()}`;
  const cached = mockWalletSessions.get(cacheKey);
  if (cached) return cached;

  const sessionWallets = buildSessionWalletsResponse({
    payerId: mapping.walletId,
    payerAddress: mapping.address,
    balance: "0.00",
    mode: "self-managed",
    fundingDisabled: false
  });

  rememberMockWalletSession(cacheKey, sessionWallets);
  return sessionWallets;
}

function findMockWalletById(walletId) {
  for (const sessionWallets of mockWalletSessions.values()) {
    for (const role of ["payer", "strategy", "search", "copy", "image"]) {
      const wallet = sessionWallets[role];

      if (wallet?.id === walletId) {
        return {
          ...wallet,
          mode: sessionWallets.mode,
          fundingDisabled: sessionWallets.fundingDisabled
        };
      }
    }
  }

  return null;
}

// L1: getCircleClient() is imported from circleWallet.js (single source of truth).

function getCircleApiProbeTarget() {
  const walletId = String(process.env.ORCHESTRATOR_WALLET_ID || "").trim();
  return walletId
    ? `https://api.circle.com/v1/w3s/developer/wallets/${walletId}`
    : "https://api.circle.com/v1/w3s/developer/wallets";
}

function createProbeHeaders() {
  const apiKey = process.env.CIRCLE_API_KEY || "";
  // L8 fix: don't send 'Bearer undefined' when key isn't configured.
  return apiKey
    ? { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
    : { Accept: "application/json" };
}

function getGatewayChainConfig() {
  const chainConfig = CHAIN_CONFIGS[ARC_GATEWAY_CHAIN];

  if (!chainConfig) {
    throw new Error(
      `Unsupported ARC_GATEWAY_CHAIN "${ARC_GATEWAY_CHAIN}". Update .env to a supported Gateway chain name.`
    );
  }

  return chainConfig;
}

function getWalletRoles(sessionWallets) {
  return Object.fromEntries(
    Object.entries(sessionWallets)
      .filter(([key]) => ["payer", "strategy", "search", "copy", "image"].includes(key))
      .map(([key, value]) => [key, value.address])
  );
}

function getProxyUrl() {
  // C1 fix: env vars are deleted by load-env.mjs after patching transports.
  // Use the captured value from the museProxy singleton instead.
  return museProxy.proxyUrl || "";
}

async function requestJsonViaProxy(url, { timeoutMs = 15_000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let dispatcher = undefined;
  const proxyUrl = getProxyUrl();

  if (proxyUrl) {
    try {
      const undici = await import("undici");
      dispatcher = new undici.ProxyAgent(proxyUrl);
    } catch {
      // Fall through without a dispatcher if undici is unavailable.
    }
  }

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    });

    const text = await response.text().catch(() => "");
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
      data
    };
  } finally {
    clearTimeout(timer);
    if (dispatcher?.close) {
      dispatcher.close().catch(() => {});
    }
  }
}

function extractWalletLookupRecord(responseData, walletId) {
  if (responseData?.wallet) {
    return responseData.wallet;
  }

  if (Array.isArray(responseData?.wallets)) {
    return (
      responseData.wallets.find((wallet) => String(wallet?.id) === String(walletId)) ||
      responseData.wallets[0] ||
      null
    );
  }

  return responseData || null;
}

async function getCircleWalletRecord(walletId) {
  const client = getCircleClient();
  const response = await client.getWallet({ id: walletId });
  const wallet = extractWalletLookupRecord(response.data, walletId);

  if (!wallet?.address) {
    throw new Error(`Wallet lookup returned no address for ${walletId}`);
  }

  return wallet;
}

async function getCircleWalletUsdcBalance(client, walletId) {
  const response = await client.getWalletTokenBalance({ id: walletId });
  const tokenBalances = response.data?.tokenBalances || [];
  const usdcToken = tokenBalances.find(
    (tokenBalance) =>
      tokenBalance.token.symbol === "USDC" ||
      tokenBalance.token.name?.toLowerCase().includes("usd")
  );

  return usdcToken?.amount || "0.00";
}

async function fetchGatewayBalanceByAddress(walletAddress) {
  const chainConfig = getGatewayChainConfig();
  const response = await requestJsonViaProxy(`${GATEWAY_API_BASE_URL}/balances`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      token: "USDC",
      sources: [
        {
          depositor: walletAddress,
          domain: chainConfig.domain
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(
      `Gateway balance fetch failed (${response.status}): ${response.text || response.statusText}`
    );
  }

  const balanceData = Array.isArray(response.data?.balances)
    ? response.data.balances[0]
    : null;

  if (!balanceData) {
    return {
      total: 0n,
      available: 0n,
      withdrawing: 0n,
      withdrawable: 0n,
      formattedTotal: "0.00",
      formattedAvailable: "0.00",
      formattedWithdrawing: "0.00",
      formattedWithdrawable: "0.00"
    };
  }

  const available = parseUnits(String(balanceData.balance || "0"), 6);
  const withdrawing = parseUnits(String(balanceData.withdrawing || "0"), 6);
  const withdrawable = parseUnits(String(balanceData.withdrawable || "0"), 6);
  const total = available + withdrawing;

  return {
    total,
    available,
    withdrawing,
    withdrawable,
    formattedTotal: formatUnits(total, 6),
    formattedAvailable: formatUnits(available, 6),
    formattedWithdrawing: formatUnits(withdrawing, 6),
    formattedWithdrawable: formatUnits(withdrawable, 6)
  };
}

function buildWalletBalanceResponse({
  walletAddress,
  walletBalance,
  gatewayBalance,
  mode = "circle"
}) {
  return {
    balance: gatewayBalance.formattedAvailable,
    walletBalance,
    gatewayAvailable: gatewayBalance.formattedAvailable,
    gatewayTotal: gatewayBalance.formattedTotal,
    gatewayWithdrawing: gatewayBalance.formattedWithdrawing,
    gatewayWithdrawable: gatewayBalance.formattedWithdrawable,
    walletAddress,
    blockchain: ARC_BLOCKCHAIN,
    mode
  };
}

function addressToBytes32(address) {
  // Validate before padding — `pad()` will silently zero-extend any string
  // (including null, "", or non-EVM garbage) to 32 bytes, producing a
  // valid-looking but on-chain-meaningless burn-intent field. Fail fast
  // here so callers see a clear error instead of a Circle-side rejection
  // hours later.
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`addressToBytes32: invalid EVM address ${JSON.stringify(address)}`);
  }
  return pad(address.toLowerCase(), { size: 32 });
}

export function buildGatewayBurnIntent({
  sourceChainConfig,
  destinationChainConfig,
  sourceDepositor,
  sourceSigner,
  destinationRecipient,
  value,
  maxFee,
  salt = `0x${crypto.randomBytes(32).toString("hex")}`
}) {
  return {
    maxBlockHeight: maxUint256,
    maxFee,
    spec: {
      version: 1,
      sourceDomain: sourceChainConfig.domain,
      destinationDomain: destinationChainConfig.domain,
      sourceContract: addressToBytes32(sourceChainConfig.gatewayWallet),
      destinationContract: addressToBytes32(destinationChainConfig.gatewayMinter),
      sourceToken: addressToBytes32(sourceChainConfig.usdc),
      destinationToken: addressToBytes32(destinationChainConfig.usdc),
      sourceDepositor: addressToBytes32(sourceDepositor),
      destinationRecipient: addressToBytes32(destinationRecipient),
      sourceSigner: addressToBytes32(sourceSigner),
      destinationCaller: addressToBytes32(zeroAddress),
      value,
      salt,
      hookData: "0x"
    }
  };
}

function buildGatewayBurnIntentTypedData(burnIntent) {
  return {
    domain: {
      name: "GatewayWallet",
      version: "1"
    },
    types: {
      TransferSpec: [
        { name: "version", type: "uint32" },
        { name: "sourceDomain", type: "uint32" },
        { name: "destinationDomain", type: "uint32" },
        { name: "sourceContract", type: "bytes32" },
        { name: "destinationContract", type: "bytes32" },
        { name: "sourceToken", type: "bytes32" },
        { name: "destinationToken", type: "bytes32" },
        { name: "sourceDepositor", type: "bytes32" },
        { name: "destinationRecipient", type: "bytes32" },
        { name: "sourceSigner", type: "bytes32" },
        { name: "destinationCaller", type: "bytes32" },
        { name: "value", type: "uint256" },
        { name: "salt", type: "bytes32" },
        { name: "hookData", type: "bytes" }
      ],
      BurnIntent: [
        { name: "maxBlockHeight", type: "uint256" },
        { name: "maxFee", type: "uint256" },
        { name: "spec", type: "TransferSpec" }
      ]
    },
    primaryType: "BurnIntent",
    message: burnIntent
  };
}

async function prepareGatewayWithdrawal({
  walletId,
  walletAddress,
  recipientAddress,
  amount,
  maxFeeUsdc = DEFAULT_WITHDRAW_MAX_FEE_USDC
}) {
  const chainConfig = getGatewayChainConfig();
  const value = parseUnits(String(amount), 6);
  const maxFee = parseUnits(String(maxFeeUsdc), 6);
  const burnIntent = buildGatewayBurnIntent({
    sourceChainConfig: chainConfig,
    destinationChainConfig: chainConfig,
    sourceDepositor: walletAddress,
    sourceSigner: walletAddress,
    destinationRecipient: recipientAddress,
    value,
    maxFee
  });
  const typedData = buildGatewayBurnIntentTypedData(burnIntent);

  let burnIntentSignature;
  if (hasCircleWalletCredentials() && walletId && !walletId.startsWith("self-managed")) {
    const client = getCircleClient();
    const signatureResponse = await client.signTypedData({
      walletId,
      data: stringifyTypedDataForCircle(typedData)
    });
    burnIntentSignature = signatureResponse.data?.signature;
  } else {
    // Self-managed mode: sign locally with the private key
    const key =
      process.env.MUSE_BUYER_PRIVATE_KEY ||
      process.env.MUSE_GATEWAY_PRIVATE_KEY ||
      process.env.ORCHESTRATOR_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error("Missing self-managed private key for withdrawal signing.");
    }
    const account = privateKeyToAccount(key);
    burnIntentSignature = await account.signTypedData(typedData);
  }

  if (!burnIntentSignature) {
    throw new Error("signTypedData returned no burn intent signature.");
  }

  const transferResponse = await requestJsonViaProxy(`${GATEWAY_API_BASE_URL}/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(
      [{ burnIntent, signature: burnIntentSignature }],
      (_key, current) => (typeof current === "bigint" ? current.toString() : current)
    )
  });

  if (!transferResponse.ok) {
    throw new Error(
      `Gateway transfer request failed (${transferResponse.status}): ${transferResponse.text || transferResponse.statusText}`
    );
  }

  const transferData = Array.isArray(transferResponse.data)
    ? transferResponse.data[0]
    : transferResponse.data;

  if (transferData?.success === false || transferData?.error) {
    throw new Error(
      transferData?.message || transferData?.error || "Gateway transfer request was rejected."
    );
  }

  const attestation =
    transferData?.attestation?.payload || transferData?.attestation || null;
  const signature = transferData?.attestation?.signature || transferData?.signature || null;

  if (!attestation || !signature) {
    throw new Error("Gateway transfer returned no attestation payload/signature.");
  }

  return {
    transferId: transferData?.id || null,
    attestation,
    signature,
    amount: formatUnits(value, 6),
    mintContract: chainConfig.gatewayMinter,
    chainId: chainConfig.chain.id,
    recipientAddress
  };
}

async function probeCircleApiAccess() {
  // C2 fix: use TTL-based caching so transient failures don't block forever.
  const now = Date.now();
  if (cachedCircleAccessProbe) {
    const ttl = cachedCircleAccessProbe.ok ? PROBE_TTL_SUCCESS_MS : PROBE_TTL_FAILURE_MS;
    if (now - cachedCircleAccessProbeTimestamp < ttl) {
      return cachedCircleAccessProbe;
    }
  }

  // Node 24's native fetch() uses undici internally — it does NOT go through
  // global-agent's patched https.globalAgent.  To route the probe through the
  // VPN proxy (V2RayTun) we must create an undici ProxyAgent ourselves and
  // pass it as the `dispatcher` option to fetch().
  const probeResult = await (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let dispatcher = undefined;
    const proxyUrl = getProxyUrl();

    if (proxyUrl) {
      try {
        const undici = await import("undici");
        dispatcher = new undici.ProxyAgent(proxyUrl);
      } catch {
        // undici not available — fall through without dispatcher
      }
    }

    try {
      const targetUrl = getCircleApiProbeTarget();
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: createProbeHeaders(),
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {})
      });

      if (response.status === 403) {
        const body = await response.text().catch(() => "");

        if (body.includes("1009")) {
          return {
            ok: false,
            detail:
              "Circle API blocked this machine's public IP or region (Cloudflare 1009). " +
              "Use an allowed egress IP or set HTTPS_PROXY to a supported region."
          };
        }
      }

      if (response.status >= 200 && response.status < 500) {
        return { ok: true };
      }

      return {
        ok: false,
        detail: `Circle API preflight failed with HTTP ${response.status || "unknown"}.`
      };
    } catch (error) {
      const message = String(error?.message || "");

      if (error?.name === "AbortError" || /abort/i.test(message)) {
        return {
          ok: false,
          detail: "Circle API preflight timed out after 15s"
        };
      }

      return {
        ok: false,
        detail: `Circle API preflight failed: ${message}`
      };
    } finally {
      clearTimeout(timer);
      if (dispatcher?.close) dispatcher.close().catch(() => {});
    }
  })();

  cachedCircleAccessProbe = probeResult;
  cachedCircleAccessProbeTimestamp = now;
  return cachedCircleAccessProbe;
}

async function ensureWalletSet() {
  if (cachedWalletSetId) return cachedWalletSetId;

  const client = getCircleClient();
  const response = await client.createWalletSet({
    name: `muse-session-${Date.now()}`,
    idempotencyKey: crypto.randomUUID()
  });

  const walletSetId = response.data?.walletSet?.id;
  if (!walletSetId) {
    throw new Error("Wallet Set creation failed: no ID returned");
  }
  cachedWalletSetId = walletSetId;
  console.log(`Created wallet set: ${cachedWalletSetId}`);
  return cachedWalletSetId;
}

// Read the native-USDC balance of any EVM address on Arc Testnet by talking
// directly to the RPC. Needed because MetaMask's eth_getBalance only works
// when the user is currently connected to Arc — we want the UI to show the
// real Arc balance even if the user is on a different chain in their wallet.
router.get("/native-balance", async (req, res) => {
  const addr = String(req.query.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  const rpcUrl =
    process.env.ARC_RPC_URL ||
    process.env.NEXT_PUBLIC_ARC_RPC_URL ||
    "https://rpc.testnet.arc.network";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [addr, "latest"], id: 1 }),
      signal: controller.signal
    });
    const data = await r.json();
    if (data.error || !data.result) {
      return res.status(502).json({ error: data.error?.message || "RPC returned no result" });
    }
    const raw = BigInt(data.result);
    // Arc Testnet RPC returns native balance in 18-decimal wei units (the
    // standard EVM convention) even though the gas token is denominated as
    // USDC. Earlier code used 6 decimals and produced absurdly inflated
    // balances like "16,784,733 USDC" for a freshly-funded account.
    const balanceUsdc = Number(formatUnits(raw, 18));
    return res.json({
      address: addr,
      balanceUsdc: Number(balanceUsdc.toFixed(6)),
      rawWei: raw.toString(),
      chainId: Number(process.env.ARC_CHAIN_ID || 5042002),
      network: "arc-testnet"
    });
  } catch (err) {
    return res.status(502).json({ error: err?.name === "AbortError" ? "RPC timeout" : (err?.message || "RPC error") });
  } finally {
    clearTimeout(timer);
  }
});

// GET /api/wallet/orchestrator?mainWallet=0x... — look up existing mapping
// WITHOUT creating one. Frontend calls this on connect so it can show a
// "DEPLOY ORCHESTRATOR" button when the user has never deployed, and the
// orchestrator chip directly when they have.
router.get("/orchestrator", async (req, res) => {
  try {
    const mainWallet = String(req.query.mainWallet || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(mainWallet)) {
      return res.status(400).json({ error: "Invalid mainWallet address" });
    }
    // Use the same service but don't create — we'll hit the raw memory/file
    // store via the get-or-create function and detect "would create" by checking
    // if the address existed before the call. Simpler: do a direct lookup via
    // a helper. Add one inline: import getExistingOrchestrator if available;
    // otherwise call get-or-create and treat every call as idempotent — but
    // we DO want to avoid minting on a GET. So: attempt lookup via stored state.
    // The service's readMapping is internal; expose it via getOrchestratorBalance
    // which returns address:null when missing.
    const bal = await getOrchestratorBalance(mainWallet);
    if (!bal.address) {
      return res.status(404).json({ error: "Orchestrator not deployed yet" });
    }
    res.json({
      address: bal.address,
      balanceUsdc: bal.balanceUsdc,
      deployed: true
    });
  } catch (err) {
    console.error("[orchestrator] lookup failed:", err?.message);
    res.status(500).json({ error: err?.message || "Lookup failed" });
  }
});

// POST /api/wallet/orchestrator — idempotent get-or-create per main wallet.
// Returns the same self-managed orchestrator address for a given MetaMask
// across every restart. Generates a fresh 256-bit private key on first call
// and persists it so the backend can sign micro-payments and withdraws.
router.post("/orchestrator", async (req, res) => {
  try {
    const mainWallet = String(req.body?.mainWallet || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(mainWallet)) {
      return res.status(400).json({ error: "Invalid mainWallet address" });
    }
    const mapping = await getOrCreateOrchestrator(mainWallet);
    res.json({
      address: mapping.address,
      walletId: mapping.walletId,
      mode: mapping.mode,
      createdAt: mapping.createdAt,
      withdrawEnabled: Boolean(mapping.privateKey)
    });
  } catch (err) {
    console.error("[orchestrator] get-or-create failed:", err?.response?.data || err?.message);
    res.status(500).json({ error: "Failed to provision orchestrator wallet", detail: err?.message || null });
  }
});

// GET /api/wallet/orchestrator/max-withdraw?mainWallet=0x... — returns the
// exact maximum withdrawable amount after subtracting the on-chain gas reserve
// estimated for this orchestrator + destination pair. The UI calls this when
// the user clicks MAX so the field is populated with a value that is
// guaranteed to succeed on-chain.
router.get("/orchestrator/max-withdraw", async (req, res) => {
  try {
    const mainWallet = String(req.query.mainWallet || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(mainWallet)) {
      return res.status(400).json({ error: "Invalid mainWallet address" });
    }
    const data = await getMaxWithdrawable(mainWallet);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to compute max withdraw" });
  }
});

// POST /api/wallet/orchestrator/withdraw — real on-chain transfer from the
// orchestrator back to the mainWallet via viem. Destination is hard-locked
// to the mainWallet that owns this orchestrator, so the funds always land
// in the legitimate owner's MetaMask — a stranger cannot redirect them.
// However, an unauthenticated POST still creates a DoS-drain: an attacker
// can repeatedly trigger withdraws (each burns native USDC for gas and
// pulls the gateway-deposited float back on-chain), forcing the owner to
// re-deposit before every task. We mitigate by rate-limiting per (IP,
// mainWallet) pair to 3 attempts per 5 minutes — enough for a real user
// who might fat-finger or retry, far below the "drain on a cron" pattern.
//
// PRODUCTION ROADMAP: full SIWE-signed body — frontend prompts MetaMask
// to sign `MUSE_WITHDRAW:<mainWallet>:<amount>:<ts>:<nonce>`, backend
// recovers signer and asserts equality with `mainWallet`. The rate limit
// then stops being load-bearing; for now it's the live defence.
const WITHDRAW_RATE_WINDOW_MS = 5 * 60 * 1000;
const WITHDRAW_RATE_MAX = 3;
const withdrawAttempts = new Map(); // key → number[] (timestamps)
const WITHDRAW_RATE_KEY_CAP = 4096;
function pruneWithdrawAttempts(now) {
  // Prune both per-key (drop expired stamps) and the map itself if it
  // grew past the cap — same eviction pattern used elsewhere.
  for (const [k, stamps] of withdrawAttempts) {
    const fresh = stamps.filter((t) => now - t < WITHDRAW_RATE_WINDOW_MS);
    if (fresh.length === 0) withdrawAttempts.delete(k);
    else withdrawAttempts.set(k, fresh);
  }
  if (withdrawAttempts.size > WITHDRAW_RATE_KEY_CAP) {
    const drop = withdrawAttempts.size - WITHDRAW_RATE_KEY_CAP;
    let i = 0;
    for (const k of withdrawAttempts.keys()) {
      if (i++ >= drop) break;
      withdrawAttempts.delete(k);
    }
  }
}
router.post("/orchestrator/withdraw", async (req, res) => {
  try {
    const mainWallet = String(req.body?.mainWallet || "").trim();
    const amountUsdc = req.body?.amountUsdc;
    if (!/^0x[0-9a-fA-F]{40}$/.test(mainWallet)) {
      return res.status(400).json({ error: "Invalid mainWallet address" });
    }
    // Rate limit per (IP, mainWallet) — caps drain-DoS without breaking
    // legitimate retries.
    const now = Date.now();
    const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
    const rateKey = `${ip}::${mainWallet.toLowerCase()}`;
    const stamps = (withdrawAttempts.get(rateKey) || []).filter((t) => now - t < WITHDRAW_RATE_WINDOW_MS);
    if (stamps.length >= WITHDRAW_RATE_MAX) {
      const retryInSec = Math.ceil((stamps[0] + WITHDRAW_RATE_WINDOW_MS - now) / 1000);
      return res.status(429).json({
        error: `Too many withdraw attempts. Try again in ~${retryInSec}s.`,
        retryAfter: retryInSec
      });
    }
    stamps.push(now);
    withdrawAttempts.set(rateKey, stamps);
    if (Math.random() < 0.05) pruneWithdrawAttempts(now);

    const result = await withdrawOrchestrator({ mainWallet, amountUsdc });
    res.json({
      ok: true,
      txHash: result.txHash,
      source: result.source,
      destination: result.destination,
      amountUsdc: result.amountUsdc,
      explorerUrl: result.explorerUrl
    });
  } catch (err) {
    const code = err?.code === "NO_KEY" ? 503 : 400;
    const rawMessage = String(err?.shortMessage || err?.details || err?.message || "");
    console.error("[orchestrator] withdraw failed:", err?.response?.data || rawMessage);
    // Translate viem's wall-of-text RPC errors into something the UI can
    // show the user without leaking internal request bodies, signatures, or
    // node-internal hex. Anything we don't recognise gets a short generic
    // fallback — the raw error stays in the backend log for debugging.
    let friendly;
    if (/txpool is full/i.test(rawMessage)) {
      friendly = "Arc Testnet mempool is congested. Retried twice — please try again in ~30 seconds.";
    } else if (/insufficient funds|gas required exceeds allowance|exceeds balance/i.test(rawMessage)) {
      friendly = "Orchestrator balance is below the on-chain gas reserve. Top up first.";
    } else if (/nonce too low|already known|replacement transaction underpriced/i.test(rawMessage)) {
      friendly = "A conflicting transaction is still pending — wait a few seconds and retry.";
    } else if (/timeout|fetch failed|ECONNRESET|ENETUNREACH|ENOTFOUND|getaddrinfo/i.test(rawMessage)) {
      friendly = "Arc Testnet RPC is unreachable right now. Try again shortly.";
    } else if (code === 503) {
      friendly = rawMessage || "This orchestrator has no signing key.";
    } else if (/amountUsdc|positive number/i.test(rawMessage)) {
      friendly = rawMessage;
    } else {
      friendly = "Withdraw failed on Arc Testnet. Try again — if it persists, ping us.";
    }
    res.status(code).json({ error: friendly });
  }
});

router.get("/status", async (_req, res) => {
  const mode = getWalletRuntimeMode();

  if (mode === "unconfigured") {
    return res.json({
      mode,
      hasCircleCredentials: false,
      hasSelfManagedKey: false,
      mockEnabled: false,
      fundingEnabled: false,
      detail:
        "No wallet backend configured. Set either (1) CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET for Circle mode, " +
        "or (2) MUSE_BUYER_PRIVATE_KEY for self-managed mode, " +
        "or (3) MOCK_X402=true for mock/demo mode."
    });
  }

  if (mode === "mock") {
    return res.json({
      mode,
      hasCircleCredentials: false,
      hasSelfManagedKey: false,
      mockEnabled: true,
      fundingEnabled: false,
      detail: null
    });
  }

  if (mode === "self-managed") {
    return res.json({
      mode,
      hasCircleCredentials: false,
      hasSelfManagedKey: true,
      mockEnabled: false,
      fundingEnabled: true,
      detail: null
    });
  }

  // circle mode
  const accessProbe = await probeCircleApiAccess();

  return res.json({
    mode,
    hasCircleCredentials: true,
    hasSelfManagedKey: hasSelfManagedKey(),
    mockEnabled: false,
    fundingEnabled: accessProbe.ok,
    detail: accessProbe.ok ? null : accessProbe.detail
  });
});

// POST /api/wallet/create — creates session wallets tied to the user's main wallet
router.post("/create", requireAdminAuth, async (req, res) => {
  try {
    const mainWalletAddress = req.body?.mainWalletAddress || "anonymous";
    const mode = getWalletRuntimeMode();

    if (mode === "mock") {
      const sessionWallets = createMockSessionWallets(mainWalletAddress);

      console.log(
        `Provisioned mock wallet session for ${mainWalletAddress}:`
      );

      return res.json(sessionWallets);
    }

    if (mode === "self-managed") {
      try {
        const sessionWallets = await createSelfManagedSessionWallets(mainWalletAddress);
        console.log(
          `Provisioned self-managed session for MetaMask ${mainWalletAddress} → orch ${sessionWallets.payer.address}`
        );
        return res.json(sessionWallets);
      } catch (err) {
        return res.status(400).json({
          error: err?.message || "Failed to provision per-user session wallets.",
          needsConnect: /mainWalletAddress is required/i.test(String(err?.message || ""))
        });
      }
    }

    if (mode === "unconfigured") {
      return res.status(503).json({
        error: "Wallet backend is not configured",
        detail:
          "Set CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET for Circle mode, MUSE_BUYER_PRIVATE_KEY for self-managed mode, or MOCK_X402=true for mock mode."
      });
    }

    // Serialize Circle wallet creation to prevent duplicate wallet sets
    // from concurrent requests for the same user.
    // H6 fix: use .then().catch() so a previous rejection doesn't permanently
    // break the lock chain. The catch ensures the lock always settles.
    const result = await new Promise((resolve, reject) => {
      walletCreationLock = walletCreationLock.catch(() => {}).then(async () => {
        try {
          const accessProbe = await probeCircleApiAccess();

          if (!accessProbe.ok) {
            resolve({
              error: true,
              status: 502,
              body: {
                error: "Circle API is not reachable from this machine",
                detail: accessProbe.detail
              }
            });
            return;
          }

          const client = getCircleClient();
          const walletSetId = await ensureWalletSet();

          const response = await client.createWallets({
            blockchains: [ARC_BLOCKCHAIN],
            count: 1,
            walletSetId,
            accountType: "EOA",
            idempotencyKey: crypto.randomUUID()
          });

          const wallets = response.data?.wallets;

          if (!wallets || wallets.length < 1) {
            throw new Error(`Expected 1 wallet, got ${wallets?.length || 0}`);
          }

          resolve({
            error: false,
            body: buildSessionWalletsResponse({
              payerId: wallets[0].id,
              payerAddress: wallets[0].address,
              balance: "0.00",
              mode: "circle",
              fundingDisabled: false
            })
          });
        } catch (innerError) {
          reject(innerError);
        }
      });
    });

    if (result.error) {
      return res.status(result.status).json(result.body);
    }

    console.log(
      `Session wallets created on ${ARC_BLOCKCHAIN} for main wallet ${mainWalletAddress}:`
    );

    res.json(result.body);
  } catch (error) {
    // H3 fix: log only the message, not the full stack (which could contain private key values).
    console.error("Wallet creation failed:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to create session wallets on Arc testnet",
      detail: null
    });
  }
});

// Wallet IDs we accept: Circle dev-controlled UUID, our own self-managed
// (`self-managed-…`, `e2e-self-managed`, `mock-…`) or seller-* synthetics.
// Anything else is bogus — reject up front so we don't pass garbage into
// the Circle SDK / log files / DB lookups.
const WALLET_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function validateWalletParam(req, res) {
  const id = String(req.params.id || "").trim();
  if (!id || !WALLET_ID_REGEX.test(id)) {
    res.status(400).json({ error: "Invalid wallet ID format" });
    return null;
  }
  return id;
}

// GET /api/wallet/:id/balance — fetch USDC balance for a wallet
router.get("/:id/balance", async (req, res) => {
  try {
    if (!validateWalletParam(req, res)) return;
    const mockWallet = findMockWalletById(req.params.id);

    if (mockWallet?.mode === "mock") {
      return res.json(
        buildWalletBalanceResponse({
          walletAddress: mockWallet.address,
          walletBalance: mockWallet.balance || "0.00",
          gatewayBalance: {
            total: 0n,
            available: 0n,
            withdrawing: 0n,
            withdrawable: 0n,
            formattedTotal: mockWallet.balance || "0.00",
            formattedAvailable: mockWallet.balance || "0.00",
            formattedWithdrawing: "0.00",
            formattedWithdrawable: "0.00"
          },
          mode: "mock"
        })
      );
    }

    if (mockWallet?.mode === "self-managed") {
      const gatewayBalance = await fetchGatewayBalanceByAddress(mockWallet.address);
      return res.json(
        buildWalletBalanceResponse({
          walletAddress: mockWallet.address,
          walletBalance: "0.00",
          gatewayBalance,
          mode: "self-managed"
        })
      );
    }

    const client = getCircleClient();
    const walletId = req.params.id;
    const wallet = await getCircleWalletRecord(walletId);
    const [walletBalance, gatewayBalance] = await Promise.all([
      getCircleWalletUsdcBalance(client, walletId),
      fetchGatewayBalanceByAddress(wallet.address)
    ]);

    res.json(
      buildWalletBalanceResponse({
        walletAddress: wallet.address,
        walletBalance,
        gatewayBalance
      })
    );
  } catch (error) {
    console.error("Wallet balance fetch failed:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to fetch wallet balance",
      detail: null
    });
  }
});

// POST /api/wallet/:id/withdraw — prepare a withdrawal
router.post("/:id/withdraw", requireAdminAuth, async (req, res) => {
  try {
    if (!validateWalletParam(req, res)) return;
    const mockWallet = findMockWalletById(req.params.id);

    if (mockWallet?.mode === "mock") {
      return res.status(400).json({
        error: "Demo wallets do not support live withdrawals."
      });
    }

    const amount = String(req.body?.amount || "").trim();
    const recipientAddress = String(req.body?.recipientAddress || "").trim();
    const maxFeeUsdc = String(req.body?.maxFeeUsdc || DEFAULT_WITHDRAW_MAX_FEE_USDC).trim();

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "Enter a valid withdrawal amount." });
    }

    if (!isAddress(recipientAddress)) {
      return res.status(400).json({ error: "Enter a valid recipient address." });
    }

    let walletAddress;
    if (mockWallet?.mode === "self-managed") {
      walletAddress = mockWallet.address;
    } else {
      const wallet = await getCircleWalletRecord(req.params.id);
      walletAddress = wallet.address;
    }

    const gatewayBalance = await fetchGatewayBalanceByAddress(walletAddress);
    const requestedAmount = parseUnits(amount, 6);

    if (gatewayBalance.available < requestedAmount) {
      return res.status(400).json({
        error: "Insufficient orchestrator Gateway balance.",
        detail: `Available: ${gatewayBalance.formattedAvailable} USDC`
      });
    }

    const withdrawal = await prepareGatewayWithdrawal({
      // M13 fix: self-managed wallets use synthetic IDs (e.g. "self-managed-0xABC")
      // that aren't valid Circle wallet IDs. Pass null so the Gateway uses address-based lookup.
      walletId: mockWallet?.mode === "self-managed" ? null : req.params.id,
      walletAddress,
      recipientAddress,
      amount,
      maxFeeUsdc
    });

    res.json({
      ok: true,
      blockchain: ARC_BLOCKCHAIN,
      sourceWalletAddress: walletAddress,
      recipientAddress: withdrawal.recipientAddress,
      amount: withdrawal.amount,
      transferId: withdrawal.transferId,
      attestation: withdrawal.attestation,
      signature: withdrawal.signature,
      mintContract: withdrawal.mintContract,
      chainId: withdrawal.chainId,
      explorerBaseUrl: ARC_EXPLORER_TX_BASE
    });
  } catch (error) {
    console.error("Wallet withdrawal preparation failed:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to prepare orchestrator withdrawal.",
      detail: null
    });
  }
});

// GET /api/wallet/:id — get wallet details
router.get("/:id", async (req, res) => {
  try {
    if (!validateWalletParam(req, res)) return;
    const mockWallet = findMockWalletById(req.params.id);

    if (mockWallet?.mode === "mock" || mockWallet?.mode === "self-managed") {
      return res.json(mockWallet);
    }

    const client = getCircleClient();
    const response = await client.getWallet({ id: req.params.id });
    res.json(extractWalletLookupRecord(response.data, req.params.id) || response.data);
  } catch (error) {
    console.error("Wallet lookup failed:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to get wallet details" });
  }
});

export default router;
