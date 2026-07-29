import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore } from "./fundamental-scoring.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCORED = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];
const NOW = new Date("2026-07-29T00:00:00Z");

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

function filterByWindow(events, maxAgeDays) {
  if (maxAgeDays === null) return events;
  const cutoff = NOW.getTime() - maxAgeDays * 86400000;
  return events.filter((e) => new Date(e.event_day).getTime() >= cutoff);
}

const allEvents = await fetchAllCalendarEvents();
const oldest = allEvents.reduce((min, e) => (e.event_day < min ? e.event_day : min), allEvents[0].event_day);
console.log(`Načteno ${allEvents.length} calendar_events, nejstarší event_day=${oldest} (${Math.round((NOW - new Date(oldest)) / 86400000)} dní zpět).\n`);

// ═══ ČÁST A: FUNDAMENTAL SCORE + CB POLICY — hloubka calendar_events okna ═══
const WINDOWS_A = [
  { label: "56d (původní, pre-backfill cron -42..+14)", days: 56 },
  { label: "180d (~6 měsíců)", days: 180 },
  { label: "365d (1 rok)", days: 365 },
  { label: "neomezeno (současný stav, ~350d)", days: null },
];

console.log("═══ ČÁST A: Fundamental Score + CB Policy podle hloubky okna ═══\n");
for (const w of WINDOWS_A) {
  const events = filterByWindow(allEvents, w.days);
  console.log(`--- okno: ${w.label} (${events.length} eventů) ---`);
  for (const ccy of SCORED) {
    const fs = computeFundamentalScore(ccy, events, NOW);
    const cb = computeCbPolicyState(ccy, SCORED, events);
    console.log(
      `  ${ccy}: fund=${fs.fundamentalScore} (conf ${fs.confidence}, ${fs.historyMonths}mo) | ` +
        `cb_score=${cb.policyScore} "${cb.policyLabel}" (${cb.policyConfidence}) | ` +
        `real_yield_adj=${cb.realYieldAdj} cb_policy_adj=${cb.cbPolicyAdj} | rate_hist=${cb.rateHistory.length}b`
    );
  }
  console.log("");
}

// ═══ ČÁST B: COT / RETAIL — citlivost na TRAILING_WEEKS ═══
// Kopie matematiky z scoring.mjs computeCotScore/cotPercentile, jen s parametrizovatelným
// oknem (produkční kód TRAILING_WEEKS nevystavuje jako argument — testujeme čistou matematiku
// nad reálnými daty, ne upravujeme produkci).
function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function stdev(arr, avg) { return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function cotScoreWithWindow(historyAsc, trailingWeeks) {
  const latest = historyAsc[historyAsc.length - 1];
  const trailing = historyAsc.slice(Math.max(0, historyAsc.length - 1 - trailingWeeks), historyAsc.length - 1);
  const trailingNets = trailing.map((r) => r.lev_money_net);
  let zscore = 0;
  if (trailingNets.length >= 8) {
    const avg = mean(trailingNets);
    const sd = stdev(trailingNets, avg);
    zscore = sd === 0 ? 0 : (latest.lev_money_net - avg) / sd;
  }
  const scaledZ = clamp(zscore, -3, 3) * (5 / 3);
  return { zscore: Math.round(zscore * 100) / 100, n: trailingNets.length };
}

function percentileWithWindow(historyAsc, trailingWeeks) {
  const trailing = historyAsc.slice(Math.max(0, historyAsc.length - 1 - trailingWeeks), historyAsc.length);
  if (trailing.length < 12) return null;
  const latest = trailing[trailing.length - 1].lev_money_net;
  const rest = trailing.slice(0, -1).map((r) => r.lev_money_net);
  return Math.round((rest.filter((v) => v <= latest).length / rest.length) * 100);
}

console.log("═══ ČÁST B: COT z-skóre/percentil podle délky TRAILING_WEEKS ═══\n");
const WEEK_WINDOWS = [52, 104, 156, 201];
for (const ccy of SCORED) {
  const { data: rows } = await supabase
    .from("cot_reports")
    .select("report_date, lev_money_long, lev_money_short")
    .eq("currency_code", ccy)
    .eq("report_type", "TFF_FUT")
    .order("report_date", { ascending: true });
  if (!rows || rows.length === 0) continue;
  const historyAsc = rows.map((r) => ({ report_date: r.report_date, lev_money_net: r.lev_money_long - r.lev_money_short }));

  const results = WEEK_WINDOWS.map((w) => {
    const z = cotScoreWithWindow(historyAsc, w);
    const p = percentileWithWindow(historyAsc, w);
    return `w=${w}: z=${z.zscore}(n=${z.n}) pct=${p}`;
  });
  console.log(`  ${ccy} (${rows.length} týdnů dostupných): ${results.join(" | ")}`);
}

// ═══ ČÁST C: Regime-shift kontrola — liší se distribuce lev_money_net v rané vs. nedávné historii? ═══
console.log("\n═══ ČÁST C: Regime shift — mean/stdev lev_money_net, nejstarších 52t vs. nejnovějších 52t ═══\n");
for (const ccy of SCORED) {
  const { data: rows } = await supabase
    .from("cot_reports")
    .select("report_date, lev_money_long, lev_money_short")
    .eq("currency_code", ccy)
    .eq("report_type", "TFF_FUT")
    .order("report_date", { ascending: true });
  if (!rows || rows.length < 104) { console.log(`  ${ccy}: nedostatek dat pro regime-shift test`); continue; }
  const nets = rows.map((r) => r.lev_money_long - r.lev_money_short);
  const oldest52 = nets.slice(0, 52);
  const newest52 = nets.slice(-52);
  const mOld = mean(oldest52), sdOld = stdev(oldest52, mOld);
  const mNew = mean(newest52), sdNew = stdev(newest52, mNew);
  const meanShift = Math.round((mNew - mOld));
  const sdRatio = Math.round((sdNew / sdOld) * 100) / 100;
  console.log(
    `  ${ccy}: nejstarších 52t mean=${Math.round(mOld)} sd=${Math.round(sdOld)} | nejnovějších 52t mean=${Math.round(mNew)} sd=${Math.round(sdNew)} | ` +
      `posun průměru=${meanShift >= 0 ? "+" : ""}${meanShift} kontraktů, poměr volatility=${sdRatio}x`
  );
}
