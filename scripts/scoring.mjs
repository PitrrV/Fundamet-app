// Čisté funkce pro výpočet COT skóre — žádné I/O, snadno testovatelné izolovaně.
// Váhy i délka okna jsou editorská volba prvního řezu, NEJSOU zpětně otestované (backtested).

const TRAILING_WEEKS = 156; // ~3 roky, pro z-skóre extremity
const Z_CLAMP = 3;
const MOMENTUM_CLAMP = 1;
const WEIGHT_EXTREMITY = 0.6;
const WEIGHT_MOMENTUM = 0.4;

function mean(arr) {
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function stdev(arr, avg) {
  const variance = arr.reduce((sum, v) => sum + (v - avg) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {Array<{report_date: string, lev_money_net: number}>} historyAsc - seřazeno vzestupně podle data, poslední prvek = aktuální týden
 */
export function computeCotScore(historyAsc) {
  if (historyAsc.length === 0) {
    return null;
  }

  const latest = historyAsc[historyAsc.length - 1];
  const prev = historyAsc.length >= 2 ? historyAsc[historyAsc.length - 2] : null;
  const fourWeeksAgo = historyAsc.length >= 5 ? historyAsc[historyAsc.length - 5] : null;

  const trailing = historyAsc.slice(Math.max(0, historyAsc.length - 1 - TRAILING_WEEKS), historyAsc.length - 1);
  const trailingNets = trailing.map((r) => r.lev_money_net);

  let zscore = 0;
  if (trailingNets.length >= 8) {
    const avg = mean(trailingNets);
    const sd = stdev(trailingNets, avg);
    zscore = sd === 0 ? 0 : (latest.lev_money_net - avg) / sd;
  }

  const wowChange = prev ? latest.lev_money_net - prev.lev_money_net : null;
  const change4w = fourWeeksAgo ? latest.lev_money_net - fourWeeksAgo.lev_money_net : null;

  // 4týdenní změny v trailing okně, pro normalizaci momenta na srovnatelnou škálu
  const trailing4wChanges = [];
  for (let i = 4; i < trailing.length; i++) {
    trailing4wChanges.push(Math.abs(trailing[i].lev_money_net - trailing[i - 4].lev_money_net));
  }
  const meanAbs4wChange = trailing4wChanges.length >= 8 ? mean(trailing4wChanges) : null;

  const scaledZ = clamp(zscore, -Z_CLAMP, Z_CLAMP) * (5 / Z_CLAMP);
  const scaledMomentum =
    change4w !== null && meanAbs4wChange && meanAbs4wChange > 0
      ? clamp(change4w / meanAbs4wChange, -MOMENTUM_CLAMP, MOMENTUM_CLAMP) * 5
      : 0;

  const cotScore = Math.round(
    clamp(WEIGHT_EXTREMITY * scaledZ + WEIGHT_MOMENTUM * scaledMomentum, -5, 5) * 10
  ) / 10;

  return {
    reportDate: latest.report_date,
    levMoneyNet: latest.lev_money_net,
    zscore: Math.round(zscore * 100) / 100,
    wowChange,
    change4w,
    cotScore,
  };
}

/**
 * Percentil pořadí posledního čistého pozicování v trailing okně — "jak crowded" je dnešní
 * pozice vůči vlastní historii (ne z-skóre, ale prosté pořadí: 90. percentil = vyšší než 90 %
 * pozorování za posledních ~3 roky). Používá se jako risk-filtr pro konvicience (viz
 * scripts/fetch-calendar.mjs), ne jako směrový signál.
 * @param {Array<{report_date: string, lev_money_net: number}>} historyAsc
 */
export function cotPercentile(historyAsc) {
  const trailing = historyAsc.slice(Math.max(0, historyAsc.length - 1 - TRAILING_WEEKS), historyAsc.length);
  if (trailing.length < 12) return null;

  const latest = trailing[trailing.length - 1].lev_money_net;
  const rest = trailing.slice(0, -1).map((r) => r.lev_money_net);
  if (rest.length === 0) return null;

  return Math.round((rest.filter((v) => v <= latest).length / rest.length) * 100);
}

export function cotPositioningLabel(zscore) {
  if (zscore > 2) return "Blízko extrému (long)";
  if (zscore < -2) return "Blízko extrému (short)";
  if (zscore > 0.5) return "Mírně long";
  if (zscore < -0.5) return "Mírně short";
  return "Neutrální";
}

export function convictionLabel(cotScore) {
  const abs = Math.abs(cotScore);
  const base = abs >= 3 ? "VYSOKÁ" : abs >= 1 ? "STŘEDNÍ" : "NÍZKÁ";
  return `${base} CONVICTION (POUZE COT · 1/5 PILÍŘŮ)`;
}

// Nezávislý audit (Fable, 3.9.2026), položka #4: poslední věta ("Skóre vychází výhradně z COT
// pozicování — 1 z 5 plánovaných pilířů...") popisovala stav appky z DOBY, kdy fundamentální/
// CB-policy/risk-regime/retail pilíře ještě neexistovaly. Ty dnes existují a `summary` se přesto
// pořád píše STEJNĚ falešně u KAŽDÉHO ingestu (viz ingest-cot.mjs), i pro měny, které fetch-
// calendar.mjs dávno přeblendoval přes všech 5 pilířů — na rozdíl od overall_score/conviction_*,
// `summary` žádnou "už nablendováno, nepřepisuj" pojistku nemá.
//
// Blast radius je větší, než jen zavádějící text v promptu pro generate-narrative.mjs: pokud AI
// shrnutí (latest_narratives.narrative) chybí nebo je stažené (viz src/types.ts komentář u
// `summary`), appka `row.summary` ukazuje PŘÍMO uživateli jako fallback (fetchCurrencies.ts).
// Živě zachyceno: uživatel by tak mohl vidět "sazbová očekávání, makro překvapení, sentiment a
// sezónnost zatím nejsou zapojeny" u měny, která je dávno plně nablendovaná.
//
// Oprava: popsat jen to, co tahle funkce doopravdy ví (COT snímek samotný) — bez tvrzení o tom,
// kolik pilířů appka celkově používá, což tahle funkce nemůže vědět a časem se to stejně mění.
export function buildSummary({ levMoneyNet, zscore, wowChange, positioningLabel }) {
  const direction = levMoneyNet >= 0 ? "long" : "short";
  const wowText =
    wowChange === null
      ? "bez srovnání s předchozím týdnem (první dostupná data)"
      : `týdenní změna ${wowChange >= 0 ? "+" : ""}${wowChange} kontraktů`;

  return (
    `Leveraged funds drží čistou ${direction} pozici ${Math.abs(levMoneyNet)} kontraktů ` +
    `(z-skóre ${zscore.toFixed(2)}, ${positioningLabel.toLowerCase()}), ${wowText}.`
  );
}
