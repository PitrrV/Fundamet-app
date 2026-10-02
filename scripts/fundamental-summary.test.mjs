import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOverallScore, computeConviction, convictionLabelFromStars, MAX_CONVICTION } from "./fundamental-summary.mjs";

test("overall score is only fundamental + real yield + CB policy, clamped, rounded to 0.1", () => {
  const r = computeOverallScore({ fundamentalScore: 0.2, realYieldAdj: 0.07, cbPolicyAdj: 0.03 });
  assert.equal(r.overallScore, 0.3);
  assert.equal(computeOverallScore({ fundamentalScore: 4.9, realYieldAdj: 1, cbPolicyAdj: 0.75 }).overallScore, 5);
  assert.equal(computeOverallScore({ fundamentalScore: -4.9, realYieldAdj: -1, cbPolicyAdj: -0.75 }).overallScore, -5);
});

test("missing real yield contributes nothing (no guess)", () => {
  const r = computeOverallScore({ fundamentalScore: 0.6, realYieldAdj: null, cbPolicyAdj: -0.17 });
  assert.equal(r.overallScore, 0.4);
});

test("overall score ignores any positioning input", () => {
  const args = { fundamentalScore: 0.2, realYieldAdj: 0.07, cbPolicyAdj: 0.03, cotScore: -2.2, retailScore: -5 };
  assert.equal(computeOverallScore(args).overallScore, 0.3);
});

test("conviction counts only CB policy, real yield and fundament that agree with direction", () => {
  const c = computeConviction(1.2, { cbPolicyAdj: 0.23, realYieldAdj: 0.1, fundamentalScoreAdj: 1.1, policyLabel: "hike" });
  assert.equal(c.stars, 3);
  assert.equal(c.reasons.length, 3);
});

test("conviction: null real yield and weak fundament give no star", () => {
  const c = computeConviction(0.4, { cbPolicyAdj: 0.23, realYieldAdj: null, fundamentalScoreAdj: 0.4, policyLabel: "hike" });
  assert.equal(c.stars, 1);
});

test("conviction never exceeds MAX_CONVICTION and is 0 for zero score", () => {
  assert.equal(MAX_CONVICTION, 3);
  assert.equal(computeConviction(0, { cbPolicyAdj: 1, realYieldAdj: 1, fundamentalScoreAdj: 3, policyLabel: "x" }).stars, 0);
});

test("conviction label is out of 3", () => {
  assert.match(convictionLabelFromStars(3), /VYSOKÁ.*3\/3/);
  assert.match(convictionLabelFromStars(2), /STŘEDNÍ.*2\/3/);
  assert.match(convictionLabelFromStars(0), /NÍZKÁ.*0\/3/);
});

import { classifyThesisUpdate, DRIVER_THRESHOLDS } from "./thesis-engine.mjs";

test("thesis drivers are fundamental only", () => {
  assert.deepEqual(Object.keys(DRIVER_THRESHOLDS).sort(), ["cb_policy", "fundamental_data"]);
});

test("legacy COT/retail/risk drivers get challenged, then removed, never confirmed", () => {
  const legacy = [
    { driver_key: "cot_positioning", label: "COT", value: -2.2, status: "strong" },
    { driver_key: "retail_sentiment", label: "Retail", value: -5, status: "strong" },
    { driver_key: "risk_regime", label: "Risk", value: 0.3, status: "strong" },
  ];
  const pillarValues = { fundamental_data: 0.3, cb_policy: 0.1 };
  const first = classifyThesisUpdate(legacy, "bearish", pillarValues);
  assert.equal(first.ledgerEntries.every((e) => e.classification === "challenges"), true);
  assert.equal(first.nextDrivers.every((d) => d.status === "weakening"), true);
  const second = classifyThesisUpdate(first.nextDrivers, "bearish", pillarValues);
  assert.equal(second.nextDrivers.length, 0);
  assert.equal(second.ledgerEntries.every((e) => e.classification === "invalidates_driver"), true);
});
