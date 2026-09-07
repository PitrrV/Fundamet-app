-- Nejnovější intradenní retail čtení + Δ24H per měna, pro čistě informační UI kartu
-- (5.9.2026 post-audit F backtest: Δ24H nemá prokázanou predikční hodnotu vůči
-- následujícímu dennímu returnu, korelace ~0 po opravě datové mezery — viz App.tsx
-- retailIntradayDisplay). Stejná 12-36h tolerance jako v backtestu, aby "Δ24H" na
-- UI znamenalo přesně totéž jako v analýze.
--
-- Oprava P0-1 (nezávislý regresní audit, 6.9.2026, nález C2): view dřív porovnávala
-- long_pct napříč RŮZNÝMI zdroji dat (myfxbook-api+fxssi / fxssi-current-ratio /
-- cftc-nonreport / NULL). Živě zachyceno: AUD Δ24H ukazovalo +21,0 p.b. v neděli, kdy
-- je trh zavřený — příčina byl přepnutý poskytovatel dat mezi 05:35 a 10:26, ne reálná
-- změna pozicování (stejný zdroj: průměr |Δ|=0,3 p.b.; přechod mezi zdroji: 13,6 p.b. —
-- 45× rozdíl). Referenční bod pro Δ24H teď MUSÍ mít stejný `source` jako aktuální
-- čtení, a `cftc-nonreport`/NULL zdroje jsou z porovnávacího okna vyloučené úplně
-- (týdenní CFTC data nepatří do intradenní řady, NULL je neznámý/starý bod z 22.6.-
-- 23.7.). Když referenční bod nejde najít, delta_24h je NULL — aktuální long_pct se
-- pořád zobrazí, appka si Δ nedomýšlí.
create or replace view latest_retail_intraday as
with latest as (
  select distinct on (currency_code) currency_code, recorded_at, long_pct, source
  from retail_sentiment_intraday
  order by currency_code, recorded_at desc
)
select l.currency_code, l.recorded_at, l.long_pct,
  ref.long_pct as long_pct_24h_ago,
  ref.long_pct is not null as delta_24h_reliable, -- true jen když se našel spolehlivý (stejný zdroj) referenční bod
  case when ref.long_pct is not null then (l.long_pct - ref.long_pct) else null end as delta_24h
from latest l
left join lateral (
  select r.long_pct
  from retail_sentiment_intraday r
  where r.currency_code = l.currency_code
    and r.source = l.source -- NULL = NULL je v SQL unknown, ne true -> l.source IS NULL správně nikdy nenajde ref
    and r.source <> 'cftc-nonreport'
    and r.recorded_at <= l.recorded_at - interval '24 hours' * 0.5
    and r.recorded_at >= l.recorded_at - interval '24 hours' * 1.5
  order by abs(extract(epoch from (r.recorded_at - (l.recorded_at - interval '24 hours'))))
  limit 1
) ref on true;

grant select on latest_retail_intraday to anon, authenticated;
