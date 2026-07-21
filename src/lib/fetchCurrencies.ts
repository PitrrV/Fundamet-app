import { supabase } from "./supabaseClient";
import type { CalendarEvent, CurrencyData, DataTier } from "../types";

interface LatestConfluenceScoreRow {
  currency_code: string;
  cot_score: number;
  overall_score: number;
  data_tier: DataTier;
  conviction_label: string;
  cot_positioning_label: string | null;
  summary: string | null;
}

interface LatestFundamentalScoreRow {
  currency_code: string;
  fundamental_score: number;
}

interface LatestNarrativeRow {
  currency_code: string;
  narrative: string;
  forward_flag: string | null;
  conviction_note: string | null;
}

interface CalendarEventRow {
  currency_code: string;
  event_day: string;
  event_title: string;
  impact: "Low" | "Medium" | "High";
  estimate: string | null;
  previous: string | null;
  actual: string | null;
}

const FETCH_TIMEOUT_MS = 10_000;
const UPCOMING_DAYS = 21;

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Databáze neodpověděla do ${ms / 1000} s.`)), ms)
    ),
  ]);
}

function groupByCurrency<T extends { currency_code: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.currency_code) ?? [];
    list.push(row);
    map.set(row.currency_code, list);
  }
  return map;
}

// Zaceněnost a dlouhodobý bias zatím nemají reálný datový zdroj — vždy null,
// dokud nepřibude sazbový/rate-expectations pilíř.
export async function fetchCurrencies(): Promise<CurrencyData[]> {
  const today = new Date().toISOString().slice(0, 10);
  const upcomingCutoff = new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString().slice(0, 10);

  const [cotResult, fundamentalResult, narrativeResult, calendarResult] = await Promise.all([
    withTimeout(
      supabase
        .from("latest_confluence_scores")
        .select(
          "currency_code, cot_score, overall_score, data_tier, conviction_label, cot_positioning_label, summary"
        )
        .order("currency_code", { ascending: true }),
      FETCH_TIMEOUT_MS
    ),
    withTimeout(
      supabase.from("latest_fundamental_scores").select("currency_code, fundamental_score"),
      FETCH_TIMEOUT_MS
    ),
    withTimeout(
      supabase.from("latest_narratives").select("currency_code, narrative, forward_flag, conviction_note"),
      FETCH_TIMEOUT_MS
    ),
    withTimeout(
      supabase
        .from("calendar_events")
        .select("currency_code, event_day, event_title, impact, estimate, previous, actual")
        .gte("event_day", today)
        .lte("event_day", upcomingCutoff)
        .order("event_day", { ascending: true }),
      FETCH_TIMEOUT_MS
    ),
  ]);

  if (cotResult.error) {
    throw new Error(`Nepodařilo se načíst confluence skóre: ${cotResult.error.message}`);
  }

  const fundamentalByCode = groupByCurrency((fundamentalResult.data ?? []) as LatestFundamentalScoreRow[]);
  const narrativeByCode = groupByCurrency((narrativeResult.data ?? []) as LatestNarrativeRow[]);
  const calendarByCode = groupByCurrency((calendarResult.data ?? []) as CalendarEventRow[]);

  return ((cotResult.data ?? []) as LatestConfluenceScoreRow[]).map((row) => {
    const fundamental = fundamentalByCode.get(row.currency_code)?.[0] ?? null;
    const narrative = narrativeByCode.get(row.currency_code)?.[0] ?? null;
    const calendarEvents: CalendarEvent[] = (calendarByCode.get(row.currency_code) ?? []).map((e) => ({
      date: e.event_day,
      title: e.event_title,
      impact: e.impact,
      estimate: e.estimate,
      previous: e.previous,
      actual: e.actual,
    }));

    return {
      code: row.currency_code,
      score: row.overall_score,
      convictionLabel: row.conviction_label,
      summary: narrative?.narrative ?? row.summary ?? "",
      cotPositioning: row.cot_positioning_label ?? "Neznámé",
      pricedIn: null,
      longTermBias: null,
      dataTier: row.data_tier,
      events: [],
      fundamentalScore: fundamental?.fundamental_score ?? null,
      forwardFlag: narrative?.forward_flag ?? null,
      convictionNote: narrative?.conviction_note ?? null,
      calendarEvents,
    };
  });
}
