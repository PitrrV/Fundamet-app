import { createClient } from "@supabase/supabase-js";
import { matchRule, eventDirection, surpriseStrength, recency, eventRelevance, ffConfidence } from "./fundamental-scoring.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCORED = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];
const NOW = new Date("2026-07-29T00:00:00Z");
const BLEND_WEIGHTS = { fund: 0.43, cot: 0.46, retail: 0.11 };

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

// Kopie computeFundamentalScore, jen navíc vrací i seznam přispívajících eventů (produkční
// funkce tenhle detail nevrací, potřebujeme ho pro ekonomickou interpretaci).
function scoreWithBreakdown(currencyCode, calendarEvents, now) {
  const relevant = [];
  const contributions = [];
  let rawSum = 0;
  for (const ev of calendarEvents) {
    const relevance = eventRelevance(currencyCode, ev);
    if (!relevance) continue;
    if (!ev.actual || !ev.estimate) continue;
    const rule = matchRule(ev.event_title);
    if (!rule || rule.w === 0) continue;
    relevant.push(ev);
    const dir = eventDirection(ev, rule);
    if (dir === 0) continue;
    const daysAgo = (now.getTime() - new Date(ev.event_day).getTime()) / 86400000;
    if (daysAgo < 0) continue;
    const contribution = dir * rule.w * surpriseStrength(ev) * recency(daysAgo) * relevance.factor;
    rawSum += contribution;
    contributions.push({
      title: ev.event_title,
      ccy: ev.currency_code,
      day: ev.event_day,
      actual: ev.actual,
      estimate: ev.estimate,
      dir,
      cat: rule.cat,
      w: rule.w,
      daysAgo: Math.round(daysAgo),
      contribution: Math.round(contribution * 100) / 100,
    });
  }
  const rawScore = Math.max(-10, Math.min(10, rawSum));
  const { confidence, historyMonths } = ffConfidence(relevant);
  const scaledRaw = rawScore / 2;
  const fundamentalScore = Math.round(Math.max(-5, Math.min(5, scaledRaw * confidence)) * 10) / 10;
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { fundamentalScore, confidence: Math.round(confidence * 100) / 100, historyMonths: Math.round(historyMonths * 10) / 10, contributions };
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events.\n`);

// ── Reálné COT/retail/risk (nezávisí na calendar_events okně) ──
const cotByCcy = {};
for (const ccy of SCORED) {
  const { data } = await supabase
    .from("latest_confluence_scores")
    .select("report_date, cot_score, cot_zscore, retail_score, cot_percentile")
    .eq("currency_code", ccy)
    .limit(1);
  cotByCcy[ccy] = data?.[0] ?? {};
}
const { data: mrData } = await supabase.from("market_regime").select("*").limit(1);
const regime = mrData?.[0];
console.log(`Risk regime: ${regime?.regime} (VIX ${regime?.vix}, 5d ${regime?.vix_5d_change})\n`);

function riskAdjForCurrency(ccy, reg) {
  const RISK_ON_MAP = { AUD: 0.4, NZD: 0.35, CAD: 0.25, JPY: -0.25, CHF: -0.15 };
  const RISK_OFF_MAP = { AUD: -0.5, NZD: -0.5, CAD: -0.3, JPY: 0.5, CHF: 0.5 };
  if (reg === "RISK_ON") return RISK_ON_MAP[ccy] ?? 0;
  if (reg === "RISK_OFF") return RISK_OFF_MAP[ccy] ?? 0;
  return 0;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

console.log("=== COT + Retail (reálný aktuální stav, nezávisí na oknu) ===");
for (const ccy of SCORED) {
  const c = cotByCcy[ccy];
  console.log(`  ${ccy}: cot_score=${c.cot_score} (z=${c.cot_zscore}, pct=${c.cot_percentile}) retail_score=${c.retail_score}`);
}

const WINDOWS = [
  { label: "56d (původní)", days: 56 },
  { label: "365d/současnost", days: 365 },
];

const FULL_DUMP_CCY = ["EUR", "GBP", "CAD", "AUD", "USD"];

for (const w of WINDOWS) {
  console.log(`\n\n########## OKNO: ${w.label} ##########`);
  const events = filterByWindow(allEvents, w.days);
  for (const ccy of SCORED) {
    const fs = scoreWithBreakdown(ccy, events, NOW);
    const cb = computeCbPolicyState(ccy, SCORED, events);
    const fundamentalScoreAdj = clamp(fs.fundamentalScore + cb.realYieldAdj + cb.cbPolicyAdj, -5, 5);
    const c = cotByCcy[ccy];
    const riskAdj = riskAdjForCurrency(ccy, regime?.regime);
    const overallRaw = fundamentalScoreAdj * BLEND_WEIGHTS.fund + (c.cot_score ?? 0) * BLEND_WEIGHTS.cot + (c.retail_score ?? 0) * BLEND_WEIGHTS.retail + riskAdj;
    const overallScore = Math.round(clamp(overallRaw, -5, 5) * 10) / 10;

    const posSum = fs.contributions.filter((e) => e.contribution > 0).reduce((s, e) => s + e.contribution, 0);
    const negSum = fs.contributions.filter((e) => e.contribution < 0).reduce((s, e) => s + e.contribution, 0);
    console.log(`\n--- ${ccy} ---`);
    console.log(`  fund=${fs.fundamentalScore} (conf ${fs.confidence}) | cb: rate=${cb.rate} cpi=${cb.cpi} "${cb.policyLabel}" | real_yield_adj=${cb.realYieldAdj} cb_policy_adj=${cb.cbPolicyAdj}`);
    console.log(`  fundamentalScoreAdj=${fundamentalScoreAdj.toFixed(2)} | cot=${c.cot_score} retail=${c.retail_score} risk=${riskAdj} -> OVERALL=${overallScore}`);
    console.log(`  Součet přispívajících eventů: ${fs.contributions.length} eventů, kladných=+${posSum.toFixed(1)}, záporných=${negSum.toFixed(1)}, netto=${(posSum + negSum).toFixed(1)} (před clampem ±10)`);
    if (w.days === 365 && FULL_DUMP_CCY.includes(ccy)) {
      console.log(`  KOMPLETNÍ seznam přispívajících eventů (${fs.contributions.length}):`);
      for (const ev of fs.contributions) {
        console.log(`    [${ev.cat}] "${ev.title}" (${ev.ccy}) ${ev.day} actual=${ev.actual} est=${ev.estimate} dir=${ev.dir} contrib=${ev.contribution} (${ev.daysAgo}d zpět)`);
      }
    } else {
      console.log(`  Top přispívající eventy:`);
      for (const ev of fs.contributions.slice(0, 5)) {
        console.log(`    [${ev.cat}] "${ev.title}" (${ev.ccy}) ${ev.day} actual=${ev.actual} est=${ev.estimate} dir=${ev.dir} contrib=${ev.contribution} (${ev.daysAgo}d zpět)`);
      }
    }
  }
}
