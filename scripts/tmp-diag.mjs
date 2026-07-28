import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data } = await supabase
  .from("cb_policy_state")
  .select("currency_code, rate, cpi, policy_label, policy_confidence, real_yield_adj, cb_policy_adj, rate_history")
  .order("currency_code");

console.log("=== cb_policy_state po opravě stránkování ===");
for (const row of data ?? []) {
  console.log(
    `${row.currency_code}: rate=${row.rate} cpi=${row.cpi} label="${row.policy_label}" conf=${row.policy_confidence} ` +
      `real_yield_adj=${row.real_yield_adj} cb_policy_adj=${row.cb_policy_adj} historie=${(row.rate_history ?? []).length} bodů`
  );
}
