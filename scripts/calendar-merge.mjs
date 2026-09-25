// Čistá logika slučování nově scrapnutých eventů s tím, co už je v calendar_events — bez I/O,
// ať jde otestovat izolovaně (fetch-calendar.mjs při importu vyžaduje Supabase env).

import { matchRule } from "./fundamental-scoring.mjs";

export function calendarKey(ev) {
  return `${ev.currency_code}|${ev.event_title}|${ev.event_day}`;
}

function sameInstant(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * @param {Array} scraped - deduplikované eventy z ForexFactory (dedupePreferComplete)
 * @param {Array} existingRows - řádky calendar_events pro stejný rozsah dní
 * @param {string} nowIso
 * @returns {{ rows: Array, unchanged: number, materialCurrencies: Set<string> }}
 */
export function planCalendarMerge(scraped, existingRows, nowIso) {
  const existingByKey = new Map(existingRows.map((r) => [calendarKey(r), r]));
  const rows = [];
  const materialCurrencies = new Set();
  let unchanged = 0;

  for (const ev of scraped) {
    const existing = existingByKey.get(calendarKey(ev));

    // Nový actual u eventu, na kterém appce záleží → spouštěč přegenerování narrativu jen pro
    // tuhle měnu (viz triggerNarrativeRegeneration ve fetch-calendar.mjs).
    if (!existing?.actual && ev.actual && (matchRule(ev.event_title)?.w ?? 0) > 0) {
      materialCurrencies.add(ev.currency_code);
    }

    // Nikdy neztratit dřív zachycený actual/estimate/previous kvůli neúplnému re-scrapu.
    const merged = {
      ...ev,
      actual: ev.actual ?? existing?.actual ?? null,
      estimate: ev.estimate ?? existing?.estimate ?? null,
      previous: ev.previous ?? existing?.previous ?? null,
    };

    const changed =
      !existing ||
      merged.actual !== (existing.actual ?? null) ||
      merged.estimate !== (existing.estimate ?? null) ||
      merged.previous !== (existing.previous ?? null) ||
      merged.impact !== existing.impact ||
      !sameInstant(merged.event_time, existing.event_time);

    if (!changed) {
      unchanged++;
      continue;
    }
    rows.push({ ...merged, updated_at: nowIso });
  }

  return { rows, unchanged, materialCurrencies };
}
