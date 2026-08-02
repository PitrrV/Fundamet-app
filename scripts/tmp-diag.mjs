// DOČASNÝ diagnostický skript — smazat po použití.
// Zjišťuje, proč USD narrativ mluví o "možnosti dalšího zvýšení sazeb", jako by rozhodnutí
// teprve přicházelo, když uživatel tvrdí, že FOMC rozhodnutí proběhlo 29.7.2026.
import { createClient } from "@supabase/supabase-js";
import { matchRule } from "./fundamental-scoring.mjs";
import { extractRateHistory, autoDetectPolicy, computeCbPolicyState } from "./cb-policy.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: events, error } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day, actual, estimate, previous, impact")
  .eq("currency_code", "USD")
  .gte("event_day", "2026-05-01")
  .order("event_day", { ascending: true });

if (error) {
  console.error("Chyba čtení calendar_events:", error.message);
  process.exit(1);
}

console.log(`Načteno ${events.length} USD eventů od 2026-05-01.`);

console.log("\n=== Eventy kategorie 'Interest Rates' ===");
for (const ev of events) {
  if (matchRule(ev.event_title)?.cat === "Interest Rates") {
    console.log(`${ev.event_day} | ${ev.event_title} | actual=${ev.actual} estimate=${ev.estimate} previous=${ev.previous} impact=${ev.impact}`);
  }
}

console.log("\n=== Eventy kolem 2026-07-25 .. 2026-08-02 (jakákoliv kategorie) obsahující 'rate'/'fomc'/'fed' ===");
for (const ev of events) {
  if (ev.event_day >= "2026-07-25" && ev.event_day <= "2026-08-02" && /rate|fomc|fed/i.test(ev.event_title || "")) {
    console.log(`${ev.event_day} | ${ev.event_title} | actual=${ev.actual} estimate=${ev.estimate} previous=${ev.previous}`);
  }
}

const history = extractRateHistory("USD", events);
console.log("\n=== extractRateHistory('USD') ===");
console.log(JSON.stringify(history, null, 2));

const policy = autoDetectPolicy(history);
console.log("\n=== autoDetectPolicy ===");
console.log(JSON.stringify(policy, null, 2));

const { data: cbRow } = await supabase.from("cb_policy_state").select("*").eq("currency_code", "USD").single();
console.log("\n=== cb_policy_state (USD, uložený řádek) ===");
console.log(JSON.stringify(cbRow, null, 2));
