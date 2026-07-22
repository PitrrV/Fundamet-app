import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day, event_time, impact, estimate, previous, actual, updated_at")
  .eq("currency_code", "GBP")
  .eq("event_day", "2026-07-22")
  .order("event_time", { ascending: true });

if (error) {
  console.error("Chyba:", error.message);
  process.exit(1);
}

for (const row of data) {
  console.log(JSON.stringify(row));
}
