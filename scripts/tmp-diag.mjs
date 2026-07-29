import { createClient } from "@supabase/supabase-js";
import { matchRule, eventDirection, surpriseStrength, recency, eventRelevance, ffConfidence, EVENT_RULES } from "./fundamental-scoring.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCORED = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];
const FOCUS = ["USD", "AUD", "EUR", "GBP"];
const NOW = new Date("2026-07-29T00:00:00Z");
const AS_OF_DAYS_AGO = [300, 220, 140, 60, 0];

// Navrhovaná konstanta: kolik "silně potvrzujících" eventů maximálně započítat na kategorii,
// než se její příspěvek zastropuje. 4 zrcadlí existující konvenci HIGH confidence v cb-policy.mjs
// (changes.length >= 4 => HIGH) — konzistence napříč pilíři, ne libovolné číslo.
const CATEGORY_CAP_N = 4;
const MAX_SINGLE_EVENT = 1.6 * 1.8; // max surprise (1.6) * max recency (1.8), bez váhy kategorie a relevance

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
    contributions.push({ cat: rule.cat, w: rule.w, contribution });
  }
  const { confidence } = ffConfidence(relevant);
  return { contributions, confidence };
}

// ── VARIANTA A (současná, pro srovnání) ──
function variantA(contributions, confidence) {
  const totalSigned = contributions.reduce((s, c) => s + c.contribution, 0);
  const rawScore = clamp(totalSigned, -10, 10);
  return Math.round(clamp((rawScore / 2) * confidence, -5, 5) * 100) / 100;
}

// ── VARIANTA E (navrhovaná): strop na kategorii + normalizace podle dosažitelného maxima ──
function variantE(contributions, confidence) {
  const byCat = {};
  for (const c of contributions) {
    byCat[c.cat] ??= { sum: 0, w: c.w };
    byCat[c.cat].sum += c.contribution;
  }
  let rawSum = 0;
  let maxPossible = 0;
  for (const cat of Object.keys(byCat)) {
    const { sum, w } = byCat[cat];
    const cap = w * MAX_SINGLE_EVENT * CATEGORY_CAP_N;
    rawSum += clamp(sum, -cap, cap);
    maxPossible += cap;
  }
  const normalizedRaw = maxPossible > 0 ? rawSum / maxPossible : 0;
  return Math.round(clamp(normalizedRaw * 5 * confidence, -5, 5) * 100) / 100;
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events.\n`);
console.log(`CATEGORY_CAP_N=${CATEGORY_CAP_N}, cap(kategorie) = w * ${MAX_SINGLE_EVENT.toFixed(2)} * ${CATEGORY_CAP_N} = w * ${(MAX_SINGLE_EVENT * CATEGORY_CAP_N).toFixed(2)}\n`);

console.log("═══ ČÁST 1: Historická validace — A vs. navrhovaná E, stejný test jako předtím ═══\n");
for (const ccy of FOCUS) {
  console.log(`\n########## ${ccy} — trajektorie v čase ##########`);
  console.log("dní zpět | CB Policy (reálná kotva)                          | A (současná) | E (navrhovaná)");
  for (const daysAgo of AS_OF_DAYS_AGO) {
    const asOf = new Date(NOW.getTime() - daysAgo * 86400000);
    const eventsUpTo = allEvents.filter((e) => new Date(e.event_day).getTime() <= asOf.getTime());
    const cb = computeCbPolicyState(ccy, SCORED, eventsUpTo);
    const { contributions, confidence } = collectContributions(ccy, eventsUpTo, asOf);
    const a = variantA(contributions, confidence);
    const e = variantE(contributions, confidence);
    console.log(`${String(daysAgo).padStart(4)} (${asOf.toISOString().slice(0, 10)}) | ${cb.policyLabel.padEnd(48)} | ${a.toFixed(2).padStart(6)}       | ${e.toFixed(2).padStart(6)}`);
  }
}

console.log("\n\n═══ ČÁST 2: Diferenciace mezi všemi 8 měnami dnes (současný stav) ═══\n");
const results = {};
for (const ccy of SCORED) {
  const { contributions, confidence } = collectContributions(ccy, allEvents, NOW);
  results[ccy] = { A: variantA(contributions, confidence), E: variantE(contributions, confidence) };
  console.log(`${ccy}: A=${results[ccy].A.toFixed(2).padStart(6)}   E=${results[ccy].E.toFixed(2).padStart(6)}`);
}
function stdev(arr) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
const aVals = SCORED.map((c) => results[c].A);
const eVals = SCORED.map((c) => results[c].E);
console.log(`\nsd(A)=${stdev(aVals).toFixed(2)}, min=${Math.min(...aVals)}, max=${Math.max(...aVals)}`);
console.log(`sd(E)=${stdev(eVals).toFixed(2)}, min=${Math.min(...eVals)}, max=${Math.max(...eVals)}`);
