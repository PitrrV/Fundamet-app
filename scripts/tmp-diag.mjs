// DOČASNÝ audit skript #3 — READ ONLY. Hloubka historie + distribuce delt pro posouzení
// backtestovatelnosti "24h změna skóre = intradenní edge" myšlenky.
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: span } = await supabase
  .from("score_snapshots")
  .select("recorded_at")
  .order("recorded_at", { ascending: true })
  .limit(1);
const { data: spanEnd } = await supabase
  .from("score_snapshots")
  .select("recorded_at")
  .order("recorded_at", { ascending: false })
  .limit(1);
const { count } = await supabase.from("score_snapshots").select("*", { count: "exact", head: true });

console.log("=== HLOUBKA HISTORIE score_snapshots ===");
console.log(`Od: ${span?.[0]?.recorded_at}`);
console.log(`Do: ${spanEnd?.[0]?.recorded_at}`);
console.log(`Celkem řádků: ${count}`);
const days = span?.[0] ? (new Date(spanEnd[0].recorded_at) - new Date(span[0].recorded_at)) / 86400000 : 0;
console.log(`Rozpětí: ${days.toFixed(1)} dní\n`);

console.log("=== DISTRIBUCE VELIKOSTI DELTA overall_score (za celou historii) ===");
const { data: all } = await supabase
  .from("score_snapshots")
  .select("currency_code, overall_score, recorded_at")
  .order("recorded_at", { ascending: true });

const byCode = {};
for (const r of all ?? []) (byCode[r.currency_code] ??= []).push(r);

let allDeltas = [];
for (const code of Object.keys(byCode)) {
  const rows = byCode[code];
  for (let i = 1; i < rows.length; i++) {
    const d = Number(rows[i].overall_score) - Number(rows[i - 1].overall_score);
    const hoursGap = (new Date(rows[i].recorded_at) - new Date(rows[i - 1].recorded_at)) / 3600000;
    allDeltas.push({ code, delta: d, hoursGap });
  }
}

const buckets = { "0.05-0.2": 0, "0.2-0.5": 0, "0.5-1.0": 0, ">1.0": 0 };
for (const d of allDeltas) {
  const a = Math.abs(d.delta);
  if (a < 0.2) buckets["0.05-0.2"]++;
  else if (a < 0.5) buckets["0.2-0.5"]++;
  else if (a < 1.0) buckets["0.5-1.0"]++;
  else buckets[">1.0"]++;
}
console.log(`Celkem zaznamenaných pohybů (>=0.05): ${allDeltas.length}`);
for (const [k, v] of Object.entries(buckets)) console.log(`  |delta| ${k.padEnd(10)} ${v} (${(v / allDeltas.length * 100).toFixed(0)}%)`);

const gaps = allDeltas.map((d) => d.hoursGap).sort((a, b) => a - b);
const median = gaps[Math.floor(gaps.length / 2)];
console.log(`\nMedián času mezi zaznamenanými pohyby: ${median.toFixed(1)} h`);
console.log(`Nejkratší mezera: ${gaps[0].toFixed(2)} h, nejdelší: ${gaps[gaps.length - 1].toFixed(1)} h`);
