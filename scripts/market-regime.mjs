// Risk-on/risk-off režim ze SKUTEČNÝCH dat (VIX), ne ruční přepínač jako v původním
// Fx-Analyzeru (`g_riskSentiment` tam byl UI toggle). Zdroj: FRED (Federal Reserve Economic
// Data) — CSV bez API klíče, ověřeno živě přes GitHub Actions (viz commit historie), funguje
// spolehlivě i pro US 2Y výnos (DGS2), který se používá jako "zaceněnost" proxy pro USD v
// cb-policy.mjs. Jediné I/O v tomhle souboru je fetch samotný — klasifikace/škálování jsou
// čisté funkce testovatelné bez sítě.

const FRED_CSV_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";

// currency-map korekce (vzor getRiskSentimentAdj z Fx-Analyzeru), capnuto ±0.5 — polovina
// originálních ±1.0/1.2, konzistentní s tím, že náš systém je na poloviční škále -5..+5.
// USD/EUR/GBP nejsou v mapě záměrně — v originále taky nemají výraznou risk-on/off charakteristiku.
const RISK_ON_MAP = { AUD: 0.4, NZD: 0.35, CAD: 0.25, JPY: -0.25, CHF: -0.15 };
const RISK_OFF_MAP = { AUD: -0.5, NZD: -0.5, CAD: -0.3, JPY: 0.5, CHF: 0.5 };

export async function fetchFredSeries(seriesId) {
  const res = await fetch(`${FRED_CSV_BASE}${seriesId}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`FRED vrátilo HTTP ${res.status} pro sérii ${seriesId}`);

  const text = await res.text();
  const lines = text.trim().split("\n").slice(1); // přeskočit hlavičku "observation_date,<ID>"
  const rows = [];
  for (const line of lines) {
    const [date, rawValue] = line.split(",");
    const value = parseFloat(rawValue);
    if (date && !Number.isNaN(value)) rows.push({ date, value });
  }
  return rows; // chronologicky vzestupně (FRED to tak vrací)
}

// VIX úroveň + 5denní změna → risk-on/neutral/risk-off. Prahy jsou editorská volba (běžná
// tržní konvence <15 klid, >20 zvýšené obavy), NE zpětně testované — stejně jako zbytek systému.
export function classifyRegime(vixRows) {
  if (!vixRows || vixRows.length < 6) return null;

  const latest = vixRows[vixRows.length - 1];
  const fiveDaysAgo = vixRows[vixRows.length - 6];
  const change5d = latest.value - fiveDaysAgo.value;
  const pctChange5d = fiveDaysAgo.value > 0 ? (change5d / fiveDaysAgo.value) * 100 : 0;

  let regime = "NEUTRAL";
  if (latest.value > 20 || pctChange5d > 15) regime = "RISK_OFF";
  else if (latest.value < 15 && pctChange5d < 5) regime = "RISK_ON";

  return {
    vix: Math.round(latest.value * 100) / 100,
    vix5dChange: Math.round(change5d * 100) / 100,
    regime,
  };
}

export function riskAdjForCurrency(currencyCode, regime) {
  if (regime === "RISK_ON") return RISK_ON_MAP[currencyCode] ?? 0;
  if (regime === "RISK_OFF") return RISK_OFF_MAP[currencyCode] ?? 0;
  return 0;
}

// 2Y výnos vs. aktuální politická sazba = market-implied path (viz cb-policy.mjs docs) —
// zatím jen pro USD (FRED DGS2 ověřeno, ostatní G10 nemají na FRED spolehlivé denní 2Y řady).
// Pokud fetch selže, volající prostě zůstane u decision_consensus metody — žádný tvrdý pád.
export function yieldGapPricedIn(twoYearYield, policyRate) {
  if (twoYearYield === null || policyRate === null) return null;
  const gap = Math.round((twoYearYield - policyRate) * 100) / 100;
  const label =
    gap > 0.15
      ? `2Y výnos (${twoYearYield.toFixed(2)} %) nad politickou sazbou (${policyRate.toFixed(2)} %) — trh cení další hiky`
      : gap < -0.15
        ? `2Y výnos (${twoYearYield.toFixed(2)} %) pod politickou sazbou (${policyRate.toFixed(2)} %) — trh cení řezy`
        : `2Y výnos (${twoYearYield.toFixed(2)} %) blízko politické sazby (${policyRate.toFixed(2)} %) — trh cení víceméně status quo`;

  return { method: "yield_gap", label, confidenceLevel: "HIGH", gap };
}

/**
 * Hlavní orchestrátor — fetchne VIX i US 2Y výnos z FRED, vrátí kompletní market regime stav.
 * Nehází chybu ven — při selhání fetch (síť/FRED výpadek) vrátí regime:null a volající
 * (fetch-calendar.mjs) pilíř pro tenhle běh prostě vynechá, ne že by shodil celý cron.
 */
export async function computeMarketRegime() {
  let vixRows = null;
  let dgs2Rows = null;

  try {
    vixRows = await fetchFredSeries("VIXCLS");
  } catch (err) {
    console.error("FRED VIXCLS fetch selhal:", err.message);
  }

  try {
    dgs2Rows = await fetchFredSeries("DGS2");
  } catch (err) {
    console.error("FRED DGS2 fetch selhal:", err.message);
  }

  const regimeInfo = vixRows ? classifyRegime(vixRows) : null;
  const usd2yYield = dgs2Rows && dgs2Rows.length > 0 ? dgs2Rows[dgs2Rows.length - 1].value : null;

  return { regimeInfo, usd2yYield };
}
