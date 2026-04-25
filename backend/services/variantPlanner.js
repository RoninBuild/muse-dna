/**
 * Gemini-powered variant planner.
 *
 * Given the user's prompt + task type + whether Hermes already has DNA for
 * the brand, this module produces the three execution variants (LITE /
 * BALANCED / DEEP) the UI shows the user. Gemini's Function Calling decides
 * the recommended tier and attaches a human-readable narrative per variant.
 *
 * Function Calling is the piece that qualifies the project for the Gemini
 * hackathon track — Gemini does NOT just chat, it calls tools that map
 * directly to real orchestration code paths.
 *
 * Fallback: if Gemini is unavailable, the planner returns three deterministic
 * variants so the product never blocks.
 */

import { geminiChat, geminiJson, hasGeminiKey } from "../../shared/gemini-client.mjs";
import {
  TIER_KEYS,
  buildAllTierSummaries,
  buildTierPlan,
  getTierMeta,
  computeAgentWorkerCount
} from "./microeconomy.js";
import { extractBrandName } from "./hermes.js";

const PLAN_TOOL_DECLARATIONS = [
  {
    name: "propose_variant_plan",
    description:
      "Commit the three execution variants (LITE / BALANCED / DEEP) for the current task. " +
      "Each variant describes what sub-agents run, expected copy flavor, and why the tier fits the task.",
    parameters: {
      type: "OBJECT",
      properties: {
        brand_name: {
          type: "STRING",
          description: "Canonical brand name extracted from the prompt."
        },
        recommended_tier: {
          type: "STRING",
          enum: ["lite", "balanced", "deep"],
          description:
            "Tier that best matches the user's task budget and desired depth. Bias toward BALANCED for standard tasks."
        },
        rationale: {
          type: "STRING",
          description:
            "One or two sentences explaining the recommendation referencing the task type and prompt."
        },
        variants: {
          type: "ARRAY",
          description: "Exactly three variants in order: lite, balanced, deep.",
          items: {
            type: "OBJECT",
            properties: {
              tier: { type: "STRING", enum: ["lite", "balanced", "deep"] },
              headline: {
                type: "STRING",
                description: "Punchy one-liner describing what this tier delivers for this specific task."
              },
              narrative: {
                type: "STRING",
                description: "Two sentence pitch explaining what the user gets and what the sub-agents focus on."
              },
              dna_focus: {
                type: "ARRAY",
                items: { type: "STRING" },
                description: "Short list (2-5 items) naming the DNA facets this tier will invest into."
              },
              risk_note: {
                type: "STRING",
                description: "Single sentence on what the tier sacrifices or which tasks it fits badly."
              }
            },
            required: ["tier", "headline", "narrative"]
          }
        }
      },
      required: ["brand_name", "recommended_tier", "variants"]
    }
  }
];

/**
 * Reject obviously-bad brand names before they reach the UI:
 *  - private-key-shaped strings (prompt-injection bait: users can paste a
 *    64-hex and the planner will faithfully echo it as the brand; not a
 *    server-side leak, but looks alarming in screenshots)
 *  - bare EVM addresses (similar)
 *  - excessive length, all-symbol garbage, or refusal artefacts
 * Returns null when the value should be replaced by the deterministic
 * extractBrandName fallback.
 */
function sanitizeBrandName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // hex-dump heuristic: > 20 chars AND > 60% hex AND starts with 0x
  if (/^0x[0-9a-fA-F]{30,}/.test(trimmed)) return null;
  if (trimmed.length > 80) return null;
  if (/^[^\p{L}\p{N}]+$/u.test(trimmed)) return null;
  // Reject strings that look like raw env var names (whole-word only)
  // instead of any substring match. "Secrets Division" / "Muse Inc." are
  // legitimate brand fragments; we only block literal env tokens.
  if (/\b(ORCHESTRATOR_PRIVATE_KEY|MUSE_[A-Z]+(_[A-Z]+)*_KEY)\b/.test(trimmed)) return null;
  if (/^\s*SECRET\s*$/i.test(trimmed)) return null;
  return trimmed;
}

function deterministicVariantCopy(tierKey) {
  const meta = getTierMeta(tierKey);
  switch (tierKey) {
    case "lite":
      return {
        headline: `${meta.label} — minimum viable brand pulse`,
        narrative:
          "Six-part DNA skeleton, essential search signal, four punchy copy units and a single hero banner.",
        dna_focus: ["promise", "primary audience", "voice", "messaging pillars"],
        risk_note: "Thin coverage of competitors, objections and visual system — not enough for long-term reuse."
      };
    case "balanced":
      return {
        headline: `${meta.label} — operator-ready campaign DNA`,
        narrative:
          "Broad strategy sweep covering positioning, audience and voice, plus a full creative pipeline with composition and render style decisions.",
        dna_focus: ["positioning", "pains", "voice", "content angles", "visual guardrails"],
        risk_note: "Skips dividend seeds (voice-seed, usp-seed, brand guard) so the next run still pays for some investment."
      };
    case "deep":
    default:
      return {
        headline: `${meta.label} — full Hermes DNA investment`,
        narrative:
          "Every strategy block, every creative unit, and all dividend seeds so every future campaign on this brand becomes a reuse run.",
        dna_focus: ["full positioning", "audience map", "voice seed", "USP seed", "visual language", "brand guard"],
        risk_note: "Highest upfront spend — only pick if you expect more than one campaign for this brand."
      };
  }
}

function buildFallbackPlan({ prompt, dnaExists, taskType = "" }) {
  const brandName = extractBrandName(prompt);
  const summaries = buildAllTierSummaries({ dnaExists });
  return {
    brand_name: brandName,
    dna_exists: dnaExists,
    recommended_tier: dnaExists ? "lite" : "balanced",
    rationale: dnaExists
      ? "Hermes already holds DNA for this brand, so a LITE dividend run captures the delta signal cheapest."
      : "BALANCED gives enough DNA coverage for reuse without burning budget on dividend seeds.",
    variants: summaries.map((summary) => {
      const plan = buildTierPlan({ tier: summary.tier, dnaExists });
      const agents = computeAgentWorkerCount({
        microPlan: plan.micro_plan,
        tier: summary.tier,
        prompt,
        taskType
      });
      return {
        ...summary,
        ...deterministicVariantCopy(summary.tier),
        plan,
        agents: agents.total,
        agents_per_service: agents.perService
      };
    }),
    source: "deterministic"
  };
}

function mergeVariantsWithPlans(geminiVariants, { dnaExists, prompt = "", taskType = "" }) {
  const summaries = buildAllTierSummaries({ dnaExists });
  // Reject any Gemini-supplied variant whose tier is not one of our known
  // keys. Without this guard, a hallucinated tier like "ultra" flowed into
  // the downstream map lookup below and broke the rendered variant set.
  const geminiByTier = new Map(
    (geminiVariants || [])
      .filter((v) => v && typeof v.tier === "string" && TIER_KEYS.includes(v.tier.toLowerCase()))
      .map((v) => [v.tier.toLowerCase(), v])
  );

  return summaries.map((summary) => {
    const plan = buildTierPlan({ tier: summary.tier, dnaExists });
    const gemini = geminiByTier.get(summary.tier);
    const baseline = deterministicVariantCopy(summary.tier);
    const agentCount = computeAgentWorkerCount({
      microPlan: plan.micro_plan,
      tier: summary.tier,
      prompt,
      taskType
    });
    return {
      ...summary,
      // Defensive coercion — Gemini occasionally returns a field with
      // `null` instead of omitting it, or an array shape we don't expect.
      // `?.trim?.()` guards against TypeError when the value is non-string.
      headline: (typeof gemini?.headline === "string" ? gemini.headline.trim() : "") || baseline.headline,
      narrative: (typeof gemini?.narrative === "string" ? gemini.narrative.trim() : "") || baseline.narrative,
      dna_focus:
        Array.isArray(gemini?.dna_focus) && gemini.dna_focus.length > 0
          ? gemini.dna_focus.filter((s) => typeof s === "string").slice(0, 6)
          : baseline.dna_focus,
      risk_note: (typeof gemini?.risk_note === "string" ? gemini.risk_note.trim() : "") || baseline.risk_note,
      plan,
      agents: agentCount.total,
      agents_per_service: agentCount.perService
    };
  });
}

/**
 * Produce the three variants to show the user.
 */
export async function planVariants({ prompt, taskType, dnaExists = false }) {
  // Orchestrator forces dnaExists=false at runtime when
  // MUSE_DISABLE_DNA_REUSE is on (hackathon requirement: every unit pays
  // on-chain, no reuse). Mirror the same override here so the variant
  // card's AGENTS count matches the wallets we'll actually deploy.
  const disableReuse = (process.env.MUSE_DISABLE_DNA_REUSE || "true") !== "false";
  if (disableReuse) dnaExists = false;
  const fallback = buildFallbackPlan({ prompt, dnaExists, taskType });

  if (!hasGeminiKey()) {
    return { ...fallback, source: "no-gemini-key" };
  }

  const systemPrompt =
    "You are Hermes — the reasoning brain of the Muse DNA agent swarm. " +
    "You plan creative campaigns by spawning specialized sub-agents that each pay a micro-cost per action. " +
    "For each task, you MUST emit exactly three variants (LITE, BALANCED, DEEP) by calling the propose_variant_plan function. " +
    "Do NOT respond with free text — always emit the tool call.";
  const userPrompt =
    `Task type: ${taskType || "unspecified"}\n` +
    `Hermes DNA already exists for this brand: ${dnaExists ? "yes" : "no"}\n` +
    `Prompt:\n"""${String(prompt || "").slice(0, 1800)}"""\n\n` +
    `Produce three tier variants (lite, balanced, deep). Each variant gets a crisp headline, a two-sentence narrative explaining what the sub-agents will build, 2-5 DNA facets they will invest into, and one risk_note.`;

  // thinkingBudget was 6144 which routinely pushed the native Gemini call
  // past 40s and forced an AIMLAPI fallback (another ~30s). Dropping to 2048
  // keeps variant quality (3-card plan is simple) while cutting the happy
  // path to ~10-15s. Operators can raise via env if needed.
  const thinkingBudget = Math.max(512, Number(process.env.VARIANT_THINKING_BUDGET || 2048));
  const toolResult = await geminiChat({
    systemPrompt,
    userPrompt,
    tools: PLAN_TOOL_DECLARATIONS,
    toolChoice: "any",
    maxTokens: 1800,
    temperature: 0.4,
    enableThinking: true,
    thinkingBudget
  });

  let args = toolResult.ok
    ? toolResult.functionCalls?.find((c) => c.name === "propose_variant_plan")?.args
    : null;
  let via = args ? "function-call" : null;
  let transport = toolResult.via === "aimlapi-fallback" ? "aimlapi" : "native";
  let resolvedModel = toolResult.model || null;
  let lastError = toolResult.ok ? null : (toolResult.errorMessage || toolResult.errorBody || toolResult.reason);

  // Second chance — most proxied routes (AIMLAPI, Vertex) drop function
  // calling or return empty responses when Gemini tries to emit a function
  // call through a plain OpenAI-compatible pipe. Ask for JSON directly.
  if (!args) {
    const jsonSystem =
      "You are Hermes — the reasoning brain of the Muse DNA agent swarm. " +
      "You plan campaigns by spawning specialized sub-agents priced per action. " +
      "Return ONLY a JSON object with this exact shape (no prose, no markdown fences): " +
      '{"brand_name": "<string>", "recommended_tier": "lite|balanced|deep", "rationale": "<short string>", "variants": [{"tier": "lite", "headline": "<string>", "narrative": "<string>", "dna_focus": ["<item>"], "risk_note": "<string>"}, {"tier": "balanced", "headline": "...", "narrative": "...", "dna_focus": [], "risk_note": "..."}, {"tier": "deep", "headline": "...", "narrative": "...", "dna_focus": [], "risk_note": "..."}]}';
    const jsonResult = await geminiJson({
      systemPrompt: jsonSystem,
      userPrompt,
      maxTokens: 3200,
      temperature: 0.35,
      enableThinking: false
    });
    if (jsonResult.ok && jsonResult.json) {
      args = jsonResult.json;
      via = "json-mode";
      transport = jsonResult.via === "aimlapi-fallback" ? "aimlapi" : "native";
      resolvedModel = jsonResult.model || resolvedModel;
      lastError = null;
    } else if (jsonResult.reason === "json-parse-failed" && jsonResult.rawText) {
      lastError = `json-parse-failed: raw=${String(jsonResult.rawText).slice(0, 500)}`;
    } else {
      lastError = jsonResult.errorMessage || jsonResult.reason || "unknown";
    }
  }

  if (!args) {
    return {
      ...fallback,
      source: "gemini-unreachable",
      gemini_error: lastError
    };
  }
  const variants = mergeVariantsWithPlans(args.variants, { dnaExists, prompt, taskType });
  const recommendedTier = TIER_KEYS.includes(String(args.recommended_tier || "").toLowerCase())
    ? String(args.recommended_tier).toLowerCase()
    : fallback.recommended_tier;

  return {
    brand_name: sanitizeBrandName(args.brand_name) || fallback.brand_name,
    dna_exists: dnaExists,
    recommended_tier: recommendedTier,
    rationale: args.rationale || fallback.rationale,
    variants,
    source: `gemini-${transport}-${via}`,
    model: resolvedModel,
    via: transport
  };
}

export const __TEST__ = { buildFallbackPlan, mergeVariantsWithPlans, deterministicVariantCopy };
