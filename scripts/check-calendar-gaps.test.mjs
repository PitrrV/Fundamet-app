// Testy hlídače děr v kalendáři. node --test scripts/check-calendar-gaps.test.mjs (nebo `npm test`).
import test from "node:test";
import assert from "node:assert/strict";
import { weekStart, weeklyCounts, findThinWeeks, findRateGaps, formatFindings } from "./check-calendar-gaps.mjs";

// Skutečné počty událostí po týdnech z produkční DB (stav z 10. 10. 2026 PŘED opravou červnové díry).
const REAL_WEEKS = {
  "2025-10-06": 61, "2025-10-13": 97, "2025-10-20": 86, "2025-10-27": 87, "2025-11-03": 118, "2025-11-10": 99,
  "2025-11-17": 118, "2025-11-24": 80, "2025-12-01": 106, "2025-12-08": 92, "2025-12-15": 128, "2025-12-22": 50,
  "2025-12-29": 47, "2026-01-05": 94, "2026-01-12": 100, "2026-01-19": 105, "2026-01-26": 84, "2026-02-02": 106,
  "2026-02-09": 87, "2026-02-16": 133, "2026-02-23": 83, "2026-03-02": 121, "2026-03-09": 91, "2026-03-16": 101,
  "2026-03-23": 87, "2026-03-30": 107, "2026-04-06": 88, "2026-04-13": 97, "2026-04-20": 85, "2026-04-27": 113,
  "2026-05-04": 114, "2026-05-11": 93, "2026-05-18": 114, "2026-05-25": 99, "2026-06-01": 117, "2026-06-08": 17,
  "2026-06-15": 74, "2026-06-22": 91, "2026-06-29": 107, "2026-07-06": 75, "2026-07-13": 97, "2026-07-20": 73,
  "2026-07-27": 98, "2026-08-03": 103, "2026-08-10": 88, "2026-08-17": 106, "2026-08-24": 75, "2026-08-31": 118,
  "2026-09-07": 94, "2026-09-14": 116, "2026-09-21": 91, "2026-09-28": 159, "2026-10-05": 78,
};
const toMap = (o) => new Map(Object.entries(o));

test("weekStart: pondělí týdne", () => {
  assert.equal(weekStart("2026-06-10"), "2026-06-08"); // středa
  assert.equal(weekStart("2026-06-14"), "2026-06-08"); // neděle
  assert.equal(weekStart("2026-06-08"), "2026-06-08");
});

test("weeklyCounts spočítá události po týdnech", () => {
  const m = weeklyCounts([{ event_day: "2026-06-08" }, { event_day: "2026-06-12" }, { event_day: "2026-06-15" }]);
  assert.equal(m.get("2026-06-08"), 2);
  assert.equal(m.get("2026-06-15"), 1);
});

test("řídký týden: na skutečných datech označí PŘESNĚ díru z 8. 6. a nic dalšího (vánoce, začátek dat ani rozpracovaný týden)", () => {
  const { thin } = findThinWeeks(toMap(REAL_WEEKS), "2026-10-10");
  assert.deepEqual(thin.map((t) => t.week), ["2026-06-08"]);
  assert.equal(thin[0].count, 17);
});

test("po opravě díry (73 událostí) už hlídač mlčí", () => {
  const fixed = { ...REAL_WEEKS, "2026-06-08": 73 };
  assert.deepEqual(findThinWeeks(toMap(fixed), "2026-10-10").thin, []);
});

test("málo dat pro základ (méně než 8 dokončených týdnů) → nehlásí nic", () => {
  assert.deepEqual(findThinWeeks(toMap({ "2026-09-07": 90, "2026-09-14": 5, "2026-09-21": 90 }), "2026-10-10").thin, []);
});

const H = (...d) => d.map((date) => ({ date, rate: 1 }));
const TODAY = "2026-10-10";

// Historie sazeb PŘED opravou (chybí červnová zasedání) — skutečné datumy z produkce.
const PRE_FIX = {
  EUR: H("2025-10-30", "2025-12-18", "2026-02-05", "2026-03-19", "2026-04-30", "2026-07-23", "2026-09-10"),
  JPY: H("2025-10-30", "2025-12-19", "2026-01-23", "2026-03-19", "2026-04-28", "2026-07-31", "2026-09-18"),
  CAD: H("2025-10-29", "2025-12-10", "2026-01-28", "2026-03-18", "2026-04-29", "2026-07-15", "2026-09-02"),
};
// Historie PO opravě + ostatní banky (kompletní).
const POST_FIX = {
  EUR: H("2025-10-30", "2025-12-18", "2026-02-05", "2026-03-19", "2026-04-30", "2026-06-11", "2026-07-23", "2026-09-10"),
  JPY: H("2025-10-30", "2025-12-19", "2026-01-23", "2026-03-19", "2026-04-28", "2026-06-16", "2026-07-31", "2026-09-18"),
  CAD: H("2025-10-29", "2025-12-10", "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-10", "2026-07-15", "2026-09-02"),
  GBP: H("2025-11-06", "2025-12-18", "2026-02-05", "2026-03-19", "2026-04-30", "2026-06-18", "2026-07-30", "2026-09-17"),
  USD: H("2025-10-29", "2025-12-10", "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16"),
  AUD: H("2025-11-04", "2025-12-09", "2026-02-03", "2026-03-17", "2026-05-05", "2026-06-16", "2026-08-11", "2026-09-29"),
  NZD: H("2025-10-08", "2025-11-26", "2026-02-18", "2026-04-08", "2026-05-27", "2026-07-08", "2026-09-02"), // 84denní letní pauza je legitimní
  CHF: H("2025-12-11", "2026-03-19", "2026-06-18", "2026-09-24"), // čtvrtletní SNB
};

test("díra v rozhodnutích: před opravou označí ECB, BoJ i BoC", () => {
  const gaps = findRateGaps(PRE_FIX, TODAY);
  assert.deepEqual(gaps.map((g) => [g.currency, g.days]).sort(), [["CAD", 77], ["EUR", 84], ["JPY", 94]]);
});

test("díra v rozhodnutích: kompletní historie všech 8 bank = žádný falešný poplach (vč. letní pauzy RBNZ a čtvrtletní SNB)", () => {
  assert.deepEqual(findRateGaps(POST_FIX, TODAY), []);
});

test("poslední rozhodnutí je příliš staré (chybí další zasedání)", () => {
  const gaps = findRateGaps({ EUR: POST_FIX.EUR }, "2026-12-01"); // ECB 29. 10. by už mělo být v datech
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].kind, "since_last");
  assert.equal(gaps[0].days, 82);
});

test("formatFindings: srozumitelné české věty", () => {
  const lines = formatFindings({ thin: [{ week: "2026-06-08", count: 17, median: 94, ratio: 0.18 }], rateGaps: findRateGaps({ EUR: PRE_FIX.EUR }, TODAY) });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /17 událostí/);
  assert.match(lines[1], /EUR/);
});
