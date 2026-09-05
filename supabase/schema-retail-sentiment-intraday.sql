-- Intradenní retail sentiment (5.9.2026) — SAMOSTATNÁ časová řada, odděleně od týdenního
-- retail_score v confluence_scores. Zdroj: veřejně čitelný data/retail_hist.json z
-- https://github.com/PitrrV/Fx-Analyzer (30min cron tam), appka ho jen ČTE a archivuje
-- vlastní, trvalou historii — Fx-Analyzer si svou historii ořezává na ~45-75 dní, appka ne.
--
-- Záměrně BEZ vazby na overall_score/BLEND_WEIGHTS/UI — jen sběr dat. Viz scripts/
-- ingest-retail-intraday.mjs a .github/workflows/ingest-retail-intraday.yml.
create table if not exists retail_sentiment_intraday (
  currency_code text not null,
  recorded_at timestamptz not null,
  long_pct numeric not null,
  source text,
  ingested_at timestamptz not null default now(),
  primary key (currency_code, recorded_at)
);

-- Pro dotazy napříč měnami seřazené časem (např. "jak starý je poslední bod").
create index if not exists idx_retail_sentiment_intraday_recorded_at
  on retail_sentiment_intraday (recorded_at);

alter table retail_sentiment_intraday enable row level security;

-- Stejná konvence jako score_snapshots/market_regime — veřejné čtení, zápis jen přes
-- service_role klíč (ingest skript), který RLS obchází.
create policy "public read retail_sentiment_intraday"
  on retail_sentiment_intraday
  for select
  to public
  using (true);
