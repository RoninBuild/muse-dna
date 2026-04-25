import assert from "node:assert/strict";
import test from "node:test";
import { buildTierPlan, getUnitDefinition, TIER_KEYS, buildMicroEconomyPlan } from "./microeconomy.js";

test("every TIER_*_UNITS entry resolves to a known unit definition (startup integrity)", () => {
  // If this test breaks it means the static tier unit lists have drifted
  // from UNIT_INDEX. That drift would silently thin the tier in production,
  // so both the module-load validator AND this test catch it.
  for (const tier of TIER_KEYS) {
    const plan = buildTierPlan({ tier });
    for (const unit of plan.micro_plan) {
      const definition = getUnitDefinition(unit.unit);
      assert.ok(definition, `tier "${tier}" contains unknown unit "${unit.unit}"`);
      assert.equal(definition.service, unit.service);
    }
  }
});

test("buildTierPlan preserves payable unit count across both code paths", () => {
  for (const tier of TIER_KEYS) {
    const plan = buildTierPlan({ tier });
    assert.ok(plan.payable_units > 0, `tier ${tier} should have payable units`);
    assert.equal(plan.micro_plan.length, plan.payable_units);
  }
});

test("buildMicroEconomyPlan returns 52-unit investment plan when DNA does not exist", () => {
  const plan = buildMicroEconomyPlan({ dnaExists: false });
  assert.equal(plan.micro_plan.length, 52);
  assert.equal(plan.skipped_units.length, 0);
});

test("buildMicroEconomyPlan returns dividend plan when DNA exists", () => {
  const plan = buildMicroEconomyPlan({ dnaExists: true });
  assert.equal(plan.micro_plan.length, 20);
  assert.equal(plan.skipped_units.length, 32);
});
