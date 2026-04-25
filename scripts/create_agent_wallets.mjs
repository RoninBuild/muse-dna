import "../shared/load-env.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_BLOCKCHAIN = process.env.ARC_BLOCKCHAIN || "ARC-TESTNET";
const DEFAULT_WALLET_SET_NAME =
  process.env.AGENT_WALLET_SET_NAME || "Muse Agent Wallets";
const AGENT_ENV_KEYS = [
  "STRATEGY_AGENT_WALLET",
  "FAST_SEARCH_WALLET",
  "COPY_AGENT_WALLET",
  "IMAGE_AGENT_WALLET"
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function getRequiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the environment or ${path.join(ROOT_DIR, ".env")}.`
    );
  }

  return value;
}

function getWalletCount() {
  const parsed = Number(process.env.AGENT_WALLET_COUNT || AGENT_ENV_KEYS.length);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : AGENT_ENV_KEYS.length;
}

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: getRequiredEnv("CIRCLE_API_KEY"),
    entitySecret: getRequiredEnv("CIRCLE_ENTITY_SECRET")
  });
}

async function ensureWalletSet(client) {
  const existingWalletSetId = String(
    process.env.AGENT_WALLET_SET_ID || process.env.USER_WALLET_SET_ID || ""
  ).trim();

  if (existingWalletSetId) {
    return existingWalletSetId;
  }

  const response = await client.createWalletSet({
    name: DEFAULT_WALLET_SET_NAME,
    idempotencyKey: crypto.randomUUID()
  });
  const walletSetId = response.data?.walletSet?.id;

  if (!walletSetId) {
    throw new Error("Wallet Set creation failed: Circle returned no walletSet.id");
  }

  return walletSetId;
}

async function createWallets(client, walletSetId) {
  const count = getWalletCount();
  const response = await client.createWallets({
    walletSetId,
    blockchains: [DEFAULT_BLOCKCHAIN],
    count,
    accountType: "EOA",
    idempotencyKey: crypto.randomUUID()
  });
  const wallets = response.data?.wallets;

  if (!Array.isArray(wallets) || wallets.length < count) {
    throw new Error(
      `Expected ${count} wallets from Circle, got ${wallets?.length || 0}`
    );
  }

  return wallets;
}

function printWalletSummary(walletSetId, wallets) {
  console.log(`Wallet set: ${walletSetId}`);
  console.log(`Blockchain: ${DEFAULT_BLOCKCHAIN}`);
  console.log("");
  console.log("Add these values to your environment:");
  console.log(`AGENT_WALLET_SET_ID=${walletSetId}`);

  AGENT_ENV_KEYS.forEach((envKey, index) => {
    const wallet = wallets[index];

    if (!wallet?.address) {
      throw new Error(`Circle response is missing address for ${envKey}`);
    }

    console.log(`${envKey}=${wallet.address}`);
  });

  const extraWallets = wallets.slice(AGENT_ENV_KEYS.length);
  if (extraWallets.length > 0) {
    console.log("");
    console.log("Additional wallets created:");
    extraWallets.forEach((wallet, index) => {
      console.log(`EXTRA_AGENT_WALLET_${index + 1}=${wallet.address}`);
    });
  }
}

export async function main() {
  loadEnvFile(path.join(ROOT_DIR, ".env.local"));

  const client = getCircleClient();
  const walletSetId = await ensureWalletSet(client);
  const wallets = await createWallets(client, walletSetId);

  printWalletSummary(walletSetId, wallets);
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
