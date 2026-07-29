import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: cs, error: csErr } = await supabase
  .from("confluence_scores")
  .select("*")
  .eq("currency_code", "EUR")
  .order("report_date", { ascending: false })
  .limit(1);
if (csErr) throw csErr;
console.log("=== confluence_scores EUR (latest row) ===");
console.log(JSON.stringify(cs?.[0], null, 2));

const { data: fs, error: fsErr } = await supabase
  .from("fundamental_scores")
  .select("*")
  .eq("currency_code", "EUR")
  .order("computed_at", { ascending: false })
  .limit(1);
if (fsErr) console.log("fundamental_scores error:", fsErr.message);
else {
  console.log("\n=== fundamental_scores EUR (latest row) ===");
  console.log(JSON.stringify(fs?.[0], null, 2));
}

const { data: cb, error: cbErr } = await supabase
  .from("cb_policy_state")
  .select("*")
  .eq("currency_code", "EUR")
  .limit(1);
if (cbErr) console.log("cb_policy_state error:", cbErr.message);
else {
  console.log("\n=== cb_policy_state EUR ===");
  console.log(JSON.stringify(cb?.[0], null, 2));
}

const { data: rs, error: rsErr } = await supabase.from("market_regime").select("*").limit(1);
if (rsErr) console.log("market_regime error:", rsErr.message);
else {
  console.log("\n=== market_regime ===");
  console.log(JSON.stringify(rs?.[0], null, 2));
}
