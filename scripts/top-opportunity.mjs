// "Top Fundamentální příležitosti týdne" — v2. Appka VŽDY ukáže nejsilnější a nejslabší měnu
// podle overall_score (žádná hvězdičková brána) — cílem je rychle ukázat, kde je teď
// nejvýraznější fundamentální příběh, ne mlčet, když konvikce zrovna není na plné síle.
// Poctivost se řeší odstupňovaným `confidence_tier`, ne skrýváním výsledku:
//   "strong" — obě strany mají ≥3/5 hvězd a kvalita dat u obou není nízká
//   "soft"   — reálný rozestup existuje, ale konvikce/kvalita dat zatím nejsou na plné úrovni
//   "flat"   — rozestup mezi nejsilnější a nejslabší měnou je tenhle týden malý, trh je plochý
// Čistě INSPIRACE pro další zkoumání, NIKDY signál ke vstupu — appka neřeší timing, risk
// management ani technickou konfluenci, to je úloha Fx Analyzeru (viz oddělení rolí v App.tsx).
//
// Žádný LLM — stejná filozofie jako zbytek systému (thesis-engine.mjs, data-quality.mjs):
// rozhodnutí jsou deterministická a auditovatelná, ne "protože to model tak napsal".

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const FLAT_SPREAD_THRESHOLD = 1.0;
const STRONG_MIN_CONVICTION = 3;
const STRONG_MIN_DATA_QUALITY = 50;

function dirLabel(d) {
  return d === "bullish" ? "bullish" : d === "bearish" ? "bearish" : "neutrální";
}

function computeTier(strongest, weakest, spread) {
  if (spread < FLAT_SPREAD_THRESHOLD) return "flat";
  const qualityOk = (c) => c.qualityScore === null || c.qualityScore >= STRONG_MIN_DATA_QUALITY;
  if (
    strongest.convictionStars >= STRONG_MIN_CONVICTION &&
    weakest.convictionStars >= STRONG_MIN_CONVICTION &&
    qualityOk(strongest) &&
    qualityOk(weakest)
  ) {
    return "strong";
  }
  return "soft";
}

function buildRationale(strongest, weakest, tier) {
  const base =
    `${strongest.currencyCode}: ${dirLabel(strongest.direction)} teze, ${strongest.convictionStars}/5 hvězd, ` +
    `skóre ${strongest.overallScore > 0 ? "+" : ""}${strongest.overallScore}. ` +
    `${weakest.currencyCode}: ${dirLabel(weakest.direction)} teze, ${weakest.convictionStars}/5 hvězd, ` +
    `skóre ${weakest.overallScore > 0 ? "+" : ""}${weakest.overallScore}.`;

  if (tier === "flat") {
    return `${base} Rozestup mezi nejsilnější a nejslabší měnou je teď malý — trh nemá tenhle týden jasně nejsilnější fundamentální příběh.`;
  }
  if (tier === "soft") {
    return `${base} Nejvýraznější dostupný rozdíl tenhle týden, ale konvikce nebo kvalita dat zatím nejsou na plné úrovni — ber to jako slabší podnět k dalšímu zkoumání.`;
  }
  return `${base} Obě teze jsou podpořené více nezávislými signály a kvalita dat u obou není nízká.`;
}

export async function computeTopOpportunity() {
  if (!supabase) {
    console.warn("top-opportunity přeskočen — chybí Supabase env.");
    return;
  }

  const [{ data: scores, error: scoresErr }, { data: theses, error: thesesErr }, { data: quality, error: qualityErr }] =
    await Promise.all([
      supabase.from("latest_confluence_scores").select("currency_code, overall_score, conviction_stars"),
      supabase.from("latest_currency_thesis").select("currency_code, direction, conviction"),
      supabase.from("data_quality_score").select("currency_code, score"),
    ]);

  if (scoresErr || thesesErr || qualityErr) {
    console.error("top-opportunity chyba čtení:", scoresErr?.message, thesesErr?.message, qualityErr?.message);
    return;
  }

  const thesisByCode = new Map((theses ?? []).map((t) => [t.currency_code, t]));
  const qualityByCode = new Map((quality ?? []).map((q) => [q.currency_code, q.score]));

  // Žádný filtr na konvikci/kvalitu dat/status teze — appka srovnává VŠECHNY měny se skóre.
  // Konvikce a kvalita dat rozhodují jen o tónu rationale (confidence_tier), ne o tom, jestli
  // se sekce vůbec zobrazí.
  const candidates = (scores ?? [])
    .filter((s) => s.overall_score !== null && s.overall_score !== undefined)
    .map((s) => {
      const thesis = thesisByCode.get(s.currency_code);
      return {
        currencyCode: s.currency_code,
        overallScore: s.overall_score,
        convictionStars: s.conviction_stars ?? 0,
        direction: thesis?.direction ?? null,
        qualityScore: qualityByCode.get(s.currency_code) ?? null,
      };
    });

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
        confidence_tier: null,
        insufficient_data: true,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
    if (error) console.error("top-opportunity chyba upsertu (insufficient_data):", error.message);
    else console.log(`top-opportunity: méně než 2 měny mají spočítané skóre (${candidates.length}) — zatím není co srovnat.`);
    return;
  }

  const sorted = candidates.slice().sort((a, b) => b.overallScore - a.overallScore);
  const strongest = sorted[0];
  const weakest = sorted[sorted.length - 1];
  const spread = strongest.overallScore - weakest.overallScore;
  const tier = computeTier(strongest, weakest, spread);

  const { error: upsertErr } = await supabase.from("weekly_top_opportunity").upsert(
    {
      id: true,
      strongest_currency: strongest.currencyCode,
      strongest_score: strongest.overallScore,
      strongest_conviction: strongest.convictionStars,
      weakest_currency: weakest.currencyCode,
      weakest_score: weakest.overallScore,
      weakest_conviction: weakest.convictionStars,
      rationale: buildRationale(strongest, weakest, tier),
      confidence_tier: tier,
      insufficient_data: false,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );

  if (upsertErr) {
    console.error("top-opportunity chyba upsertu:", upsertErr.message);
    return;
  }

  console.log(
    `top-opportunity: nejsilnější=${strongest.currencyCode} (${strongest.overallScore}), nejslabší=${weakest.currencyCode} (${weakest.overallScore}), tier=${tier}.`
  );
}
