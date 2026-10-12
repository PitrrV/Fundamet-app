import test from "node:test";
import assert from "node:assert/strict";
import { selectScenarioSeeds, validateAgenda, MAX_AGENDA_ITEMS, MAX_RESOLVED_ITEMS } from "./agenda.mjs";

const ev = (date, title, actual = null, extra = {}) => ({ date, title, actual, estimate: "1.0", previous: "0.9", ...extra });
const TODAY = "2026-10-12";

// Živý případ USD: 7 zveřejněných a 1 nadcházející vytlačilo CPI z 14. 10.
const usd = [
  ev("2026-10-08", "Unemployment Rate", "4.2"),
  ev("2026-10-08", "Non-Farm Employment Change", "29"),
  ev("2026-10-09", "Average Hourly Earnings m/m", "0.1"),
  ev("2026-10-09", "Retail Sales m/m", "1.2"),
  ev("2026-10-10", "Prelim GDP q/q", "2.2"),
  ev("2026-10-10", "ISM Services PMI", "54.7"),
  ev("2026-10-11", "Core PCE Price Index m/m", "0.3"),
  ev("2026-10-14", "Core CPI m/m"),
  ev("2026-10-14", "CPI y/y"),
  ev("2026-10-28", "Federal Funds Rate"),
  ev("2026-10-29", "Advance GDP q/q"),
  ev("2026-10-30", "Core PCE Price Index m/m"),
];

test("zveřejněné události zabírají nejvýš 2 místa a nadcházející se vejdou", () => {
  const seeds = selectScenarioSeeds(usd, TODAY);
  assert.ok(seeds.length <= MAX_AGENDA_ITEMS);
  assert.ok(seeds.filter((s) => s.actual).length <= MAX_RESOLVED_ITEMS);
  const titles = seeds.map((s) => s.title);
  assert.ok(titles.includes("Federal Funds Rate"));
  assert.ok(titles.some((t) => /CPI/.test(t) && !seeds.find((s) => s.title === t).actual), "CPI 14. 10. musí být v agendě");
  assert.ok(seeds.filter((s) => !s.actual).length >= 4);
});

test("výsledek je chronologicky řazený", () => {
  const seeds = selectScenarioSeeds(usd, TODAY);
  const dates = seeds.map((s) => s.date);
  assert.deepEqual(dates, [...dates].sort());
});

test("minulá událost bez výsledku se nezobrazuje jako nadcházející", () => {
  const seeds = selectScenarioSeeds([ev("2026-10-09", "Retail Sales m/m", null), ev("2026-10-15", "CPI y/y")], TODAY);
  assert.deepEqual(seeds.map((s) => s.title), ["CPI y/y"]);
});

test("události bez váhy se vynechají", () => {
  assert.equal(selectScenarioSeeds([ev("2026-10-15", "Bank Holiday")], TODAY).length, 0);
});

test("hlavní ukazatel kategorie má přednost před týdenními žádostmi a PPI", () => {
  const seeds = selectScenarioSeeds(
    [
      ev("2026-10-15", "Unemployment Claims"),
      ev("2026-10-15", "Unemployment Rate"),
      ev("2026-10-13", "PPI y/y"),
      ev("2026-10-22", "National Core CPI y/y"),
    ],
    TODAY
  );
  const titles = seeds.map((s) => s.title);
  assert.ok(titles.includes("Unemployment Rate") && titles.includes("National Core CPI y/y"));
  assert.equal(seeds.length, 4, "zbylé sloty se doplní i méně důležitými");
});

test("CPI y/y (vstup do skóre) předběhne jádrové m/m a stejný ukazatel se neopakuje", () => {
  const seeds = selectScenarioSeeds(
    [
      ev("2026-10-14", "Core CPI m/m"),
      ev("2026-10-14", "CPI y/y"),
      ev("2026-10-08", "Unemployment Claims", "197K"),
      ev("2026-10-15", "Unemployment Claims"),
    ],
    TODAY
  );
  const titles = seeds.map((s) => s.title);
  assert.ok(titles.includes("CPI y/y"));
  assert.equal(titles.filter((t) => t === "Unemployment Claims").length, 1);
});

const seeds = [ev("2026-10-14", "CPI y/y", null, { estimate: null }), ev("2026-10-10", "Retail Sales m/m", "1.2")];
const item = (o) => ({
  event: "CPI y/y", date: "2026-10-14", tier: "klíčový",
  why_it_matters: "Test inflace pro tezi o reálném výnosu.",
  market_expectation: "Konsenzus zatím nemáme, bez konsenzu.",
  thesis_test: "Vyšší inflace by tezi potvrdila.",
  reaction: "silná", reaction_note: "Zacenění je zatím nejasné.", outcome: null, ...o,
});
const done = item({ event: "Retail Sales m/m", date: "2026-10-10", tier: "druhořadý", market_expectation: "Čekalo se 1,0 %.", outcome: "Maloobchod vyšel 1,2 % nad odhadem, což tezi o silné spotřebě potvrzuje." });

test("platná agenda projde", () => assert.deepEqual(validateAgenda([item(), done], seeds), []));
test("chybějící událost je chyba", () => assert.ok(validateAgenda([item()], seeds).some((p) => /chybí/.test(p))));
test("událost mimo výběr je chyba", () =>
  assert.ok(validateAgenda([item(), done, item({ event: "Vymyšlené", date: "2026-10-20" })], seeds).some((p) => /mimo výběr/.test(p))));
test("outcome u nevyšlé události je chyba", () =>
  assert.ok(validateAgenda([item({ outcome: "Už vyšlo." }), done], seeds).some((p) => /outcome musí být null/.test(p))));
test("holý outcome u vyšlé události je chyba", () =>
  assert.ok(validateAgenda([item(), { ...done, outcome: "beat" }], seeds).some((p) => /celá věta/.test(p))));
test("čísla u události bez konsenzu bez poznámky jsou chyba", () =>
  assert.ok(validateAgenda([item({ market_expectation: "Čeká se 3,1 % z 3,0 %." }), done], seeds).some((p) => /konsenzus v datech není/.test(p))));
