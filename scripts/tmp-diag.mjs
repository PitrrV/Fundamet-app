import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function main() {
  console.log("=== score_snapshots CAD posledních 10 ===");
  const { data: cadSnaps, error: e1 } = await supabase
    .from("score_snapshots")
    .select("*")
    .eq("currency_code", "CAD")
    .order("recorded_at", { ascending: false })
    .limit(10);
  if (e1) console.error("chyba:", e1.message);
  for (const r of cadSnaps ?? []) console.log(JSON.stringify(r));

  console.log("\n=== score_snapshots VŠECHNY měny za posledních 8 hodin ===");
  const since = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
  const { data: allSnaps, error: e2 } = await supabase
    .from("score_snapshots")
    .select("*")
    .gte("recorded_at", since)
    .order("recorded_at", { ascending: false });
  if (e2) console.error("chyba:", e2.message);
  for (const r of allSnaps ?? []) {
    console.log(
      `${r.recorded_at} [${r.currency_code}] overall=${r.overall_score} fund_adj=${r.fundamental_score_adj} cot=${r.cot_score} retail=${r.retail_score} risk_adj=${r.risk_adj}`
    );
  }

  console.log("\n=== cot_reports CAD posledních 6 (lev_money_net atd.) ===");
  const { data: cotRows, error: e3 } = await supabase
    .from("cot_reports")
    .select("report_date, lev_money_long, lev_money_short, lev_money_net")
    .eq("currency_code", "CAD")
    .order("report_date", { ascending: false })
    .limit(6);
  if (e3) console.error("chyba:", e3.message);
  for (const r of cotRows ?? []) console.log(JSON.stringify(r));

  console.log("\n=== confluence_scores CAD posledních 6 (cot detaily) ===");
  const { data: confRows, error: e3b } = await supabase
    .from("confluence_scores")
    .select("report_date, lev_money_net, cot_zscore, cot_wow_change, cot_4w_change, cot_score, retail_score, cot_percentile, overall_score, computed_at")
    .eq("currency_code", "CAD")
    .order("report_date", { ascending: false })
    .limit(6);
  if (e3b) console.error("chyba:", e3b.message);
  for (const r of confRows ?? []) console.log(JSON.stringify(r));

  console.log("\n=== fundamental_scores CAD posledních 6 ===");
  const { data: fundRows, error: e4 } = await supabase
    .from("fundamental_scores")
    .select("*")
    .eq("currency_code", "CAD")
    .order("computed_at", { ascending: false })
    .limit(6);
  if (e4) console.error("chyba:", e4.message);
  for (const r of fundRows ?? []) console.log(JSON.stringify(r));

  console.log("\n=== calendar_events CAD posledních 14 dní s actual ===");
  const sinceCal = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data: calRows, error: e5 } = await supabase
    .from("calendar_events")
    .select("event_day, event_title, actual, estimate, previous, impact")
    .eq("currency_code", "CAD")
    .gte("event_day", sinceCal)
    .not("actual", "is", null)
    .order("event_day", { ascending: false });
  if (e5) console.error("chyba:", e5.message);
  for (const r of calRows ?? []) console.log(JSON.stringify(r));

  console.log("\n=== cb_policy_state CAD ===");
  const { data: cbRows, error: e6 } = await supabase.from("cb_policy_state").select("*").eq("currency_code", "CAD");
  if (e6) console.error("chyba:", e6.message);
  for (const r of cbRows ?? []) console.log(JSON.stringify(r));

  console.log("\n=== latest_confluence_scores + latest_fundamental_scores VŠECHNY měny ===");
  const { data: conf } = await supabase
    .from("latest_confluence_scores")
    .select("currency_code, overall_score, cot_score, retail_score, report_date, computed_at")
    .order("currency_code");
  const { data: fund } = await supabase.from("latest_fundamental_scores").select("currency_code, fundamental_score, raw_score, confidence, computed_at");
  for (const c of conf ?? []) {
    const f = (fund ?? []).find((x) => x.currency_code === c.currency_code);
    console.log(
      `[${c.currency_code}] overall=${c.overall_score} cot=${c.cot_score} retail=${c.retail_score} fund=${f?.fundamental_score} raw=${f?.raw_score} conf=${f?.confidence} conf_computed=${c.computed_at} fund_computed=${f?.computed_at}`
    );
  }
}

main();
