import express from "express";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { db } from "../db/index.js";
import { issueMuseSession, requireSignedMainWallet } from "../middleware/siwe.js";
import { runTask } from "../services/orchestrator.js";
import { planVariants } from "../services/variantPlanner.js";
import { extractBrandName, listSkillFiles } from "../services/hermes.js";
import { TIER_KEYS, buildTierPlan, getTierMeta } from "../services/microeconomy.js";
import { getOrchestratorSigner } from "../services/orchestratorWallets.js";

const ARC_RPC_URL =
  process.env.ARC_RPC_URL ||
  process.env.NEXT_PUBLIC_ARC_RPC_URL ||
  "https://rpc.blockdaemon.testnet.arc.network";

/**
 * Pre-flight that turns "task fails on x402 insufficient_balance after 30s
 * of cascading retries" into a clean 400 with a concrete CTA. Steps:
 *   1. Confirm the connected MetaMask has a backend orchestrator deployed.
 *   2. Read the orchestrator's Gateway-side USDC balance.
 *   3. If short, try to auto-deposit from the orchestrator's on-chain wallet
 *      (because the user already topped that up via MetaMask). This makes
 *      the demo flow "fund once → run anything" instead of forcing a second
 *      manual step.
 *   4. If on-chain is also short, return 400 with the exact USDC amount
 *      the UI should ask the user to top up from MetaMask.
 */
async function ensureOrchestratorReadyForSpend({ mainWallet, estimatedCostUsdc }) {
  if (!mainWallet) return { ok: true }; // Anonymous task path — orchestrator skipped.

  const signer = await getOrchestratorSigner(mainWallet).catch(() => null);
  if (!signer?.privateKey) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "ORCHESTRATOR_NOT_DEPLOYED",
        message: "Deploy your orchestrator before launching a task.",
        cta: "DEPLOY ORCHESTRATOR"
      }
    };
  }

  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: signer.privateKey,
    rpcUrl: ARC_RPC_URL
  });

  // Distinguish "RPC unhealthy" from "balance is zero". Treating an RPC
  // error as 0 balance (which we used to do) led the user into the
  // auto-deposit branch, then the deposit itself failed because the same
  // RPC was down — surfacing as "TOP UP $X" when the real problem was
  // network. Now we return 503 so the UI shows "Arc RPC is unreachable —
  // try again in a moment" instead of asking the user for money.
  let balances;
  try {
    balances = await gateway.getBalances();
  } catch (err) {
    console.warn(`[tasks] Gateway balance read failed for orch ${signer.address}: ${err?.message || err}`);
    return {
      ok: false,
      status: 503,
      body: {
        error: "ARC_RPC_UNREACHABLE",
        message: "Arc Testnet RPC is currently unreachable — please retry in a few seconds.",
        cta: "RETRY"
      }
    };
  }

  // 0.005 USDC headroom on top of estimated cost — Gateway settle rounds
  // each payment up to a 6-decimal atomic unit, so a few cents of slack
  // prevents the last unit from failing on a rounding boundary.
  const required = Number((Number(estimatedCostUsdc || 0) + 0.005).toFixed(6));
  const gatewayAvailable = Number(balances?.gateway?.formattedAvailable || 0);
  const onChainAvailable = Number(balances?.wallet?.formatted || 0);
  // Native-gas reserve required INDEPENDENTLY of Gateway balance. The
  // orchestrator broadcasts a real on-chain native USDC transfer per
  // unit (direct settle — the ArcScan hash judges click). Each transfer
  // burns gas + value. If we returned ok={true} based on Gateway alone
  // when on-chain native is empty, x402 would settle but every direct
  // settle would fail "insufficient funds" — judges would see Gateway
  // UUIDs (no ArcScan link). So check the reserve EVERY pre-flight,
  // even when Gateway is already funded.
  const directSettleReserveUsdc = Number((Number(estimatedCostUsdc || 0) + 0.05).toFixed(6));
  if (gatewayAvailable >= required && onChainAvailable >= directSettleReserveUsdc) {
    return { ok: true, gatewayAvailable };
  }

  // Auto-deposit attempt: orch wallet may already have on-chain USDC from
  // a prior MetaMask top-up that hasn't been moved into the Gateway yet.
  const shortfall = Math.max(0, Number((required - gatewayAvailable).toFixed(6)));
  // Round up to 0.01 to avoid noisy 0.00543 deposits.
  const depositAmount = Math.max(0.01, Math.ceil(shortfall * 100) / 100);
  const onChainAfterDeposit = Number((onChainAvailable - depositAmount).toFixed(6));

  if (onChainAvailable >= depositAmount && onChainAfterDeposit >= directSettleReserveUsdc) {
    console.log(
      `[tasks] auto-depositing ${depositAmount} USDC from orch ${signer.address} on-chain → Gateway (had ${gatewayAvailable.toFixed(4)}, need ${required.toFixed(4)})`
    );
    // Retry the deposit through txpool/network blips. Same shape as
    // sendMicroPaymentOnArc/withdrawOrchestrator — drill the cause chain
    // because viem hides the real reason in `err.details`.
    let depositSucceeded = false;
    let lastDepErr = null;
    const RETRY_DELAYS_MS = [1_500, 3_000, 5_000];
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt += 1) {
      try {
        await gateway.deposit(depositAmount.toFixed(6));
        depositSucceeded = true;
        break;
      } catch (depErr) {
        lastDepErr = depErr;
        const parts = [];
        let cur = depErr;
        // Walk up to 8 levels — viem can wrap errors through ContractFunctionError
        // → TransactionExecutionError → TransactionRejectedRpcError → RpcRequestError
        // → InternalRpcError, plus our own retry wrapper on top. Five was
        // shallow enough that the real "txpool is full" reason fell off the
        // bottom of the chain on some failure modes.
        for (let i = 0; i < 8 && cur; i += 1) {
          if (cur.shortMessage) parts.push(String(cur.shortMessage));
          if (cur.details) parts.push(String(cur.details));
          if (cur.message) parts.push(String(cur.message));
          cur = cur.cause;
        }
        const msg = parts.join(" | ");
        const retryable = /txpool is full|already known|nonce too low|replacement transaction underpriced|timeout|ECONNRESET|fetch failed|503|502|504/i.test(msg);
        if (!retryable || attempt === RETRY_DELAYS_MS.length) {
          console.warn(`[tasks] auto-deposit failed (final) for orch ${signer.address}: ${msg.slice(0, 200)}`);
          break;
        }
        const waitMs = RETRY_DELAYS_MS[attempt];
        console.warn(`[tasks] auto-deposit retry ${attempt + 1}/${RETRY_DELAYS_MS.length} after txpool/transient error in ${(waitMs / 1000).toFixed(1)}s`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    if (depositSucceeded) {
      // Gateway's verify endpoint reads the indexed balance. On a healthy RPC
      // the deposit confirms in ~1-2 blocks, but the Gateway side has its own
      // indexer lag. Poll up to 6s in 1s ticks until the new balance is live;
      // bail out otherwise so the task either finds the funds or the user sees
      // a clear "still indexing" message instead of a confusing 402.
      const targetAvailable = gatewayAvailable + depositAmount * 0.95; // tolerate small fee deltas
      let confirmed = false;
      for (let i = 0; i < 6 && !confirmed; i += 1) {
        await new Promise((r) => setTimeout(r, 1_000));
        const refreshed = await gateway.getBalances().catch(() => null);
        const nowAvailable = Number(refreshed?.gateway?.formattedAvailable || 0);
        if (nowAvailable >= targetAvailable) confirmed = true;
      }
      return {
        ok: true,
        gatewayAvailable: gatewayAvailable + depositAmount,
        autoDeposited: depositAmount,
        gatewayIndexConfirmed: confirmed
      };
    }
    // Fell through retries — surface as the same "needs top-up" branch so the
    // user gets a clear CTA rather than a stuck spinner.
  }

  // True top-up requirement = how much MORE total native USDC the orch
  // needs on-chain so we can both deposit `depositAmount` into Gateway AND
  // still hold back `directSettleReserveUsdc` for direct on-chain settle.
  //
  //   requiredTotal = max(required, depositAmount) + reserve
  //   trueTopUp     = max(0.01, requiredTotal - onChainAvailable)
  //
  // The previous formula double-counted the deposit when computing the
  // reserve gap, leading to a 67% over-ask in the common case
  // (onChainAvailable=0.045, depositAmount=0.01, reserve=0.05 → asked 0.025
  // when the user actually needed 0.015).
  const requiredTotal = Number(
    (Math.max(required, depositAmount) + directSettleReserveUsdc).toFixed(6)
  );
  const trueTopUp = Math.max(
    0.01,
    Number((requiredTotal - onChainAvailable).toFixed(2))
  );
  return {
    ok: false,
    status: 402,
    body: {
      error: "INSUFFICIENT_GATEWAY_BALANCE",
      message: `Top up at least ${trueTopUp.toFixed(2)} USDC from MetaMask before running this task.`,
      cta: "TOP UP",
      requiredUsdc: trueTopUp,
      gatewayAvailableUsdc: gatewayAvailable,
      orchOnChainUsdc: onChainAvailable,
      reserveUsdc: directSettleReserveUsdc
    }
  };
}

// Per-task agent wallets are now provisioned DYNAMICALLY inside the
// orchestrator (4-15 fresh EVM wallets per task based on plan +
// prompt complexity). This route no longer pre-generates them — the
// orchestrator emits `task:wallets_deployed` directly over socket.

const router = express.Router();
const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS || 10);
const MAX_PROMPT_LEN = Number(process.env.MAX_PROMPT_LEN || 8192);
const MAX_BUDGET_USDC = Number(process.env.MAX_BUDGET_USDC || 100);
const TASK_PLAN_WINDOW_MS = 5 * 60 * 1000;
const TASK_PLAN_MAX = 20;
const taskPlanAttempts = new Map();
const TASK_PLAN_KEY_CAP = 4096;
let activeTasksCount = 0;

function normalizeTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  return TIER_KEYS.includes(tier) ? tier : null;
}

function validatePromptLength(prompt) {
  // Prompt flows into the Gemini planner and into filesystem-adjacent
  // Hermes paths; cap length at the edge so an 80KB adversarial prompt
  // can't soak planner tokens or starve the agent pool.
  if (typeof prompt === "string" && prompt.length > MAX_PROMPT_LEN) {
    return `prompt too long (max ${MAX_PROMPT_LEN} chars)`;
  }
  return null;
}

/**
 * POST /api/tasks/plan
 *
 * Preview endpoint. Calls Gemini (via Function Calling) and returns three
 * execution variants the frontend displays to the user. No payment happens,
 * no sub-agents run.
 */
router.post("/plan", async (req, res) => {
  try {
    const now = Date.now();
    const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
    const stamps = (taskPlanAttempts.get(ip) || []).filter(
      (t) => now - t < TASK_PLAN_WINDOW_MS
    );
    if (stamps.length >= TASK_PLAN_MAX) {
      const retryInSec = Math.ceil((stamps[0] + TASK_PLAN_WINDOW_MS - now) / 1000);
      return res.status(429).json({
        error: `Too many planner requests. Try again in ~${retryInSec}s.`,
        retryAfter: retryInSec
      });
    }
    stamps.push(now);
    taskPlanAttempts.set(ip, stamps);
    if (taskPlanAttempts.size > TASK_PLAN_KEY_CAP) {
      const drop = taskPlanAttempts.size - TASK_PLAN_KEY_CAP;
      let i = 0;
      for (const key of taskPlanAttempts.keys()) {
        if (i++ >= drop) break;
        taskPlanAttempts.delete(key);
      }
    }

    const { prompt, taskType } = req.body || {};

    // Explicit typeof guard — `!prompt?.trim()` lets through a payload like
    // {prompt: {trim: 1}} where `.trim` is truthy non-function; the next
    // line then crashes calling `validatePromptLength`/`extractBrandName`
    // with an object. Match the /create handler's strict-string check.
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt required" });
    }
    const promptLenErr = validatePromptLength(prompt);
    if (promptLenErr) {
      return res.status(400).json({ error: promptLenErr });
    }
    if (typeof taskType !== "string" || !taskType.trim()) {
      return res.status(400).json({ error: "taskType required" });
    }

    const brandGuess = extractBrandName(prompt);
    const skillFiles = await listSkillFiles().catch(() => []);
    const dnaFile = skillFiles.find((name) => {
      const normalized = name
        .normalize("NFKC")
        .toLowerCase()
        .replace(/_dna\.md$/i, "");
      return normalized === String(brandGuess).toLowerCase().normalize("NFKC");
    });

    const plan = await planVariants({
      prompt: prompt.trim(),
      taskType: taskType.trim(),
      dnaExists: Boolean(dnaFile)
    });

    return res.json({
      brandName: plan.brand_name,
      dnaExists: plan.dna_exists,
      dnaFile: dnaFile || null,
      recommendedTier: plan.recommended_tier,
      rationale: plan.rationale,
      variants: plan.variants.map((variant) => ({
        tier: variant.tier,
        label: variant.label,
        subtitle: variant.subtitle,
        description: variant.description,
        timeEstimateSeconds: variant.timeEstimateSeconds,
        units: variant.units,
        dnaBlocks: variant.dnaBlocks,
        dnaBlocksTotal: variant.dnaBlocksTotal,
        estimatedCostUsdc: variant.estimatedCostUsdc,
        savingsUsdc: variant.savingsUsdc,
        services: variant.services,
        // Dynamic agent count (4-15) picked per-task by Hermes + fallback
        // heuristic. This is what the UI should show as "AGENTS" on the
        // variant card — number of fresh wallets that'll be deployed.
        agents: variant.agents,
        agentsPerService: variant.agents_per_service,
        headline: variant.headline,
        narrative: variant.narrative,
        dnaFocus: variant.dna_focus,
        riskNote: variant.risk_note,
        plan: {
          microPlan: variant.plan.micro_plan.map((u) => ({
            service: u.service,
            unit: u.unit,
            label: u.label,
            price: u.price,
            dnaKey: u.dnaKey
          })),
          payableUnits: variant.plan.payable_units,
          dnaBlocksIncluded: variant.plan.dna_blocks_included
        }
      })),
      source: plan.source,
      model: plan.model || null
    });
  } catch (error) {
    console.error("Plan variants failed:", error);
    return res.status(500).json({ error: "Failed to build variant plan." });
  }
});

// Per-(IP, mainWallet) rate limit on task creation — stop-gap until SIWE
// proves ownership. Without it an attacker who knows a victim's MetaMask
// address could spam /api/tasks against the victim's orchestrator and burn
// their gateway balance + native gas. 5 task starts per 5-minute window
// is generous for legitimate users (judges + retries) and slow enough to
// make drain-by-spam impractical.
const TASK_CREATE_WINDOW_MS = 5 * 60 * 1000;
const TASK_CREATE_MAX = 5;
const taskCreateAttempts = new Map();
const TASK_CREATE_KEY_CAP = 4096;
function pruneTaskCreateAttempts(now) {
  for (const [k, stamps] of taskCreateAttempts) {
    const fresh = stamps.filter((t) => now - t < TASK_CREATE_WINDOW_MS);
    if (fresh.length === 0) taskCreateAttempts.delete(k);
    else taskCreateAttempts.set(k, fresh);
  }
  if (taskCreateAttempts.size > TASK_CREATE_KEY_CAP) {
    const drop = taskCreateAttempts.size - TASK_CREATE_KEY_CAP;
    let i = 0;
    for (const k of taskCreateAttempts.keys()) {
      if (i++ >= drop) break;
      taskCreateAttempts.delete(k);
    }
  }
}

router.post("/", requireSignedMainWallet({ allowHeadless: true }), async (req, res) => {
  let counted = false;
  try {
    // INPUT VALIDATION FIRST — runs before we reserve a concurrency slot
    // so malformed bodies (`{}`, `null`, missing fields) don't leak slots.
    // The previous form incremented `activeTasksCount` then returned 400
    // without decrementing, so 10 bad POSTs from a bot could pin the cap
    // forever and lock real users out of the queue.
    const { prompt, taskType, budgetUsdc, sessionWallets, tier, mainWallet, headless } = req.body || {};
    // brandName + notes were dropped on the floor previously — frontend
    // sent them but neither persisted nor forwarded to Hermes. brandName
    // now lands in the `tasks.brand_name` column; notes are appended to
    // the prompt with a marker so the LLM picks them up as constraints.
    const brandNameRaw = typeof req.body?.brandName === "string" ? req.body.brandName.trim() : "";
    const notesRaw = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";

    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt required" });
    }
    const promptLenErr = validatePromptLength(prompt);
    if (promptLenErr) {
      return res.status(400).json({ error: promptLenErr });
    }

    if (typeof taskType !== "string" || !taskType.trim()) {
      return res.status(400).json({ error: "taskType required" });
    }

    // mainWallet must be a real EVM address. We used to accept anything
    // and only fail later during direct-settle (which left the task in
    // `running` state silently for minutes); validate up front so bad
    // clients get a clean 400 and don't occupy a concurrency slot.
    //
    // For non-headless calls (i.e. the UI flow) mainWallet is now REQUIRED:
    // without it the orchestrator has no per-user signer to load from
    // `orchestrator-wallets.json`, would fall through to the env shortcut
    // (which is the multi-tenancy bug we just closed), and tasks would
    // either silently spend the wrong wallet or fail mid-run. CI scripts
    // that legitimately have no MetaMask must opt in via the headless gate
    // (env `MUSE_SKIP_PREFLIGHT=true` or admin token).
    // Compute the headless authorisation ONCE per request and reuse it
    // below for the pre-flight gate. The previous form recomputed env
    // vars and headers a second time at the pre-flight site — if env
    // changed mid-request (extremely rare but possible in a hot-reload
    // scenario), the two reads could disagree and pre-flight would
    // either run or skip inconsistently with the upfront mainWallet check.
    const authContext = req.museAuth || {};
    const wantsHeadless = Boolean(authContext.wantsHeadless);
    const normalizedMainWallet = typeof mainWallet === "string" ? mainWallet.trim() : "";
    if (mainWallet !== undefined && mainWallet !== null && mainWallet !== "") {
      if (!normalizedMainWallet || !/^0x[0-9a-fA-F]{40}$/.test(normalizedMainWallet)) {
        return res.status(400).json({ error: "mainWallet must be a valid 0x-prefixed EVM address" });
      }
    } else if (!wantsHeadless) {
      return res.status(400).json({
        error: "MAIN_WALLET_REQUIRED",
        message: "Connect a wallet before launching a task — mainWallet is required for x402 signing."
      });
    }

    // Per-(IP, mainWallet) rate limit. Skip for authorised headless calls
    // (admin token / env override) so CI scripts and the hackathon stress
    // test aren't capped to 5 tasks/5min. Real UI users almost never hit
    // 5 task starts in 5 minutes; bots trying to drain a known orch will.
    if (!wantsHeadless && normalizedMainWallet) {
      const now = Date.now();
      const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
      const rateKey = `${ip}::${normalizedMainWallet.toLowerCase()}`;
      const stamps = (taskCreateAttempts.get(rateKey) || []).filter(
        (t) => now - t < TASK_CREATE_WINDOW_MS
      );
      if (stamps.length >= TASK_CREATE_MAX) {
        const retryInSec = Math.ceil((stamps[0] + TASK_CREATE_WINDOW_MS - now) / 1000);
        return res.status(429).json({
          error: `Too many task starts for this wallet. Try again in ~${retryInSec}s.`,
          retryAfter: retryInSec
        });
      }
      stamps.push(now);
      taskCreateAttempts.set(rateKey, stamps);
      if (Math.random() < 0.05) pruneTaskCreateAttempts(now);
    }

    // Now that the body is shaped correctly, reserve the concurrency slot.
    // The 429 check happens here (not before validation) so a flood of
    // garbage POSTs only spends ~µs of CPU each, never burning slot quota.
    if (activeTasksCount >= MAX_CONCURRENT_TASKS) {
      return res.status(429).json({ error: "Too many concurrent tasks running. Please wait." });
    }
    activeTasksCount += 1;
    counted = true;

    const normalizedTier = normalizeTier(tier) || "deep";
    const tierMeta = getTierMeta(normalizedTier);
    const tierPlanPreview = buildTierPlan({ tier: normalizedTier });
    const defaultBudget = Math.max(0.5, tierPlanPreview.estimated_cost_usdc * 1.2);
    const parsedBudget = Number(budgetUsdc);
    // Clamp: reject NaN/Infinity/negative (fall back to default) AND cap
    // the upper bound to MAX_BUDGET_USDC so a bad client can't authorize
    // a runaway task that drains the orchestrator wallet.
    const validBudget = Number.isFinite(parsedBudget) && parsedBudget > 0
      ? Math.min(parsedBudget, MAX_BUDGET_USDC)
      : Number(defaultBudget.toFixed(3));
    const safeBudget = Math.min(validBudget, MAX_BUDGET_USDC);

    // Pre-flight orchestrator check. Stops the task from spinning up agents
    // and burning 30s of fallbacks just to fail on Gateway 402. Returns a
    // structured error the UI can map to a CTA (deploy / top-up).
    //
    // Headless gate is server-controlled via env (MUSE_SKIP_PREFLIGHT=true)
    // Reuse the headless authorisation computed above (line ~340) so the
    // pre-flight gate can't disagree with the upfront mainWallet check.
    // We deliberately do NOT trust a body field for this — a hostile client
    // could otherwise set `headless: true` and bypass the orchestrator
    // funding check, letting the task burn 30+ seconds before failing on
    // the agent's x402 challenge.
    const skipPreflight = wantsHeadless;

    if (normalizedMainWallet && !skipPreflight) {
      const preflight = await ensureOrchestratorReadyForSpend({
        mainWallet: normalizedMainWallet,
        estimatedCostUsdc: tierPlanPreview.estimated_cost_usdc
      });
      if (!preflight.ok) {
        if (counted) {
          activeTasksCount = Math.max(0, activeTasksCount - 1);
          counted = false;
        }
        return res.status(preflight.status).json(preflight.body);
      }
    }

    // Compose the effective prompt: original task + optional notes block.
    // The orchestrator/Hermes reads the prompt verbatim, so a clearly
    // delimited notes section is the path of least resistance for routing
    // the user's tone/constraints to the LLM without a schema migration.
    const composedPrompt = notesRaw
      ? `${prompt.trim()}\n\n## Notes / Constraints\n${notesRaw}`
      : prompt.trim();

    const task = await db.tasks.create({
      prompt: composedPrompt,
      taskType: taskType.trim(),
      brandName: brandNameRaw || null,
      budgetUsdc: safeBudget,
      status: "running"
    });

    task.tier = normalizedTier;
    task.tierMeta = tierMeta;

    if (normalizedMainWallet && !wantsHeadless && req.verifiedMainWallet) {
      issueMuseSession(res, req.verifiedMainWallet);
    }

    res.json({
      taskId: task.id,
      tier: normalizedTier,
      tierMeta,
      estimatedCostUsdc: tierPlanPreview.estimated_cost_usdc
      // Agent wallets are announced separately via `task:wallets_deployed`
      // on the socket once the orchestrator has picked N workers.
    });

    const io = req.app.get("io");
    const socket = {
      emit(event, data) {
        io.to(`task:${task.id}`).emit(event, data);
      }
    };

    const ROOM_READY_TIMEOUT_MS = 5_000;
    const roomName = `task:${task.id}`;

    // Wallet announcement now happens inside the orchestrator once it has
    // computed the dynamic worker count from the plan.

    // Headless callers (CI scripts, hackathon stress test) opt out of the
    // abandoned-tab guard. They poll /api/tasks/:id over HTTP instead of
    // joining the Socket.io room, so the guard would always abort their
    // tasks before any spend. UI clients keep the original protection.
    //
    // SECURITY: gate on `wantsHeadless` (which requires MUSE_SKIP_PREFLIGHT
    // env OR a timing-safe admin token), NOT the raw `headless === true`
    // body field. Otherwise an unauthenticated client with any mainWallet
    // could send `headless: true` and bypass this guard, kicking off real
    // x402 spend without the user's tab even knowing.
    const waitForRoomReady = wantsHeadless
      ? Promise.resolve({ joined: true })
      : new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Timed out — nobody ever joined. Orchestrator decides below
          // whether to still run based on final room occupancy.
          resolve({ joined: false });
        }
      }, ROOM_READY_TIMEOUT_MS);

      const checkInterval = setInterval(() => {
        if (resolved) {
          clearInterval(checkInterval);
          return;
        }
        const roomMembers = io.of('/').adapter.rooms.get(roomName);
        if (roomMembers && roomMembers.size > 0) {
          resolved = true;
          clearTimeout(timer);
          clearInterval(checkInterval);
          resolve({ joined: true });
        }
      }, 200);
    });

    waitForRoomReady.then(async (readyResult) => {
      try {
        // Phantom-task guard: if after ROOM_READY_TIMEOUT_MS nobody has
        // joined the task room AND the room is still empty right now,
        // bail out instead of silently running and spending USDC against
        // a closed tab. The user can always retry — the task row remains
        // so it's visible in /api/tasks/:id.
        if (!readyResult?.joined) {
          const members = io.of('/').adapter.rooms.get(roomName);
          if (!members || members.size === 0) {
            await db.tasks.update(task.id, {
              status: "failed",
              errorLog: "No client joined the task room within the ready window — task aborted before any spend."
            }).catch((dbErr) => {
              console.error("Task abort state update failed:", dbErr?.message || dbErr);
            });
            return;
          }
        }
        await runTask(task, socket, sessionWallets, {
          mainWallet: normalizedMainWallet || null
        });
      } catch (error) {
        // Defensive: the full error message can include stack snippets, env
        // hints, or upstream HTTP bodies. Log it server-side but do not echo
        // raw error text into the socket or the DB errorLog — both surfaces
        // are readable by external clients (socket room + /api/tasks/:id).
        console.error("Task orchestration failed:", error?.message || error);
        socket.emit("task:error", {
          message: "Task orchestration failed — check backend logs."
        });

        try {
          await db.tasks.update(task.id, {
            status: "failed",
            errorLog: "Task orchestration failed — check backend logs."
          });
        } catch (dbError) {
          console.error("Task failure state update failed:", dbError?.message || dbError);
        }
      } finally {
        if (counted) {
          activeTasksCount = Math.max(0, activeTasksCount - 1);
          counted = false;
        }
      }
    }).catch((error) => {
      // Belt-and-suspenders: if waitForRoomReady itself rejects we still
      // need to free the counter slot.
      console.error("Task room-ready handler crashed:", error?.message || error);
      if (counted) {
        activeTasksCount = Math.max(0, activeTasksCount - 1);
        counted = false;
      }
    });
  } catch (error) {
    console.error("Task create failed:", error.message);
    if (counted) {
      activeTasksCount = Math.max(0, activeTasksCount - 1);
      counted = false;
    }
    return res.status(500).json({ error: "Failed to create task." });
  }
});

// RFC 4122 UUID v1-v5 (case-insensitive). Plus our `sim-…` simulation IDs
// the frontend uses when no real backend is available. Anything else is
// guaranteed-bogus so we 400 immediately instead of letting Postgres
// throw a 500 on an invalid uuid cast.
const TASK_ID_REGEX = /^(sim-[a-z0-9-]{6,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

router.get("/:id", async (req, res) => {
  try {
    const taskId = String(req.params.id || "").trim();
    if (!TASK_ID_REGEX.test(taskId)) {
      return res.status(400).json({ error: "Invalid task ID format" });
    }
    const task = await db.tasks.findById(taskId);

    if (!task) {
      return res.status(404).json({ error: "Task not found." });
    }

    const steps = await db.steps.findByTask(req.params.id);
    return res.json({ task, steps });
  } catch (error) {
    console.error("Task lookup failed:", error.message);
    return res.status(500).json({ error: "Failed to load task." });
  }
});

export default router;
