import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { CIRCLE_BATCHING_NAME, CIRCLE_BATCHING_VERSION } from "@circle-fin/x402-batching";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_CAIP2_NETWORK,
  ARC_GATEWAY_WALLET_CONTRACT,
  ARC_USDC_TOKEN_ADDRESS,
  X402_PAYMENT_MAX_TIMEOUT_SECONDS,
  X402_VERSION,
  createMockX402Scheme
} from "./x402protocol.js";

const FALLBACK_WALLET_ADDRESS = "0xFEE0000000000000000000000000000000000000";
const FALLBACK_WALLET_ID = "mock-orchestrator-wallet";

let circleClient = null;

/**
 * Returns the explicitly configured self-managed private key, if any.
 * We do NOT silently fall back to ORCHESTRATOR_PRIVATE_KEY when a walletId
 * is provided — that would fake a Circle dev-controlled wallet flow.
 */
function isSelfManagedWalletId(walletId) {
  return typeof walletId === "string" && walletId.startsWith("self-managed");
}

function isMockWalletId(walletId) {
  return typeof walletId === "string" && walletId.startsWith("mock");
}

function resolveExplicitPrivateKey(overrides = {}) {
  if (overrides.privateKey) {
    return String(overrides.privateKey).trim();
  }

  // ENV FALLBACK GUARD — the env-provided MUSE_BUYER_PRIVATE_KEY is the
  // shared CI/headless test wallet. If we let it leak into the UI flow,
  // every connected MetaMask would silently spend the SAME wallet's
  // Gateway balance, which is exactly the multi-user bug we're closing.
  //
  // Only return the env key when the caller has explicitly opted in via
  // `useEnvFallback: true` (live-hackathon-proof.mjs, e2e-storm.mjs, and
  // other headless scripts). UI-driven calls MUST pass a per-user
  // `privateKey` (read from orchestrator-wallets.json by the route layer)
  // and never reach this fallback.
  const looksLikeCircleWalletId =
    overrides.walletId &&
    !isSelfManagedWalletId(overrides.walletId) &&
    !isMockWalletId(overrides.walletId);

  if (!looksLikeCircleWalletId && !overrides.useCircleIfAvailable && overrides.useEnvFallback === true) {
    const envKey =
      process.env.MUSE_BUYER_PRIVATE_KEY ||
      process.env.MUSE_GATEWAY_PRIVATE_KEY ||
      process.env.ORCHESTRATOR_PRIVATE_KEY ||
      "";
    return String(envKey || "").trim();
  }

  return "";
}

function isValidPrivateKey(key) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(key || "").trim());
}

function resolveLocalSignerAccount(overrides = {}) {
  const key = resolveExplicitPrivateKey(overrides);
  return isValidPrivateKey(key) ? privateKeyToAccount(key) : null;
}

function resolveWalletAddress(overrides) {
  const localSigner = resolveLocalSignerAccount(overrides);
  if (localSigner) {
    return localSigner.address;
  }

  return (
    overrides.walletAddress ||
    process.env.ORCHESTRATOR_WALLET_ADDRESS ||
    FALLBACK_WALLET_ADDRESS
  );
}

function resolveWalletId(overrides) {
  // If the caller explicitly wants Circle mode and provided a walletId, use it.
  if (overrides.walletId) {
    return overrides.walletId;
  }

  // If we have a local signer, we do not need a Circle walletId.
  if (resolveLocalSignerAccount(overrides)) {
    return null;
  }

  return process.env.ORCHESTRATOR_WALLET_ID || FALLBACK_WALLET_ID;
}

// L2 fix: single source of truth for credential checks (wallet.js also rejected TEST_API_KEY).
export function hasCircleWalletCredentials() {
  const apiKey = process.env.CIRCLE_API_KEY || "";
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET || "";
  return Boolean(apiKey && entitySecret && !apiKey.startsWith("TEST_API_KEY"));
}

// L1 fix: export so wallet.js uses the same client singleton.
export function getCircleClient() {
  if (!circleClient) {
    if (!hasCircleWalletCredentials()) {
      throw new Error(
        "Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET for Circle dev-controlled wallet mode."
      );
    }

    circleClient = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET
    });
  }

  return circleClient;
}

export function stringifyTypedDataForCircle(typedData) {
  const normalized = normalizeTypedDataForCircle(typedData);

  return JSON.stringify(normalized, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

export function buildCircleEip712DomainTypes(domain = {}) {
  const domainFields = [];

  if (domain.name !== undefined) {
    domainFields.push({ name: "name", type: "string" });
  }

  if (domain.version !== undefined) {
    domainFields.push({ name: "version", type: "string" });
  }

  if (domain.chainId !== undefined) {
    domainFields.push({ name: "chainId", type: "uint256" });
  }

  if (domain.verifyingContract !== undefined) {
    domainFields.push({ name: "verifyingContract", type: "address" });
  }

  if (domain.salt !== undefined) {
    domainFields.push({ name: "salt", type: "bytes32" });
  }

  return domainFields;
}

export function normalizeTypedDataForCircle(typedData) {
  if (!typedData || typeof typedData !== "object") {
    return typedData;
  }

  const types =
    typedData.types && typeof typedData.types === "object" && !Array.isArray(typedData.types)
      ? typedData.types
      : null;

  if (!types || types.EIP712Domain) {
    return typedData;
  }

  const eip712Domain = buildCircleEip712DomainTypes(typedData.domain);
  if (eip712Domain.length === 0) {
    return typedData;
  }

  return {
    ...typedData,
    types: {
      EIP712Domain: eip712Domain,
      ...types
    }
  };
}

function buildDefaultPaymentRequired({
  amount,
  asset,
  payTo,
  network,
  resource,
  description,
  idempotencyKey
}) {
  const mockX402 = process.env.MOCK_X402 === "true";

  return {
    x402Version: X402_VERSION,
    resource: {
      url: resource || "/execute",
      description: description || "Paid resource",
      mimeType: "application/json"
    },
    accepts: [
      {
        scheme: "exact",
        network: network || ARC_CAIP2_NETWORK,
        asset: asset || ARC_USDC_TOKEN_ADDRESS,
        amount: String(amount),
        payTo,
        maxTimeoutSeconds: X402_PAYMENT_MAX_TIMEOUT_SECONDS,
        extra: mockX402
          ? {}
          : {
              name: CIRCLE_BATCHING_NAME,
              version: CIRCLE_BATCHING_VERSION,
              verifyingContract: ARC_GATEWAY_WALLET_CONTRACT
            }
      }
    ],
    extensions: {
      muse: {
        idempotencyKey: idempotencyKey || null,
        settlementMode: mockX402 ? "mock" : "real"
      }
    }
  };
}

function createCircleBatchSigner(overrides) {
  const localSignerAccount = resolveLocalSignerAccount(overrides);

  if (localSignerAccount) {
    return {
      address: localSignerAccount.address,
      async signTypedData(params) {
        return localSignerAccount.signTypedData(params);
      }
    };
  }

  const walletAddress = resolveWalletAddress(overrides);
  const walletId = overrides.walletId || process.env.ORCHESTRATOR_WALLET_ID || null;

  return {
    address: walletAddress,
    async signTypedData(params) {
      const client = getCircleClient();
      const data = stringifyTypedDataForCircle(params);
      const response = walletId
        ? await client.signTypedData({
            walletId,
            data
          })
        : await client.signTypedData({
            walletAddress,
            blockchain: process.env.ARC_BLOCKCHAIN || "ARC-TESTNET",
            data
          });
      const signature = response.data?.signature;

      if (!signature) {
        throw new Error("Circle signTypedData returned no signature");
      }

      return signature;
    }
  };
}

export function createCircleWalletClient(overrides = {}) {
  const walletAddress = resolveWalletAddress(overrides);
  const walletId = resolveWalletId(overrides);
  let httpClient = null;

  function getHttpClient() {
    if (!httpClient) {
      const client = new x402Client();
      const useMock = process.env.MOCK_X402 === "true";

      let schemeClient;
      if (useMock) {
        schemeClient = createMockX402Scheme({
          walletId: walletId || FALLBACK_WALLET_ID,
          walletAddress
        });
      } else {
        const signer = createCircleBatchSigner(overrides);
        schemeClient = new BatchEvmScheme(signer);
      }

      client.register(ARC_CAIP2_NETWORK, schemeClient);
      httpClient = new x402HTTPClient(client);
    }

    return httpClient;
  }

  return {
    address: walletAddress,
    walletId,
    mode: (() => {
      if (process.env.MOCK_X402 === "true") {
        return "mock";
      }

      if (isSelfManagedWalletId(walletId)) {
        return "self-managed";
      }

      if (isMockWalletId(walletId)) {
        return "mock";
      }

      if (walletId && hasCircleWalletCredentials()) {
        return "circle";
      }

      if (resolveLocalSignerAccount(overrides)) {
        return "self-managed";
      }

      return "unconfigured";
    })(),

    async createPaymentPayload(paymentRequired) {
      return getHttpClient().createPaymentPayload(paymentRequired);
    },

    encodePaymentSignatureHeader(paymentPayload) {
      return getHttpClient().encodePaymentSignatureHeader(paymentPayload);
    },

    getPaymentRequiredResponse(getHeader, body) {
      return getHttpClient().getPaymentRequiredResponse(getHeader, body);
    },

    getPaymentSettleResponse(getHeader) {
      return getHttpClient().getPaymentSettleResponse(getHeader);
    },

    async signForX402({
      amount,
      asset,
      payTo,
      network,
      resource,
      description,
      idempotencyKey = null
    }) {
      const paymentRequired = buildDefaultPaymentRequired({
        amount,
        asset,
        payTo,
        network,
        resource,
        description,
        idempotencyKey
      });
      const paymentPayload = await getHttpClient().createPaymentPayload(paymentRequired);

      return {
        ...paymentPayload.payload,
        accepted: paymentPayload.accepted,
        resource: paymentPayload.resource,
        extensions: paymentPayload.extensions,
        x402Version: paymentPayload.x402Version
      };
    }
  };
}

// H8 fix: lazy-init singleton so env vars are always loaded before first use.
let _circleWalletSingleton = null;

export function getCircleWalletSingleton() {
  if (!_circleWalletSingleton) {
    _circleWalletSingleton = createCircleWalletClient();
  }
  return _circleWalletSingleton;
}

// Backward-compat: keep the named export but as a getter on a proxy object.
// Modules that already destructured `circleWallet` will still work.
export const circleWallet = new Proxy({}, {
  get(_target, prop) {
    return getCircleWalletSingleton()[prop];
  }
});
