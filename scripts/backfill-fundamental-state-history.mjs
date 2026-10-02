// Jednorázový backfill týdenní historie fundamentálního stavu (fundamental_state_history).
//
// Pro každý uplynulý pátek přepočítá stav měny POINT-IN-TIME jen z událostí do tohoto data
// (okno 12 měsíců, stejný modul jako živý výpočet). Zapisuje VÝHRADNĚ do fundamental_state_history
// (idempotentní upsert) — žádná jiná tabulka, žádné skóre/narrativ se nemění.
//
// Poznámky k poctivosti dat: calendar_events obsahuje poslední známé hodnoty (actual se po vydání
// může revidovat) a začíná říjnem 2025, takže nejstarší týdny vidí kratší než 12měsíční okno a mají
// méně dostupných složek (sloupec available_count). Týdny s méně než 3 složkami mají index null.
import { fetchAllCalendarEvents } from "./fetch-calendar.mjs";
import { computeFundamentalState, componentSigns, weekEndFriday } from "./fundamental-state.mjs";
import { createClient } from "@supabase/supabase-js";

const CODES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];
const DAY = 86400000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const iso = (t) => new Date(t).toISOString().slice(0, 10);

async function main() {
  const { data: events, error } = await fetchAllCalendarEvents();
  if (error) throw new Error(`čtení calendar_events selhalo: ${error.message}`);
  const first = events.reduce((m, e) => (e.event_day < m ? e.event_day : m), "9999-12-31");
  const today = iso(Date.now());
  const currentWeekEnd = weekEndFriday(today);

  // první pátek, ke kterému už existuje aspoň pár týdnů dat
  let t = new Date(`${weekEndFriday(first)}T00:00:00Z`).getTime() + 28 * DAY;
  const rows = [];
  for (; iso(t) < currentWeekEnd; t += 7 * DAY) {
    const friday = iso(t);
    for (const code of CODES) {
      const st = computeFundamentalState(code, CODES, events, { asOfDay: friday });
      rows.push({
        currency_code: code,
        week_end: friday,
        index_value: st.index,
        score: st.score,
        available_count: st.availableCount,
        component_signs: componentSigns(st),
        updated_at: new Date().toISOString(),
      });
    }
  }
  console.log(`Počítám ${rows.length} řádků (${rows[0]?.week_end} → ${rows[rows.length - 1]?.week_end}).`);

  for (let i = 0; i < rows.length; i += 200) {
    const { error: upErr } = await supabase
      .from("fundamental_state_history")
      .upsert(rows.slice(i, i + 200), { onConflict: "currency_code,week_end" });
    if (upErr) throw new Error(`upsert selhal: ${upErr.message}`);
  }
  const withIndex = rows.filter((r) => r.index_value !== null).length;
  console.log(`Zapsáno ${rows.length} řádků (${withIndex} s indexem, ${rows.length - withIndex} s nedostatkem dat).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
