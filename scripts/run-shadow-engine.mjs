// Phase 4 — vstupní bod Shadow Fundamental Engine. Zcela oddělený proces od fetch-calendar.mjs
// (vlastní GH Actions workflow, vlastní Supabase čtení) — nikdy nevolá recomputeScores() a nikdy
// nezapisuje do žádné produkční tabulky. Čte calendar_events READ-ONLY a jen ČTE (nepřepočítává
// jinak) computeCbPolicyState/computeFundamentalScore pro referenční hodnoty (policy context /
// data_momentum) — cb-policy.mjs a fundamental-scoring.mjs se nijak nemění ani nevolá jejich
// zápis do DB.

import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore } from "./fundamental-scoring.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";
import { runShadowEngine } from "./shadow-fundamental-engine.mjs";
import { trackExpectationsDrift } from "./shadow-expectations.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SCORED_CURRENCIES = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];

// Vlastní kopie stránkování (stejný princip jako fetchAllCalendarEvents ve fetch-calendar.mjs,
// ale záměrně samostatná implementace) — ať tenhle skript NIKDY neimportuje/nesahá na
// fetch-calendar.mjs, nejcitlivější soubor vůči produkční regresi.
async function fetchAllCalendarEvents() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, currency_code, event_title, event_day, event_time, impact, actual, estimate, previous")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return { data: rows, error: null };
}

function pragueDateString(date) {
  return date.toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

async function main() {
  const { data: allEvents, error } = await fetchAllCalendarEvents();
  if (error) {
    console.error("shadow-engine: nepodařilo se načíst calendar_events:", error.message);
    process.exit(1);
  }

  const cbPolicyByCode = {};
  const dataMomentumByCode = {};
  for (const code of SCORED_CURRENCIES) {
    cbPolicyByCode[code] = computeCbPolicyState(code, SCORED_CURRENCIES, allEvents ?? []);
    dataMomentumByCode[code] = computeFundamentalScore(code, allEvents ?? []);
  }

  console.log(`shadow-engine: spouštím pro ${SCORED_CURRENCIES.length} měn, model_version=shadow-v1...`);
  const results = await runShadowEngine({
    supabase,
    allEvents: allEvents ?? [],
    currencyCodes: SCORED_CURRENCIES,
    cbPolicyByCode,
    dataMomentumByCode,
  });

  for (const code of SCORED_CURRENCIES) {
    const r = results[code];
    console.log(
      `[${code}] quality=${r.data_quality} absolute=${r.absolute_fundamental ?? "N/A"} relative=${r.relative_fundamental ?? "N/A"} ` +
        `rank=${r.relative_rank ?? "N/A"} blocks_missing=[${r.blocks_missing.join(",")}]`
    );
  }

  const today = pragueDateString(new Date());
  for (const code of SCORED_CURRENCIES) {
    try {
      const drift = await trackExpectationsDrift(supabase, code, allEvents ?? [], today);
      if (drift.length > 0) {
        console.log(`[${code}] expectations drift: ${drift.map((d) => `${d.category}=${d.estimateValue}`).join(", ")}`);
      }
    } catch (err) {
      console.error(`shadow-expectations [${code}] selhalo (nekriticky):`, err.message);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("shadow-engine: neočekávaná chyba:", err);
    process.exit(1);
  });
}
