-- Historie skóre + vysvětlení změny.
--
-- PROČ NOVÁ TABULKA: confluence_scores má `unique (currency_code, report_date)` a
-- fetch-calendar.mjs ho každých 15 minut přepisuje přes .update() (řádek ~410). report_date se
-- mění jen týdně s COT reportem, takže na měnu existuje jeden řádek na týden a předchozí hodnota
-- overall_score nenávratně mizí. Historii tedy není kam ukládat — musí vzniknout samostatně.
--
-- PROČ SE UKLÁDÁ I ROZPAD NA PILÍŘE: bez něj by šlo říct jen "skóre kleslo o 0.6", ne KTERÁ
-- komponenta to způsobila. fundamental_score_adj a risk_adj se dnes počítají jen v paměti
-- (fetch-calendar.mjs řádky 392-393) a nikam se neukládají, takže atribuci nelze zpětně dopočítat
-- z ničeho, co v DB je. Tohle je ten chybějící kus.
create table if not exists score_snapshots (
  id                    bigint generated always as identity primary key,
  currency_code         text not null references currencies(code),
  overall_score         numeric(4,2) not null,
  fundamental_score_adj numeric(4,2),   -- fundament + real yield + CB policy, po clampu
  cot_score             numeric(4,2),
  retail_score          numeric(4,2),
  risk_adj              numeric(4,2),
  conviction_stars      int,
  recorded_at           timestamptz not null default now()
);
create index if not exists score_snapshots_currency_idx on score_snapshots (currency_code, recorded_at desc);

-- Poslední změna na měnu: aktuální hodnota, předchozí hodnota a rozdíl — spočítané v SQL přes
-- lag(), aby frontend nemusel tahat dva řádky a odečítat je sám.
create or replace view latest_score_change as
  select distinct on (currency_code)
    currency_code,
    overall_score,
    previous_score,
    round(overall_score - previous_score, 2) as delta,
    recorded_at,
    previous_recorded_at
  from (
    select
      currency_code,
      overall_score,
      recorded_at,
      lag(overall_score) over (partition by currency_code order by recorded_at) as previous_score,
      lag(recorded_at)   over (partition by currency_code order by recorded_at) as previous_recorded_at
    from score_snapshots
  ) s
  order by currency_code, recorded_at desc;

-- Vysvětlení změny od LLM. Patří do narratives (tabulka LLM výstupů), ne do currency_thesis —
-- thesis_summary je deterministický template z thesis-engine.mjs (buildThesisSummary, řádek 138)
-- a míchat do jednoho sloupce generovaný a šablonový text by znemožnilo rozlišit, co je čí.
alter table narratives add column if not exists thesis_change_note text;

-- POZOR, nutné: latest_narratives je view přes `select *`, které si zamyká sloupce v okamžiku
-- vytvoření. Bez znovuvytvoření by frontend nový sloupec vůbec neviděl. (Stejná past už
-- v projektu chytila audio_url i input_fingerprint.)
create or replace view latest_narratives as
  select distinct on (currency_code) *
  from narratives
  order by currency_code, generated_at desc;

alter table score_snapshots enable row level security;
drop policy if exists "public read score_snapshots" on score_snapshots;
create policy "public read score_snapshots" on score_snapshots for select using (true);
grant select on score_snapshots, latest_score_change to anon, authenticated;
