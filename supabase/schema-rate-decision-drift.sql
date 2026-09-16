-- Historie revizí tržního konsensu (ForexFactory "estimate") pro NADCHÁZEJÍCÍ sazbové
-- rozhodnutí appka už umí spočítat (viz upcomingRateDecision, scripts/cb-policy.mjs).
-- Appka dřív viděla jen AKTUÁLNÍ snímek konsensu, ne jak se k němu trh dopracoval — bez
-- historie nešlo poznat, jestli se očekávání teprve posouvá (a rozhodnutí se blíží), nebo je
-- stabilní už týdny. Ukládá se JEN při skutečné změně hodnoty (scripts/rate-decision-drift.mjs),
-- ne při každém 15min běhu — jedna řádka na jednu revizi konsensu, ne šum.
create table if not exists rate_decision_estimate_history (
  id bigint generated always as identity primary key,
  currency_code text not null,
  event_title text not null,
  event_day date not null,
  current_rate numeric not null,
  estimate_rate numeric not null,
  direction text not null,
  snapshot_at timestamptz not null default now()
);

create index if not exists idx_rate_decision_estimate_history_lookup
  on rate_decision_estimate_history (currency_code, event_day, snapshot_at desc);

alter table rate_decision_estimate_history enable row level security;
