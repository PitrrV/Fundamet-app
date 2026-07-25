import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: topOpp, error: topOppErr } = await supabase.from("weekly_top_opportunity").select("*");
console.log("=== weekly_top_opportunity ===");
console.log(JSON.stringify(topOpp, null, 2));
if (topOppErr) console.error("ERR", topOppErr.message);

const { data: ledger, error: ledgerErr } = await supabase
  .from("thesis_ledger_feed")
  .select("*")
  .order("occurred_at", { ascending: false })
  .limit(20);
console.log("=== thesis_ledger_feed (top 20) ===");
console.log(JSON.stringify(ledger, null, 2));
if (ledgerErr) console.error("ERR", ledgerErr.message);

const { data: scores } = await supabase
  .from("latest_confluence_scores")
  .select("currency_code, overall_score, conviction_stars")
  .order("currency_code");
console.log("=== latest_confluence_scores ===");
console.log(JSON.stringify(scores, null, 2));

const { data: theses } = await supabase
  .from("latest_currency_thesis")
  .select("currency_code, direction, conviction, status")
  .order("currency_code");
console.log("=== latest_currency_thesis ===");
console.log(JSON.stringify(theses, null, 2));

const { data: quality } = await supabase.from("data_quality_score").select("currency_code, score").order("currency_code");
console.log("=== data_quality_score ===");
console.log(JSON.stringify(quality, null, 2));
