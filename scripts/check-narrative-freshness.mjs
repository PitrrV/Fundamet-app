// Automatický test konzistence: pro každou měnu s narrativem porovná score_snapshot uložený u
// posledního textu (přesná čísla, ze kterých ho generate-narrative.mjs skládalo) s tím, co appka
// PRÁVĚ TEĎ skutečně ukazuje v latest_confluence_scores/latest_fundamental_scores (gauge, tabs).
// Žádné volání OpenAI, jen čtení — bezpečné spouštět kdykoli, i jako pravidelný health-check.
//
// PROČ TOHLE NENAHRAZUJE runtime pojistku v generate-narrative.mjs (scoresDiffer/
// readLiveScoreSnapshot, viz tam): ta chrání PŘED zápisem zastaralého textu, v okamžiku
// generování. Tenhle skript hlídá stav PO zápisu, kdykoli později — zachytí i situaci, kdy se
// skóre posunulo AŽ PO uložení narrativu (mezi během generate-narrative.yml a příštím
// fetch-calendar.yml), což runtime pojistka structurálně nemůže vidět, protože v tu chvíli
// narrativ ještě neexistoval. Obě vrstvy dohromady dávají appce garanci, ne jen sníženou
// pravděpodobnost.
//
// Exit kód: 0 = všechno sedí (nebo starší řádky bez snímku, informativně), 1 = aspoň jedna
// neshoda — vhodné jako krok v CI/Actions, který má selhat viditelně, ne jen tiše zalogovat.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Stejný práh jako FRESHNESS_EPSILON v generate-narrative.mjs a round05 u fingerprintu —
// "materiálně jiná" hodnota, ne šum ze zaokrouhlení.
const EPSILON = 0.05;

function differs(a, b) {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) > EPSILON;
}

async function main() {
  const { data: narratives, error: e1 } = await supabase
    .from("latest_narratives")
    .select("currency_code, score_snapshot, generated_at")
    .order("currency_code", { ascending: true });
  if (e1) {
    console.error("Nepodařilo se načíst latest_narratives:", e1.message);
    process.exit(1);
  }

  const { data: conf, error: e2 } = await supabase
    .from("latest_confluence_scores")
    .select("currency_code, overall_score, cot_score, retail_score");
  if (e2) {
    console.error("Nepodařilo se načíst latest_confluence_scores:", e2.message);
    process.exit(1);
  }

  const { data: fund, error: e3 } = await supabase
    .from("latest_fundamental_scores")
    .select("currency_code, fundamental_score");
  if (e3) {
    console.error("Nepodařilo se načíst latest_fundamental_scores:", e3.message);
    process.exit(1);
  }

  const confByCode = Object.fromEntries((conf ?? []).map((r) => [r.currency_code, r]));
  const fundByCode = Object.fromEntries((fund ?? []).map((r) => [r.currency_code, r]));

  let checked = 0;
  let noSnapshot = 0;
  let failures = 0;

  for (const row of narratives ?? []) {
    const code = row.currency_code;
    const snap = row.score_snapshot;

    if (!snap) {
      // Řádky vygenerované PŘED touhle migrací snapshot nemají — informativní stav, ne selhání.
      // Zmizí samo, jakmile se daná měna příště přegeneruje.
      noSnapshot++;
      console.log(`[${code}] žádný score_snapshot (starší narrativ z doby před opravou) — přeskočeno.`);
      continue;
    }

    const live = {
      overall_score: confByCode[code]?.overall_score ?? null,
      cot_score: confByCode[code]?.cot_score ?? null,
      retail_score: confByCode[code]?.retail_score ?? null,
      fundamental_score: fundByCode[code]?.fundamental_score ?? null,
    };

    checked++;
    const mismatches = [];
    if (differs(snap.overall_score, live.overall_score)) {
      mismatches.push(`overall_score: text=${snap.overall_score} živé=${live.overall_score}`);
    }
    if (differs(snap.fundamental_score, live.fundamental_score)) {
      mismatches.push(`fundamental_score: text=${snap.fundamental_score} živé=${live.fundamental_score}`);
    }
    if (differs(snap.cot_score, live.cot_score)) {
      mismatches.push(`cot_score: text=${snap.cot_score} živé=${live.cot_score}`);
    }
    if (differs(snap.retail_score, live.retail_score)) {
      mismatches.push(`retail_score: text=${snap.retail_score} živé=${live.retail_score}`);
    }

    if (mismatches.length > 0) {
      failures++;
      console.error(`[${code}] NESHODA (text vygenerován ${row.generated_at}): ${mismatches.join("; ")}`);
    } else {
      console.log(`[${code}] OK — text odpovídá aktuálnímu skóre.`);
    }
  }

  console.log(`\nZkontrolováno ${checked} měn se snímkem (${noSnapshot} bez snímku), ${failures} neshod.`);

  if (failures > 0) {
    console.error("SELHALO: text alespoň jedné měny cituje jinou hodnotu skóre, než appka právě zobrazuje.");
    process.exit(1);
  }
  console.log("OK: všechny texty se snímkem skóre odpovídají aktuálnímu stavu.");
}

main();
