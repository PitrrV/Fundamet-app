-- Konfluence Gen2 — Market Expectations Engine (MEE), viz architektonický návrh Gen2.
-- Odděluje "co trh oficiálně čeká" (consensus estimate z ForexFactory) od "na co je trh
-- reálně napozicovaný" (COT percentil) — bez toho appka neumí poznat rozdíl mezi "beat, co je
-- skutečná novinka" a "beat, co jen potvrzuje, co už bylo v pozicování" (sell-the-news riziko).

-- ── market_expectations: snapshot PŘED eventem, refreshuje se každým cronem dokud actual chybí ──
create table if not exists market_expectations (
  id                    bigint generated always as identity primary key,
  calendar_event_id     bigint not null unique references calendar_events(id),
  currency_code         text not null references currencies(code),
  event_title           text not null,
  event_day             date not null,
  consensus_estimate    text,
  cot_percentile_snapshot numeric,           -- 0-100, jak "crowded" je pozicování v čase snapshotu
  positioning_bias      text check (positioning_bias in ('crowded_long','crowded_short','neutral')),
  historical_beat_rate  numeric,             -- 0-100, % posledních výskytů téhle řady, co beatly odhad
  priced_in_score       numeric,             -- 0-1, |percentil-50|/50 — jak extrémní je pozicování
  snapshot_at           timestamptz not null default now()
);
create index if not exists market_expectations_currency_day_idx on market_expectations (currency_code, event_day);

-- ── event_reactions: vyhodnoceno PO eventu, jakmile je actual známý ────────────────────────────
create table if not exists event_reactions (
  id                    bigint generated always as identity primary key,
  market_expectation_id bigint not null unique references market_expectations(id),
  calendar_event_id     bigint not null unique references calendar_events(id),
  currency_code         text not null references currencies(code),
  event_title           text not null,
  event_day             date not null,
  actual                text,
  surprise_direction    int not null check (surprise_direction in (-1, 0, 1)),
  surprise_strength     numeric,
  priced_in_score       numeric,             -- zkopírováno ze snapshotu, pro audit bez joinu
  reaction_quality      text not null check (reaction_quality in ('as_expected','genuine_surprise','sell_the_news_risk')),
  computed_at           timestamptz not null default now()
);
create index if not exists event_reactions_currency_day_idx on event_reactions (currency_code, event_day desc);

alter table market_expectations enable row level security;
alter table event_reactions     enable row level security;

drop policy if exists "public read market_expectations" on market_expectations;
drop policy if exists "public read event_reactions"     on event_reactions;
create policy "public read market_expectations" on market_expectations for select using (true);
create policy "public read event_reactions"     on event_reactions     for select using (true);

grant select on market_expectations, event_reactions to anon, authenticated;
