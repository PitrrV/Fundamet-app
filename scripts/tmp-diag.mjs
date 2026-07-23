import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: mee, error: meeErr } = await supabase
  .from("market_expectations")
  .select("currency_code, event_title, event_day, consensus_estimate, cot_percentile_snapshot, positioning_bias, historical_beat_rate, priced_in_score")
  .order("currency_code", { ascending: true })
  .limit(15);
if (meeErr) console.error("MEE chyba:", meeErr.message);
console.log("--- MARKET_EXPECTATIONS (prvních 15) ---");
for (const row of mee ?? []) console.log(JSON.stringify(row));

const { count: meeCount } = await supabase.from("market_expectations").select("*", { count: "exact", head: true });
console.log("market_expectations celkem:", meeCount);

const { data: flags, error: flagErr } = await supabase
  .from("data_quality_flags")
  .select("currency_code, flag_type, category, severity, detail")
  .order("currency_code", { ascending: true });
if (flagErr) console.error("Flags chyba:", flagErr.message);
console.log("--- DATA_QUALITY_FLAGS ---");
for (const row of flags ?? []) console.log(JSON.stringify(row));

const { data: coverage, error: covErr } = await supabase
  .from("data_coverage")
  .select("currency_code, expected, present, missing, coverage_pct")
  .order("currency_code", { ascending: true });
if (covErr) console.error("Coverage chyba:", covErr.message);
console.log("--- DATA_COVERAGE ---");
for (const row of coverage ?? []) console.log(JSON.stringify(row));
