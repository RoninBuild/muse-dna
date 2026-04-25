import { db as defaultDb } from "../db/index.js";
import {
  buildDNA as defaultBuildDNA,
  planTask as defaultPlanTask,
  readSkillFile as defaultReadSkillFile
} from "./hermes.js";
import {
  SERVICE_LABELS,
  SERVICE_ORDER,
  TIER_KEYS,
  buildMicroEconomyPlan,
  buildTierPlan,
  getTierMeta,
  toUnitId,
  computeAgentWorkerCount
} from "./microeconomy.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { callAgentWithX402 as defaultCallAgent } from "./x402client.js";
import { createCircleWalletClient } from "./circleWallet.js";
import { recordPayment as recordAgentPayment } from "./agentRegistry.js";
import { sendMicroPaymentOnArc, getOrchestratorSigner } from "./orchestratorWallets.js";
import { setDnaOwner } from "./dnaOwnership.js";

const AGENT_URLS = {
  strategy: process.env.STRATEGY_AGENT_URL || "http://localhost:3101/execute",
  search: process.env.FAST_SEARCH_AGENT_URL || "http://localhost:3102/execute",
  copy: process.env.COPYWRITER_AGENT_URL || "http://localhost:3103/execute",
  image: process.env.IMAGE_AGENT_URL || "http://localhost:3104/execute"
};

function resolveExpectedAgentWallet(sessionWallets, service) {
  const sessionWallet = sessionWallets?.[service]?.address;
  if (sessionWallet) {
    return sessionWallet;
  }
  // Env fallback so constrainPaymentRequiredToExpectedSeller in the x402
  // client always has a wallet to validate against — otherwise a compromised
  // agent could redirect its payment challenge to any wallet.
  const envKeyMap = {
    strategy: "STRATEGY_AGENT_WALLET",
    search: "FAST_SEARCH_WALLET",
    copy: "COPY_AGENT_WALLET",
    image: "IMAGE_AGENT_WALLET"
  };
  return process.env[envKeyMap[service]] || null;
}

const DEFAULT_BRAND_NAME = "Generic_Campaign";
const DEFAULT_BATCH_CONCURRENCY = {
  strategy: 1,
  search: 1,
  copy: 1,
  image: 1
};
// Hackathon-mode: every unit has a template fallback in the agent (writer.js,
// researcher.js etc) so transient LLM/network failures don't need to bubble
// up as "failed" rows. Bumped to 5 tries so even three consecutive Gemini
// quota hits don't surface as a fail — the agent's template fallback fires
// before we exhaust.
const MAX_UNIT_ATTEMPTS = Math.max(
  1,
  Number(process.env.MUSE_UNIT_MAX_ATTEMPTS || 5)
);
const MAX_DB_WRITE_ATTEMPTS = Math.max(
  1,
  Number(process.env.MUSE_DB_WRITE_MAX_ATTEMPTS || 3)
);
const DIRECT_SETTLE_RETRY_DELAYS_MS = [1500, 3000, 5000];
const RETRY_BACKOFF_MS = Math.max(
  100,
  Number(process.env.MUSE_RETRY_BACKOFF_MS || 350)
);
const BUILD_DNA_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.MUSE_BUILD_DNA_TIMEOUT_MS || 30_000)
);

function createNullSocket() {
  return {
    emit() {}
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function normalizeBrandName(value) {
  return String(value || "").trim() || DEFAULT_BRAND_NAME;
}

function normalizePayment(payment) {
  const txHash =
    typeof payment?.txHash === "string" && payment.txHash.trim()
      ? payment.txHash.trim()
      : null;
  const transaction =
    typeof payment?.transaction === "string" && payment.transaction.trim()
      ? payment.transaction.trim()
      : null;
  const transactionReference = txHash || transaction;
  const amountUsdc =
    payment?.amountUsdc ?? (
      typeof payment?.amount === "string" || typeof payment?.amount === "number"
        ? Number(payment.amount) / 1_000_000
        : 0
    );

  return {
    txHash: transactionReference,
    transaction: transaction || transactionReference,
    amountUsdc: Number(amountUsdc || 0),
    arcUrl: typeof payment?.arcUrl === "string" && payment.arcUrl
      ? payment.arcUrl
      : null,
    network: payment?.network || null,
    payer: payment?.payer || null,
    note: payment?.note || null
  };
}

function assertSettledPayment(payment, unitDefinition) {
  if (!payment.txHash) {
    throw new Error(
      `${unitDefinition.service}.${unitDefinition.unit} returned an incomplete payment receipt`
    );
  }

  if (!Number.isFinite(payment.amountUsdc)) {
    throw new Error(
      `${unitDefinition.service}.${unitDefinition.unit} returned a non-finite payment amount`
    );
  }

  // Explicitly reject negative / zero amounts before the tolerance math below
  // so a hostile agent cannot try to slip something like amountUsdc=-0.0001
  // through (that would currently be caught by the underpayment branch, but
  // the error message would be confusing). Fail clearly, fail early.
  if (payment.amountUsdc <= 0) {
    throw new Error(
      `${unitDefinition.service}.${unitDefinition.unit} returned a non-positive payment amount (${payment.amountUsdc})`
    );
  }

  // L7 note: tolerance is intentionally asymmetric — we are strict on underpayment
  // (0.0001 USDC / 0.01 cent) but more lenient on overpayment (0.001 USDC / 0.1 cent)
  // to absorb rounding differences across Circle Gateway, micro-USDC conversions,
  // and on-chain settlement precision.
  const minimumAcceptedAmount = unitDefinition.price - 0.0001;
  const maximumAcceptedAmount = unitDefinition.price + 0.001;

  if (payment.amountUsdc < minimumAcceptedAmount) {
    throw new Error(
      `${unitDefinition.service}.${unitDefinition.unit} underpaid ${payment.amountUsdc.toFixed(4)} USDC for a ${unitDefinition.price.toFixed(4)} USDC unit`
    );
  }

  if (payment.amountUsdc > maximumAcceptedAmount) {
    throw new Error(
      `${unitDefinition.service}.${unitDefinition.unit} overpaid ${payment.amountUsdc.toFixed(4)} USDC beyond the accepted tolerance`
    );
  }

  return payment;
}

function formatUnitLabel(unitDefinition) {
  return `${SERVICE_LABELS[unitDefinition.service]} - ${unitDefinition.label}`;
}

// Resolve concurrency for a service batch. Priority:
//   1. Per-service env override (e.g. STRATEGY_BATCH_CONCURRENCY=4)
//   2. Global env override (MUSE_BATCH_CONCURRENCY)
//   3. The dynamic worker count chosen by computeAgentWorkerCount for THIS task
//      — so when the variant card claims "8 strategy agents", we actually run
//      8 /execute calls in parallel instead of serializing them.
//   4. The conservative service-level default as the last fallback.
function getBatchConcurrency(serviceName, dynamicWorkerCount = 0) {
  const envKey = `${String(serviceName).toUpperCase().replace(/-/g, "_")}_BATCH_CONCURRENCY`;
  const configured = Number(process.env[envKey] || process.env.MUSE_BATCH_CONCURRENCY || 0);

  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.floor(configured));
  }

  if (Number.isFinite(dynamicWorkerCount) && dynamicWorkerCount > 0) {
    return Math.max(1, Math.floor(dynamicWorkerCount));
  }

  return DEFAULT_BATCH_CONCURRENCY[serviceName] || 3;
}

function isRetryableDatabaseError(error) {
  return /database|timeout|terminated|connect|ECONNRESET|ETIMEDOUT|ECONNREFUSED|lock/i.test(
    String(error?.message || "")
  );
}

function isRetryableUnitError(error) {
  const message = String(error?.message || "");

  if (
    /incomplete payment receipt|non-finite payment amount|underpaid|overpaid/i.test(
      message
    )
  ) {
    return false;
  }

  // Retry x402 payment failures that look like transient Gateway/proxy errors.
  if (/after x402 payment.*Unexpected token|after x402 payment.*Gateway.*failed|after x402 payment.*502|after x402 payment.*503|after x402 payment.*504|after x402 payment.*429|after x402 payment.*timeout/i.test(message)) {
    return true;
  }

  if (/after x402 payment/i.test(message)) {
    return false;
  }

  return /429|408|425|500|502|503|504|timeout|timed out|network|fetch|socket|connect|ECONNRESET|ECONNREFUSED|EAI_AGAIN|database|terminated/i.test(
    message
  );
}

function buildRetryDelay(attempt, error) {
  // If the failure looks like the agent process is actually dead
  // (ECONNREFUSED / fetch failed), back off hard so the supervisor has
  // time to restart it (supervisor polls every ~8s). Normal transient
  // errors keep the fast linear backoff they had before.
  const msg = String(error?.message || error || "");
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg)) {
    // attempts 1..5 → 2s, 4s, 6s, 10s, 14s (total 36s — well past the 8s
    // supervisor cycle).
    const schedule = [0, 2_000, 4_000, 6_000, 10_000, 14_000];
    return schedule[Math.min(attempt, schedule.length - 1)];
  }
  return RETRY_BACKOFF_MS * attempt;
}

// Pause between concurrent batches to relieve pressure on the Circle Gateway
// API. Configurable via env so demos and tests can drive it to 0; the default
// stays low because the spec calls for fast parallel micro-payments, not a
// drip-fed conveyor.
const BATCH_PAUSE_MS = Math.max(
  0,
  Number(process.env.MUSE_BATCH_PAUSE_MS ?? (process.env.MOCK_X402 === "true" ? 0 : 150))
);

async function settleUnitsWithConcurrency(units, worker, concurrency) {
  const settled = [];
  // M12 fix: compute chunks once instead of re-creating the array every iteration.
  const chunks = chunkArray(units, Math.max(1, concurrency));
  const lastChunkIndex = chunks.length - 1;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const chunkResults = await Promise.all(
      chunk.map(async (unitDefinition) => {
        try {
          return {
            status: "fulfilled",
            value: await worker(unitDefinition),
            unitDefinition
          };
        } catch (error) {
          return {
            status: "rejected",
            reason: error,
            unitDefinition
          };
        }
      })
    );

    settled.push(...chunkResults);

    if (BATCH_PAUSE_MS > 0 && chunkIndex < lastChunkIndex) {
      await sleep(BATCH_PAUSE_MS);
    }
  }

  return settled;
}

async function retryDbWrite(action, description) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_DB_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;

      if (attempt >= MAX_DB_WRITE_ATTEMPTS || !isRetryableDatabaseError(error)) {
        throw error;
      }

      console.warn(
        `${description} retry ${attempt}/${MAX_DB_WRITE_ATTEMPTS} after transient DB error: ${error.message}`
      );
      await sleep(buildRetryDelay(attempt));
    }
  }

  throw lastError;
}

function buildOrchestratorBrief(unitDefinition, context) {
  // Short, unit-specific instruction assembled by the orchestrator. Gives
  // every sub-agent a focused brief beyond the raw user prompt so the output
  // stays coherent with the rest of the swarm. Safe to ignore on the agent
  // side (agents fall back to their built-in instruction).
  const tier = (context.tier || "deep").toUpperCase();
  const core = `Tier ${tier}. Task: ${context.taskType}. Brand: ${context.brandName}.`;
  const service = unitDefinition.service;
  const parts = [core];

  if (service === "strategy") {
    parts.push(`Produce the "${unitDefinition.label}" block for the brand's reusable DNA. Be operator-friendly, 1-3 sentences, no fluff.`);
  } else if (service === "search") {
    parts.push(`Fetch the freshest signal that a copywriter can ride for "${unitDefinition.label}". Prefer recent, concrete facts.`);
  } else if (service === "copy") {
    parts.push(`Write the "${unitDefinition.label}" for a ${context.taskType} asset. Lean on the brand DNA + news context already loaded. Punchy, plain text, zero markdown.`);
  } else if (service === "image") {
    parts.push(`Output the "${unitDefinition.label}". Keep the premium dark glassmorphism brand system intact. If final banner, use the copy headline for overlay.`);
  }

  if (context.newsContext) {
    parts.push(`Live signal context (trimmed): ${String(context.newsContext).slice(0, 220)}.`);
  }
  if (context.generatedText && service === "image") {
    parts.push(`Copy excerpt: ${String(context.generatedText).slice(0, 200)}.`);
  }

  return parts.join(" ");
}

function buildUnitPayload(unitDefinition, context) {
  const common = {
    taskId: context.taskId,
    service: unitDefinition.service,
    unit: unitDefinition.unit,
    idempotencyKey: `${context.taskId}:${unitDefinition.service}:${unitDefinition.unit}`,
    prompt: context.prompt,
    brandName: context.brandName,
    taskType: context.taskType,
    tier: context.tier || "deep",
    orchestratorBrief: buildOrchestratorBrief(unitDefinition, context),
    dnaContent: context.dnaContent || null,
    newsContext: context.newsContext || null,
    copyText: context.generatedText || null
  };

  switch (unitDefinition.service) {
    case "strategy":
      return {
        ...common,
        prompt: context.prompt
      };

    case "search":
      return common;

    case "copy":
      return {
        ...common,
        searchOutputs: context.searchOutputs || {}
      };

    case "image":
      return {
        ...common,
        copyOutputs: context.copyOutputs || {}
      };

    default:
      return common;
  }
}

function createOutputValue(result) {
  if (!result || typeof result !== "object") {
    return result ?? null;
  }

  if (Object.prototype.hasOwnProperty.call(result, "output")) {
    return result.output;
  }

  if (result.copy) {
    return result.copy;
  }

  if (result.image) {
    return result.image;
  }

  if (result.news) {
    return result.news;
  }

  if (result.research) {
    return result.research;
  }

  return result;
}

function createOutputMap(batchResults) {
  return Object.fromEntries(
    batchResults.map((entry) => [entry.unitDefinition.unit, entry.output])
  );
}

function createStrategySnapshot(batchResults, brandName) {
  return {
    brandName,
    researchedAt: new Date().toISOString(),
    blocks: batchResults.map((entry) => ({
      service: entry.unitDefinition.service,
      unit: entry.unitDefinition.unit,
      label: entry.unitDefinition.label,
      dnaKey: entry.unitDefinition.dnaKey,
      output: entry.output
    }))
  };
}

function composeCopyFromOutputs({ taskType, brandName, outputs, newsContext }) {
  const getText = (unitName) => {
    const value = outputs[unitName];

    if (typeof value === "string") {
      return value;
    }

    if (typeof value?.text === "string") {
      return value.text;
    }

    if (typeof value?.content === "string") {
      return value.content;
    }

    if (typeof value?.value === "string") {
      return value.value;
    }

    return null;
  };

  const finalCopy = getText("final-copy");
  if (finalCopy) {
    return finalCopy;
  }

  const headline = getText("headline") || `${brandName} turns agentic output into paid micro-actions`;
  const hook = getText("hook-line") || newsContext || `${brandName} keeps creative execution tied to live commercial signal.`;
  const pain = getText("pain-turn") || "Operators cannot afford generic creative loops or expensive gas-heavy settlement.";
  const benefits = getText("benefit-stack") || "Sub-cent pricing, visible unit economics, and reusable brand memory now travel together.";
  const proof = getText("proof-line") || "Hermes removes repeated paid setup work while Arc keeps the value flow on-chain.";
  const cta = getText("cta-line") || "See the live ledger and watch the second run get cheaper.";

  if (taskType === "email_campaign") {
    return `Subject: ${headline}\n\n${hook}\n\n${pain}\n${benefits}\n${proof}\n\n${cta}`;
  }

  if (taskType === "twitter_post") {
    return `${headline}\n\n${hook}\n\n${pain}\n${benefits}\n${proof}\n\n${cta}\n\n#Arc #USDC #Nous`;
  }

  return `${headline}\n\n${hook}\n\n${benefits}\n${proof}\n\n${cta}`;
}

function composeImageFromOutputs({ brandName, taskType, prompt, outputs }) {
  const render = outputs["banner-render"];

  if (render?.url) {
    return render.url;
  }

  return render?.imageUrl || render?.image?.url || `data:text/plain,${encodeURIComponent(`${brandName} ${taskType} ${prompt}`)}`;
}

function groupByService(microPlan) {
  return SERVICE_ORDER.map((serviceName) => ({
    serviceName,
    units: microPlan.filter((unit) => unit.service === serviceName)
  })).filter((entry) => entry.units.length > 0);
}

function normalizeTaskPlan(plan, { tier } = {}) {
  const tierKey = TIER_KEYS.includes(String(tier || "").toLowerCase())
    ? String(tier).toLowerCase()
    : null;
  // Hackathon requirement: demonstrate 50+ on-chain transactions per demo
  // run. DNA reuse short-circuits units as `reused` (no payment), which
  // caps the on-chain tx count. Flipping this flag forces every run to
  // behave like a first run — no skips, every unit pays on Arc.
  const disableReuse = (process.env.MUSE_DISABLE_DNA_REUSE || "true") !== "false";
  const effectiveDnaExists = disableReuse ? false : plan.dna_exists;
  const effectiveSkipped = disableReuse ? [] : (Array.isArray(plan.skipped_units) ? plan.skipped_units : undefined);
  const deterministicPlan = tierKey
    ? buildTierPlan({ tier: tierKey, dnaExists: effectiveDnaExists })
    : buildMicroEconomyPlan({
        dnaExists: effectiveDnaExists,
        skippedUnits: effectiveSkipped
      });

  const normalized = {
    brand_name: normalizeBrandName(plan.brand_name),
    dna_exists: Boolean(effectiveDnaExists),
    dna_file: disableReuse ? null : (plan.dna_file || null),
    tier: tierKey || "deep",
    micro_plan: tierKey ? deterministicPlan.micro_plan : (plan.micro_plan ?? deterministicPlan.micro_plan),
    skipped_units: tierKey ? deterministicPlan.skipped_units : (plan.skipped_units ?? deterministicPlan.skipped_units),
    skipped_unit_definitions: tierKey
      ? deterministicPlan.skipped_unit_definitions
      : (plan.skipped_unit_definitions ?? deterministicPlan.skipped_unit_definitions),
    estimated_cost_usdc: tierKey ? deterministicPlan.estimated_cost_usdc : (plan.estimated_cost_usdc ?? deterministicPlan.estimated_cost_usdc),
    investment_cost_usdc: plan.investment_cost_usdc ?? deterministicPlan.investment_cost_usdc,
    savings_usdc: plan.savings_usdc ?? deterministicPlan.savings_usdc,
    blueprint_total_units: plan.blueprint_total_units ?? deterministicPlan.blueprint_total_units,
    payable_units: tierKey ? deterministicPlan.payable_units : (plan.payable_units ?? deterministicPlan.payable_units),
    reused_units: plan.reused_units ?? deterministicPlan.reused_units,
    dna_blocks_total: plan.dna_blocks_total ?? deterministicPlan.dna_blocks_total
  };
  if (disableReuse) {
    // Even if the planner produced reused/skipped entries, erase them so the
    // orchestrator won't short-circuit any unit — every tile is paid on Arc.
    // reused_units is a count (number) everywhere downstream — the DB column
    // is INT and the hackathon-proof assertion does strict-equal vs 0 — so
    // an empty array would surface as `[] !== 0` and fail every headless run.
    normalized.skipped_units = [];
    normalized.skipped_unit_definitions = [];
    normalized.reused_units = 0;
    normalized.savings_usdc = 0;
  }
  return normalized;
}

function createFailureSummary(failedUnits) {
  if (failedUnits.length === 0) {
    return null;
  }

  const preview = failedUnits
    .slice(0, 4)
    .map((entry) => `${entry.service}.${entry.unit}`)
    .join(", ");
  const suffix = failedUnits.length > 4 ? ", ..." : "";

  return `${failedUnits.length} micro-units failed but the task continued with successful results (${preview}${suffix})`;
}

function formatDirectSettleError(error) {
  const message = String(error?.shortMessage || error?.message || error || "").trim();
  return message ? message.slice(0, 240) : "unknown direct-settle failure";
}

async function settleDirectOnArcWithRetry({ mainWalletRaw, toAddress, amountUsdc, unitId }) {
  let lastError = null;

  for (let attempt = 1; attempt <= DIRECT_SETTLE_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      return await sendMicroPaymentOnArc({
        mainWalletRaw,
        toAddress,
        amountUsdc
      });
    } catch (error) {
      lastError = error;
      if (attempt > DIRECT_SETTLE_RETRY_DELAYS_MS.length) {
        break;
      }

      const delayMs = DIRECT_SETTLE_RETRY_DELAYS_MS[attempt - 1];
      console.warn(
        `[orchestrator] direct settle retry ${attempt}/${DIRECT_SETTLE_RETRY_DELAYS_MS.length} for ${unitId} after ${formatDirectSettleError(error)} (waiting ${delayMs}ms)`
      );
      await sleep(delayMs);
    }
  }

  throw lastError || new Error(`direct-settle failed for ${unitId}`);
}

async function persistReusedUnits({ taskId, skippedUnits, db, socket }) {
  for (const unitDefinition of skippedUnits) {
    await retryDbWrite(
      () =>
        db.steps.create({
          taskId,
          serviceName: unitDefinition.service,
          unitName: unitDefinition.unit,
          status: "reused",
          costUsdc: 0,
          reusedFromDna: true,
          dnaSectionKey: unitDefinition.dnaKey || null,
          outputJson: {
            source: "hermes-memory",
            label: unitDefinition.label
          }
        }),
      `Persist reused unit ${unitDefinition.service}.${unitDefinition.unit}`
    );

    socket.emit("unit:reused", {
      service: unitDefinition.service,
      unit: unitDefinition.unit,
      label: formatUnitLabel(unitDefinition),
      dnaKey: unitDefinition.dnaKey || null,
      reason: "Hermes memory already contains this paid block"
    });
  }
}


export function createTaskRunner(overrides = {}) {
  const dependencies = {
    db: defaultDb,
    planTask: defaultPlanTask,
    buildDNA: defaultBuildDNA,
    readSkillFile: defaultReadSkillFile,
    callAgent: defaultCallAgent,
    ...overrides
  };

  return async function runTask(task, socket = createNullSocket(), sessionWallets = null, options = {}) {
    const taskId = task.id;
    const prompt = String(task.prompt || "").trim();
    const taskType = task.taskType || task.task_type;
    const budgetUsdc = Number(task.budgetUsdc ?? task.budget_usdc ?? 2);
    // MetaMask address of the operator that triggered the task. Passed
    // from the frontend — used to look up the paired orchestrator private
    // key so we can broadcast a real on-chain USDC transfer to each agent
    // in addition to the Circle Gateway x402 settlement (Gateway batches
    // and won't hand us an Arc hash synchronously on testnet; the direct
    // transfer is what ends up clickable on ArcScan).
    const mainWalletForSettlement = options?.mainWallet || null;
    const directSettlementEnabled = (process.env.MUSE_DIRECT_SETTLEMENT || "true") !== "false";

    // Per-user x402 signer. Look up THIS user's orchestrator private key from
    // the orchestrator-wallets store (same store the topbar uses for the
    // top-up popover) and bind it to the wallet client. Every micro-payment
    // from this task will be signed with that key — never with the shared
    // env wallet, which is reserved for headless CI scripts only.
    let userPrivateKey = null;
    if (mainWalletForSettlement) {
      try {
        const signer = await getOrchestratorSigner(mainWalletForSettlement);
        userPrivateKey = signer?.privateKey || null;
      } catch (signerErr) {
        console.warn(
          `[orchestrator] failed to load per-user signer for ${mainWalletForSettlement}: ${signerErr?.message || signerErr}`
        );
      }
    }

    const taskWalletClient = createCircleWalletClient({
      walletId: sessionWallets?.payer?.id,
      walletAddress: sessionWallets?.payer?.address,
      // PRIORITY: per-user privkey > headless env fallback. UI flow always
      // hits the first branch (mainWallet supplied + mapping exists). CI
      // scripts (live-hackathon-proof) opt into env via useEnvFallback.
      privateKey: userPrivateKey || undefined,
      useEnvFallback: !mainWalletForSettlement
    });

    socket.emit("task:planning", {
      message: "Hermes is pricing the task into micro-units..."
    });

    const requestedTier = task.tier || task.variant_tier || null;
    const plan = await dependencies.planTask({ prompt, taskType });
    const normalizedPlan = normalizeTaskPlan(plan, { tier: requestedTier });

    // ─── Dynamic agent-worker provisioning ───
    // Every task spins up 4-15 fresh EVM wallets — one per agent worker.
    // Each service (strategy / search / copy / image) gets N workers
    // based on Hermes's tier + prompt-complexity decision. Units of a
    // service are distributed round-robin across its workers. Each worker
    // wallet exists only for the lifetime of this process — private key
    // is held in-memory, never persisted. The worker receives its share
    // of the micro-payments on-chain as the orchestrator settles units.
    const agentWorkerDecision = computeAgentWorkerCount({
      microPlan: normalizedPlan.micro_plan,
      tier: normalizedPlan.tier,
      prompt,
      taskType
    });

    /** @type {Map<string, Array<{address: string, privateKey: string, index: number}>>} */
    const workersByService = new Map();
    for (const [service, count] of Object.entries(agentWorkerDecision.perService)) {
      if (!count) continue;
      const list = [];
      for (let i = 0; i < count; i += 1) {
        const pk = generatePrivateKey();
        const account = privateKeyToAccount(pk);
        list.push({ address: account.address, privateKey: pk, index: i });
      }
      workersByService.set(service, list);
    }

    // unitId → worker assignment (round-robin within service).
    const workerByUnitId = new Map();
    const rrCursor = {};
    for (const unit of normalizedPlan.micro_plan) {
      const svc = unit.service;
      const list = workersByService.get(svc) || [];
      if (list.length === 0) continue;
      const cur = rrCursor[svc] || 0;
      workerByUnitId.set(toUnitId(unit), list[cur % list.length]);
      rrCursor[svc] = cur + 1;
    }

    // Socket broadcast — flat list for the UI to group by service.
    const deployedWallets = [];
    for (const [service, list] of workersByService.entries()) {
      for (const w of list) {
        deployedWallets.push({
          service,
          index: w.index,
          address: w.address
        });
      }
    }
    socket.emit("task:wallets_deployed", {
      taskId,
      tier: normalizedPlan.tier,
      total: deployedWallets.length,
      wallets: deployedWallets,
      perService: agentWorkerDecision.perService,
      unitsPerService: agentWorkerDecision.unitsPerService,
      complexityMultiplier: agentWorkerDecision.complexityMultiplier
    });

    await retryDbWrite(
      () =>
        dependencies.db.tasks.update(taskId, {
          brandName: normalizedPlan.brand_name,
          dnaExists: normalizedPlan.dna_exists,
          planSteps: normalizedPlan.micro_plan.map((unitDefinition) => toUnitId(unitDefinition)),
          planSkipped: normalizedPlan.skipped_units,
          estimatedCostUsdc: normalizedPlan.estimated_cost_usdc,
          investmentCostUsdc: normalizedPlan.investment_cost_usdc,
          savingsUsdc: normalizedPlan.savings_usdc
        }),
      `Persist task plan ${taskId}`
    );

    socket.emit("task:plan_ready", {
      brandName: normalizedPlan.brand_name,
      dnaExists: normalizedPlan.dna_exists,
      dnaFile: normalizedPlan.dna_file,
      tier: normalizedPlan.tier,
      tierMeta: getTierMeta(normalizedPlan.tier),
      microPlan: normalizedPlan.micro_plan,
      skippedUnits: normalizedPlan.skipped_units,
      skippedUnitDefinitions: normalizedPlan.skipped_unit_definitions,
      estimatedCost: normalizedPlan.estimated_cost_usdc,
      investmentCost: normalizedPlan.investment_cost_usdc,
      savings: normalizedPlan.savings_usdc,
      totalUnits: normalizedPlan.blueprint_total_units,
      payableUnits: normalizedPlan.payable_units,
      reusedUnits: normalizedPlan.reused_units,
      dnaBlocksTotal: normalizedPlan.dna_blocks_total
    });

    if (Number.isFinite(budgetUsdc) && normalizedPlan.estimated_cost_usdc > budgetUsdc) {
      const reason =
        `Task budget ${budgetUsdc.toFixed(3)} USDC is below the estimated ` +
        `${Number(normalizedPlan.estimated_cost_usdc).toFixed(3)} USDC required by the plan`;

      await retryDbWrite(
        () =>
          dependencies.db.tasks.update(taskId, {
            status: "failed",
            errorLog: reason,
            completedAt: new Date().toISOString()
          }),
        `Persist over-budget task ${taskId}`
      );

      socket.emit("task:error", {
        message: reason
      });

      return null;
    }

    const context = {
      taskId,
      prompt,
      taskType,
      tier: normalizedPlan.tier,
      brandName: normalizedPlan.brand_name,
      dnaContent: null,
      newsContext: null,
      searchOutputs: {},
      copyOutputs: {},
      imageOutputs: {},
      generatedText: null,
      generatedImage: null
    };

    if (normalizedPlan.dna_exists && normalizedPlan.dna_file) {
      context.dnaContent = await dependencies.readSkillFile(normalizedPlan.dna_file);
    }

    await persistReusedUnits({
      taskId,
      skippedUnits: normalizedPlan.skipped_unit_definitions || [],
      db: dependencies.db,
      socket
    });

    let totalSpent = 0;
    let dnaFileCreated = normalizedPlan.dna_exists ? normalizedPlan.dna_file : null;
    const skippedDefs = Array.isArray(normalizedPlan.skipped_unit_definitions)
      ? normalizedPlan.skipped_unit_definitions
      : [];
    let dnaBlocksCompleted = normalizedPlan.dna_exists
      ? skippedDefs.filter((unit) => unit && unit.service === "strategy").length
      : 0;
    const transactions = [];
    const failedUnits = [];
    const executionOrder = new Map(
      normalizedPlan.micro_plan.map((unitDefinition, index) => [toUnitId(unitDefinition), index])
    );

    const executeUnit = async (unitDefinition) => {
      const payload = buildUnitPayload(unitDefinition, context);
      const unitId = toUnitId(unitDefinition);
      let settledExecution = null;

      // Worker wallet for this unit was decided at plan-time (round-robin
      // within the service's pool). Pass it along on every unit event so
      // the frontend can group the ledger by wallet — the UI shows 15
      // cards (one per fresh wallet) with each unit nested under the
      // wallet that actually earned the micro-payment.
      const unitWorker = workerByUnitId.get(unitId);
      const unitWalletAddress = unitWorker?.address || null;
      const unitWalletIndex = typeof unitWorker?.index === "number" ? unitWorker.index : null;

      socket.emit("unit:requesting", {
        service: unitDefinition.service,
        unit: unitDefinition.unit,
        label: formatUnitLabel(unitDefinition),
        price: unitDefinition.price,
        dnaKey: unitDefinition.dnaKey || null,
        walletAddress: unitWalletAddress,
        walletIndex: unitWalletIndex
      });

      for (let attempt = 1; attempt <= MAX_UNIT_ATTEMPTS; attempt += 1) {
        try {
          if (!settledExecution) {
            const statusLabel = attempt === 1
              ? "Signing micro-check with Circle Wallet"
              : `Retry ${attempt}/${MAX_UNIT_ATTEMPTS} after transient failure`;

            socket.emit("unit:paying", {
              service: unitDefinition.service,
              unit: unitDefinition.unit,
              label: formatUnitLabel(unitDefinition),
              price: unitDefinition.price,
              status: statusLabel,
              walletAddress: unitWalletAddress,
              walletIndex: unitWalletIndex
            });

            const agentWalletAddress = resolveExpectedAgentWallet(sessionWallets, unitDefinition.service);

            const result = await dependencies.callAgent({
              url: AGENT_URLS[unitDefinition.service],
              payload,
              agentName: `${unitDefinition.service}.${unitDefinition.unit}`,
              circleWalletClient: taskWalletClient,
              agentWalletAddress
            });

            // Seller provenance: an agent MUST echo back the service + unit
            // it was asked to run. A compromised or swapped agent returning
            // output for a different unit would otherwise be accepted and
            // billed against the wrong ledger row. String compare is cheap.
            if (
              typeof result?.service === "string" &&
              result.service !== unitDefinition.service
            ) {
              throw new Error(
                `Agent ${unitDefinition.service}.${unitDefinition.unit} responded with mismatched service "${result.service}"`
              );
            }
            if (
              typeof result?.unit === "string" &&
              result.unit !== unitDefinition.unit
            ) {
              throw new Error(
                `Agent ${unitDefinition.service}.${unitDefinition.unit} responded with mismatched unit "${result.unit}"`
              );
            }

            let payment = assertSettledPayment(
              normalizePayment(result.payment),
              unitDefinition
            );

            // Direct on-chain settlement: Circle Gateway gives us a UUID
            // receipt that isn't viewable on ArcScan. We additionally do
            // a real EVM transfer from orch wallet → agent wallet so the
            // UI can link every paid unit to a genuine Arc Testnet tx.
            // Failure here is logged but non-fatal — we still keep the
            // Gateway receipt and the unit counts as settled.
            // Route the direct settle to THIS unit's dedicated worker wallet
            // (one of the N wallets provisioned at task start). Fall back to
            // the agent service wallet if for some reason we didn't generate
            // one — avoids losing tx visibility on edge cases.
            const unitWorker = workerByUnitId.get(toUnitId(unitDefinition));
            const settleToAddress = unitWorker?.address || agentWalletAddress;
            if (directSettlementEnabled && mainWalletForSettlement && settleToAddress) {
              // sendMicroPaymentOnArc already retries internally (4 attempts
              // with bumped nonce on txpool/nonce errors) and serializes
              // per-wallet via the nonce queue. If it STILL throws after all
              // that, Arc RPC is genuinely unhealthy — we keep the Circle
              // Gateway receipt and log a warning rather than throwing:
              // - Throwing here retries the agent HTTP call, which makes
              //   the agent do a second Circle Gateway payment = double
              //   spend of the buyer's Gateway balance on a transient RPC
              //   hiccup (this happened under the storm: strategy units
              //   all 100% failed because the first direct-settle threw,
              //   then retry hit Gateway rate-limits).
              // - Keeping the Circle receipt still counts the unit as
              //   settled; the UI shows the UUID in dim-text with a
              //   tooltip explaining the on-chain hash is pending.
              try {
                const direct = await sendMicroPaymentOnArc({
                  mainWalletRaw: mainWalletForSettlement,
                  toAddress: settleToAddress,
                  amountUsdc: payment.amountUsdc || unitDefinition.price
                });
                payment = {
                  ...payment,
                  txHash: direct.txHash,
                  transaction: direct.txHash,
                  arcUrl: direct.arcUrl,
                  payer: mainWalletForSettlement,
                  walletAddress: settleToAddress,
                  network: payment.network || "eip155:arc-testnet",
                  note: payment.note
                    ? `${payment.note} · on-chain transfer: ${direct.txHash}`
                    : `On-chain transfer to ${direct.to}`
                };
              } catch (directErr) {
                console.warn(
                  `[orchestrator] direct on-chain settle failed for ${unitDefinition.service}.${unitDefinition.unit} (keeping Circle receipt): ${directErr?.message || directErr}`
                );
              }
            }
            const output = createOutputValue(result);

            settledExecution = {
              unitDefinition,
              output,
              payment,
              raw: result
            };
          }

          const { payment, output } = settledExecution;

          await retryDbWrite(
            () =>
              dependencies.db.steps.create({
                taskId,
                serviceName: unitDefinition.service,
                unitName: unitDefinition.unit,
                status: "completed",
                costUsdc: payment.amountUsdc,
                txHash: payment.txHash,
                arcUrl: payment.arcUrl,
                paymentNetwork: payment.network || null,
                paymentNote: payment.note || null,
                reusedFromDna: false,
                dnaSectionKey: unitDefinition.dnaKey || null,
                outputJson: output
              }),
            `Persist completed unit ${unitDefinition.service}.${unitDefinition.unit}`
          );

          // Accounting guard: if retryDbWrite above succeeded on a previous
          // attempt but a later step threw and we re-entered the loop, we
          // must not re-emit the socket event, re-increment counters, or
          // re-push the transaction. Everything below runs at most once per
          // settled payment.
          if (!settledExecution.accounted) {
            socket.emit("unit:validated", {
              service: unitDefinition.service,
              unit: unitDefinition.unit,
              label: formatUnitLabel(unitDefinition),
              price: unitDefinition.price,
              txHash: payment.txHash,
              amountUsdc: payment.amountUsdc,
              arcUrl: payment.arcUrl,
              network: payment.network || null,
              dnaKey: unitDefinition.dnaKey || null,
              note: payment.note,
              walletAddress: unitWalletAddress,
              walletIndex: unitWalletIndex
            });

            if (unitDefinition.service === "strategy") {
              dnaBlocksCompleted += 1;
              // dna_blocks_total is the canonical 24 (full strategy block
              // count). For non-deep tiers the plan only runs a subset, so
              // we report the total against the strategy units actually
              // queued in this tier (paid + skipped-from-DNA) — otherwise a
              // lite run shows 6/24 and judges read that as half-done.
              const tierStrategyTotal =
                normalizedPlan.micro_plan.filter((u) => u.service === "strategy").length +
                (normalizedPlan.skipped_unit_definitions || []).filter(
                  (u) => u && u.service === "strategy"
                ).length;
              socket.emit("dna:progress", {
                completed: dnaBlocksCompleted,
                total: tierStrategyTotal || normalizedPlan.dna_blocks_total,
                unit: unitDefinition.unit,
                label: unitDefinition.label
              });
            }

            totalSpent = Number((totalSpent + payment.amountUsdc).toFixed(6));
            transactions.push({
              order: executionOrder.get(unitId) ?? transactions.length,
              service: unitDefinition.service,
              unit: unitDefinition.unit,
              label: formatUnitLabel(unitDefinition),
              txHash: payment.txHash,
              amountUsdc: payment.amountUsdc,
              arcUrl: payment.arcUrl,
              network: payment.network || null
            });

            settledExecution.accounted = true;
          }

          // Book the payment against the agent's on-chain reputation
          // counter. Guarded by `settledExecution.reputationRecorded` so a
          // retry of the DB write never double-charges reputation.
          if (!settledExecution.reputationRecorded) {
            const agentAddress = sessionWallets?.[unitDefinition.service]?.address
              || process.env[`${unitDefinition.service.toUpperCase().replace(/-/g, "_")}_AGENT_WALLET`]
              || (unitDefinition.service === "search" ? process.env.FAST_SEARCH_WALLET : null);
            if (agentAddress) {
              try {
                await recordAgentPayment({ agent: agentAddress, amountUsdc: payment.amountUsdc });
                settledExecution.reputationRecorded = true;
              } catch (registryError) {
                console.warn(
                  `Agent registry record_payment failed for ${unitDefinition.service}.${unitDefinition.unit}: ${registryError.message}`
                );
              }
            } else {
              settledExecution.reputationRecorded = true;
            }
          }

          return settledExecution;
        } catch (error) {
          const retryable = settledExecution
            ? isRetryableDatabaseError(error) || isRetryableUnitError(error)
            : isRetryableUnitError(error);

          if (retryable && attempt < MAX_UNIT_ATTEMPTS) {
            await sleep(buildRetryDelay(attempt, error));
            continue;
          }

          if (!settledExecution) {
            await retryDbWrite(
              () =>
                dependencies.db.steps.create({
                  taskId,
                  serviceName: unitDefinition.service,
                  unitName: unitDefinition.unit,
                  status: "failed",
                  costUsdc: 0,
                  reusedFromDna: false,
                  dnaSectionKey: unitDefinition.dnaKey || null,
                  errorLog: error.message
                }),
              `Persist failed unit ${unitDefinition.service}.${unitDefinition.unit}`
            );

            socket.emit("unit:failed", {
              service: unitDefinition.service,
              unit: unitDefinition.unit,
              label: formatUnitLabel(unitDefinition),
              error: error.message,
              walletAddress: unitWalletAddress,
              walletIndex: unitWalletIndex
            });
          } else {
            // CRITICAL: payment already settled on Arc Testnet (Circle
            // Gateway + on-chain transfer succeeded), but the full
            // step row persist is failing. Losing the receipt would
            // mean the buyer was debited with no ledger trace and the
            // UI would falsely report "failed". Persist a minimal
            // receipt with `errorLog="ledger persist degraded"` so the
            // tx hash + cost are at least retained, then surface the
            // unit as VALIDATED (not failed) — the money DID move.
            try {
              await retryDbWrite(
                () =>
                  dependencies.db.steps.create({
                    taskId,
                    serviceName: unitDefinition.service,
                    unitName: unitDefinition.unit,
                    status: "completed",
                    costUsdc: settledExecution.payment.amountUsdc,
                    txHash: settledExecution.payment.txHash,
                    arcUrl: settledExecution.payment.arcUrl,
                    paymentNetwork: settledExecution.payment.network || null,
                    paymentNote: settledExecution.payment.note || null,
                    reusedFromDna: false,
                    dnaSectionKey: unitDefinition.dnaKey || null,
                    outputJson: null,
                    errorLog: `ledger persist degraded — full output dropped: ${error.message?.slice(0, 200) || error.message}`
                  }),
                `Persist degraded receipt for settled unit ${unitDefinition.service}.${unitDefinition.unit}`
              );
            } catch (degradeError) {
              // Even the minimal receipt failed. Log loudly — operator
              // must reconcile from on-chain tx hash by hand.
              console.error(
                `[CRITICAL] Settled payment lost from ledger: tx=${settledExecution.payment.txHash} cost=$${settledExecution.payment.amountUsdc} unit=${unitDefinition.service}.${unitDefinition.unit} task=${taskId}`,
                degradeError?.message || degradeError
              );
            }

            // Make sure the validated counters/socket events fire even
            // when DB persist failed — money was paid, the user must
            // see it accounted.
            if (!settledExecution.accounted) {
              socket.emit("unit:validated", {
                service: unitDefinition.service,
                unit: unitDefinition.unit,
                label: formatUnitLabel(unitDefinition),
                price: unitDefinition.price,
                txHash: settledExecution.payment.txHash,
                amountUsdc: settledExecution.payment.amountUsdc,
                arcUrl: settledExecution.payment.arcUrl,
                network: settledExecution.payment.network || null,
                dnaKey: unitDefinition.dnaKey || null,
                note: settledExecution.payment.note,
                walletAddress: unitWalletAddress,
                walletIndex: unitWalletIndex,
                degraded: true
              });
              totalSpent = Number((totalSpent + settledExecution.payment.amountUsdc).toFixed(6));
              transactions.push({
                order: executionOrder.get(unitId) ?? transactions.length,
                service: unitDefinition.service,
                unit: unitDefinition.unit,
                label: formatUnitLabel(unitDefinition),
                txHash: settledExecution.payment.txHash,
                amountUsdc: settledExecution.payment.amountUsdc,
                arcUrl: settledExecution.payment.arcUrl,
                network: settledExecution.payment.network || null
              });
              settledExecution.accounted = true;
            }
            // Return the settled payment so the parent treats this as
            // a success — the on-chain money moved, only the full DB
            // row was degraded. Throwing here would falsely surface
            // the unit as a failure in the variant settle aggregator.
            return settledExecution;
          }

          throw error;
        }
      }

      throw new Error(`Unit ${unitDefinition.service}.${unitDefinition.unit} exhausted all retries`);
    };

    const serviceBatches = groupByService(normalizedPlan.micro_plan);
    const lastServiceName = serviceBatches[serviceBatches.length - 1]?.serviceName || null;

    for (const batch of serviceBatches) {
      const dynamicConcurrency = agentWorkerDecision?.perService?.[batch.serviceName] || 0;
      const settled = await settleUnitsWithConcurrency(
        batch.units,
        executeUnit,
        getBatchConcurrency(batch.serviceName, dynamicConcurrency)
      );

      const failures = settled
        .filter((entry) => entry.status === "rejected")
        .map((entry) => ({
          service: entry.unitDefinition.service,
          unit: entry.unitDefinition.unit,
          label: formatUnitLabel(entry.unitDefinition),
          error: entry.reason instanceof Error ? entry.reason.message : "Unknown unit failure"
        }));
      failedUnits.push(...failures);

      const batchResults = settled
        .filter((entry) => entry.status === "fulfilled")
        .map((entry) => entry.value);

      if (failures.length > 0) {
        socket.emit("task:warning", {
          service: batch.serviceName,
          count: failures.length,
          message: `${failures.length} ${batch.serviceName} unit(s) failed, but the run is continuing with the successful results`
        });
      }

      if (batch.serviceName === "strategy" && batchResults.length > 0) {
        const strategySnapshot = createStrategySnapshot(batchResults, normalizedPlan.brand_name);

        socket.emit("dna:building", {
          message: "Hermes is compiling the completed DNA blocks..."
        });

        // Hermes daemon / AIMLAPI fallback for DNA writing is an HTTP call with
        // its own internal AbortController, but if that hangs silently the task
        // would stay in "dna" phase forever (no socket task:completed emitted,
        // recoverInterruptedTasks only runs on restart). Hard ceiling here.
        const dna = await Promise.race([
          dependencies.buildDNA({
            brandName: normalizedPlan.brand_name,
            strategyResult: strategySnapshot,
            prompt
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`buildDNA timed out after ${BUILD_DNA_TIMEOUT_MS}ms`)),
              BUILD_DNA_TIMEOUT_MS
            )
          )
        ]);

        dnaFileCreated = dna.fileName;
        context.dnaContent = dna.dnaContent;

        // Stamp ownership so the /api/hermes/dna endpoint can scope the
        // brand list to the wallet that minted it. brandKey is what the
        // ownership store uses (lowercase, normalized brand_name).
        if (mainWalletForSettlement) {
          try {
            const brandKey = String(normalizedPlan.brand_name || "")
              .toLowerCase()
              .replace(/[\s_-]+/g, "-");
            await setDnaOwner(brandKey, mainWalletForSettlement);
          } catch (ownershipError) {
            console.warn(
              `[orchestrator] DNA ownership stamp failed for ${normalizedPlan.brand_name}: ${ownershipError?.message || ownershipError}`
            );
          }
        }

        socket.emit("dna:created", {
          fileName: dna.fileName,
          completed: dnaBlocksCompleted,
          total: normalizedPlan.dna_blocks_total,
          message: `Brand DNA for ${normalizedPlan.brand_name} is now saved in Hermes memory`
        });

        await retryDbWrite(
          () =>
            dependencies.db.skills.create({
              taskId,
              skillName: dna.fileName
            }),
          `Persist DNA skill ${dna.fileName}`
        );
      }

      if (batch.serviceName === "search") {
        const outputs = createOutputMap(batchResults);
        context.searchOutputs = outputs;
        context.newsContext = batchResults
          .map((entry) => entry.output?.summary || entry.output?.text || entry.output?.title || null)
          .filter(Boolean)
          .join(". ");
      }

      if (batch.serviceName === "copy") {
        const outputs = createOutputMap(batchResults);
        context.copyOutputs = outputs;
        context.generatedText = composeCopyFromOutputs({
          taskType,
          brandName: normalizedPlan.brand_name,
          outputs,
          newsContext: context.newsContext
        });
      }

      if (batch.serviceName === "image") {
        const outputs = createOutputMap(batchResults);
        context.imageOutputs = outputs;
        context.generatedImage = composeImageFromOutputs({
          brandName: normalizedPlan.brand_name,
          taskType,
          prompt,
          outputs
        });
      }

      // Small inter-batch delay to avoid Gateway API rate limits under load.
      // M15 fix: skip after the last batch to avoid unnecessary delay.
      if (batch.serviceName !== lastServiceName) {
        await sleep(2_000);
      }
    }

    const warningSummary = createFailureSummary(failedUnits);

    if (transactions.length === 0) {
      const reason = warningSummary || "All payable micro-units failed before any work could complete";

      await retryDbWrite(
        () =>
          dependencies.db.tasks.update(taskId, {
            status: "failed",
            totalSpentUsdc: totalSpent,
            errorLog: reason,
            completedAt: new Date().toISOString()
          }),
        `Persist failed task ${taskId}`
      );

      socket.emit("task:error", {
        message: reason
      });

      return null;
    }

    const result = {
      text: context.generatedText || null,
      imageUrl: context.generatedImage || null,
      taskType,
      brandName: normalizedPlan.brand_name,
      warnings: failedUnits,
      metrics: {
        paidMicroPayments: transactions.length,
        reusedUnits: normalizedPlan.reused_units,
        totalBlueprintUnits: normalizedPlan.blueprint_total_units,
        dnaBlocksBuilt: dnaBlocksCompleted,
        dnaBlocksTotal: normalizedPlan.dna_blocks_total,
        failedUnits: failedUnits.length
      }
    };

    await retryDbWrite(
      () =>
        dependencies.db.tasks.update(taskId, {
          status: "completed",
          totalSpentUsdc: totalSpent,
          dnaFileCreated,
          result,
          errorLog: warningSummary,
          completedAt: new Date().toISOString()
        }),
      `Persist completed task ${taskId}`
    );

    const orderedTransactions = [...transactions].sort((left, right) => left.order - right.order);

    socket.emit("task:completed", {
      result,
      totalSpent,
      savings: normalizedPlan.savings_usdc,
      dnaCreated: dnaFileCreated,
      transactions: orderedTransactions,
      warnings: failedUnits,
      metrics: {
        paidMicroPayments: orderedTransactions.length,
        reusedUnits: normalizedPlan.reused_units,
        totalBlueprintUnits: normalizedPlan.blueprint_total_units,
        dnaBlocksBuilt: dnaBlocksCompleted,
        dnaBlocksTotal: normalizedPlan.dna_blocks_total,
        failedUnits: failedUnits.length
      }
    });

    return {
      plan: normalizedPlan,
      result,
      totalSpent,
      transactions: orderedTransactions,
      dnaFileCreated
    };
  };
}

export const runTask = createTaskRunner();
