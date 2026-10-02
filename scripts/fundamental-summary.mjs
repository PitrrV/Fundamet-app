// Celkové skóre a conviction měny — ČISTĚ z fundamentu. COT, retail sentiment ani VIX/risk režim
// do něj nevstupují (jsou to pozicování a tržní kontext, ne fundament; COT se zobrazuje zvlášť
// jako doplňkový údaj, retail a VIX řeší Fx-Analyzer). Čisté funkce, žádné I/O.

export const MAX_CONVICTION = 3;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * overall_score = fundamentální skóre (překvapení z kalendáře) + real yield + CB politika,
 * ořezané na -5..5. `realYieldAdj` může být null (chybí spolehlivé CPI) — pak tenhle pilíř
 * nic nepřidává, nic se nedomýšlí.
 */
export function computeOverallScore({ fundamentalScore, realYieldAdj, cbPolicyAdj }) {
  const raw = clamp(fundamentalScore + (realYieldAdj ?? 0) + cbPolicyAdj, -5, 5);
  return { fundamentalScoreAdj: raw, overallScore: Math.round(raw * 10) / 10 };
}

/**
 * Conviction = kolik ze 3 nezávislých fundamentálních pohledů (CB politika, real yield,
 * fundament z kalendáře) ukazuje stejným směrem jako celkové skóre. Max 3.
 */
export function computeConviction(overallScore, { cbPolicyAdj, realYieldAdj, fundamentalScoreAdj, policyLabel }) {
  if (overallScore === 0) return { stars: 0, reasons: [] };
  const dir = overallScore > 0 ? 1 : -1;
  // null = o reálném výnosu té měny nic nevíme, hvězda se neuděluje (není to totéž jako "nesouhlasí").
  const signAgrees = (v) => v !== null && v !== undefined && v !== 0 && Math.sign(v) === dir;

  const reasons = [];
  let stars = 0;

  if (signAgrees(cbPolicyAdj)) {
    stars++;
    reasons.push(`CB politika: ${policyLabel}`);
  }
  if (signAgrees(realYieldAdj)) {
    stars++;
    reasons.push(`Real yield: ${realYieldAdj > 0 ? "+" : ""}${realYieldAdj} vůči průměru koše měn`);
  }
  if (Math.abs(fundamentalScoreAdj) >= 1 && signAgrees(fundamentalScoreAdj)) {
    stars++;
    reasons.push(`Fundament/kalendář: ${fundamentalScoreAdj > 0 ? "+" : ""}${Math.round(fundamentalScoreAdj * 10) / 10}`);
  }
  return { stars: Math.min(MAX_CONVICTION, stars), reasons };
}

export function convictionLabelFromStars(stars) {
  const base = stars >= 3 ? "VYSOKÁ" : stars >= 2 ? "STŘEDNÍ" : "NÍZKÁ";
  return `${base} CONVICTION (${stars}/${MAX_CONVICTION} FUNDAMENTÁLNÍCH SIGNÁLŮ SOUHLASÍ)`;
}
