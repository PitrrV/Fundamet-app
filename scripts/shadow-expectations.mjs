// Phase 4 — generalizace rate-decision-drift.mjs (trackRateDecisionDrift) z jediné kategorie
// "Interest Rates" na obecná makro data. STEJNÝ princip: ulož snímek jen při SKUTEČNÉ změně
// `estimate`, žádná extrapolace/predikce. Čistě historizace pro pozdější validaci Expectations
// vrstvy (Phase 3.7) — appka odsud NIKDY nepočítá žádné nové skóre.
//
// Priorita kategorií (dle zadání): CPI → GDP → NFP/jobs → Retail Sales → PMI. Pro každou měnu a
// kategorii appka sleduje NEJBLIŽŠÍ nadcházející event s validním `estimate` — starší/vzdálenější
// kandidáty v téže kategorii appka záměrně nesbírá (jeden aktivní "sledovaný" event na kategorii,
// stejná konvence jako upcomingRateDecision v cb-policy.mjs).

import { matchRule } from "./fundamental-scoring.mjs";

export const EXPECTATIONS_CATEGORIES = ["Inflation", "GDP", "Labor +Jobs", "Retail Sales", "PMI"];

function parseEstimate(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?%?$/.test(cleaned)) return null; // vyhýbá se hlasovacím formátům ("7-2") apod.
  const val = parseFloat(cleaned);
  return Number.isNaN(val) ? null : val;
}

export function findNearestUpcoming(currencyCode, category, calendarEvents, todayIso) {
  const candidates = calendarEvents
    .filter(
      (ev) =>
        ev.currency_code === currencyCode &&
        !ev.actual &&
        ev.estimate &&
        ev.event_day >= todayIso &&
        matchRule(ev.event_title)?.cat === category &&
        parseEstimate(ev.estimate) !== null
    )
    .sort((a, b) => new Date(a.event_day) - new Date(b.event_day));
  return candidates[0] ?? null;
}

// @param {object} supabase
// @param {string} currencyCode
// @param {Array} calendarEvents
// @param {string} todayIso
export async function trackExpectationsDrift(supabase, currencyCode, calendarEvents, todayIso) {
  const results = [];
  for (const category of EXPECTATIONS_CATEGORIES) {
    const candidate = findNearestUpcoming(currencyCode, category, calendarEvents, todayIso);
    if (!candidate) continue;

    const estimateValue = parseEstimate(candidate.estimate);
    if (estimateValue === null) continue;

    const { data: latest, error: readErr } = await supabase
      .from("fundamental_expectations_history")
      .select("estimate_value, snapshot_at")
      .eq("currency_code", currencyCode)
      .eq("category", category)
      .eq("event_day", candidate.event_day)
      .order("snapshot_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (readErr) {
      console.error(`shadow-expectations [${currencyCode}/${category}]: chyba čtení historie:`, readErr.message);
      continue;
    }

    const changed = !latest || Number(latest.estimate_value) !== estimateValue;
    if (!changed) continue;

    const { error: insErr } = await supabase.from("fundamental_expectations_history").insert({
      currency_code: currencyCode,
      category,
      event_title: candidate.event_title,
      event_day: candidate.event_day,
      estimate_value: estimateValue,
    });
    if (insErr) {
      console.error(`shadow-expectations [${currencyCode}/${category}]: chyba zápisu:`, insErr.message);
      continue;
    }
    results.push({ category, eventTitle: candidate.event_title, eventDay: candidate.event_day, estimateValue, previous: latest ? Number(latest.estimate_value) : null });
  }
  return results;
}
