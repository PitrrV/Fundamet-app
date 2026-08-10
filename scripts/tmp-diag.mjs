import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

console.log("=== poslední confluence_scores pro všechny měny (overall vs cot) ===");
const { data } = await supabase
  .from("latest_confluence_scores")
  .select("currency_code, report_date, overall_score, cot_score, data_tier, computed_at")
  .order("currency_code", { ascending: true });
for (const c of data ?? []) {
  const raw = Number(c.overall_score) === Number(c.cot_score);
  console.log(`${c.currency_code}: overall=${c.overall_score} cot=${c.cot_score} data_tier=${c.data_tier}${raw ? "  <<< POZOR: stale rovno cot_score" : ""}`);
}
