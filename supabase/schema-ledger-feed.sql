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

grant select on thesis_ledger_feed to anon, authenticated;
