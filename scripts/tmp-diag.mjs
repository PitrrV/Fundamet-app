// DOČASNÝ diagnostický skript — smazat po použití.
// Ověřuje nahlášenou chybu: appka u NZD Employment Change/Unemployment Rate ukazuje datum 4.8.,
// uživatel tvrdí, že podle ForexFactory je to až 5.8. Podezření: NZ je UTC+12/+13, scraper
// počítá event_day čistě z UTC dne timestampu (ev.dateline), což se může lišit od dne, který FF
// web ukazuje v prohlížečové časové zóně uživatele.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: events, error } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day, event_time, actual, estimate, previous")
  .eq("currency_code", "NZD")
  .gte("event_day", "2026-08-01")
  .lte("event_day", "2026-08-10")
  .order("event_day", { ascending: true });

if (error) {
  console.error("chyba:", error.message);
  process.exit(1);
}

for (const ev of events) {
  const t = ev.event_time ? new Date(ev.event_time) : null;
  console.log(`${ev.event_title} | uložený event_day=${ev.event_day} | event_time (UTC iso)=${ev.event_time}`);
  if (t) {
    console.log(`  → UTC den: ${t.toISOString().slice(0, 10)} ${t.toISOString().slice(11, 16)}`);
    console.log(`  → NZ (Pacific/Auckland) den: ${t.toLocaleString("sv-SE", { timeZone: "Pacific/Auckland" })}`);
    console.log(`  → US East (America/New_York) den: ${t.toLocaleString("sv-SE", { timeZone: "America/New_York" })}`);
    console.log(`  → Praha (Europe/Prague) den: ${t.toLocaleString("sv-SE", { timeZone: "Europe/Prague" })}`);
  }
}
