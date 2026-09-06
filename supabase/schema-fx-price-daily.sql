-- Historické denní close ceny (5.9.2026) — SAMOSTATNÁ archivace, druhá polovina rovnice
-- pro budoucí backtest Retail Flow (retail_sentiment_intraday už existuje). Zdroj: veřejně
-- čitelné data/fx_daily/{PAIR}.json z https://github.com/PitrrV/Fx-Analyzer (appka tam má
-- vlastní denní cron proti Stooq/Yahoo Finance). Fundamet-app tenhle soubor jen ČTE přes
-- raw.githubusercontent.com — žádný nový cenový provider, žádné nové API klíče.
--
-- Záměrně BEZ vazby na overall_score/BLEND_WEIGHTS/UI/žádný signál — jen archivace pro
-- pozdější backtest (Retail Δ24H → následující denní return). Viz scripts/
-- ingest-fx-daily-prices.mjs a .github/workflows/ingest-fx-daily-prices.yml.
create table if not exists fx_price_daily (
  pair text not null,
  price_date date not null,
  close numeric not null,
  source text,
  ingested_at timestamptz not null default now(),
  primary key (pair, price_date)
);

create index if not exists idx_fx_price_daily_price_date
  on fx_price_daily (price_date);

alter table fx_price_daily enable row level security;

create policy "public read fx_price_daily"
  on fx_price_daily
  for select
  to public
  using (true);
