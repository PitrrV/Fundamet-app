import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: theses, error } = await supabase
  .from("currency_thesis")
  .select("id, currency_code, direction, conviction, drivers, status, confirm_streak, challenge_streak")
  .order("currency_code", { ascending: true });

if (error) {
  console.error("Chyba:", error.message);
  process.exit(1);
}

for (const t of theses) {
  console.log(JSON.stringify(t));
}

const { data: ledger, error: ledgerErr } = await supabase
  .from("thesis_ledger")
  .select("thesis_id, driver_key, classification, reasoning")
  .order("thesis_id", { ascending: true });

if (ledgerErr) {
  console.error("Ledger chyba:", ledgerErr.message);
  process.exit(1);
}

console.log("--- LEDGER ---");
for (const l of ledger) {
  console.log(JSON.stringify(l));
}
