// Hlídač děr v kalendáři — POUZE DETEKCE A UPOZORNĚNÍ. Nic nezapisuje, nic nemaže ani neopravuje
// (schváleno uživatelem 10. 10. 2026, krok 2 první etapy). Čte calendar_events a hlásí:
//
//  1) "řídký" týden: týden (pondělí–neděle) s podezřele málo událostmi proti mediánu ostatních
//     týdnů. Živý případ: týden od 8. 6. 2026 měl 17 událostí místo ~90, takže v historii chyběla
//     rozhodnutí ECB, BoC a BoJ a nikdo si toho celé týdny nevšiml.
//  2) "díra v rozhodnutích centrální banky": mezi dvěma po sobě jdoucími zachycenými sazbovými
//     rozhodnutími uplynulo víc dní, než je u dané banky normální — pravděpodobně chybí zasedání.
//
// Výstup: řádky v logu, `::warning::` anotace v GitHub Actions a shrnutí běhu. Exit kód 1 při
// nálezu nebo chybě čtení (workflow ho převede na varování, aby nechodily e-maily "Run failed").
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extractRateHistory } from "./cb-policy.mjs";

export const SCORED_CURRENCIES = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];

// Týden je "řídký", když má méně než tento podíl mediánu. 0,4 (ne 0,5): vánoční týdny bývají
// kolem 0,48 mediánu a jsou legitimní; skutečná díra z června měla 0,18.
export const THIN_WEEK_RATIO = 0.4;
export const LOOKBACK_WEEKS = 52;
export const MIN_WEEKS_FOR_BASELINE = 8;

// Nejdelší běžný odstup mezi sazbovými rozhodnutími (dny). Nejdelší normální mezery v datech:
// většina bank 56 dní, RBNZ 84 dní (letní pauza 26. 11. → 18. 2.), SNB čtvrtletně ~98 dní.
export const DEFAULT_MAX_GAP_DAYS = 65;
export const MAX_GAP_DAYS = { NZD: 95, CHF: 120 };
export const RATE_LOOKBACK_DAYS = 400;

const DAY_MS = 86400000;

function parseDay(d) {
  return new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
}

function dayStr(date) {
  return date.toISOString().slice(0, 10);
}

/** Pondělí týdne, do kterého `day` (YYYY-MM-DD) spadá. */
export function weekStart(day) {
  const d = parseDay(day);
  const dow = (d.getUTCDay() + 6) % 7; // pondělí = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return dayStr(d);
}

/** @returns {Map<string, number>} pondělí týdne → počet událostí */
export function weeklyCounts(events) {
  const counts = new Map();
  for (const ev of events) {
    const w = weekStart(ev.event_day);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Najde dokončené týdny s podezřele málo událostmi.
 * Nezahrnuje rozpracovaný (aktuální) týden ani první týden dat (může být nepřesně ořezaný).
 * @param {Map<string, number>} counts
 * @param {string} today YYYY-MM-DD
 */
export function findThinWeeks(counts, today, { ratio = THIN_WEEK_RATIO, lookbackWeeks = LOOKBACK_WEEKS } = {}) {
  const allWeeks = [...counts.keys()].sort();
  if (allWeeks.length === 0) return { median: null, thin: [] };
  const firstWeek = allWeeks[0];
  const cutoff = dayStr(new Date(parseDay(today).getTime() - lookbackWeeks * 7 * DAY_MS));
  const completed = allWeeks.filter((w) => {
    const weekEnd = dayStr(new Date(parseDay(w).getTime() + 6 * DAY_MS));
    return w !== firstWeek && weekEnd < today && w >= cutoff;
  });
  if (completed.length < MIN_WEEKS_FOR_BASELINE) return { median: null, thin: [] };
  const med = median(completed.map((w) => counts.get(w)));
  const thin = completed
    .filter((w) => counts.get(w) < med * ratio)
    .map((w) => ({ week: w, count: counts.get(w), median: med, ratio: Math.round((counts.get(w) / med) * 100) / 100 }));
  return { median: med, thin };
}

/**
 * Najde nezvykle dlouhé odstupy mezi sazbovými rozhodnutími.
 * @param {Record<string, Array<{date: string, rate: number}>>} historyByCurrency
 * @param {string} today YYYY-MM-DD
 */
export function findRateGaps(historyByCurrency, today, { lookbackDays = RATE_LOOKBACK_DAYS } = {}) {
  const cutoff = dayStr(new Date(parseDay(today).getTime() - lookbackDays * DAY_MS));
  const out = [];
  for (const [code, history] of Object.entries(historyByCurrency)) {
    const maxGap = MAX_GAP_DAYS[code] ?? DEFAULT_MAX_GAP_DAYS;
    const dates = [...new Set(history.map((h) => h.date))].filter((d) => d >= cutoff).sort();
    for (let i = 1; i < dates.length; i++) {
      const gap = Math.round((parseDay(dates[i]) - parseDay(dates[i - 1])) / DAY_MS);
      if (gap > maxGap) out.push({ currency: code, from: dates[i - 1], to: dates[i], days: gap, maxGap, kind: "gap" });
    }
    if (dates.length > 0) {
      const sinceLast = Math.round((parseDay(today) - parseDay(dates[dates.length - 1])) / DAY_MS);
      if (sinceLast > maxGap) {
        out.push({ currency: code, from: dates[dates.length - 1], to: today, days: sinceLast, maxGap, kind: "since_last" });
      }
    }
  }
  return out;
}

export function formatFindings({ thin, rateGaps }) {
  const lines = [];
  for (const t of thin) {
    lines.push(
      `Týden od ${t.week} má jen ${t.count} událostí (medián ${t.median}, ${Math.round(t.ratio * 100)} %) — pravděpodobně chybí data z kalendáře.`
    );
  }
  for (const g of rateGaps) {
    lines.push(
      g.kind === "gap"
        ? `${g.currency}: mezi sazbovými rozhodnutími ${g.from} a ${g.to} uplynulo ${g.days} dní (běžně nejvýš ${g.maxGap}) — pravděpodobně chybí zasedání.`
        : `${g.currency}: poslední zachycené sazbové rozhodnutí je z ${g.from} (před ${g.days} dny, běžně nejvýš ${g.maxGap}) — zkontrolovat, zda neproběhlo další.`
    );
  }
  return lines;
}

async function loadEvents(supabase, sinceDay) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("currency_code, event_title, event_day, actual")
      .gte("event_day", sinceDay)
      .order("event_day", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`calendar_events: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
    process.exit(1);
  }
  const supabase = createClient(url, key);
  const today = new Date().toISOString().slice(0, 10);
  const since = dayStr(new Date(parseDay(today).getTime() - (LOOKBACK_WEEKS * 7 + 14) * DAY_MS));

  let events;
  try {
    events = await loadEvents(supabase, since);
  } catch (err) {
    console.error(`KONTROLA NEPROBĚHLA: ${err.message}`);
    console.log(`::warning::Hlídač děr v kalendáři neproběhl (${err.message}).`);
    process.exit(1);
  }

  const { median: med, thin } = findThinWeeks(weeklyCounts(events), today);
  const historyByCurrency = Object.fromEntries(SCORED_CURRENCIES.map((c) => [c, extractRateHistory(c, events)]));
  const rateGaps = findRateGaps(historyByCurrency, today);
  const lines = formatFindings({ thin, rateGaps });

  console.log(`Zkontrolováno ${events.length} událostí od ${since}; medián událostí na týden: ${med ?? "n/a"}.`);
  const summary = lines.length === 0 ? "Hlídač děr: žádná podezřelá mezera." : `Hlídač děr: ${lines.length} nález(ů).`;
  console.log(summary);
  for (const l of lines) {
    console.log(`  - ${l}`);
    console.log(`::warning::${l}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  }
  process.exit(lines.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Hlídač děr selhal:", err);
    process.exit(1);
  });
}
