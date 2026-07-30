import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: cs } = await supabase
  .from("confluence_scores")
  .select("overall_score, cot_score, retail_score, cot_zscore, cot_positioning_label")
  .eq("currency_code", "EUR")
  .order("report_date", { ascending: false })
  .limit(1);
console.log("=== confluence_scores EUR ===");
console.log(JSON.stringify(cs?.[0], null, 2));

const { data: fs } = await supabase
  .from("fundamental_scores")
  .select("raw_score, confidence, fundamental_score, history_months, computed_at")
  .eq("currency_code", "EUR")
  .order("computed_at", { ascending: false })
  .limit(1);
console.log("\n=== fundamental_scores EUR ===");
console.log(JSON.stringify(fs?.[0], null, 2));

const { data: cb } = await supabase.from("cb_policy_state").select("*").eq("currency_code", "EUR").limit(1);
console.log("\n=== cb_policy_state EUR ===");
console.log(JSON.stringify(cb?.[0], null, 2));

const { data: snaps } = await supabase
  .from("score_snapshots")
  .select("overall_score, fundamental_score_adj, cot_score, retail_score, risk_adj, recorded_at")
  .eq("currency_code", "EUR")
  .order("recorded_at", { ascending: false })
  .limit(3);
console.log("\n=== score_snapshots EUR (posledni 3) ===");
for (const s of snaps ?? []) console.log(JSON.stringify(s));

const { data: thesis } = await supabase
  .from("currency_thesis")
  .select("*")
  .eq("currency_code", "EUR")
  .in("status", ["active", "watching"])
  .order("opened_at", { ascending: false })
  .limit(1);
console.log("\n=== currency_thesis EUR (živá) ===");
console.log(JSON.stringify(thesis?.[0], null, 2));

if (thesis?.[0]) {
  const { data: ledger } = await supabase
    .from("thesis_ledger")
    .select("driver_key, classification, reasoning, occurred_at")
    .eq("thesis_id", thesis[0].id)
    .order("occurred_at", { ascending: false })
    .limit(10);
  console.log("\n=== thesis_ledger EUR (posledních 10) ===");
  for (const l of ledger ?? []) console.log(l.occurred_at, l.classification, l.driver_key, "-", l.reasoning);
}
