// Unit testy pro autoDetectPolicy() — P0.1 z nezávislého reportu (Cowork, 21.9.2026).
// node --test scripts/cb-policy.test.mjs (nebo `npm test`).

import test from "node:test";
import assert from "node:assert/strict";
import { autoDetectPolicy } from "./cb-policy.mjs";

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
