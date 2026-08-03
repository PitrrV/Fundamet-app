-- Appka byla dosud čitelná bez přihlášení (`grant select ... to anon` napříč všemi předchozími
-- schema-*.sql soubory) — kdokoli se znal URL, viděl celý dashboard i bez loginu. Uživatel chce
-- appku jen po registraci/přihlášení: kdokoli se svým e-mailem se ověří (viz AdminLogin.tsx),
-- ale bez ověření appka nenačte vůbec nic. Frontend gate (App.tsx) sám o sobě nestačí — anon
-- klíč je veřejně vyčitatelný z buildu, takže bez tohohle REVOKE by šlo tabulky dál číst přímo
-- přes Supabase REST API. Zápis (admin úpravy `calendar_events.actual`) byl už dřív jen pro
-- `authenticated` + RLS kontrolu admin e-mailu (schema-admin-edit.sql) — tam se nic nemění.
--
-- GitHub Actions cron skripty (fetch-calendar.mjs, ingest-cot.mjs, generate-narrative.mjs, ...)
-- používají SUPABASE_SERVICE_KEY (service_role), který RLS i grants obchází úplně — tenhle
-- REVOKE se jich netýká, žádné workflow nepřestane fungovat.

revoke select on currencies, cot_reports, confluence_scores, latest_confluence_scores from anon;

revoke select on
  calendar_events,
  fundamental_scores, latest_fundamental_scores,
  narratives, latest_narratives
from anon;

revoke select on currency_thesis, thesis_ledger, latest_currency_thesis from anon;

revoke select on market_expectations, event_reactions from anon;

revoke select on category_expectations, data_quality_flags, data_quality_score, data_coverage from anon;

revoke select on cb_policy_state, market_regime from anon;

revoke select on regime_shift_state from anon;

revoke select on score_snapshots, latest_score_change from anon;

revoke select on weekly_top_opportunity from anon;

revoke select on thesis_ledger_feed from anon;
