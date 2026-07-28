import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: snaps, error: snapsErr } = await supabase
  .from("score_snapshots")
  .select("currency_code, overall_score, fundamental_score_adj, cot_score, retail_score, risk_adj, conviction_stars, recorded_at")
  .order("recorded_at", { ascending: false })
  .limit(20);
console.log("=== score_snapshots (posledních 20) ===");
console.log(JSON.stringify(snaps, null, 2));
if (snapsErr) console.error("ERR score_snapshots:", snapsErr.message);

const { data: change, error: changeErr } = await supabase
  .from("latest_score_change")
  .select("*");
console.log("=== latest_score_change ===");
console.log(JSON.stringify(change, null, 2));
if (changeErr) console.error("ERR latest_score_change:", changeErr.message);

const { data: narr, error: narrErr } = await supabase
  .from("latest_narratives")
  .select("currency_code, thesis_change_note, generated_at")
  .order("currency_code");
console.log("=== latest_narratives.thesis_change_note ===");
console.log(JSON.stringify(narr, null, 2));
if (narrErr) console.error("ERR latest_narratives:", narrErr.message);
