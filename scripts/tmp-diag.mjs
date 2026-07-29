import { createClient } from "@supabase/supabase-js";
import { matchRule, eventDirection, surpriseStrength, recency, eventRelevance, ffConfidence } from "./fundamental-scoring.mjs";
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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function collectContributions(currencyCode, calendarEvents, now) {
  const relevant = [];
  const contributions = [];
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
    contributions.push({ cat: rule.cat, contribution });
  }
  const { confidence } = ffConfidence(relevant);
  return { contributions, confidence };
}

function variantA(contributions, confidence) {
  const totalSigned = contributions.reduce((s, c) => s + c.contribution, 0);
  const rawScore = clamp(totalSigned, -10, 10);
  return Math.round(clamp((rawScore / 2) * confidence, -5, 5) * 100) / 100;
}

// ── VARIANTA F: top-N NEJROZHODNĚJŠÍCH (podle |contribution|, ne podle data) eventů na
// kategorii, jinak identická logika jako současnost (součet, stejný ±10 ořez). Cílem je
// odfiltrovat objem SLABÝCH/nerozhodných eventů (typicky PMI), ale zachovat skutečný trvalý
// trend (i kdyby šlo o desítky eventů), protože ten se projeví jako VÍCE rozhodných eventů
// stejným směrem, ne jako pár náhodných.
function variantF(contributions, confidence, capN) {
  const byCat = {};
  for (const c of contributions) {
    byCat[c.cat] ??= [];
    byCat[c.cat].push(c.contribution);
  }
  let rawSum = 0;
  for (const cat of Object.keys(byCat)) {
    const sorted = byCat[cat].slice().sort((a, b) => Math.abs(b) - Math.abs(a));
    rawSum += sorted.slice(0, capN).reduce((s, v) => s + v, 0);
  }
  const rawScore = clamp(rawSum, -10, 10);
  return Math.round(clamp((rawScore / 2) * confidence, -5, 5) * 100) / 100;
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events.\n`);

for (const capN of [8, 12, 20]) {
  console.log(`\n\n================ VARIANTA F, capN=${capN} (top-N nejrozhodnějších na kategorii) ================`);

  console.log("\n═══ Historická validace vs. reálná CB Policy kotva ═══");
  for (const ccy of FOCUS) {
    console.log(`\n--- ${ccy} ---`);
    console.log("dní zpět | CB Policy (kotva)                          | A       | F");
    for (const daysAgo of AS_OF_DAYS_AGO) {
      const asOf = new Date(NOW.getTime() - daysAgo * 86400000);
      const eventsUpTo = allEvents.filter((e) => new Date(e.event_day).getTime() <= asOf.getTime());
      const cb = computeCbPolicyState(ccy, SCORED, eventsUpTo);
      const { contributions, confidence } = collectContributions(ccy, eventsUpTo, asOf);
      const a = variantA(contributions, confidence);
      const f = variantF(contributions, confidence, capN);
      console.log(`${String(daysAgo).padStart(4)} (${asOf.toISOString().slice(0, 10)}) | ${cb.policyLabel.padEnd(43)} | ${a.toFixed(2).padStart(6)} | ${f.toFixed(2).padStart(6)}`);
    }
  }

  console.log("\n═══ Diferenciace mezi 8 měnami dnes ═══");
  const fVals = [];
  for (const ccy of SCORED) {
    const { contributions, confidence } = collectContributions(ccy, allEvents, NOW);
    const f = variantF(contributions, confidence, capN);
    fVals.push(f);
    console.log(`${ccy}: F=${f.toFixed(2)}`);
  }
  function stdev(arr) {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  }
  console.log(`sd(F)=${stdev(fVals).toFixed(2)}, min=${Math.min(...fVals)}, max=${Math.max(...fVals)}`);
}
