import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("score_snapshots")
  .select("currency_code, overall_score, recorded_at")
  .order("currency_code", { ascending: true })
  .order("recorded_at", { ascending: true });

if (error) {
  console.error("chyba čtení score_snapshots:", error.message);
  process.exit(1);
}

// Seskup podle měny, spočítej delty mezi po sobě jdoucími řádky (stejná logika jako
// view latest_score_change, jen přes celou historii, ne jen poslední řádek).
const byCurrency = new Map();
for (const row of data) {
  if (!byCurrency.has(row.currency_code)) byCurrency.set(row.currency_code, []);
  byCurrency.get(row.currency_code).push(row);
}

const buckets = { "0.05-0.09": 0, "0.10-0.14": 0, "0.15-0.19": 0, "0.20-0.29": 0, "0.30-0.49": 0, "0.50+": 0 };
let total = 0;
const firstTs = data[0]?.recorded_at;
const lastTs = data[data.length - 1]?.recorded_at;

for (const [code, rows] of byCurrency) {
  let exactly01 = 0;
  let ge02 = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i].overall_score - rows[i - 1].overall_score);
    total++;
    if (d >= 0.05 && d < 0.1) buckets["0.05-0.09"]++;
    else if (d >= 0.1 && d < 0.15) { buckets["0.10-0.14"]++; exactly01++; }
    else if (d >= 0.15 && d < 0.2) buckets["0.15-0.19"]++;
    else if (d >= 0.2 && d < 0.3) { buckets["0.20-0.29"]++; ge02++; }
    else if (d >= 0.3 && d < 0.5) { buckets["0.30-0.49"]++; ge02++; }
    else if (d >= 0.5) { buckets["0.50+"]++; ge02++; }
  }
  console.log(`${code}: ${rows.length} snapshotů, ${exactly01} pohybů přesně v pásmu 0.10-0.14, ${ge02} pohybů >=0.2`);
}

console.log("\n=== Rozdělení všech pohybů (napříč všemi měnami) ===");
console.log(JSON.stringify(buckets, null, 2));
console.log(`Celkem pohybů (>=0.05): ${total}`);
console.log(`Časové okno dat: ${firstTs} -> ${lastTs}`);

const days = (new Date(lastTs) - new Date(firstTs)) / 86400000;
const would01 = buckets["0.05-0.09"] + buckets["0.10-0.14"] + buckets["0.15-0.19"] + buckets["0.20-0.29"] + buckets["0.30-0.49"] + buckets["0.50+"];
const would02 = buckets["0.20-0.29"] + buckets["0.30-0.49"] + buckets["0.50+"];
console.log(`\nZa ${days.toFixed(1)} dní dat:`);
console.log(`  práh >=0.1 by zaalertoval ${would01}x (~${(would01 / days).toFixed(1)}/den napříč všemi 8 měnami)`);
console.log(`  práh >=0.2 by zaalertoval ${would02}x (~${(would02 / days).toFixed(1)}/den napříč všemi 8 měnami)`);
