// DOČASNÝ diagnostický skript — smazat po použití. Finální ověření po úklidu.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: nzd } = await supabase
  .from("calendar_events")
  .select("event_title, event_day, event_time")
  .eq("currency_code", "NZD")
  .in("event_title", ["Employment Change q/q", "Unemployment Rate", "Labor Cost Index q/q"])
  .order("event_day", { ascending: true });
console.log("NZD eventy:", JSON.stringify(nzd, null, 2));

const PAGE_SIZE = 1000;
const all = [];
for (let from = 0; ; from += PAGE_SIZE) {
  const { data: page } = await supabase
    .from("calendar_events")
    .select("currency_code, event_title, event_day")
    .gte("event_day", "2026-07-01")
    .range(from, from + PAGE_SIZE - 1);
  all.push(...page);
  if (page.length < PAGE_SIZE) break;
}

const groups = new Map();
for (const ev of all) {
  const key = `${ev.currency_code}|${ev.event_title}`;
  if (!groups.has(key)) groups.set(key, new Set());
  groups.get(key).add(ev.event_day);
}
let dupCount = 0;
for (const [key, days] of groups) {
  const sorted = [...days].sort();
  for (let i = 1; i < sorted.length; i++) {
    if ((new Date(sorted[i]) - new Date(sorted[i - 1])) / 86400000 === 1) {
      console.log(`STÁLE DUPLICITA: ${key} — ${sorted[i - 1]} a ${sorted[i]}`);
      dupCount++;
    }
  }
}
console.log(`Zbývá ${dupCount} podezřelých párů (z původních 75).`);
