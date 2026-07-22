import { supabase } from "./supabaseClient";
import type { CalendarEvent, CbPolicy, CurrencyData, DataTier, PricedIn, RiskRegime, Scenario } from "../types";

// Tvar, jak scénáře skutečně ukládá generate-narrative.mjs (OpenAI JSON schema používá
// snake_case) — mapuje se na camelCase `Scenario` až ve výstupu fetchCurrencies().
interface ScenarioRow {
  event: string;
  date: string;
  if_beat: string;
  if_miss: string;
  outcome: string | null;
}

interface LatestConfluenceScoreRow {
  currency_code: string;
  cot_score: number;
  overall_score: number;
  data_tier: DataTier;
  conviction_label: string;
  cot_positioning_label: string | null;
  summary: string | null;
  retail_score: number | null;
  cot_percentile: number | null;
  conviction_stars: number | null;
  conviction_reasons: string[] | null;
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
  scenarios: ScenarioRow[] | null;
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

interface CbPolicyStateRow {
  currency_code: string;
  rate: number | null;
  cpi: number | null;
  policy_score: number | null;
  policy_label: string | null;
  policy_confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  real_yield_adj: number | null;
  cb_policy_adj: number | null;
  priced_in: PricedIn | null;
}

interface MarketRegimeRow {
  vix: number;
  vix_5d_change: number;
  regime: "RISK_ON" | "NEUTRAL" | "RISK_OFF";
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

export async function fetchCurrencies(): Promise<CurrencyData[]> {
  const today = new Date().toISOString().slice(0, 10);
  const upcomingCutoff = new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString().slice(0, 10);

  const [cotResult, fundamentalResult, narrativeResult, calendarResult, cbPolicyResult, marketRegimeResult] =
    await Promise.all([
      withTimeout(
        supabase
          .from("latest_confluence_scores")
          .select(
            "currency_code, cot_score, overall_score, data_tier, conviction_label, cot_positioning_label, summary, retail_score, cot_percentile, conviction_stars, conviction_reasons"
          )
          .order("currency_code", { ascending: true }),
        FETCH_TIMEOUT_MS
      ),
      withTimeout(
        supabase.from("latest_fundamental_scores").select("currency_code, fundamental_score"),
        FETCH_TIMEOUT_MS
      ),
      withTimeout(
        supabase
          .from("latest_narratives")
          .select("currency_code, narrative, forward_flag, conviction_note, scenarios"),
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
      withTimeout(
        supabase
          .from("cb_policy_state")
          .select("currency_code, rate, cpi, policy_score, policy_label, policy_confidence, real_yield_adj, cb_policy_adj, priced_in"),
        FETCH_TIMEOUT_MS
      ),
      withTimeout(supabase.from("market_regime").select("vix, vix_5d_change, regime").limit(1), FETCH_TIMEOUT_MS),
    ]);

  if (cotResult.error) {
    throw new Error(`Nepodařilo se načíst confluence skóre: ${cotResult.error.message}`);
  }

  const fundamentalByCode = groupByCurrency((fundamentalResult.data ?? []) as LatestFundamentalScoreRow[]);
  const narrativeByCode = groupByCurrency((narrativeResult.data ?? []) as LatestNarrativeRow[]);
  const calendarByCode = groupByCurrency((calendarResult.data ?? []) as CalendarEventRow[]);
  const cbPolicyByCode = groupByCurrency((cbPolicyResult.data ?? []) as CbPolicyStateRow[]);
  const marketRegime = ((marketRegimeResult.data ?? []) as MarketRegimeRow[])[0] ?? null;
  const riskRegime: RiskRegime | null = marketRegime
    ? { vix: marketRegime.vix, vix5dChange: marketRegime.vix_5d_change, regime: marketRegime.regime }
    : null;

  return ((cotResult.data ?? []) as LatestConfluenceScoreRow[]).map((row) => {
    const fundamental = fundamentalByCode.get(row.currency_code)?.[0] ?? null;
    const narrative = narrativeByCode.get(row.currency_code)?.[0] ?? null;
    const cbPolicyRow = cbPolicyByCode.get(row.currency_code)?.[0] ?? null;
    const calendarEvents: CalendarEvent[] = (calendarByCode.get(row.currency_code) ?? []).map((e) => ({
      date: e.event_day,
      title: e.event_title,
      impact: e.impact,
      estimate: e.estimate,
      previous: e.previous,
      actual: e.actual,
    }));

    const cbPolicy: CbPolicy | null =
      cbPolicyRow && cbPolicyRow.priced_in
        ? {
            rate: cbPolicyRow.rate,
            cpi: cbPolicyRow.cpi,
            policyLabel: cbPolicyRow.policy_label ?? "",
            policyConfidence: cbPolicyRow.policy_confidence ?? "LOW",
            realYieldAdj: cbPolicyRow.real_yield_adj ?? 0,
            cbPolicyAdj: cbPolicyRow.cb_policy_adj ?? 0,
            pricedIn: cbPolicyRow.priced_in,
          }
        : null;

    const scenarios: Scenario[] = (narrative?.scenarios ?? []).map((s) => ({
      event: s.event,
      date: s.date,
      ifBeat: s.if_beat,
      ifMiss: s.if_miss,
      outcome: s.outcome,
    }));

    return {
      code: row.currency_code,
      score: row.overall_score,
      convictionLabel: row.conviction_label,
      summary: narrative?.narrative ?? row.summary ?? "",
      cotPositioning: row.cot_positioning_label ?? "Neznámé",
      pricedIn: cbPolicy?.pricedIn.label ?? null,
      longTermBias: cbPolicy?.policyLabel ?? null,
      dataTier: row.data_tier,
      events: [],
      fundamentalScore: fundamental?.fundamental_score ?? null,
      forwardFlag: narrative?.forward_flag ?? null,
      convictionNote: narrative?.conviction_note ?? null,
      calendarEvents,
      cbPolicy,
      retailScore: row.retail_score,
      cotPercentile: row.cot_percentile,
      convictionStars: row.conviction_stars,
      convictionReasons: row.conviction_reasons ?? [],
      riskRegime,
      scenarios,
    };
  });
}
