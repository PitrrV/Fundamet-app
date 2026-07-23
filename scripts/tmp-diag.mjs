import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: narratives, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, narrative, generated_at")
  .order("currency_code", { ascending: true });

if (error) {
  console.error("Chyba:", error.message);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

// dnešní/nedávné (5 dní) eventy s actual pro každou měnu — abychom věděli, co by narrative MĚLO zmínit
const { data: events } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day, actual, estimate")
  .not("actual", "is", null)
  .gte("event_day", new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10))
  .lte("event_day", today);

const byCurrency = {};
for (const e of events ?? []) {
  (byCurrency[e.currency_code] ??= []).push(e);
}

for (const row of narratives ?? []) {
  console.log(`\n=== ${row.currency_code} (generated_at=${row.generated_at}) ===`);
  console.log("Nedávné (<=5 dní) resolved eventy v DB:", JSON.stringify(byCurrency[row.currency_code] ?? []));
  console.log("NARRATIVE TEXT:");
  console.log(row.narrative);
}
