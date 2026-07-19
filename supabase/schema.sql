-- Konfluence — schéma pro reálná COT data (CFTC Traders in Financial Futures)
-- Spusťte celý tento soubor jednorázově v Supabase SQL editoru (Project → SQL Editor → New query).

-- ── currencies: statická mapovací tabulka, seedovaná jednou ────────────────
create table currencies (
  code                      text primary key,          -- 'EUR','GBP','JPY','CHF','CAD','AUD','NZD','USD'
  name                      text not null,
  cftc_contract_market_code text not null unique,
  market_and_exchange_name  text not null,
  exchange                  text not null check (exchange in ('CME','ICE')),
  contract_unit             text,
  is_active                 boolean not null default true
);

insert into currencies (code, name, cftc_contract_market_code, market_and_exchange_name, exchange, contract_unit) values
  ('EUR','Euro',              '099741','EURO FX - CHICAGO MERCANTILE EXCHANGE','CME','EUR 125,000'),
  ('GBP','British Pound',     '096742','BRITISH POUND STERLING - CHICAGO MERCANTILE EXCHANGE','CME','GBP 62,500'),
  ('JPY','Japanese Yen',      '097741','JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE','CME','JPY 12,500,000'),
  ('CHF','Swiss Franc',       '092741','SWISS FRANC - CHICAGO MERCANTILE EXCHANGE','CME','CHF 125,000'),
  ('CAD','Canadian Dollar',   '090741','CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE','CME','CAD 100,000'),
  ('AUD','Australian Dollar', '232741','AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE','CME','AUD 100,000'),
  ('NZD','New Zealand Dollar','112741','NZ DOLLAR - CHICAGO MERCANTILE EXCHANGE','CME','NZD 100,000'),
  ('USD','US Dollar Index',   '098662','USD INDEX - ICE FUTURES U.S.','ICE','$1,000 x index');

-- ── cot_reports: jeden řádek na měnu/report_date, raw historie ─────────────
create table cot_reports (
  id                bigint generated always as identity primary key,
  currency_code     text not null references currencies(code),
  report_date       date not null,
  report_type       text not null default 'TFF_FUT', -- prostor pro 'TFF_COMBINED' později
  open_interest_all bigint,
  dealer_long       bigint, dealer_short    bigint, dealer_spread    bigint,
  asset_mgr_long    bigint, asset_mgr_short  bigint, asset_mgr_spread  bigint,
  lev_money_long    bigint, lev_money_short  bigint, lev_money_spread  bigint,
  other_rept_long   bigint, other_rept_short bigint, other_rept_spread bigint,
  lev_money_net     bigint generated always as (lev_money_long - lev_money_short) stored,
  raw               jsonb,          -- celá API odpověď, pro audit/debug/reprocessing
  ingested_at       timestamptz not null default now(),
  unique (currency_code, report_date, report_type)
);
create index cot_reports_currency_date_idx on cot_reports (currency_code, report_date desc);

-- ── confluence_scores: co čte frontend ──────────────────────────────────────
create table confluence_scores (
  id                    bigint generated always as identity primary key,
  currency_code         text not null references currencies(code),
  report_date           date not null,               -- váže se na cot_reports řádek použitý k výpočtu
  lev_money_net         bigint,
  cot_zscore            numeric,
  cot_wow_change        bigint,
  cot_4w_change         bigint,
  cot_score             numeric(4,2) not null,        -- -5..+5, jen COT komponenta
  overall_score         numeric(4,2) not null,        -- zatím == cot_score (viz komentář ve scoring.mjs)
  data_tier             text not null default 'cot_only' check (data_tier in ('cot_only','partial','full')),
  conviction_label      text not null,                -- např. "STŘEDNÍ CONVICTION (POUZE COT · 1/5 PILÍŘŮ)"
  cot_positioning_label text,                          -- např. "Blízko extrému (long)"
  summary               text,
  computed_at           timestamptz not null default now(),
  unique (currency_code, report_date)
);
create index confluence_scores_currency_date_idx on confluence_scores (currency_code, report_date desc);

create view latest_confluence_scores as
  select distinct on (currency_code) *
  from confluence_scores
  order by currency_code, report_date desc;

-- ── RLS: veřejné anonymní SELECT, žádný zápis přes anon/publishable klíč ────
alter table currencies         enable row level security;
alter table cot_reports        enable row level security;
alter table confluence_scores  enable row level security;

create policy "public read currencies"        on currencies        for select using (true);
create policy "public read cot_reports"       on cot_reports       for select using (true);
create policy "public read confluence_scores" on confluence_scores for select using (true);
-- Žádné insert/update/delete policy pro anon/authenticated → zápis je defaultně zakázaný.
-- service_role role (sb_secret_... klíč) má BYPASSRLS a těmito policy není omezena —
-- to je role, kterou používá ingest skript pro zápis.

grant select on currencies, cot_reports, confluence_scores, latest_confluence_scores
  to anon, authenticated;
