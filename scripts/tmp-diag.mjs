import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("calendar_events")
  .select("id, currency_code, event_day, event_title, actual, updated_at")
  .order("updated_at", { ascending: false })
  .limit(15);

if (error) throw error;
console.log("=== posledních 15 aktualizací calendar_events ===");
for (const row of data) {
  console.log(row.updated_at, row.currency_code, row.event_title, "actual=" + JSON.stringify(row.actual));
}
