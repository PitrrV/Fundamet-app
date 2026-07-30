import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: events } = await supabase
  .from("calendar_events")
  .select("id, event_title, event_day, actual, estimate, previous, updated_at")
  .eq("currency_code", "GBP")
  .gte("event_day", "2026-07-28")
  .lte("event_day", "2026-07-31")
  .order("event_day", { ascending: true });
console.log("=== GBP eventy 28.-31.7. ===");
for (const e of events ?? []) {
  console.log(e.event_day, e.event_title, "actual=" + JSON.stringify(e.actual), "updated_at=" + e.updated_at);
}

const { data: narr } = await supabase
  .from("narratives")
  .select("generated_at, forward_flag")
  .eq("currency_code", "GBP")
  .order("generated_at", { ascending: false })
  .limit(3);
console.log("\n=== poslední narrativy GBP ===");
for (const n of narr ?? []) console.log(n.generated_at, "-", n.forward_flag);
