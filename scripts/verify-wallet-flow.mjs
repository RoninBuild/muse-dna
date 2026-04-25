import "../shared/load-env.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const buyerPrivateKey = String(process.env.MUSE_BUYER_PRIVATE_KEY || "").trim();
const backendPort = 3302;
const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
const targetGatewayAmount = 0.05;
const withdrawAmount = "0.01";
const gatewayMinterAbi = [
  {
    name: "gatewayMint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" }
    ],
    outputs: []
  }
];

if (!/^0x[0-9a-fA-F]{64}$/.test(buyerPrivateKey)) {
  throw new Error(
    "Set MUSE_BUYER_PRIVATE_KEY to a funded Arc testnet wallet private key before running verify-wallet-flow."
  );
}

function startBackend(env) {
  const child = spawn("node", ["index.js"], {
    cwd: path.join(rootDir, "backend"),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[backend:err] ${chunk}`);
  });

  return child;
}

function stopProcess(child) {
  if (!child?.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore"
    });
    return;
  }

  child.kill("SIGTERM");
}

function killPortPidsWindows(port) {
  const netstat = spawnSync("netstat", ["-ano"], {
    encoding: "utf-8"
  });

  if (netstat.status !== 0) {
    return;
  }

  const pids = new Set();
  for (const line of netstat.stdout.split(/\r?\n/)) {
    if (!line.includes(`:${port}`) || !line.includes("LISTENING")) {
      continue;
    }

    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && /^\d+$/.test(pid)) {
      pids.add(pid);
    }
  }

  for (const pid of pids) {
    spawnSync("taskkill", ["/PID", pid, "/F"], {
      stdio: "ignore"
    });
  }
}

async function freePort(port) {
  if (process.platform !== "win32") {
    return;
  }

  killPortPidsWindows(port);
  await delay(1200);
}

async function waitForBackend(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${backendBaseUrl}/health`);
      if (response.ok || response.status === 503) {
        return;
      }
    } catch {
      // keep polling
    }

    await delay(400);
  }

  throw new Error("Timed out waiting for backend health.");
}

async function createSessionWallet(mainWalletAddress) {
  const response = await fetch(`${backendBaseUrl}/api/wallet/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ mainWalletAddress })
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Wallet create failed with ${response.status}`);
  }

  return body;
}

async function getWalletBalance(walletId) {
  const response = await fetch(`${backendBaseUrl}/api/wallet/${walletId}/balance`);
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Balance fetch failed with ${response.status}`);
  }

  return body;
}

async function waitForGatewayBalance(walletId, minimumAmount, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastBalance = null;

  while (Date.now() < deadline) {
    lastBalance = await getWalletBalance(walletId);
    const available = Number(lastBalance.gatewayAvailable ?? lastBalance.balance ?? 0);

    if (available >= minimumAmount - 0.000001) {
      return lastBalance;
    }

    await delay(1200);
  }

  throw new Error(
    `Gateway balance for ${walletId} did not reach ${minimumAmount.toFixed(3)} USDC in time.`
  );
}

async function prepareWithdrawal(walletId, amount, recipientAddress) {
  const response = await fetch(`${backendBaseUrl}/api/wallet/${walletId}/withdraw`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      amount,
      recipientAddress
    })
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Withdraw prepare failed with ${response.status}`);
  }

  return body;
}

async function main() {
  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: buyerPrivateKey
  });
  await freePort(backendPort);
  const backend = startBackend({
    ...process.env,
    DB_MODE: "memory",
    MOCK_X402: "false",
    MUSE_RECOVER_INTERRUPTED_TASKS: "false",
    PORT: String(backendPort)
  });

  try {
    await waitForBackend();

    const sessionWallets = await createSessionWallet(gateway.address);
    const initialBalance = await getWalletBalance(sessionWallets.payer.id);
    const currentAvailable = Number(initialBalance.gatewayAvailable ?? initialBalance.balance ?? 0);
    const shortfall = Math.max(0, Number((targetGatewayAmount - currentAvailable).toFixed(6)));

    if (shortfall > 0) {
      await gateway.depositFor(shortfall.toFixed(6), sessionWallets.payer.address);
    }

    const fundedBalance = await waitForGatewayBalance(
      sessionWallets.payer.id,
      Math.max(targetGatewayAmount, currentAvailable)
    );

    assert.ok(Number(fundedBalance.gatewayAvailable ?? fundedBalance.balance ?? 0) >= targetGatewayAmount);

    const preparedWithdrawal = await prepareWithdrawal(
      sessionWallets.payer.id,
      withdrawAmount,
      gateway.address
    );

    assert.ok(preparedWithdrawal.attestation, "Withdrawal should return an attestation");
    assert.ok(preparedWithdrawal.signature, "Withdrawal should return an attestation signature");

    const mintTxHash = await gateway.walletClient.writeContract({
      address: preparedWithdrawal.mintContract,
      abi: gatewayMinterAbi,
      functionName: "gatewayMint",
      args: [preparedWithdrawal.attestation, preparedWithdrawal.signature]
    });
    await gateway.publicClient.waitForTransactionReceipt({ hash: mintTxHash });

    const afterWithdrawBalance = await getWalletBalance(sessionWallets.payer.id);
    const afterAvailable = Number(afterWithdrawBalance.gatewayAvailable ?? afterWithdrawBalance.balance ?? 0);
    const expectedAfter = Number((Number(fundedBalance.gatewayAvailable) - Number(withdrawAmount)).toFixed(6));

    assert.ok(afterAvailable <= expectedAfter + 0.00001);

    console.log(
      JSON.stringify(
        {
          ok: true,
          buyer: gateway.address,
          payer: sessionWallets.payer.address,
          gatewayAvailableBefore: initialBalance.gatewayAvailable ?? initialBalance.balance,
          gatewayAvailableAfterFunding: fundedBalance.gatewayAvailable,
          gatewayAvailableAfterWithdraw: afterWithdrawBalance.gatewayAvailable,
          transferId: preparedWithdrawal.transferId,
          mintTxHash
        },
        null,
        2
      )
    );
  } finally {
    stopProcess(backend);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
