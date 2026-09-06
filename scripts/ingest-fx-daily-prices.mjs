// Historické denní close ceny — POUZE sběr dat, žádné skóre, žádné UI, žádný signál,
// žádný backtest (ten je samostatný další krok, po tomhle ingestu).
//
// Zdroj: veřejně čitelný data/fx_daily/{PAIR}.json z https://github.com/PitrrV/Fx-Analyzer
// (appka tam má vlastní denní cron proti Stooq, fallback Yahoo Finance — viz technický
// audit 5.9.2026). Fundamet-app tenhle soubor jen ČTE přes raw.githubusercontent — žádný
// nový cenový provider, žádné nové API klíče.
//
// Druhá polovina rovnice pro budoucí backtest "Retail Δ24H → následující denní return" —
// retail_sentiment_intraday (ingest-retail-intraday.mjs) je první polovina. Obě tabulky
// jsou nezávislé archivy, žádná nevstupuje do overall_score/BLEND_WEIGHTS/conviction.
//
// Spouští se z .github/workflows/ingest-fx-daily-prices.yml (cron denně) nebo ručně:
// node scripts/ingest-fx-daily-prices.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SOURCE_BASE = "https://raw.githubusercontent.com/PitrrV/Fx-Analyzer/main/data/fx_daily";
// Stejných 28 párů jako STANDARD_PAIRS ve Fx-Analyzeru (scripts/fetch-seasonality-daily.js) —
// appka tam sama nemá víc než tohle, není co dalšího přidat.
const PAIRS = [
  "EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP",
  "EURCHF", "EURAUD", "EURCAD", "EURJPY", "EURNZD", "GBPCHF", "GBPJPY", "GBPAUD",
  "GBPCAD", "GBPNZD", "AUDCAD", "AUDJPY", "AUDNZD", "AUDCHF", "NZDCAD", "NZDJPY",
  "NZDCHF", "CADJPY", "CADCHF", "CHFJPY",
];
const INSERT_CHUNK_SIZE = 1000;
// Fx-Analyzer má cron na tohle jednou denně (03:00 UTC) — pokud appka déle nevidí novější
// den, než tohle, zdroj pravděpodobně přestal aktualizovat (appka to jen zaloguje).
const STALE_AFTER_MS = 48 * 60 * 60 * 1000; // 48 h (denní + víkendová rezerva)

function validatePair(json, expectedPair) {
  const problems = [];
  if (!json || typeof json !== "object") return { ok: false, problems: ["odpověď není objekt"] };
  if (json.pair !== expectedPair) problems.push(`pole pair=${json.pair} neodpovídá očekávanému ${expectedPair}`);
  if (!Array.isArray(json.dates) || !Array.isArray(json.closes)) {
    return { ok: false, problems: ["chybí pole dates/closes"] };
  }
  if (json.dates.length !== json.closes.length) {
    return { ok: false, problems: [`dates.length=${json.dates.length} != closes.length=${json.closes.length}`] };
  }
  return { ok: problems.length === 0, problems };
}

function validateRow(dateStr, close, now) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { ok: false, reason: `neplatné datum: ${JSON.stringify(dateStr)}` };
  const d = new Date(dateStr + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return { ok: false, reason: `neparsovatelné datum: ${dateStr}` };
  if (d.getTime() > now.getTime()) return { ok: false, reason: `datum v budoucnosti: ${dateStr}` };
  const num = Number(close);
  if (!Number.isFinite(num) || num <= 0) return { ok: false, reason: `close=${close} není kladné číslo` };
  return { ok: true, close: num };
}

async function ingestPair(pair, now) {
  const url = `${SOURCE_BASE}/${pair}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Fundamet-app/ingest-fx-daily-prices" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    console.warn(`[${pair}] zdroj vrátil HTTP ${res.status} — přeskočeno, zkusím příští běh.`);
    return { pair, ok: false, inserted: 0, rejected: 0 };
  }
  const json = await res.json();
  const check = validatePair(json, pair);
  if (!check.ok) {
    console.warn(`[${pair}] validace celého souboru selhala: ${check.problems.join("; ")} — přeskočeno.`);
    return { pair, ok: false, inserted: 0, rejected: 0 };
  }

  // Watermark per pár — jednotlivé páry mají různě dlouhou historii, sdílený watermark
  // napříč páry by dával smysl.
  const { data: lastRow, error: lastErr } = await supabase
    .from("fx_price_daily")
    .select("price_date")
    .eq("pair", pair)
    .order("price_date", { ascending: false })
    .limit(1);
  if (lastErr) {
    console.error(`[${pair}] chyba čtení watermarku:`, lastErr.message);
    return { pair, ok: false, inserted: 0, rejected: 0 };
  }
  const watermark = lastRow?.[0]?.price_date ?? null;

  const rows = [];
  let rejected = 0;
  const rejectReasons = [];
  for (let i = 0; i < json.dates.length; i++) {
    const dateStr = json.dates[i];
    if (watermark && dateStr <= watermark) continue; // jen novější než dosavadní watermark
    const v = validateRow(dateStr, json.closes[i], now);
    if (!v.ok) {
      rejected++;
      if (rejectReasons.length < 5) rejectReasons.push(`${dateStr}: ${v.reason}`);
      continue;
    }
    rows.push({ pair, price_date: dateStr, close: v.close, source: "fx-analyzer/stooq-or-yahoo" });
  }

  if (rejected) {
    console.warn(`[${pair}] zamítnuto ${rejected} řádků (neplatná data): ${rejectReasons.join(" | ")}${rejected > 5 ? " ..." : ""}`);
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    const { error: insErr } = await supabase
      .from("fx_price_daily")
      .upsert(chunk, { onConflict: "pair,price_date", ignoreDuplicates: true });
    if (insErr) {
      console.error(`[${pair}] chyba zápisu dávky:`, insErr.message);
      return { pair, ok: false, inserted, rejected };
    }
    inserted += chunk.length;
  }

  const latestDate = json.dates[json.dates.length - 1];
  const ageMs = latestDate ? now.getTime() - new Date(latestDate + "T00:00:00Z").getTime() : Infinity;
  const staleNote = ageMs > STALE_AFTER_MS ? ` POZOR: nejnovější bod je starý ${Math.round(ageMs / 3600000)}h — zdroj možná přestal aktualizovat.` : "";
  console.log(
    `[${pair}] OK — watermark=${watermark ?? "žádný (první běh)"}, nových řádků k zápisu=${rows.length}, zamítnuto=${rejected}, ` +
      `nejnovější bod ve zdroji=${latestDate}.${staleNote}`
  );
  return { pair, ok: true, inserted, rejected };
}

async function main() {
  const now = new Date();
  console.log(`Ingestuji ${PAIRS.length} párů z ${SOURCE_BASE} ...`);
  let totalInserted = 0, totalRejected = 0, failedPairs = [];
  for (const pair of PAIRS) {
    const r = await ingestPair(pair, now);
    if (!r.ok) failedPairs.push(pair);
    totalInserted += r.inserted;
    totalRejected += r.rejected;
  }

  if (failedPairs.length) console.warn(`Páry, u kterých ingest selhal (zdroj/validace): ${failedPairs.join(", ")}`);
  console.log(`Hotovo — nově zapsáno (nebo už existovalo, PK dedupe): ${totalInserted} řádků, zamítnuto: ${totalRejected}.`);

  const { count: totalRows, error: countErr } = await supabase
    .from("fx_price_daily")
    .select("*", { count: "exact", head: true });
  if (countErr) console.error("Chyba čtení celkového počtu řádků:", countErr.message);
  else console.log(`Celkem řádků v fx_price_daily po tomhle běhu: ${totalRows}`);

  if (failedPairs.length === PAIRS.length) process.exit(1); // úplný výpadek zdroje = skutečná chyba
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
