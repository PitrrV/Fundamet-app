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
// nakoupený nahoru = medvědí signál pro skóre, a naopak. Prahy jsou v procentech "long z
// long+short", výstup -1..+1 přeškálovaný ×5 na naši -5..+5 škálu (stejnou jako cot_score).
function retailScoreFromRow(row) {
  if (row.nonrept_long === null || row.nonrept_short === null) return null;
  const total = row.nonrept_long + row.nonrept_short;
  if (total <= 0) return null;

  const pctLong = (row.nonrept_long / total) * 100;
  let raw;
  if (pctLong >= 80) raw = -1;
  else if (pctLong >= 70) raw = -0.5;
  else if (pctLong <= 20) raw = 1;
  else if (pctLong <= 30) raw = 0.5;
  else raw = 0;

  return { retailScore: Math.round(raw * 5 * 10) / 10, pctLong: Math.round(pctLong) };
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

  // rows[0] je nejnovější (CFTC API vrací DESC dle report_date).
  const retail = retailScoreFromRow(rows[0]);
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

  const { error: scoreErr } = await supabase
    .from("confluence_scores")
    .upsert(scoreRow, { onConflict: "currency_code,report_date" });

  if (scoreErr) {
    console.error(`[${label}] chyba upsertu confluence_scores:`, scoreErr.message);
    return { code: currency.code, ok: false };
  }

  console.log(
    `[${label}] OK — report_date=${result.reportDate} cot_score=${result.cotScore} zscore=${result.zscore} ` +
      `retail_score=${scoreRow.retail_score ?? "N/A"}${retail ? ` (${retail.pctLong}% long)` : ""} ` +
      `cot_percentile=${percentile ?? "N/A"}`
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

  // Neselhat tvrdě kvůli jednotlivým měnám (např. neověřený USD/ICE kontrakt) —
  // jen pokud selžou úplně všechny, je to signál skutečné poruchy (síť, auth).
  if (failed.length === results.length) {
    console.error("Všechny měny selhaly — pravděpodobně problém s API nebo databází.");
    process.exit(1);
  }
}

main();
