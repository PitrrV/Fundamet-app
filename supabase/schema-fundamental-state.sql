-- Fundamentální STAV měny (state-v1) — hlavní skóre a pořadí aplikace (scripts/fundamental-state.mjs).
-- Čistě přidává dvě tabulky, nic stávajícího nemění. Zápis jen přes service_role (fetch-calendar.mjs,
-- backfill-fundamental-state-history.mjs), čtení veřejné — stejný vzor jako ostatní tabulky.

-- Aktuální stav: jeden řádek na měnu, přepisuje se při každém přepočtu.
create table if not exists fundamental_state (
  currency_code    text primary key references currencies(code),
  model_version    text not null,
  as_of_day        date not null,
  window_months    integer not null,
  index_value      numeric,            -- −1..+1, vážený průměr dostupných složek; null = nedostatek dat
  score            numeric(4,1),       -- index × 5 (−5..+5), shodné s confluence_scores.overall_score
  band_key         text not null,      -- strong | mild_positive | neutral | mild_negative | weak | insufficient
  band_label       text not null,
  available_count  integer not null,   -- kolik ze total_count složek má data
  total_count      integer not null,
  components       jsonb not null,     -- [{key,label,weight,score(+1/0/-1/null),detail}]
  activity_score   numeric(4,1),       -- jen reálná ekonomika (práce/růst/spotřeba/PMI), −5..+5 — driver tezí
  inflation        jsonb,              -- {value,target,gap,eventDay} — kontext, do indexu nevstupuje
  surprise_score   numeric,            -- skóre z překvapení vs. konsenzus (starý fundamental_score) — mimo index
  surprise_label   text,
  updated_at       timestamptz not null default now()
);

-- Týdenní historie indexu (klíč = pátek týdne). Plní ji běžný přepočet (aktuální týden se
-- přepisuje) a jednorázový backfill z calendar_events.
create table if not exists fundamental_state_history (
  currency_code    text not null references currencies(code),
  week_end         date not null,
  index_value      numeric,
  score            numeric(4,1),
  available_count  integer not null,
  component_signs  jsonb,              -- {policy:1, realYield:null, ...}
  updated_at       timestamptz not null default now(),
  primary key (currency_code, week_end)
);

alter table fundamental_state         enable row level security;
alter table fundamental_state_history enable row level security;

drop policy if exists "public read fundamental_state"         on fundamental_state;
drop policy if exists "public read fundamental_state_history" on fundamental_state_history;
create policy "public read fundamental_state"         on fundamental_state         for select using (true);
create policy "public read fundamental_state_history" on fundamental_state_history for select using (true);

-- Appka je čitelná jen po přihlášení (viz schema-require-auth.sql) — žádný přístup pro anon.
grant select on fundamental_state, fundamental_state_history to authenticated;
revoke select on fundamental_state, fundamental_state_history from anon;
