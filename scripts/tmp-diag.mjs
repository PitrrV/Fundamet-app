import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

for (const code of ["AUD", "USD"]) {
  const { data: cb } = await supabase.from("cb_policy_state").select("*").eq("currency_code", code).limit(1);
  const { data: cs } = await supabase
    .from("confluence_scores")
    .select("overall_score, conviction_reasons, conviction_stars, report_date")
    .eq("currency_code", code)
    .order("report_date", { ascending: false })
    .limit(1);
  console.log(`\n=== ${code} ===`);
  console.log("cb_policy_state:", JSON.stringify(cb?.[0]));
  console.log("confluence_scores:", JSON.stringify(cs?.[0]));
}

// Zjisti taky, jestli AUD má vůbec zachycený Interest Rate / Inflation event v calendar_events
const { data: audRateEvents } = await supabase
  .from("calendar_events")
  .select("event_title, event_day, actual, estimate")
  .eq("currency_code", "AUD")
  .or("event_title.ilike.%interest rate%,event_title.ilike.%cash rate%,event_title.ilike.%cpi%,event_title.ilike.%inflation%")
  .order("event_day", { ascending: false })
  .limit(10);
console.log("\n=== AUD rate/inflation events (posledních 10) ===");
for (const e of audRateEvents ?? []) console.log(e.event_day, e.event_title, "actual=" + e.actual, "estimate=" + e.estimate);
