-- Konfluence Gen2, Fáze 1 — Thesis Engine (viz architektonické návrhy Gen2/Gen2.5/Gen3/Gen3.5,
-- odeslané uživateli jako samostatné dokumenty). Běží zatím "ve stínu" vedle stávajícího systému:
-- currency_thesis/thesis_ledger se počítají a ukládají při každém běhu fetch-calendar.mjs, ale
-- frontend je ještě nečte — nejdřív se ověří na reálných datech, než se zapojí do UI.
--
-- driver_key je omezený na pevnou, kódem řízenou množinu ('fundamental_data', 'cot_positioning',
-- 'cb_policy', 'risk_regime', 'retail_sentiment') — sanity-check nález #5 (metrika, co může
-- časem změnit význam): risk_regime je sdílený/strukturální driver napříč měnami, takže musí mít
-- STEJNÝ klíč pro všechny měny, jinak by cross-currency regime detekce v pozdější fázi tiše
-- nefungovala. V téhle fázi ho přiřazuje jen náš vlastní deterministický kód (scripts/thesis-engine.mjs),
-- ne volný text, takže riziko drift je uzavřené konstrukcí, ne DB constraintem.

create table if not exists currency_thesis (
  id               bigint generated always as identity primary key,
  currency_code    text not null references currencies(code),
  direction        text not null check (direction in ('bullish','bearish','neutral')),
  conviction       numeric(3,1) not null,          -- 0..5, převzato z existujícího conviction_stars
  drivers          jsonb not null default '[]',    -- [{driver_key, label, value, status}]
  thesis_summary   text,
  status           text not null default 'active' check (status in ('active','watching','invalidated')),
  confirm_streak   int not null default 0,
  challenge_streak int not null default 0,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  superseded_by    bigint references currency_thesis(id),
  updated_at       timestamptz not null default now()
);
create index if not exists currency_thesis_currency_status_idx on currency_thesis (currency_code, status);

-- Jen jedna aktivní/watching teze na měnu zároveň — vynucuje to i na úrovni DB, ne jen v kódu.
create unique index if not exists currency_thesis_one_live_per_currency
  on currency_thesis (currency_code)
  where status in ('active','watching');

create view latest_currency_thesis as
  select distinct on (currency_code) *
  from currency_thesis
  where status in ('active','watching')
  order by currency_code, opened_at desc;

-- ── thesis_ledger: append-only historie klasifikací — skutečná dlouhodobá paměť ────────────
create table if not exists thesis_ledger (
  id             bigint generated always as identity primary key,
  thesis_id      bigint not null references currency_thesis(id),
  driver_key     text,                             -- null = klasifikace na úrovni celé teze (otevření/uzavření)
  classification text not null check (classification in ('confirms','challenges','invalidates_driver','opened','closed')),
  reasoning      text not null,
  occurred_at    timestamptz not null default now()
);
create index if not exists thesis_ledger_thesis_idx on thesis_ledger (thesis_id, occurred_at desc);

alter table currency_thesis enable row level security;
alter table thesis_ledger   enable row level security;

drop policy if exists "public read currency_thesis" on currency_thesis;
drop policy if exists "public read thesis_ledger"   on thesis_ledger;
create policy "public read currency_thesis" on currency_thesis for select using (true);
create policy "public read thesis_ledger"   on thesis_ledger   for select using (true);

grant select on currency_thesis, thesis_ledger, latest_currency_thesis to anon, authenticated;
