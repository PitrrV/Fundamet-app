// Unit testy pro autoDetectPolicy() — P0.1 z nezávislého reportu (Cowork, 21.9.2026).
// node --test scripts/cb-policy.test.mjs (nebo `npm test`).

import test from "node:test";
import assert from "node:assert/strict";
import { autoDetectPolicy, extractLatestCpi, referenceCpiFallback, computeCbPolicyState } from "./cb-policy.mjs";

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("živý bug (USD, 21.9.2026): čerstvý hike po dlouhém plató se starým nesouvisejícím cutem nesmí dát 'plateau, hold'", () => {
  const history = [
    { date: "2025-10-29", rate: 4.0 },
    { date: "2025-12-10", rate: 3.75 }, // starý cut, jiný (dávno uzavřený) cyklus
    { date: "2026-01-28", rate: 3.75 },
    { date: "2026-03-18", rate: 3.75 },
    { date: "2026-05-06", rate: 3.75 },
    { date: "2026-07-29", rate: 3.75 },
    { date: "2026-09-16", rate: 4.0 }, // čerstvý hike, appka na to koukala 5 dní poté
  ];
  const result = autoDetectPolicy(history);
  assert.ok(!/plateau/i.test(result.label), `label nesmí obsahovat "plateau": ${result.label}`);
  assert.equal(result.score, 1);
  assert.equal(result.daysSinceMove, 0);
  assert.equal(result.lastMoveBp, 25);
  assert.equal(result.lastMoveDate, "2026-09-16");
});

test("hike po roční pauze (cycle_turn-like): žádný nedávný cut v okolí, poslední pohyb čerstvý hike", () => {
  const history = [
    { date: "2025-01-05", rate: 2.0 },
    { date: "2025-03-01", rate: 2.0 },
    { date: "2025-05-01", rate: 2.0 },
    { date: "2025-07-01", rate: 2.0 },
    { date: "2025-09-01", rate: 2.0 },
    { date: "2025-11-01", rate: 2.25 }, // čerstvý hike
  ];
  const result = autoDetectPolicy(history);
  assert.ok(!/plateau/i.test(result.label));
  assert.equal(result.score, 1);
  assert.equal(result.lastMoveBp, 25);
});

test("cut po hikovacím cyklu: čerstvý cut nesmí dát 'plateau, hold' ani zůstat na starém kladném skóre", () => {
  const history = [
    { date: "2025-01-05", rate: 3.0 },
    { date: "2025-03-01", rate: 3.25 },
    { date: "2025-05-01", rate: 3.5 },
    { date: "2025-07-01", rate: 3.5 },
    { date: "2025-09-01", rate: 3.5 },
    { date: "2025-11-01", rate: 3.25 }, // čerstvý cut
  ];
  const result = autoDetectPolicy(history);
  assert.ok(!/plateau/i.test(result.label));
  assert.equal(result.score, -1);
  assert.equal(result.lastMoveBp, -25);
});

test("dlouhé plató BEZE skutečně nedávného pohybu: 'plateau, hold' zůstává správně (regrese, audit 2.8.2026)", () => {
  const hikeDate = "2024-01-10";
  const history = [
    { date: "2023-11-01", rate: 3.75 },
    { date: hikeDate, rate: 4.0 }, // poslední skutečný pohyb, dávno mimo FRESH_MOVE_WINDOW_DAYS
    { date: addDays(hikeDate, 60), rate: 4.0 },
    { date: addDays(hikeDate, 120), rate: 4.0 },
    { date: addDays(hikeDate, 180), rate: 4.0 },
    { date: addDays(hikeDate, 240), rate: 4.0 },
  ];
  const result = autoDetectPolicy(history);
  assert.match(result.label, /plateau/i);
  assert.equal(result.score, 0);
  assert.equal(result.daysSinceMove, 240);
});

// Obě hraniční hodnoty potřebují holdCount>=4 PO hiku (aby "cyklus hikování", holdCount<=3,
// samo o sobě nerozhodlo dřív, než se vůbec dostane k testování FRESH_MOVE_WINDOW_DAYS) —
// 5 "hold" rozhodnutí po hiku v intervalech ~9 dní dá holdCount=5 v last6.
function historyWithHikeThenHolds(hikeDate, lastHoldOffsetDays) {
  const holdOffsets = [
    Math.round(lastHoldOffsetDays * 0.2),
    Math.round(lastHoldOffsetDays * 0.4),
    Math.round(lastHoldOffsetDays * 0.6),
    Math.round(lastHoldOffsetDays * 0.8),
    lastHoldOffsetDays,
  ];
  return [
    { date: addDays(hikeDate, -200), rate: 3.75 },
    { date: hikeDate, rate: 4.0 }, // hike
    ...holdOffsets.map((d) => ({ date: addDays(hikeDate, d), rate: 4.0 })),
  ];
}

test("hranice přesně 45 dní od posledního pohybu (a holdCount>=4): pořád čerstvé, žádné 'plateau'", () => {
  const result = autoDetectPolicy(historyWithHikeThenHolds("2026-01-01", 45));
  assert.equal(result.daysSinceMove, 45);
  assert.ok(!/plateau/i.test(result.label), `45 dní je pořád v okně, label: ${result.label}`);
  assert.equal(result.score, 1);
});

test("hranice 46 dní od posledního pohybu (a holdCount>=4): okno vypršelo, spadá zpět na plató", () => {
  const result = autoDetectPolicy(historyWithHikeThenHolds("2026-01-01", 46));
  assert.equal(result.daysSinceMove, 46);
  assert.match(result.label, /plateau/i);
  assert.equal(result.score, 0);
});

test("agresivní hikovací cyklus (3+ hiky) zůstává beze změny — nová větev nesmí nabourat existující prioritu", () => {
  const history = [
    { date: "2026-01-01", rate: 3.0 },
    { date: "2026-03-01", rate: 3.25 },
    { date: "2026-05-01", rate: 3.5 },
    { date: "2026-07-01", rate: 3.75 },
  ];
  const result = autoDetectPolicy(history);
  assert.match(result.label, /agresivní hiking/i);
  assert.equal(result.score, 2);
});

test("nedostatek dat vrací neutrální stav beze změny chování", () => {
  assert.deepEqual(autoDetectPolicy([]), { score: 0, label: "nedostatek dat", confidence: "LOW" });
  assert.deepEqual(autoDetectPolicy([{ date: "2026-01-01", rate: 3.0 }]), {
    score: 0,
    label: "nedostatek dat",
    confidence: "LOW",
  });
});

// --- Audit CPI 2026-10-09 (schváleno uživatelem): JPY národní Core CPI + záložní CPI ---

const ev = (currency_code, event_title, event_day, actual, estimate = null) => ({ currency_code, event_title, event_day, actual, estimate });

test("JPY: národní Core CPI má přednost před čerstvějším Tokyo Core CPI i BOJ Core CPI", () => {
  const events = [
    ev("JPY", "National Core CPI y/y", "2026-09-18", "1.7%"),
    ev("JPY", "BOJ Core CPI y/y", "2026-09-25", "1.8%"),
    ev("JPY", "Tokyo Core CPI y/y", "2026-10-02", "2.7%"),
  ];
  assert.equal(extractLatestCpi("JPY", events), 1.7);
});

test("JPY: bez národního údaje se chování nemění (fallback na dostupnou core variantu)", () => {
  const events = [ev("JPY", "Tokyo Core CPI y/y", "2026-10-02", "2.7%")];
  assert.equal(extractLatestCpi("JPY", events), 2.7);
});

const REF = [
  { currency: "CHF", cpi_yoy_pct: 1.0, release_date: "2026-10-01", max_age_dni: 50 },
  { currency: "NZD", cpi_yoy_pct: 4.1, release_date: "2026-07-21", max_age_dni: 110 },
];

test("záložní CPI: platné v rámci max_age_dni, po uplynutí se nepoužije (radši null než zastaralé)", () => {
  assert.equal(referenceCpiFallback(REF, "CHF", new Date("2026-10-09T00:00:00Z")), 1.0);
  assert.equal(referenceCpiFallback(REF, "NZD", new Date("2026-10-09T00:00:00Z")), 4.1);
  assert.equal(referenceCpiFallback(REF, "CHF", new Date("2026-11-25T00:00:00Z")), null); // 55 dní > 50
  assert.equal(referenceCpiFallback(REF, "NZD", new Date("2026-11-15T00:00:00Z")), null); // 117 dní > 110
  assert.equal(referenceCpiFallback(REF, "USD", new Date("2026-10-09T00:00:00Z")), null); // není v souboru
  assert.equal(referenceCpiFallback(REF, "CHF", new Date("2026-09-30T00:00:00Z")), null); // před vydáním
});

test("computeCbPolicyState: záložní CPI se použije jen na vyžádání a nepřebije CPI z kalendáře", () => {
  const rate = (c, day, v) => ev(c, c === "CHF" ? "SNB Policy Rate" : "Official Bank Rate", day, `${v}%`);
  const events = [
    rate("CHF", "2026-09-24", 0), rate("CHF", "2026-06-18", 0),
    rate("GBP", "2026-09-17", 3.75), rate("GBP", "2026-06-18", 3.75),
    ev("GBP", "CPI y/y", "2026-09-16", "3.1%"),
  ];
  const withoutRef = computeCbPolicyState("CHF", ["CHF", "GBP"], events);
  assert.equal(withoutRef.cpi, null);
  assert.equal(withoutRef.realYieldAdj, null);
  const RECENT = [{ currency: "CHF", cpi_yoy_pct: 1.0, release_date: new Date().toISOString().slice(0, 10), max_age_dni: 50 }];
  const withRef = computeCbPolicyState("CHF", ["CHF", "GBP"], events, { referenceCpi: RECENT });
  assert.equal(withRef.cpi, 1.0);
  assert.notEqual(withRef.realYieldAdj, null);
  const gbp = computeCbPolicyState("GBP", ["CHF", "GBP"], events, { referenceCpi: RECENT });
  assert.equal(gbp.cpi, 3.1); // CPI z kalendáře zůstává
});
