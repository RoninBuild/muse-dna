import assert from "node:assert/strict";
import test from "node:test";
import { __TEST__ } from "./variantPlanner.js";

const { mergeVariantsWithPlans } = __TEST__;

test("mergeVariantsWithPlans drops Gemini variants with an unknown tier instead of throwing", () => {
  // Previously this chain called buildTierPlan with an invalid tier and bubbled
  // a 500 up to the variant-preview endpoint. The filter must silently drop
  // unknown tiers and fall back to deterministic copy.
  const variants = [
    { tier: "ultra", headline: "bogus", narrative: "Gemini hallucinated a tier" },
    { tier: "balanced", headline: "real", narrative: "valid tier" }
  ];
  const result = mergeVariantsWithPlans(variants, { dnaExists: false });

  // Always three variants in canonical order — regardless of what Gemini sent.
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((v) => v.tier),
    ["lite", "balanced", "deep"]
  );
  // Balanced pulls in Gemini's headline; lite/deep keep the deterministic copy
  // because Gemini supplied neither.
  const balanced = result.find((v) => v.tier === "balanced");
  assert.equal(balanced?.headline, "real");
});

test("mergeVariantsWithPlans handles null / garbage geminiVariants safely", () => {
  const result = mergeVariantsWithPlans(null, { dnaExists: false });
  assert.equal(result.length, 3);
  // None of the variants should have been populated from the (absent) LLM.
  for (const variant of result) {
    assert.ok(variant.headline);
    assert.ok(variant.narrative);
    assert.ok(variant.plan);
  }
});
