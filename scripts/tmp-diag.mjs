// DOČASNÝ diagnostický skript — smazat po použití. Jen čte, nic nezapisuje.
// Plný audit AI textů napříč všemi 8 měnami: narrative, forward_flag, conviction_note,
// thesis_change_note, scenarios (agenda) + čísla, proti kterým se dá text ověřit.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data: narratives, error: e1 } = await supabase
  .from("latest_narratives")
  .select("currency_code, narrative, forward_flag, conviction_note, thesis_change_note, scenarios")
  .order("currency_code", { ascending: true });
if (e1) { console.error(e1); process.exit(1); }

const { data: conf, error: e2 } = await supabase
  .from("latest_confluence_scores")
  .select("currency_code, overall_score, cot_score, conviction_label, conviction_stars, conviction_reasons, retail_score, cot_percentile")
  .order("currency_code", { ascending: true });
if (e2) { console.error(e2); process.exit(1); }

const { data: fund, error: e3 } = await supabase
  .from("latest_fundamental_scores")
  .select("currency_code, fundamental_score")
  .order("currency_code", { ascending: true });
if (e3) { console.error(e3); process.exit(1); }

const { data: thesis, error: e4 } = await supabase
  .from("latest_currency_thesis")
  .select("currency_code, direction, conviction, drivers, thesis_summary, status, confirm_streak, challenge_streak")
  .order("currency_code", { ascending: true });
if (e4) { console.error(e4); process.exit(1); }

for (const code of ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "NZD", "USD"]) {
  const n = narratives.find((r) => r.currency_code === code);
  const c = conf.find((r) => r.currency_code === code);
  const f = fund.find((r) => r.currency_code === code);
  const t = thesis.find((r) => r.currency_code === code);
  console.log(`\n===== ${code} =====`);
  console.log("SCORES:", JSON.stringify({ overall: c?.overall_score, cot: c?.cot_score, fund: f?.fundamental_score, conviction: c?.conviction_stars, retail: c?.retail_score, cotPct: c?.cot_percentile }));
  console.log("THESIS:", JSON.stringify({ direction: t?.direction, conviction: t?.conviction, status: t?.status, drivers: t?.drivers, summary: t?.thesis_summary }));
  console.log("NARRATIVE:", n?.narrative);
  console.log("FORWARD_FLAG:", n?.forward_flag);
  console.log("CONVICTION_NOTE:", n?.conviction_note);
  console.log("THESIS_CHANGE_NOTE:", n?.thesis_change_note);
  console.log("SCENARIOS:", JSON.stringify(n?.scenarios, null, 1));
}
