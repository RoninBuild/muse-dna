import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildMicroEconomyPlan } from "../backend/services/microeconomy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const artifactDir = path.join(rootDir, "artifacts", "phase5");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const phase5DbMode = process.env.PHASE5_DB_MODE || "memory";
const expectedDatabaseMode = process.env.PHASE5_EXPECT_DATABASE_MODE ||
  (phase5DbMode === "memory" ? "memory" : "postgres");
const skillsDir = process.env.HERMES_SKILLS_DIR || path.join(os.homedir(), ".hermes", "skills");

const sharedEnv = {
  ...process.env,
  DB_MODE: phase5DbMode,
  HERMES_SKILLS_DIR: skillsDir,
  MOCK_X402: "true",
  MOCK_X402_SEED: "muse-phase5-browser",
  REQUIRE_X402_CHALLENGE: "true",
  USDC_CONTRACT: "0x3600000000000000000000000000000000000000",
  USDC_TOKEN_ADDRESS: "0x3600000000000000000000000000000000000000",
  GATEWAY_API_BASE_URL: "https://gateway-api-testnet.circle.com",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  ARC_EXPLORER_TX_BASE: "https://testnet.arcscan.app/tx",
  ORCHESTRATOR_WALLET_ADDRESS: "0xFEE0000000000000000000000000000000000000",
  NEXT_PUBLIC_BACKEND_URL: "http://localhost:3000",
  BACKEND_INTERNAL_URL: "http://127.0.0.1:3001"
};

Object.assign(process.env, sharedEnv);

const services = [
  {
    label: "backend",
    args: ["run", "start", "--workspace", "@muse/backend"],
    cwd: rootDir,
    env: sharedEnv,
    readiness: "http://127.0.0.1:3001/health",
    validateResponse: async (response) => {
      const health = await response.json();

      if (!response.ok) {
        throw new Error(`Backend health returned ${response.status}`);
      }

      if (health.database !== expectedDatabaseMode) {
        throw new Error(
          `Backend database mode was ${health.database}; expected ${expectedDatabaseMode}`
        );
      }
    }
  },
  {
    label: "strategy",
    args: ["run", "start", "--workspace", "@muse/strategy-agent"],
    cwd: rootDir,
    env: sharedEnv,
    readiness: "http://127.0.0.1:3101/health"
  },
  {
    label: "fast-search",
    args: ["run", "start", "--workspace", "@muse/fast-search-agent"],
    cwd: rootDir,
    env: sharedEnv,
    readiness: "http://127.0.0.1:3102/health"
  },
  {
    label: "copywriter",
    args: ["run", "start", "--workspace", "@muse/copywriter-agent"],
    cwd: rootDir,
    env: sharedEnv,
    readiness: "http://127.0.0.1:3103/health"
  },
  {
    label: "image",
    args: ["run", "start", "--workspace", "@muse/image-agent"],
    cwd: rootDir,
    env: sharedEnv,
    readiness: "http://127.0.0.1:3104/health"
  },
  {
    label: "frontend",
    args: ["run", "start", "--workspace", "@muse/frontend"],
    cwd: rootDir,
    env: sharedEnv,
    readiness: "http://127.0.0.1:3000/"
  }
];

function normalizeComparableToken(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/_dna\.md$/iu, "")
    .replace(/\.md$/iu, "")
    .replace(/brand\s*dna$/iu, "");

  return normalized.match(/[\p{L}\p{N}]+/gu)?.join("") || "";
}

function serviceCountMap(steps) {
  return steps.reduce((counts, step) => {
    counts[step.service_name] = (counts[step.service_name] || 0) + 1;
    return counts;
  }, {});
}

function createExpectedServiceCounts(unitDefinitions) {
  return unitDefinitions.reduce((counts, unit) => {
    counts[unit.service] = (counts[unit.service] || 0) + 1;
    return counts;
  }, {});
}

function isSettledPaymentStep(step) {
  return Boolean(
    step.status === "completed" &&
    !step.reused_from_dna &&
    typeof step.tx_hash === "string" &&
    step.tx_hash.trim()
  );
}

function assertExactUnitSet(actualUnits, expectedUnits, label) {
  assert.deepEqual(
    [...actualUnits].sort(),
    [...expectedUnits].sort(),
    label
  );
}

async function ensureFrontendBuild() {
  console.log("Building frontend for Phase 5 verification...");

  const result = spawnSync(`${npmCommand} run build --workspace @muse/frontend`, {
    cwd: rootDir,
    env: sharedEnv,
    stdio: "inherit",
    shell: true
  });

  if (result.status !== 0) {
    throw new Error("Frontend build failed before Phase 5 verification.");
  }
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
  if (process.platform === "win32") {
    for (const port of ports) {
      killPortPidsWindows(port);
    }

    await delay(1500);
  }
}

async function resetAutoCrmDna() {
  await fs.mkdir(skillsDir, { recursive: true });
  const files = await fs.readdir(skillsDir).catch(() => []);
  const staleTokens = new Set([
    normalizeComparableToken("AutoCRM"),
    normalizeComparableToken("нового")
  ]);

  await Promise.all(
    files
      .filter((fileName) => fileName.endsWith(".md"))
      .filter((fileName) => staleTokens.has(normalizeComparableToken(fileName)))
      .map((fileName) => fs.rm(path.join(skillsDir, fileName), { force: true }))
  );
}

function startService(service) {
  const command = [npmCommand, ...service.args].join(" ");
  console.log(`Starting ${service.label}...`);
  const child = spawn(command, {
    cwd: service.cwd,
    env: service.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${service.label}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${service.label}:err] ${chunk}`);
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

async function waitForService(service, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(service.readiness);

      if (response.ok) {
        if (service.validateResponse) {
          await service.validateResponse(response);
        }

        return;
      }
    } catch {
      // keep polling
    }

    await delay(400);
  }

  throw new Error(`Timed out waiting for ${service.label} at ${service.readiness}`);
}

async function waitForLocatorCount(locator, count, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await locator.count()) === count) {
      return;
    }

    await delay(350);
  }

  throw new Error(`Timed out waiting for locator count ${count}`);
}

async function createTaskFromUi(page, presetLabel) {
  await page.goto("http://127.0.0.1:3000/task/new", {
    waitUntil: "networkidle"
  });

  const startDemoButton = page.getByRole("button", { name: /Start demo session/i });
  if (await startDemoButton.isVisible()) {
    await startDemoButton.click();
    await page.getByText("Demo mode is ready. You can start immediately.").waitFor({
      timeout: 30000
    });
  }

  await page.getByRole("button", { name: presetLabel }).click();
  await page.getByRole("button", { name: /Start task/i }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /Start task|Run task|Create task/i }).click();
  await page.waitForURL(/\/task\/[0-9a-f-]+$/i);
  const taskUrl = page.url();
  const taskId = taskUrl.split("/task/")[1];

  return {
    taskId,
    taskUrl
  };
}

async function fetchTaskSnapshot(page) {
  const taskResponse = await fetch(
    page.url().replace("http://127.0.0.1:3000/task/", "http://127.0.0.1:3000/api/tasks/")
  );

  return taskResponse.json();
}

async function assertBackendModeStillHealthy() {
  const response = await fetch("http://127.0.0.1:3001/health");
  const health = await response.json();

  assert.equal(response.status, 200, "Backend health degraded during the browser run.");
  assert.equal(
    health.database,
    expectedDatabaseMode,
    "Backend database mode changed during the browser run."
  );
}

async function assertFirstTask(page) {
  const expectedPlan = buildMicroEconomyPlan({ dnaExists: false });
  const transactionRows = page.locator(".tx-row");

  await waitForLocatorCount(transactionRows, expectedPlan.micro_plan.length, 60000);
  await page.getByText("52 paid").first().waitFor({ timeout: 45000 });
  await page.getByText("Built 24 of 24 Hermes DNA blocks").waitFor({ timeout: 45000 });
  await page.getByText("AutoCRM_DNA.md").first().waitFor({ timeout: 45000 });

  const taskSnapshot = await fetchTaskSnapshot(page);
  const paidSteps = taskSnapshot.steps.filter(isSettledPaymentStep);
  const reusedSteps = taskSnapshot.steps.filter((step) => step.reused_from_dna);

  assert.equal(taskSnapshot.task.status, "completed");
  assert.equal(Number(taskSnapshot.task.total_spent_usdc).toFixed(3), "0.248");
  assert.equal(paidSteps.length, 52);
  assert.equal(reusedSteps.length, 0);
  assert.equal(taskSnapshot.task.result.metrics.paidMicroPayments, 52);
  assert.equal(taskSnapshot.task.result.metrics.totalBlueprintUnits, 52);

  assertExactUnitSet(
    paidSteps.map((step) => step.unit_name),
    expectedPlan.micro_plan.map((unit) => unit.unit),
    "First run paid units did not match the full investment blueprint."
  );
  assert.deepEqual(
    serviceCountMap(paidSteps),
    createExpectedServiceCounts(expectedPlan.micro_plan),
    "First run paid service counts did not match the blueprint."
  );

  return {
    taskId: taskSnapshot.task.id,
    totalSpent: Number(taskSnapshot.task.total_spent_usdc),
    dnaFile: taskSnapshot.task.dna_file_created,
    txCount: paidSteps.length
  };
}

async function assertSecondTask(page) {
  const expectedPlan = buildMicroEconomyPlan({ dnaExists: true });
  const transactionRows = page.locator(".tx-row");

  await waitForLocatorCount(transactionRows, expectedPlan.micro_plan.length, 60000);
  await page.getByText("20 paid").first().waitFor({ timeout: 45000 });
  await page.getByText("32 reused").first().waitFor({ timeout: 45000 });
  await page.getByText("Hermes memory").first().waitFor({ timeout: 45000 });

  const taskSnapshot = await fetchTaskSnapshot(page);
  const paidSteps = taskSnapshot.steps.filter(isSettledPaymentStep);
  const reusedSteps = taskSnapshot.steps.filter((step) => step.reused_from_dna);

  assert.equal(taskSnapshot.task.status, "completed");
  assert.equal(Number(taskSnapshot.task.total_spent_usdc).toFixed(3), "0.100");
  assert.equal(paidSteps.length, 20);
  assert.equal(reusedSteps.length, 32);
  assert.equal(taskSnapshot.task.result.metrics.paidMicroPayments, 20);
  assert.equal(taskSnapshot.task.result.metrics.reusedUnits, 32);

  assertExactUnitSet(
    paidSteps.map((step) => step.unit_name),
    expectedPlan.micro_plan.map((unit) => unit.unit),
    "Second run paid units did not match the dividend execution plan."
  );
  assertExactUnitSet(
    reusedSteps.map((step) => step.unit_name),
    expectedPlan.skipped_units,
    "Second run reused units did not match the Hermes skip set."
  );
  assert.deepEqual(
    serviceCountMap(paidSteps),
    createExpectedServiceCounts(expectedPlan.micro_plan),
    "Second run paid service counts did not match the dividend plan."
  );
  assert.deepEqual(
    serviceCountMap(reusedSteps),
    createExpectedServiceCounts(expectedPlan.skipped_unit_definitions),
    "Second run reused service counts did not match the Hermes skip plan."
  );

  return {
    taskId: taskSnapshot.task.id,
    totalSpent: Number(taskSnapshot.task.total_spent_usdc),
    txCount: paidSteps.length
  };
}

async function assertHistoryPage(page) {
  await page.goto("http://127.0.0.1:3000/history", {
    waitUntil: "networkidle"
  });

  await page.getByText("AutoCRM_DNA.md").first().waitFor({ timeout: 30000 });
  const historyCards = page.locator(".history-card");
  assert.ok((await historyCards.count()) >= 2, "Expected at least two history cards");

  const historyResponse = await fetch("http://127.0.0.1:3000/api/history");
  const history = await historyResponse.json();
  assert.ok(history.tasks.length >= 2, "Expected at least two tasks in history API");
  assert.ok(history.dnaAssets.includes("AutoCRM_DNA.md"), "Expected AutoCRM_DNA.md in dnaAssets");

  return {
    taskCount: history.tasks.length,
    dnaAssets: history.dnaAssets
  };
}

async function createBrowser() {
  try {
    return await chromium.launch({
      channel: "msedge",
      headless: true
    });
  } catch {
    const edgePath = process.env.PLAYWRIGHT_BROWSER_PATH ||
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    return chromium.launch({
      executablePath: edgePath,
      headless: true
    });
  }
}

async function captureFailure(page, fileName) {
  await fs.mkdir(artifactDir, { recursive: true });
  const screenshotPath = path.join(artifactDir, fileName);
  await page.screenshot({
    path: screenshotPath,
    fullPage: true
  });
  return screenshotPath;
}

async function main() {
  await ensureFrontendBuild();
  await fs.mkdir(artifactDir, { recursive: true });
  console.log("Freeing local demo ports...");
  await freePorts([3000, 3001, 3101, 3102, 3103, 3104]);
  console.log("Resetting AutoCRM DNA state...");
  await resetAutoCrmDna();

  const children = services.map(startService);
  let browser;
  let page;

  try {
    console.log("Waiting for service readiness...");
    await Promise.all(services.map((service) => waitForService(service)));

    console.log("Launching browser...");
    browser = await createBrowser();
    const context = await browser.newContext({
      viewport: {
        width: 1440,
        height: 1100
      }
    });
    page = await context.newPage();

    console.log("Running first AutoCRM task...");
    const firstTask = await createTaskFromUi(page, "AutoCRM launch");
    const firstResult = await assertFirstTask(page);
    await assertBackendModeStillHealthy();

    console.log("Running second AutoCRM task...");
    const secondTask = await createTaskFromUi(page, "Lifecycle email");
    const secondResult = await assertSecondTask(page);
    await assertBackendModeStillHealthy();

    console.log("Validating history dashboard...");
    const historyResult = await assertHistoryPage(page);
    await assertBackendModeStillHealthy();

    console.log(
      JSON.stringify(
        {
          databaseMode: expectedDatabaseMode,
          firstTask: {
            ...firstTask,
            ...firstResult
          },
          secondTask: {
            ...secondTask,
            ...secondResult
          },
          history: historyResult
        },
        null,
        2
      )
    );
  } catch (error) {
    if (page) {
      const screenshot = await captureFailure(page, "phase5-failure.png");
      console.error(`Saved failure screenshot to ${screenshot}`);
    }

    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }

    for (const child of children) {
      stopService(child);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
