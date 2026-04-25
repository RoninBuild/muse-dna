export const SERVICE_ORDER = ["strategy", "search", "copy", "image"];

export const SERVICE_LABELS = {
  strategy: "Strategy DNA",
  search: "Search Signal",
  copy: "Copy Pulse",
  image: "Visual Frame"
};

function createUnit(service, unit, price, dnaKey, label, instruction, options = {}) {
  return {
    service,
    unit,
    price,
    dnaKey,
    label,
    instruction,
    investmentOnly: Boolean(options.investmentOnly),
    dnaBlock: Boolean(options.dnaBlock),
    outputType: options.outputType || "text"
  };
}

const STRATEGY_UNITS = [
  createUnit("strategy", "product-summary", 0.005, "product.summary", "Product Summary", "Extract the cleanest one-sentence product summary.", { dnaBlock: true }),
  createUnit("strategy", "product-surface", 0.005, "product.features", "Feature Surface", "List the feature layer that matters commercially.", { dnaBlock: true }),
  createUnit("strategy", "problem-statement", 0.005, "positioning.problem", "Problem Statement", "Define the pain the product removes.", { dnaBlock: true }),
  createUnit("strategy", "promise-core", 0.005, "positioning.promise", "Core Promise", "Write the core brand promise.", { dnaBlock: true }),
  createUnit("strategy", "usp-proof", 0.005, "positioning.usp", "USP Proof", "Capture the differentiating proof point.", { dnaBlock: true }),
  createUnit("strategy", "category-frame", 0.005, "positioning.category", "Category Frame", "Frame the category narrative this brand should own.", { dnaBlock: true }),
  createUnit("strategy", "audience-primary", 0.005, "audience.primary", "Primary Audience", "Define the primary buyer.", { dnaBlock: true }),
  createUnit("strategy", "audience-secondary", 0.005, "audience.secondary", "Secondary Audience", "Define the secondary audience.", { dnaBlock: true }),
  createUnit("strategy", "audience-pains", 0.005, "audience.pains", "Audience Pains", "List the daily pain points.", { dnaBlock: true }),
  createUnit("strategy", "audience-motivations", 0.005, "audience.motivations", "Audience Motivations", "List what the audience wants to unlock.", { dnaBlock: true }),
  createUnit("strategy", "buyer-triggers", 0.005, "audience.triggers", "Buyer Triggers", "Describe what makes the buyer act now.", { dnaBlock: true }),
  createUnit("strategy", "objections", 0.005, "objections.core", "Objections", "Write the core objections the message must answer.", { dnaBlock: true }),
  createUnit("strategy", "proof-points", 0.005, "proof.points", "Proof Points", "Extract proof, credibility, and trust signals.", { dnaBlock: true }),
  createUnit("strategy", "competitors-direct", 0.005, "competitors.direct", "Direct Competitors", "List direct competitors or substitutes.", { dnaBlock: true }),
  createUnit("strategy", "competitors-alt", 0.005, "competitors.alternatives", "Alternative Competitors", "List adjacent alternatives buyers compare against.", { dnaBlock: true }),
  createUnit("strategy", "competitor-gap", 0.005, "competitors.gap", "Competitive Gap", "Describe the white-space the brand can claim.", { dnaBlock: true }),
  createUnit("strategy", "voice-pillars", 0.005, "voice.pillars", "Voice Pillars", "Define the voice pillars.", { dnaBlock: true }),
  createUnit("strategy", "tone-dos", 0.005, "voice.dos", "Tone Dos", "List what the tone should do.", { dnaBlock: true }),
  createUnit("strategy", "tone-donts", 0.005, "voice.donts", "Tone Donts", "List what the tone must avoid.", { dnaBlock: true }),
  createUnit("strategy", "keywords-core", 0.005, "messaging.keywords", "Keywords", "Extract keywords the brand should sound fluent in.", { dnaBlock: true }),
  createUnit("strategy", "messaging-pillars", 0.005, "messaging.pillars", "Messaging Pillars", "Define the messaging pillars.", { dnaBlock: true }),
  createUnit("strategy", "content-angles", 0.005, "messaging.angles", "Content Angles", "List repeatable content angles.", { dnaBlock: true }),
  createUnit("strategy", "cta-style", 0.005, "messaging.cta", "CTA Style", "Define how the brand should ask for action.", { dnaBlock: true }),
  createUnit("strategy", "visual-guardrails", 0.005, "visual.guardrails", "Visual Guardrails", "Describe visual boundaries for future assets.", { dnaBlock: true })
];

const SEARCH_UNITS = [
  createUnit("search", "news-query", 0.004, null, "News Query", "Find the freshest relevant brand or category signal."),
  createUnit("search", "release-scan", 0.004, null, "Release Scan", "Look for release or shipping signals."),
  createUnit("search", "market-signal", 0.004, null, "Market Signal", "Capture a category or market movement."),
  createUnit("search", "operator-quote", 0.004, null, "Operator Quote", "Capture an operator-friendly proof or phrase."),
  createUnit("search", "competitor-signal", 0.004, null, "Competitor Signal", "Capture a competitive or comparison signal."),
  createUnit("search", "search-summary", 0.004, null, "Search Summary", "Collapse the findings into one reusable summary.")
];

const COPY_ALWAYS_UNITS = [
  createUnit("copy", "headline", 0.005, "copy.headline", "Headline", "Write the main headline."),
  createUnit("copy", "hook-line", 0.005, "copy.hook", "Hook Line", "Write the hook that opens the asset."),
  createUnit("copy", "pain-turn", 0.005, "copy.pain", "Pain Turn", "Name the pain in crisp operator language."),
  createUnit("copy", "benefit-stack", 0.005, "copy.benefits", "Benefit Stack", "Translate the value into practical wins."),
  createUnit("copy", "proof-line", 0.005, "copy.proof", "Proof Line", "Write a proof-oriented line."),
  createUnit("copy", "cta-line", 0.005, "copy.cta", "CTA Line", "Write the closing call to action."),
  createUnit("copy", "channel-format", 0.005, "copy.format", "Channel Format", "Format the content for the requested channel."),
  createUnit("copy", "final-copy", 0.005, "copy.final", "Final Copy", "Return the final copy block.")
];

const COPY_INVESTMENT_UNITS = [
  createUnit("copy", "voice-seed", 0.005, "copy.voice_seed", "Voice Seed", "Create a voice seed reusable across later tasks.", { investmentOnly: true }),
  createUnit("copy", "usp-seed", 0.005, "copy.usp_seed", "USP Seed", "Create a reusable USP seed.", { investmentOnly: true })
];

const IMAGE_ALWAYS_UNITS = [
  createUnit("image", "visual-brief", 0.006, "visual.brief", "Visual Brief", "Write the core visual brief.", { outputType: "json" }),
  createUnit("image", "scene-prompt", 0.006, "visual.scene", "Scene Prompt", "Describe the scene prompt.", { outputType: "json" }),
  createUnit("image", "composition", 0.006, "visual.composition", "Composition", "Describe the layout and composition.", { outputType: "json" }),
  createUnit("image", "render-style", 0.006, "visual.style", "Render Style", "Describe the style treatment.", { outputType: "json" }),
  createUnit("image", "caption-lockup", 0.006, "visual.caption", "Caption Lockup", "Write the short overlay or caption.", { outputType: "json" }),
  createUnit("image", "banner-render", 0.006, "visual.render", "Banner Render", "Return the final image asset.", { outputType: "image" })
];

const IMAGE_INVESTMENT_UNITS = [
  createUnit("image", "brand-palette", 0.003, "visual.palette", "Brand Palette", "Define the reusable palette.", { investmentOnly: true, outputType: "json" }),
  createUnit("image", "motif-board", 0.003, "visual.motif", "Motif Board", "Define repeatable visual motifs.", { investmentOnly: true, outputType: "json" }),
  createUnit("image", "layout-grid", 0.003, "visual.layout", "Layout Grid", "Define the reusable layout grid.", { investmentOnly: true, outputType: "json" }),
  createUnit("image", "icon-language", 0.003, "visual.icons", "Icon Language", "Define the icon language.", { investmentOnly: true, outputType: "json" }),
  createUnit("image", "surface-texture", 0.003, "visual.texture", "Surface Texture", "Define texture and background treatment.", { investmentOnly: true, outputType: "json" }),
  createUnit("image", "brand-guard", 0.003, "visual.brand_guard", "Brand Guard", "Define what the visual system must avoid.", { investmentOnly: true, outputType: "json" })
];

const INVESTMENT_EXECUTION_PLAN = [
  ...STRATEGY_UNITS,
  ...SEARCH_UNITS,
  ...COPY_ALWAYS_UNITS,
  ...COPY_INVESTMENT_UNITS,
  ...IMAGE_ALWAYS_UNITS,
  ...IMAGE_INVESTMENT_UNITS
];

const DIVIDEND_EXECUTION_PLAN = [
  ...SEARCH_UNITS,
  ...COPY_ALWAYS_UNITS,
  ...IMAGE_ALWAYS_UNITS
];

const DIVIDEND_SKIPPED_UNITS = [
  ...STRATEGY_UNITS,
  ...COPY_INVESTMENT_UNITS,
  ...IMAGE_INVESTMENT_UNITS
];

const ALL_UNITS = [
  ...STRATEGY_UNITS,
  ...SEARCH_UNITS,
  ...COPY_ALWAYS_UNITS,
  ...COPY_INVESTMENT_UNITS,
  ...IMAGE_ALWAYS_UNITS,
  ...IMAGE_INVESTMENT_UNITS
];

const UNIT_INDEX = new Map(ALL_UNITS.map((definition) => [definition.unit, definition]));

// Startup-time sanity check: every unit name referenced by TIER_*_UNITS must
// exist in UNIT_INDEX. Without this a typo silently thins the tier (because
// `getUnitDefinition()` returns null and `.filter(Boolean)` drops it) and
// downstream plans become cheaper / weaker than advertised.
function validateStaticUnitReferences() {
  const errors = [];
  const serviceMaps = {
    strategy: TIER_STRATEGY_UNITS,
    search: TIER_SEARCH_UNITS,
    copy: TIER_COPY_UNITS,
    image: TIER_IMAGE_UNITS
  };
  for (const [service, byTier] of Object.entries(serviceMaps)) {
    for (const [tier, unitNames] of Object.entries(byTier)) {
      for (const unitName of unitNames) {
        const definition = UNIT_INDEX.get(unitName);
        if (!definition) {
          errors.push(`TIER_${service.toUpperCase()}_UNITS.${tier} references unknown unit "${unitName}"`);
        } else if (definition.service !== service) {
          errors.push(
            `TIER_${service.toUpperCase()}_UNITS.${tier} references "${unitName}" which belongs to service "${definition.service}"`
          );
        }
      }
    }
  }
  if (errors.length) {
    throw new Error(
      `Microeconomy tier catalog drift detected:\n- ${errors.join("\n- ")}`
    );
  }
}

// ============================================================
// TIERS — three execution variants the Gemini orchestrator
// offers the user. Each tier picks a subset of units so costs,
// DNA coverage, and time vary meaningfully. Gemini can also
// override these lists at plan time by returning custom lists
// via Function Calling.
// ============================================================
export const TIER_KEYS = ["lite", "balanced", "deep"];

const TIER_STRATEGY_UNITS = {
  lite: ["product-summary", "promise-core", "audience-primary", "audience-pains", "voice-pillars", "messaging-pillars"],
  balanced: [
    "product-summary", "product-surface", "problem-statement", "promise-core",
    "usp-proof", "category-frame", "audience-primary", "audience-pains",
    "audience-motivations", "voice-pillars", "tone-dos", "messaging-pillars",
    "content-angles", "cta-style"
  ],
  deep: STRATEGY_UNITS.map((u) => u.unit)
};

const TIER_SEARCH_UNITS = {
  lite: ["news-query", "market-signal", "search-summary"],
  balanced: ["news-query", "release-scan", "market-signal", "operator-quote", "search-summary"],
  deep: SEARCH_UNITS.map((u) => u.unit)
};

const TIER_COPY_UNITS = {
  lite: ["headline", "hook-line", "cta-line", "final-copy"],
  balanced: ["headline", "hook-line", "pain-turn", "benefit-stack", "cta-line", "final-copy"],
  deep: [...COPY_ALWAYS_UNITS, ...COPY_INVESTMENT_UNITS].map((u) => u.unit)
};

const TIER_IMAGE_UNITS = {
  lite: ["visual-brief", "render-style", "banner-render"],
  balanced: ["visual-brief", "scene-prompt", "composition", "render-style", "caption-lockup", "banner-render"],
  deep: [...IMAGE_ALWAYS_UNITS, ...IMAGE_INVESTMENT_UNITS].map((u) => u.unit)
};

const TIER_META = {
  lite: {
    key: "lite",
    label: "LITE",
    subtitle: "Sprint build",
    description: "Minimum viable DNA, fast turnaround, lowest cost per run.",
    timeEstimateSeconds: 35
  },
  balanced: {
    key: "balanced",
    label: "BALANCED",
    subtitle: "Signature mix",
    description: "Covers the positioning, voice, and creative pipeline without extra dividend seeds.",
    timeEstimateSeconds: 70
  },
  deep: {
    key: "deep",
    label: "DEEP",
    subtitle: "Full DNA investment",
    description: "All strategy blocks and dividend seeds, ready to be reused by every future campaign.",
    timeEstimateSeconds: 140
  }
};

function roundMoney(value) {
  return Number(value.toFixed(4));
}

function cloneUnits(units) {
  return units.map((unit) => ({ ...unit }));
}

function sumPrice(units) {
  return roundMoney(units.reduce((total, unit) => total + Number(unit.price || 0), 0));
}

export function toUnitId(unitDefinition) {
  return `${unitDefinition.service}.${unitDefinition.unit}`;
}

export function getUnitDefinition(unitName) {
  return UNIT_INDEX.get(unitName) || null;
}

function normalizeSkippedUnits(skippedUnits) {
  if (!Array.isArray(skippedUnits)) {
    return null;
  }

  const seenUnits = new Set();
  const normalized = [];

  for (const unitName of skippedUnits) {
    const definition = getUnitDefinition(unitName);

    if (!definition || seenUnits.has(definition.unit)) {
      continue;
    }

    seenUnits.add(definition.unit);
    normalized.push({ ...definition });
  }

  return normalized;
}

export function buildMicroEconomyPlan({ dnaExists, skippedUnits } = {}) {
  const explicitSkippedUnitDefinitions = normalizeSkippedUnits(skippedUnits);
  const skippedUnitDefinitions = dnaExists
    ? explicitSkippedUnitDefinitions ?? cloneUnits(DIVIDEND_SKIPPED_UNITS)
    : [];
  const skippedSet = new Set(skippedUnitDefinitions.map((unit) => unit.unit));
  const executableUnits = dnaExists
    ? cloneUnits(ALL_UNITS.filter((unit) => !skippedSet.has(unit.unit)))
    : cloneUnits(INVESTMENT_EXECUTION_PLAN);
  const investmentCost = sumPrice(INVESTMENT_EXECUTION_PLAN);
  const estimatedCost = dnaExists ? sumPrice(executableUnits) : investmentCost;

  return {
    micro_plan: executableUnits,
    skipped_units: skippedUnitDefinitions.map((unit) => unit.unit),
    skipped_unit_definitions: skippedUnitDefinitions,
    estimated_cost_usdc: estimatedCost,
    investment_cost_usdc: investmentCost,
    savings_usdc: dnaExists ? roundMoney(investmentCost - estimatedCost) : 0,
    blueprint_total_units: ALL_UNITS.length,
    payable_units: executableUnits.length,
    reused_units: skippedUnitDefinitions.length,
    dna_blocks_total: STRATEGY_UNITS.length
  };
}

function normalizeTierKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  return TIER_KEYS.includes(normalized) ? normalized : null;
}

function collectTierUnits(tierKey, { dnaExists = false, skippedUnits = [] } = {}) {
  const strategyUnits = dnaExists ? [] : TIER_STRATEGY_UNITS[tierKey];
  const searchUnits = TIER_SEARCH_UNITS[tierKey];
  const copyUnits = TIER_COPY_UNITS[tierKey];
  const imageUnits = TIER_IMAGE_UNITS[tierKey];
  const skippedSet = new Set(skippedUnits);
  const combined = [...strategyUnits, ...searchUnits, ...copyUnits, ...imageUnits];

  return combined
    .filter((unit) => !skippedSet.has(unit))
    .map((unitName) => getUnitDefinition(unitName))
    .filter(Boolean)
    .map((definition) => ({ ...definition }));
}

/**
 * Build a concrete execution plan for a tier. Used by the Gemini variant
 * planner and by the /tasks/execute endpoint once the user picks a tier.
 */
export function buildTierPlan({ tier, dnaExists = false, skippedUnits = [] } = {}) {
  const tierKey = normalizeTierKey(tier);
  if (!tierKey) {
    throw new Error(`Unknown tier: ${tier}`);
  }

  const executableUnits = collectTierUnits(tierKey, { dnaExists, skippedUnits });
  const deepPlan = collectTierUnits("deep", { dnaExists: false });
  const investmentCost = sumPrice(deepPlan);
  const estimatedCost = sumPrice(executableUnits);

  const executableUnitSet = new Set(executableUnits.map((u) => u.unit));
  // Skipped set includes every unit the blueprint has but the tier doesn't
  // run — strategy blocks reused from Hermes DNA **and** copy/image
  // investment seeds that LITE/BALANCED tiers intentionally skip. Previously
  // we only counted strategy skips, which under-reported DNA reuse savings.
  const allSkipped = ALL_UNITS
    .filter((u) => !executableUnitSet.has(u.unit))
    .map((u) => ({ ...u }));
  const reusedStrategy = allSkipped.filter((u) => u.service === "strategy").length;

  return {
    tier: tierKey,
    meta: { ...TIER_META[tierKey] },
    micro_plan: executableUnits,
    skipped_units: allSkipped.map((u) => u.unit),
    skipped_unit_definitions: allSkipped,
    estimated_cost_usdc: estimatedCost,
    investment_cost_usdc: investmentCost,
    savings_usdc: roundMoney(investmentCost - estimatedCost),
    payable_units: executableUnits.length,
    reused_units: allSkipped.length,
    dna_blocks_included: executableUnits.filter((u) => u.service === "strategy").length,
    dna_blocks_total: STRATEGY_UNITS.length,
    reused_strategy_blocks: reusedStrategy,
    blueprint_total_units: ALL_UNITS.length
  };
}

/**
 * Return a summary of every tier plus the meta. Used by the variant planner.
 */
export function buildAllTierSummaries({ dnaExists = false } = {}) {
  return TIER_KEYS.map((tier) => {
    const plan = buildTierPlan({ tier, dnaExists });
    return {
      tier,
      ...TIER_META[tier],
      units: plan.payable_units,
      dnaBlocks: plan.dna_blocks_included,
      dnaBlocksTotal: plan.dna_blocks_total,
      estimatedCostUsdc: plan.estimated_cost_usdc,
      savingsUsdc: plan.savings_usdc,
      services: {
        strategy: plan.micro_plan.filter((u) => u.service === "strategy").length,
        search: plan.micro_plan.filter((u) => u.service === "search").length,
        copy: plan.micro_plan.filter((u) => u.service === "copy").length,
        image: plan.micro_plan.filter((u) => u.service === "image").length
      }
    };
  });
}

export function getTierMeta(tier) {
  const tierKey = normalizeTierKey(tier);
  return tierKey ? { ...TIER_META[tierKey] } : null;
}

/**
 * Dynamic agent-worker provisioning.
 *
 * Hackathon requirement: every task should spin up 4-15 agent wallets so
 * judges see "fresh swarm per task" on ArcScan. The exact count is derived
 * from:
 *   1. units_per_service in the plan  (ceil(units / threshold))
 *   2. tier threshold                 (smaller threshold = more workers)
 *   3. prompt-complexity multiplier   (long / enterprise / multi-brand)
 *
 * Total is clamped to [MIN_AGENTS, MAX_AGENTS] so no single task spams the
 * network and no simple task ships with just 2 wallets.
 */
// Per product spec: orchestrator picks 4-15 fresh agents (= wallets) per task.
// Floor is the four mandatory roles (strategy / search / copy / image), ceiling
// is high enough that complex full-kit jobs can fan out without spamming the
// chain.
const MIN_AGENTS = 4;
const MAX_AGENTS = 15;
const TIER_WORKER_THRESHOLD = { lite: 2, balanced: 3, deep: 3 };

function promptComplexityMultiplier(prompt, taskType) {
  const text = String(prompt || "").toLowerCase();
  let mult = 1.0;
  // Longer prompts tend to describe multi-faceted campaigns.
  if (text.length > 400) mult += 0.25;
  else if (text.length > 180) mult += 0.1;
  // Keywords that historically correlate with broader DNA needs.
  const complexHints = /(enterprise|b2b|multi[- ]brand|fortune|platform|ecosystem|global|international|launch|rebrand|campaign series|ecommerce)/i;
  if (complexHints.test(prompt || "")) mult += 0.2;
  // Full-kit tasks are inherently more work than a single tweet.
  if (taskType === "full_kit") mult += 0.25;
  else if (taskType === "email_campaign") mult += 0.1;
  return Math.min(1.5, Math.max(0.9, mult));
}

export function computeAgentWorkerCount({ microPlan, tier, prompt = "", taskType = "" } = {}) {
  // Previously fell back to "deep" on unknown tier — that's the MOST
  // expensive tier, so a bad upstream tier string could silently inflate
  // worker count. Default to the cheapest tier ("lite") instead so a
  // misconfigured caller under-provisions rather than over-spends.
  const tierKey = normalizeTierKey(tier) || "lite";
  const threshold = TIER_WORKER_THRESHOLD[tierKey] || 2;
  const mult = promptComplexityMultiplier(prompt, taskType);

  const unitsPerService = { strategy: 0, search: 0, copy: 0, image: 0 };
  for (const unit of Array.isArray(microPlan) ? microPlan : []) {
    if (unit?.service && unitsPerService[unit.service] !== undefined) {
      unitsPerService[unit.service] += 1;
    }
  }

  // Per-service raw count = ceil(units / threshold) × multiplier.
  const rawPerService = Object.fromEntries(
    Object.entries(unitsPerService).map(([service, units]) => {
      if (units === 0) return [service, 0];
      const base = Math.ceil(units / threshold);
      return [service, Math.max(1, Math.round(base * mult))];
    })
  );

  let total = Object.values(rawPerService).reduce((a, b) => a + b, 0);

  // Enforce floor — inflate services proportionally until we hit MIN_AGENTS.
  while (total < MIN_AGENTS) {
    // Pick the service with the highest units-per-worker ratio and add one.
    let bestService = null;
    let bestRatio = -Infinity;
    for (const [s, count] of Object.entries(rawPerService)) {
      if (unitsPerService[s] === 0) continue;
      const ratio = unitsPerService[s] / Math.max(1, count);
      if (ratio > bestRatio) { bestRatio = ratio; bestService = s; }
    }
    if (!bestService) break;
    rawPerService[bestService] += 1;
    total += 1;
  }

  // Enforce ceiling — shrink services proportionally if over MAX_AGENTS.
  while (total > MAX_AGENTS) {
    let bestService = null;
    let bestCount = 0;
    for (const [s, count] of Object.entries(rawPerService)) {
      if (count > bestCount) { bestCount = count; bestService = s; }
    }
    if (!bestService || bestCount <= 1) break;
    rawPerService[bestService] -= 1;
    total -= 1;
  }

  return {
    total,
    perService: rawPerService,
    unitsPerService,
    tier: tierKey,
    complexityMultiplier: mult
  };
}

// Fail fast on module load if the tier catalog and the unit index have
// drifted — better to crash the process on startup than silently ship a
// weaker plan to paying buyers.
validateStaticUnitReferences();
