import assert from "node:assert/strict";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { callAgentWithX402 } from "../backend/services/x402client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sharedEnv = {
  ...process.env,
  MOCK_X402: "true",
  MOCK_X402_SEED: "muse-phase3-smoke",
  REQUIRE_X402_CHALLENGE: "true",
  USDC_CONTRACT: "0x3600000000000000000000000000000000000000",
  USDC_TOKEN_ADDRESS: "0x3600000000000000000000000000000000000000",
  GATEWAY_API_BASE_URL: "https://gateway-api-testnet.circle.com",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  ARC_EXPLORER_TX_BASE: "https://testnet.arcscan.app/tx",
  ORCHESTRATOR_WALLET_ADDRESS: "0xFEE0000000000000000000000000000000000000"
};

Object.assign(process.env, sharedEnv);

const servers = [
  {
    label: "strategy",
    cwd: `${rootDir}\\agents\\strategy`,
    port: 3101,
    env: {
      ...sharedEnv,
      PORT: "3101",
      STRATEGY_AGENT_WALLET: "0xAAA0000000000000000000000000000000000000"
    }
  },
  {
    label: "fast-search",
    cwd: `${rootDir}\\agents\\fast-search`,
    port: 3102,
    env: {
      ...sharedEnv,
      PORT: "3102",
      FAST_SEARCH_WALLET: "0xBBB0000000000000000000000000000000000000"
    }
  },
  {
    label: "copywriter",
    cwd: `${rootDir}\\agents\\copywriter`,
    port: 3103,
    env: {
      ...sharedEnv,
      PORT: "3103",
      COPY_AGENT_WALLET: "0xCCC0000000000000000000000000000000000000",
      HERMES_URL: "http://127.0.0.1:8642"
    }
  },
  {
    label: "image",
    cwd: `${rootDir}\\agents\\image`,
    port: 3104,
    env: {
      ...sharedEnv,
      PORT: "3104",
      IMAGE_AGENT_WALLET: "0xDDD0000000000000000000000000000000000000"
    }
  }
];

function startServer(server) {
  const child = spawn("node", ["server.js"], {
    cwd: server.cwd,
    env: server.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${server.label}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${server.label}:err] ${chunk}`);
  });

  return child;
}

function stopServer(child) {
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

async function waitForHealth(port, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }

    await delay(300);
  }

  throw new Error(`Timed out waiting for service on port ${port}`);
}

const children = servers.map(startServer);

try {
  await Promise.all(servers.map((server) => waitForHealth(server.port)));

  const invalidPaymentResponse = await fetch("http://127.0.0.1:3101/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "PAYMENT-SIGNATURE": "not-a-valid-payment-header"
    },
    body: JSON.stringify({
      service: "strategy",
      unit: "product-summary",
      brandName: "AutoCRM",
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'."
    })
  });
  assert.equal(invalidPaymentResponse.status, 402);

  const strategy = await callAgentWithX402({
    url: "http://127.0.0.1:3101/execute",
    payload: {
      service: "strategy",
      unit: "product-summary",
      brandName: "AutoCRM",
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'."
    },
    agentName: "strategy.product-summary"
  });
  assert.equal(strategy.success, true);
  assert.ok(strategy.output.text);
  assert.equal(strategy.payment.amountUsdc, 0.005);
  assert.match(strategy.payment.txHash, /^0x/i);
  assert.ok(strategy.payment.arcUrl);

  const repeatedStrategy = await callAgentWithX402({
    url: "http://127.0.0.1:3101/execute",
    payload: {
      service: "strategy",
      unit: "product-summary",
      brandName: "AutoCRM",
      prompt: "РЎРґРµР»Р°Р№ Twitter-РїРѕСЃС‚ Рё Р±Р°РЅРЅРµСЂ РґР»СЏ 'AutoCRM'.",
      idempotencyKey: "phase3:strategy:product-summary"
    },
    agentName: "strategy.product-summary"
  });
  const repeatedStrategyAgain = await callAgentWithX402({
    url: "http://127.0.0.1:3101/execute",
    payload: {
      service: "strategy",
      unit: "product-summary",
      brandName: "AutoCRM",
      prompt: "РЎРґРµР»Р°Р№ Twitter-РїРѕСЃС‚ Рё Р±Р°РЅРЅРµСЂ РґР»СЏ 'AutoCRM'.",
      idempotencyKey: "phase3:strategy:product-summary"
    },
    agentName: "strategy.product-summary"
  });
  assert.equal(repeatedStrategy.success, true);
  assert.equal(repeatedStrategyAgain.success, true);
  assert.equal(
    repeatedStrategy.payment.txHash,
    repeatedStrategyAgain.payment.txHash,
    "Repeated idempotent calls should reuse the settled receipt instead of charging again"
  );

  const fastSearch = await callAgentWithX402({
    url: "http://127.0.0.1:3102/execute",
    payload: {
      service: "search",
      unit: "news-query",
      brandName: "AutoCRM",
      taskType: "twitter_post"
    },
    agentName: "search.news-query"
  });
  assert.equal(fastSearch.success, true);
  assert.ok(fastSearch.output.summary);
  assert.equal(fastSearch.payment.amountUsdc, 0.004);
  assert.match(fastSearch.payment.txHash, /^0x/i);
  assert.ok(fastSearch.payment.arcUrl);

  const copywriter = await callAgentWithX402({
    url: "http://127.0.0.1:3103/execute",
    payload: {
      service: "copy",
      unit: "final-copy",
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'.",
      taskType: "twitter_post",
      brandName: "AutoCRM",
      dnaContent: "# AutoCRM Brand DNA\n\nPractical, sharp, sales-ops fluent.",
      newsContext: "AutoCRM launched a new release."
    },
    agentName: "copy.final-copy"
  });
  assert.equal(copywriter.success, true);
  assert.ok(copywriter.output.text);
  assert.equal(copywriter.payment.amountUsdc, 0.005);
  assert.match(copywriter.payment.txHash, /^0x/i);
  assert.ok(copywriter.payment.arcUrl);

  const imageRender = await callAgentWithX402({
    url: "http://127.0.0.1:3104/execute",
    payload: {
      service: "image",
      unit: "banner-render",
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'.",
      brandName: "AutoCRM",
      taskType: "twitter_post",
      copyText: "AutoCRM turns creative work into a stream of USDC micro-checks."
    },
    agentName: "image.banner-render"
  });
  assert.equal(imageRender.success, true);
  assert.ok(imageRender.output.url.startsWith("data:image/svg+xml;base64,"));
  assert.equal(imageRender.payment.amountUsdc, 0.006);
  assert.match(imageRender.payment.txHash, /^0x/i);
  assert.ok(imageRender.payment.arcUrl);

  const imagePalette = await callAgentWithX402({
    url: "http://127.0.0.1:3104/execute",
    payload: {
      service: "image",
      unit: "brand-palette",
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'.",
      brandName: "AutoCRM",
      taskType: "twitter_post"
    },
    agentName: "image.brand-palette"
  });
  assert.equal(imagePalette.success, true);
  assert.deepEqual(imagePalette.output.colors, ["#07131f", "#10253b", "#66f1d0", "#f5f7fb"]);
  assert.equal(imagePalette.payment.amountUsdc, 0.003);
  assert.match(imagePalette.payment.txHash, /^0x/i);
  assert.ok(imagePalette.payment.arcUrl);

  console.log(
    JSON.stringify(
      {
        strategy: strategy.payment,
        fastSearch: fastSearch.payment,
        copywriter: copywriter.payment,
        imageRender: imageRender.payment,
        imagePalette: imagePalette.payment
      },
      null,
      2
    )
  );
} finally {
  for (const child of children) {
    stopServer(child);
  }
}
