// Intradenní retail sentiment — POUZE sběr dat, žádné skóre, žádné UI, žádný signál.
//
// Zdroj: veřejně čitelný data/retail_hist.json z https://github.com/PitrrV/Fx-Analyzer
// (appka tam běží vlastní 30min cron proti MyFxbook official API + FXSSI Current Ratio,
// viz technický audit 5.9.2026). Fundamet-app tenhle soubor jen ČTE přes raw.githubusercontent
// — žádný vlastní MyFxbook účet, žádné nové API klíče. Fx-Analyzer si svou historii ořezává
// (~45-75 dní), tahle appka ne — buduje si vlastní, trvalou archivaci od nuly.
//
// Záměrně ODDĚLENO od týdenního retail_score (ingest-cot.mjs, currency-relative percentil,
// viz post-audit oprava F) — jiná tabulka, jiná appka jako zdroj, jiná frekvence. Nikam
// nevstupuje do overall_score/BLEND_WEIGHTS/conviction — čistě archivace pro pozdější
// analýzu (rychlost změny, viz plán "F fáze 3" až bude dost historie).
//
// Spouští se z .github/workflows/ingest-retail-intraday.yml (cron */30) nebo ručně:
// node scripts/ingest-retail-intraday.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SOURCE_URL = "https://raw.githubusercontent.com/PitrrV/Fx-Analyzer/main/data/retail_hist.json";
// Stejná množina/pořadí jako SCORED_CURRENCIES ve fetch-calendar.mjs — appka nezapisuje bod,
// kterému kterákoliv z těchhle osmi měn chybí (viz validatePoint níž).
const REQUIRED_CURRENCIES = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];
const INSERT_CHUNK_SIZE = 500;
// Fx-Analyzer má na retail.yml cron */30 — pokud appka déle nevidí novější bod, než tohle,
// zdroj pravděpodobně přestal fungovat (appka to jen zaloguje, nic nerozbije).
const STALE_AFTER_MS = 3 * 60 * 60 * 1000; // 3 h

// Kolik dopředu do budoucna appka ještě toleruje jako "hodinový posun/drift", ne chybu.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function validatePoint(point, now) {
  if (!point || typeof point !== "object") return { ok: false, reason: "bod není objekt" };

  const t = new Date(point.t);
  if (!point.t || Number.isNaN(t.getTime())) return { ok: false, reason: `neplatný timestamp: ${JSON.stringify(point.t)}` };
  if (t.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: `timestamp v budoucnosti: ${point.t}` };
  }

  if (!point.ccy || typeof point.ccy !== "object") return { ok: false, reason: "chybí pole ccy" };

  const values = {};
  for (const code of REQUIRED_CURRENCIES) {
    const v = point.ccy[code];
    if (v === undefined || v === null) return { ok: false, reason: `chybí měna ${code}` };
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      return { ok: false, reason: `${code}: long %=${v} mimo rozsah 0-100` };
    }
    values[code] = num;
  }

  return { ok: true, recordedAt: t.toISOString(), values };
}

async function main() {
  console.log(`Stahuji ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "Fundamet-app/ingest-retail-intraday" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    console.error(`Zdroj vrátil HTTP ${res.status} — nic se nezapisuje, zkusím příští běh.`);
    process.exit(0); // transientní selhání zdroje, ne appky — netreba tvrdý pád (viz FRED-fallback fix)
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.points)) {
    console.error("Zdroj nemá očekávaný tvar (chybí pole points) — nic se nezapisuje.");
    process.exit(0);
  }
  console.log(`Zdroj: ${data.points.length} bodů celkem, poslední zdroj dat: ${data.source ?? "N/A"}, updated=${data.updated ?? "N/A"}`);

  // Watermark — jen body novější než náš dosavadní nejnovější záznam. PRIMARY KEY
  // (currency_code, recorded_at) navíc chrání proti duplicitám, kdyby se okno přesto
  // překrylo (např. po výpadku appky na pár hodin).
  const { data: lastRow, error: lastErr } = await supabase
    .from("retail_sentiment_intraday")
    .select("recorded_at")
    .order("recorded_at", { ascending: false })
    .limit(1);
  if (lastErr) {
    console.error("Chyba čtení dosavadního watermarku:", lastErr.message);
    process.exit(1);
  }
  const watermark = lastRow?.[0]?.recorded_at ?? null;
  console.log(`Dosavadní watermark (nejnovější uložený bod): ${watermark ?? "žádný — první běh, backfilluje se celá historie zdroje"}`);

  const now = new Date();
  const candidates = watermark ? data.points.filter((p) => p.t && p.t > watermark) : data.points;
  console.log(`Kandidátů k zápisu (novější než watermark): ${candidates.length}`);

  const rows = [];
  const rejected = [];
  for (const point of candidates) {
    const v = validatePoint(point, now);
    if (!v.ok) {
      rejected.push({ t: point?.t ?? "?", reason: v.reason });
      continue;
    }
    for (const code of REQUIRED_CURRENCIES) {
      rows.push({
        currency_code: code,
        recorded_at: v.recordedAt,
        long_pct: v.values[code],
        source: point.source ?? null,
      });
    }
  }

  if (rejected.length) {
    console.warn(`Zamítnuto ${rejected.length} bodů (neplatná data, nezapsáno jako validní bod):`);
    for (const r of rejected.slice(0, 20)) console.warn(`  · ${r.t}: ${r.reason}`);
    if (rejected.length > 20) console.warn(`  · ... a ${rejected.length - 20} dalších`);
  }

  console.log(`Validních řádků k zápisu: ${rows.length} (${rows.length / REQUIRED_CURRENCIES.length} bodů × ${REQUIRED_CURRENCIES.length} měn)`);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    // ignoreDuplicates: true → ON CONFLICT (currency_code, recorded_at) DO NOTHING,
    // ne update — historický bod se nikdy nepřepisuje, jen doplňuje.
    const { error: insErr } = await supabase
      .from("retail_sentiment_intraday")
      .upsert(chunk, { onConflict: "currency_code,recorded_at", ignoreDuplicates: true });
    if (insErr) {
      console.error(`Chyba zápisu dávky ${i}-${i + chunk.length}:`, insErr.message);
      process.exit(1);
    }
    inserted += chunk.length;
  }
  console.log(`Zapsáno (nebo už existovalo, PK dedupe): ${inserted} řádků.`);

  // Kontrola stáří zdroje — appka nic nerozbije, jen nahlásí, že Fx-Analyzer/MyFxbook/FXSSI
  // pravděpodobně přestaly aktualizovat (retail.yml tam běží každých 30 min).
  const latestPoint = data.points[data.points.length - 1];
  if (latestPoint?.t) {
    const ageMs = now.getTime() - new Date(latestPoint.t).getTime();
    if (ageMs > STALE_AFTER_MS) {
      console.warn(
        `POZOR: nejnovější bod ve zdroji je starý ${Math.round(ageMs / 60000)} min ` +
          `(očekáváno ~30 min) — Fx-Analyzer retail feed možná přestal aktualizovat.`
      );
    } else {
      console.log(`Zdroj vypadá živě — nejnovější bod starý ${Math.round(ageMs / 60000)} min.`);
    }
  }

  // Rychlý souhrn — počet řádků v naší vlastní tabulce po tomhle běhu.
  const { count: totalRows, error: countErr } = await supabase
    .from("retail_sentiment_intraday")
    .select("*", { count: "exact", head: true });
  if (countErr) console.error("Chyba čtení celkového počtu řádků:", countErr.message);
  else console.log(`Celkem řádků v retail_sentiment_intraday po tomhle běhu: ${totalRows}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
