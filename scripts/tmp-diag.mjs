import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: narratives, error: nErr } = await supabase
  .from("narratives")
  .select("currency_code, generated_at, thesis_change_note, narrative")
  .order("generated_at", { ascending: false });
if (nErr) throw nErr;

const { data: snaps, error: sErr } = await supabase
  .from("score_snapshots")
  .select("currency_code, overall_score, recorded_at")
  .order("recorded_at", { ascending: true });
if (sErr) throw sErr;

const byCurrency = {};
for (const s of snaps) {
  (byCurrency[s.currency_code] ??= []).push(s);
}

console.log("=== score_snapshots per currency (count, first, last) ===");
for (const [code, rows] of Object.entries(byCurrency)) {
  console.log(code, "n=" + rows.length, "first=" + rows[0]?.recorded_at, "last=" + rows[rows.length - 1]?.recorded_at);
}

console.log("\n=== latest_score_change (delta between last two snapshots) ===");
for (const [code, rows] of Object.entries(byCurrency)) {
  if (rows.length < 2) {
    console.log(code, "insufficient snapshots");
    continue;
  }
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const delta = Math.round((last.overall_score - prev.overall_score) * 100) / 100;
  console.log(code, `last=${last.overall_score}@${last.recorded_at}`, `prev=${prev.overall_score}@${prev.recorded_at}`, `delta=${delta}`);
}

console.log("\n=== narratives (most recent per currency) ===");
const seen = new Set();
for (const n of narratives) {
  if (seen.has(n.currency_code)) continue;
  seen.add(n.currency_code);
  console.log(
    n.currency_code,
    "generated_at=" + n.generated_at,
    "thesis_change_note=" + (n.thesis_change_note ? JSON.stringify(n.thesis_change_note).slice(0, 200) : "null")
  );
}
