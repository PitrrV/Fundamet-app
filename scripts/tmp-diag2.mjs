import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: cbPolicy, error: cbErr } = await supabase
  .from("cb_policy_state")
  .select("currency_code, rate, cpi, policy_label, real_yield_adj, cb_policy_adj, updated_at")
  .order("currency_code");
console.log("=== cb_policy_state (raw) ===");
console.log(JSON.stringify(cbPolicy, null, 2));
if (cbErr) console.error("ERR", cbErr.message);

const { data: regime, error: regimeErr } = await supabase.from("market_regime").select("*");
console.log("=== market_regime (raw) ===");
console.log(JSON.stringify(regime, null, 2));
if (regimeErr) console.error("ERR", regimeErr.message);
