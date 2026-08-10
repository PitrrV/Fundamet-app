import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

console.log("=== AUD: report_date z latest_confluence_scores (view) ===");
const { data: viewRow, error: viewErr } = await supabase
  .from("latest_confluence_scores")
  .select("currency_code, report_date, overall_score, cot_score")
  .eq("currency_code", "AUD")
  .limit(1);
if (viewErr) console.error("viewErr", viewErr.message);
console.log(JSON.stringify(viewRow));

console.log("\n=== AUD: přímo z confluence_scores (raw tabulka, všechny řádky) ===");
const { data: rawRows, error: rawErr } = await supabase
  .from("confluence_scores")
  .select("currency_code, report_date, overall_score, cot_score, computed_at")
  .eq("currency_code", "AUD")
  .order("report_date", { ascending: false });
if (rawErr) console.error("rawErr", rawErr.message);
for (const r of rawRows ?? []) console.log(JSON.stringify(r));

console.log("\n=== POKUS o update s .select() navrat (zjisti, kolik radku match) ===");
const testReportDate = viewRow?.[0]?.report_date;
console.log("pouziju report_date =", JSON.stringify(testReportDate), "typeof", typeof testReportDate);
const { data: updData, error: updErr } = await supabase
  .from("confluence_scores")
  .update({ overall_score: 1.4 })
  .eq("currency_code", "AUD")
  .eq("report_date", testReportDate)
  .select();
if (updErr) console.error("updErr", updErr.message);
console.log("update matchnul radku:", updData?.length, JSON.stringify(updData));
