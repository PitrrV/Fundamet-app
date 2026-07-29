import { createClient } from "@supabase/supabase-js";
import { matchRule, eventDirection, surpriseStrength, recency, eventRelevance, ffConfidence, EVENT_RULES } from "./fundamental-scoring.mjs";
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
    contributions.push({ cat: rule.cat, contribution, daysAgo, day: ev.event_day });
  }
  contributions.sort((a, b) => a.daysAgo - b.daysAgo);
  const { confidence } = ffConfidence(relevant);
  return { contributions, confidence };
}

function finalize(rawSum, confidence) {
  const rawScore = clamp(rawSum, -10, 10);
  const scaledRaw = rawScore / 2;
  return Math.round(clamp(scaledRaw * confidence, -5, 5) * 100) / 100;
}

function computeVariants(currencyCode, calendarEvents, now) {
  const { contributions, confidence } = collectContributions(currencyCode, calendarEvents, now);
  const totalSigned = contributions.reduce((s, c) => s + c.contribution, 0);
  const fundA = finalize(totalSigned, confidence);

  const meanAll = contributions.length > 0 ? totalSigned / contributions.length : 0;
  const fundB = finalize(meanAll * 2, confidence);

  const cappedByCat = {};
  for (const c of contributions) {
    cappedByCat[c.cat] ??= [];
    if (cappedByCat[c.cat].length < 6) cappedByCat[c.cat].push(c.contribution);
  }
  const cappedSum = Object.values(cappedByCat).flat().reduce((s, v) => s + v, 0);
  const fundC = finalize(cappedSum, confidence);

  const byCat = {};
  for (const c of contributions) {
    byCat[c.cat] ??= { count: 0, sum: 0 };
    byCat[c.cat].count++;
    byCat[c.cat].sum += c.contribution;
  }
  let weightedSum = 0, weightTotal = 0;
  for (const cat of [...new Set(EVENT_RULES.map((r) => r.cat))]) {
    const b = byCat[cat];
    if (!b) continue;
    const catMean = b.sum / b.count;
    const rule = EVENT_RULES.find((r) => r.cat === cat);
    weightedSum += catMean * rule.w;
    weightTotal += rule.w;
  }
  const dRaw = weightTotal > 0 ? (weightedSum / weightTotal) * 2 : 0;
  const fundD = finalize(dRaw, confidence);

  return { A: fundA, B: fundB, C: fundC, D: fundD, n: contributions.length, confidence: Math.round(confidence * 100) / 100 };
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events.\n`);
console.log("Historická validace: pro každé 'as-of' datum použity JEN eventy s event_day <= as-of");
console.log("(simulace toho, co by model spočítal, kdyby běžel v ten den) + reálný CB Policy stav jako kotva.\n");

for (const ccy of FOCUS) {
  console.log(`\n########## ${ccy} — trajektorie v čase ##########`);
  console.log("as-of dní zpět | CB Policy (reálná kotva)                          | rate  | A(sum) | B(mean) | C(cap6/kat) | D(2-fáz) | N eventů");
  for (const daysAgo of AS_OF_DAYS_AGO) {
    const asOf = new Date(NOW.getTime() - daysAgo * 86400000);
    const eventsUpTo = allEvents.filter((e) => new Date(e.event_day).getTime() <= asOf.getTime());
    const cb = computeCbPolicyState(ccy, SCORED, eventsUpTo);
    const v = computeVariants(ccy, eventsUpTo, asOf);
    console.log(
      `${String(daysAgo).padStart(4)} (${asOf.toISOString().slice(0, 10)}) | ${cb.policyLabel.padEnd(48)} | ${String(cb.rate).padStart(5)} | ` +
        `${v.A.toFixed(2).padStart(6)} | ${v.B.toFixed(2).padStart(6)}  | ${v.C.toFixed(2).padStart(6)}      | ${v.D.toFixed(2).padStart(6)}   | ${v.n} (conf ${v.confidence})`
    );
  }
}
