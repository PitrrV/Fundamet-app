// Konfluence Gen2 — Market Expectations Engine (MEE), viz architektonický návrh Gen2.
//
// Rozdíl proti prostému beat/miss: odděluje "co trh oficiálně čeká" (consensus estimate) od
// "na co je trh reálně napozicovaný" (COT percentil). Beat, co jen potvrzuje pozicování, co už
// bylo crowded, je jiná informace než beat proti neutrálnímu pozicování — první je kandidát na
// "sell the news", druhý je skutečná novinka. Bez týhle vrstvy appka tenhle rozdíl neumí poznat.
//
// Dva kroky, oba volané pro každou měnu z fetch-calendar.mjs:
//  1) snapshot nadcházejících klíčových eventů (PŘED tím, než vyjde actual)
//  2) vyhodnocení reakce, jakmile actual dorazí

import { createClient } from "@supabase/supabase-js";
import { matchRule, eventDirection, surpriseStrength } from "./fundamental-scoring.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const SNAPSHOT_WINDOW_DAYS = 10;
// Editorská volba (stejná konvence jako zbytek systému) — nad tímhle prahem priced-in skóre
// bereme surprise jako kandidáta na "sell the news", ne jako čistou novinku.
const SELL_THE_NEWS_THRESHOLD = 0.6;

function parseNum(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return parseFloat(String(value).replace(",", "."));
}

// % posledních výskytů téhle datové řady pro danou měnu, co beatly konsensus — surová
// historická statistika, žádné vážení podle stáří (na rozdíl od fundamental-scoring.mjs).
function computeHistoricalBeatRate(title, currencyCode, allEvents) {
  const history = allEvents.filter(
    (e) => e.currency_code === currencyCode && e.event_title === title && e.actual && e.estimate
  );
  const resolved = history.filter((e) => !Number.isNaN(parseNum(e.actual)) && !Number.isNaN(parseNum(e.estimate)));
  if (resolved.length === 0) return null;
  const beats = resolved.filter((e) => parseNum(e.actual) > parseNum(e.estimate)).length;
  return Math.round((beats / resolved.length) * 100);
}

// 0..1 — jak extrémní (daleko od neutrálních 50) je aktuální COT pozicování. Nehádá SMĚR
// budoucího výsledku, jen říká "kolik je toho už v cenách", viz Gen2 dokument.
function pricedInScoreFromPercentile(percentile) {
  if (percentile === null || percentile === undefined) return null;
  return Math.round((Math.abs(percentile - 50) / 50) * 100) / 100;
}

function positioningBiasFromPercentile(percentile) {
  if (percentile === null || percentile === undefined) return "neutral";
  if (percentile >= 70) return "crowded_long";
  if (percentile <= 30) return "crowded_short";
  return "neutral";
}

/**
 * @param {string} currencyCode
 * @param {Array} allEvents - calendar_events řádky VŠECH měn (musí obsahovat `id`)
 * @param {number|null} cotPercentile - aktuální COT percentil pro tuhle měnu
 */
export async function runMarketExpectationsForCurrency(currencyCode, allEvents, cotPercentile) {
  if (!supabase) {
    console.warn(`[${currencyCode}] MEE přeskočen — chybí Supabase env.`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + SNAPSHOT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

  const upcoming = allEvents.filter(
    (e) =>
      e.currency_code === currencyCode &&
      e.event_day >= today &&
      e.event_day <= cutoff &&
      !e.actual &&
      e.id &&
      (matchRule(e.event_title)?.w ?? 0) > 0
  );

  for (const ev of upcoming) {
    const historicalBeatRate = computeHistoricalBeatRate(ev.event_title, currencyCode, allEvents);
    const pricedInScore = pricedInScoreFromPercentile(cotPercentile);

    const { error } = await supabase.from("market_expectations").upsert(
      {
        calendar_event_id: ev.id,
        currency_code: currencyCode,
        event_title: ev.event_title,
        event_day: ev.event_day,
        consensus_estimate: ev.estimate,
        cot_percentile_snapshot: cotPercentile,
        positioning_bias: positioningBiasFromPercentile(cotPercentile),
        historical_beat_rate: historicalBeatRate,
        priced_in_score: pricedInScore,
        snapshot_at: new Date().toISOString(),
      },
      { onConflict: "calendar_event_id" }
    );
    if (error) console.error(`[${currencyCode}] MEE chyba upsertu snapshotu (${ev.event_title}):`, error.message);
  }

  const { data: pendingSnapshots, error: readErr } = await supabase
    .from("market_expectations")
    .select("id, calendar_event_id, event_title, event_day, priced_in_score")
    .eq("currency_code", currencyCode);

  if (readErr) {
    console.error(`[${currencyCode}] MEE chyba čtení market_expectations:`, readErr.message);
    return;
  }
  if (!pendingSnapshots || pendingSnapshots.length === 0) return;

  const { data: existingReactions, error: reactErr } = await supabase
    .from("event_reactions")
    .select("market_expectation_id")
    .eq("currency_code", currencyCode);
  if (reactErr) {
    console.error(`[${currencyCode}] MEE chyba čtení event_reactions:`, reactErr.message);
    return;
  }
  const reactedIds = new Set((existingReactions ?? []).map((r) => r.market_expectation_id));

  const eventsById = new Map(allEvents.filter((e) => e.currency_code === currencyCode && e.id).map((e) => [e.id, e]));

  for (const snap of pendingSnapshots) {
    if (reactedIds.has(snap.id)) continue;
    const ev = eventsById.get(snap.calendar_event_id);
    if (!ev || !ev.actual) continue;

    const rule = matchRule(ev.event_title);
    if (!rule) continue;

    const direction = eventDirection(ev, rule);
    const strength = surpriseStrength(ev);
    const pricedIn = snap.priced_in_score;

    let reactionQuality = "as_expected";
    if (direction !== 0) {
      reactionQuality = pricedIn !== null && pricedIn > SELL_THE_NEWS_THRESHOLD ? "sell_the_news_risk" : "genuine_surprise";
    }

    const { error: insErr } = await supabase.from("event_reactions").insert({
      market_expectation_id: snap.id,
      calendar_event_id: snap.calendar_event_id,
      currency_code: currencyCode,
      event_title: snap.event_title,
      event_day: snap.event_day,
      actual: ev.actual,
      surprise_direction: direction,
      surprise_strength: Math.round(strength * 100) / 100,
      priced_in_score: pricedIn,
      reaction_quality: reactionQuality,
    });
    if (insErr) {
      console.error(`[${currencyCode}] MEE chyba zápisu event_reactions (${snap.event_title}):`, insErr.message);
    } else {
      console.log(
        `[${currencyCode}] MEE: reakce na "${snap.event_title}" = ${reactionQuality} (směr=${direction}, priced_in=${pricedIn}).`
      );
    }
  }
}
