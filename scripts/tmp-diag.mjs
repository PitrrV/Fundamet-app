// DOČASNÝ diagnostický skript — smazat po použití. Ověření opraveného USD narrativu.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("latest_narratives")
  .select("narrative, forward_flag")
  .eq("currency_code", "USD")
  .single();

if (error) {
  console.error("Chyba:", error.message);
  process.exit(1);
}

console.log("Narrative:", data.narrative);
console.log("\nForward flag:", data.forward_flag);

const { data: cbRow } = await supabase.from("cb_policy_state").select("policy_label, policy_score, priced_in").eq("currency_code", "USD").single();
console.log("\ncb_policy_state:", JSON.stringify(cbRow, null, 2));
