// "Vypravěč" — skládá ze VŠECH pilířů (COT + retail pozicování + fundament/kalendář +
// CB politika/real yield/zaceněnost + risk režim + basket kontext) soudržný fundamentální
// příběh přes OpenAI, včetně explicitní scénářové predikce ("když X, tak Y") pro nejbližší
// důležité eventy. Tohle je jediný krok v pipeline, který skutečně "rozumí" datům, ne jen
// počítá vzorec — proto LLM, ne deterministický kód.

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { getEventHistoryTrend, getWeight } from "./fundamental-scoring.mjs";

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
const MAX_SCENARIOS = 3;
const SCENARIO_LOOKBACK_DAYS = 5; // jak dlouho po zveřejnění actual event ještě zůstává ve scénářích (s komentářem k výsledku)

const SYSTEM_PROMPT = `Jsi profesionální makro trader FX fondu. Dostaneš strukturovaná fundamentální data o jedné měně:
- COT pozicování velkých spekulantů (cot) a retail pozicování malých spekulantů (retailSentiment) — pozicování je RIZIKOVÝ FILTR, ne směrový signál: přeplněný obchod je křehký, i správná teze se dá vyždímat.
- Kvantitativní fundamentální skóre z nedávných ekonomických dat (fundamental).
- Politiku centrální banky — trajektorie (hiking/cutting/hold cyklus), real yield vůči ostatním měnám koše, a "zaceněnost" (pricedIn) — jak moc trh poslední rozhodnutí čekal (cbPolicy).
- Risk-on/risk-off tržní režim (riskRegime) — v risk-off táhnou JPY/CHF bez ohledu na vlastní data, v risk-on táhnou AUD/NZD/CAD.
- Kontext zbytku koše měn (basketContext) — FX je vždy relativní, píš o měně i VE VZTAHU k ostatním, ne v izolaci.
- Konvicience jako shoda nezávislých signálů (convictionStars/convictionReasons) — kolik nezávislých pohledů souhlasí, ne jak velké je jedno číslo.
- Nadcházející naplánované eventy s historickým trendem podobných eventů (upcomingEvents) a nedávné eventy s již známým výsledkem (recentEvents).
- Předvybrané klíčové nadcházející eventy (scenarioSeeds) — pro tyhle napiš explicitní podmíněnou predikci.

Tvým úkolem je napsat soudržný fundamentální příběh v češtině — ne jen popsat čísla, ale vysvětlit PROČ se měna chová, jak se chová, včetně situací, kdy jednotlivá data protiřečí (např. "poslední data vyšla hůř, než se čekalo, ALE COT pozicování zůstává extrémně long a historicky se po podobných zklamáních měna spíš stabilizovala"). Dej explicitní upozornění na navazující eventy — pokud se blíží důležité rozhodnutí, ale předtím vyjde jiný klíčový event, řekni to jasně a vysvětli, proč na to čekat.

Buď upřímný ohledně nejistoty: pokud jsou signály smíšené, je málo historických dat, nebo "zaceněnost" vychází jen z konsensu posledního rozhodnutí (ne z reálných tržních dat), řekni to — nepředstírej jistotu, kterou data nemají.

Pro každý event v "scenarioSeeds" (max 3) napiš do "scenarios" VŽDY "if_beat" a "if_miss" — DVĚ krátké věty, co se stane s měnou, POKUD data překonají odhad, a co POKUD zaostanou — zdůvodni to historickým trendem podobných eventů (historicalTrend v tom seedu) a aktuálním kontextem (pozicování, CB politika, risk režim), ne obecnou frází. Tohle je referenční scénář a ZŮSTÁVÁ i poté, co je výsledek známý — nikdy ho nemaž ani nepřepisuj.

Navíc: pokud má seed vyplněné pole "actual" (výsledek už je zveřejněný), napiš i "outcome" — profesionální zhodnocení SKUTEČNÉHO výsledku, ne jen zopakování čísel. Řekni, jestli to bylo beat/miss/v souladu s konsensem, JAK moc to bylo signifikantní (viz surpriseStrength kontext v datech), a co to podle tebe znamená DÁL — navazuje snad tenhle výsledek na to, co příběh (narrative) říká o pozicování/CB politice/risk režimu, potvrzuje ho, nebo mu odporuje? Piš to stejně jako zbytek příběhu — jako trader, co právě dostal číslo na obrazovku a rozhoduje se, co s tím. Pokud "actual" chybí (event ještě neproběhl), nastav "outcome" na null.

Odpověz strukturovaným JSON: "narrative" (hlavní příběh, 3-6 vět), "forward_flag" (jedna věta upozorňující na nejbližší důležitý nadcházející event a na co si dát pozor, nebo null pokud nic zajímavého nepřichází), "conviction_note" (jedna až dvě věty vysvětlující, jak moc si má trader být jistý tímhle čtením a proč — zmiň convictionStars, pokud je nízká), "scenarios" (pole max 3 položek {event, date, if_beat, if_miss, outcome}, prázdné pole pokud scenarioSeeds nic neobsahuje).`;

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

async function loadBasketContext() {
  const { data } = await supabase
    .from("latest_confluence_scores")
    .select("currency_code, overall_score, conviction_label");
  const map = {};
  for (const row of data ?? []) {
    map[row.currency_code] = { overallScore: row.overall_score, convictionLabel: row.conviction_label };
  }
  return map;
}

async function loadMarketRegime() {
  const { data } = await supabase.from("market_regime").select("vix, vix_5d_change, regime").limit(1);
  return data?.[0] ?? null;
}

// Vybere top-N eventů podle váhy z kombinovaného okna (nedávno vyšlé + nadcházející) —
// přesně ty, na které by se profesionální trader díval jako na klíčové "co sledovat dál"
// (buildForecastV5 styl). Eventy, co ve svém okně `actual` UŽ mají, zůstávají ve scénářích
// pár dní (SCENARIO_LOOKBACK_DAYS) po zveřejnění, aby appka mohla okomentovat i skutečný
// výsledek, ne jen hypotézu — viz `outcome` v system promptu. `candidates` je filtrované
// jen na PŘÍMÉ eventy tyhle měny (viz loadCurrencyContext), takže relevance faktor je vždy 1.
function selectScenarioSeeds(candidates) {
  return candidates
    .map((ev) => ({ ...ev, _weight: getWeight(ev.title) }))
    .filter((ev) => ev._weight > 0)
    .sort((a, b) => b._weight - a._weight)
    .slice(0, MAX_SCENARIOS)
    .map(({ _weight, ...ev }) => ev);
}

async function loadCurrencyContext(currencyCode, allCalendarEvents, basketContext, marketRegime) {
  const today = isoToday();
  const upcomingCutoff = new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString().slice(0, 10);
  const recentCutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);

  const { data: cotRows } = await supabase
    .from("latest_confluence_scores")
    .select("cot_score, overall_score, cot_positioning_label, conviction_label, conviction_stars, conviction_reasons, retail_score, cot_percentile, data_tier, summary")
    .eq("currency_code", currencyCode)
    .limit(1);
  const cotRow = cotRows?.[0] ?? null;

  const { data: fundRows } = await supabase
    .from("latest_fundamental_scores")
    .select("fundamental_score, confidence, history_months")
    .eq("currency_code", currencyCode)
    .limit(1);
  const fundamental = fundRows?.[0] ?? null;

  const { data: cbRows } = await supabase
    .from("cb_policy_state")
    .select("rate, cpi, policy_score, policy_label, policy_confidence, real_yield_adj, cb_policy_adj, priced_in")
    .eq("currency_code", currencyCode)
    .limit(1);
  const cbPolicy = cbRows?.[0] ?? null;

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

  // Vlastní (širší) okno pro scénáře: pár dní zpět (aby čerstvě vyšlé číslo ještě dostalo
  // komentář k výsledku) až po upcomingCutoff dopředu — nezávislé na `upcoming`/`recent`
  // oknech výše, které slouží jen jako obecný kontext pro zbytek příběhu.
  const scenarioLookbackCutoff = new Date(Date.now() - SCENARIO_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const scenarioCandidates = currencyEvents
    .filter((e) => e.event_day >= scenarioLookbackCutoff && e.event_day <= upcomingCutoff)
    .sort((a, b) => a.event_day.localeCompare(b.event_day))
    .map((e) => ({
      date: e.event_day,
      title: e.event_title,
      impact: e.impact,
      estimate: e.estimate,
      previous: e.previous,
      actual: e.actual,
      historicalTrend: getEventHistoryTrend(e.event_title, currencyCode, allCalendarEvents),
    }));

  const scenarioSeeds = selectScenarioSeeds(scenarioCandidates);

  const cot = cotRow
    ? {
        cotScore: cotRow.cot_score,
        overallScore: cotRow.overall_score,
        positioningLabel: cotRow.cot_positioning_label,
        convictionLabel: cotRow.conviction_label,
        convictionStars: cotRow.conviction_stars,
        convictionReasons: cotRow.conviction_reasons,
        cotPercentile: cotRow.cot_percentile,
        summary: cotRow.summary,
      }
    : null;

  const retailSentiment = cotRow?.retail_score != null ? { score: cotRow.retail_score, cotPercentile: cotRow.cot_percentile } : null;

  const otherCurrencies = Object.fromEntries(Object.entries(basketContext).filter(([code]) => code !== currencyCode));

  return { cot, fundamental, cbPolicy, retailSentiment, riskRegime: marketRegime, basketContext: otherCurrencies, upcoming, recent, scenarioSeeds };
}

async function generateForCurrency(currencyCode, context) {
  const { cot, fundamental, cbPolicy, retailSentiment, riskRegime, basketContext, upcoming, recent, scenarioSeeds } = context;

  if (!cot && !fundamental && upcoming.length === 0 && recent.length === 0) {
    console.log(`[${currencyCode}] žádná data — přeskočeno.`);
    return false;
  }

  const payload = {
    currency: currencyCode,
    cot,
    fundamental,
    cbPolicy,
    retailSentiment,
    riskRegime,
    basketContext,
    upcomingEvents: upcoming,
    recentEvents: recent,
    scenarioSeeds,
  };

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
              scenarios: {
                type: "array",
                maxItems: MAX_SCENARIOS,
                items: {
                  type: "object",
                  properties: {
                    event: { type: "string" },
                    date: { type: "string" },
                    if_beat: { type: "string" },
                    if_miss: { type: "string" },
                    outcome: { type: ["string", "null"] },
                  },
                  required: ["event", "date", "if_beat", "if_miss", "outcome"],
                  additionalProperties: false,
                },
              },
            },
            required: ["narrative", "forward_flag", "conviction_note", "scenarios"],
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
    scenarios: result.scenarios ?? [],
    model: OPENAI_MODEL,
  });

  if (insErr) {
    console.error(`[${currencyCode}] chyba zápisu narrative:`, insErr.message);
    return false;
  }

  console.log(`[${currencyCode}] OK — narrative vygenerován (${result.narrative.length} znaků, ${result.scenarios?.length ?? 0} scénářů).`);
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

  const basketContext = await loadBasketContext();
  const marketRegime = await loadMarketRegime();

  let ok = 0;
  for (const { code } of currencies ?? []) {
    const context = await loadCurrencyContext(code, allCalendarEvents ?? [], basketContext, marketRegime);
    const success = await generateForCurrency(code, context);
    if (success) ok++;
  }

  console.log(`\nHotovo: ${ok}/${currencies?.length ?? 0} měn úspěšně zpracováno.`);
}

main().catch((err) => {
  console.error("Neočekávaná chyba:", err);
  process.exit(1);
});
