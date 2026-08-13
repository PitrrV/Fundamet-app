import { createClient } from "@supabase/supabase-js";

// Stejný klient (anon key), stejné dotazy, stejný vzor jako src/lib/fetchCurrencies.ts —
// cílem je reprodukovat přesně to, co dělá prohlížeč uživatele, ne server-side service-key
// cestu (ta běží úplně jinudy a nemusí odhalit stejný problém).
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

const today = new Date().toISOString().slice(0, 10);
const upcomingCutoff = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);

const queries = {
  latest_confluence_scores: () =>
    supabase
      .from("latest_confluence_scores")
      .select("currency_code, cot_score, overall_score, data_tier, conviction_label, cot_positioning_label, summary, retail_score, cot_percentile, conviction_stars, conviction_reasons")
      .order("currency_code", { ascending: true }),
  latest_fundamental_scores: () => supabase.from("latest_fundamental_scores").select("currency_code, fundamental_score"),
  latest_narratives: () =>
    supabase.from("latest_narratives").select("currency_code, narrative, forward_flag, conviction_note, scenarios, thesis_change_note"),
  calendar_events: () =>
    supabase
      .from("calendar_events")
      .select("id, currency_code, event_day, event_title, impact, estimate, previous, actual")
      .gte("event_day", today)
      .lte("event_day", upcomingCutoff)
      .order("event_day", { ascending: true }),
  cb_policy_state: () =>
    supabase.from("cb_policy_state").select("currency_code, rate, cpi, policy_score, policy_label, policy_confidence, real_yield_adj, cb_policy_adj, priced_in"),
  market_regime: () => supabase.from("market_regime").select("vix, vix_5d_change, regime").limit(1),
  latest_currency_thesis: () =>
    supabase.from("latest_currency_thesis").select("currency_code, direction, conviction, drivers, thesis_summary, status, confirm_streak, challenge_streak, opened_at"),
  data_quality_score: () => supabase.from("data_quality_score").select("currency_code, score"),
  data_coverage: () => supabase.from("data_coverage").select("currency_code, coverage_pct, missing"),
  thesis_ledger_feed: () =>
    supabase.from("thesis_ledger_feed").select("currency_code, driver_key, classification, reasoning, occurred_at").order("occurred_at", { ascending: false }).limit(200),
  latest_score_change: () => supabase.from("latest_score_change").select("currency_code, delta, previous_score, recorded_at"),
  regime_shift_state: () => supabase.from("regime_shift_state").select("currency_code, long_term_score, short_term_score, divergence, alert"),
};

console.log(`=== Měřím ${Object.keys(queries).length} dotazů (anon key, stejně jako appka) — 3 kola ===`);

for (let round = 1; round <= 3; round++) {
  console.log(`\n--- kolo ${round} ---`);
  const start = Date.now();
  const results = await Promise.all(
    Object.entries(queries).map(async ([name, fn]) => {
      const t0 = Date.now();
      try {
        const { error, count, data } = await fn();
        const ms = Date.now() - t0;
        return { name, ms, ok: !error, error: error?.message, rows: data?.length ?? count };
      } catch (e) {
        return { name, ms: Date.now() - t0, ok: false, error: e.message };
      }
    })
  );
  results.sort((a, b) => b.ms - a.ms);
  for (const r of results) console.log(`  ${r.ok ? "OK " : "FAIL"} ${r.name}: ${r.ms}ms${r.ok ? ` (${r.rows} řádků)` : ` — ${r.error}`}`);
  console.log(`  celé kolo (Promise.all): ${Date.now() - start}ms`);
}
