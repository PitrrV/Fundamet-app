import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function span(table, dateCol, extraSelect = "") {
  const { count } = await supabase.from(table).select("*", { count: "exact", head: true });
  const { data: oldest } = await supabase.from(table).select(dateCol + extraSelect).order(dateCol, { ascending: true }).limit(1);
  const { data: newest } = await supabase.from(table).select(dateCol + extraSelect).order(dateCol, { ascending: false }).limit(1);
  console.log(`${table}: ${count} řádků, rozsah ${oldest?.[0]?.[dateCol]} .. ${newest?.[0]?.[dateCol]}`);
}

console.log("=== Historická hloubka dat pro backtest ===\n");
await span("cot_reports", "report_date");
await span("confluence_scores", "report_date");
await span("score_snapshots", "recorded_at");
await span("narratives", "generated_at");

const { count: calCount } = await supabase.from("calendar_events").select("*", { count: "exact", head: true }).not("actual", "is", null);
console.log(`calendar_events s vyplněným actual: ${calCount}`);

const { data: cotPerCurrency } = await supabase.from("cot_reports").select("currency_code, report_date");
const byCcy = {};
for (const r of cotPerCurrency ?? []) {
  byCcy[r.currency_code] ??= { count: 0, min: r.report_date, max: r.report_date };
  byCcy[r.currency_code].count++;
  if (r.report_date < byCcy[r.currency_code].min) byCcy[r.currency_code].min = r.report_date;
  if (r.report_date > byCcy[r.currency_code].max) byCcy[r.currency_code].max = r.report_date;
}
console.log("\ncot_reports podle měny:");
for (const [ccy, v] of Object.entries(byCcy)) console.log(`  ${ccy}: ${v.count} týdnů, ${v.min} .. ${v.max}`);

const { data: snapRows } = await supabase.from("score_snapshots").select("currency_code, recorded_at").order("recorded_at");
console.log(`\nscore_snapshots celkem: ${snapRows?.length ?? 0} řádků`);
for (const r of (snapRows ?? []).slice(0, 5)) console.log(`  ${r.currency_code} @ ${r.recorded_at}`);

const { data: mr } = await supabase.from("market_regime").select("*");
console.log("\nmarket_regime (jediný řádek, bez historie):", JSON.stringify(mr));
