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

export interface CurrencyData {
  code: string;
  score: number; // -5..+5
  convictionLabel: string;
  summary: string; // may contain **bold** markers
  cotPositioning: string;
  pricedIn: string;
  longTermBias: string;
  events: MacroEvent[];
}
