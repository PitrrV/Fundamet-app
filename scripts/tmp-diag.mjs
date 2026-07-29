import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: snaps, error } = await supabase
  .from("score_snapshots")
  .select("overall_score, fundamental_score_adj, cot_score, retail_score, risk_adj, recorded_at")
  .eq("currency_code", "CHF")
  .order("recorded_at", { ascending: true });
if (error) throw error;

console.log("=== CHF score_snapshots (chronologicky) ===");
for (const s of snaps) {
  console.log(s.recorded_at, "overall=" + s.overall_score, "fund_adj=" + s.fundamental_score_adj, "cot=" + s.cot_score, "retail=" + s.retail_score, "risk=" + s.risk_adj);
}

const { data: narr, error: nErr } = await supabase
  .from("narratives")
  .select("generated_at, thesis_change_note")
  .eq("currency_code", "CHF")
  .order("generated_at", { ascending: false })
  .limit(3);
if (nErr) throw nErr;
console.log("\n=== CHF poslední narrativy ===");
for (const n of narr) {
  console.log(n.generated_at, JSON.stringify(n.thesis_change_note));
}
