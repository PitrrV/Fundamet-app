// DOČASNÝ diagnostický skript — smazat po použití. Jen čte, nic nezapisuje.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("cb_policy_state")
  .select("currency_code, rate, cpi, real_yield_adj, cb_policy_adj, policy_label")
  .eq("currency_code", "JPY");
if (error) { console.error(error); process.exit(1); }
console.log(JSON.stringify(data, null, 2));

const { data: fund } = await supabase
  .from("latest_fundamental_scores")
  .select("currency_code, fundamental_score")
  .eq("currency_code", "JPY");
console.log(JSON.stringify(fund, null, 2));
