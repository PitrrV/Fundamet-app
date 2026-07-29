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
    contributions.push(contribution);
  }
  const { confidence } = ffConfidence(relevant);
  return { contributions, confidence, n: relevant.length };
}

function variantA(contributions, confidence) {
  const totalSigned = contributions.reduce((s, v) => s + v, 0);
  const rawScore = clamp(totalSigned, -10, 10);
  return Math.round(clamp((rawScore / 2) * confidence, -5, 5) * 100) / 100;
}

// H: lineární tlumení podle počtu eventů, pak stávající tvrdý ořez ±10 (dříve navrženo)
function variantH(contributions, confidence, referenceCount) {
  const totalSigned = contributions.reduce((s, v) => s + v, 0);
  const n = contributions.length;
  const dampFactor = n > 0 ? Math.min(1, referenceCount / n) : 1;
  const rawScore = clamp(totalSigned * dampFactor, -10, 10);
  return Math.round(clamp((rawScore / 2) * confidence, -5, 5) * 100) / 100;
}

// TANH: hladké měkké saturování přímo na součtu, žádný tvrdý ořez potřeba (tanh je
// přirozeně omezený a nikdy sign nezmění — je to lichá, ryze rostoucí funkce).
function variantTanh(contributions, confidence, K) {
  const totalSigned = contributions.reduce((s, v) => s + v, 0);
  const rawScore = 10 * Math.tanh(totalSigned / K);
  return Math.round(clamp((rawScore / 2) * confidence, -5, 5) * 100) / 100;
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events.\n`);

for (const K of [20, 30, 40]) {
  console.log(`\n\n================ TANH SOFT-SATURACE, K=${K} ================`);

  console.log("\n═══ Historická validace vs. reálná CB Policy kotva ═══");
  for (const ccy of FOCUS) {
    console.log(`\n--- ${ccy} ---`);
    console.log("dní zpět | CB Policy (kotva)                          | A       | H(ref60) | tanh(K)");
    for (const daysAgo of AS_OF_DAYS_AGO) {
      const asOf = new Date(NOW.getTime() - daysAgo * 86400000);
      const eventsUpTo = allEvents.filter((e) => new Date(e.event_day).getTime() <= asOf.getTime());
      const cb = computeCbPolicyState(ccy, SCORED, eventsUpTo);
      const { contributions, confidence } = collectContributions(ccy, eventsUpTo, asOf);
      const a = variantA(contributions, confidence);
      const h = variantH(contributions, confidence, 60);
      const t = variantTanh(contributions, confidence, K);
      console.log(`${String(daysAgo).padStart(4)} (${asOf.toISOString().slice(0, 10)}) | ${cb.policyLabel.padEnd(43)} | ${a.toFixed(2).padStart(6)} | ${h.toFixed(2).padStart(7)} | ${t.toFixed(2).padStart(6)}`);
    }
  }

  console.log("\n═══ Diferenciace mezi 8 měnami dnes ═══");
  const vals = [];
  for (const ccy of SCORED) {
    const { contributions, confidence, n } = collectContributions(ccy, allEvents, NOW);
    const t = variantTanh(contributions, confidence, K);
    vals.push(t);
    console.log(`${ccy}: tanh=${t.toFixed(2)} (n=${n})`);
  }
  function stdev(arr) {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  }
  console.log(`sd=${stdev(vals).toFixed(2)}, min=${Math.min(...vals)}, max=${Math.max(...vals)}`);
}
