// Fundamentální scoring engine — adaptace EVENT_RULES/eventDirection/eventRelevance/
// surpriseStrength/recency/confidence z FX Analyzeru (engine.js) na tenhle projekt.
// Čisté funkce, žádné I/O — vstup jsou řádky z calendar_events (DB), výstup číslo.

// Pořadí je záměrné: "Labor -Unemployment" MUSÍ být před "Labor +Jobs", protože
// "unemployment" obsahuje substring "employment" a naivní matching by jinak chytil
// špatné pravidlo (opačné znaménko) pro každý unemployment report.
// Přesně převzato z aktuálního engine.js (FX Analyzer) — dřívější verze tady vycházela ze
// zkrácené specifikace (FF_CALENDAR_INTEGRATION_SPEC.md), která pár klíčových frází vynechala
// (např. "deposit facility rate" — ForexFactory pojmenování ECB sazby by tak nikdy nespadlo
// do kategorie "Interest Rates" a real yield/CB policy pilíř by pro EUR neměl žádná data).
export const EVENT_RULES = [
  { cat: "Interest Rates", keys: ["interest rate", "rate decision", "rate statement", "funds rate", "policy rate", "bank rate", "deposit facility rate", "refinancing rate", "cash rate", "overnight rate", "main refinancing"], w: 3.5, dir: 1 },
  { cat: "Inflation", keys: ["cpi", "consumer price index", "inflation rate", "core inflation", "hicp", "pce", "personal consumption", "ppi", "producer price"], w: 3.0, dir: 1 },
  // Pořadí záměrné: "Labor -Unemployment" MUSÍ být před "Labor +Jobs" — "unemployment"
  // obsahuje jako substring "employment", takže by jinak vždy chytila +Jobs (dir:1) místo
  // správné -Unemployment (dir:-1) a engine by KAŽDÝ pokles nezaměstnanosti (bullish)
  // vykládal jako bearish miss a naopak.
  { cat: "Labor -Unemployment", keys: ["unemployment rate", "unemployment claims", "unemployment change", "jobless claims", "initial claims", "continuing claims", "claimant count"], w: 3.0, dir: -1 },
  { cat: "Labor +Jobs", keys: ["non-farm", "nonfarm", "payroll", "employment change", "employment", "adp", "average hourly earnings", "wage", "earnings"], w: 3.0, dir: 1 },
  { cat: "GDP", keys: ["gdp", "gross domestic product"], w: 2.2, dir: 1 },
  { cat: "PMI", keys: ["manufacturing pmi", "services pmi", "service pmi", "composite pmi", "pmi", "purchasing managers", "ism manufacturing", "ism services"], w: 1.8, dir: "pmi" },
  { cat: "Retail Sales", keys: ["retail sales"], w: 1.7, dir: 1 },
  { cat: "External Balance", keys: ["trade balance", "current account"], w: 1.0, dir: 1 },
  { cat: "Confidence", keys: ["consumer confidence", "business confidence", "sentiment", "zew", "ifo"], w: 1.0, dir: 1 },
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

// Historický backfill (viz commit "rozšíření CB Policy historie") zvedl počet relevantních
// eventů z řádově desítek (původní ~56denní okno) na stovky za rok. Neomezený součet přes
// celou historii pak u většiny měn narazil do ±10 stropu jen objemem dat, ne silou signálu —
// živě ověřeno (audit 2026-07-29): 7 z 8 měn saturovaných. Čtyři nezávislé pokusy omezit
// příspěvek PO KATEGORII (normalizace na maximum, top-N, průměr × zastropovaný počet, tvrdý
// strop na kategorii) tuhle saturaci opravily, ale všechny čtyři otočily znaménko u GBP
// (kategorie s NEJVÍC důkazy pro svůj směr dostávaly nejtvrdší zásah — ekonomicky obráceně).
// Prozatímní záplata (REFERENCE_EVENT_COUNT/dampingFactor, JEDEN kladný faktor na CELÝ
// součet) saturaci zmírnila, ale nezbavila se jí — druhý audit (2026-08-06) živě ověřil, že
// EUR/AUD/NZD zůstávaly saturované i s ní (rawScore přesně na ±10 stropu, nulová reakce na
// nové silné překvapení).
//
// Definitivní oprava (2026-08-06): VÁŽENÝ PRŮMĚR místo sumy — Σ(příspěvky)/Σ(vah) místo
// Σ(příspěvky)×tlumící faktor. Matematicky nemůže saturovat objemem dat (průměr ohraničených
// čísel je vždy ve stejném rozsahu jako ty čísla, bez ohledu na jejich počet) a pořád je to
// JEDEN kladný faktor na celý součet (dělení kladným Σ(vah) nikdy neotočí znaménko) — splňuje
// stejné omezení, které čtyři dřívější per-kategorie pokusy porušily.
const FUND_SCALE = 3; // přeškáluje vážený průměr (max ±1.6, viz surpriseStrength) na ±4.8 — strop je teď dosažitelný jen při skoro jednotném, silném signálu, ne objemem dat

export function matchRule(title) {
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

// Exponenciální rozpad místo dřívější schodovité funkce (1.8/1.4/1.0/0.7 na hranicích
// 90/180/365 dní). Schodovitá verze měla dvě vady, obě živě zachycené: (1) event, co
// PRÁVĚ překročil hranici (89 → 91 dní), skokově srazil skóre BEZ jediného nového datového
// bodu — to skóre dělá nepravdivé (vypadá jako reakce na novinku) a zbytečně spouští
// přegenerování narrativu; (2) události starší 365 dní zůstávaly navždy na plné 0.7 váze
// místo aby jejich vliv skutečně vyprchal. Poločas 45 dní: event dnes má stejnou špičkovou
// váhu jako dřív (1.8), ale odtud hladce mizí — v 45 dnech na polovinu, v 90 dnech na
// čtvrtinu, prakticky nulový po roce (~0.003×). Žádné skoky, žádná věčná podlaha.
const RECENCY_PEAK = 1.8;
const RECENCY_HALF_LIFE_DAYS = 45;

export function recency(daysAgo) {
  if (daysAgo < 0) return 0; // budoucí event by sem neměl dojít, ale pro jistotu
  return RECENCY_PEAK * Math.exp((-Math.LN2 * daysAgo) / RECENCY_HALF_LIFE_DAYS);
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
  let weightedSum = 0;
  let weightTotal = 0;

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

    // Váha (vždy kladná) a příspěvek (se znaménkem) se počítají zvlášť — dělíme jedním
    // druhým, ne sčítáme s tlumící konstantou (viz FUND_SCALE výš).
    const weight = rule.w * recency(daysAgo) * relevance.factor;
    weightedSum += dir * surpriseStrength(ev) * weight;
    weightTotal += weight;
  }

  // Vážený průměr dir×surpriseStrength je vždy v [-1.6, 1.6] bez ohledu na počet eventů
  // (surpriseStrength ∈ [1, 1.6], dir ∈ {-1,1}) — FUND_SCALE ho přeškáluje na ±4.8, takže
  // clamp tady je jen defenzivní pojistka, ne aktivní strop.
  const rawScore = weightTotal > 0 ? Math.max(-5, Math.min(5, (weightedSum / weightTotal) * FUND_SCALE)) : 0;
  const { confidence, historyMonths } = ffConfidence(relevant);
  const fundamentalScore = Math.round(Math.max(-5, Math.min(5, rawScore * confidence)) * 10) / 10;

  return {
    rawScore: Math.round(rawScore * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    fundamentalScore,
    historyMonths: Math.round(historyMonths * 10) / 10,
  };
}

// Nezávislý indikátor "možná se mění fundamentální režim" — NEBLENDUJE se do
// fundamentalScore, jen ho staví vedle sebe s krátkodobým přepočtem stejnou funkcí (žádná
// duplicitní logika kategorií/vah). 90 dní = jeden RECENCY_HALF_LIFE_DAYS (45) plus rezerva,
// tedy okno, kde recency() ještě dává eventům citelnou váhu (≥25 % špičky).
const REGIME_SHIFT_SHORT_TERM_DAYS = 90;
const REGIME_SHIFT_ALERT_THRESHOLD = 2.0; // na škále -5..5, stejná jako fundamentalScore

export function computeRegimeShift(currencyCode, calendarEvents, now = new Date()) {
  const longTerm = computeFundamentalScore(currencyCode, calendarEvents, now);

  const shortTermEvents = calendarEvents.filter((ev) => {
    const daysAgo = (now.getTime() - new Date(ev.event_day).getTime()) / 86400000;
    return daysAgo >= 0 && daysAgo <= REGIME_SHIFT_SHORT_TERM_DAYS;
  });
  const shortTerm = computeFundamentalScore(currencyCode, shortTermEvents, now);

  const divergence = Math.round((shortTerm.fundamentalScore - longTerm.fundamentalScore) * 10) / 10;
  const signFlip =
    Math.abs(longTerm.fundamentalScore) >= 0.5 &&
    Math.abs(shortTerm.fundamentalScore) >= 0.5 &&
    Math.sign(longTerm.fundamentalScore) !== Math.sign(shortTerm.fundamentalScore);
  const alert = signFlip || Math.abs(divergence) >= REGIME_SHIFT_ALERT_THRESHOLD;

  return {
    longTermScore: longTerm.fundamentalScore,
    shortTermScore: shortTerm.fundamentalScore,
    divergence,
    alert,
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
