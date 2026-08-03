// DOČASNÝ jednorázový úklid — smazat po použití.
// Přechod na pražské datum (viz commit "fix: počítat den eventu podle pražského času") nechal
// v DB staré řádky pod původním (UTC) event_day vedle nově scrapnutých pod správným datem.
// Pro každý řádek s event_time přepočítá správný pražský den; když se neshoduje s uloženým
// event_day:
//   - existuje-li už "správný" sourozenec (stejná měna+název+správný den) → smaže tenhle starý,
//   - jinak → tenhle řádek rovnou opraví na správné datum (šetří data, co ještě nikdo znovu
//     nescrapl, typicky mimo aktuální 9týdenní scrape okno).
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function pragueDateString(date) {
  return date.toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

const PAGE_SIZE = 1000;
const rows = [];
for (let from = 0; ; from += PAGE_SIZE) {
  const { data: page, error } = await supabase
    .from("calendar_events")
    .select("id, currency_code, event_title, event_day, event_time")
    .order("id", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) {
    console.error("Chyba čtení:", error.message);
    process.exit(1);
  }
  rows.push(...page);
  if (page.length < PAGE_SIZE) break;
}
console.log(`Načteno ${rows.length} řádků celkem.`);

const existingKeys = new Set(rows.map((r) => `${r.currency_code}|${r.event_title}|${r.event_day}`));

let toDelete = [];
let toUpdate = [];

for (const r of rows) {
  if (!r.event_time) continue;
  const correctDay = pragueDateString(new Date(r.event_time));
  if (correctDay === r.event_day) continue;

  const correctKey = `${r.currency_code}|${r.event_title}|${correctDay}`;
  if (existingKeys.has(correctKey)) {
    toDelete.push(r.id);
  } else {
    toUpdate.push({ id: r.id, correctDay });
    existingKeys.add(correctKey); // ať se dva staré duplikáty stejného eventu nepřepíšou na stejný den
  }
}

console.log(`Ke smazání (má už správného sourozence): ${toDelete.length}`);
console.log(`K opravě na místě (žádný sourozenec): ${toUpdate.length}`);

for (const { id, correctDay } of toUpdate) {
  const { error } = await supabase.from("calendar_events").update({ event_day: correctDay }).eq("id", id);
  if (error) console.error(`Chyba update id=${id}:`, error.message);
}

const BATCH = 500;
let deleted = 0;
for (let i = 0; i < toDelete.length; i += BATCH) {
  const batch = toDelete.slice(i, i + BATCH);

  // market_expectations/event_reactions mají FK na calendar_events(id) bez on delete cascade —
  // stará (nesprávně datovaná) calendar_events řádka může mít vlastní snímek/reakci, kterou
  // je potřeba smazat první, jinak DELETE na calendar_events spadne na FK violation.
  const { error: meErr } = await supabase.from("market_expectations").delete().in("calendar_event_id", batch);
  if (meErr) console.error("Chyba mazání market_expectations:", meErr.message);
  const { error: erErr } = await supabase.from("event_reactions").delete().in("calendar_event_id", batch);
  if (erErr) console.error("Chyba mazání event_reactions:", erErr.message);

  const { error, count } = await supabase.from("calendar_events").delete({ count: "exact" }).in("id", batch);
  if (error) {
    console.error("Chyba mazání dávky:", error.message);
    process.exit(1);
  }
  deleted += count ?? batch.length;
}

console.log(`Hotovo. Smazáno ${deleted}, opraveno na místě ${toUpdate.length}.`);
