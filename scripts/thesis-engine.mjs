// Konfluence Gen2, Fáze 1 — Thesis Engine (ve stínu vedle stávajícího systému, viz
// architektonické návrhy Gen2/Gen2.5/Gen3/Gen3.5 poslané uživateli jako samostatné dokumenty).
//
// Rozdíl proti dosavadnímu systému: měna nemá jen "dnešní skóre", má TEZI s pamětí napříč
// dny — currency_thesis + append-only thesis_ledger. Nová data se nehodnotí izolovaně, ale
// vůči existující tezi: potvrzují ji (confirms), zpochybňují (challenges), nebo ruší
// (invalidates_driver / uzavření teze). Klasifikace je čistě deterministická (viz
// classifyThesisUpdate — žádné I/O, žádný LLM).
//
// V TÉTHLE FÁZI appka ještě nečte currency_thesis do UI — běží to "ve stínu" k ověření na
// reálných datech, přesně jak doporučoval Gen2 dokument v sekci "Než se začne implementovat".

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// Prahy "o kolik se musí pilíř lišit od nuly, aby se počítal jako pojmenovaný driver, ne šum" —
// editorská volba (stejná konvence jako zbytek systému — ne zpětně testováno), na škále, na
// které daný pilíř reálně žije (viz scripts/fetch-calendar.mjs recomputeScores()).
//
// driver_key je záměrně pevná, kódem řízená množina, ne volný text — sanity-check nález #5
// (metrika, co může časem tiše změnit význam): risk_regime je STRUKTURÁLNÍ/SDÍLENÝ driver
// napříč měnami (JPY/CHF v risk-off, AUD/NZD/CAD v risk-on), takže musí mít stejný klíč pro
// všechny měny, jinak by budoucí cross-currency regime detekce (Gen2.5) tiše nefungovala.
export const DRIVER_THRESHOLDS = {
  fundamental_data: 1.5, // fundamentalScoreAdj, škála -5..5
  cot_positioning: 1.5, // cot_score, škála -5..5
  cb_policy: 0.4, // cbPolicyAdj + realYieldAdj, škála zhruba -1.75..1.75
  risk_regime: 0.2, // riskAdj, škála zhruba -0.5..0.5 — sdílený driver_key
  retail_sentiment: 1.5, // retailScore, škála -5..5
};

const DRIVER_LABELS = {
  fundamental_data: "Fundamentální data",
  cot_positioning: "COT pozicování",
  cb_policy: "CB politika / real yield",
  risk_regime: "Risk režim",
  retail_sentiment: "Retail sentiment",
};

const THESIS_DIRECTION_DEADZONE = 0.3; // |overall_score| pod tímhle = neutrální teze

// "confirms" se dřív logoval při KAŽDÉM běhu (každých 15 min), i když se hodnota pilíře vůbec
// nehnula — u retail_sentiment/cot_positioning (mění se jen týdně přes ingest-cot.mjs) to
// zaplavilo "Co se změnilo?" desítkami identických řádků denně a smysluplné challenges/
// invalidates_driver záznamy z toho vypadly z limitu feedu (viz živě nahlášený případ
// 31.7.2026: AUD PPI pozitivní překvapení mělo zpochybnit fundament driver, ale nebylo
// dohledatelné mezi spamem retail confirms). Nový confirms se teď loguje jen když se hodnota
// SKUTEČNĚ posunula, nebo jednou za CONFIRM_REMINDER_HOURS jako připomínka, že driver pořád
// platí.
const CONFIRM_REMINDER_HOURS = 24;
const CONFIRM_REMINDER_MS = CONFIRM_REMINDER_HOURS * 60 * 60 * 1000;
const CONFIRM_VALUE_EPSILON = 0.05; // stejná citlivost jako dedup u score_snapshots ve fetch-calendar.mjs

// fundamental_data je jediný driver, u kterého umíme v okamžiku klasifikace dohledat KONKRÉTNÍ
// dnešní event (viz todaysFundamentalEventLabel ve fetch-calendar.mjs) — ostatní drivery jsou
// agregátní čísla bez jednoho jasného "zdroje" k pojmenování.
function driverEventSuffix(driverKey, eventLabel) {
  return driverKey === "fundamental_data" && eventLabel ? ` — ${eventLabel}` : "";
}

export function directionFromScore(score) {
  if (score > THESIS_DIRECTION_DEADZONE) return "bullish";
  if (score < -THESIS_DIRECTION_DEADZONE) return "bearish";
  return "neutral";
}

function signMatchesDirection(value, direction) {
  if (direction === "bullish") return value > 0;
  if (direction === "bearish") return value < 0;
  return false;
}

// Které pilíře jsou dost silné a ve správném směru, aby se počítaly jako pojmenovaný driver
// NOVĚ otevírané tezí (žádná předchozí teze, se kterou by se dalo porovnávat).
function computeInitialDrivers(direction, pillarValues, now = new Date()) {
  const drivers = [];
  for (const [driverKey, value] of Object.entries(pillarValues)) {
    if (value === null || value === undefined) continue;
    if (Math.abs(value) < DRIVER_THRESHOLDS[driverKey]) continue;
    if (!signMatchesDirection(value, direction)) continue;
    drivers.push({
      driver_key: driverKey,
      label: DRIVER_LABELS[driverKey],
      value: Math.round(value * 100) / 100,
      status: "strong",
      confirmed_at: now.toISOString(),
    });
  }
  return drivers;
}

// Jádro klasifikace — porovná drivery PŘEDCHOZÍ tezí s aktuálními hodnotami pilířů. Čistá
// funkce, žádné I/O, snadno testovatelná a auditovatelná.
//
// Pravidla (viz Gen2 "Rozhodovací logika: potvrzuje / zpochybňuje / ruší"):
//  - driver pořád v souladu se směrem a nad prahem -> confirms
//  - driver poprvé přestane sedět (opačné znaménko nebo pod prahem) -> challenges, status "weakening"
//  - driver zpochybněn PODRUHÉ v řadě (byl už "weakening") -> invalidates_driver, driver odebrán
//  - nový pilíř nad prahem ve správném směru, co v tezi ještě nebyl -> confirms (nový driver)
export function classifyThesisUpdate(previousDrivers, direction, pillarValues, options = {}) {
  const { now = new Date(), fundamentalEventLabel = null } = options;
  const ledgerEntries = [];
  const nextDrivers = [];
  let dominantInvalidated = false;

  const prevDriversByKey = new Map((previousDrivers ?? []).map((d) => [d.driver_key, d]));
  const dominantKey = (previousDrivers ?? []).slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0]?.driver_key;

  for (const prevDriver of previousDrivers ?? []) {
    const currentValue = pillarValues[prevDriver.driver_key];
    const stillSupports =
      currentValue !== null &&
      currentValue !== undefined &&
      signMatchesDirection(currentValue, direction) &&
      Math.abs(currentValue) >= DRIVER_THRESHOLDS[prevDriver.driver_key];

    if (stillSupports) {
      const valueChanged = Math.abs(currentValue - prevDriver.value) >= CONFIRM_VALUE_EPSILON;
      const lastConfirmedAt = prevDriver.confirmed_at ? new Date(prevDriver.confirmed_at).getTime() : null;
      const dueForReminder = lastConfirmedAt === null || now.getTime() - lastConfirmedAt >= CONFIRM_REMINDER_MS;
      const shouldLog = valueChanged || dueForReminder;

      nextDrivers.push({
        ...prevDriver,
        value: Math.round(currentValue * 100) / 100,
        status: "strong",
        confirmed_at: shouldLog ? now.toISOString() : (prevDriver.confirmed_at ?? now.toISOString()),
      });
      if (shouldLog) {
        ledgerEntries.push({
          driver_key: prevDriver.driver_key,
          classification: "confirms",
          reasoning: `${DRIVER_LABELS[prevDriver.driver_key]} zůstává v souladu se tezí (${currentValue.toFixed(2)})${driverEventSuffix(prevDriver.driver_key, fundamentalEventLabel)}.`,
        });
      }
      continue;
    }

    if (prevDriver.status === "weakening") {
      ledgerEntries.push({
        driver_key: prevDriver.driver_key,
        classification: "invalidates_driver",
        reasoning: `${DRIVER_LABELS[prevDriver.driver_key]} zpochybněn podruhé v řadě — driver z teze odebrán${driverEventSuffix(prevDriver.driver_key, fundamentalEventLabel)}.`,
      });
      if (prevDriver.driver_key === dominantKey) dominantInvalidated = true;
    } else {
      nextDrivers.push({ ...prevDriver, status: "weakening" });
      ledgerEntries.push({
        driver_key: prevDriver.driver_key,
        classification: "challenges",
        reasoning: `${DRIVER_LABELS[prevDriver.driver_key]} už neodpovídá směru teze — poprvé zpochybněn${driverEventSuffix(prevDriver.driver_key, fundamentalEventLabel)}.`,
      });
    }
  }

  for (const [driverKey, value] of Object.entries(pillarValues)) {
    if (prevDriversByKey.has(driverKey)) continue;
    if (value === null || value === undefined) continue;
    if (Math.abs(value) < DRIVER_THRESHOLDS[driverKey]) continue;
    if (!signMatchesDirection(value, direction)) continue;
    nextDrivers.push({
      driver_key: driverKey,
      label: DRIVER_LABELS[driverKey],
      value: Math.round(value * 100) / 100,
      status: "strong",
      confirmed_at: now.toISOString(),
    });
    ledgerEntries.push({
      driver_key: driverKey,
      classification: "confirms",
      reasoning: `${DRIVER_LABELS[driverKey]} nově podporuje tezi (${value.toFixed(2)})${driverEventSuffix(driverKey, fundamentalEventLabel)}.`,
    });
  }

  return { nextDrivers, ledgerEntries, dominantInvalidated };
}

function buildThesisSummary(currencyCode, direction, drivers) {
  if (direction === "neutral" || drivers.length === 0) {
    return `${currencyCode}: zatím žádná jasná teze — signály jsou smíšené nebo slabé.`;
  }
  const label = direction === "bullish" ? "Bullish" : "Bearish";
  const driverLabels = drivers.map((d) => d.label).join(", ");
  return `${label} teze nesena: ${driverLabels}.`;
}

async function insertLedgerEntries(thesisId, entries) {
  if (entries.length === 0) return;
  const rows = entries.map((e) => ({
    thesis_id: thesisId,
    driver_key: e.driver_key ?? null,
    classification: e.classification,
    reasoning: e.reasoning,
  }));
  const { error } = await supabase.from("thesis_ledger").insert(rows);
  if (error) console.error(`Chyba zápisu thesis_ledger (thesis_id=${thesisId}):`, error.message);
}

async function openNewThesis(currencyCode, direction, pillarValues, convictionStars, supersedesId = null, now = new Date()) {
  const drivers = computeInitialDrivers(direction, pillarValues, now);
  const { data, error } = await supabase
    .from("currency_thesis")
    .insert({
      currency_code: currencyCode,
      direction,
      conviction: convictionStars ?? 0,
      drivers,
      thesis_summary: buildThesisSummary(currencyCode, direction, drivers),
      status: "active",
    })
    .select("id")
    .single();

  if (error) {
    console.error(`[${currencyCode}] chyba otevření nové teze:`, error.message);
    return null;
  }

  await insertLedgerEntries(data.id, [
    {
      driver_key: null,
      classification: "opened",
      reasoning: supersedesId
        ? `Nová teze otevřena po uzavření předchozí (id=${supersedesId}) — směr se otočil.`
        : "Nová teze otevřena — žádná předchozí neexistovala.",
    },
  ]);

  if (supersedesId) {
    const { error: supErr } = await supabase.from("currency_thesis").update({ superseded_by: data.id }).eq("id", supersedesId);
    if (supErr) console.error(`[${currencyCode}] chyba zápisu superseded_by:`, supErr.message);
  }

  return data.id;
}

async function closeThesis(thesisId, reasoning) {
  const { error } = await supabase
    .from("currency_thesis")
    .update({ status: "invalidated", closed_at: new Date().toISOString() })
    .eq("id", thesisId);
  if (error) console.error(`Chyba uzavření teze id=${thesisId}:`, error.message);
  await insertLedgerEntries(thesisId, [{ driver_key: null, classification: "closed", reasoning }]);
}

/**
 * Hlavní vstupní bod — volá se z fetch-calendar.mjs po přepočtu overall_score pro danou měnu.
 * @param {string} currencyCode
 * @param {{overallScore:number, convictionStars:number, fundamentalScoreAdj:number, cotScore:number,
 *          cbPolicyAdj:number, realYieldAdj:number, riskAdj:number, retailScore:number,
 *          fundamentalEventLabel?:string|null}} pillars fundamentalEventLabel = název dnešního
 *          eventu, co nejvíc táhne fundamentalScoreAdj (viz todaysFundamentalEventLabel ve
 *          fetch-calendar.mjs) — jen kosmetika do reasoning textu u driver_key=fundamental_data.
 * @returns {Promise<boolean>} true, když se stalo něco naratívně významného (viz komentář níž)
 */
// Vrací true, když se stalo něco NARATIVNĚ významného (nová teze, obrat směru, dominantní
// driver invalidován, návrat ze watching na active) — fetch-calendar.mjs to používá jako
// druhý, nezávislý spouštěč přegenerování shrnutí, viz volání níž. Důvod: dosavadní jediný
// spouštěč (materialActualArrived, čistě diff "actual" v calendar_events mezi během) je
// křehký — dvě po sobě jdoucí souběžně běžící úlohy (např. ruční dispatch uprostřed
// pravidelného 15minutového cronu) mohou obě vidět "actual" už vyplněný tou druhou a
// spouštěč tiše nenastane, i když k reálné, důležité změně skutečně došlo (živě zachyceno
// 30. 7. 2026: rozhodnutí BOE o sazbě dorazilo, teze GBP přešla do watching, ale shrnutí
// se nepřegenerovalo, protože scrape-diff spouštěč nezafiroval).
export async function runThesisEngineForCurrency(currencyCode, pillars) {
  if (!supabase) {
    console.warn(`[${currencyCode}] thesis-engine přeskočen — chybí Supabase env.`);
    return false;
  }

  const pillarValues = {
    fundamental_data: pillars.fundamentalScoreAdj,
    cot_positioning: pillars.cotScore,
    cb_policy: (pillars.cbPolicyAdj ?? 0) + (pillars.realYieldAdj ?? 0),
    risk_regime: pillars.riskAdj,
    retail_sentiment: pillars.retailScore,
  };
  const direction = directionFromScore(pillars.overallScore);
  const now = new Date();
  const fundamentalEventLabel = pillars.fundamentalEventLabel ?? null;

  const { data: existingRows, error: readErr } = await supabase
    .from("currency_thesis")
    .select("id, direction, conviction, drivers, status, confirm_streak, challenge_streak")
    .eq("currency_code", currencyCode)
    .in("status", ["active", "watching"])
    .limit(1);

  if (readErr) {
    console.error(`[${currencyCode}] chyba čtení currency_thesis:`, readErr.message);
    return false;
  }

  const thesis = existingRows?.[0] ?? null;

  if (!thesis) {
    if (direction === "neutral") return false; // nic pojmenovaného, o čem otevírat tezi
    const newId = await openNewThesis(currencyCode, direction, pillarValues, pillars.convictionStars, null, now);
    if (newId) console.log(`[${currencyCode}] thesis-engine: otevřena nová ${direction} teze (id=${newId}).`);
    return newId != null;
  }

  // Tvrdý obrat směru (bullish <-> bearish) — teze se rovnou uzavírá, klasifikace přes
  // drivery by tu byla zavádějící (viz Gen2 "strukturální event vždy vynucuje review").
  if (direction !== "neutral" && thesis.direction !== "neutral" && direction !== thesis.direction) {
    await closeThesis(thesis.id, `Celkový směr se otočil z ${thesis.direction} na ${direction} — teze zrušena.`);
    const newId = await openNewThesis(currencyCode, direction, pillarValues, pillars.convictionStars, thesis.id, now);
    if (newId) console.log(`[${currencyCode}] thesis-engine: obrat směru, nová ${direction} teze (id=${newId}) nahrazuje id=${thesis.id}.`);
    return true;
  }

  let recovered = false;
  // Teze byla "watching" a signály se zase srovnaly se směrem -> návrat na active.
  if (thesis.status === "watching" && direction === thesis.direction) {
    const { error: recoverErr } = await supabase.from("currency_thesis").update({ status: "active" }).eq("id", thesis.id);
    if (recoverErr) console.error(`[${currencyCode}] chyba návratu teze na active:`, recoverErr.message);
    else recovered = true;
    await insertLedgerEntries(thesis.id, [
      { driver_key: null, classification: "confirms", reasoning: "Teze se stabilizovala — návrat ze stavu watching na active." },
    ]);
  }

  const { nextDrivers, ledgerEntries, dominantInvalidated } = classifyThesisUpdate(thesis.drivers ?? [], direction, pillarValues, {
    now,
    fundamentalEventLabel,
  });

  const hasChallenge = ledgerEntries.some((e) => e.classification === "challenges" || e.classification === "invalidates_driver");
  const confirmStreak = hasChallenge ? 0 : thesis.confirm_streak + 1;
  const challengeStreak = hasChallenge ? thesis.challenge_streak + 1 : 0;
  const newStatus = dominantInvalidated ? "watching" : thesis.status === "watching" && direction === thesis.direction ? "active" : thesis.status;

  const { error: updErr } = await supabase
    .from("currency_thesis")
    .update({
      conviction: pillars.convictionStars ?? thesis.conviction,
      drivers: nextDrivers,
      thesis_summary: buildThesisSummary(currencyCode, direction, nextDrivers),
      status: newStatus,
      confirm_streak: confirmStreak,
      challenge_streak: challengeStreak,
      updated_at: new Date().toISOString(),
    })
    .eq("id", thesis.id);

  if (updErr) {
    console.error(`[${currencyCode}] chyba update currency_thesis:`, updErr.message);
    return recovered;
  }

  await insertLedgerEntries(thesis.id, ledgerEntries);

  if (ledgerEntries.length > 0) {
    console.log(
      `[${currencyCode}] thesis-engine: ${ledgerEntries.length} klasifikace (${ledgerEntries.map((e) => e.classification).join(", ")})` +
        (dominantInvalidated ? " — DOMINANTNÍ DRIVER INVALIDOVÁN, teze -> watching" : "")
    );
  }

  return recovered || dominantInvalidated;
}
