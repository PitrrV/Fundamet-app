// DOČASNÝ audit skript #2 — READ ONLY, žádné volání OpenAI.
// Ověřuje saturaci (clamp) fundamentálního skóre napříč VŠEMI měnami.
import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore } from "./fundamental-scoring.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const allCalendarEvents = [];
{
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data: page, error } = await supabase
      .from("calendar_events")
      .select("currency_code, event_title, event_day, actual, estimate, previous, impact")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    allCalendarEvents.push(...page);
    if (page.length < pageSize) break;
  }
}

const CODES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];
const now = new Date();

console.log("=== SATURACE FUNDAMENTÁLNÍHO SKÓRE (clamp -5..5) ===");
console.log("rawScore je PŘED clampem; |rawScore| >= 5 znamená, že skóre je zaseknuté na stropu\n");
console.log("měna  rawScore  confidence  fundScore  |  citlivost na velký beat  | saturováno?");
console.log("-".repeat(88));

let saturated = 0;
for (const code of CODES) {
  const base = computeFundamentalScore(code, allCalendarEvents, now);
  const fake = {
    currency_code: code,
    event_title: "Non-Farm Employment Change",
    event_day: now.toISOString().slice(0, 10),
    actual: "300K", estimate: "150K", previous: "150K", impact: "High",
  };
  const up = computeFundamentalScore(code, [...allCalendarEvents, fake], now);
  const fakeMiss = { ...fake, actual: "10K" };
  const down = computeFundamentalScore(code, [...allCalendarEvents, fakeMiss], now);

  const dUp = up.fundamentalScore - base.fundamentalScore;
  const dDown = down.fundamentalScore - base.fundamentalScore;
  const isSat = Math.abs(base.rawScore) >= 5 || (Math.abs(dUp) < 0.05 && Math.abs(dDown) < 0.05);
  if (isSat) saturated++;

  console.log(
    `${code}   ${String(base.rawScore).padStart(7)}  ${String(base.confidence).padStart(9)}  ` +
    `${String(base.fundamentalScore).padStart(8)}  |  beat ${dUp >= 0 ? "+" : ""}${dUp.toFixed(2)} / miss ${dDown >= 0 ? "+" : ""}${dDown.toFixed(2)}  | ${isSat ? "ANO — mrtvý vstup" : "ne"}`
  );
}
console.log("-".repeat(88));
console.log(`Saturovaných měn: ${saturated}/8\n`);

console.log("=== JAK ČASTO SE SKÓRE REÁLNĚ HÝBE (score_snapshots za 14 dní) ===");
const { data: snaps } = await supabase
  .from("score_snapshots")
  .select("currency_code, overall_score, fundamental_score_adj, cot_score, risk_adj, recorded_at")
  .gte("recorded_at", new Date(Date.now() - 14 * 864e5).toISOString())
  .order("recorded_at", { ascending: true });

const byCode = {};
for (const s of snaps ?? []) (byCode[s.currency_code] ??= []).push(s);
console.log("měna  snímků/14d   rozsah overall   který pilíř se hýbal nejvíc");
console.log("-".repeat(78));
for (const code of CODES) {
  const rows = byCode[code] ?? [];
  if (rows.length < 2) { console.log(`${code}   ${String(rows.length).padStart(3)}  (málo dat)`); continue; }
  const os = rows.map((r) => Number(r.overall_score));
  const rng = `${Math.min(...os).toFixed(1)} .. ${Math.max(...os).toFixed(1)}`;
  const spread = (key) => {
    const v = rows.map((r) => Number(r[key])).filter((n) => !Number.isNaN(n));
    return v.length ? Math.max(...v) - Math.min(...v) : 0;
  };
  const parts = { fund: spread("fundamental_score_adj"), cot: spread("cot_score"), risk: spread("risk_adj") };
  const top = Object.entries(parts).sort((a, b) => b[1] - a[1])[0];
  console.log(
    `${code}   ${String(rows.length).padStart(3)}        ${rng.padEnd(15)}  ` +
    `${top[0]} (rozpětí ${top[1].toFixed(2)})   [fund ${parts.fund.toFixed(2)} / cot ${parts.cot.toFixed(2)} / risk ${parts.risk.toFixed(2)}]`
  );
}
