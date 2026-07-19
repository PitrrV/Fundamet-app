import { supabase } from "./supabaseClient";
import type { CurrencyData, DataTier } from "../types";

interface LatestConfluenceScoreRow {
  currency_code: string;
  cot_score: number;
  overall_score: number;
  data_tier: DataTier;
  conviction_label: string;
  cot_positioning_label: string | null;
  summary: string | null;
}

const FETCH_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Databáze neodpověděla do ${ms / 1000} s.`)), ms)
    ),
  ]);
}

// Zaceněnost a dlouhodobý bias zatím nemají reálný datový zdroj (viz plán) —
// vždy null, dokud nepřibude kalendář/rate-expectations pilíř.
export async function fetchCurrencies(): Promise<CurrencyData[]> {
  const { data, error } = await withTimeout(
    supabase
      .from("latest_confluence_scores")
      .select(
        "currency_code, cot_score, overall_score, data_tier, conviction_label, cot_positioning_label, summary"
      )
      .order("currency_code", { ascending: true }),
    FETCH_TIMEOUT_MS
  );

  if (error) {
    throw new Error(`Nepodařilo se načíst confluence skóre: ${error.message}`);
  }

  return ((data ?? []) as LatestConfluenceScoreRow[]).map((row) => ({
    code: row.currency_code,
    score: row.overall_score,
    convictionLabel: row.conviction_label,
    summary: row.summary ?? "",
    cotPositioning: row.cot_positioning_label ?? "Neznámé",
    pricedIn: null,
    longTermBias: null,
    dataTier: row.data_tier,
    events: [],
  }));
}
