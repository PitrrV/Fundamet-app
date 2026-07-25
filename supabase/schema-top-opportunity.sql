-- "Top Fundamentální příležitosti týdne" — automatický výběr nejsilnější a nejslabší měny
-- podle fundamentálního biasu. Čistě INSPIRACE k dalšímu zkoumání, NE signál ke vstupu — appka
-- neřeší timing, risk management ani technickou konfluenci, to je úloha Fx Analyzeru.
--
-- Jeden řádek (stejný vzor jako market_regime) — appka nezobrazuje historii doporučení, jen
-- aktuální snímek. "Týdne" je časový rámec dat (fundamentální skóre se mění pozvolna), ne
-- doslovná týdenní cadence přepočtu — počítá se při každém běhu fetch-calendar.mjs jako
-- ostatní pilíře, prostě to nejaktuálnější je vždy zobrazené.
create table if not exists weekly_top_opportunity (
  id                   boolean primary key default true check (id),
  strongest_currency   text references currencies(code),
  strongest_score      numeric,
  strongest_conviction int,
  weakest_currency     text references currencies(code),
  weakest_score        numeric,
  weakest_conviction   int,
  rationale            text,
  insufficient_data    boolean not null default false, -- appka radši nic nenavrhne, než by navrhla ze slabých kandidátů
  computed_at          timestamptz not null default now()
);

alter table weekly_top_opportunity enable row level security;

drop policy if exists "public read weekly_top_opportunity" on weekly_top_opportunity;
create policy "public read weekly_top_opportunity" on weekly_top_opportunity for select using (true);

grant select on weekly_top_opportunity to anon, authenticated;
