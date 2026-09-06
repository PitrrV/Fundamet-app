-- Nejnovější intradenní retail čtení + Δ24H per měna, pro čistě informační UI kartu
-- (5.9.2026 post-audit F backtest: Δ24H nemá prokázanou predikční hodnotu vůči
-- následujícímu dennímu returnu, korelace ~0 po opravě datové mezery — viz App.tsx
-- retailIntradayDisplay). Stejná 12-36h tolerance jako v backtestu, aby "Δ24H" na
-- UI znamenalo přesně totéž jako v analýze.
create or replace view latest_retail_intraday as
with latest as (
  select distinct on (currency_code) currency_code, recorded_at, long_pct
  from retail_sentiment_intraday
  order by currency_code, recorded_at desc
)
select l.currency_code, l.recorded_at, l.long_pct,
  ref.long_pct as long_pct_24h_ago,
  (l.long_pct - ref.long_pct) as delta_24h
from latest l
left join lateral (
  select r.long_pct
  from retail_sentiment_intraday r
  where r.currency_code = l.currency_code
    and r.recorded_at <= l.recorded_at - interval '24 hours' * 0.5
    and r.recorded_at >= l.recorded_at - interval '24 hours' * 1.5
  order by abs(extract(epoch from (r.recorded_at - (l.recorded_at - interval '24 hours'))))
  limit 1
) ref on true;

grant select on latest_retail_intraday to anon, authenticated;
