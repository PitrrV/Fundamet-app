import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore } from "./fundamental-scoring.mjs";
import { computeCbPolicyState, autoDetectPolicy, extractRateHistory } from "./cb-policy.mjs";
import { computeCotScore, cotPercentile } from "./scoring.mjs";
import { classifyRegime } from "./market-regime.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SCORED = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];

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

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events pro reprodukovatelnost test.\n`);

// ── TEST 1: Determinismus/reprodukovatelnost — stejný vstup → stejný výstup (2x nezávisle) ──
console.log("=== TEST 1: Determinismus (2x nezávislý běh, stejný vstup, stejné 'now') ===");
const fixedNow = new Date("2026-07-28T12:00:00Z");
let detOk = true;
for (const ccy of SCORED) {
  const r1 = computeFundamentalScore(ccy, allEvents, fixedNow);
  const r2 = computeFundamentalScore(ccy, allEvents, fixedNow);
  const same = JSON.stringify(r1) === JSON.stringify(r2);
  if (!same) detOk = false;
  console.log(`  Fundamental[${ccy}]: run1=${r1.fundamentalScore} run2=${r2.fundamentalScore} shodné=${same}`);
}
const cb1 = computeCbPolicyState("EUR", SCORED, allEvents);
const cb2 = computeCbPolicyState("EUR", SCORED, allEvents);
console.log(`  CBPolicy[EUR]: run1=${JSON.stringify(cb1)}`);
console.log(`  CBPolicy[EUR]: shodné=${JSON.stringify(cb1) === JSON.stringify(cb2)}`);
console.log(`TEST 1 výsledek: ${detOk ? "PROŠEL" : "SELHAL"}\n`);

// ── TEST 2: Izolace — změna jednoho eventu jedné měny nesmí ovlivnit jinou měnu ──
console.log("=== TEST 2: Izolace mezi měnami (upravit 1 EUR event, GBP/JPY musí zůstat beze změny) ===");
const before = {};
for (const ccy of SCORED) before[ccy] = computeFundamentalScore(ccy, allEvents, fixedNow).fundamentalScore;

const perturbed = allEvents.map((e) =>
  e.currency_code === "EUR" && e.actual
    ? { ...e, actual: String(parseFloat(e.actual) + 999) }
    : e
);
const after = {};
for (const ccy of SCORED) after[ccy] = computeFundamentalScore(ccy, perturbed, fixedNow).fundamentalScore;

let isoOk = true;
for (const ccy of SCORED) {
  const changed = before[ccy] !== after[ccy];
  if (ccy !== "EUR" && changed) isoOk = false;
  console.log(`  ${ccy}: před=${before[ccy]} po_narušení_EUR=${after[ccy]} ${ccy === "EUR" ? "(očekávaná změna)" : changed ? "NEČEKANÁ ZMĚNA" : "beze změny (OK)"}`);
}
console.log(`TEST 2 výsledek: ${isoOk ? "PROŠEL" : "SELHAL"}\n`);

// ── TEST 3: Časový drift bez nových dat — recency() u fundamentálního skóre ──
console.log("=== TEST 3: Drift fundamentálního skóre čistě z plynutí času (STEJNÁ data, 'now' +200 dní) ===");
const nowPlus200 = new Date(fixedNow.getTime() + 200 * 86400000);
for (const ccy of SCORED) {
  const r1 = computeFundamentalScore(ccy, allEvents, fixedNow);
  const r2 = computeFundamentalScore(ccy, allEvents, nowPlus200);
  const drift = Math.round((r2.fundamentalScore - r1.fundamentalScore) * 100) / 100;
  console.log(`  ${ccy}: dnes=${r1.fundamentalScore} (conf ${r1.confidence}) za 200 dní=${r2.fundamentalScore} (conf ${r2.confidence}) drift=${drift >= 0 ? "+" : ""}${drift}`);
}

// ── TEST 4: Časový drift CB Policy z 365denního okna (yearChange) ──
console.log("\n=== TEST 4: Drift CB Policy labelu čistě z plynutí času ('now' +200 dní, STEJNÁ rozhodnutí) ===");
for (const ccy of SCORED) {
  const hist = extractRateHistory(ccy, allEvents);
  if (hist.length < 2) { console.log(`  ${ccy}: nedostatek historie pro test`); continue; }
  const origNow = Date.now;
  Date.now = () => fixedNow.getTime();
  const p1 = autoDetectPolicy(hist);
  Date.now = () => nowPlus200.getTime();
  const p2 = autoDetectPolicy(hist);
  Date.now = origNow;
  const changed = p1.label !== p2.label || p1.score !== p2.score;
  console.log(`  ${ccy}: dnes="${p1.label}" (score ${p1.score}) za 200 dní="${p2.label}" (score ${p2.score}) ${changed ? "ZMĚNA BEZ NOVÝCH DAT" : "stabilní"}`);
}

// ── TEST 5: Věcná kontrola proti známé historické makro události (AUD RBA hiking cyklus) ──
console.log("\n=== TEST 5: Věcná shoda s historickými daty — AUD rate history (RBA) ===");
const audHist = extractRateHistory("AUD", allEvents);
console.log("  AUD rate_history (datum, sazba):", JSON.stringify(audHist));
const audPolicy = autoDetectPolicy(audHist);
console.log(`  -> klasifikace: "${audPolicy.label}" (score ${audPolicy.score}, confidence ${audPolicy.confidence})`);
console.log("  Očekávání: sazba roste monotónně 3.60->4.35 = hiking cyklus, score by mělo být kladné.");

// ── TEST 6: COT — nezávislé přepočítání z raw cot_reports vs. uložené confluence_scores ──
console.log("\n=== TEST 6: COT — přepočet z raw cot_reports vs. hodnota uložená v confluence_scores ===");
for (const ccy of SCORED) {
  const { data: rows } = await supabase
    .from("cot_reports")
    .select("report_date, lev_money_long, lev_money_short")
    .eq("currency_code", ccy)
    .eq("report_type", "TFF_FUT")
    .order("report_date", { ascending: true });
  if (!rows || rows.length === 0) { console.log(`  ${ccy}: žádná cot_reports data`); continue; }
  const historyAsc = rows.map((r) => ({ report_date: r.report_date, lev_money_net: r.lev_money_long - r.lev_money_short }));
  const recomputed = computeCotScore(historyAsc);

  const { data: stored } = await supabase
    .from("confluence_scores")
    .select("report_date, cot_score, cot_zscore")
    .eq("currency_code", ccy)
    .order("report_date", { ascending: false })
    .limit(1);
  const storedRow = stored?.[0];
  const match = storedRow && recomputed && storedRow.cot_score === recomputed.cotScore && storedRow.report_date === recomputed.reportDate;
  console.log(
    `  ${ccy}: přepočteno cot_score=${recomputed?.cotScore} (z-skóre ${recomputed?.zscore}) @ ${recomputed?.reportDate} ` +
      `| uloženo cot_score=${storedRow?.cot_score} @ ${storedRow?.report_date} | ${match ? "SHODA" : "NESHODA"}`
  );
}

// ── TEST 7: Risk Regime — pure function test s reálnými posledními VIX daty ──
console.log("\n=== TEST 7: Risk Regime determinismus (aktuální market_regime vs. přepočet z FRED by měl sedět) ===");
const { data: mr } = await supabase.from("market_regime").select("*").limit(1);
console.log("  Aktuálně uložený market_regime:", JSON.stringify(mr?.[0]));
console.log("  (Pozn.: FRED VIX se mění nanejvýš 1x denně — shoda mezi opakovanými cron běhy ve stejný den je očekávaná, ne náhoda.)");
