// Sleduje, jak se v čase mění tržní konsensus (ForexFactory "estimate") pro NADCHÁZEJÍCÍ
// sazbové rozhodnutí, které appka už umí spočítat (viz upcomingRateDecision, cb-policy.mjs).
// Appka dřív viděla jen AKTUÁLNÍ snímek konsensu (bod #7 post-fix auditu, 4.9.2026) — ne jak
// se k němu trh dopracoval. Bez historie nejde poznat rozdíl mezi "konsensus je stabilní už
// týdny" a "konsensus se teprve teď hýbe a rozhodnutí je za dveřmi" — přesně tu druhou situaci
// chce appka umět zviditelnit (živý podnět uživatele, 16.9.2026).
//
// Princip: ukládej snímek JEN když se hodnota SKUTEČNĚ mění (ne při každém 15min běhu) — jedna
// řádka na jednu revizi konsensu, ne šum. Nad rámec toho appka jen POROVNÁVÁ nejstarší a
// nejnovější snímek, žádná extrapolace ani predikce.
//
// DŮLEŽITÉ OMEZENÍ (stejná konvence jako upcomingRateDecision): ČISTĚ INFORMAČNÍ vrstva pro
// UI/narrativ, nikde nevstupuje do policy_score/cbPolicyAdj/realYieldAdj/overall_score. Appka
// neříká "obchoduj teď" ani "je čas se pozicovat" — jen zviditelní FAKT, že se tržní očekávání
// mění a rozhodnutí se blíží, ať si čtenář včas všimne sám (appka neřeší timing/vstup do
// obchodu, to je úloha Fx Analyzeru, viz generate-narrative.mjs SHARED_CONTEXT).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// Editorská volba (stejná konvence jako zbytek systému): pod tímhle počtem dní do rozhodnutí
// appka posun konsensu označí jako "imminent" (zvýrazní ho v UI/narrativu) — nad tímhle oknem
// jde jen o tichou historii pro pozdější kontext. 21 dní = zhruba 3 týdny, typicky poslední
// úsek před čtvrtletním cyklem zasedání velkých centrálních bank.
export const PROXIMITY_WINDOW_DAYS = 21;

/**
 * @param {string} currencyCode
 * @param {import("./cb-policy.mjs").UpcomingRateDecision|null} decision - výstup upcomingRateDecision()
 * @returns {Promise<object|null>} decision obohacený o pole `drift`, nebo null beze změny
 */
export async function trackRateDecisionDrift(currencyCode, decision) {
  if (!decision) return null;
  if (!supabase) {
    console.warn(`[${currencyCode}] Sledování konsensu přeskočeno — chybí Supabase env.`);
    return { ...decision, drift: null };
  }

  const { data: latest, error: readErr } = await supabase
    .from("rate_decision_estimate_history")
    .select("estimate_rate, snapshot_at")
    .eq("currency_code", currencyCode)
    .eq("event_day", decision.eventDay)
    .order("snapshot_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (readErr) {
    console.error(`[${currencyCode}] Nepodařilo se načíst historii konsensu:`, readErr.message);
    return { ...decision, drift: null };
  }

  // Ulož nový snímek jen při skutečné změně hodnoty — první běh pro danou eventDay (latest
  // neexistuje) taky zakládá historii, ať appka má od čeho měřit "firstEstimateRate".
  const changed = !latest || Number(latest.estimate_rate) !== decision.estimateRate;
  // Živý podnět uživatele (18.9.2026): appka má na tohle upozornit Telegramem, ne jen tiše
  // zapsat. `justRevised` je TRUE jen když už dřív nějaký snímek existoval A hodnota se
  // změnila — ne při úplně prvním zachycení nové nadcházející sazby (to není "revize", jen
  // appka se poprvé dozvěděla o novém rozhodnutí).
  const justRevised = changed && !!latest;
  const previousEstimateRate = latest ? Number(latest.estimate_rate) : null;
  if (changed) {
    const { error: insErr } = await supabase.from("rate_decision_estimate_history").insert({
      currency_code: currencyCode,
      event_title: decision.eventTitle,
      event_day: decision.eventDay,
      current_rate: decision.currentRate,
      estimate_rate: decision.estimateRate,
      direction: decision.direction,
    });
    if (insErr) console.error(`[${currencyCode}] Nepodařilo se zapsat revizi konsensu:`, insErr.message);
  }

  const { data: history, error: histErr } = await supabase
    .from("rate_decision_estimate_history")
    .select("estimate_rate, snapshot_at")
    .eq("currency_code", currencyCode)
    .eq("event_day", decision.eventDay)
    .order("snapshot_at", { ascending: true });

  if (histErr || !history || history.length === 0) {
    if (histErr) console.error(`[${currencyCode}] Nepodařilo se načíst historii konsensu:`, histErr.message);
    return { ...decision, drift: null };
  }

  const first = history[0];
  const firstEstimateRate = Number(first.estimate_rate);
  const shifted = firstEstimateRate !== decision.estimateRate;
  const daysTracked = Math.max(0, Math.round((Date.now() - new Date(first.snapshot_at).getTime()) / 86400000));
  const daysUntilDecision = Math.round(
    (new Date(`${decision.eventDay}T00:00:00Z`).getTime() - Date.now()) / 86400000
  );

  return {
    ...decision,
    drift: {
      firstEstimateRate,
      firstTrackedAt: first.snapshot_at,
      daysTracked,
      daysUntilDecision,
      revisionsCount: history.length,
      shifted,
      // Zvýrazňovací signál: konsensus se prokazatelně hýbe A rozhodnutí je blízko. Obojí
      // musí platit najednou — posun daleko dopředu (>PROXIMITY_WINDOW_DAYS) je pořád jen
      // tichá historie, ne důvod appku zviditelňovat.
      imminent: shifted && daysUntilDecision >= 0 && daysUntilDecision <= PROXIMITY_WINDOW_DAYS,
      // Pro Telegram alert v main() — jen TATO revize (ne celková historie od prvního
      // snímku), ať zpráva ukazuje "odkud se to práva hnulo", ne jen "odkud appka sleduje".
      justRevised,
      previousEstimateRate,
    },
  };
}
