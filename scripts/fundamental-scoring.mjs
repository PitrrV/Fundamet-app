// Fundamentální scoring engine — adaptace EVENT_RULES/eventDirection/eventRelevance/
// surpriseStrength/recency/confidence z FX Analyzeru (engine.js) na tenhle projekt.
// Čisté funkce, žádné I/O — vstup jsou řádky z calendar_events (DB), výstup číslo.

// Pořadí je záměrné: "Labor -Unemployment" MUSÍ být před "Labor +Jobs", protože
// "unemployment" obsahuje substring "employment" a naivní matching by jinak chytil
// špatné pravidlo (opačné znaménko) pro každý unemployment report.
export const EVENT_RULES = [
  { cat: "Interest Rates", keys: ["interest rate", "rate decision", "rate statement", "funds rate", "bank rate", "cash rate", "refi rate"], w: 3.5, dir: 1 },
  { cat: "Inflation", keys: ["cpi", "consumer price index", "inflation rate", "core inflation", "hicp", "pce", "ppi", "producer price"], w: 3.0, dir: 1 },
  { cat: "Labor -Unemployment", keys: ["unemployment rate", "unemployment claims", "jobless claims", "claimant count"], w: 3.0, dir: -1 },
  { cat: "Labor +Jobs", keys: ["non-farm", "nonfarm", "payroll", "employment change", "adp", "wage", "earnings"], w: 3.0, dir: 1 },
  { cat: "GDP", keys: ["gdp", "gross domestic product"], w: 2.2, dir: 1 },
  { cat: "PMI", keys: ["manufacturing pmi", "services pmi", "composite pmi", "ism"], w: 1.8, dir: "pmi" },
  { cat: "Retail Sales", keys: ["retail sales"], w: 1.7, dir: 1 },
  { cat: "External Balance", keys: ["trade balance", "current account"], w: 1.0, dir: 1 },
  { cat: "Confidence", keys: ["consumer confidence", "business confidence", "zew", "ifo"], w: 1.0, dir: 1 },
];

const INDIRECT_MAP = {
  AUD: ["CNY"],
  NZD: ["CNY"],
  CAD: ["USD"],
  CHF: ["USD"],
};
const INDIRECT_FACTOR = 0.45;

const FF_CONF_MONTHS = 15;
const FF_FUND_DAMP = 0.4;

function matchRule(title) {
  const lower = (title || "").toLowerCase();
  return EVENT_RULES.find((rule) => rule.keys.some((k) => lower.includes(k))) ?? null;
}

export function getWeight(title) {
  return matchRule(title)?.w ?? 0;
}

function parseNum(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return parseFloat(String(value).replace(",", "."));
}

export function eventDirection(ev, rule) {
  rule = rule ?? matchRule(ev.event_title);
  if (!rule) return 0;
  const a = parseNum(ev.actual);
  const e = parseNum(ev.estimate);
  if (Number.isNaN(a) || Number.isNaN(e)) return 0;

  if (rule.dir === "pmi") {
    if (a >= 50 && e < 50) return 1;
    if (a < 50 && e >= 50) return -1;
    if (a > e) return 1;
    if (a < e) return -1;
    const prev = parseNum(ev.previous);
    if (!Number.isNaN(prev)) {
      if (a > prev) return 1;
      if (a < prev) return -1;
    }
    return 0;
  }

  let dir = a > e ? 1 : a < e ? -1 : 0;
  if (rule.dir === -1) dir *= -1;
  return dir;
}

export function surpriseStrength(ev) {
  const a = parseNum(ev.actual);
  const e = parseNum(ev.estimate);
  if (Number.isNaN(a) || Number.isNaN(e)) return 1;
  return 1 + Math.min(0.6, (Math.abs(a - e) / Math.max(Math.abs(e), 1)) * 8);
}

export function recency(daysAgo) {
  if (daysAgo <= 90) return 1.8;
  if (daysAgo <= 180) return 1.4;
  if (daysAgo <= 365) return 1.0;
  return 0.7;
}

export function eventRelevance(currencyCode, ev) {
  if (ev.currency_code === currencyCode) return { type: "direct", factor: 1 };
  if ((INDIRECT_MAP[currencyCode] ?? []).includes(ev.currency_code)) {
    return { type: "indirect", factor: INDIRECT_FACTOR };
  }
  return null;
}

function historySpanMonths(events) {
  if (events.length < 2) return 0;
  const times = events.map((e) => new Date(e.event_day).getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400000;
  return spanDays / 30;
}

export function ffConfidence(relevantEvents) {
  const months = historySpanMonths(relevantEvents);
  const frac = Math.max(0, Math.min(1, months / FF_CONF_MONTHS));
  return { confidence: FF_FUND_DAMP + (1 - FF_FUND_DAMP) * frac, historyMonths: months };
}

/**
 * @param {string} currencyCode
 * @param {Array} calendarEvents - řádky z calendar_events (libovolné měny, filtrujeme tady)
 * @param {Date} now
 */
export function computeFundamentalScore(currencyCode, calendarEvents, now = new Date()) {
  const relevant = [];
  let rawSum = 0;

  for (const ev of calendarEvents) {
    const relevance = eventRelevance(currencyCode, ev);
    if (!relevance) continue;
    if (!ev.actual || !ev.estimate) continue;

    const rule = matchRule(ev.event_title);
    if (!rule || rule.w === 0) continue;

    relevant.push(ev);

    const dir = eventDirection(ev, rule);
    if (dir === 0) continue;

    const daysAgo = (now.getTime() - new Date(ev.event_day).getTime()) / 86400000;
    if (daysAgo < 0) continue; // budoucí event bez actual by sem neměl dojít, ale pro jistotu

    const contribution = dir * rule.w * surpriseStrength(ev) * recency(daysAgo) * relevance.factor;
    rawSum += contribution;
  }

  const rawScore = Math.max(-10, Math.min(10, rawSum));
  const { confidence, historyMonths } = ffConfidence(relevant);
  const scaledRaw = rawScore / 2; // -10..10 -> -5..5, stejný rozsah jako cot_score
  const fundamentalScore = Math.round(Math.max(-5, Math.min(5, scaledRaw * confidence)) * 10) / 10;

  return {
    rawScore: Math.round(scaledRaw * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    fundamentalScore,
    historyMonths: Math.round(historyMonths * 10) / 10,
  };
}

/**
 * Vážený průměr směru posledních 6 výskytů stejného typu události pro danou měnu.
 * @param {string} eventTitle
 * @param {string} currencyCode
 * @param {Array} calendarEvents
 */
export function getEventHistoryTrend(eventTitle, currencyCode, calendarEvents) {
  const keyword = (eventTitle || "").toLowerCase().split(" ")[0];
  if (!keyword) return { trend: "neutrální", sample: 0 };

  const history = calendarEvents
    .filter((e) => {
      const relevance = eventRelevance(currencyCode, e);
      return relevance && e.event_title.toLowerCase().includes(keyword) && e.actual && e.estimate;
    })
    .sort((a, b) => new Date(b.event_day).getTime() - new Date(a.event_day).getTime())
    .slice(0, 6);

  if (history.length === 0) return { trend: "neutrální", sample: 0 };

  let weightedSum = 0;
  let weightTotal = 0;
  history.forEach((ev, idx) => {
    const relevance = eventRelevance(currencyCode, ev);
    const weight = (history.length - idx) * relevance.factor;
    weightedSum += eventDirection(ev) * weight;
    weightTotal += weight;
  });

  const normalized = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const trend = normalized > 0.25 ? "pozitivní" : normalized < -0.25 ? "negativní" : "neutrální";
  return { trend, normalized: Math.round(normalized * 100) / 100, sample: history.length };
}
