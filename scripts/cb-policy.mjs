// Politika centrální banky, real yield a "zaceněnost" — odvozeno z calendar_events (kategorie
// "Interest Rates"/"Inflation" z fundamental-scoring.mjs EVENT_RULES), BEZ jakéhokoli nového
// datového zdroje — adaptace extractCBRatesFromCalendar/extractCPIFromCalendar/
// autoDetectCBPolicy/getRealYieldScore/getCBPolicyScore z Fx-Analyzeru (engine.js).
// Čisté funkce, žádné I/O.

import { matchRule, eventDirection } from "./fundamental-scoring.mjs";

// Extrahuje historii skutečných sazbových rozhodnutí (kategorie "Interest Rates") pro danou
// měnu z calendar_events. Vrací chronologicky seřazené {date, rate}.
export function extractRateHistory(currencyCode, calendarEvents) {
  const history = [];
  for (const ev of calendarEvents) {
    if (ev.currency_code !== currencyCode || !ev.actual) continue;
    if (matchRule(ev.event_title)?.cat !== "Interest Rates") continue;
    // "MPC Official Bank Rate Votes" apod. — actual je hlasování ("7-2"), ne sazba.
    if (/votes?/i.test(ev.event_title || "")) continue;

    const raw = String(ev.actual).trim();
    if (!/^[<>~≈]?\s*-?\d+(\.\d+)?\s*%?$/.test(raw)) continue;
    const val = parseFloat(raw.replace(/^[<>~≈\s]+/, ""));
    if (Number.isNaN(val) || val < -1 || val > 25) continue;

    history.push({ date: ev.event_day, rate: val });
  }
  history.sort((a, b) => new Date(a.date) - new Date(b.date));
  return history;
}

// Poslední známá roční inflace (kategorie "Inflation"), preferuje YoY pojmenované eventy
// (m/m hodnota by rozbila real yield výpočet, který počítá s roční mírou).
export function extractLatestCpi(currencyCode, calendarEvents) {
  const inflationEvents = calendarEvents
    .filter((ev) => ev.currency_code === currencyCode && ev.actual && matchRule(ev.event_title)?.cat === "Inflation")
    .sort((a, b) => new Date(b.event_day) - new Date(a.event_day));

  const isYoY = (title) => /y\/?o\/?y|annual|year/i.test(title || "");
  const isMoM = (title) => /m\/?o\/?m|monthly/i.test(title || "");

  const candidate = inflationEvents.find((ev) => isYoY(ev.event_title)) ?? inflationEvents.find((ev) => !isMoM(ev.event_title));
  if (!candidate) return null;

  const val = parseFloat(candidate.actual);
  if (Number.isNaN(val) || val < -2 || val > 20) return null;
  return Math.round(val * 10) / 10;
}

// Detekuje hiking/cutting/hold cyklus ze skutečných změn sazby (min. 0.1 bps) — adaptace
// autoDetectCBPolicy. Vrací score -2..+2, label a confidence podle počtu skutečných rozhodnutí.
export function autoDetectPolicy(rateHistory) {
  if (!rateHistory || rateHistory.length < 2) {
    return { score: 0, label: "nedostatek dat", confidence: "LOW" };
  }

  const changes = [];
  for (let i = 1; i < rateHistory.length; i++) {
    const diff = rateHistory[i].rate - rateHistory[i - 1].rate;
    if (Math.abs(diff) >= 0.1) changes.push({ date: rateHistory[i].date, change: diff, rate: rateHistory[i].rate });
  }

  const recent = changes.slice(-6);
  const hikeCount = recent.filter((c) => c.change > 0).length;
  const cutCount = recent.filter((c) => c.change < 0).length;
  const lastChange = changes[changes.length - 1]?.change ?? 0;

  const now = Date.now();
  const yearAgo = rateHistory.filter((r) => new Date(r.date).getTime() > now - 365 * 86400000);
  const yearChange = yearAgo.length >= 2 ? yearAgo[yearAgo.length - 1].rate - yearAgo[0].rate : 0;

  const last6 = rateHistory.slice(-6);
  const holdCount = last6.filter((r, i) => i > 0 && Math.abs(r.rate - last6[i - 1].rate) < 0.1).length;

  let score = 0;
  let desc = "hold";
  if (hikeCount >= 3 || (hikeCount >= 2 && yearChange > 1.0)) {
    score = 2;
    desc = `agresivní hiking (${yearChange >= 0 ? "+" : ""}${yearChange.toFixed(2)} % za rok)`;
  } else if (hikeCount >= 2 && holdCount <= 2) {
    score = 2;
    desc = "aktivní cyklus hikování";
  } else if (hikeCount >= 1 && cutCount === 0 && holdCount <= 3) {
    score = 1;
    desc = "cyklus hikování";
  } else if (cutCount >= 3 || (cutCount >= 2 && yearChange < -1.0)) {
    score = -2;
    desc = `agresivní řezy (${yearChange.toFixed(2)} % za rok)`;
  } else if (cutCount >= 2 && hikeCount === 0) {
    score = -2;
    desc = "aktivní cyklus řezů";
  } else if (cutCount >= 1 && hikeCount === 0 && holdCount <= 3) {
    score = -1;
    desc = "cyklus snižování";
  } else if (holdCount >= 4 && Math.abs(yearChange) < 0.15) {
    score = 0;
    desc = `plateau, hold @ ${rateHistory[rateHistory.length - 1].rate.toFixed(2)} %`;
  } else if (lastChange > 0) {
    score = 1;
    desc = "poslední hike, pozorujeme";
  } else if (lastChange < 0) {
    score = -1;
    desc = "poslední cut, pozorujeme";
  }

  const confidence = changes.length >= 4 ? "HIGH" : changes.length >= 2 ? "MEDIUM" : "LOW";
  const currentRate = rateHistory[rateHistory.length - 1]?.rate;
  const label = `${desc}${currentRate !== undefined ? ` @ ${currentRate.toFixed(2)} %` : ""}`;
  return { score, label, confidence };
}

// Real yield (sazba - CPI) RELATIVNĚ k průměru ostatních měn v košíku — capnuto ±1.0
// (polovina originálních ±2 v Fx-Analyzeru, konzistentní s tím, že náš celý systém je na
// poloviční škále -5..+5).
export function computeRealYieldAdj(currencyCode, ratesByCode, cpiByCode) {
  const codes = Object.keys(ratesByCode);
  if (codes.length === 0 || !(currencyCode in ratesByCode)) return 0;

  const realYields = codes.map((c) => (ratesByCode[c] ?? 0) - (cpiByCode[c] ?? 2));
  const avg = realYields.reduce((a, b) => a + b, 0) / realYields.length;
  const ry = (ratesByCode[currencyCode] ?? 0) - (cpiByCode[currencyCode] ?? 2);

  return Math.round(Math.max(-1, Math.min(1, (ry - avg) * 0.175)) * 100) / 100;
}

// CB policy score RELATIVNĚ k průměru ostatních měn — capnuto ±0.75 (polovina originálních ±1.5).
export function computeCbPolicyAdj(currencyCode, policyScoresByCode) {
  const codes = Object.keys(policyScoresByCode);
  if (codes.length === 0) return 0;

  const avg = codes.reduce((sum, c) => sum + (policyScoresByCode[c] ?? 0), 0) / codes.length;
  const pol = policyScoresByCode[currencyCode] ?? 0;

  return Math.round(Math.max(-0.75, Math.min(0.75, (pol - avg) * 0.2)) * 100) / 100;
}

// "Zaceněnost" — jak moc trh nejnovější rozhodnutí čekal. Funguje pro VŠECHNY měny bez
// nového datového zdroje: poslední Interest Rate event má pole `estimate` (konsensus trhu
// PRO TENHLE meeting) — beat/miss na něm (nejvyšší váha v EVENT_RULES) JE fakticky
// "překvapilo/nepřekvapilo trh". Volající (fetch-calendar.mjs) může výsledek přepsat na
// metodu 'yield_gap' tam, kde má reálná tržní data (zatím jen USD, viz market-regime.mjs).
export function decisionConsensusPricedIn(currencyCode, calendarEvents, policyConfidence) {
  const lastDecision = calendarEvents
    .filter(
      (ev) =>
        ev.currency_code === currencyCode &&
        ev.actual &&
        ev.estimate &&
        matchRule(ev.event_title)?.cat === "Interest Rates"
    )
    .sort((a, b) => new Date(b.event_day) - new Date(a.event_day))[0];

  if (!lastDecision) {
    return { method: "decision_consensus", label: "žádné nedávné rozhodnutí k porovnání", confidenceLevel: "LOW" };
  }

  const dir = eventDirection(lastDecision);
  const label =
    dir === 0
      ? `poslední rozhodnutí (${lastDecision.event_title}) odpovídalo konsensu (${lastDecision.estimate})`
      : `poslední rozhodnutí (${lastDecision.event_title}) ${
          dir > 0 ? "překvapilo jestřábí stranou" : "překvapilo holubičí stranou"
        } vůči konsensu (${lastDecision.estimate})`;

  return { method: "decision_consensus", label, confidenceLevel: policyConfidence ?? "MEDIUM" };
}

/**
 * Hlavní orchestrátor — pro danou měnu spočítá kompletní CB-policy stav z calendar_events
 * VŠECH měn (potřeba pro relativní srovnání vůči průměru).
 * @param {string} currencyCode
 * @param {string[]} allCurrencyCodes
 * @param {Array} allCalendarEvents
 */
export function computeCbPolicyState(currencyCode, allCurrencyCodes, allCalendarEvents) {
  const ratesByCode = {};
  const cpiByCode = {};
  const policyByCode = {};
  const histories = {};

  for (const code of allCurrencyCodes) {
    const history = extractRateHistory(code, allCalendarEvents);
    histories[code] = history;
    if (history.length > 0) ratesByCode[code] = history[history.length - 1].rate;

    const cpi = extractLatestCpi(code, allCalendarEvents);
    if (cpi !== null) cpiByCode[code] = cpi;

    policyByCode[code] = autoDetectPolicy(history).score;
  }

  const policy = autoDetectPolicy(histories[currencyCode] ?? []);
  const realYieldAdj = computeRealYieldAdj(currencyCode, ratesByCode, cpiByCode);
  const cbPolicyAdj = computeCbPolicyAdj(currencyCode, policyByCode);
  const pricedIn = decisionConsensusPricedIn(currencyCode, allCalendarEvents, policy.confidence);

  return {
    rate: ratesByCode[currencyCode] ?? null,
    cpi: cpiByCode[currencyCode] ?? null,
    policyScore: policy.score,
    policyLabel: policy.label,
    policyConfidence: policy.confidence,
    realYieldAdj,
    cbPolicyAdj,
    pricedIn,
    rateHistory: histories[currencyCode] ?? [],
  };
}
