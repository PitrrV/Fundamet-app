import { supabase } from "./supabaseClient";
import type { AgendaReaction, AgendaTier, CalendarEvent, CbPolicy, CurrencyData, CurrencyThesis, DataQuality, DataTier, LedgerEntry, PricedIn, RiskRegime, Scenario, ThesisDriver, TopOpportunity } from "../types";

// Tvar, jak agendu skutečně ukládá generate-narrative.mjs (OpenAI JSON schema používá
// snake_case) — mapuje se na camelCase `Scenario` až ve výstupu fetchCurrencies().
// Vše kromě event/date je volitelné: řádky vygenerované starší verzí promptu mají jiný tvar
// a nesmí shodit načtení celé měny, než je přepíše nejbližší běh generátoru.
interface ScenarioRow {
  event: string;
  date: string;
  tier?: AgendaTier;
  why_it_matters?: string | null;
  market_expectation?: string | null;
  thesis_test?: string | null;
  reaction?: AgendaReaction;
  reaction_note?: string | null;
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
  audio_url: string | null;
}

interface CalendarEventRow {
  id: number;
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

// Tvar, jak drivers ukládá scripts/thesis-engine.mjs (snake_case driver_key) — mapuje se na
// camelCase ThesisDriver až ve výstupu fetchCurrencies().
interface ThesisDriverRow {
  driver_key: string;
  label: string;
  value: number;
  status: "strong" | "weakening";
}

interface DataQualityScoreRow {
  currency_code: string;
  score: number;
}

interface DataCoverageRow {
  currency_code: string;
  coverage_pct: number;
  missing: string[] | null;
}

interface LatestCurrencyThesisRow {
  currency_code: string;
  direction: "bullish" | "bearish" | "neutral";
  conviction: number;
  drivers: ThesisDriverRow[] | null;
  thesis_summary: string | null;
  status: "active" | "watching" | "invalidated";
  confirm_streak: number;
  challenge_streak: number;
  opened_at: string;
}

// "Co se změnilo?" — view thesis_ledger_feed (znovupoužívá thesis_ledger z Gen2 Thesis Enginu).
interface LedgerFeedRow {
  currency_code: string;
  driver_key: string | null;
  classification: "confirms" | "challenges" | "invalidates_driver" | "opened" | "closed";
  reasoning: string;
  occurred_at: string;
}

const LEDGER_FEED_LIMIT_PER_CURRENCY = 10;

interface WeeklyTopOpportunityRow {
  strongest_currency: string | null;
  strongest_score: number | null;
  strongest_conviction: number | null;
  weakest_currency: string | null;
  weakest_score: number | null;
  weakest_conviction: number | null;
  rationale: string | null;
  confidence_tier: "strong" | "soft" | "flat" | null;
  insufficient_data: boolean;
  computed_at: string;
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

  const [
    cotResult,
    fundamentalResult,
    narrativeResult,
    calendarResult,
    cbPolicyResult,
    marketRegimeResult,
    thesisResult,
    dataQualityResult,
    dataCoverageResult,
    ledgerFeedResult,
  ] = await Promise.all([
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
          .select("currency_code, narrative, forward_flag, conviction_note, scenarios, audio_url"),
        FETCH_TIMEOUT_MS
      ),
      withTimeout(
        supabase
          .from("calendar_events")
          .select("id, currency_code, event_day, event_title, impact, estimate, previous, actual")
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
      withTimeout(
        supabase
          .from("latest_currency_thesis")
          .select("currency_code, direction, conviction, drivers, thesis_summary, status, confirm_streak, challenge_streak, opened_at"),
        FETCH_TIMEOUT_MS
      ),
      withTimeout(supabase.from("data_quality_score").select("currency_code, score"), FETCH_TIMEOUT_MS),
      withTimeout(supabase.from("data_coverage").select("currency_code, coverage_pct, missing"), FETCH_TIMEOUT_MS),
      withTimeout(
        supabase
          .from("thesis_ledger_feed")
          .select("currency_code, driver_key, classification, reasoning, occurred_at")
          .order("occurred_at", { ascending: false })
          .limit(200),
        FETCH_TIMEOUT_MS
      ),
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
  const thesisByCode = groupByCurrency((thesisResult.data ?? []) as LatestCurrencyThesisRow[]);
  const dataQualityByCode = groupByCurrency((dataQualityResult.data ?? []) as DataQualityScoreRow[]);
  const dataCoverageByCode = groupByCurrency((dataCoverageResult.data ?? []) as DataCoverageRow[]);
  const ledgerFeedByCode = groupByCurrency((ledgerFeedResult.data ?? []) as LedgerFeedRow[]);

  return ((cotResult.data ?? []) as LatestConfluenceScoreRow[]).map((row) => {
    const fundamental = fundamentalByCode.get(row.currency_code)?.[0] ?? null;
    const narrative = narrativeByCode.get(row.currency_code)?.[0] ?? null;
    const cbPolicyRow = cbPolicyByCode.get(row.currency_code)?.[0] ?? null;
    const calendarEvents: CalendarEvent[] = (calendarByCode.get(row.currency_code) ?? []).map((e) => ({
      id: e.id,
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
      tier: s.tier ?? "kontext",
      whyItMatters: s.why_it_matters ?? null,
      marketExpectation: s.market_expectation ?? null,
      thesisTest: s.thesis_test ?? null,
      reaction: s.reaction ?? "omezená",
      reactionNote: s.reaction_note ?? null,
      outcome: s.outcome,
    }));

    const thesisRow = thesisByCode.get(row.currency_code)?.[0] ?? null;
    const thesis: CurrencyThesis | null = thesisRow
      ? {
          direction: thesisRow.direction,
          conviction: thesisRow.conviction,
          drivers: (thesisRow.drivers ?? []).map(
            (d): ThesisDriver => ({ driverKey: d.driver_key, label: d.label, value: d.value, status: d.status })
          ),
          thesisSummary: thesisRow.thesis_summary,
          status: thesisRow.status,
          confirmStreak: thesisRow.confirm_streak,
          challengeStreak: thesisRow.challenge_streak,
          openedAt: thesisRow.opened_at,
        }
      : null;

    const dataQualityRow = dataQualityByCode.get(row.currency_code)?.[0] ?? null;
    const dataCoverageRow = dataCoverageByCode.get(row.currency_code)?.[0] ?? null;
    const dataQuality: DataQuality | null =
      dataQualityRow && dataCoverageRow
        ? {
            score: dataQualityRow.score,
            level: dataQualityRow.score >= 80 ? "HIGH" : dataQualityRow.score >= 50 ? "MEDIUM" : "LOW",
            coveragePct: dataCoverageRow.coverage_pct,
            missingCategories: dataCoverageRow.missing ?? [],
          }
        : null;

    const ledgerFeed: LedgerEntry[] = (ledgerFeedByCode.get(row.currency_code) ?? [])
      .slice(0, LEDGER_FEED_LIMIT_PER_CURRENCY)
      .map((l) => ({
        driverKey: l.driver_key,
        classification: l.classification,
        reasoning: l.reasoning,
        occurredAt: l.occurred_at,
      }));

    return {
      code: row.currency_code,
      score: row.overall_score,
      convictionLabel: row.conviction_label,
      summary: narrative?.narrative ?? row.summary ?? "",
      summaryAudioUrl: narrative?.audio_url ?? null,
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
      thesis,
      dataQuality,
      ledgerFeed,
    };
  });
}

// "Top Fundamentální příležitosti týdne" — jeden řádek napříč všemi měnami (weekly_top_opportunity
// je singleton, viz top-opportunity.mjs), proto samostatná funkce mimo per-měna fetchCurrencies().
export async function fetchTopOpportunity(): Promise<TopOpportunity | null> {
  const result = await withTimeout(
    supabase
      .from("weekly_top_opportunity")
      .select(
        "strongest_currency, strongest_score, strongest_conviction, weakest_currency, weakest_score, weakest_conviction, rationale, confidence_tier, insufficient_data, computed_at"
      )
      .limit(1),
    FETCH_TIMEOUT_MS
  );

  if (result.error) {
    throw new Error(`Nepodařilo se načíst top příležitost týdne: ${result.error.message}`);
  }

  const row = ((result.data ?? []) as WeeklyTopOpportunityRow[])[0] ?? null;
  if (!row) return null;

  return {
    strongestCurrency: row.strongest_currency,
    strongestScore: row.strongest_score,
    strongestConviction: row.strongest_conviction,
    weakestCurrency: row.weakest_currency,
    weakestScore: row.weakest_score,
    weakestConviction: row.weakest_conviction,
    rationale: row.rationale,
    confidenceTier: row.confidence_tier,
    insufficientData: row.insufficient_data,
    computedAt: row.computed_at,
  };
}
