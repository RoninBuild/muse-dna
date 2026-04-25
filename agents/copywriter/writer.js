import { aimlChat, hasAimlKey } from "../../shared/aimlapi-client.mjs";
import { featherlessChat, hasFeatherlessKey } from "../../shared/featherless-client.mjs";
import { resolveCopyRoute } from "../../shared/agent-models.mjs";
import { classifyLlmText } from "../../shared/llm-response-guard.mjs";

// Trim env value — a trailing newline / space (common when env is pasted
// from a doc) makes URL construction throw inside `fetch`, the catch
// silently returns null, and the LLM cascade falls through to template
// without ever attempting the Hermes daemon.
const HERMES_URL = (process.env.HERMES_URL || "http://localhost:8642").trim().replace(/\/+$/, "");
const HERMES_MODEL = process.env.HERMES_MODEL || "openrouter/nous/hermes-3";
// Kept under ~8s each so that the full fallback chain
// (Featherless → AIMLAPI → Hermes → template) still fits inside the
// orchestrator's 30s x402 budget with margin. Previously 12s × 3 = 36s
// and the orchestrator aborted before the chain had a chance to return.
const REQUEST_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env.AGENT_LLM_TIMEOUT_MS || 8_000)
);

function detectBrand(dnaContent, prompt, brandName) {
  if (brandName) {
    return brandName;
  }

  const dnaHeading = String(dnaContent || "").match(/^#\s+(.+?)\s+Brand DNA/im);
  if (dnaHeading?.[1]) {
    return dnaHeading[1].trim();
  }

  const promptBrand = String(prompt || "").match(/["'«»"](.+?)["'«»"]/u);
  if (promptBrand?.[1]) {
    return promptBrand[1].trim();
  }

  return "the brand";
}

const COPY_INSTRUCTIONS = {
  headline: "Write a concise, punchy headline (max 12 words) for this brand's campaign.",
  "hook-line": "Write the opening hook sentence that grabs attention immediately.",
  "pain-turn": "Name the key pain point in crisp operator language (1-2 sentences).",
  "benefit-stack": "List 2-3 concrete practical benefits in short punchy sentences.",
  "proof-line": "Write a credibility/proof line that backs up the benefit claims.",
  "cta-line": "Write a clear, action-oriented call to action (1 sentence).",
  "channel-format": "Write the format guidance for the target channel (1-2 sentences).",
  "voice-seed": "Create a reusable voice definition for this brand (2-3 sentences describing tone and personality).",
  "usp-seed": "Create a reusable USP definition (2-3 sentences on what makes this brand uniquely valuable).",
  "final-copy": "Write the complete final copy block for the campaign, combining headline, hook, pain, benefits, proof, and CTA."
};

const COPY_TEMPLATES = {
  headline: ({ brandName }) => `${brandName} prices creative execution one action at a time`,
  "hook-line": ({ voice }) => voice.newsAngle,
  "pain-turn": () => "Teams still overpay for repeated setup, generic creative, and bloated review loops.",
  "benefit-stack": () => "Hermes keeps the brand memory. Arc settles the value flow. Every next run gets lighter.",
  "proof-line": () => "You can point to the ledger, count the micro-checks, and show exactly what got cheaper.",
  "cta-line": () => "Run the next task and watch the investment turn into dividends.",
  "channel-format": ({ taskType }) => taskType === "email_campaign"
    ? "Use a subject line, body block, and clear CTA."
    : "Use short high-signal blocks that read well in a live demo.",
  "voice-seed": ({ brandName }) => `${brandName} should always sound like a calm operator who knows where the economics live.`,
  "usp-seed": ({ brandName }) => `${brandName} wins by making reusable strategic context reduce future paid calls.`,
  "final-copy-email": ({ brandName, voice }) =>
    `Subject: ${brandName} now turns every creative action into a micro-settlement\n\n${voice.newsAngle}\n\nTeams do not need more generic output. They need execution that keeps the brand context intact, charges only for actual usage, and gets cheaper once Hermes has learned the business.\n\nThat is the loop: pay once for the strategic memory, then let Arc + USDC handle the high-frequency execution path.\n\nRun the next campaign and compare the ledger side by side.`,
  "final-copy-default": ({ brandName, voice }) =>
    `${brandName} turns creative work into a stream of USDC micro-checks.\n\n${voice.newsAngle}\n\nNo bloated subscription story. No hidden economics. Hermes remembers the brand, Arc settles the action, and every repeat task gets lighter.\n\nWatch the ledger. Count the transactions. See the second run get cheaper.\n\n#Arc #USDC #Nous`
};

function createCommonVoice({ brandName, newsContext }) {
  return {
    brandName,
    newsAngle: newsContext || `${brandName} is moving with live operator signal instead of generic AI hype.`
  };
}

function getTemplateFallback(unit, { brandName, voice, taskType }) {
  if (unit === "final-copy") {
    return taskType === "email_campaign"
      ? COPY_TEMPLATES["final-copy-email"]({ brandName, voice })
      : COPY_TEMPLATES["final-copy-default"]({ brandName, voice });
  }

  const template = COPY_TEMPLATES[unit];
  if (!template) return null;
  return template({ brandName, voice, taskType });
}

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
        max_tokens: 500,
        temperature: 0.4
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
    if (result.ok) return { ...result, provider: "featherless" };
    console.warn(`Copy via Featherless (${route.model}) failed: ${result.reason}; falling back to AIMLAPI`);
  }

  if (hasAimlKey()) {
    // When we arrive here after a Featherless failure, route.model may be a
    // Featherless-specific ID that AIMLAPI does not host. Substitute a safe
    // AIMLAPI default in that case so the request still succeeds.
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
    if (result.ok) return { ...result, provider: "aimlapi" };
    console.warn(`Copy via AIMLAPI (${aimlModel}) failed: ${result.reason}`);
  }

  return null;
}

export async function runCopyUnit(input) {
  const brandName = detectBrand(input.dnaContent, input.prompt, input.brandName);
  const tier = input.tier || "deep";
  const orchestratorBrief = String(input.orchestratorBrief || "").trim();
  const voice = createCommonVoice({
    brandName,
    newsContext: input.newsContext
  });

  const instruction = COPY_INSTRUCTIONS[input.unit];
  const fallback = getTemplateFallback(input.unit, {
    brandName,
    voice,
    taskType: input.taskType
  });

  if (!fallback && !instruction) {
    throw new Error(`Unsupported copy unit: ${input.unit}`);
  }

  if (!instruction) {
    return { text: fallback, unit: input.unit, brandName, source: "template", tier };
  }

  const dnaContext = input.dnaContent
    ? `\nBrand DNA (excerpt):\n${String(input.dnaContent).slice(0, 900)}`
    : "";
  const newsBlock = input.newsContext
    ? `\nRecent signal: ${String(input.newsContext).slice(0, 400)}`
    : "";

  const systemPrompt =
    "You are a senior direct-response copywriter. Write clean, punchy copy. " +
    "No headers, no markdown, no emoji. Plain text only.";
  const briefBlock = orchestratorBrief ? `\nOrchestrator brief: ${orchestratorBrief}` : "";
  const userPrompt = `Brand: ${brandName}\nTask type: ${input.taskType}\nPrompt: ${String(input.prompt || "").slice(0, 240)}${dnaContext}${newsBlock}${briefBlock}\n\nTask: ${instruction}`;
  const route = resolveCopyRoute(input.unit, tier);
  const maxTokens = input.unit === "final-copy" ? 700 : 320;

  const llmResult = await runViaRoute({
    route,
    systemPrompt,
    userPrompt,
    maxTokens,
    temperature: 0.45
  });

  // Copy has stricter minimums than strategy — a headline still needs to
  // read as a sentence, not as "ok" or a refusal. final-copy must have at
  // least two newlines (headline + body) or we fall back to the template.
  const minChars = input.unit === "final-copy" ? 60 : 16;
  const isFinalCopyTruncated = (text) =>
    input.unit === "final-copy" && String(text || "").split(/\n+/).filter(Boolean).length < 2;

  if (
    llmResult &&
    classifyLlmText(llmResult.text, { minChars }).ok &&
    !isFinalCopyTruncated(llmResult.text)
  ) {
    return {
      text: llmResult.text,
      unit: input.unit,
      brandName,
      source: llmResult.provider,
      model: llmResult.model,
      tier
    };
  }

  const hermesResult = await callHermesFallback(systemPrompt, userPrompt);
  if (
    hermesResult &&
    classifyLlmText(hermesResult, { minChars }).ok &&
    !isFinalCopyTruncated(hermesResult)
  ) {
    return { text: hermesResult, unit: input.unit, brandName, source: "hermes", tier };
  }

  return {
    text: fallback || `${brandName}: ${instruction}`,
    unit: input.unit,
    brandName,
    source: "template",
    tier
  };
}
