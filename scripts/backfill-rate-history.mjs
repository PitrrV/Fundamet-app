// Jednorázový zpětný scrape — řeší studený start CB Policy pilíře (scripts/cb-policy.mjs).
//
// PROBLÉM: autoDetectPolicy() potřebuje rateHistory.length >= 2, aby uměla určit trend
// (hike/cut/hold). Historii bere z calendar_events, ale běžný fetch-calendar.mjs stahuje jen
// úzké okno WEEK_OFFSETS_DAYS (−42 až +14 dní) — záměrně, aby běh každých 15 minut zůstal
// rychlý. Centrální banky rozhodují po 6–8 týdnech (SNB jen čtvrtletně), takže do 2 měsíců se
// u většiny měn vejde nanejvýš 1 rozhodnutí → cb_policy_adj zůstává 0 u všech měn (ověřeno
// živě, viz audit).
//
// ŘEŠENÍ — a proč zrovna tohle, ne bootstrap z jiného zdroje:
// Analyzer (PitrrV/Fx-Analyzer) má pro tohle jen ručně psané skóre (CB_POLICY_DATA), ne
// historii rozhodnutí — kopírovat by znamenalo dovézt cizí subjektivní úsudek a tvářit se, že
// ho appka spočítala. Nové API (např. FRED) by znamenalo druhý, nezávislý zdroj pravdy pro
// sazby vedle ForexFactory, s rizikem, že se časem rozejdou.
//
// Místo toho appka udělá to, co už umí — stáhne starší týdny ZE STEJNÉHO zdroje, kterým se
// živí i běžný provoz, a uloží je do STEJNÉ tabulky STEJNOU cestou (fetchWeek/mergeUpsert z
// fetch-calendar.mjs, beze změny). autoDetectPolicy() se nemění vůbec — jen jednou uvidí víc
// dat. Skóre je pořád 100% deterministické, žádný LLM ani ruční hodnota do něj nevstupuje.
//
// Spustit JEDNORÁZOVĚ (workflow_dispatch), nikdy jako cron — proto samostatný skript, ne
// rozšíření WEEK_OFFSETS_DAYS v běžném běhu (to by každý ze 96 běhů denně zbytečně prodloužilo
// a zvýšilo riziko blokace ForexFactory).

import { fetchWeek, dedupePreferComplete, mergeUpsert, recomputeScores } from "./fetch-calendar.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Od −49 dní (týden hned za běžným oknem, ať nevznikne mezera) do −294 dní (42 týdnů ≈ 9,7
// měsíce zpět). SNB rozhoduje čtvrtletně (~91 dní) — 294 dní zaručuje aspoň 2 její rozhodnutí
// s rezervou, ostatní centrální banky (6–8týdenní cyklus) mají v tomhle okně 4-7 rozhodnutí.
const BACKFILL_START_DAYS = -49;
const BACKFILL_END_DAYS = -294;
const STEP_DAYS = 7;
// Mezi požadavky o něco delší pauza než u běžného 15minutového běhu — tohle je jednorázový
// dávkový scrape ~35 týdnů najednou, ne rutinní provoz, tak zbytečně nezatěžovat ForexFactory.
const SLEEP_MS = 2000;

function buildOffsets() {
  const offsets = [];
  for (let d = BACKFILL_START_DAYS; d >= BACKFILL_END_DAYS; d -= STEP_DAYS) offsets.push(d);
  return offsets;
}

async function main() {
  const offsets = buildOffsets();
  console.log(`Zpětný scrape ${offsets.length} týdnů (${BACKFILL_START_DAYS} až ${BACKFILL_END_DAYS} dní)...`);

  const allEvents = [];
  let failed = 0;
  for (const offset of offsets) {
    try {
      const weekEvents = await fetchWeek(offset);
      console.log(`  offset ${offset}: ${weekEvents.length} eventů`);
      allEvents.push(...weekEvents);
    } catch (err) {
      // Jednotlivý týden smí selhat (viz poznámka o rotující IP v fetch-calendar.mjs) —
      // pokračovat dál, ne přerušit celý backfill kvůli jednomu HTTP 403.
      failed++;
      console.error(`  offset ${offset} selhal:`, err.message);
    }
    await sleep(SLEEP_MS);
  }

  const deduped = dedupePreferComplete(allEvents);
  console.log(`Celkem po deduplikaci: ${deduped.length} eventů (${failed}/${offsets.length} týdnů selhalo).`);

  if (deduped.length === 0) {
    console.error("Žádné eventy nestaženy — backfill nic nezapsal.");
    process.exit(1);
  }

  const { count } = await mergeUpsert(deduped);
  console.log(`Upsertnuto ${count}/${deduped.length} eventů do calendar_events.`);

  console.log("Přepočítávám skóre (CB Policy teď uvidí rozšířenou historii)...");
  await recomputeScores();

  console.log("\nHotovo. Zkontroluj cb_policy_state — policy_label by u většiny měn už neměl být 'nedostatek dat'.");
}

main().catch((err) => {
  console.error("Neočekávaná chyba:", err);
  process.exit(1);
});
