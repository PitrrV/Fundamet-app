import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeAgainstHistory,
  computeAbsoluteFundamental,
  computeRelativeFundamental,
  computeTrajectory,
  classifyDataQuality,
  extractLatestUnemployment,
  extractLatestGrowth,
  extractLatestRetailSales,
  extractInflationHistory,
  isNationalEuroTitle,
  STATE_BLOCKS,
  MIN_HISTORY_N,
  CB_INFLATION_TARGET,
} from "./shadow-fundamental-engine.mjs";
import { findNearestUpcoming } from "./shadow-expectations.mjs";

const HIST8 = [2.0, 2.1, 1.9, 2.0, 2.2, 1.8, 2.0, 2.1]; // 8 pozorování, mean ~2.01
const HIST7 = HIST8.slice(0, 7);

// 1. Inflation: raw nad CB target -> kladná normalized hodnota (fixedReference, bez flipu)
test("1. inflation above target -> positive normalized", () => {
  const r = normalizeAgainstHistory(4.0, HIST8, { fixedReference: CB_INFLATION_TARGET.USD, flipSign: false });
  assert.ok(r.normalized > 0);
});

// 2. Inflation: raw pod CB target -> záporná normalized hodnota
test("2. inflation below target -> negative normalized", () => {
  const r = normalizeAgainstHistory(0.5, HIST8, { fixedReference: CB_INFLATION_TARGET.USD, flipSign: false });
  assert.ok(r.normalized < 0);
});

// 3. Labor: nezaměstnanost NAD vlastním průměrem -> ZÁPORNÁ normalized (flip, slabší trh práce)
test("3. unemployment above own mean -> negative normalized (flip applied)", () => {
  const highUnemployment = [4.0, 4.1, 3.9, 4.0, 4.2, 3.8, 4.0, 4.1];
  const r = normalizeAgainstHistory(5.5, highUnemployment, { fixedReference: null, flipSign: true });
  assert.ok(r.normalized < 0);
});

// 4. Labor: nezaměstnanost POD vlastním průměrem -> KLADNÁ normalized (flip, silnější trh práce)
test("4. unemployment below own mean -> positive normalized (flip applied)", () => {
  const highUnemployment = [4.0, 4.1, 3.9, 4.0, 4.2, 3.8, 4.0, 4.1];
  const r = normalizeAgainstHistory(2.5, highUnemployment, { fixedReference: null, flipSign: true });
  assert.ok(r.normalized > 0);
});

// 5. Growth: nad vlastním průměrem -> kladná (žádný flip)
test("5. growth above own mean -> positive normalized", () => {
  const r = normalizeAgainstHistory(3.0, HIST8, { fixedReference: null, flipSign: false });
  assert.ok(r.normalized > 0);
});

// 6. Demand: pod vlastním průměrem -> záporná (žádný flip)
test("6. retail sales below own mean -> negative normalized", () => {
  const r = normalizeAgainstHistory(0.2, HIST8, { fixedReference: null, flipSign: false });
  assert.ok(r.normalized < 0);
});

// 7. PMI: fixedReference=50, nad 50 -> kladná, pod 50 -> záporná
test("7. PMI above/below fixed reference 50", () => {
  const pmiHist = [51, 50.5, 49.8, 50.2, 49.5, 50.8, 50.1, 49.9];
  const above = normalizeAgainstHistory(53, pmiHist, { fixedReference: 50, flipSign: false });
  const below = normalizeAgainstHistory(47, pmiHist, { fixedReference: 50, flipSign: false });
  assert.ok(above.normalized > 0);
  assert.ok(below.normalized < 0);
});

// 8. N_available: méně než MIN_HISTORY_N -> normalized musí být null
test("8. history below MIN_HISTORY_N -> normalized is null", () => {
  assert.equal(HIST7.length, MIN_HISTORY_N - 1);
  const r = normalizeAgainstHistory(2.5, HIST7, { fixedReference: null, flipSign: false });
  assert.equal(r.normalized, null);
});

// 9. N_available: přesně MIN_HISTORY_N -> normalized se počítá (není null)
test("9. history at MIN_HISTORY_N -> normalized computed", () => {
  const r = normalizeAgainstHistory(2.5, HIST8, { fixedReference: null, flipSign: false });
  assert.notEqual(r.normalized, null);
});

// 10. Real Yield nikdy nevstupuje do Absolute Fundamental Condition — STATE_BLOCKS neobsahuje 'real_yield'
test("10. real_yield excluded from STATE_BLOCKS (Absolute Fundamental Condition)", () => {
  assert.ok(!STATE_BLOCKS.includes("real_yield"));
  assert.deepEqual(STATE_BLOCKS, ["inflation", "labor", "growth", "demand", "pmi"]);
});

// 11. Absolute: méně než MIN_BLOCKS_REQUIRED (4 z 5) dostupných -> null
test("11. absolute fundamental null when fewer than 4 of 5 blocks available", () => {
  const r = computeAbsoluteFundamental({ inflation: 1, labor: -0.5, growth: null, demand: null, pmi: null });
  assert.equal(r.absolute, null);
  assert.equal(r.blocksUsed, 2);
});

// 12. Absolute: >= 4 z 5 dostupných -> spočítá se jako průměr
test("12. absolute fundamental computed as average when >=4 blocks available", () => {
  const r = computeAbsoluteFundamental({ inflation: 1, labor: -1, growth: 2, demand: 0, pmi: null });
  assert.equal(r.blocksUsed, 4);
  assert.equal(r.absolute, 0.5); // (1 + -1 + 2 + 0) / 4
});

// 13. Relative vyžaduje Absolute: currency s absolute=null -> relative=null, rank=null
test("13. relative is null when currency's own absolute is null", () => {
  const r = computeRelativeFundamental("JPY", { USD: 1.0, EUR: 0.5, JPY: null });
  assert.equal(r.relative, null);
  assert.equal(r.rank, null);
  assert.ok(r.basketMean !== null); // basket mean se počítá z DOSTUPNÝCH ostatních měn
});

// 14. Relative matematika: relative = currency_absolute - basket_mean, přesný výpočet
test("14. relative = absolute - basketMean exact arithmetic", () => {
  const absoluteByCode = { USD: 2.0, EUR: 1.0, JPY: -1.0, GBP: 0.0 };
  const r = computeRelativeFundamental("USD", absoluteByCode);
  const expectedMean = (2.0 + 1.0 - 1.0 + 0.0) / 4;
  assert.equal(r.basketMean, Math.round(expectedMean * 100) / 100);
  assert.equal(r.relative, Math.round((2.0 - expectedMean) * 100) / 100);
});

// 15. Relative rank: ordinální, nejsilnější = 1
test("15. relative rank ordinal, strongest = 1", () => {
  const absoluteByCode = { USD: 2.0, EUR: 1.0, JPY: -1.0, GBP: 0.0 };
  assert.equal(computeRelativeFundamental("USD", absoluteByCode).rank, 1);
  assert.equal(computeRelativeFundamental("JPY", absoluteByCode).rank, 4);
});

// 16. EUR agregát vs. národní — Unemployment: appka musí vybrat "Unemployment Rate" (agregát),
// NIKDY "Spanish Unemployment Rate"/"Italian Quarterly Unemployment Rate" (národní podkomponenty)
test("16. EUR unemployment picks EA aggregate, excludes national components", () => {
  const events = [
    { currency_code: "EUR", event_title: "Spanish Unemployment Rate", event_day: "2026-09-30", actual: "10.5" },
    { currency_code: "EUR", event_title: "Italian Quarterly Unemployment Rate", event_day: "2026-09-28", actual: "6.0" },
    { currency_code: "EUR", event_title: "Unemployment Rate", event_day: "2026-09-25", actual: "6.3" },
  ];
  const r = extractLatestUnemployment("EUR", events);
  assert.equal(r.title, "Unemployment Rate");
  assert.equal(r.value, 6.3);
  assert.ok(!isNationalEuroTitle(r.title));
});

// 17. EUR agregát vs. národní — Growth: appka musí vybrat EA-agregátní GDP titul, ne
// "German Prelim GDP q/q"/"French Flash GDP q/q" (národní podkomponenty)
test("17. EUR growth picks EA aggregate GDP, excludes national components", () => {
  const events = [
    { currency_code: "EUR", event_title: "German Prelim GDP q/q", event_day: "2026-09-30", actual: "0.5" },
    { currency_code: "EUR", event_title: "Revised GDP q/q", event_day: "2026-09-07", actual: "0.3" },
  ];
  const r = extractLatestGrowth("EUR", events);
  assert.equal(r.title, "Revised GDP q/q");
  assert.equal(r.value, 0.3);
});

// Regresní test — živě odhaleno při dry-run 2026-09-22: extractLatestCpi (cb-policy.mjs, reuse
// beze změny) sama o sobě NEVYLUČUJE EUR národní CPI tituly ("Spanish Flash CPI y/y" apod.),
// protože v produkci je jediná EUR alternativa "CPI Flash Estimate y/y" (agregát) obvykle novější
// než národní — ale to NENÍ zaručené. extractInflationHistory proto MUSÍ filtrovat vstupní pole
// eventů PŘED voláním extractLatestCpi (viz komentář v extractInflationHistory), ne spoléhat na
// to, že agregát náhodou vyjde jako poslední.
test("16b. EUR inflation history never includes national CPI titles, even when they are the newest y/y CPI print", () => {
  const events = [
    { currency_code: "EUR", event_title: "Final CPI y/y", event_day: "2026-08-19", actual: "2.9" },
    // Národní tisk vychází PO agregátu a je numericky odlišný — pokud by appka nefiltrovala
    // vstup, extractLatestCpi (jen "nejnovější y/y CPI titul") by ho omylem vybrala.
    { currency_code: "EUR", event_title: "Spanish Flash CPI y/y", event_day: "2026-08-28", actual: "4.3" },
  ];
  const history = extractInflationHistory("EUR", events);
  assert.equal(history.length, 1);
  assert.equal(history[0].title, "Final CPI y/y");
  assert.equal(history[0].value, 2.9);
});

// 18. Future-event exclusion — findNearestUpcoming nikdy nevrátí event s event_day < today
test("18. findNearestUpcoming excludes past events", () => {
  const events = [
    { currency_code: "USD", event_title: "CPI y/y", event_day: "2020-01-01", actual: null, estimate: "3.0" },
    { currency_code: "USD", event_title: "CPI y/y", event_day: "2099-01-01", actual: null, estimate: "3.2" },
  ];
  const r = findNearestUpcoming("USD", "Inflation", events, "2026-09-22");
  assert.equal(r.event_day, "2099-01-01");
});

// 19. GDP vintage dedup — mezi Advance/Prelim/Final téže čtvrtky appka vybere tu s NEJNOVĚJŠÍM
// event_day (nejúplnější dostupnou vintage), ne fabrikovaný průměr přes vintages
test("19. GDP vintage dedup picks latest event_day (most-final vintage), not an average", () => {
  const events = [
    { currency_code: "USD", event_title: "Advance GDP q/q", event_day: "2026-07-30", actual: "3.0" },
    { currency_code: "USD", event_title: "Prelim GDP q/q", event_day: "2026-08-26", actual: "3.3" },
    { currency_code: "USD", event_title: "Final GDP q/q", event_day: "2026-09-30", actual: "3.8" },
  ];
  const r = extractLatestGrowth("USD", events);
  assert.equal(r.title, "Final GDP q/q");
  assert.equal(r.value, 3.8);
  assert.equal(r.vintage, "final");
});

// 20. classifyDataQuality prahy: přesně HIGH/MEDIUM/LOW/INSUFFICIENT
test("20. classifyDataQuality tier thresholds", () => {
  const full = { inflation: 1, labor: 1, growth: 1, demand: 1, pmi: 1 };
  const four = { inflation: 1, labor: 1, growth: 1, demand: 1, pmi: null };
  const two = { inflation: 1, labor: 1, growth: null, demand: null, pmi: null };
  const one = { inflation: 1, labor: null, growth: null, demand: null, pmi: null };
  assert.equal(classifyDataQuality(full, 0.2), "HIGH");
  assert.equal(classifyDataQuality(full, null), "MEDIUM"); // 5 bloků, ale bez real yield -> ne HIGH
  assert.equal(classifyDataQuality(four, 0.2), "MEDIUM");
  assert.equal(classifyDataQuality(two, null), "LOW");
  assert.equal(classifyDataQuality(one, null), "INSUFFICIENT");
});

// 21. Izolace od produkce — shadow moduly nikdy neodkazují na COT/retail/VIX/scoring.mjs/
// market-regime.mjs ani nezapisují do produkčních tabulek (confluence_scores, currency_thesis,
// fundamental_scores, cb_policy_state)
test("21. shadow modules never reference COT/retail/VIX or write to production tables", () => {
  const files = ["shadow-fundamental-engine.mjs", "shadow-expectations.mjs", "run-shadow-engine.mjs"];
  const forbidden = [
    /from ["']\.\/scoring\.mjs["']/i,
    /from ["']\.\/market-regime\.mjs["']/i,
    /cot_score/i,
    /cot_flow/i,
    /retail_score/i,
    /\bvix\b/i,
    /\.from\(["']confluence_scores["']\)/,
    /\.from\(["']currency_thesis["']\)/,
    /\.from\(["']fundamental_scores["']\)/,
    /\.from\(["']cb_policy_state["']\)/,
  ];
  for (const file of files) {
    const raw = readFileSync(new URL(file, import.meta.url), "utf8");
    // Skenuje jen KÓD, ne komentáře — soubor legitimně v komentářích VYSVĚTLUJE, že VIX/COT/
    // retail sem nevstupují (viz hlavička shadow-fundamental-engine.mjs), což by jinak samo
    // spustilo falešně pozitivní nález.
    const codeOnly = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(codeOnly), `${file} obsahuje zakázaný odkaz: ${pattern}`);
    }
  }
});

test("trajectory: null when no prior normalized value", () => {
  assert.equal(computeTrajectory(1.0, null), null);
  assert.equal(computeTrajectory(null, 1.0), null);
  assert.equal(computeTrajectory(1.5, 1.0), 0.5);
});

test("extractLatestRetailSales excludes Core/BRC/national variants", () => {
  const events = [
    { currency_code: "GBP", event_title: "BRC Retail Sales Monitor y/y", event_day: "2026-09-08", actual: "2.0" },
    { currency_code: "GBP", event_title: "Retail Sales m/m", event_day: "2026-09-01", actual: "0.4" },
  ];
  const r = extractLatestRetailSales("GBP", events);
  assert.equal(r.title, "Retail Sales m/m");
});
