import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: snaps, error: snapErr } = await supabase
  .from("score_snapshots")
  .select("currency_code, overall_score, fundamental_score_adj, cot_score, retail_score, risk_adj, recorded_at")
  .order("recorded_at", { ascending: false })
  .limit(40);
if (snapErr) console.error("snapErr", snapErr.message);
console.log("=== posledních 40 score_snapshots (napříč měnami) ===");
for (const s of snaps ?? []) console.log(JSON.stringify(s));

console.log("\n=== posledních 5 cot_reports pro AUD ===");
const { data: cotAud } = await supabase
  .from("cot_reports")
  .select("currency_code, report_date, lev_money_net, cot_score, cot_wow_change, cot_4w_change")
  .eq("currency_code", "AUD")
  .order("report_date", { ascending: false })
  .limit(5);
for (const c of cotAud ?? []) console.log(JSON.stringify(c));

console.log("\n=== posledních 5 confluence_scores pro AUD ===");
const { data: confAud } = await supabase
  .from("confluence_scores")
  .select("currency_code, report_date, overall_score, cot_score, computed_at, data_tier")
  .eq("currency_code", "AUD")
  .order("computed_at", { ascending: false })
  .limit(5);
for (const c of confAud ?? []) console.log(JSON.stringify(c));

console.log("\n=== poslední confluence_scores pro všechny měny (report_date rozptyl) ===");
const { data: allConf } = await supabase
  .from("confluence_scores")
  .select("currency_code, report_date, overall_score, cot_score, computed_at")
  .order("computed_at", { ascending: false })
  .limit(24);
for (const c of allConf ?? []) console.log(JSON.stringify(c));
