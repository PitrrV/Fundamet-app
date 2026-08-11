import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore, matchRule, eventDirection, surpriseStrength, recency, eventRelevance } from "./fundamental-scoring.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function fetchAllCalendarEvents() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, currency_code, event_title, event_day, actual, estimate, previous")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Celkem calendar_events: ${allEvents.length} (unikátních id: ${new Set(allEvents.map((e) => e.id)).size})`);
console.log(`id=690 (NFP 7.8.) přítomno:`, allEvents.some((e) => e.id === 690));

const now = new Date();
const CODE = "USD";

const rows = [];
for (const ev of allEvents) {
  const relevance = eventRelevance(CODE, ev);
  if (!relevance) continue;
  if (!ev.actual || !ev.estimate) continue;
  const rule = matchRule(ev.event_title);
  if (!rule || rule.w === 0) continue;
  const dir = eventDirection(ev, rule);
  if (dir === 0) continue;
  const daysAgo = (now.getTime() - new Date(ev.event_day).getTime()) / 86400000;
  if (daysAgo < 0) continue;
  const w = rule.w * recency(daysAgo) * relevance.factor;
  const ss = surpriseStrength(ev);
  const contribution = dir * ss * w;
  rows.push({ title: ev.event_title, cat: rule.cat, event_day: ev.event_day, actual: ev.actual, estimate: ev.estimate, dir, surpriseStrength: Math.round(ss * 100) / 100, weight: Math.round(w * 100) / 100, contribution: Math.round(contribution * 100) / 100, daysAgo: Math.round(daysAgo * 10) / 10 });
}

rows.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
console.log(`\n=== ${CODE}: relevantní eventy (${rows.length}), seřazeno dle |contribution| ===`);
for (const r of rows) console.log(JSON.stringify(r));

const weightedSum = rows.reduce((s, r) => s + r.contribution, 0);
const weightTotal = rows.reduce((s, r) => s + r.weight, 0);
console.log(`\nweightedSum=${weightedSum.toFixed(3)} weightTotal=${weightTotal.toFixed(3)} rawAvg=${(weightedSum / weightTotal).toFixed(4)}`);

const result = computeFundamentalScore(CODE, allEvents, now);
console.log(`\ncomputeFundamentalScore(${CODE}) =`, JSON.stringify(result));

for (const code of ["EUR", "GBP", "CHF", "JPY", "AUD", "NZD", "CAD"]) {
  const r = computeFundamentalScore(code, allEvents, now);
  console.log(`computeFundamentalScore(${code}) =`, JSON.stringify(r));
}
