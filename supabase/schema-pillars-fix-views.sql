-- Oprava: `latest_confluence_scores` a `latest_narratives` jsou VIEW definované přes
-- `select *` — Postgres ale zamkne seznam sloupců v okamžiku VYTVOŘENÍ view, takže
-- `alter table ... add column` (viz schema-pillars.sql) do nich nové sloupce nepropsal.
-- Proto zůstávala appka na chybě "column ... does not exist" i po spuštění schema-pillars.sql.
-- Tenhle soubor je bezpečné spustit i opakovaně (CREATE OR REPLACE VIEW).

create or replace view latest_confluence_scores as
  select distinct on (currency_code) *
  from confluence_scores
  order by currency_code, report_date desc;

create or replace view latest_narratives as
  select distinct on (currency_code) *
  from narratives
  order by currency_code, generated_at desc;
