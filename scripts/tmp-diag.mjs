// DOČASNÝ diagnostický skript — smazat po použití. Jen čte, nic nezapisuje.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const codes = ["GBP", "CAD"];

const { data: conf, error: e1 } = await supabase
  .from("latest_confluence_scores")
  .select("currency_code, cot_score, overall_score, conviction_stars, conviction_label, retail_score, cot_percentile")
  .in("currency_code", codes);
if (e1) { console.error(e1); process.exit(1); }

const { data: fund, error: e2 } = await supabase
  .from("latest_fundamental_scores")
  .select("currency_code, fundamental_score")
  .in("currency_code", codes);
if (e2) { console.error(e2); process.exit(1); }

const { data: cb, error: e3 } = await supabase
  .from("cb_policy_state")
  .select("currency_code, policy_label, real_yield_adj, cb_policy_adj")
  .in("currency_code", codes);
if (e3) { console.error(e3); process.exit(1); }

console.log("=== confluence (overall_score = hlavní gauge číslo) ===");
console.log(JSON.stringify(conf, null, 2));
console.log("=== fundamental_score (samostatná komponenta) ===");
console.log(JSON.stringify(fund, null, 2));
console.log("=== cb_policy_state ===");
console.log(JSON.stringify(cb, null, 2));
