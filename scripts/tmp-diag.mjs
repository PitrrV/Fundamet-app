import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

const { data: authData, error: authErr } = await supabase.auth.verifyOtp({
  email: "p.vospalek@gmail.com",
  token: "28516853",
  type: "email",
});

if (authErr) {
  console.error("verifyOtp selhal:", authErr.message);
  process.exit(1);
}
console.log("Přihlášeno jako:", authData.user?.email, "role v JWT:", authData.session?.access_token ? "má token" : "BEZ TOKENU");

// Stejné dotazy jako fetchCurrencies.ts, ale teď přes klienta se skutečnou authenticated
// session (ne anon) — přesně to, co dělá prohlížeč přihlášeného uživatele.
const today = new Date().toISOString().slice(0, 10);
const upcomingCutoff = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);

const queries = {
  latest_confluence_scores: () => supabase.from("latest_confluence_scores").select("currency_code, overall_score").order("currency_code"),
  latest_narratives: () => supabase.from("latest_narratives").select("currency_code, narrative"),
  calendar_events: () =>
    supabase.from("calendar_events").select("id, currency_code, event_day").gte("event_day", today).lte("event_day", upcomingCutoff),
  latest_fundamental_scores: () => supabase.from("latest_fundamental_scores").select("currency_code, fundamental_score"),
  cb_policy_state: () => supabase.from("cb_policy_state").select("currency_code, rate"),
  market_regime: () => supabase.from("market_regime").select("vix").limit(1),
  latest_currency_thesis: () => supabase.from("latest_currency_thesis").select("currency_code, direction"),
  data_quality_score: () => supabase.from("data_quality_score").select("currency_code, score"),
  data_coverage: () => supabase.from("data_coverage").select("currency_code, coverage_pct"),
  thesis_ledger_feed: () => supabase.from("thesis_ledger_feed").select("currency_code, reasoning").limit(200),
  latest_score_change: () => supabase.from("latest_score_change").select("currency_code, delta"),
  regime_shift_state: () => supabase.from("regime_shift_state").select("currency_code, alert"),
};

console.log("\n=== Dotazy s authenticated session (přihlášený uživatel) ===");
for (const [name, fn] of Object.entries(queries)) {
  const { error, data } = await fn();
  console.log(`  ${error ? "FAIL" : "OK "} ${name}${error ? ` — ${error.message}` : ` (${data?.length ?? 0} řádků)`}`);
}

await supabase.auth.signOut();
