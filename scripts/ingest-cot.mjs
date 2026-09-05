// Stáhne poslední CFTC "Traders in Financial Futures" (Futures Only) data pro sledované
// měny, uloží raw historii do cot_reports a přepočítá confluence_scores.
// Spouští se z .github/workflows/ingest-cot.yml (cron) nebo ručně: node scripts/ingest-cot.mjs

import { createClient } from "@supabase/supabase-js";
import { computeCotScore, cotPercentile, cotPositioningLabel, convictionLabel, buildSummary } from "./scoring.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CFTC_APP_TOKEN = process.env.CFTC_APP_TOKEN; // volitelné, odstraňuje throttling

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const COT_DATASET_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";
const WEEKS_OF_HISTORY = 200; // ~4 roky, dost na trailing z-skóre okno + rezerva

async function fetchCotHistory(contractCode) {
  const params = new URLSearchParams({
    cftc_contract_market_code: contractCode,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: String(WEEKS_OF_HISTORY),
  });
  const headers = CFTC_APP_TOKEN ? { "X-App-Token": CFTC_APP_TOKEN } : {};

  const res = await fetch(`${COT_DATASET_URL}?${params}`, { headers });
  if (!res.ok) {
    throw new Error(`CFTC API vrátilo ${res.status} pro kontrakt ${contractCode}`);
  }
  return res.json();
}

function toRow(currencyCode, apiRow) {
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    currency_code: currencyCode,
    report_date: apiRow.report_date_as_yyyy_mm_dd?.slice(0, 10),
    report_type: "TFF_FUT",
    open_interest_all: num(apiRow.open_interest_all),
    dealer_long: num(apiRow.dealer_positions_long_all),
    dealer_short: num(apiRow.dealer_positions_short_all),
    dealer_spread: num(apiRow.dealer_positions_spread_all),
    asset_mgr_long: num(apiRow.asset_mgr_positions_long),
    asset_mgr_short: num(apiRow.asset_mgr_positions_short),
    asset_mgr_spread: num(apiRow.asset_mgr_positions_spread),
    lev_money_long: num(apiRow.lev_money_positions_long),
    lev_money_short: num(apiRow.lev_money_positions_short),
    lev_money_spread: num(apiRow.lev_money_positions_spread),
    other_rept_long: num(apiRow.other_rept_positions_long),
    other_rept_short: num(apiRow.other_rept_positions_short),
    other_rept_spread: num(apiRow.other_rept_positions_spread),
    // Non-reportable = malí spekulanti = retail traders. Stejný TFF report jako COT,
    // žádné extra volání — jen jsme to pole dřív neukládali.
    nonrept_long: num(apiRow.nonrept_positions_long_all),
    nonrept_short: num(apiRow.nonrept_positions_short_all),
    raw: apiRow,
  };
}

// Kontrariánské skóre retail pozicování (vzor getSentimentScore z Fx-Analyzeru): retail dav
// nakoupený nahoru = medvědí signál pro skóre, a naopak.
//
// Post-audit oprava F (5.9.2026): pilíř dřív používal FIXNÍ absolutní prahy (≤20/30, ≥70/80 %)
// stejné napříč všemi měnami — dvoufázová analýza (nejdřív změřit, pak rozhodnout, ŽÁDNÁ
// implementace naslepo) na 4 letech historie (207 týdnů, cot_reports od 2022) ukázala:
// (1) není to problém dat — 0 chybějících hodnot; (2) krajní pásmo (≤20/≥80, nejsilnější
// signál ±5) se NESTALO ANI JEDNOU za 4 roky u ŽÁDNÉ měny — mrtvý kód; (3) jednotlivé měny mají
// trvale jinou "nulovou hladinu" (EUR 53-72 %, CHF 20-58 % dlouhodobě) — fixní absolutní
// procento proto bylo nefér: CAD/JPY 0% aktivace za 4 roky, CHF 15 %. Zúžení na jinou fixní
// hranici (např. 40/60) tenhle problém neřeší, jen ho přesouvá (simulace: AUD/CHF/USD by
// naopak byly nenulové PRAKTICKY VŽDY se STEJNOU hodnotou — degeneruje na statickou konstantu
// bez týdenní informace).
//
// Řešení: currency-relative percentil (stejná konvence jako cot_percentile u COT pilíře) —
// "je současné pozicování extrémní vzhledem k tomu, co je pro TUHLE měnu normální", ne vzhledem
// k univerzálnímu číslu. Okno je EXPANDING (celá historie DO tohoto týdne, ne rolling 52/104) —
// simulace ukázala, že strukturální posun jednotlivých měn je přes 4 roky velmi setrvalý,
// rolling okno by jen přidalo další nezpětně otestovaný hyperparametr (proč zrovna 52 týdnů?).
// Vyžaduje aspoň RETAIL_MIN_HISTORY_WEEKS předchozích týdnů, jinak appka o "co je normální pro
// tuhle měnu" neví dost — vrátí null (appka pilíř pro tenhle týden vynechá, nic si nedomýšlí).
//
// Mapování percentilu na skóre (symetrické, předem dané — NE vybírané podle toho, co dá víc
// signálů): p≤10 → +5, p∈(10,25] → +2,5, p∈[75,90) → −2,5, p≥90 → −5, jinak 0. Stejná výsledná
// škála −5..+5 jako dřív, jen jinak kalibrovaný vstup.
const RETAIL_MIN_HISTORY_WEEKS = 20;

/**
 * @param {Array<{report_date: string, pctLong: number}>} historyAsc - vzestupně podle data,
 *   poslední prvek = aktuální týden. Musí obsahovat i historii, ne jen aktuální řádek.
 */
function retailScoreFromHistory(historyAsc) {
  if (historyAsc.length === 0) return null;
  const latest = historyAsc[historyAsc.length - 1];
  const prior = historyAsc.slice(0, -1);
  if (prior.length < RETAIL_MIN_HISTORY_WEEKS) return null;

  const leCount = prior.filter((r) => r.pctLong <= latest.pctLong).length;
  const percentileRank = (100 * leCount) / prior.length;

  let raw;
  if (percentileRank <= 10) raw = 1;
  else if (percentileRank <= 25) raw = 0.5;
  else if (percentileRank >= 90) raw = -1;
  else if (percentileRank >= 75) raw = -0.5;
  else raw = 0;

  return {
    retailScore: Math.round(raw * 5 * 10) / 10,
    pctLong: Math.round(latest.pctLong),
    percentileRank: Math.round(percentileRank * 10) / 10,
  };
}

async function processCurrency(currency) {
  const label = `${currency.code} (${currency.cftc_contract_market_code})`;
  let apiRows;
  try {
    apiRows = await fetchCotHistory(currency.cftc_contract_market_code);
  } catch (err) {
    console.error(`[${label}] chyba stažení z CFTC API:`, err.message);
    return { code: currency.code, ok: false };
  }

  if (!Array.isArray(apiRows) || apiRows.length === 0) {
    console.warn(`[${label}] CFTC API vrátilo 0 řádků — kontrakt/kód pravděpodobně neplatný, přeskočeno.`);
    return { code: currency.code, ok: false };
  }

  const rows = apiRows
    .map((r) => toRow(currency.code, r))
    .filter((r) => r.report_date && r.lev_money_long !== null && r.lev_money_short !== null);

  if (rows.length === 0) {
    console.warn(`[${label}] Po zpracování nezbyly žádné použitelné řádky — zkontrolovat mapování polí.`);
    console.warn(`[${label}] Ukázka syrové odpovědi:`, JSON.stringify(apiRows[0]));
    return { code: currency.code, ok: false };
  }

  const { error: upsertErr } = await supabase
    .from("cot_reports")
    .upsert(rows, { onConflict: "currency_code,report_date,report_type" });

  if (upsertErr) {
    console.error(`[${label}] chyba upsertu cot_reports:`, upsertErr.message);
    return { code: currency.code, ok: false };
  }

  // Historie vzestupně podle data pro scoring
  const historyAsc = rows
    .map((r) => ({ report_date: r.report_date, lev_money_net: r.lev_money_long - r.lev_money_short }))
    .sort((a, b) => a.report_date.localeCompare(b.report_date));

  const result = computeCotScore(historyAsc);
  if (!result) {
    console.warn(`[${label}] Nedostatek dat pro výpočet skóre.`);
    return { code: currency.code, ok: false };
  }

  // Historie pctLong vzestupně podle data, pro currency-relative percentil (viz
  // retailScoreFromHistory výš) — stejný zdroj (`rows`, čerstvě stažený z CFTC) jako historyAsc
  // pro cot_score, jen filtrovaný na nonrept_long/short místo lev_money_long/short.
  const retailHistoryAsc = rows
    .map((r) => {
      if (r.nonrept_long === null || r.nonrept_short === null) return null;
      const total = r.nonrept_long + r.nonrept_short;
      if (total <= 0) return null;
      return { report_date: r.report_date, pctLong: (r.nonrept_long / total) * 100 };
    })
    .filter((r) => r !== null)
    .sort((a, b) => a.report_date.localeCompare(b.report_date));

  const retail = retailScoreFromHistory(retailHistoryAsc);
  const percentile = cotPercentile(historyAsc);

  const positioningLabel = cotPositioningLabel(result.zscore);
  const scoreRow = {
    currency_code: currency.code,
    report_date: result.reportDate,
    lev_money_net: result.levMoneyNet,
    cot_zscore: result.zscore,
    cot_wow_change: result.wowChange,
    cot_4w_change: result.change4w,
    cot_score: result.cotScore,
    overall_score: result.cotScore, // přepočítá fetch-calendar.mjs (blend přes všechny pilíře)
    retail_score: retail?.retailScore ?? null,
    cot_percentile: percentile,
    data_tier: "cot_only",
    conviction_label: convictionLabel(result.cotScore),
    cot_positioning_label: positioningLabel,
    summary: buildSummary({
      levMoneyNet: result.levMoneyNet,
      zscore: result.zscore,
      wowChange: result.wowChange,
      positioningLabel,
    }),
  };

  // Pojistka proti "kruhovému" resetu skóre: tenhle upsert běží i v pondělní 14:00 UTC
  // pojistce pro svátky posunuté vydání (viz ingest-cot.yml), která typicky trefí STEJNÝ
  // report_date, co už sobotní běh — a bez týhle kontroly by přepsala overall_score/data_tier
  // zpátky na syrové "jen COT" hodnoty, i když fetch-calendar.mjs mezitím řádek už dávno
  // nablendoval přes všechny pilíře. Appka pak na pár minut (do dalšího 15minutového cronu)
  // ukazuje všem 8 měnám najednou jiné, nesprávné skóre — živě nahlášeno uživatelem 10.8.2026.
  // Když už existující řádek NENÍ 'cot_only' (=byl nablendovaný), zachovej jeho overall_score
  // a conviction pole — jen COT-specifická pole (cot_score, zscore, retail_score, ...) se smí
  // přepsat čerstvými daty.
  const { data: existingRow } = await supabase
    .from("confluence_scores")
    .select("overall_score, data_tier, conviction_stars, conviction_reasons, conviction_label")
    .eq("currency_code", currency.code)
    .eq("report_date", result.reportDate)
    .limit(1);

  const existing = existingRow?.[0];
  if (existing && existing.data_tier !== "cot_only") {
    scoreRow.overall_score = existing.overall_score;
    scoreRow.data_tier = existing.data_tier;
    scoreRow.conviction_stars = existing.conviction_stars;
    scoreRow.conviction_reasons = existing.conviction_reasons;
    scoreRow.conviction_label = existing.conviction_label;
  }

  const { error: scoreErr } = await supabase
    .from("confluence_scores")
    .upsert(scoreRow, { onConflict: "currency_code,report_date" });

  if (scoreErr) {
    console.error(`[${label}] chyba upsertu confluence_scores:`, scoreErr.message);
    return { code: currency.code, ok: false };
  }

  console.log(
    `[${label}] OK — report_date=${result.reportDate} cot_score=${result.cotScore} zscore=${result.zscore} ` +
      `retail_score=${scoreRow.retail_score ?? "N/A"}${retail ? ` (${retail.pctLong}% long, ${retail.percentileRank}. percentil)` : ""} ` +
      `cot_percentile=${percentile ?? "N/A"}` +
      (existing && existing.data_tier !== "cot_only"
        ? ` (overall_score ${existing.overall_score} zachováno — už bylo nablendované)`
        : "")
  );
  return { code: currency.code, ok: true };
}

async function healthCheck() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    console.log(`Health check: HTTP ${res.status} ${res.statusText}`);
    if (!res.ok) {
      console.log("Tělo odpovědi:", await res.text());
    }
  } catch (err) {
    console.error("Health check selhal:", err.message);
    let cause = err.cause;
    let depth = 0;
    while (cause && depth < 5) {
      console.error(`  příčina[${depth}]:`, cause.code ?? cause.message ?? cause);
      cause = cause.cause;
      depth++;
    }
  }
}

// Po dokončení ingestu okamžitě odpálí fetch-calendar.yml, aby se nablendované overall_score
// (přes fundament/CB politiku/retail/risk pilíře) obnovilo co nejdřív — jinak by appka až do
// dalšího 15minutového cronu ukazovala syrové "jen COT" skóre všem měnám najednou (viz komentář
// u zachování existujícího overall_score výš). Stejný vzor jako triggerNarrativeRegeneration
// ve fetch-calendar.mjs. Nekritické — bez GITHUB_TOKEN/GITHUB_REPOSITORY/GITHUB_REF_NAME (mimo
// Actions, např. lokální spuštění) se jen přeskočí.
async function triggerFetchCalendarRecompute() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF_NAME;

  if (!token || !repo || !ref) {
    console.warn("Přeskakuji okamžitý trigger fetch-calendar.yml — chybí GITHUB_TOKEN/GITHUB_REPOSITORY/GITHUB_REF_NAME.");
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/fetch-calendar.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref, inputs: {} }),
    });
    if (res.ok) {
      console.log("Spuštěn okamžitý fetch-calendar.yml (obnova nablendovaného overall_score po COT ingestu).");
    } else {
      console.error(`Nepodařilo se spustit fetch-calendar.yml: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("Trigger fetch-calendar.yml selhal:", err.message);
  }
}

async function main() {
  console.log(`Připojuji se na Supabase URL: "${SUPABASE_URL}" (délka service key: ${SUPABASE_SERVICE_KEY.length} znaků)`);
  await healthCheck();

  const { data: currencies, error } = await supabase
    .from("currencies")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("Nepodařilo se načíst tabulku currencies:", error.message);
    if (error.cause) console.error("Příčina:", error.cause);
    process.exit(1);
  }

  if (!currencies || currencies.length === 0) {
    console.error("Tabulka currencies je prázdná — spusťte nejdřív supabase/schema.sql.");
    process.exit(1);
  }

  const results = [];
  for (const currency of currencies) {
    results.push(await processCurrency(currency));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nHotovo: ${results.length - failed.length}/${results.length} měn úspěšně zpracováno.`);
  if (failed.length > 0) {
    console.warn(`Neúspěšné: ${failed.map((f) => f.code).join(", ")}`);
  }

  if (results.some((r) => r.ok)) {
    await triggerFetchCalendarRecompute();
  }

  // Neselhat tvrdě kvůli jednotlivým měnám (např. neověřený USD/ICE kontrakt) —
  // jen pokud selžou úplně všechny, je to signál skutečné poruchy (síť, auth).
  if (failed.length === results.length) {
    console.error("Všechny měny selhaly — pravděpodobně problém s API nebo databází.");
    process.exit(1);
  }
}

main();
