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
  date: string; // YYYY-MM-DD
  title: string;
  impact: "Low" | "Medium" | "High";
  estimate: string | null;
  previous: string | null;
  actual: string | null;
}

export interface CurrencyData {
  code: string;
  score: number; // -5..+5
  convictionLabel: string;
  summary: string; // narrative z OpenAI (nebo starší COT-only text jako fallback); může obsahovat **bold**
  cotPositioning: string;
  pricedIn: string | null; // null = zdroj zatím není napojen, nezobrazovat fabrikované číslo
  longTermBias: string | null; // null = zdroj zatím není napojen
  dataTier: DataTier;
  events: MacroEvent[];
  fundamentalScore: number | null; // null = fundamentální pilíř zatím nemá data pro tuhle měnu
  forwardFlag: string | null;
  convictionNote: string | null;
  calendarEvents: CalendarEvent[]; // nadcházející, reálná
}
