import { createClient } from "@supabase/supabase-js";
import { computeRegimeShift } from "./fundamental-scoring.mjs";

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
console.log(`Načteno ${allEvents.length} calendar_events.\n`);
console.log("=== computeRegimeShift (produkční kód) pro všech 8 měn ===\n");
for (const ccy of SCORED) {
  const r = computeRegimeShift(ccy, allEvents);
  console.log(
    `${ccy}: dlouhodobé=${r.longTermScore.toFixed(1)} krátkodobé(90d)=${r.shortTermScore.toFixed(1)} rozdíl=${r.divergence.toFixed(1)} alert=${r.alert}`
  );
}
