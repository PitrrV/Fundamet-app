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
// USD má Manufacturing i Services PMI — kvůli completePmiMonths musí mít oba, jinak měsíc nepočítá se.
const pmiBoth = (values) => [...monthly("ISM Manufacturing PMI", values), ...monthly("ISM Services PMI", values)];
const cbUp = { policyScore: 1, policyLabel: "hiking", realYieldAdj: 0.2 };

test("všech 6 složek kladných → index 1, skóre 5, silný, conviction 3", () => {
  const events = [
    ...monthly("Unemployment Rate", [5.0, 5.0, 5.0, 5.0, 4.5]),
    ...monthly("GDP q/q", [0.1, 0.1, 0.1, 0.8], "2026-09-01", "USD", 3), // HDP je čtvrtletní
    ...monthly("Retail Sales m/m", [0.1, 0.1, 0.1, 0.1, 0.9]),
    ...pmiBoth([51, 51, 51, 51, 53]),
    ...monthly("ISM Services PMI", [51, 51, 51, 51, 53]),
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
  const s = computeFundamentalState("USD", CODES, pmiBoth([53, 53, 53, 53, 53]), {
    asOfDay: "2026-09-30",
    cb: { policyScore: 1, policyLabel: "hiking", realYieldAdj: null },
  });
  assert.equal(s.components.find((c) => c.key === "realYield").score, null);
  assert.equal(s.components.find((c) => c.key === "labor").score, null);
  assert.equal(s.availableCount, 2); // politika + PMI
});

test("pod minimem složek index neexistuje (nedostatek dat)", () => {
  const s = computeFundamentalState("USD", CODES, pmiBoth([53, 53, 53, 53, 53]), {
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
  const s = computeFundamentalState("USD", CODES, pmiBoth([50, 50, 50, 50, 50]), {
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
  const s = computeFundamentalState("USD", CODES, pmiBoth([53, 53, 53, 53, 53]), { asOfDay: "2026-09-30", cb: cbUp });
  const signs = componentSigns(s);
  assert.deepEqual(Object.keys(signs), ["policy", "realYield", "labor", "growth", "demand", "pmi"]);
  assert.equal(signs.pmi, 1);
  assert.equal(signs.labor, null);
});

test("výpočet nepoužívá COT/retail/VIX ani cenu (žádné takové vstupy)", () => {
  const s = computeFundamentalState("USD", CODES, pmiBoth([53, 53, 53, 53, 53]), { asOfDay: "2026-09-30", cb: cbUp });
  assert.equal(JSON.stringify(Object.keys(s)).match(/cot|retail|vix|price/i), null);
});

// ── přepínače oprav (STATE_OPTIONS_DEFAULT) ────────────────────────────────────────────────
const ev2 = (title, day, actual, code) => ev(title, day, actual, code);
const gbpGdp = [
  ev2("Final GDP q/q", "2025-12-22", 0.1, "GBP"),
  ev2("Final GDP q/q", "2026-03-31", 0.1, "GBP"),
  ev2("Final GDP q/q", "2026-06-30", 0.6, "GBP"),
  ev2("GDP m/m", "2026-09-11", 0.4, "GBP"),
  ev2("Final GDP q/q", "2026-09-30", 0.5, "GBP"),
];
const cbNone = { policyScore: 0, policyLabel: "hold", realYieldAdj: null };

test("výchozí přepínače: opravy dat zapnuté, vyhlazení spotřeby vypnuté (rozhodnuto podle backtestu)", async () => {
  const { STATE_OPTIONS_DEFAULT } = await import("./fundamental-state.mjs");
  assert.deepEqual({ ...STATE_OPTIONS_DEFAULT }, { consistentGrowthUnit: true, completePmiMonths: true, extraSeries: true, smoothDemand: false });
});

test("HDP v jedné jednotce: měsíční m/m netlačí čtvrtletní q/q (GBP)", () => {
  const off = computeFundamentalState("GBP", CODES, gbpGdp, { asOfDay: "2026-10-02", cb: cbNone, options: { consistentGrowthUnit: false } });
  const on = computeFundamentalState("GBP", CODES, gbpGdp, { asOfDay: "2026-10-02", cb: cbNone, options: { consistentGrowthUnit: true } });
  const detail = (s) => s.components.find((c) => c.key === "growth").detail;
  assert.match(detail(on), /poslední 0,5 % \(norma 0,27 %\)/); // q/q: 0,1; 0,1; 0,6 → 0,5
  assert.notEqual(detail(off), detail(on)); // původní série míchá jednotky
});

test("PMI: měsíc bez služeb se s completePmiMonths nepočítá (EUR)", () => {
  const eur = [
    ev2("Final Manufacturing PMI", "2026-08-03", 50, "EUR"), ev2("Final Services PMI", "2026-08-05", 52, "EUR"),
    ev2("Final Manufacturing PMI", "2026-09-01", 51, "EUR"), ev2("Final Services PMI", "2026-09-03", 53, "EUR"),
    ev2("Final Manufacturing PMI", "2026-10-01", 52.9, "EUR"), // služby ještě nevyšly
  ];
  const off = computeFundamentalState("EUR", CODES, eur, { asOfDay: "2026-10-02", cb: cbNone, options: { completePmiMonths: false } });
  const on = computeFundamentalState("EUR", CODES, eur, { asOfDay: "2026-10-02", cb: cbNone, options: { completePmiMonths: true } });
  const pmi = (s) => s.components.find((c) => c.key === "pmi").detail;
  assert.match(pmi(off), /52,9/);
  assert.match(pmi(on), /52 \(/); // září: (51+53)/2
});

test("extraSeries: AUD Household Spending jako spotřeba, NZD BusinessNZ jako PMI", () => {
  const aud = monthly("Household Spending m/m", [0.1, 0.1, 0.1, 0.1, 0.9], "2026-09-01", "AUD");
  const nzd = [
    ...monthly("BusinessNZ Manufacturing Index", [48, 48, 49, 51, 52], "2026-09-01", "NZD"),
    ...monthly("BusinessNZ Services Index", [49, 49, 50, 52, 53], "2026-09-01", "NZD"),
  ];
  const a0 = computeFundamentalState("AUD", CODES, aud, { asOfDay: "2026-09-30", cb: cbNone, options: { extraSeries: false } });
  const a1 = computeFundamentalState("AUD", CODES, aud, { asOfDay: "2026-09-30", cb: cbNone, options: { extraSeries: true } });
  assert.equal(a0.components.find((c) => c.key === "demand").score, null);
  assert.equal(a1.components.find((c) => c.key === "demand").score, 1);
  const n0 = computeFundamentalState("NZD", CODES, nzd, { asOfDay: "2026-09-30", cb: cbNone, options: { extraSeries: false } });
  const n1 = computeFundamentalState("NZD", CODES, nzd, { asOfDay: "2026-09-30", cb: cbNone, options: { extraSeries: true } });
  assert.equal(n0.components.find((c) => c.key === "pmi").score, null);
  assert.equal(n1.components.find((c) => c.key === "pmi").score, 1); // (52+53)/2 = 52,5 > 50,5
});

test("smoothDemand: střídavý šum m/m už složku nepřepíná, trvalý posun ano", () => {
  const noisy = monthly("Retail Sales m/m", [0.9, -0.7, 1.0, -0.6, 0.9, -0.5, 1.1], "2026-09-01", "USD");
  const shift = monthly("Retail Sales m/m", [0.1, 0.0, 0.1, 0.0, 0.9, 1.0, 1.1], "2026-09-01", "USD");
  const get = (events, smooth) =>
    computeFundamentalState("USD", CODES, events, { asOfDay: "2026-09-30", cb: cbNone, options: { smoothDemand: smooth } }).components.find((c) => c.key === "demand").score;
  assert.equal(get(noisy, false), 1); // poslední tisk 1,1 vs. norma ≈ 0,3 → raw skáče na +1
  assert.equal(get(noisy, true), 0); // vyhlazený průměr se pohybuje kolem 0,2 — žádný trend
  assert.equal(get(shift, true), 1); // skutečný posun nahoru zůstává vidět
});
