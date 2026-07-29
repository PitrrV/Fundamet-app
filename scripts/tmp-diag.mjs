import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore } from "./fundamental-scoring.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCORED = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];
const FOCUS = ["USD", "AUD", "EUR", "GBP"];
const NOW = new Date("2026-07-29T00:00:00Z");
const AS_OF_DAYS_AGO = [300, 220, 140, 60, 0];

async function fetchAllCalendarEvents() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, currency_code, event_title, event_day, actual, estimate, previous")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function filterByAsOf(events, asOf) {
  return events.filter((e) => new Date(e.event_day).getTime() <= asOf.getTime());
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events.\n`);
console.log("=== OVĚŘENÍ PRODUKČNÍHO KÓDU (skutečný export z fundamental-scoring.mjs, ne kopie) ===\n");

console.log("--- Historická validace proti reálné CB Policy kotvě ---");
for (const ccy of FOCUS) {
  console.log(`\n${ccy}:`);
  console.log("dní zpět | CB Policy (kotva)                          | fundamentalScore | confidence | historyMonths");
  for (const daysAgo of AS_OF_DAYS_AGO) {
    const asOf = new Date(NOW.getTime() - daysAgo * 86400000);
    const eventsUpTo = filterByAsOf(allEvents, asOf);
    const cb = computeCbPolicyState(ccy, SCORED, eventsUpTo);
    const result = computeFundamentalScore(ccy, eventsUpTo, asOf);
    console.log(`${String(daysAgo).padStart(4)} (${asOf.toISOString().slice(0, 10)}) | ${cb.policyLabel.padEnd(43)} | ${result.fundamentalScore.toFixed(2).padStart(6)}          | ${result.confidence}     | ${result.historyMonths}`);
  }
}

console.log("\n--- Diferenciace mezi 8 měnami dnes (rawScore = po tlumení, PŘED confidence) ---");
const finalScores = [];
for (const ccy of SCORED) {
  const result = computeFundamentalScore(ccy, allEvents, NOW);
  finalScores.push(result.fundamentalScore);
  console.log(`${ccy}: fundamentalScore=${result.fundamentalScore} rawScore(scaledRaw)=${result.rawScore} confidence=${result.confidence}`);
}
function stdev(arr) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
console.log(`\nsd=${stdev(finalScores).toFixed(2)}, min=${Math.min(...finalScores)}, max=${Math.max(...finalScores)}`);

console.log("\n--- Kontrola determinismu: stejný vstup 2x, musí vyjít bitově stejně ---");
let detOk = true;
for (const ccy of SCORED) {
  const r1 = computeFundamentalScore(ccy, allEvents, NOW);
  const r2 = computeFundamentalScore(ccy, allEvents, NOW);
  const same = JSON.stringify(r1) === JSON.stringify(r2);
  if (!same) detOk = false;
  console.log(`  ${ccy}: shodné=${same}`);
}
console.log(`Determinismus: ${detOk ? "PROŠEL" : "SELHAL"}`);
