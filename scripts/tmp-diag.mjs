import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: narratives, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, scenarios, generated_at")
  .order("currency_code", { ascending: true });

if (error) {
  console.error("Chyba:", error.message);
  process.exit(1);
}

for (const row of narratives ?? []) {
  console.log(`=== ${row.currency_code} (generated_at=${row.generated_at}) ===`);
  for (const s of row.scenarios ?? []) {
    const hasOutcome = s.outcome !== null && s.outcome !== undefined;
    console.log(
      `  [${s.date}] ${s.event} — outcome: ${hasOutcome ? `"${s.outcome.slice(0, 60)}..."` : "NULL"}`
    );
  }
}

// Pro každou měnu zkontroluj, jestli scénář bez outcome má v calendar_events už actual
const { data: events } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day, actual");

console.log("\n=== KONTROLA: scénář bez outcome, ale actual už existuje ===");
for (const row of narratives ?? []) {
  for (const s of row.scenarios ?? []) {
    if (s.outcome) continue;
    const match = (events ?? []).find(
      (e) => e.currency_code === row.currency_code && e.event_title === s.event && e.event_day === s.date
    );
    if (match?.actual) {
      console.log(`  NESOULAD: ${row.currency_code} ${s.event} (${s.date}) — actual=${match.actual}, ale outcome=NULL`);
    }
  }
}
