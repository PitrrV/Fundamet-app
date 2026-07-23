-- Konfluence Gen3.5 Fáze 1 — Confidence & Data Quality Engine, jen Data Quality + Coverage
-- (viz architektonický návrh Gen3.5 a jeho revizní log). Nezávisí na currency_thesis/MEE —
-- funguje čistě nad kvalitou vstupních dat (COT, kalendář), takže dává hodnotu hned, bez
-- čekání na nasbíranou historii tezí.
--
-- importance_tier je rovnou v první verzi (schválená úprava #3 z revizního logu Gen3.5) —
-- numerická váha by řídila plynulé skóre, tier řídí tvrdé pravidlo: chybějící "critical"
-- kategorie stropuje data_quality_score na LOW bez ohledu na zbytek (viz data-quality.mjs).

-- ── category_expectations: co by měla mít každá měna "core" a jak často ────────────────────
-- Editorský seed (stejná konvence jako zbytek systému — ne zpětně testováno), stejný napříč
-- všemi 8 měnami jako startovní bod. Kategorie odpovídají EVENT_RULES.cat z
-- fundamental-scoring.mjs. Lze později doladit per měna (viz Gen2 diskuze o currency-specific
-- vahách) — tahle tabulka je teď JEDINÝ zdroj pravdy pro "co je pro tuhle měnu důležité".
create table if not exists category_expectations (
  currency_code           text not null references currencies(code),
  category                text not null,
  importance_tier         text not null check (importance_tier in ('critical','major','supporting')),
  expected_frequency_days int not null,
  primary key (currency_code, category)
);

insert into category_expectations (currency_code, category, importance_tier, expected_frequency_days)
select c.code, cat.category, cat.tier, cat.freq
from currencies c
cross join (values
  ('Interest Rates',        'critical',   42),
  ('Inflation',              'critical',   32),
  ('Labor +Jobs',            'major',      32),
  ('Labor -Unemployment',    'major',      32),
  ('PMI',                    'major',      32),
  ('GDP',                    'supporting', 95),
  ('Retail Sales',           'supporting', 32)
) as cat(category, tier, freq)
on conflict (currency_code, category) do nothing;

-- ── data_quality_flags: AKTUÁLNÍ aktivní problémy (ne append-only log) ─────────────────────
-- Každý běh fetch-calendar.mjs přepočítá a upsertne — flag, co už neplatí, se smaže. Jednodušší
-- než plný audit log pro první fázi; jde rozšířit na append-only později, pokud bude potřeba
-- historie "kdy přesně flag vznikl/zmizel".
create table if not exists data_quality_flags (
  id            bigint generated always as identity primary key,
  currency_code text not null references currencies(code),
  source_type   text not null check (source_type in ('cot_reports','calendar_events')),
  flag_type     text not null check (flag_type in ('stale_cot','missing_event','pending_actual_overdue')),
  category      text,              -- vyplněno jen u missing_event
  severity      text not null check (severity in ('LOW','MEDIUM','HIGH')),
  detail        text not null,
  detected_at   timestamptz not null default now(),
  unique (currency_code, flag_type, category)
);

create table if not exists data_quality_score (
  currency_code text primary key references currencies(code),
  score         int not null check (score between 0 and 100),
  active_flags  jsonb not null default '[]',
  computed_at   timestamptz not null default now()
);

create table if not exists data_coverage (
  currency_code text primary key references currencies(code),
  expected      jsonb not null default '[]',
  present       jsonb not null default '[]',
  missing       jsonb not null default '[]',
  coverage_pct  numeric not null,
  computed_at   timestamptz not null default now()
);

alter table category_expectations enable row level security;
alter table data_quality_flags    enable row level security;
alter table data_quality_score    enable row level security;
alter table data_coverage         enable row level security;

drop policy if exists "public read category_expectations" on category_expectations;
drop policy if exists "public read data_quality_flags"     on data_quality_flags;
drop policy if exists "public read data_quality_score"     on data_quality_score;
drop policy if exists "public read data_coverage"          on data_coverage;
create policy "public read category_expectations" on category_expectations for select using (true);
create policy "public read data_quality_flags"     on data_quality_flags     for select using (true);
create policy "public read data_quality_score"     on data_quality_score     for select using (true);
create policy "public read data_coverage"          on data_coverage          for select using (true);

grant select on category_expectations, data_quality_flags, data_quality_score, data_coverage to anon, authenticated;
