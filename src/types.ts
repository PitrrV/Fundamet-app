export type Verdict = "Souhlasí" | "Neutrální" | "Nesouhlasí";
export type Importance = "NÍZKÁ" | "STŘEDNÍ" | "VYSOKÁ";

export interface EventDetail {
  consensusVsHistory: string;
  pricedInMarket: string;
  cotExtreme: string;
  historicalReaction: {
    label: string; // e.g. "6 / 9"
    trendUp: boolean;
    bars: number[]; // -1..1 relative bar heights, sign = direction
  };
  reasoning: string; // may contain **bold** markers for gold highlight
}

export interface MacroEvent {
  date: string;
  title: string;
  subtitle: string; // "Konsensus 52.1 · Předchozí 51.6"
  importance: Importance;
  pricedInPct: number;
  verdict: Verdict;
  detail: EventDetail;
}

export type DataTier = "cot_only" | "partial" | "full";

export interface CalendarEvent {
  id: number;
  date: string; // YYYY-MM-DD
  title: string;
  impact: "Low" | "Medium" | "High";
  estimate: string | null;
  previous: string | null;
  actual: string | null;
}

export interface PricedIn {
  method: "yield_gap" | "decision_consensus";
  label: string;
  confidenceLevel: "HIGH" | "MEDIUM" | "LOW";
}

export interface CbPolicy {
  rate: number | null;
  cpi: number | null;
  policyLabel: string;
  policyConfidence: "HIGH" | "MEDIUM" | "LOW";
  realYieldAdj: number;
  cbPolicyAdj: number;
  pricedIn: PricedIn;
}

export interface RiskRegime {
  vix: number;
  vix5dChange: number;
  regime: "RISK_ON" | "NEUTRAL" | "RISK_OFF";
}

export interface Scenario {
  event: string;
  date: string;
  ifBeat: string;
  ifMiss: string;
  outcome: string | null; // profesionální komentář ke skutečnému výsledku, jakmile je actual známý
}

export interface ThesisDriver {
  driverKey: string;
  label: string;
  value: number;
  status: "strong" | "weakening";
}

export interface DataQuality {
  score: number; // 0-100
  level: "HIGH" | "MEDIUM" | "LOW";
  coveragePct: number;
  missingCategories: string[];
}

export interface CurrencyThesis {
  direction: "bullish" | "bearish" | "neutral";
  conviction: number; // 0..5
  drivers: ThesisDriver[];
  thesisSummary: string | null;
  status: "active" | "watching" | "invalidated";
  confirmStreak: number;
  challengeStreak: number;
  openedAt: string;
}

export interface LedgerEntry {
  driverKey: string | null;
  classification: "confirms" | "challenges" | "invalidates_driver" | "opened" | "closed";
  reasoning: string;
  occurredAt: string;
}

export interface TopOpportunity {
  strongestCurrency: string | null;
  strongestScore: number | null;
  strongestConviction: number | null;
  weakestCurrency: string | null;
  weakestScore: number | null;
  weakestConviction: number | null;
  rationale: string | null;
  insufficientData: boolean;
  computedAt: string;
}

export interface CurrencyData {
  code: string;
  score: number; // -5..+5
  convictionLabel: string;
  summary: string; // narrative z OpenAI (nebo starší COT-only text jako fallback); může obsahovat **bold**
  summaryAudioUrl: string | null; // TTS namluvení summary (OpenAI tts-1), null dokud se nevygeneruje
  cotPositioning: string;
  pricedIn: string | null; // "zaceněnost" poslední CB rozhodnutí — z cbPolicy.pricedIn.label
  longTermBias: string | null; // z cbPolicy.policyLabel (CB politický cyklus)
  dataTier: DataTier;
  events: MacroEvent[];
  fundamentalScore: number | null; // null = fundamentální pilíř zatím nemá data pro tuhle měnu
  forwardFlag: string | null;
  convictionNote: string | null;
  calendarEvents: CalendarEvent[]; // nadcházející, reálná
  cbPolicy: CbPolicy | null;
  retailScore: number | null; // -5..+5, kontrariánské skóre z CFTC non-reportable pozic
  cotPercentile: number | null; // 0-100, "jak crowded" je současné COT pozicování
  convictionStars: number | null; // 0-5, kolik nezávislých signálů souhlasí se směrem overall_score
  convictionReasons: string[];
  riskRegime: RiskRegime | null;
  scenarios: Scenario[]; // "když X, tak Y" predikce pro nejbližší klíčové eventy
  thesis: CurrencyThesis | null; // Gen2 Thesis Engine — teze s pamětí napříč dny, null dokud appka žádnou neotevřela
  dataQuality: DataQuality | null; // Gen3.5 CDQE Fáze 1 — kvalita/pokrytí vstupních dat, ne kvalita samotné teze
  ledgerFeed: LedgerEntry[]; // "Co se změnilo?" — historie potvrzení/zpochybnění teze (thesis_ledger)
}
