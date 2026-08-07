-- Konzistence textu se skóre — appka živě zachytila (2026-08-07), že jedno volání OpenAI trvá
-- desítky vteřin, zatímco fetch-calendar.mjs běží nezávisle na tomtéž skóre každých 15 minut.
-- Pokud se skóre změní PŘESNĚ v tom okně mezi načtením kontextu pro prompt a uložením narrativu,
-- appka dřív mlčky uložila text platný "před chvílí", i když gauge v UI už ukazoval jinou
-- hodnotu. generate-narrative.mjs teď po vygenerování porovná skóre POUŽITÉ v promptu s tím, co
-- je PRÁVĚ TEĎ v DB (readLiveScoreSnapshot/scoresDiffer), a při neshodě jednou přegeneruje s
-- čerstvým kontextem — ale aby šlo POZDĚJI (i po uložení, i po dnech) ověřit, jaké skóre bylo v
-- uloženém textu skutečně použité, potřebuje appka ten snímek trvale uložit, ne ho nechat zaniknout
-- v paměti procesu. scripts/check-narrative-freshness.mjs pak tenhle sloupec porovnává se živým
-- skóre jako automatický test (bez volání OpenAI, jen čtení).
alter table narratives add column if not exists score_snapshot jsonb;

-- POZOR, nutné: latest_narratives je view přes `select *`, které si zamyká sloupce v okamžiku
-- vytvoření. Bez znovuvytvoření by frontend i kontrolní skript nový sloupec vůbec neviděly —
-- stejná past už dřív chytila audio_url, input_fingerprint i thesis_change_note (viz historie
-- migrací v tomhle adresáři).
create or replace view latest_narratives as
  select distinct on (currency_code) *
  from narratives
  order by currency_code, generated_at desc;

grant select on latest_narratives to anon, authenticated;
