import { aimlChat, hasAimlKey } from "../../shared/aimlapi-client.mjs";
import { featherlessChat, hasFeatherlessKey } from "../../shared/featherless-client.mjs";
import { resolveStrategyRoute } from "../../shared/agent-models.mjs";
import { classifyLlmText } from "../../shared/llm-response-guard.mjs";

// Trim env value — a trailing newline / space (common when env is pasted
// from a doc) makes URL construction throw inside `fetch`, the catch
// silently returns null, and the LLM cascade falls through to template
// without ever attempting the Hermes daemon.
const HERMES_URL = (process.env.HERMES_URL || "http://localhost:8642").trim().replace(/\/+$/, "");
const HERMES_MODEL = process.env.HERMES_MODEL || "openrouter/nous/hermes-3";
const REQUEST_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env.AGENT_LLM_TIMEOUT_MS || 12_000)
);

function shortenPrompt(prompt) {
  return String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

// Some template builders interpolate `${shortenPrompt(prompt)}` directly into
// a sentence. When the buyer skipped the prompt (or sent a whitespace-only
// one) the result was a stilted "...built around: ." with a trailing period
// and no content. The template-builders below now use this guarded variant
// so we always end up with a coherent fallback sentence even on empty input.
function promptOrFallback(prompt, fallback = "this brand's commercial flow") {
  const cleaned = shortenPrompt(prompt);
  return cleaned || fallback;
}

const STRATEGY_INSTRUCTIONS = {
  "product-summary": "Extract the cleanest one-sentence product summary for the given brand.",
  "product-surface": "List the feature layer that matters commercially (1-3 sentences).",
  "problem-statement": "Define the pain the product removes in one sentence.",
  "promise-core": "Write the core brand promise in one sentence.",
  "usp-proof": "Capture the single differentiating proof point (1-2 sentences).",
  "category-frame": "Frame the category narrative this brand should own (1-2 sentences).",
  "audience-primary": "Define the primary buyer persona in 1-2 sentences.",
  "audience-secondary": "Define the secondary audience in 1-2 sentences.",
  "audience-pains": "List 2-4 daily pain points the audience experiences, in a short sentence each.",
  "audience-motivations": "List 2-4 things the audience wants to unlock.",
  "buyer-triggers": "Describe what makes the buyer act now (1-2 sentences).",
  "objections": "Write the 2-3 core objections the message must answer.",
  "proof-points": "Extract 2-3 proof, credibility, and trust signals.",
  "competitors-direct": "List 2-4 direct competitors or substitutes.",
  "competitors-alt": "List 2-4 adjacent alternatives buyers compare against.",
  "competitor-gap": "Describe the white-space the brand can claim (1-2 sentences).",
  "voice-pillars": "Define 3 voice pillars for this brand.",
  "tone-dos": "List 3 things the tone should do.",
  "tone-donts": "List 3 things the tone must avoid.",
  "keywords-core": "Extract 4-6 keywords the brand should sound fluent in.",
  "messaging-pillars": "Define 3 messaging pillars.",
  "content-angles": "List 3 repeatable content angles.",
  "cta-style": "Define how the brand should ask for action (1-2 sentences).",
  "visual-guardrails": "Describe 2-3 visual boundaries for future assets."
};

const STRATEGY_TEMPLATES = {
  "product-summary": ({ brandName, prompt }) => `${brandName} is a focused commercial system built around: ${promptOrFallback(prompt)}.`,
  "product-surface": ({ brandName }) => `${brandName} packages AI assistance into a workflow operators can actually adopt quickly.`,
  "problem-statement": ({ brandName }) => `${brandName} removes reporting drag, fragmented context, and slow decision loops.`,
  "promise-core": ({ brandName }) => `${brandName} helps teams move from scattered signals to clear action without extra coordination cost.`,
  "usp-proof": ({ brandName }) => `${brandName} turns brand context into reusable execution logic instead of paying to rediscover it every run.`,
  "category-frame": ({ brandName }) => `${brandName} should be framed as an operating system layer for teams that need higher-frequency output.`,
  "audience-primary": ({ brandName }) => `Primary buyer: leaders responsible for revenue, pipeline visibility, or execution quality inside ${brandName}'s category.`,
  "audience-secondary": () => "Secondary audience: operators, analysts, and creators who need faster review and cleaner handoff.",
  "audience-pains": () => "Pain points: scattered tooling, generic creative, slow approvals, weak proof, and expensive iteration.",
  "audience-motivations": () => "Motivations: faster execution, more confidence, lower waste, and outputs that feel informed instead of improvised.",
  "buyer-triggers": () => "Triggers: launch moments, release cycles, pipeline pressure, or the need to show measurable progress quickly.",
  objections: () => "Objections: unclear differentiation, AI hype without proof, and fear that automation creates more review work.",
  "proof-points": () => "Proof points: visible ledger activity, reusable memory, and measurable drop in repeated paid setup work.",
  "competitors-direct": ({ brandName }) => `${brandName} competes with broad suites that bundle workflow, CRM, or content automation.`,
  "competitors-alt": () => "Alternatives include manual agency work, fragmented SaaS stacks, generic AI tools, and spreadsheet-heavy ops.",
  "competitor-gap": ({ brandName }) => `${brandName} can own the space between strategic memory and execution-level economic proof.`,
  "voice-pillars": () => "Voice pillars: precise, operator-friendly, commercially literate, and quietly confident.",
  "tone-dos": () => "Tone dos: sound decisive, useful, grounded, and specific about outcomes.",
  "tone-donts": () => "Tone donts: avoid hype, vague futurism, and abstract claims detached from workflows.",
  "keywords-core": () => "Keywords: live visibility, execution, reusable memory, operator signal, programmable value, and micro-settlement.",
  "messaging-pillars": () => "Messaging pillars: faster action, lower waste, consistent outputs, and value priced by actual usage.",
  "content-angles": () => "Content angles: from investment to dividend, sub-cent actions, agentic commerce, and memory-backed execution.",
  "cta-style": () => "CTA style: invite the audience to watch, compare, or validate the economics directly.",
  "visual-guardrails": () => "Visual guardrails: premium dark surfaces, clean hierarchy, restrained glow, and no generic dashboard clutter."
};

async function callHermesFallback(systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${HERMES_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: HERMES_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 300,
        temperature: 0.3
      }),
      signal: controller.signal
    });

    if (!response.ok) return null;
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    return content?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runViaRoute({ route, systemPrompt, userPrompt, maxTokens, temperature }) {
  if (route.provider === "featherless" && hasFeatherlessKey()) {
    const result = await featherlessChat({
      model: route.model,
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature,
      timeoutMs: REQUEST_TIMEOUT_MS
    });
    if (result.ok) {
      return { ...result, provider: "featherless" };
    }
    console.warn(`Featherless (${route.model}) failed: ${result.reason}; falling back to AIMLAPI`);
  }

  if (hasAimlKey()) {
    // Featherless model IDs aren't hosted by AIMLAPI; substitute a safe
    // default when falling back after a Featherless failure.
    const aimlModel =
      route.provider === "featherless"
        ? "meta-llama/Llama-3.3-70B-Instruct-Turbo"
        : route.model;
    const result = await aimlChat({
      model: aimlModel,
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature,
      timeoutMs: REQUEST_TIMEOUT_MS
    });
    if (result.ok) {
      return { ...result, provider: "aimlapi" };
    }
    console.warn(`AIMLAPI (${aimlModel}) failed: ${result.reason}`);
  }

  return null;
}

export async function runStrategyUnit({ brandName, prompt, unit, tier = "deep", orchestratorBrief = "" }) {
  const instruction = STRATEGY_INSTRUCTIONS[unit];
  const template = STRATEGY_TEMPLATES[unit];

  if (!template) {
    throw new Error(`Unsupported strategy unit: ${unit}`);
  }

  const fallback = template({ brandName, prompt });

  if (!instruction) {
    return { text: fallback, unit, brandName, source: "template" };
  }

  const systemPrompt =
    "You are a senior brand strategist. Respond with 1-3 concise sentences. " +
    "No headers, no bullet formatting, no markdown. Plain prose only.";
  const briefBlock = orchestratorBrief ? `\nOrchestrator brief: ${orchestratorBrief}` : "";
  const userPrompt = `Brand: ${brandName}\nPrompt: ${shortenPrompt(prompt)}${briefBlock}\n\nTask: ${instruction}`;
  const route = resolveStrategyRoute(unit, tier);

  const llmResult = await runViaRoute({
    route,
    systemPrompt,
    userPrompt,
    maxTokens: 260,
    temperature: 0.3
  });

  // Reject empty / refusal / too-short outputs so the buyer is not paying for
  // "As an AI language model…" or a single-character reply. Keeps going down
  // the fallback chain (Hermes → deterministic template) instead of tagging
  // the response as live LLM output.
  if (llmResult && classifyLlmText(llmResult.text, { minChars: 20 }).ok) {
    return {
      text: llmResult.text,
      unit,
      brandName,
      source: llmResult.provider,
      model: llmResult.model,
      tier
    };
  }

  const hermesResult = await callHermesFallback(systemPrompt, userPrompt);
  if (hermesResult && classifyLlmText(hermesResult, { minChars: 20 }).ok) {
    return { text: hermesResult, unit, brandName, source: "hermes", tier };
  }

  return { text: fallback, unit, brandName, source: "template", tier };
}
