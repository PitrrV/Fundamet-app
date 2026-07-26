-- Detekce změny vstupů: generátor si ke každému narrativu uloží otisk dat, ze kterých vznikl.
-- Při dalším běhu porovná a měnu beze změny vůbec negeneruje (viz generate-narrative.mjs).
--
-- Proč jsonb a ne jeden text hash: otisk je rozpadlý po sekcích (skóre, teze, CB politika,
-- risk režim, koš měn, kalendář), takže z porovnání rovnou vypadne DŮVOD regenerace do logu.
-- Jeden slepený hash by řekl jen "něco se změnilo".
alter table narratives add column if not exists input_fingerprint jsonb;

-- POZOR — tohle je nutné, ne kosmetika. latest_narratives je view přes `select *`, který si
-- zamyká seznam sloupců v okamžiku vytvoření. Bez znovuvytvoření by view nový sloupec vůbec
-- neukázalo, generátor by četl samé null, vyhodnotil "otisk chybí" a regeneroval by pořád
-- všechno — celá optimalizace by tiše nefungovala. (Stejná past už v projektu chytila
-- audio_url i dřív; proto to sem píšu rovnou.)
create or replace view latest_narratives as
  select distinct on (currency_code) *
  from narratives
  order by currency_code, generated_at desc;
