import { createClient } from "@supabase/supabase-js";
import { matchRule } from "./fundamental-scoring.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FAILING = ["AUD", "CHF", "GBP", "USD", "JPY"];

const { data, error } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day, actual, estimate")
  .in("currency_code", FAILING)
  .order("currency_code")
  .order("event_day");

if (error) {
  console.error("query error:", error);
  process.exit(1);
}

console.log(`=== ${data.length} celkem eventů pro ${FAILING.join(",")} ===`);

for (const cc of FAILING) {
  const rows = (data ?? []).filter((r) => r.currency_code === cc);
  const irRows = rows.filter((r) => matchRule(r.event_title)?.cat === "Interest Rates");
  console.log(`\n--- ${cc}: ${rows.length} eventů celkem, ${irRows.length} v kategorii Interest Rates ---`);
  for (const r of irRows) {
    console.log(`  ${r.event_day}  "${r.event_title}"  actual="${r.actual}"  estimate="${r.estimate}"`);
  }
}
