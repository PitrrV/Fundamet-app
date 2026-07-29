-- Nezávislý indikátor "možná se mění fundamentální režim" — porovnává dlouhodobé (celá
-- historie, po opravě saturace Variantou H) a krátkodobé (posledních 90 dní) fundamentální
-- skóre STEJNOU funkcí (computeRegimeShift v fundamental-scoring.mjs), NEBLENDUJE se do
-- overall_score. Spusťte jednorázově v Supabase SQL editoru.

create table if not exists regime_shift_state (
  currency_code    text primary key references currencies(code),
  long_term_score  numeric(4,2),
  short_term_score numeric(4,2),
  divergence       numeric(4,2),
  alert            boolean not null default false,
  updated_at       timestamptz not null default now()
);

alter table regime_shift_state enable row level security;

drop policy if exists "public read regime_shift_state" on regime_shift_state;
create policy "public read regime_shift_state" on regime_shift_state for select using (true);

grant select on regime_shift_state to anon, authenticated;
