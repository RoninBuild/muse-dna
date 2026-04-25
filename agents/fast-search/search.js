import { aimlChat, hasAimlKey } from "../../shared/aimlapi-client.mjs";
import { resolveSearchRoute } from "../../shared/agent-models.mjs";
import { classifyLlmText } from "../../shared/llm-response-guard.mjs";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

// Simple Brave API circuit breaker — quota / forbidden errors should not
// cause us to hammer Brave for every subsequent call in the same window.
// Rate-limit responses open the circuit for a few minutes so search work
// fails fast and falls back to the LLM-only path, which is the correct
// behaviour when Brave is actually out of quota.
const BRAVE_CIRCUIT_COOLDOWN_MS = 5 * 60_000;
let braveCircuitOpenUntil = 0;
let braveCircuitReason = null;

function braveCircuitOpen() {
  return braveCircuitOpenUntil > Date.now();
}

function tripBraveCircuit(reason) {
  braveCircuitReason = reason;
  braveCircuitOpenUntil = Date.now() + BRAVE_CIRCUIT_COOLDOWN_MS;
  console.warn(
    `[search] Brave API circuit opened for ${BRAVE_CIRCUIT_COOLDOWN_MS / 1000}s — reason: ${reason}`
  );
}

if (!BRAVE_API_KEY && !process.env.AIMLAPI_API_KEY) {
  console.warn(
    "BRAVE_API_KEY and AIMLAPI_API_KEY are both unset — search agent will only return template fallbacks."
  );
}
const REQUEST_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env.AGENT_SEARCH_TIMEOUT_MS || 10_000)
);

function currentYear() {
  return new Date().getFullYear();
}

const SEARCH_QUERIES = {
  "news-query": ({ brandName }) => `${brandName} news ${currentYear()}`,
  "release-scan": ({ brandName }) => `${brandName} product release launch ${currentYear()}`,
  "market-signal": ({ brandName }) => `${brandName} market category trend ${currentYear()}`,
  "operator-quote": ({ brandName }) => `${brandName} customer quote testimonial review`,
  "competitor-signal": ({ brandName }) => `${brandName} vs competitor comparison`,
  "search-summary": ({ brandName }) => `${brandName} overview summary`
};

const SEARCH_INSTRUCTIONS = {
  "news-query": "Summarize the freshest news angle worth using in a campaign.",
  "release-scan": "Summarize whether the brand has recent release or shipping signals.",
  "market-signal": "Summarize the market or category trend that favors this brand.",
  "operator-quote": "Synthesize an operator-friendly proof line in quotable shape (1 sentence).",
  "competitor-signal": "Summarize the key competitive angle this brand should take.",
  "search-summary": "Collapse everything into a single reusable 1-sentence summary."
};

const SEARCH_FALLBACKS = {
  "news-query": ({ brandName }) => ({
    title: `${brandName} keeps shipping while peers slow down`,
    summary: `${brandName} has a fresh narrative hook around speed, visibility, and execution in ${currentYear()}.`
  }),
  "release-scan": ({ brandName }) => ({
    title: `${brandName} release cadence remains active`,
    summary: `${brandName} can be framed around recent release momentum instead of generic future promises.`
  }),
  "market-signal": ({ brandName }) => ({
    title: `${brandName} benefits from the shift toward measurable AI tooling`,
    summary: `The market signal favors tools that tie AI output to concrete workflow outcomes, which fits ${brandName}.`
  }),
  "operator-quote": ({ brandName }) => ({
    title: `${brandName} resonates with operators who want fewer manual handoffs`,
    summary: `Operator language should emphasize cleaner visibility, faster action, and less reporting friction for ${brandName}.`
  }),
  "competitor-signal": ({ brandName }) => ({
    title: `${brandName} can win against bloated suites`,
    summary: `${brandName} should contrast focused execution with broad platforms that create extra process drag.`
  }),
  "search-summary": ({ brandName }) => ({
    title: `${brandName} has enough fresh signal for current-task copy`,
    summary: `Use a live, operator-friendly angle: ${brandName} turns noisy workflow into actionable clarity right now.`
  })
};

async function braveSearch(query) {
  if (!BRAVE_API_KEY) return null;
  if (braveCircuitOpen()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", "3");
    url.searchParams.set("freshness", "pw");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY
      },
      signal: controller.signal
    });

    if (!response.ok) {
      // Auth / quota / forbidden are hard failures — trip the circuit so we
      // stop hitting Brave for the rest of the cooldown window. Transient
      // server errors (5xx) also open the circuit to avoid thrashing.
      if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
        tripBraveCircuit(`http-${response.status}`);
      }
      return null;
    }

    const data = await response.json();
    const results = data.web?.results || [];

    if (results.length === 0) return null;

    const top = results[0];
    const snippets = results
      .slice(0, 3)
      .map((r) => r.description || r.title)
      .filter(Boolean)
      .join(" ");

    return {
      title: top.title || query,
      summary: snippets.slice(0, 600) || top.description || top.title,
      raw: results.slice(0, 3)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refineWithLlm({ brandName, unit, braveResult, tier }) {
  const route = resolveSearchRoute(unit, tier);
  const model = route.model;
  const instruction = SEARCH_INSTRUCTIONS[unit] || SEARCH_INSTRUCTIONS["search-summary"];

  const braveSnippet = braveResult
    ? `Live search snippets:\n${braveResult.summary}`
    : "No live search results available — infer a plausible operator angle from the brand name alone.";

  const result = await aimlChat({
    model,
    systemPrompt:
      "You are a research synthesizer. Produce tight operator-friendly output. " +
      "No markdown, no quotes, no headers. Plain prose only.",
    userPrompt: `Brand: ${brandName}\nUnit: ${unit}\n\n${braveSnippet}\n\nTask: ${instruction}\n\nRespond with strictly two lines:\nTITLE: <short title>\nSUMMARY: <one sentence>`,
    maxTokens: 220,
    temperature: 0.4,
    timeoutMs: REQUEST_TIMEOUT_MS
  });

  if (!result.ok) return null;

  const titleMatch = result.text.match(/TITLE\s*:\s*(.+)/i);
  const summaryMatch = result.text.match(/SUMMARY\s*:\s*([\s\S]+)/i);

  return {
    title: (titleMatch?.[1] || "").trim() || braveResult?.title || `${brandName} signal`,
    summary: (summaryMatch?.[1] || result.text).trim(),
    model: result.model
  };
}

export async function runSearchUnit({ brandName, unit, tier = "deep" }) {
  const queryBuilder = SEARCH_QUERIES[unit];
  const fallbackBuilder = SEARCH_FALLBACKS[unit];

  if (!fallbackBuilder) {
    throw new Error(`Unsupported search unit: ${unit}`);
  }

  const fallback = fallbackBuilder({ brandName });
  const braveResult = queryBuilder
    ? await braveSearch(queryBuilder({ brandName })).catch(() => null)
    : null;

  if (hasAimlKey()) {
    const refined = await refineWithLlm({ brandName, unit, braveResult, tier }).catch(() => null);
    // Require the synthesiser to actually say something useful — empty or
    // refusal outputs should fall through to the Brave raw signal or the
    // template rather than shipping "I cannot help" as paid research.
    if (refined && classifyLlmText(refined.summary, { minChars: 12 }).ok) {
      return {
        title: refined.title,
        summary: refined.summary,
        unit,
        source: braveResult ? "brave+aimlapi" : "aimlapi",
        model: refined.model,
        tier
      };
    }
  }

  if (braveResult) {
    // Apply the same content-quality guard as the LLM path: a Brave snippet
    // that says "no results" or is empty should not be billed as paid search
    // signal. Fall through to the deterministic template when the summary
    // is too thin or looks like a refusal.
    if (classifyLlmText(braveResult.summary, { minChars: 12 }).ok) {
      return {
        title: braveResult.title,
        summary: braveResult.summary,
        unit,
        source: "brave",
        tier
      };
    }
  }

  return { ...fallback, unit, source: "template", tier, isTemplate: true };
}
