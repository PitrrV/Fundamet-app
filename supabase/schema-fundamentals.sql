-- Konfluence — druhý pilíř: ekonomický kalendář (ForexFactory) + fundamentální skóre + narrative.
-- Spusťte tento soubor jednorázově v Supabase SQL editoru (Project → SQL Editor → New query).
-- Navazuje na supabase/schema.sql (currencies, cot_reports, confluence_scores) — nespouštět
-- místo něj, ale až po něm.

-- ── calendar_events: scrapované + průběžně doplňované eventy z ForexFactory ────────────────
-- currency_code NENÍ FK na currencies(code) záměrně — potřebujeme ukládat i eventy pro CNY
-- (nepřímá relevance pro AUD/NZD, viz fundamental-scoring.mjs), a CNY není v currencies
-- (nemá CFTC kontrakt, není to obchodovaná měna appky).
create table calendar_events (
  id                bigint generated always as identity primary key,
  currency_code     text not null,
  event_title       text not null,
  event_day         date not null,          -- dedup klíč BEZ přesného času (FF čas u budoucích eventů posouvá)
  event_time        timestamptz,            -- plný čas, pokud je znám
  impact            text not null default 'Medium' check (impact in ('Low','Medium','High')),
  actual            text,
  estimate          text,
  previous          text,
  updated_at        timestamptz not null default now(),
  unique (currency_code, event_title, event_day)
);
create index calendar_events_currency_day_idx on calendar_events (currency_code, event_day);

-- ── fundamental_scores: výstup fundamentálního scoring enginu (EVENT_RULES atd.) ───────────
create table fundamental_scores (
  id                bigint generated always as identity primary key,
  currency_code     text not null references currencies(code),
  computed_at       timestamptz not null default now(),
  raw_score         numeric,          -- před confidence dampingem
  confidence        numeric,          -- 0.4..1.0, podle nasbírané hloubky historie v calendar_events
  fundamental_score numeric,          -- raw_score * confidence, škálováno na -5..5 (stejně jako cot_score)
  history_months    numeric,          -- kolik měsíců historie máme nasbíráno pro tuhle měnu
  unique (currency_code, computed_at)
);
create index fundamental_scores_currency_date_idx on fundamental_scores (currency_code, computed_at desc);

create view latest_fundamental_scores as
  select distinct on (currency_code) *
  from fundamental_scores
  order by currency_code, computed_at desc;

-- ── narratives: OpenAI "vypravěč" — syntéza COT + fundamentů do příběhu ────────────────────
create table narratives (
  id                bigint generated always as identity primary key,
  currency_code     text not null references currencies(code),
  narrative         text not null,
  forward_flag      text,
  conviction_note   text,
  model             text not null,     -- jaký OpenAI model příběh vygeneroval, pro audit
  generated_at      timestamptz not null default now()
);
create index narratives_currency_date_idx on narratives (currency_code, generated_at desc);

create view latest_narratives as
  select distinct on (currency_code) *
  from narratives
  order by currency_code, generated_at desc;

-- ── RLS: stejný vzor jako u stávajících tabulek — veřejné SELECT, zápis jen přes service_role ──
alter table calendar_events     enable row level security;
alter table fundamental_scores  enable row level security;
alter table narratives          enable row level security;

create policy "public read calendar_events"     on calendar_events     for select using (true);
create policy "public read fundamental_scores"  on fundamental_scores  for select using (true);
create policy "public read narratives"          on narratives          for select using (true);

grant select on
  calendar_events,
  fundamental_scores, latest_fundamental_scores,
  narratives, latest_narratives
to anon, authenticated;
