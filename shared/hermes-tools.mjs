/**
 * Function-calling schema that Gemini uses to reason about the Muse DNA
 * ecosystem.
 *
 * Every tool maps 1:1 to a real backend operation: Circle Gateway balance,
 * x402 receipts, Hermes DNA library, Arc explorer link builder. When Gemini
 * calls one of these, the dispatcher (`dispatchHermesTool` below) actually
 * invokes the corresponding Circle / x402 / database code path. This is what
 * qualifies the project for the hackathon's Gemini track:
 *
 * > "Function Calling, allowing agents to securely interact with Circle
 * >  APIs and smart contracts as part of real-world payment and settlement
 * >  workflows."
 */

export const HERMES_TOOLS = [
  {
    name: "get_orchestrator_balance",
    description:
      "Return the on-chain USDC balance of the orchestrator wallet on Arc Testnet. Use this when the user asks how much the agent can spend.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "list_recent_micro_payments",
    description:
      "Return the most recent x402 / Circle Gateway micro-payments (at most 25). Each entry is a real settled authorization with tier, txHash, amount in USDC, and Arc explorer URL.",
    parameters: {
      type: "OBJECT",
      properties: {
        limit: {
          type: "INTEGER",
          description: "Max number of payments to return (1-25)."
        }
      },
      required: []
    }
  },
  {
    name: "get_task_status",
    description:
      "Return the current status, tier, spent amount, and steps of a running or completed task by UUID.",
    parameters: {
      type: "OBJECT",
      properties: {
        task_id: {
          type: "STRING",
          description: "UUID of the task to inspect."
        }
      },
      required: ["task_id"]
    }
  },
  {
    name: "list_hermes_dna_assets",
    description:
      "List the brand DNA files Hermes has memorized. Each DNA file lets the next task reuse strategic work for free instead of paying for it again.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "explain_nanopayment_economics",
    description:
      "Return a margin comparison between individual gas-priced settlement (Ethereum mainnet, Base) vs Circle Gateway batched settlement on Arc Testnet for a given payment count and per-payment amount. Use this to explain why nanopayments are viable.",
    parameters: {
      type: "OBJECT",
      properties: {
        payment_count: {
          type: "INTEGER",
          description: "Number of micro-payments in the hypothetical batch."
        },
        amount_usdc: {
          type: "NUMBER",
          description: "Per-payment amount in USDC."
        }
      },
      required: ["payment_count"]
    }
  },
  {
    name: "get_agent_wallet_directory",
    description:
      "Return the Arc Testnet addresses of every sub-agent the orchestrator pays (strategy, search, copy, image) along with the orchestrator wallet itself.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "get_agent_reputation",
    description:
      "Return the ERC-8004-inspired reputation counters (tx count, total USDC settled, active flag) for every registered Muse sub-agent. Use this when the user asks how trustworthy an agent is or how busy the swarm has been.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "preview_bridge_withdraw",
    description:
      "Produce a Circle Bridge Kit / CCTP withdraw preview: fee breakdown, expected receive amount, and finality time for moving USDC from Arc Testnet to a supported destination chain.",
    parameters: {
      type: "OBJECT",
      properties: {
        amount_usdc: { type: "NUMBER", description: "Amount to withdraw." },
        destination_chain_id: { type: "INTEGER", description: "EVM chainId of the destination (e.g. 8453 for Base)." },
        destination_address: { type: "STRING", description: "Destination EVM address." }
      },
      required: ["amount_usdc", "destination_chain_id", "destination_address"]
    }
  },
  {
    name: "summarize_tier_catalog",
    description:
      "List LITE / BALANCED / DEEP tiers with their unit count, estimated cost, and DNA coverage so Hermes can explain the economic trade-offs.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  }
];

/**
 * Coerce a tool-call argument to a finite number or fall back to the default.
 * Gemini is allowed to pass non-numeric values ("NaN", "abc", null) and any
 * math we do on those propagates NaN through later comparisons (e.g.
 * `count >= NaN` is always false) which can unbound a loop.
 */
function coerceFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Safely accept `args` from an LLM: strip dangerous prototype slots so a
 * polluted object cannot influence our internal Object.prototype lookups,
 * and refuse non-plain objects early.
 */
function sanitizeToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object") {
    return {};
  }
  const safe = Object.create(null);
  for (const key of Object.keys(rawArgs)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    safe[key] = rawArgs[key];
  }
  return safe;
}

/**
 * Dispatch a function call returned by Gemini. `context` carries the backend
 * dependencies so this module stays easy to unit-test.
 */
export async function dispatchHermesTool(name, rawArgs = {}, context = {}) {
  const args = sanitizeToolArgs(rawArgs);
  const {
    db,
    listDnaAssets,
    getWalletBalance,
    getAgentDirectory,
    buildArcTxUrl,
    buildTierCatalog
  } = context;

  switch (name) {
    case "get_orchestrator_balance": {
      const balance = await getWalletBalance();
      return {
        address: balance.address,
        balance_usdc: balance.balanceUsdc,
        network: balance.network || "eip155:5042002",
        source: balance.source || "arc-testnet"
      };
    }

    case "list_recent_micro_payments": {
      const limit = Math.max(1, Math.min(25, coerceFiniteNumber(args.limit, 10)));
      const tasks = await db.tasks.findAll();
      const payments = [];
      for (const task of tasks) {
        if (payments.length >= limit) break;
        const steps = await db.steps.findByTask(task.id);
        for (const step of steps) {
          if (payments.length >= limit) break;
          if (step.status !== "completed" || !step.tx_hash) continue;
          payments.push({
            task_id: task.id,
            tier: task.tier || null,
            service: step.service_name,
            unit: step.unit_name,
            amount_usdc: Number(step.cost_usdc || 0),
            tx_hash: step.tx_hash,
            network: step.payment_network || null,
            arc_url: step.arc_url || buildArcTxUrl?.(step.tx_hash) || null,
            settled_at: step.completed_at || step.started_at || null
          });
        }
      }
      return {
        count: payments.length,
        payments
      };
    }

    case "get_task_status": {
      const taskId = String(args.task_id || "").trim();
      if (!taskId) {
        return { error: "task_id required" };
      }
      const task = await db.tasks.findById(taskId);
      if (!task) {
        return { error: "Task not found", task_id: taskId };
      }
      const steps = await db.steps.findByTask(taskId);
      const completedCount = steps.filter((s) => s.status === "completed").length;
      const failedCount = steps.filter((s) => s.status === "failed").length;
      return {
        task_id: task.id,
        status: task.status,
        brand_name: task.brand_name,
        tier: task.tier || task.variant_tier || null,
        total_spent_usdc: Number(task.total_spent_usdc || 0),
        savings_usdc: Number(task.savings_usdc || 0),
        dna_file: task.dna_file_created || null,
        steps_total: steps.length,
        steps_completed: completedCount,
        steps_failed: failedCount,
        completed_at: task.completed_at,
        error_log: task.error_log || null
      };
    }

    case "list_hermes_dna_assets": {
      const assets = await listDnaAssets();
      return {
        count: assets.length,
        dna_files: assets
      };
    }

    case "explain_nanopayment_economics": {
      const paymentCount = Math.max(1, Math.min(10_000, coerceFiniteNumber(args.payment_count, 52)));
      const perPaymentUsdc = Math.max(0.00001, coerceFiniteNumber(args.amount_usdc, 0.005));
      // Conservative gas estimates; these are rough L1/L2 typical costs.
      const ETHEREUM_MAINNET_GAS_USDC = 2.5;
      const BASE_MAINNET_GAS_USDC = 0.15;
      const ARC_BATCH_GAS_USDC = 0.01;
      const totalPaymentUsdc = Number((paymentCount * perPaymentUsdc).toFixed(6));

      return {
        payment_count: paymentCount,
        per_payment_usdc: perPaymentUsdc,
        total_value_usdc: totalPaymentUsdc,
        scenarios: [
          {
            name: "Ethereum L1 (one-tx-per-payment)",
            gas_total_usdc: Number((ETHEREUM_MAINNET_GAS_USDC * paymentCount).toFixed(4)),
            gas_per_payment_usdc: ETHEREUM_MAINNET_GAS_USDC,
            break_even_payment_usdc: ETHEREUM_MAINNET_GAS_USDC,
            verdict: "Infeasible: per-call gas exceeds payment value by ~500x."
          },
          {
            name: "Base L2 (one-tx-per-payment)",
            gas_total_usdc: Number((BASE_MAINNET_GAS_USDC * paymentCount).toFixed(4)),
            gas_per_payment_usdc: BASE_MAINNET_GAS_USDC,
            break_even_payment_usdc: BASE_MAINNET_GAS_USDC,
            verdict: "Still too expensive: gas > payment, eats all margin."
          },
          {
            name: "Arc Testnet + Circle Gateway batched",
            gas_total_usdc: ARC_BATCH_GAS_USDC,
            gas_per_payment_usdc: Number((ARC_BATCH_GAS_USDC / paymentCount).toFixed(6)),
            break_even_payment_usdc: Number((ARC_BATCH_GAS_USDC / paymentCount).toFixed(6)),
            verdict: "Viable: effective gas per payment is sub-cent."
          }
        ],
        summary: `For ${paymentCount} authorizations at $${perPaymentUsdc.toFixed(4)} USDC each, Arc + Gateway charges ~$${(ARC_BATCH_GAS_USDC / paymentCount).toFixed(6)} gas per payment, while Ethereum mainnet charges $${ETHEREUM_MAINNET_GAS_USDC.toFixed(2)}. Batching is the only path to sub-cent pricing.`
      };
    }

    case "get_agent_wallet_directory": {
      const directory = await getAgentDirectory();
      return { agents: directory };
    }

    case "summarize_tier_catalog": {
      const tiers = await buildTierCatalog();
      return { tiers };
    }

    case "get_agent_reputation": {
      if (!context.getAgentReputation) {
        return { error: "agent registry unavailable" };
      }
      const agents = await context.getAgentReputation();
      return {
        count: agents.length,
        mode: context.registryMode ? context.registryMode() : "unknown",
        agents
      };
    }

    case "preview_bridge_withdraw": {
      if (!context.previewBridge) {
        return { error: "bridge preview unavailable" };
      }
      const preview = await context.previewBridge({
        amountUsdc: coerceFiniteNumber(args.amount_usdc, 0),
        destinationChainId: coerceFiniteNumber(args.destination_chain_id, 0),
        destinationAddress: String(args.destination_address || "")
      });
      return preview;
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
