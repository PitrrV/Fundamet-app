// DOČASNÝ diagnostický skript — smazat po použití.
// Zkontroluje rate history + autoDetectPolicy klasifikaci pro VŠECHNY měny, aby se ověřilo,
// jestli oprava USD "poslední cut" bugu (holdCount>=4 bez yearChange gate) neodhalila nebo
// nevyřešila podobný problém i jinde.
import { createClient } from "@supabase/supabase-js";
import { extractRateHistory, autoDetectPolicy } from "./cb-policy.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CURRENCIES = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];

const { data: events, error } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day, actual, estimate, previous")
  .order("event_day", { ascending: true });

if (error) {
  console.error("Chyba čtení calendar_events:", error.message);
  process.exit(1);
}

console.log(`Načteno ${events.length} eventů celkem.\n`);

for (const code of CURRENCIES) {
  const history = extractRateHistory(code, events);
  const policy = autoDetectPolicy(history);
  console.log(`=== ${code} ===`);
  console.log("historie:", JSON.stringify(history));
  console.log("klasifikace:", JSON.stringify(policy));
  console.log("");
}

console.log("=== Uložené cb_policy_state (aktuální DB stav) ===");
const { data: rows } = await supabase.from("cb_policy_state").select("currency_code, rate, policy_label, policy_score, updated_at").order("currency_code");
for (const r of rows ?? []) {
  console.log(`${r.currency_code}: ${r.policy_label} (score=${r.policy_score}, rate=${r.rate}, updated=${r.updated_at})`);
}
