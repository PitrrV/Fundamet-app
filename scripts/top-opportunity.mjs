// "Top Fundamentální příležitosti týdne" — deterministický výběr nejsilnější a nejslabší měny
// podle fundamentálního biasu (overall_score + aktivní teze s dostatečnou konvikcí a kvalitou
// dat). Čistě INSPIRACE pro další zkoumání, NIKDY signál ke vstupu — appka neřeší timing, risk
// management ani technickou konfluenci, to je úloha Fx Analyzeru (viz oddělení rolí v App.tsx).
//
// Žádný LLM — stejná filozofie jako zbytek systému (thesis-engine.mjs, data-quality.mjs):
// rozhodnutí jsou deterministická a auditovatelná, ne "protože to model tak napsal".

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// Editorské prahy (stejná konvence jako zbytek systému) — appka radši nic nenavrhne, než by
// navrhla pár postavený na slabé konvikci nebo nespolehlivých datech.
const MIN_CONVICTION = 3;
const MIN_DATA_QUALITY_SCORE = 50;

function buildRationale(strongest, weakest) {
  const dirLabel = (d) => (d === "bullish" ? "bullish" : d === "bearish" ? "bearish" : "neutrální");
  return (
    `${strongest.currencyCode}: ${dirLabel(strongest.direction)} teze, ${strongest.convictionStars}/5 hvězd, ` +
    `skóre ${strongest.overallScore > 0 ? "+" : ""}${strongest.overallScore}. ` +
    `${weakest.currencyCode}: ${dirLabel(weakest.direction)} teze, ${weakest.convictionStars}/5 hvězd, ` +
    `skóre ${weakest.overallScore > 0 ? "+" : ""}${weakest.overallScore}. ` +
    `Obě teze jsou aktivní (ne "sleduje se") a kvalita dat u obou není nízká.`
  );
}

export async function computeTopOpportunity() {
  if (!supabase) {
    console.warn("top-opportunity přeskočen — chybí Supabase env.");
    return;
  }

  const [{ data: scores, error: scoresErr }, { data: theses, error: thesesErr }, { data: quality, error: qualityErr }] =
    await Promise.all([
      supabase.from("latest_confluence_scores").select("currency_code, overall_score, conviction_stars"),
      supabase.from("latest_currency_thesis").select("currency_code, direction, conviction, status"),
      supabase.from("data_quality_score").select("currency_code, score"),
    ]);

  if (scoresErr || thesesErr || qualityErr) {
    console.error("top-opportunity chyba čtení:", scoresErr?.message, thesesErr?.message, qualityErr?.message);
    return;
  }

  const thesisByCode = new Map((theses ?? []).map((t) => [t.currency_code, t]));
  const qualityByCode = new Map((quality ?? []).map((q) => [q.currency_code, q.score]));

  const candidates = (scores ?? [])
    .map((s) => {
      const thesis = thesisByCode.get(s.currency_code);
      return {
        currencyCode: s.currency_code,
        overallScore: s.overall_score,
        convictionStars: s.conviction_stars ?? 0,
        direction: thesis?.direction ?? null,
        status: thesis?.status ?? null,
        qualityScore: qualityByCode.get(s.currency_code) ?? null,
      };
    })
    .filter((c) => c.status === "active")
    .filter((c) => c.convictionStars >= MIN_CONVICTION)
    .filter((c) => c.qualityScore === null || c.qualityScore >= MIN_DATA_QUALITY_SCORE);

  if (candidates.length < 2) {
    const { error } = await supabase.from("weekly_top_opportunity").upsert(
      {
        id: true,
        strongest_currency: null,
        strongest_score: null,
        strongest_conviction: null,
        weakest_currency: null,
        weakest_score: null,
        weakest_conviction: null,
        rationale: null,
        insufficient_data: true,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
    if (error) console.error("top-opportunity chyba upsertu (insufficient_data):", error.message);
    else console.log(`top-opportunity: nedostatek kvalitních kandidátů (${candidates.length}/8 splňuje prahy) — nic nenavrženo.`);
    return;
  }

  const sorted = candidates.slice().sort((a, b) => b.overallScore - a.overallScore);
  const strongest = sorted[0];
  const weakest = sorted[sorted.length - 1];

  const { error: upsertErr } = await supabase.from("weekly_top_opportunity").upsert(
    {
      id: true,
      strongest_currency: strongest.currencyCode,
      strongest_score: strongest.overallScore,
      strongest_conviction: strongest.convictionStars,
      weakest_currency: weakest.currencyCode,
      weakest_score: weakest.overallScore,
      weakest_conviction: weakest.convictionStars,
      rationale: buildRationale(strongest, weakest),
      insufficient_data: false,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );

  if (upsertErr) {
    console.error("top-opportunity chyba upsertu:", upsertErr.message);
    return;
  }

  console.log(`top-opportunity: nejsilnější=${strongest.currencyCode} (${strongest.overallScore}), nejslabší=${weakest.currencyCode} (${weakest.overallScore}).`);
}
