// DOČASNÝ diagnostický/úklidový skript — smazat po použití (viz .github/workflows/tmp-diag.yml).
//
// Jednorázový úklid: throttle confirms v thesis-engine.mjs (commit f491683) běží jen dopředu,
// nemaže zpětně staré duplicitní "confirms" řádky nalogované PŘED opravou (kdy se každý pořád
// platný driver logoval znovu při KAŽDÉM 15min běhu). Tyhle staré duplikáty pořád zabírají
// nejnovější sloty ve feedu (thesis_ledger_feed, limit 200 globálně / 10 na měnu, řazeno
// occurred_at desc), takže "Co se změnilo?" vypadá stejně i po nasazení opravy.
//
// Pravidlo úklidu: pro každou dvojici (thesis_id, driver_key) ponechat jen NEJSTARŠÍ "confirms"
// řádek za KAŽDÝ kalendářní den (odpovídá tomu, co by throttle produkoval, kdyby běžel od
// začátku) — zbytek smazat. Nikdy se nemaže "challenges"/"invalidates_driver"/"opened"/"closed"
// (ty spamovat nikdy nemohly, viz classifyThesisUpdate).
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// PostgREST defaultně vrací max 1000 řádků na dotaz — první běh tenhle skript spustil bez
// stránkování a tiše zpracoval jen nejstarších 1000 z celkově výrazně víc řádků. Stránkuje se
// přes .range(), dokud dotaz nevrátí méně než PAGE_SIZE (= konec dat).
const PAGE_SIZE = 1000;
const rows = [];
for (let from = 0; ; from += PAGE_SIZE) {
  const { data: page, error } = await supabase
    .from("thesis_ledger")
    .select("id, thesis_id, driver_key, occurred_at")
    .eq("classification", "confirms")
    .order("occurred_at", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  if (error) {
    console.error("Chyba čtení thesis_ledger:", error.message);
    process.exit(1);
  }
  rows.push(...page);
  if (page.length < PAGE_SIZE) break;
}

console.log(`Načteno ${rows.length} řádků s classification='confirms' (celkem, stránkováno).`);

const keepFirstPerDay = new Map();
const toDelete = [];

for (const r of rows) {
  const day = r.occurred_at.slice(0, 10);
  const key = `${r.thesis_id}|${r.driver_key ?? "null"}|${day}`;
  if (keepFirstPerDay.has(key)) {
    toDelete.push(r.id);
  } else {
    keepFirstPerDay.set(key, r.id);
  }
}

console.log(`Ponechá se ${keepFirstPerDay.size} řádků (max 1/den/driver), ke smazání ${toDelete.length}.`);

const BATCH = 500;
let deleted = 0;
for (let i = 0; i < toDelete.length; i += BATCH) {
  const batch = toDelete.slice(i, i + BATCH);
  const { error: delErr, count } = await supabase.from("thesis_ledger").delete({ count: "exact" }).in("id", batch);
  if (delErr) {
    console.error("Chyba mazání dávky:", delErr.message);
    process.exit(1);
  }
  deleted += count ?? batch.length;
  console.log(`  smazáno ${deleted}/${toDelete.length}`);
}

console.log(`Hotovo. Celkem smazáno ${deleted} duplicitních 'confirms' řádků z thesis_ledger.`);
