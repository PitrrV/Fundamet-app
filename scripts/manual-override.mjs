// Ruční zápis "actual" hodnoty pro konkrétní event — pro případy, kdy nechceš čekat na
// automatický scraper (běží co ~15 min) nebo když ForexFactory hodnotu ještě nemá, ale ty
// ji už znáš odjinud. Spouští se přes .github/workflows/manual-override.yml
// (workflow_dispatch formulář v GitHub Actions), ne ručně z příkazové řádky.
//
// Po zápisu rovnou přepočítá skóre (recomputeScores z fetch-calendar.mjs) — nemusíš čekat
// na další cron, aby se to propsalo do fundamentálního skóre / CB politiky / konvicience.
// Přegenerování narrative (aby se aktualizoval i "VÝSLEDEK" text u scénáře) dělá zvlášť
// druhý krok workflow (node scripts/generate-narrative.mjs).

import { createClient } from "@supabase/supabase-js";
import { recomputeScores } from "./fetch-calendar.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const currencyCode = process.env.CURRENCY_CODE?.trim().toUpperCase();
const eventTitle = process.env.EVENT_TITLE?.trim();
const eventDay = process.env.EVENT_DAY?.trim();
const actual = process.env.ACTUAL_VALUE?.trim();

async function main() {
  if (!currencyCode || !eventTitle || !eventDay || !actual) {
    console.error("Chybí jeden z povinných vstupů: currency_code, event_title, event_day, actual.");
    process.exit(1);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDay)) {
    console.error(`event_day musí být ve formátu YYYY-MM-DD, dostal jsem: "${eventDay}"`);
    process.exit(1);
  }

  // ilike bez % = case-insensitive přesná shoda — tolerantní k velikosti písmen (mobilní
  // klávesnice ráda kapitalizuje), ale díky unique(currency_code,event_title,event_day)
  // constraintu pořád jednoznačné.
  const { data: rows, error: selErr } = await supabase
    .from("calendar_events")
    .select("id, currency_code, event_title, event_day, actual, estimate, previous")
    .eq("currency_code", currencyCode)
    .eq("event_day", eventDay)
    .ilike("event_title", eventTitle);

  if (selErr) {
    console.error("Chyba čtení calendar_events:", selErr.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    const { data: sameDay } = await supabase
      .from("calendar_events")
      .select("event_title")
      .eq("currency_code", currencyCode)
      .eq("event_day", eventDay);
    console.error(
      `Event nenalezen: [${currencyCode}] "${eventTitle}" (${eventDay}). ` +
        `Zkontroluj přesný název a datum — musí sedět přesně jako v appce/kalendáři.`
    );
    if (sameDay && sameDay.length > 0) {
      console.error(`Eventy, co pro ${currencyCode}/${eventDay} v databázi jsou:`, sameDay.map((r) => r.event_title).join(" | "));
    } else {
      console.error(`Pro ${currencyCode}/${eventDay} nemám v databázi žádný event.`);
    }
    process.exit(1);
  }

  if (rows.length > 1) {
    console.error(`Nalezeno víc než 1 shoda (${rows.length}) pro tenhle název/den — nejednoznačné, nic jsem nepřepsal.`);
    process.exit(1);
  }

  const row = rows[0];
  console.log(
    `Nalezeno: [${row.currency_code}] "${row.event_title}" (${row.event_day}) — ` +
      `dosavadní actual: ${row.actual ?? "N/A"}, estimate: ${row.estimate ?? "N/A"}, previous: ${row.previous ?? "N/A"}`
  );

  const { error: updErr } = await supabase
    .from("calendar_events")
    .update({ actual, updated_at: new Date().toISOString() })
    .eq("id", row.id);

  if (updErr) {
    console.error("Chyba zápisu actual:", updErr.message);
    process.exit(1);
  }

  console.log(`OK — actual nastaven na "${actual}". Přepočítávám skóre (fundament/CB politika/konvicience)...`);
  await recomputeScores();
  console.log("Hotovo — skóre přepočítáno. Narrative se přegeneruje v dalším kroku workflow.");
}

main().catch((err) => {
  console.error("Neočekávaná chyba:", err);
  process.exit(1);
});
