import { test } from "node:test";
import assert from "node:assert/strict";
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
