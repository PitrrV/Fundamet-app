// Fundamentální STAV měny — hlavní skóre a pořadí aplikace. Čisté funkce, žádné I/O.
//
// Odpovídá na otázku "jak se dané měně fundamentálně daří" ze 6 složek, každá +1 / 0 / −1 nebo
// null ("nemáme data" — nikdy ne tichá nula):
//   politika centrální banky · reálný výnos · trh práce · růst (HDP) · spotřeba · PMI
// Index = vážený průměr dostupných složek (−1..+1), skóre = index × 5 (kompatibilní škála −5..+5).
//
// Proč STAV a ne překvapení: backtest 2023–2026 (scripts/research-lookback-backtest.mjs, 1568
// pozorování měna×týden) — pořadí podle stavu mělo týdenní rank-IC ≈ 0,10 vůči pozdějšímu
// pohybu ceny měny, skóre z překvapení vs. konsenzus ≈ 0. Okno 12 měsíců dopadlo nejlépe a delší
// historie index nezlepšila. Index je ČTENÍ fundamentální situace, ne předpověď ceny — IC je
// slabé a po letech nestabilní. Překvapení (už "v ceně") se proto zobrazuje zvlášť, mimo skóre.
// COT, retail sentiment, VIX ani cena do výpočtu NEVSTUPUJÍ.
import { computeCbPolicyState } from "./cb-policy.mjs";
import {
  extractUnemploymentHistory,
  extractGrowthHistory,
  extractRetailSalesHistory,
  extractPmiHistory,
  extractInflationHistory,
  CB_INFLATION_TARGET,
} from "./shadow-fundamental-engine.mjs";

export const STATE_MODEL_VERSION = "state-v1";
export const WINDOW_MONTHS = 12; // kolik historie index vidí (backtest: 12 m nejlepší, delší horší)
export const TREND_BASE_PRINTS = 3; // "norma" = průměr předchozích 3 tisků
export const TREND_THRESHOLD = 0.5; // odchylka posledního tisku od normy v jednotkách směrodatné odchylky řady
export const MIN_COMPONENTS = 3; // pod tímto počtem dostupných složek index neexistuje
export const SCORE_SCALE = 5; // index (−1..+1) → skóre (−5..+5)
export const REAL_YIELD_DEADBAND = 0.05;
export const PMI_BAND = { low: 49.5, high: 50.5 }; // kolem hranice 50 expanze/kontrakce

// Váhy ve třech úrovních (ne jemné ladění): reálný výnos a trh práce nesly v backtestu největší
// informaci, HDP (zřídka, se zpožděním) nejmenší.
export const COMPONENT_DEFS = [
  { key: "policy", label: "Politika centrální banky", weight: 1.0 },
  { key: "realYield", label: "Reálný výnos", weight: 1.5 },
  { key: "labor", label: "Trh práce", weight: 1.5 },
  { key: "growth", label: "Růst (HDP)", weight: 0.5 },
  { key: "demand", label: "Spotřeba (maloobchod)", weight: 1.0 },
  { key: "pmi", label: "PMI", weight: 1.0 },
];

export const BANDS = [
  { key: "strong", label: "Silný", min: 0.5 },
  { key: "mild_positive", label: "Mírně pozitivní", min: 0.2 },
  { key: "neutral", label: "Neutrální", min: -0.2 },
  { key: "mild_negative", label: "Mírně negativní", min: -0.5 },
  { key: "weak", label: "Slabý", min: -Infinity },
];

export function bandFromIndex(index) {
  if (index === null || index === undefined) return { key: "insufficient", label: "Nedostatek dat" };
  // Hranice patří výš: index přesně 0,2 je "mírně pozitivní"; −0,2 už "neutrální".
  const b = BANDS.find((band) => index >= band.min - 1e-9) ?? BANDS[BANDS.length - 1];
  return { key: b.key, label: b.label };
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};
const round = (v, d) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const fmtNum = (v) => String(round(v, 2)).replace(".", ",");

function addMonths(day, months) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Trend série vůči vlastní nedávné normě. null = málo tisků (nemáme, ne nula).
function trendComponent(history, { invert = false, unit = "" } = {}) {
  const n = history.length;
  if (n < TREND_BASE_PRINTS + 1) {
    return { score: null, detail: n === 0 ? "data nemáme" : `málo tisků (${n}) na určení trendu` };
  }
  const values = history.map((h) => h.value);
  const last = values[n - 1];
  const norm = mean(values.slice(-1 - TREND_BASE_PRINTS, -1));
  const z = (last - norm) / (sd(values) || 1);
  let s = z >= TREND_THRESHOLD ? 1 : z <= -TREND_THRESHOLD ? -1 : 0;
  if (invert) s = -s;
  return { score: s === 0 ? 0 : s, detail: `poslední ${fmtNum(last)}${unit} (norma ${fmtNum(norm)}${unit})` };
}

function pmiComponent(history) {
  if (history.length === 0) return { score: null, detail: "data nemáme" };
  const last = history[history.length - 1].value;
  const s = last > PMI_BAND.high ? 1 : last < PMI_BAND.low ? -1 : 0;
  return { score: s, detail: `${fmtNum(last)} (hranice expanze 50)` };
}

export function describeSurprise(score) {
  if (score === null || score === undefined) return "nemáme";
  if (score >= 1) return "pozitivní překvapení";
  if (score <= -1) return "negativní překvapení";
  return "v souladu s očekáváním";
}

/**
 * @param {string} currencyCode
 * @param {string[]} allCodes všechny skórované měny (koš pro reálný výnos)
 * @param {Array} events řádky calendar_events
 * @param {{asOfDay?: string, cb?: object}} opts asOfDay "YYYY-MM-DD" (default: nejnovější event);
 *   cb = už spočítaný computeCbPolicyState (produkce), jinak se spočítá z okna
 */
export function computeFundamentalState(currencyCode, allCodes, events, { asOfDay, cb } = {}) {
  const day = asOfDay ?? events.reduce((m, e) => (e.event_day > m ? e.event_day : m), "0000-00-00");
  const from = addMonths(day, -WINDOW_MONTHS);
  const windowed = events.filter((e) => e.event_day >= from && e.event_day <= day);
  const cbState = cb ?? computeCbPolicyState(currencyCode, allCodes, windowed);

  const raw = {
    policy: { score: Math.sign(cbState.policyScore ?? 0) || 0, detail: cbState.policyLabel ?? "bez dat" },
    realYield:
      cbState.realYieldAdj === null || cbState.realYieldAdj === undefined
        ? { score: null, detail: "chybí roční inflace (CPI y/y) — nedomýšlíme" }
        : {
            score: cbState.realYieldAdj > REAL_YIELD_DEADBAND ? 1 : cbState.realYieldAdj < -REAL_YIELD_DEADBAND ? -1 : 0,
            detail: `${cbState.realYieldAdj > 0 ? "+" : ""}${fmtNum(cbState.realYieldAdj)} vůči průměru koše`,
          },
    labor: trendComponent(extractUnemploymentHistory(currencyCode, windowed), { invert: true, unit: " %" }),
    growth: trendComponent(extractGrowthHistory(currencyCode, windowed), { unit: " %" }),
    demand: trendComponent(extractRetailSalesHistory(currencyCode, windowed), { unit: " %" }),
    pmi: pmiComponent(extractPmiHistory(currencyCode, windowed)),
  };

  const components = COMPONENT_DEFS.map((def) => ({ ...def, ...raw[def.key] }));
  const available = components.filter((c) => c.score !== null);

  const wmean = (list) => (list.length ? list.reduce((s, c) => s + c.weight * c.score, 0) / list.reduce((s, c) => s + c.weight, 0) : null);
  const index = available.length >= MIN_COMPONENTS ? round(wmean(available), 3) : null;
  const score = index === null ? null : round(index * SCORE_SCALE, 1);
  const activity = available.filter((c) => ["labor", "growth", "demand", "pmi"].includes(c.key));
  const activityIndex = activity.length >= 2 ? wmean(activity) : null;

  const dir = index === null || index === 0 ? 0 : Math.sign(index);
  const agreeing = dir === 0 ? [] : available.filter((c) => c.score === dir);
  const share = available.length ? agreeing.length / available.length : 0;
  const convictionStars = dir === 0 || index === null ? 0 : share >= 0.75 ? 3 : share >= 0.5 ? 2 : share >= 0.25 ? 1 : 0;

  const infl = extractInflationHistory(currencyCode, windowed);
  const lastInfl = infl[infl.length - 1];
  const target = CB_INFLATION_TARGET[currencyCode] ?? null;
  const inflation = lastInfl
    ? { value: lastInfl.value, target, gap: target === null ? null : round(lastInfl.value - target, 2), eventDay: lastInfl.eventDay }
    : null;

  return {
    modelVersion: STATE_MODEL_VERSION,
    currencyCode,
    asOfDay: day,
    windowMonths: WINDOW_MONTHS,
    components,
    availableCount: available.length,
    totalCount: components.length,
    index,
    score,
    band: bandFromIndex(index),
    activityScore: activityIndex === null ? null : round(activityIndex * SCORE_SCALE, 1),
    agreeCount: agreeing.length,
    convictionStars,
    convictionReasons: agreeing.map((c) => `${c.label}: ${c.detail}`),
    convictionLabel: convictionLabel(convictionStars, agreeing.length, available.length),
    inflation,
  };
}

export function convictionLabel(stars, agree, available) {
  const base = stars >= 3 ? "VYSOKÁ" : stars >= 2 ? "STŘEDNÍ" : "NÍZKÁ";
  return `${base} CONVICTION (${agree}/${available} SLOŽEK SOUHLASÍ)`;
}

// Pátek týdne (pondělí–neděle), do kterého `day` spadá — klíč týdenní historie indexu.
export function weekEndFriday(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // pondělí = 0
  d.setUTCDate(d.getUTCDate() + (4 - dow));
  return d.toISOString().slice(0, 10);
}

// Kompaktní tvar složek pro uložení do historie: { policy: 1, realYield: null, ... }
export function componentSigns(state) {
  return Object.fromEntries(state.components.map((c) => [c.key, c.score]));
}
