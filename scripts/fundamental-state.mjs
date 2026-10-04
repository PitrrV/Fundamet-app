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
// COT, retail sentiment, VIX ani cena do výpočtu NEVSTUPUJÍ. Inflace vstupuje jen nepřímo: složka
// Reálný výnos = sazba − CPI y/y (vůči průměru koše), vyšší inflace ji tedy snižuje.
import { computeCbPolicyState } from "./cb-policy.mjs";
import {
  extractUnemploymentHistory,
  extractGrowthHistory,
  extractRetailSalesHistory,
  extractPmiHistory,
  extractInflationHistory,
  isNationalEuroTitle,
  PMI_TITLES,
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
// Opravy dat a vyhlazení spotřeby — přepínače, aby šly otestovat v backtestu (scripts/
// research-lookback-backtest.mjs) PŘED nasazením. Produkce používá jen to, co je zapnuté ve
// STATE_OPTIONS_DEFAULT; výchozí hodnoty se mění až po ověření.
//  consistentGrowthUnit — HDP: série v JEDNÉ jednotce (q/q, jinak nejčastější), ne mix m/m a q/q (GBP)
//  completePmiMonths    — PMI: měsíc se počítá, jen když má všechny subindexy, které měna má (EUR: bez
//                         měsíce, kdy služby ještě nevyšly)
//  extraSeries          — AUD: Household Spending m/m jako spotřeba; NZD: BusinessNZ Manufacturing/Services Index jako PMI
//  smoothDemand         — spotřeba: průměr posledních 3 tisků vs. předchozích 3 místo jednotlivého tisku (m/m tržby jsou převážně šum)
export const STATE_OPTIONS_DEFAULT = Object.freeze({
  consistentGrowthUnit: false,
  completePmiMonths: false,
  extraSeries: false,
  smoothDemand: false,
});

const EXTRA_DEMAND_TITLE = { AUD: /^household spending m\/m$/i };
const EXTRA_PMI_TITLES = {
  NZD: { manufacturing: ["BusinessNZ Manufacturing Index"], services: ["BusinessNZ Services Index"] },
};

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


// HDP v JEDNÉ jednotce. Původní extractGrowthHistory slučuje tisky do skupin po 75 dnech ještě
// PŘED rozlišením jednotky, takže u GBP (měsíční m/m + čtvrtletní q/q) měsíční tisk vytlačí
// čtvrtletní a série míchá jednotky. Tady se nejdřív vybere jednotka (q/q, jinak ta s nejvíc tisky) a
// teprve potom se čtvrtletní vintages (Advance/Prelim/Final téhož kvartálu) sloučí na nejnovější.
const GDP_VINTAGE_WINDOW_DAYS = 75;
function growthHistoryConsistent(code, events) {
  const rows = events
    .filter((e) => e.currency_code === code && e.actual != null && /gdp/i.test(e.event_title || "") && !/price index/i.test(e.event_title) && !isNationalEuroTitle(e.event_title))
    .map((e) => ({
      value: parseFloat(e.actual),
      title: e.event_title,
      eventDay: e.event_day,
      unit: /m\/m/i.test(e.event_title) ? "pct_mom" : /q\/q/i.test(e.event_title) ? "pct_qoq" : /y\/y/i.test(e.event_title) ? "pct_yoy" : "pct",
    }))
    .filter((o) => !Number.isNaN(o.value) && o.value >= -20 && o.value <= 20)
    .sort((a, b) => (a.eventDay < b.eventDay ? -1 : 1));
  const collapse = (asc) => {
    const groups = [];
    let cur = [];
    for (const r of asc) {
      if (cur.length === 0 || (new Date(r.eventDay) - new Date(cur[0].eventDay)) / 86400000 <= GDP_VINTAGE_WINDOW_DAYS) cur.push(r);
      else {
        groups.push(cur);
        cur = [r];
      }
    }
    if (cur.length) groups.push(cur);
    return groups.map((g) => g[g.length - 1]);
  };
  const byUnit = new Map();
  for (const r of rows) {
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, []);
    byUnit.get(r.unit).push(r);
  }
  const series = new Map([...byUnit].map(([u, asc]) => [u, u === "pct_mom" ? asc : collapse(asc)])); // měsíční tisky nemají vintages
  const qoq = series.get("pct_qoq");
  if (qoq && qoq.length >= TREND_BASE_PRINTS + 1) return qoq;
  return [...series.values()].sort((a, b) => b.length - a.length)[0] ?? [];
}

// Trend po blocích: průměr posledních 3 tisků vs. průměr 3 tisků předtím, v jednotkách směrodatné
// odchylky rozdílu dvou 3-průměrů (sd · √(2/3)). Měsíční m/m tržby střídají znaménko, takže
// jednotlivý tisk skoro náhodně přepíná ±1; průměr po blocích takový šum potlačí. Potřebuje 6 tisků.
const BLOCK = 3;
const BLOCK_Z_THRESHOLD = 1.0; // z je tu t-podobná statistika (rozdíl v jednotkách své směrodatné chyby) — práh 1 SE, ne 0,5 sd
function blockTrendComponent(history, { invert = false, unit = "" } = {}) {
  const n = history.length;
  if (n < 2 * BLOCK) {
    return { score: null, detail: n === 0 ? "data nemáme" : `málo tisků (${n}) na určení trendu` };
  }
  const values = history.map((h) => h.value);
  const last = mean(values.slice(-BLOCK));
  const prev = mean(values.slice(-2 * BLOCK, -BLOCK));
  const z = (last - prev) / ((sd(values) || 1) * Math.sqrt(2 / BLOCK));
  let s = z >= BLOCK_Z_THRESHOLD ? 1 : z <= -BLOCK_Z_THRESHOLD ? -1 : 0;
  if (invert) s = -s;
  return { score: s === 0 ? 0 : s, detail: `průměr 3 posledních ${fmtNum(last)}${unit} (předchozí 3: ${fmtNum(prev)}${unit})` };
}

function demandHistory(code, events, opts) {
  let h = extractRetailSalesHistory(code, events);
  if (h.length === 0 && opts.extraSeries && EXTRA_DEMAND_TITLE[code]) {
    h = events
      .filter((e) => e.currency_code === code && e.actual != null && EXTRA_DEMAND_TITLE[code].test((e.event_title || "").trim()))
      .map((e) => ({ value: parseFloat(e.actual), title: e.event_title, eventDay: e.event_day }))
      .filter((o) => !Number.isNaN(o.value) && o.value >= -30 && o.value <= 30)
      .sort((a, b) => (a.eventDay < b.eventDay ? -1 : 1));
  }
  return h;
}

// PMI po měsících. Bez přepínačů = přesně původní extractPmiHistory.
function pmiHistoryState(code, events, opts) {
  if (!opts.completePmiMonths && !(opts.extraSeries && EXTRA_PMI_TITLES[code])) return extractPmiHistory(code, events);
  const cfg = opts.extraSeries && EXTRA_PMI_TITLES[code] ? EXTRA_PMI_TITLES[code] : PMI_TITLES[code];
  if (!cfg) return [];
  const rowsFor = (titles) =>
    titles.length === 0
      ? []
      : events
          .filter((e) => e.currency_code === code && e.actual != null && titles.includes(e.event_title) && !isNationalEuroTitle(e.event_title))
          .map((e) => ({ value: parseFloat(e.actual), title: e.event_title, eventDay: e.event_day }))
          .filter((o) => !Number.isNaN(o.value) && o.value >= 0 && o.value <= 100);
  const byMonth = new Map();
  for (const [cat, titles] of [["man", cfg.manufacturing], ["svc", cfg.services]]) {
    for (const r of rowsFor(titles)) {
      const m = r.eventDay.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, { man: [], svc: [] });
      byMonth.get(m)[cat].push(r);
    }
  }
  const required = [cfg.manufacturing.length > 0 ? "man" : null, cfg.services.length > 0 ? "svc" : null].filter(Boolean);
  const out = [];
  for (const m of [...byMonth.keys()].sort()) {
    const g = byMonth.get(m);
    if (opts.completePmiMonths && required.some((c) => g[c].length === 0)) continue;
    const all = [...g.man, ...g.svc];
    out.push({
      value: Math.round((all.reduce((a, r) => a + r.value, 0) / all.length) * 100) / 100,
      eventDay: all.map((r) => r.eventDay).sort().pop(),
      componentsUsed: all.length,
    });
  }
  return out;
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
 *   cb = už spočítaný computeCbPolicyState (produkce), jinak se spočítá z okna;
 *   options = přepínače oprav (viz STATE_OPTIONS_DEFAULT)
 */
export function computeFundamentalState(currencyCode, allCodes, events, { asOfDay, cb, options } = {}) {
  const opts = { ...STATE_OPTIONS_DEFAULT, ...(options ?? {}) };
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
    growth: trendComponent(
      opts.consistentGrowthUnit ? growthHistoryConsistent(currencyCode, windowed) : extractGrowthHistory(currencyCode, windowed),
      { unit: " %" }
    ),
    demand: (opts.smoothDemand ? blockTrendComponent : trendComponent)(demandHistory(currencyCode, windowed, opts), { unit: " %" }),
    pmi: pmiComponent(pmiHistoryState(currencyCode, windowed, opts)),
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
