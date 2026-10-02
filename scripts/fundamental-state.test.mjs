import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFundamentalState,
  bandFromIndex,
  weekEndFriday,
  describeSurprise,
  componentSigns,
  WINDOW_MONTHS,
  MIN_COMPONENTS,
} from "./fundamental-state.mjs";

const CODES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];
const ev = (title, day, actual, code = "USD") => ({ currency_code: code, event_title: title, event_day: day, actual: String(actual), estimate: null, previous: null, impact: "High", event_time: null });
const monthly = (title, values, endDay = "2026-09-01", code = "USD", stepMonths = 1) =>
  values.map((v, i) => {
    const d = new Date(`${endDay}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - (values.length - 1 - i) * stepMonths);
    return ev(title, d.toISOString().slice(0, 10), v, code);
  });
const cbUp = { policyScore: 1, policyLabel: "hiking", realYieldAdj: 0.2 };

test("všech 6 složek kladných → index 1, skóre 5, silný, conviction 3", () => {
  const events = [
    ...monthly("Unemployment Rate", [5.0, 5.0, 5.0, 5.0, 4.5]),
    ...monthly("GDP q/q", [0.1, 0.1, 0.1, 0.8], "2026-09-01", "USD", 3), // HDP je čtvrtletní
    ...monthly("Retail Sales m/m", [0.1, 0.1, 0.1, 0.1, 0.9]),
    ...monthly("ISM Manufacturing PMI", [51, 51, 51, 51, 53]),
  ];
  const s = computeFundamentalState("USD", CODES, events, { asOfDay: "2026-09-30", cb: cbUp });
  assert.equal(s.availableCount, 6);
  assert.equal(s.index, 1);
  assert.equal(s.score, 5);
  assert.equal(s.band.key, "strong");
  assert.equal(s.convictionStars, 3);
  assert.match(s.convictionLabel, /VYSOKÁ.*6\/6/);
});

test("rostoucí nezaměstnanost je záporná složka (obrácený směr)", () => {
  const events = monthly("Unemployment Rate", [5.0, 5.0, 5.0, 5.0, 5.6]);
  const s = computeFundamentalState("USD", CODES, events, { asOfDay: "2026-09-30", cb: cbUp });
  assert.equal(s.components.find((c) => c.key === "labor").score, -1);
});

test("chybějící data jsou null (nemáme), ne nula, a nezapočítají se", () => {
  const s = computeFundamentalState("USD", CODES, monthly("ISM Manufacturing PMI", [53, 53, 53, 53, 53]), {
    asOfDay: "2026-09-30",
    cb: { policyScore: 1, policyLabel: "hiking", realYieldAdj: null },
  });
  assert.equal(s.components.find((c) => c.key === "realYield").score, null);
  assert.equal(s.components.find((c) => c.key === "labor").score, null);
  assert.equal(s.availableCount, 2); // politika + PMI
});

test("pod minimem složek index neexistuje (nedostatek dat)", () => {
  const s = computeFundamentalState("USD", CODES, monthly("ISM Manufacturing PMI", [53, 53, 53, 53, 53]), {
    asOfDay: "2026-09-30",
    cb: { policyScore: 1, policyLabel: "hiking", realYieldAdj: null },
  });
  assert.ok(s.availableCount < MIN_COMPONENTS);
  assert.equal(s.index, null);
  assert.equal(s.score, null);
  assert.equal(s.band.key, "insufficient");
  assert.equal(s.convictionStars, 0);
});

test("váhy: reálný výnos (1,5) převáží politiku (1,0)", () => {
  // policy +1 (w1), realYield −1 (w1.5), PMI 0 (w1) → (1 − 1.5 + 0) / 3.5
  const s = computeFundamentalState("USD", CODES, monthly("ISM Manufacturing PMI", [50, 50, 50, 50, 50]), {
    asOfDay: "2026-09-30",
    cb: { policyScore: 1, policyLabel: "hiking", realYieldAdj: -0.3 },
  });
  assert.equal(s.index, Math.round(((1 - 1.5 + 0) / 3.5) * 1000) / 1000);
});

test("okno historie je 12 měsíců — starší tisky se nepočítají", () => {
  assert.equal(WINDOW_MONTHS, 12);
  const old = monthly("Unemployment Rate", [5.0, 5.0, 5.0, 5.0, 4.0], "2025-06-01"); // > 12 m před asOf
  const s = computeFundamentalState("USD", CODES, old, { asOfDay: "2026-09-30", cb: cbUp });
  assert.equal(s.components.find((c) => c.key === "labor").score, null);
});

test("point-in-time: události po asOfDay se neberou v úvahu", () => {
  const events = [...monthly("Unemployment Rate", [5.0, 5.0, 5.0, 5.0]), ev("Unemployment Rate", "2026-09-20", 6.5)];
  const before = computeFundamentalState("USD", CODES, events, { asOfDay: "2026-09-10", cb: cbUp });
  const after = computeFundamentalState("USD", CODES, events, { asOfDay: "2026-09-30", cb: cbUp });
  assert.equal(before.components.find((c) => c.key === "labor").score, 0);
  assert.equal(after.components.find((c) => c.key === "labor").score, -1);
});

test("pásma indexu a hranice", () => {
  assert.equal(bandFromIndex(0.6).key, "strong");
  assert.equal(bandFromIndex(0.5).key, "strong");
  assert.equal(bandFromIndex(0.2).key, "mild_positive");
  assert.equal(bandFromIndex(0).key, "neutral");
  assert.equal(bandFromIndex(-0.2).key, "neutral");
  assert.equal(bandFromIndex(-0.21).key, "mild_negative");
  assert.equal(bandFromIndex(-0.5).key, "mild_negative");
  assert.equal(bandFromIndex(-0.51).key, "weak");
  assert.equal(bandFromIndex(null).key, "insufficient");
});

test("pátek týdne pro libovolný den", () => {
  assert.equal(weekEndFriday("2026-09-28"), "2026-10-02"); // pondělí
  assert.equal(weekEndFriday("2026-10-02"), "2026-10-02"); // pátek
  assert.equal(weekEndFriday("2026-10-04"), "2026-10-02"); // neděle patří k týdnu končícímu v pátek
});

test("překvapení se popisuje odděleně od stavu", () => {
  assert.equal(describeSurprise(1.4), "pozitivní překvapení");
  assert.equal(describeSurprise(-1), "negativní překvapení");
  assert.equal(describeSurprise(0.3), "v souladu s očekáváním");
  assert.equal(describeSurprise(null), "nemáme");
});

test("kompaktní znaky složek pro historii", () => {
  const s = computeFundamentalState("USD", CODES, monthly("ISM Manufacturing PMI", [53, 53, 53, 53, 53]), { asOfDay: "2026-09-30", cb: cbUp });
  const signs = componentSigns(s);
  assert.deepEqual(Object.keys(signs), ["policy", "realYield", "labor", "growth", "demand", "pmi"]);
  assert.equal(signs.pmi, 1);
  assert.equal(signs.labor, null);
});

test("výpočet nepoužívá COT/retail/VIX ani cenu (žádné takové vstupy)", () => {
  const s = computeFundamentalState("USD", CODES, monthly("ISM Manufacturing PMI", [53, 53, 53, 53, 53]), { asOfDay: "2026-09-30", cb: cbUp });
  assert.equal(JSON.stringify(Object.keys(s)).match(/cot|retail|vix|price/i), null);
});
