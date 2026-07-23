// Konfluence Gen3.5 Fáze 1 — Confidence & Data Quality Engine: jen Data Quality + Coverage
// (viz architektonický návrh Gen3.5 a jeho revizní log). Deterministické kontroly nad vstupními
// daty (COT, kalendář) — ne nad tezí. Nezávisí na currency_thesis, takže dává hodnotu hned.

import { createClient } from "@supabase/supabase-js";
import { matchRule } from "./fundamental-scoring.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// Editorské prahy (stejná konvence jako zbytek systému). Grace multiplier 1.5x na
// expected_frequency_days, aby kontrola nekmitala přesně na hranici.
const GRACE_MULTIPLIER = 1.5;
const STALE_COT_MEDIUM_DAYS = 10;
const STALE_COT_HIGH_DAYS = 17;
const SEVERITY_PENALTY = { HIGH: 25, MEDIUM: 10, LOW: 5 };
// Schválená úprava #3 z revizního logu Gen3.5 — chybějící "critical" kategorie stropuje skóre
// na LOW bez ohledu na vážený průměr, ne jen tiše ubere pár bodů.
const CRITICAL_MISSING_SCORE_CAP = 40;

function daysBetween(isoDateA, isoDateB) {
  return Math.round((new Date(isoDateA).getTime() - new Date(isoDateB).getTime()) / 86400000);
}

function severityForTier(tier) {
  if (tier === "critical") return "HIGH";
  if (tier === "major") return "MEDIUM";
  return "LOW";
}

/**
 * @param {string} currencyCode
 * @param {Array} allEvents - calendar_events VŠECH měn (musí obsahovat event_day, actual)
 * @param {string|null} latestCotReportDate - report_date z latest_confluence_scores
 */
export async function runDataQualityForCurrency(currencyCode, allEvents, latestCotReportDate) {
  if (!supabase) {
    console.warn(`[${currencyCode}] CDQE přeskočen — chybí Supabase env.`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const { data: expectations, error: expErr } = await supabase
    .from("category_expectations")
    .select("category, importance_tier, expected_frequency_days")
    .eq("currency_code", currencyCode);

  if (expErr) {
    console.error(`[${currencyCode}] CDQE chyba čtení category_expectations:`, expErr.message);
    return;
  }

  const currencyEvents = allEvents.filter((e) => e.currency_code === currencyCode);
  const flags = [];
  const present = [];
  const missing = [];

  for (const exp of expectations ?? []) {
    const resolvedOfCategory = currencyEvents.filter((e) => e.actual && matchRule(e.event_title)?.cat === exp.category);
    const mostRecent = resolvedOfCategory.sort((a, b) => b.event_day.localeCompare(a.event_day))[0] ?? null;
    const daysSince = mostRecent ? daysBetween(today, mostRecent.event_day) : null;
    const isFresh = daysSince !== null && daysSince <= exp.expected_frequency_days * GRACE_MULTIPLIER;

    if (isFresh) {
      present.push(exp.category);
    } else {
      missing.push(exp.category);
      const severity = severityForTier(exp.importance_tier);
      flags.push({
        currency_code: currencyCode,
        source_type: "calendar_events",
        flag_type: "missing_event",
        category: exp.category,
        severity,
        detail: mostRecent
          ? `${exp.category}: poslední výskyt před ${daysSince} dny (očekáváno každých ~${exp.expected_frequency_days}).`
          : `${exp.category}: v datech zatím vůbec nenalezeno.`,
      });
    }
  }

  const coveragePct = (expectations ?? []).length > 0 ? Math.round((present.length / expectations.length) * 100) : 100;

  const { error: covErr } = await supabase.from("data_coverage").upsert(
    {
      currency_code: currencyCode,
      expected: (expectations ?? []).map((e) => e.category),
      present,
      missing,
      coverage_pct: coveragePct,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "currency_code" }
  );
  if (covErr) console.error(`[${currencyCode}] CDQE chyba upsertu data_coverage:`, covErr.message);

  if (latestCotReportDate) {
    const cotAge = daysBetween(today, latestCotReportDate);
    if (cotAge > STALE_COT_HIGH_DAYS) {
      flags.push({
        currency_code: currencyCode,
        source_type: "cot_reports",
        flag_type: "stale_cot",
        category: null,
        severity: "HIGH",
        detail: `Poslední COT report starý ${cotAge} dní (běžná cadence je týdenní).`,
      });
    } else if (cotAge > STALE_COT_MEDIUM_DAYS) {
      flags.push({
        currency_code: currencyCode,
        source_type: "cot_reports",
        flag_type: "stale_cot",
        category: null,
        severity: "MEDIUM",
        detail: `Poslední COT report starý ${cotAge} dní.`,
      });
    }
  } else {
    flags.push({
      currency_code: currencyCode,
      source_type: "cot_reports",
      flag_type: "stale_cot",
      category: null,
      severity: "HIGH",
      detail: "Žádný COT report zatím nenalezen.",
    });
  }

  const overdue = currencyEvents.filter((e) => e.event_day < today && !e.actual && daysBetween(today, e.event_day) >= 1);
  if (overdue.length > 0) {
    flags.push({
      currency_code: currencyCode,
      source_type: "calendar_events",
      flag_type: "pending_actual_overdue",
      category: null,
      severity: "MEDIUM",
      detail: `${overdue.length} event(y) po datu vydání pořád bez actual (např. "${overdue[0].event_title}").`,
    });
  }

  const { error: delErr } = await supabase.from("data_quality_flags").delete().eq("currency_code", currencyCode);
  if (delErr) console.error(`[${currencyCode}] CDQE chyba mazání starých flagů:`, delErr.message);

  if (flags.length > 0) {
    const { error: flagErr } = await supabase.from("data_quality_flags").insert(flags);
    if (flagErr) console.error(`[${currencyCode}] CDQE chyba zápisu flagů:`, flagErr.message);
  }

  let score = 100;
  for (const flag of flags) score -= SEVERITY_PENALTY[flag.severity];
  score = Math.max(0, score);

  const hasCriticalMissing = flags.some((f) => f.flag_type === "missing_event" && f.severity === "HIGH");
  if (hasCriticalMissing) score = Math.min(score, CRITICAL_MISSING_SCORE_CAP);

  const { error: scoreErr } = await supabase.from("data_quality_score").upsert(
    {
      currency_code: currencyCode,
      score,
      active_flags: flags.map((f) => ({ flag_type: f.flag_type, category: f.category, severity: f.severity, detail: f.detail })),
      computed_at: new Date().toISOString(),
    },
    { onConflict: "currency_code" }
  );
  if (scoreErr) console.error(`[${currencyCode}] CDQE chyba upsertu data_quality_score:`, scoreErr.message);

  if (flags.length > 0) {
    console.log(`[${currencyCode}] CDQE: score=${score}, coverage=${coveragePct}%, ${flags.length} flag(y).`);
  }
}
