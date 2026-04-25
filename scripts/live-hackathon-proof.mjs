import "../shared/load-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { buildMicroEconomyPlan } from "../backend/services/microeconomy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const artifactDir = path.join(rootDir, "artifacts", "hackathon-live");
const skillsDir = path.join(artifactDir, "skills");

const buyerPrivateKey = String(process.env.MUSE_BUYER_PRIVATE_KEY || "").trim();

if (!/^0x[0-9a-fA-F]{64}$/.test(buyerPrivateKey)) {
  throw new Error(
    "Set MUSE_BUYER_PRIVATE_KEY to a funded Arc testnet wallet private key before running live proof."
  );
}

const hackathonPlan = buildMicroEconomyPlan({ dnaExists: false });
const targetGatewayAmount = Math.max(
  0.3,
  Number((hackathonPlan.estimated_cost_usdc + 0.02).toFixed(3))
);

// P3-6: build a base env that strips all private keys before spreading into
// agent processes. Agents are the RECEIVING end of payments — they never need
// to sign transactions and handing them the buyer key means any agent log that
// serialises process.env leaks it.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.endsWith("_PRIVATE_KEY") && k !== "MUSE_BUYER_PRIVATE_KEY"
  )
);

const sharedEnv = {
  ...baseEnv,
  DB_MODE: "memory",
  HERMES_SKILLS_DIR: skillsDir,
  MUSE_RECOVER_INTERRUPTED_TASKS: "false",
  MOCK_X402: "false",
  REQUIRE_X402_CHALLENGE: "true",
  PORT: "3301",
  STRATEGY_AGENT_URL: "http://127.0.0.1:3201/execute",
  FAST_SEARCH_AGENT_URL: "http://127.0.0.1:3202/execute",
  COPYWRITER_AGENT_URL: "http://127.0.0.1:3203/execute",
  IMAGE_AGENT_URL: "http://127.0.0.1:3204/execute"
};

// backendEnv adds the buyer private key back — the backend needs it to operate
// in self-managed mode (direct Arc Testnet settlement). Agents get sharedEnv
// which intentionally omits all private keys.
// Also restore proxy vars that load-env.mjs deletes from process.env, so child
// processes can bootstrap their own proxy transport for Gateway API calls.
// We read them straight from .env because load-env.mjs already stripped them.
function readEnvVarFromFile(key) {
  try {
    const envPath = path.join(rootDir, ".env");
    const content = fsSync.readFileSync(envPath, "utf8");
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}
const proxyRestore = {
  HTTPS_PROXY: readEnvVarFromFile("HTTPS_PROXY") || readEnvVarFromFile("HTTP_PROXY") || "",
  HTTP_PROXY: readEnvVarFromFile("HTTP_PROXY") || "",
  GLOBAL_AGENT_HTTP_PROXY: readEnvVarFromFile("GLOBAL_AGENT_HTTP_PROXY") || readEnvVarFromFile("HTTPS_PROXY") || readEnvVarFromFile("HTTP_PROXY") || "",
  NO_PROXY: readEnvVarFromFile("NO_PROXY") || "localhost,127.0.0.1",
  GLOBAL_AGENT_NO_PROXY: readEnvVarFromFile("GLOBAL_AGENT_NO_PROXY") || "localhost,127.0.0.1"
};
Object.assign(sharedEnv, proxyRestore);

// backendEnv: inherits sharedEnv (proxy vars etc.) PLUS the buyer private key
// which the backend's self-managed settlement path needs to sign Arc txs.
const backendEnv = {
  ...sharedEnv,
  MUSE_BUYER_PRIVATE_KEY: buyerPrivateKey
};

const services = [
  {
    label: "backend",
    cwd: path.join(rootDir, "backend"),
    command: "node",
    args: ["index.js"],
    // P3-6: backend gets the private key; agents get sharedEnv which does not.
    env: {
      ...backendEnv,
      PORT: "3301"
    },
    readiness: "http://127.0.0.1:3301/health"
  },
  {
    label: "strategy",
    cwd: path.join(rootDir, "agents", "strategy"),
    command: "node",
    args: ["server.js"],
    env: {
      ...sharedEnv,
      PORT: "3201"
    },
    readiness: "http://127.0.0.1:3201/health"
  },
  {
    label: "fast-search",
    cwd: path.join(rootDir, "agents", "fast-search"),
    command: "node",
    args: ["server.js"],
    env: {
      ...sharedEnv,
      PORT: "3202"
    },
    readiness: "http://127.0.0.1:3202/health"
  },
  {
    label: "copywriter",
    cwd: path.join(rootDir, "agents", "copywriter"),
    command: "node",
    args: ["server.js"],
    env: {
      ...sharedEnv,
      PORT: "3203"
    },
    readiness: "http://127.0.0.1:3203/health"
  },
  {
    label: "image",
    cwd: path.join(rootDir, "agents", "image"),
    command: "node",
    args: ["server.js"],
    env: {
      ...sharedEnv,
      PORT: "3204"
    },
    readiness: "http://127.0.0.1:3204/health"
  }
];

function formatUsdc(value) {
  return Number(value || 0).toFixed(6);
}

function createTimestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function startService(service) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: service.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logPrefix = `[${service.label}] `;
  child.stdout.on("data", (chunk) => {
    process.stdout.write(logPrefix + chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${service.label}:err] ` + chunk);
  });

  return child;
}

function stopService(child) {
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

async function freePorts(ports) {
  if (process.platform !== "win32") {
    return;
  }

  for (const port of ports) {
    killPortPidsWindows(port);
  }

  await delay(1500);
}

async function waitForService(service, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(service.readiness);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }

    await delay(400);
  }

  throw new Error(`Timed out waiting for ${service.label} at ${service.readiness}`);
}

async function waitForGatewayBalance(gateway, address, minimumAmount, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const balances = await gateway.getBalances(address);
    const available = Number(balances.gateway.formattedAvailable || 0);

    if (available >= minimumAmount - 0.000001) {
      return balances;
    }

    await delay(2_000);
  }

  throw new Error(
    `Gateway balance for ${address} did not reach ${minimumAmount.toFixed(3)} USDC in time.`
  );
}

async function createLiveSessionWallet(mainWalletAddress) {
  const response = await fetch("http://127.0.0.1:3301/api/wallet/create", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ mainWalletAddress })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Wallet creation failed with ${response.status}`);
  }

  return body;
}

async function createTask(sessionWallets, prompt, taskType, budgetUsdc, mainWallet) {
  const response = await fetch("http://127.0.0.1:3301/api/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      taskType,
      budgetUsdc,
      sessionWallets,
      // Headless: this script polls /api/tasks/:id over HTTP and never joins
      // the Socket.io task room. Without this flag the backend's abandoned-tab
      // guard would abort the task before any spend. UI clients omit this and
      // keep the original guard.
      headless: true,
      // mainWallet activates the orchestrator's direct on-chain settle path:
      // for every Gateway-settled unit it ALSO broadcasts a real native-USDC
      // transfer to the agent's worker wallet on Arc Testnet. That's what
      // gives every micro-payment a clickable ArcScan tx hash — without it
      // we only get Gateway UUID receipts and arcUrl: null in the report.
      mainWallet
    })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body?.error || `Task creation failed with ${response.status}`);
  }

  if (!body.taskId) {
    throw new Error("Task creation returned no taskId");
  }

  return body.taskId;
}

async function pollTask(taskId, timeoutMs = 20 * 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:3301/api/tasks/${taskId}`);
    const snapshot = await response.json().catch(() => null);

    if (response.ok && snapshot?.task?.status === "completed") {
      return snapshot;
    }

    if (response.ok && snapshot?.task?.status === "failed") {
      throw new Error(snapshot.task.error_log || "Live task failed.");
    }

    await delay(2_000);
  }

  throw new Error(`Timed out waiting for task ${taskId} to complete.`);
}

function summarizeSteps(steps) {
  // 0x-prefixed 64-char hex == real Arc Testnet tx hash. Anything else
  // (Gateway UUID, Circle wallet id, empty string) means direct on-chain
  // settlement DID NOT broadcast — the hackathon proof MUST surface that
  // instead of silently counting the step as "settled".
  const ARC_TX_HASH_RE = /^0x[0-9a-f]{64}$/i;
  const completedWithTx = steps.filter(
    (step) => step.status === "completed" && typeof step.tx_hash === "string" && step.tx_hash.trim()
  );
  const settledSteps = completedWithTx.filter((step) => ARC_TX_HASH_RE.test(step.tx_hash));
  const nonArcHashes = completedWithTx.filter((step) => !ARC_TX_HASH_RE.test(step.tx_hash));
  if (nonArcHashes.length > 0) {
    console.error(
      `[live-proof] ${nonArcHashes.length} completed step(s) returned non-Arc tx_hash (Gateway UUID or stub); first 3:`,
      nonArcHashes.slice(0, 3).map((s) => ({ service: s.service_name, unit: s.unit_name, tx_hash: s.tx_hash }))
    );
  }

  const perService = settledSteps.reduce((summary, step) => {
    const key = step.service_name;
    const current = summary[key] || {
      count: 0,
      spentUsdc: 0,
      transactions: []
    };

    current.count += 1;
    current.spentUsdc += Number(step.cost_usdc || 0);
    current.transactions.push({
      unit: step.unit_name,
      tx: step.tx_hash,
      amountUsdc: Number(step.cost_usdc || 0),
      arcUrl: step.arc_url || null
    });

    summary[key] = current;
    return summary;
  }, {});

  return {
    settledSteps,
    perService
  };
}

async function writeArtifacts(report) {
  await fs.mkdir(artifactDir, { recursive: true });

  const reportPath = path.join(artifactDir, "latest.json");
  const timestampedReportPath = path.join(artifactDir, `hackathon-live-${createTimestampSlug()}.json`);

  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(timestampedReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return {
    reportPath,
    timestampedReportPath
  };
}

async function main() {
  const children = [];
  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: buyerPrivateKey,
    // The default RPC (rpc.testnet.arc.network) and the QuickNode mirror
    // share a node-level mempool that fills up under load and rejects new
    // txs with "txpool is full" for hours at a time. The Blockdaemon mirror
    // has its own healthy mempool. Override here so the deposit doesn't
    // get stuck waiting for someone else's mempool to drain.
    rpcUrl: process.env.ARC_RPC_URL || "https://rpc.blockdaemon.testnet.arc.network"
  });
  const ports = [3301, 3201, 3202, 3203, 3204];
  const taskType = "email_campaign";
  const brandName = `ArcNanoHack${Date.now()}`;
  const prompt = `Create an email campaign for ${brandName}, a machine-to-machine billing layer where agents pay other agents per action on Arc using USDC micropayments.`;
  const buyerBalancesBefore = await gateway.getBalances();

  await fs.rm(skillsDir, { recursive: true, force: true });
  await fs.mkdir(skillsDir, { recursive: true });
  await freePorts(ports);

  try {
    for (const service of services) {
      children.push(startService(service));
    }

    await Promise.all(services.map((service) => waitForService(service)));

    const sessionWallets = await createLiveSessionWallet(gateway.address);
    assert.equal(
      String(sessionWallets.strategy.address).toLowerCase(),
      String(process.env.STRATEGY_AGENT_WALLET).toLowerCase()
    );
    assert.equal(
      String(sessionWallets.search.address).toLowerCase(),
      String(process.env.FAST_SEARCH_WALLET).toLowerCase()
    );
    assert.equal(
      String(sessionWallets.copy.address).toLowerCase(),
      String(process.env.COPY_AGENT_WALLET).toLowerCase()
    );
    assert.equal(
      String(sessionWallets.image.address).toLowerCase(),
      String(process.env.IMAGE_AGENT_WALLET).toLowerCase()
    );

    const payerBalancesBefore = await gateway.getBalances(sessionWallets.payer.address);
    const payerGatewayAvailableBefore = Number(
      payerBalancesBefore.gateway.formattedAvailable || 0
    );
    const shortfall = Math.max(0, Number((targetGatewayAmount - payerGatewayAvailableBefore).toFixed(6)));

    let depositResult = null;
    if (shortfall > 0) {
      // Arc Testnet's mempool returns "txpool is full" under load — the
      // deposit's approve+depositFor pair is two on-chain txs back-to-back
      // and either can race the mempool. Retry up to 8× with growing
      // backoff so a sustained congestion period (60-180s) doesn't blow
      // up the whole hackathon proof. Total worst-case wait ≈ 6 minutes.
      const RETRY_DELAYS_MS = [5_000, 10_000, 15_000, 30_000, 45_000, 60_000, 90_000, 120_000];
      let lastErr;
      for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt += 1) {
        try {
          depositResult = await gateway.depositFor(shortfall.toFixed(6), sessionWallets.payer.address);
          break;
        } catch (err) {
          lastErr = err;
          // viem nests the actual transient reason inside `details` while
          // `shortMessage` stays a generic "Transaction creation failed."
          // Walk the cause chain too — depositFor can wrap the rpc error
          // through 3 levels (ContractFunctionExecutionError → TransactionExecutionError
          // → TransactionRejectedRpcError) — so concatenate every visible
          // string so the regex can find "txpool is full" wherever it sits.
          const parts = [];
          let cur = err;
          for (let i = 0; i < 5 && cur; i += 1) {
            if (cur.shortMessage) parts.push(String(cur.shortMessage));
            if (cur.details) parts.push(String(cur.details));
            if (cur.message) parts.push(String(cur.message));
            cur = cur.cause;
          }
          const msg = parts.join(" | ");
          const retryable = /txpool is full|already known|nonce too low|replacement transaction underpriced|timeout|ECONNRESET|fetch failed|503|502|504/i.test(msg);
          if (!retryable || attempt === RETRY_DELAYS_MS.length) throw err;
          // CRITICAL: "timeout" / "already known" / "nonce too low" can fire
          // AFTER the prior depositFor broadcast hit the mempool — the tx
          // is already in flight or already mined, we just never saw the
          // receipt. Issuing a fresh approve+depositFor pair would
          // double-charge the buyer. Probe Gateway balance before retry:
          // if the payer is at/above target, treat the deposit as landed.
          try {
            const probe = await gateway.getBalances(sessionWallets.payer.address);
            const probeAvailable = Number(probe?.gateway?.formattedAvailable || 0);
            if (probeAvailable >= targetGatewayAmount - 0.000001) {
              console.warn(`[live-proof] depositFor retry skipped — Gateway already shows ${probeAvailable.toFixed(6)} (>= ${targetGatewayAmount.toFixed(6)}); prior tx must have landed.`);
              depositResult = { txHash: null, recovered: true };
              break;
            }
          } catch (probeErr) {
            console.warn(`[live-proof] balance probe failed before retry: ${probeErr?.message || probeErr}`);
          }
          const waitMs = RETRY_DELAYS_MS[attempt];
          console.warn(`[live-proof] depositFor retry ${attempt + 1}/${RETRY_DELAYS_MS.length} after txpool/transient error in ${(waitMs / 1000).toFixed(0)}s`);
          await delay(waitMs);
        }
      }
      if (!depositResult) throw lastErr || new Error("depositFor: no result");
      await waitForGatewayBalance(gateway, sessionWallets.payer.address, targetGatewayAmount);
    }

    const payerBalancesAfterFunding = await gateway.getBalances(sessionWallets.payer.address);
    const taskId = await createTask(sessionWallets, prompt, taskType, 1, gateway.address);
    const snapshot = await pollTask(taskId);
    const payerBalancesAfterTask = await gateway.getBalances(sessionWallets.payer.address);
    const buyerBalancesAfter = await gateway.getBalances();

    const { settledSteps, perService } = summarizeSteps(snapshot.steps || []);
    const totalSpentUsdc = Number(snapshot.task.total_spent_usdc || 0);
    const txCount = settledSteps.length;
    const breakEvenGasPerTxUsdc = Number((totalSpentUsdc / Math.max(1, txCount)).toFixed(6));

    if (txCount !== hackathonPlan.micro_plan.length) {
      const failedSteps = (snapshot.steps || []).filter(s => s.status === "failed");
      const perServiceFailed = {};
      for (const s of failedSteps) {
        perServiceFailed[s.service_name] = (perServiceFailed[s.service_name] || 0) + 1;
      }
      console.error("Incomplete task:", {
        txCount,
        expected: hackathonPlan.micro_plan.length,
        failedByService: perServiceFailed,
        firstErrors: failedSteps.slice(0, 5).map(s => ({ service: s.service_name, unit: s.unit_name, error: s.error_log }))
      });
    }

    assert.equal(snapshot.task.status, "completed");
    assert.equal(txCount, hackathonPlan.micro_plan.length);
    assert.equal(snapshot.task.result?.metrics?.paidMicroPayments, hackathonPlan.micro_plan.length);
    assert.equal(snapshot.task.result?.metrics?.reusedUnits || 0, 0);

    const serviceCounts = Object.fromEntries(
      Object.entries(perService).map(([serviceName, summary]) => [serviceName, summary.count])
    );

    assert.deepEqual(serviceCounts, {
      strategy: 24,
      search: 6,
      copy: 10,
      image: 12
    });

    const report = {
      hackathonProof: {
        requirementMaxPriceUsdc: 0.01,
        requirementMinTransactions: 50,
        actualTransactions: txCount,
        passedTransactionRequirement: txCount >= 50,
        maxUnitPriceUsdc: Math.max(...hackathonPlan.micro_plan.map((unit) => Number(unit.price || 0))),
        averageUnitPriceUsdc: breakEvenGasPerTxUsdc,
        totalTaskRevenueUsdc: totalSpentUsdc,
        breakEvenGasPerTxUsdc,
        marginExplanation:
          `This task generated ${txCount} live micropayments for ${formatUsdc(totalSpentUsdc)} USDC total, so any traditional per-transaction gas cost above ${formatUsdc(breakEvenGasPerTxUsdc)} USDC would break unit economics.`
      },
      buyer: {
        address: gateway.address,
        walletUsdcBefore: buyerBalancesBefore.wallet.formatted,
        gatewayAvailableBefore: buyerBalancesBefore.gateway.formattedAvailable,
        walletUsdcAfter: buyerBalancesAfter.wallet.formatted,
        gatewayAvailableAfter: buyerBalancesAfter.gateway.formattedAvailable
      },
      sessionWallets: {
        payer: sessionWallets.payer,
        strategy: sessionWallets.strategy,
        search: sessionWallets.search,
        copy: sessionWallets.copy,
        image: sessionWallets.image
      },
      funding: {
        targetGatewayAmountUsdc: targetGatewayAmount,
        payerGatewayAvailableBefore: payerBalancesBefore.gateway.formattedAvailable,
        depositResult: depositResult
          ? {
              approvalTxHash: depositResult.approvalTxHash || null,
              depositTxHash: depositResult.depositTxHash,
              formattedAmount: depositResult.formattedAmount,
              depositor: depositResult.depositor
            }
          : null,
        payerGatewayAvailableAfterFunding: payerBalancesAfterFunding.gateway.formattedAvailable,
        payerGatewayAvailableAfterTask: payerBalancesAfterTask.gateway.formattedAvailable
      },
      task: {
        id: snapshot.task.id,
        brandName,
        prompt,
        taskType,
        status: snapshot.task.status,
        totalSpentUsdc,
        dnaFileCreated: snapshot.task.dna_file_created,
        paidMicroPayments: snapshot.task.result?.metrics?.paidMicroPayments || 0,
        reusedUnits: snapshot.task.result?.metrics?.reusedUnits || 0,
        failedUnits: snapshot.task.result?.metrics?.failedUnits || 0
      },
      agents: Object.fromEntries(
        Object.entries(perService).map(([serviceName, summary]) => [
          serviceName,
          {
            wallet:
              serviceName === "strategy"
                ? sessionWallets.strategy.address
                : serviceName === "search"
                  ? sessionWallets.search.address
                  : serviceName === "copy"
                    ? sessionWallets.copy.address
                    : sessionWallets.image.address,
            count: summary.count,
            spentUsdc: Number(summary.spentUsdc.toFixed(6)),
            transactions: summary.transactions
          }
        ])
      ),
      transactions: settledSteps.map((step) => ({
        service: step.service_name,
        unit: step.unit_name,
        amountUsdc: Number(step.cost_usdc || 0),
        tx: step.tx_hash,
        arcUrl: step.arc_url || null
      }))
    };

    const artifactPaths = await writeArtifacts(report);
    console.log(JSON.stringify({ ...report, artifacts: artifactPaths }, null, 2));
  } finally {
    for (const child of children) {
      stopService(child);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
