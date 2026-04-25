/**
 * Hermes Chat — conversational brain backed by Gemini Function Calling.
 *
 * The user can ask natural-language questions about the Muse DNA economy
 * ("how many tx settled today?", "explain why this beats Ethereum gas",
 *  "inspect task X"). Gemini decides which tool to call, the dispatcher
 * invokes the real backend code (Circle Gateway balance, x402 ledger,
 * Hermes DNA files, tier catalog, etc.), the result is fed back, and Gemini
 * emits a final natural-language answer.
 *
 * One chat turn can invoke multiple tools — the loop below iterates up to
 * MAX_TOOL_ITERATIONS before forcing a text answer.
 */
import { geminiChat, hasGeminiKey } from "../../shared/gemini-client.mjs";
import { HERMES_TOOLS, dispatchHermesTool } from "../../shared/hermes-tools.mjs";
import { listSkillFiles } from "./hermes.js";
import { buildAllTierSummaries } from "./microeconomy.js";
import { listAgents as listRegistryAgents, registryMode } from "./agentRegistry.js";
import { privateKeyToAccount } from "viem/accounts";

const MAX_TOOL_ITERATIONS = 5;

const SYSTEM_PROMPT = `You are Hermes — the reasoning brain of the Muse DNA agent swarm.
You coordinate four specialized sub-agents (strategy, search, copy, image),
each with its own Arc Testnet wallet, and every creative action they take is
settled as an x402 nanopayment through Circle Gateway. You can call tools to
inspect balances, recent payments, task status, DNA memory, the tier catalog,
and to explain the nanopayment economics.

Rules:
- Always call a tool when the user asks for factual state (balances, tx, tasks, DNA).
- Chain tools when needed (e.g. list payments, then explain economics using that count).
- Never invent numbers — use tool output.
- Keep answers operator-friendly: short paragraphs, tight bullet lists, plain text.
- When asked "why is this viable" always call explain_nanopayment_economics and cite the numbers it returns.
`;

function resolveSelfManagedAddress() {
  const key =
    process.env.MUSE_BUYER_PRIVATE_KEY ||
    process.env.MUSE_GATEWAY_PRIVATE_KEY ||
    process.env.ORCHESTRATOR_PRIVATE_KEY ||
    "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(key).trim())) return null;
  try {
    return privateKeyToAccount(String(key).trim()).address;
  } catch {
    return null;
  }
}

function getAgentDirectoryDefault() {
  return [
    {
      role: "orchestrator",
      address:
        process.env.ORCHESTRATOR_WALLET_ADDRESS ||
        resolveSelfManagedAddress() ||
        "(self-managed key not configured)"
    },
    {
      role: "strategy",
      label: "Strategy DNA agent",
      address: process.env.STRATEGY_AGENT_WALLET || "(not configured)"
    },
    {
      role: "search",
      label: "Fast Search agent",
      address: process.env.FAST_SEARCH_WALLET || "(not configured)"
    },
    {
      role: "copy",
      label: "Copy Pulse agent",
      address: process.env.COPY_AGENT_WALLET || "(not configured)"
    },
    {
      role: "image",
      label: "Visual Frame agent",
      address: process.env.IMAGE_AGENT_WALLET || "(not configured)"
    }
  ];
}

const HERMES_RPC_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.HERMES_RPC_TIMEOUT_MS || 6_000)
);

async function getWalletBalanceDefault() {
  const rpcUrl =
    process.env.ARC_RPC_URL ||
    process.env.NEXT_PUBLIC_ARC_RPC_URL ||
    "https://rpc.testnet.arc.network";
  const address =
    process.env.ORCHESTRATOR_WALLET_ADDRESS || resolveSelfManagedAddress() || null;

  if (!address) {
    return { address: null, balanceUsdc: 0, source: "unconfigured" };
  }

  // Arc Testnet uses USDC as native gas token. Even though the asset is
  // labelled USDC (6-decimal stablecoin), `eth_getBalance` returns the
  // standard EVM 18-decimal wei representation — same convention as ETH
  // on Ethereum. Earlier code divided by 1e6 and reported balances 1e12×
  // too high (e.g. 40 USDC shown as 40 trillion).
  // Hard timeout — without this a hung RPC pins the whole /api/hermes/chat
  // request (Gemini function-call hop) until socket close.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HERMES_RPC_TIMEOUT_MS);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getBalance",
        params: [address, "latest"],
        id: 1
      }),
      signal: controller.signal
    });
    const data = await response.json();
    if (data.error || !data.result) {
      return {
        address,
        balanceUsdc: 0,
        source: "rpc-error",
        error: data.error?.message || "no result"
      };
    }
    const wei = BigInt(data.result);
    // 18-decimal wei → USDC. We use string conversion through formatUnits
    // semantics rather than direct float math so very small balances
    // (sub-µUSDC) don't underflow to 0.
    const usdc = Number(wei) / 1e18;
    return {
      address,
      balanceUsdc: Number(usdc.toFixed(6)),
      network: "eip155:5042002",
      source: "arc-testnet-rpc"
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      address,
      balanceUsdc: 0,
      source: aborted ? "rpc-timeout" : "rpc-fetch-failed",
      error: aborted ? `RPC timeout after ${HERMES_RPC_TIMEOUT_MS}ms` : String(error?.message || error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildArcTxUrlDefault(txHash) {
  const base = process.env.ARC_EXPLORER_TX_BASE || "https://testnet.arcscan.app/tx";
  if (!txHash || !String(txHash).startsWith("0x")) return null;
  return `${base}/${txHash}`;
}

async function buildTierCatalogDefault() {
  return buildAllTierSummaries({ dnaExists: false });
}

function toGeminiMessages(history, userText) {
  const messages = Array.isArray(history)
    ? history
        .filter((m) => ["user", "assistant", "tool"].includes(m.role))
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }))
    : [];
  messages.push({ role: "user", content: userText });
  return messages;
}

/**
 * Run the chat loop. Returns `{ ok, text, transcript, toolCalls }`.
 */
export async function chatWithHermes({ message, history = [] }, overrides = {}) {
  if (!message?.trim()) {
    return { ok: false, reason: "empty-message" };
  }
  if (!hasGeminiKey()) {
    return { ok: false, reason: "no-gemini-key" };
  }

  const deps = {
    db: overrides.db,
    listDnaAssets: overrides.listDnaAssets || (async () => listSkillFiles()),
    getWalletBalance: overrides.getWalletBalance || getWalletBalanceDefault,
    getAgentDirectory: overrides.getAgentDirectory || (async () => getAgentDirectoryDefault()),
    buildArcTxUrl: overrides.buildArcTxUrl || buildArcTxUrlDefault,
    buildTierCatalog: overrides.buildTierCatalog || buildTierCatalogDefault,
    getAgentReputation: overrides.getAgentReputation || (async () => listRegistryAgents()),
    registryMode: overrides.registryMode || registryMode,
    previewBridge: overrides.previewBridge || (async ({ amountUsdc, destinationChainId, destinationAddress }) => {
      // Self-call back into the same backend. Without a timeout a hung Express
      // worker would freeze every Hermes chat indefinitely.
      const port = process.env.PORT || 3001;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bridge/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ amountUsdc, destinationChainId, destinationAddress }),
          signal: controller.signal
        });
        if (!res.ok) {
          return { error: `bridge preview HTTP ${res.status}` };
        }
        return await res.json();
      } catch (error) {
        const reason = error?.name === "AbortError" ? "timeout" : (error?.message || "unknown error");
        return { error: `bridge preview ${reason}` };
      } finally {
        clearTimeout(timer);
      }
    })
  };

  const transcript = toGeminiMessages(history, message);
  const toolCallsMade = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const result = await geminiChat({
      systemPrompt: SYSTEM_PROMPT,
      messages: transcript,
      tools: HERMES_TOOLS,
      toolChoice: iteration === MAX_TOOL_ITERATIONS - 1 ? "none" : "auto",
      maxTokens: 1200,
      temperature: 0.25,
      enableThinking: false
    });

    if (!result.ok) {
      return {
        ok: false,
        reason: `gemini-failed:${result.reason}`,
        errorMessage: result.errorMessage || result.errorBody || null,
        toolCalls: toolCallsMade
      };
    }

    const functionCalls = Array.isArray(result.functionCalls) ? result.functionCalls : [];

    if (functionCalls.length === 0) {
      return {
        ok: true,
        text: result.text || "(no response)",
        model: result.model,
        via: result.via || "native",
        toolCalls: toolCallsMade
      };
    }

    // Execute every tool call Gemini emitted in this turn and append the
    // results to the transcript so the model sees them on the next pass.
    for (const call of functionCalls) {
      let toolResult;
      try {
        toolResult = await dispatchHermesTool(call.name, call.args || {}, deps);
      } catch (error) {
        toolResult = { error: String(error?.message || error) };
      }
      toolCallsMade.push({ name: call.name, args: call.args || {}, result: toolResult });

      transcript.push({
        role: "assistant",
        content: `[tool_call:${call.name}] ${JSON.stringify(call.args || {})}`
      });
      transcript.push({
        role: "user",
        content: `[tool_result:${call.name}] ${JSON.stringify(toolResult).slice(0, 2_500)}`
      });
    }
  }

  // Exhausted iterations — return whatever we have.
  return {
    ok: true,
    text: "Reached tool-call limit; inspect toolCalls for details.",
    toolCalls: toolCallsMade,
    truncated: true
  };
}
