// DOČASNÝ diagnostický skript — smazat po použití.
// 1) Ověří, že NZD eventy mají teď opravené datum. 2) Zkontroluje, jestli změna date-bucketingu
// nevytvořila duplicity (stejná měna+název, datum jen o 1 den jinam — starý UTC řádek vedle
// nového pražského).
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: nzd } = await supabase
  .from("calendar_events")
  .select("event_title, event_day, event_time, actual, estimate")
  .eq("currency_code", "NZD")
  .in("event_title", ["Employment Change q/q", "Unemployment Rate"])
  .order("event_day", { ascending: true });
console.log("NZD Employment/Unemployment radky:", JSON.stringify(nzd, null, 2));

// Duplicity: stejná měna+název s dvěma různými event_day v rozmezí posledních ~30 dní.
const { data: all } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day")
  .gte("event_day", "2026-07-01");

const groups = new Map();
for (const ev of all ?? []) {
  const key = `${ev.currency_code}|${ev.event_title}`;
  if (!groups.has(key)) groups.set(key, new Set());
  groups.get(key).add(ev.event_day);
}
let dupCount = 0;
for (const [key, days] of groups) {
  if (days.size > 1) {
    const sorted = [...days].sort();
    // Zajímají nás jen sousední dny (potenciální timezone duplicity), ne legitimně opakující
    // se eventy (týdenní/měsíční data se stejným názvem přirozeně mají víc různých dnů).
    for (let i = 1; i < sorted.length; i++) {
      const d1 = new Date(sorted[i - 1]);
      const d2 = new Date(sorted[i]);
      if ((d2 - d1) / 86400000 === 1) {
        console.log(`MOŽNÁ DUPLICITA: ${key} — ${sorted[i - 1]} a ${sorted[i]}`);
        dupCount++;
      }
    }
  }
}
console.log(`Nalezeno ${dupCount} podezřelých sousedních-dnů párů.`);
