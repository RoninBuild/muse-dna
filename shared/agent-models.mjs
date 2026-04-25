/**
 * Per-unit, per-tier model routing for Muse sub-agents.
 *
 * The hackathon brief requires different models for different sub-agents.
 * Each tier (LITE / BALANCED / DEEP) routes the same unit to a different
 * model — that's how "10 agents" expands into "30 specialized sub-agents"
 * across tiers without duplicating process boundaries.
 *
 * Provider codes:
 *   aimlapi     — default, all-purpose (routes through AIMLAPI catalog).
 *   featherless — Featherless track qualifier, used for specific units.
 *
 * Routing rules:
 *   LITE     → cheap fast models (mini, haiku, qwen).
 *   BALANCED → mixed tier (gpt-4o, sonnet, llama-70b).
 *   DEEP     → premium tier plus Featherless where it makes sense.
 */

const LITE = "lite";
const BALANCED = "balanced";
const DEEP = "deep";

function tierKey(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === LITE || normalized === BALANCED || normalized === DEEP) {
    return normalized;
  }
  return DEEP;
}

export const STRATEGY_UNIT_MODELS = {
  "product-summary":      { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o" }, deep: { provider: "aimlapi", model: "gpt-4o" } },
  "product-surface":      { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o" } },
  "problem-statement":    { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  "promise-core":         { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  "usp-proof":            { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  "category-frame":       { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  "audience-primary":     { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }, deep: { provider: "featherless", model: "meta-llama/Meta-Llama-3.1-70B-Instruct" } },
  "audience-secondary":   { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }, deep: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" } },
  "audience-pains":       { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }, deep: { provider: "featherless", model: "meta-llama/Meta-Llama-3.1-70B-Instruct" } },
  "audience-motivations": { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }, deep: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" } },
  "buyer-triggers":       { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "deepseek-chat" }, deep: { provider: "aimlapi", model: "deepseek-chat" } },
  objections:             { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "deepseek-chat" }, deep: { provider: "aimlapi", model: "deepseek-chat" } },
  "proof-points":         { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "alibaba/qwen3-32b" }, deep: { provider: "aimlapi", model: "alibaba/qwen3-32b" } },
  "competitors-direct":   { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "alibaba/qwen3-32b" }, deep: { provider: "aimlapi", model: "alibaba/qwen3-32b" } },
  "competitors-alt":      { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "alibaba/qwen-max" }, deep: { provider: "aimlapi", model: "alibaba/qwen-max" } },
  "competitor-gap":       { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "alibaba/qwen3-32b" }, deep: { provider: "aimlapi", model: "alibaba/qwen3-32b" } },
  "voice-pillars":        { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o" }, deep: { provider: "aimlapi", model: "gpt-4o" } },
  "tone-dos":             { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "tone-donts":           { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "keywords-core":        { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "messaging-pillars":    { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  "content-angles":       { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }, deep: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" } },
  "cta-style":            { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "visual-guardrails":    { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } }
};

export const COPY_UNIT_MODELS = {
  headline:        { lite: { provider: "aimlapi", model: "gpt-4o-mini" },    balanced: { provider: "aimlapi", model: "gpt-4o" },    deep: { provider: "aimlapi", model: "gpt-4o" } },
  "hook-line":     { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  "pain-turn":     { lite: { provider: "aimlapi", model: "gpt-4o-mini" },    balanced: { provider: "aimlapi", model: "deepseek-chat" }, deep: { provider: "aimlapi", model: "deepseek-chat" } },
  "benefit-stack": { lite: { provider: "aimlapi", model: "gpt-4o-mini" },    balanced: { provider: "aimlapi", model: "gpt-4o" },    deep: { provider: "aimlapi", model: "gpt-4o" } },
  "proof-line":    { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, deep: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" } },
  "cta-line":      { lite: { provider: "aimlapi", model: "gpt-4o-mini" },    balanced: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }, deep: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" } },
  "channel-format":{ lite: { provider: "aimlapi", model: "gpt-4o-mini" },    balanced: { provider: "aimlapi", model: "alibaba/qwen3-32b" }, deep: { provider: "aimlapi", model: "alibaba/qwen3-32b" } },
  "final-copy":    { lite: { provider: "aimlapi", model: "gpt-4o-mini" },    balanced: { provider: "featherless", model: "meta-llama/Meta-Llama-3.1-70B-Instruct" }, deep: { provider: "featherless", model: "meta-llama/Meta-Llama-3.1-70B-Instruct" } },
  "voice-seed":    { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  "usp-seed":      { lite: { provider: "aimlapi", model: "gpt-4o-mini" },    balanced: { provider: "aimlapi", model: "gpt-4o" },    deep: { provider: "aimlapi", model: "gpt-4o" } }
};

export const SEARCH_UNIT_MODELS = {
  "news-query":        { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "release-scan":      { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "market-signal":     { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  "operator-quote":    { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }, deep: { provider: "aimlapi", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" } },
  "competitor-signal": { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "deepseek-chat" }, deep: { provider: "aimlapi", model: "deepseek-chat" } },
  "search-summary":    { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o" }, deep: { provider: "aimlapi", model: "gpt-4o" } }
};

export const IMAGE_UNIT_MODELS = {
  "visual-brief":    { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "scene-prompt":    { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" }, deep: { provider: "aimlapi", model: "claude-sonnet-4-5-20250929" } },
  composition:       { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "render-style":    { lite: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" }, deep: { provider: "aimlapi", model: "claude-haiku-4-5-20251001" } },
  "caption-lockup":  { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o" }, deep: { provider: "aimlapi", model: "gpt-4o" } },
  "banner-render":   { lite: { provider: "aimlapi", model: "flux/schnell" }, balanced: { provider: "aimlapi", model: "flux/schnell" }, deep: { provider: "aimlapi", model: "flux/schnell" } },
  "brand-palette":   { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "motif-board":     { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "layout-grid":     { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "icon-language":   { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "surface-texture": { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } },
  "brand-guard":     { lite: { provider: "aimlapi", model: "gpt-4o-mini" }, balanced: { provider: "aimlapi", model: "gpt-4o-mini" }, deep: { provider: "aimlapi", model: "gpt-4o-mini" } }
};

const DEFAULT_ROUTE = { provider: "aimlapi", model: "gpt-4o-mini" };

function pickRoute(table, unit, tier) {
  const row = table[unit];
  if (!row) return DEFAULT_ROUTE;
  return row[tierKey(tier)] || row[DEEP] || DEFAULT_ROUTE;
}

export function resolveStrategyRoute(unit, tier) {
  return pickRoute(STRATEGY_UNIT_MODELS, unit, tier);
}

export function resolveCopyRoute(unit, tier) {
  return pickRoute(COPY_UNIT_MODELS, unit, tier);
}

export function resolveSearchRoute(unit, tier) {
  return pickRoute(SEARCH_UNIT_MODELS, unit, tier);
}

export function resolveImageRoute(unit, tier) {
  return pickRoute(IMAGE_UNIT_MODELS, unit, tier);
}

// Back-compat helpers — return only the model ID so legacy callers that only
// expected a string still work.
export function resolveStrategyModel(unit, tier) { return resolveStrategyRoute(unit, tier).model; }
export function resolveCopyModel(unit, tier)     { return resolveCopyRoute(unit, tier).model; }
export function resolveSearchModel(unit, tier)   { return resolveSearchRoute(unit, tier).model; }
export function resolveImageModel(unit, tier)    { return resolveImageRoute(unit, tier).model; }
