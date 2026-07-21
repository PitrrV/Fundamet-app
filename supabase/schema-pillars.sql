-- Konfluence — třetí fáze: CB politika/real yield/zaceněnost, retail sentiment (COT
-- non-reportable), COT percentil, risk-on/off režim (VIX), konvicience ze shody signálů,
-- a scénářová predikce ("když X, tak Y") v narrative.
-- Spusťte tento soubor jednorázově v Supabase SQL editoru, AŽ PO schema.sql a
-- schema-fundamentals.sql (navazuje na cot_reports, confluence_scores, narratives).

-- ── cot_reports: retail sentiment vychází ze STEJNÉHO CFTC TFF reportu jako COT ────────────
-- non-reportable pozice (malí spekulanti = retail) — pole už chodí v `raw`, jen se dosud
-- neukládala do vlastních sloupců.
alter table cot_reports add column if not exists nonrept_long  bigint;
alter table cot_reports add column if not exists nonrept_short bigint;

-- ── confluence_scores: retail skóre, COT percentil, konvicience ze shody signálů ───────────
alter table confluence_scores add column if not exists retail_score       numeric(4,2);
alter table confluence_scores add column if not exists cot_percentile     numeric;
alter table confluence_scores add column if not exists conviction_stars   integer;
alter table confluence_scores add column if not exists conviction_reasons jsonb;

-- ── cb_policy_state: politika CB, real yield, zaceněnost — odvozeno z calendar_events ──────
create table cb_policy_state (
  currency_code    text primary key references currencies(code),
  rate             numeric,          -- poslední známá politická sazba (z Interest Rate eventů)
  cpi              numeric,          -- poslední známá roční inflace (z Inflation eventů)
  policy_score     numeric,          -- -2..+2, hiking/cutting cyklus (autoDetectCBPolicy styl)
  policy_label     text,             -- např. "agresivní hiking (+1.25 % za rok)"
  policy_confidence text,            -- HIGH/MEDIUM/LOW podle konzistence posledních rozhodnutí
  real_yield_adj   numeric(4,2),     -- ±1.0, (rate-cpi) relativně k průměru ostatních měn
  cb_policy_adj    numeric(4,2),     -- ±0.75, policy_score relativně k průměru ostatních měn
  priced_in        jsonb,            -- {method:'yield_gap'|'decision_consensus', label, confidenceLevel}
  rate_history     jsonb,            -- [{date,rate}], pro audit/debug
  updated_at       timestamptz not null default now()
);

-- ── market_regime: risk-on/off z VIX (FRED, bez klíče) — jeden řádek, přepisuje se ────────
create table market_regime (
  id               boolean primary key default true check (id),  -- vynutí přesně 1 řádek
  vix              numeric,
  vix_5d_change    numeric,
  regime           text check (regime in ('RISK_ON','NEUTRAL','RISK_OFF')),
  updated_at       timestamptz not null default now()
);

-- ── narratives: scénářová predikce ("když X, tak Y") ────────────────────────────────────────
alter table narratives add column if not exists scenarios jsonb;

-- ── RLS: stejný vzor jako u stávajících tabulek — veřejné SELECT, zápis jen přes service_role ──
alter table cb_policy_state enable row level security;
alter table market_regime   enable row level security;

create policy "public read cb_policy_state" on cb_policy_state for select using (true);
create policy "public read market_regime"   on market_regime   for select using (true);

grant select on cb_policy_state, market_regime to anon, authenticated;
