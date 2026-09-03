-- Spolehlivější spouštění fetch-calendar.yml — GitHubův vlastní `schedule:` cron (*/15 min)
-- není garantovaný: GitHub scheduled eventy za vyšší zátěže infrastruktury tiše odkládá nebo
-- přeskakuje, bez chyby, bez notifikace. Živě zachyceno opakovaně (běžně ~1h mezery místo 15
-- min, 3.9.2026 mezera 3,5h — appka kvůli tomu 3,5h neměla čerstvá CHF fundamentální data).
--
-- Řešení: appka si tenhle "budík" nastaví sama v Supabase (pg_cron — reálný Postgres cron,
-- běží jako součást databáze, nic ho neodkládá) a ten zavolá GitHubovo REST API
-- (workflow_dispatch) místo spoléhání na GitHubův vlastní schedule. GitHub API-spuštěné běhy
-- (workflow_dispatch) NEPODLÉHAJÍ stejnému odkládání jako schedule eventy — jsou to dvě různé
-- fronty na GitHubově straně.
--
-- GitHubův `schedule: */15 * * * *` ve fetch-calendar.yml zůstává beze změny jako záložní cesta
-- (concurrency group ve workflow souboru souběžné běhy sám serializuje/přeskočí, takže dva
-- spouštěče vedle sebe nevadí) — tenhle cron jen doplňuje spolehlivost, nenahrazuje nic v kódu.
--
-- POZOR — než tenhle soubor spustíte, potřebujete GitHub token (viz návod, co appka/asistent
-- poslal mimo tenhle soubor) uložený v Supabase Vaultu. Ten krok NENÍ součástí tohoto souboru
-- schválně — token nesmí nikdy skončit v gitu, ani jako placeholder. Spusťte ho ručně v SQL
-- editoru PŘED touhle migrací:
--
--   select vault.create_secret('VÁŠ_GITHUB_TOKEN_SEM', 'github_pat_fetch_calendar');
--
-- (přesný návod na vytvoření tokenu je v odpovědi/dokumentaci mimo repo, ne tady)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Funkce, ne inline SQL v cron.schedule — kvůli ochraně před chybějícím/smazaným secretem
-- (RAISE WARNING a tichý návrat, ne pád celého cron jobu) a kvůli čitelnosti při ručním testu.
create or replace function trigger_fetch_calendar_dispatch()
returns void
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  gh_token text;
begin
  select decrypted_secret into gh_token
  from vault.decrypted_secrets
  where name = 'github_pat_fetch_calendar'
  limit 1;

  if gh_token is null then
    raise warning 'trigger_fetch_calendar_dispatch: chybi secret github_pat_fetch_calendar ve Vaultu, přeskakuji.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/PitrrV/Fundamet-app/actions/workflows/fetch-calendar.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || gh_token,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'konfluence-pg-cron'
    ),
    body := jsonb_build_object('ref', 'claude/fundament-app-setup-ehe8g0')
  );
end;
$$;

-- Stejný interval jako GitHubův vlastní (nedeklarovaný) záměr — každých 15 minut. pg_cron je
-- na tenhle interval spolehlivý (je to skutečný Postgres cron, ne fronta sdílená se vším
-- ostatním provozem na GitHub Actions).
select cron.schedule(
  'fetch-calendar-dispatch',
  '*/15 * * * *',
  'select trigger_fetch_calendar_dispatch();'
);

-- Ruční test po nastavení (v SQL editoru):
--   select trigger_fetch_calendar_dispatch();
--   select * from net._http_response order by created desc limit 3;   -- mělo by se objevit status_code 204
--   select * from cron.job_run_details order by start_time desc limit 5;
-- a v GitHubu (Actions tab) by se do pár vteřin měl objevit nový běh "Fetch ForexFactory Calendar".
