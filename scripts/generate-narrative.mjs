// "Vypravěč" — skládá z COT skóre + fundamentálního skóre + ekonomického kalendáře
// soudržný fundamentální příběh přes OpenAI. Tohle je jediný krok v pipeline, který
// skutečně "rozumí" datům, ne jen počítá vzorec — proto LLM, ne deterministický kód.

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { getEventHistoryTrend } from "./fundamental-scoring.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Chybí OPENAI_API_KEY v prostředí.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const UPCOMING_DAYS = 21;
const RECENT_DAYS = 90;

const SYSTEM_PROMPT = `Jsi profesionální makro trader FX fondu. Dostaneš strukturovaná fundamentální data o jedné měně: COT pozicování velkých spekulantů, kvantitativní fundamentální skóre odvozené z nedávných ekonomických dat, nadcházející naplánované ekonomické eventy s historickým trendem podobných eventů, a nedávné eventy s již známým výsledkem.

Tvým úkolem je napsat soudržný fundamentální příběh v češtině — ne jen popsat čísla, ale vysvětlit PROČ se měna chová, jak se chová, včetně situací, kdy jednotlivá data protiřečí (např. "poslední data vyšla hůř, než se čekalo, ALE COT pozicování zůstává extrémně long a historicky se po podobných zklamáních měna spíš stabilizovala"). Dej explicitní upozornění na navazující eventy — pokud se blíží důležité rozhodnutí, ale předtím vyjde jiný klíčový event, řekni to jasně a vysvětli, proč na to čekat.

Buď upřímný ohledně nejistoty: pokud jsou signály smíšené nebo je málo historických dat, řekni to — nepředstírej jistotu, kterou data nemají.

Odpověz strukturovaným JSON: "narrative" (hlavní příběh, 3-6 vět), "forward_flag" (jedna věta upozorňující na nejbližší důležitý nadcházející event a na co si dát pozor, nebo null pokud nic zajímavého nepřichází), "conviction_note" (jedna až dvě věty vysvětlující, jak moc si má trader být jistý tímhle čtením a proč).`;

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

async function loadCurrencyContext(currencyCode, allCalendarEvents) {
  const today = isoToday();
  const upcomingCutoff = new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString().slice(0, 10);
  const recentCutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);

  const { data: cotRows } = await supabase
    .from("latest_confluence_scores")
    .select("cot_score, overall_score, cot_positioning_label, conviction_label, data_tier, summary")
    .eq("currency_code", currencyCode)
    .limit(1);
  const cot = cotRows?.[0] ?? null;

  const { data: fundRows } = await supabase
    .from("latest_fundamental_scores")
    .select("fundamental_score, confidence, history_months")
    .eq("currency_code", currencyCode)
    .limit(1);
  const fundamental = fundRows?.[0] ?? null;

  const currencyEvents = allCalendarEvents.filter((e) => e.currency_code === currencyCode);

  const upcoming = currencyEvents
    .filter((e) => e.event_day >= today && e.event_day <= upcomingCutoff)
    .sort((a, b) => a.event_day.localeCompare(b.event_day))
    .map((e) => ({
      date: e.event_day,
      title: e.event_title,
      impact: e.impact,
      estimate: e.estimate,
      previous: e.previous,
      historicalTrend: getEventHistoryTrend(e.event_title, currencyCode, allCalendarEvents),
    }));

  const recent = currencyEvents
    .filter((e) => e.event_day < today && e.event_day >= recentCutoff && e.actual)
    .sort((a, b) => b.event_day.localeCompare(a.event_day))
    .map((e) => ({
      date: e.event_day,
      title: e.event_title,
      impact: e.impact,
      actual: e.actual,
      estimate: e.estimate,
      previous: e.previous,
    }));

  return { cot, fundamental, upcoming, recent };
}

async function generateForCurrency(currencyCode, context) {
  const { cot, fundamental, upcoming, recent } = context;

  if (!cot && !fundamental && upcoming.length === 0 && recent.length === 0) {
    console.log(`[${currencyCode}] žádná data — přeskočeno.`);
    return false;
  }

  const payload = { currency: currencyCode, cot, fundamental, upcomingEvents: upcoming, recentEvents: recent };

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "fx_narrative",
          strict: true,
          schema: {
            type: "object",
            properties: {
              narrative: { type: "string" },
              forward_flag: { type: ["string", "null"] },
              conviction_note: { type: "string" },
            },
            required: ["narrative", "forward_flag", "conviction_note"],
            additionalProperties: false,
          },
        },
      },
    });
  } catch (err) {
    console.error(`[${currencyCode}] OpenAI volání selhalo:`, err.message);
    return false;
  }

  let result;
  try {
    result = JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error(`[${currencyCode}] Nepodařilo se parsovat odpověď OpenAI:`, err.message);
    return false;
  }

  const { error: insErr } = await supabase.from("narratives").insert({
    currency_code: currencyCode,
    narrative: result.narrative,
    forward_flag: result.forward_flag,
    conviction_note: result.conviction_note,
    model: OPENAI_MODEL,
  });

  if (insErr) {
    console.error(`[${currencyCode}] chyba zápisu narrative:`, insErr.message);
    return false;
  }

  console.log(`[${currencyCode}] OK — narrative vygenerován (${result.narrative.length} znaků).`);
  return true;
}

async function main() {
  const { data: currencies, error } = await supabase.from("currencies").select("code").eq("is_active", true);

  if (error) {
    console.error("Nepodařilo se načíst tabulku currencies:", error.message);
    process.exit(1);
  }

  const { data: allCalendarEvents, error: calErr } = await supabase
    .from("calendar_events")
    .select("currency_code, event_title, event_day, actual, estimate, previous, impact");

  if (calErr) {
    console.error("Nepodařilo se načíst calendar_events:", calErr.message);
    process.exit(1);
  }

  let ok = 0;
  for (const { code } of currencies ?? []) {
    const context = await loadCurrencyContext(code, allCalendarEvents ?? []);
    const success = await generateForCurrency(code, context);
    if (success) ok++;
  }

  console.log(`\nHotovo: ${ok}/${currencies?.length ?? 0} měn úspěšně zpracováno.`);
}

main().catch((err) => {
  console.error("Neočekávaná chyba:", err);
  process.exit(1);
});
