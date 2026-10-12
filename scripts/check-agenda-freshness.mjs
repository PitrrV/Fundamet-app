// Kontrola čerstvosti makro agendy — POUZE ČTE a hlásí (nic nezapisuje ani neopravuje).
// Agenda se dřív přenášela ze starého textu a tiše zastarala (hotové události bez výsledku,
// chybějící nadcházející CPI). Hlásí:
//  1) událost v agendě už vyšla (kalendář má actual), ale agenda má outcome null,
//  2) v agendě je položka starší než SCENARIO_LOOKBACK_DAYS (ukazuje na dávnou minulost),
//  3) důležitá událost (váha ≥ 2) v následujících 7 dnech v agendě chybí.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { agendaWeight } from "./agenda.mjs";
import { SCORED_CURRENCIES } from "./check-calendar-gaps.mjs";

export const STALE_AFTER_DAYS = 5;
export const LOOKAHEAD_DAYS = 7;
export const MIN_IMPORTANT_WEIGHT = 2;
const DAY_MS = 86400000;
const addDays = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);

/**
 * @param {Record<string, Array<{event: string, date: string, outcome: string|null}>>} agendaByCurrency
 * @param {Array<{currency_code: string, event_title: string, event_day: string, actual: string|null}>} events
 * @param {string} today YYYY-MM-DD
 */
export function findAgendaIssues(agendaByCurrency, events, today) {
  const issues = [];
  const staleCutoff = addDays(today, -STALE_AFTER_DAYS);
  const horizon = addDays(today, LOOKAHEAD_DAYS);
  for (const [code, agenda] of Object.entries(agendaByCurrency)) {
    const items = agenda ?? [];
    const own = events.filter((e) => e.currency_code === code);
    for (const it of items) {
      const cal = own.find((e) => e.event_title === it.event && e.event_day === it.date);
      if (cal?.actual && (it.outcome == null || it.outcome === "")) {
        issues.push({ currency: code, kind: "bez_vysledku", text: `${code}: ${it.event} (${it.date}) už vyšlo (${cal.actual}), agenda to neví.` });
      }
      if (it.date < staleCutoff) {
        issues.push({ currency: code, kind: "stara_polozka", text: `${code}: v agendě je položka ${it.event} z ${it.date} (starší než ${STALE_AFTER_DAYS} dní).` });
      }
    }
    const inAgenda = new Set(items.map((it) => `${it.date}|${it.event}`));
    for (const e of own) {
      if (e.actual || e.event_day < today || e.event_day > horizon) continue;
      if (agendaWeight(e.event_title) < MIN_IMPORTANT_WEIGHT) continue;
      if (!inAgenda.has(`${e.event_day}|${e.event_title}`)) {
        issues.push({ currency: code, kind: "chybi", text: `${code}: důležitá událost ${e.event_title} (${e.event_day}) v agendě chybí.` });
      }
    }
  }
  return issues;
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
  const { data: narr, error: e1 } = await supabase.from("latest_narratives").select("currency_code, scenarios");
  const { data: events, error: e2 } = await supabase
    .from("calendar_events")
    .select("currency_code, event_title, event_day, actual")
    .gte("event_day", addDays(today, -14))
    .lte("event_day", addDays(today, 21));
  if (e1 || e2) {
    console.error(`KONTROLA NEPROBĚHLA: ${(e1 ?? e2).message}`);
    console.log(`::warning::Kontrola agendy neproběhla (${(e1 ?? e2).message}).`);
    process.exit(1);
  }
  const agendaByCurrency = Object.fromEntries(SCORED_CURRENCIES.map((c) => [c, narr.find((n) => n.currency_code === c)?.scenarios ?? []]));
  const issues = findAgendaIssues(agendaByCurrency, events, today);
  const summary = issues.length === 0 ? "Agenda: čerstvá, nic nechybí." : `Agenda: ${issues.length} nález(ů).`;
  console.log(summary);
  for (const i of issues) {
    console.log(`  - ${i.text}`);
    console.log(`::warning::${i.text}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n${issues.map((i) => `- ${i.text}`).join("\n")}\n`);
  }
  process.exit(issues.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Kontrola agendy selhala:", err);
    process.exit(1);
  });
}
