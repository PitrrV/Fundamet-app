-- "Co se změnilo?" — znovupoužívá stávající thesis_ledger (Gen2 Thesis Engine), jen přidává
-- view s currency_code (thesis_ledger sám o sobě má jen thesis_id), aby frontend mohl filtrovat
-- podle měny bez joinu. Žádná nová logika, žádná nová tabulka pro sledování změn — appka si
-- tohle "kdy a proč se teze změnila" pamatuje od Fáze 1 Thesis Enginu, jen to dosud nebylo nikde
-- zobrazené.
create or replace view thesis_ledger_feed as
  select
    tl.id,
    ct.currency_code,
    tl.driver_key,
    tl.classification,
    tl.reasoning,
    tl.occurred_at
  from thesis_ledger tl
  join currency_thesis ct on ct.id = tl.thesis_id
  order by tl.occurred_at desc;

-- POZOR: JEN authenticated, ne anon — appka od schema-require-auth.sql vyžaduje přihlášení
-- pro kohokoli. Živě zachyceno 17.8.2026 (kompletní audit appky): tenhle řádek měl původně
-- "anon, authenticated" a stejnou chybu (grant na anon po zavedení require-auth) opakoval i
-- schema-narrative-freshness.sql u latest_narratives — tam to reálně unikalo do produkce, tady
-- naštěstí ne (viz git historie), ale kdyby se tenhle soubor někdy znovu spustil kvůli nové
-- migraci, otevřel by to samé.
grant select on thesis_ledger_feed to authenticated;
