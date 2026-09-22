// Phase 4 — Shadow Fundamental Engine. Čisté funkce (extrakce/normalizace/Absolute/Relative)
// + orchestrátor s DB I/O. Implementuje POUZE "NOW + SHADOW" vrstvu z Phase 3.7 designu:
// počítá a ukládá, ale NIKDY nezapisuje do produkčních tabulek (confluence_scores,
// currency_thesis, fundamental_scores, cb_policy_state) ani nevolá recomputeScores().
//
// Tvrdá pravidla (viz Phase 3.7/Phase 4 zadání):
// - COT, retail sentiment, VIX/risk regime a cena (fx_price_daily) sem NIKDY nevstupují.
// - computeFundamentalScore() (Data Momentum) se jen ČTE jako referenční hodnota, nikdy
//   se nepřepočítává jinak a nemění se jeho váhy/historie/UI interpretace.
// - Real Yield (computeRealYieldAdj, cb-policy.mjs) se používá BEZE ZMĚNY — žádný nový vzorec.
// - Real Yield je samostatná paralelní vrstva, NIKDY neblenduje do Absolute Fundamental
//   Condition (mixovala by dvě různé škály — z-score -3..+3 vs. computeRealYieldAdj -1..+1 —
//   a koncepčně měří jinou otázku: "kompenzuje politika inflaci", ne "jaký je stav ekonomiky").
// - Chybějící data se NIKDY nedomýšlí (žádný `?? fallback`) — blok zůstává `null` a promítne
//   se do blocks_missing/data_quality.

import { matchRule } from "./fundamental-scoring.mjs";
import { extractLatestCpi, computeRealYieldAdj } from "./cb-policy.mjs";

export const SHADOW_MODEL_VERSION = "shadow-v1";

// 5 "state/activity" bloků tvořících Absolute Fundamental Condition. Real Yield je záměrně
// mimo tenhle seznam — viz komentář výš.
export const STATE_BLOCKS = ["inflation", "labor", "growth", "demand", "pmi"];
export const MIN_BLOCKS_REQUIRED = 4; // z 5 state/activity bloků, jinak Absolute = null

// Stejná konvence jako scoring.mjs (COT z-score): minimální počet historických pozorování,
// než appka vůbec zkusí počítat normalized hodnotu, a stejný clip strop ±3.
export const MIN_HISTORY_N = 8;
export const Z_CLAMP = 3;

// Veřejně publikované mandáty centrálních bank (ne odhad appky) — u pásmových mandátů (CHF/AUD/
// NZD) je použit střed pásma, explicitně označeno jako proxy, ne oficiální bodový cíl.
export const CB_INFLATION_TARGET = {
  USD: 2.0, // Fed — oficiální cíl je 2 % PCE, CPI je použito jako proxy (PCE appka nesbírá)
  EUR: 2.0, // ECB — symetrický 2 % cíl (HICP)
  JPY: 2.0, // BOJ — price stability target
  GBP: 2.0, // BoE — CPI cíl
  CHF: 1.0, // SNB — "cenová stabilita" = CPI růst <2 %/rok, žádný oficiální bodový cíl; střed 0–2 % pásma jako proxy
  CAD: 2.0, // BoC — kontrolní pásmo 1–3 %, střed
  AUD: 2.5, // RBA — cílové pásmo 2–3 %, střed
  NZD: 2.0, // RBNZ — cílové pásmo 1–3 %, střed
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stdev(arr, avg) {
  const variance = arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}
function round2(v) {
  return v === null || v === undefined ? null : Math.round(v * 100) / 100;
}

// EUR je jediná vícenárodní měna v koši — národní podkomponenty (Německo/Francie/Itálie/
// Španělsko) NEJSOU EA agregát a nesmí vstoupit do EUR bloků. Ověřeno živě proti DB
// (2026-09-22): agregátní tituly nemají žádný prefix ("Final CPI y/y", "Unemployment Rate",
// "Retail Sales m/m", "Final Services PMI"), národní mají vždy prefix země.
export function isNationalEuroTitle(title) {
  return /^(german|french|italian|spanish)\b/i.test((title || "").trim());
}

// ---------------------------------------------------------------------------------------------
// Raw extrakce per blok. Inflation reuse extractLatestCpi (cb-policy.mjs) beze změny — viz
// findSourceEventForInflation níž pro dohledání zdrojového eventu k PIT uložení.
// ---------------------------------------------------------------------------------------------

// Historický backfill Inflation bloku — VŽDY přes extractLatestCpi (žádná paralelní logika):
// appka pro každé datum, kdy se mohla objevit nová headline CPI hodnota, zavolá extractLatestCpi
// jen s eventy DO TOHOTO DATA (striktní PIT — "co by extractLatestCpi řekla tehdy"), takže
// backfill je 100% stejný výběr, jaký appka použije i live, jen aplikovaný zpětně na existující
// historii v calendar_events (appka na ForexFactory zpětně nic nevymýšlí, jen přehrává už
// zachycená data).
export function extractInflationHistory(currencyCode, events) {
  // extractLatestCpi (cb-policy.mjs) se reuse BEZE ZMĚNY (Phase 4 mandát) a sama o sobě
  // nevylučuje EUR národní podkomponenty (German/French/Italian/Spanish Flash CPI atd.) — je to
  // stejná funkce, co v produkci počítá Real Yield pro VŠECHNY měny, takže její vlastní kód se
  // NESMÍ upravovat. Řešení: appka jí místo toho NIKDY nepředá národní EUR tituly na vstupu —
  // filtruje se VSTUPNÍ pole eventů, ne samotná funkce. Produkční volání v cb-policy.mjs
  // (computeCbPolicyState) tenhle filtr nemá a zůstává beze změny — viz komentář na začátku
  // souboru, proč je tohle jediný bezpečný způsob, jak dodržet zároveň "reuse beze změny" i
  // "EUR jen EA agregát".
  const nonNationalEvents = events.filter((e) => !isNationalEuroTitle(e.event_title));

  const candidateDays = [
    ...new Set(
      nonNationalEvents
        .filter(
          (e) =>
            e.currency_code === currencyCode &&
            e.actual != null &&
            matchRule(e.event_title)?.cat === "Inflation" &&
            /cpi/i.test(e.event_title || "")
        )
        .map((e) => e.event_day)
    ),
  ].sort();

  const history = [];
  for (const day of candidateDays) {
    const eventsUpToDay = nonNationalEvents.filter((e) => e.event_day <= day);
    const value = extractLatestCpi(currencyCode, eventsUpToDay);
    if (value === null) continue;
    const source = findSourceEventForInflation(currencyCode, eventsUpToDay, value);
    if (!source) continue;
    const last = history[history.length - 1];
    if (last && last.eventDay === source.event_day) continue; // stejný zdrojový event, nepřidávej duplicitně
    history.push({ value, title: source.event_title, eventDay: source.event_day, vintage: null, unit: "pct_yoy" });
  }
  return history;
}

export function findSourceEventForInflation(currencyCode, events, value) {
  if (value === null || value === undefined) return null;
  const candidates = events
    .filter(
      (e) =>
        e.currency_code === currencyCode &&
        e.actual != null &&
        matchRule(e.event_title)?.cat === "Inflation" &&
        /cpi/i.test(e.event_title || "") &&
        Math.abs(parseFloat(e.actual) - value) < 0.05
    )
    .sort((a, b) => new Date(b.event_day) - new Date(a.event_day));
  return candidates[0] ?? null;
}

// Obecný pomocník: VŠECHNA platná pozorování (ne jen nejnovější), chronologicky vzestupně —
// nutné pro historický backfill normalizace (viz normalizeAgainstHistory níž), appka totiž musí
// znát celou dostupnou historii bloku, ne jen jeho aktuální hodnotu.
function historyFromPattern(currencyCode, events, titlePattern, { min, max }) {
  return events
    .filter(
      (e) =>
        e.currency_code === currencyCode &&
        e.actual != null &&
        titlePattern.test((e.event_title || "").trim()) &&
        !isNationalEuroTitle(e.event_title)
    )
    .map((e) => ({ value: round2(parseFloat(e.actual)), title: e.event_title, eventDay: e.event_day }))
    .filter((o) => !Number.isNaN(o.value) && o.value >= min && o.value <= max)
    .sort((a, b) => new Date(a.eventDay) - new Date(b.eventDay));
}

const UNEMPLOYMENT_PATTERN = /^unemployment rate$/i;
export function extractUnemploymentHistory(currencyCode, events) {
  return historyFromPattern(currencyCode, events, UNEMPLOYMENT_PATTERN, { min: 0, max: 35 }).map((o) => ({
    ...o,
    vintage: null,
    unit: "pct_rate",
  }));
}

export function extractLatestUnemployment(currencyCode, events) {
  const history = extractUnemploymentHistory(currencyCode, events);
  return history.length > 0 ? history[history.length - 1] : null;
}

// Vintages STEJNÉ čtvrtky (Advance/Prelim/Final) vycházejí v rozestupu max. ~65 dní; RŮZNÉ
// čtvrtky jsou od sebe ~90 dní. Greedy okno 75 dní tak spolehlivě sesbírá vintages jedné čtvrtky
// do jedné skupiny, aniž by slilo dvě sousední čtvrtky — z každé skupiny appka bere pozorování s
// NEJNOVĚJŠÍM event_day (nejúplnější dostupnou vintage), ne fabrikovaný průměr přes vintages.
function collapseVintageGroups(rowsAsc, windowDays = 75) {
  const groups = [];
  let current = [];
  for (const r of rowsAsc) {
    if (current.length === 0) {
      current.push(r);
      continue;
    }
    const spanDays = (new Date(r.eventDay).getTime() - new Date(current[0].eventDay).getTime()) / 86400000;
    if (spanDays <= windowDays) current.push(r);
    else {
      groups.push(current);
      current = [r];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.map((g) => [...g].sort((a, b) => new Date(b.eventDay) - new Date(a.eventDay))[0]);
}

function growthVintageOf(title) {
  if (/advance/i.test(title)) return "advance";
  if (/flash/i.test(title)) return "flash";
  if (/prelim/i.test(title)) return "prelim";
  if (/revised/i.test(title)) return "revised";
  if (/final/i.test(title)) return "final";
  return "single";
}

// GDP Price Index je deflátor (inflačně příbuzná série), ne reálný růstový ukazatel — vyloučeno.
const GROWTH_EXCLUDE = /price index/i;
export function extractGrowthHistory(currencyCode, events) {
  const rows = historyFromPattern(currencyCode, events, /gdp/i, { min: -20, max: 20 }).filter(
    (o) => !GROWTH_EXCLUDE.test(o.title)
  );
  const collapsed = collapseVintageGroups(rows).sort((a, b) => new Date(a.eventDay) - new Date(b.eventDay));
  return collapsed.map((o) => ({
    ...o,
    vintage: growthVintageOf(o.title),
    unit: /m\/m/i.test(o.title) ? "pct_mom" : /q\/q/i.test(o.title) ? "pct_qoq" : "pct",
  }));
}

export function extractLatestGrowth(currencyCode, events) {
  const history = extractGrowthHistory(currencyCode, events);
  return history.length > 0 ? history[history.length - 1] : null;
}

// Jen headline Retail Sales (m/m nebo y/y nebo q/q, dle měny) — bez "Core"/"BRC"/národních
// prefixů. GBP "BRC Retail Sales Monitor" je soukromý (retail sektor) proxy index, ne oficiální
// ONS data — appka pro GBP má oficiální "Retail Sales m/m" k dispozici, proto BRC vynecháno.
const RETAIL_SALES_PATTERN = /^retail sales (m\/m|y\/y|q\/q)$/i;
export function extractRetailSalesHistory(currencyCode, events) {
  return historyFromPattern(currencyCode, events, RETAIL_SALES_PATTERN, { min: -30, max: 30 }).map((o) => ({
    ...o,
    vintage: null,
    unit: /m\/m/i.test(o.title) ? "pct_mom" : /y\/y/i.test(o.title) ? "pct_yoy" : "pct_qoq",
  }));
}

export function extractLatestRetailSales(currencyCode, events) {
  const history = extractRetailSalesHistory(currencyCode, events);
  return history.length > 0 ? history[history.length - 1] : null;
}

// Explicitní whitelist místo obecného keyword-matchingu — vyhne se EUR národním PMI a CAD
// regionálnímu "Ivey PMI" (samostatný, ne oficiální manufacturing/services index). Prázdné pole
// = u téhle měny appka na ForexFactory daný subindex nemá (DATA GAP, ne bug) — ověřeno živě
// 2026-09-22: JPY/CHF/CAD nemají žádný Services PMI titul, NZD nemá PMI vůbec.
export const PMI_TITLES = {
  USD: { manufacturing: ["ISM Manufacturing PMI"], services: ["ISM Services PMI"] },
  EUR: { manufacturing: ["Final Manufacturing PMI", "Flash Manufacturing PMI"], services: ["Final Services PMI", "Flash Services PMI"] },
  GBP: { manufacturing: ["Final Manufacturing PMI", "Flash Manufacturing PMI"], services: ["Final Services PMI", "Flash Services PMI"] },
  JPY: { manufacturing: ["Final Manufacturing PMI", "Flash Manufacturing PMI"], services: [] },
  CHF: { manufacturing: ["Manufacturing PMI"], services: [] },
  CAD: { manufacturing: ["Manufacturing PMI"], services: [] },
  AUD: { manufacturing: ["Flash Manufacturing PMI"], services: ["Flash Services PMI"] },
  NZD: { manufacturing: [], services: [] },
};

function historyByTitles(currencyCode, events, titles) {
  if (!titles || titles.length === 0) return [];
  return events
    .filter(
      (e) =>
        e.currency_code === currencyCode &&
        e.actual != null &&
        titles.includes(e.event_title) &&
        !isNationalEuroTitle(e.event_title)
    )
    .map((e) => ({ value: parseFloat(e.actual), title: e.event_title, eventDay: e.event_day }))
    .filter((o) => !Number.isNaN(o.value) && o.value >= 0 && o.value <= 100)
    .sort((a, b) => new Date(a.eventDay) - new Date(b.eventDay));
}

// PMI blok = průměr Manufacturing + Services čtení SE STEJNÝM měsícem publikace (jen ty
// subindexy, co appka pro danou měnu má, viz PMI_TITLES) — nikdy nedomýšlí chybějící subindex.
export function extractPmiHistory(currencyCode, events) {
  const cfg = PMI_TITLES[currencyCode];
  if (!cfg) return [];
  const manRows = historyByTitles(currencyCode, events, cfg.manufacturing);
  const svcRows = historyByTitles(currencyCode, events, cfg.services);
  const byMonth = new Map();
  for (const r of [...manRows, ...svcRows]) {
    const month = r.eventDay.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(r);
  }
  const history = [];
  for (const month of [...byMonth.keys()].sort()) {
    const parts = byMonth.get(month);
    const value = round2(parts.reduce((s, p) => s + p.value, 0) / parts.length);
    const latestDay = [...parts].sort((a, b) => new Date(b.eventDay) - new Date(a.eventDay))[0].eventDay;
    const title = parts.length === 2 ? `${parts[0].title} + ${parts[1].title} (avg)` : parts[0].title;
    history.push({ value, title, eventDay: latestDay, vintage: null, unit: "index", componentsUsed: parts.length });
  }
  return history;
}

export function extractLatestPmi(currencyCode, events) {
  const history = extractPmiHistory(currencyCode, events);
  return history.length > 0 ? history[history.length - 1] : null;
}

// ---------------------------------------------------------------------------------------------
// Normalizace: clip((raw-reference)/own_history_stdev, -3, +3). `fixedReference` = CB target
// (Inflation) nebo 50 (PMI); jinak (Labor/Growth/Demand) reference = own_history_mean.
// `priorRawValues` MUSÍ obsahovat jen pozorování STARŠÍ než tohle (point-in-time), nikdy budoucí.
// ---------------------------------------------------------------------------------------------

export function normalizeAgainstHistory(rawValue, priorRawValues, { fixedReference = null, flipSign = false } = {}) {
  if (!priorRawValues || priorRawValues.length < MIN_HISTORY_N) {
    return { normalized: null, referenceUsed: fixedReference, historyMean: null, historyStdev: null, historyN: priorRawValues?.length ?? 0 };
  }
  const avg = mean(priorRawValues);
  const sd = stdev(priorRawValues, avg);
  const reference = fixedReference !== null ? fixedReference : avg;
  if (sd === 0) {
    return { normalized: 0, referenceUsed: round2(reference), historyMean: round2(avg), historyStdev: 0, historyN: priorRawValues.length };
  }
  let z = clamp((rawValue - reference) / sd, -Z_CLAMP, Z_CLAMP);
  if (flipSign) z = -z;
  return { normalized: round2(z), referenceUsed: round2(reference), historyMean: round2(avg), historyStdev: round2(sd), historyN: priorRawValues.length };
}

// Vyšší nezaměstnanost = slabší stav trhu práce, proto flipSign — jinak (Growth/Demand/PMI)
// vyšší = silnější, žádný flip. Inflation nemá flip (deviace od cíle, ne "dobré/špatné").
export const BLOCK_NORMALIZE_CONFIG = {
  inflation: (currencyCode) => ({ fixedReference: CB_INFLATION_TARGET[currencyCode] ?? null, flipSign: false }),
  labor: () => ({ fixedReference: null, flipSign: true }),
  growth: () => ({ fixedReference: null, flipSign: false }),
  demand: () => ({ fixedReference: null, flipSign: false }),
  pmi: () => ({ fixedReference: 50, flipSign: false }),
};

// ---------------------------------------------------------------------------------------------
// Absolute Fundamental Condition — vážený průměr (rovné váhy) dostupných state/activity bloků.
// NULL, pokud je dostupných méně než MIN_BLOCKS_REQUIRED z 5. Real Yield sem NEVSTUPUJE (viz
// komentář na začátku souboru).
// ---------------------------------------------------------------------------------------------

export function computeAbsoluteFundamental(normalizedByBlock) {
  const available = STATE_BLOCKS.filter((b) => normalizedByBlock[b] !== null && normalizedByBlock[b] !== undefined);
  const missing = STATE_BLOCKS.filter((b) => !available.includes(b));
  if (available.length < MIN_BLOCKS_REQUIRED) {
    return { absolute: null, blocksUsed: available.length, blocksAvailable: available, blocksMissing: missing };
  }
  const avg = mean(available.map((b) => normalizedByBlock[b]));
  return { absolute: clamp(round2(avg), -Z_CLAMP, Z_CLAMP), blocksUsed: available.length, blocksAvailable: available, blocksMissing: missing };
}

// Relative Fundamental Strength — distance-from-basket-mean (primární, stejné jednotky jako
// Absolute) + ordinální rank. NULL, pokud daná měna nemá platné Absolute NEBO basket je prázdný.
export function computeRelativeFundamental(currencyCode, absoluteByCode) {
  const valid = Object.entries(absoluteByCode).filter(([, v]) => v !== null && v !== undefined);
  const myAbs = absoluteByCode[currencyCode];
  const basketMean = valid.length > 0 ? round2(mean(valid.map(([, v]) => v))) : null;
  if (myAbs === null || myAbs === undefined || valid.length === 0) {
    return { relative: null, rank: null, basketMean };
  }
  const relative = round2(myAbs - basketMean);
  const sorted = [...valid].sort((a, b) => b[1] - a[1]);
  const rank = sorted.findIndex(([code]) => code === currencyCode) + 1;
  return { relative, rank, basketMean };
}

export function computeTrajectory(currentNormalized, previousNormalized) {
  if (currentNormalized === null || currentNormalized === undefined) return null;
  if (previousNormalized === null || previousNormalized === undefined) return null;
  return round2(currentNormalized - previousNormalized);
}

// Data Quality tier — založeno na počtu bloků s VALIDNÍ normalized hodnotou (ne na počtu řádků
// v DB), viz Phase 3.6/3.7 nález, že row-count != real observation count.
export function classifyDataQuality(normalizedByBlock, realYieldNorm) {
  const validCount = STATE_BLOCKS.filter((b) => normalizedByBlock[b] !== null && normalizedByBlock[b] !== undefined).length;
  const hasRealYield = realYieldNorm !== null && realYieldNorm !== undefined;
  if (validCount >= 5 && hasRealYield) return "HIGH";
  if (validCount >= 4) return "MEDIUM";
  if (validCount >= 2) return "LOW";
  return "INSUFFICIENT";
}

export function extractAllBlocks(currencyCode, allEvents) {
  // Konzistentně s extractInflationHistory (viz komentář tam) — "aktuální" čtení = poslední bod
  // téže historie, ne samostatné volání extractLatestCpi na neFiltrovaném poli.
  const inflationHistory = extractInflationHistory(currencyCode, allEvents);
  return {
    inflation: inflationHistory.length > 0 ? inflationHistory[inflationHistory.length - 1] : null,
    labor: extractLatestUnemployment(currencyCode, allEvents),
    growth: extractLatestGrowth(currencyCode, allEvents),
    demand: extractLatestRetailSales(currencyCode, allEvents),
    pmi: extractLatestPmi(currencyCode, allEvents),
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestrátor (I/O). Volající (run-shadow-engine.mjs) dodá supabase klienta, VŠECHNY
// calendar_events (read-only) a cbPolicyByCode (z computeCbPolicyState, jen čteno pro real
// yield / policy context — cb-policy.mjs se tady nepřepočítává, jen se předává výsledek).
// ---------------------------------------------------------------------------------------------

export async function runShadowEngine({ supabase, allEvents, currencyCodes, cbPolicyByCode, dataMomentumByCode, now = new Date() }) {
  const extractedByCode = {};
  for (const code of currencyCodes) {
    extractedByCode[code] = extractAllBlocks(code, allEvents);
  }

  // 1) Zapiš raw pozorování — CELOU dostupnou historii per blok (ne jen aktuální), ať appka
  // hned zúročí ~11-12 měsíců reálné historie už v calendar_events (žádná fabrikace, jen přehrání
  // už zachycených dat). insert-only, ignoreDuplicates přes onConflict = idempotentní i při
  // opakovaném běhu (starší řádky se nikdy nepřepisují).
  const historiesByCode = {};
  for (const code of currencyCodes) {
    historiesByCode[code] = {
      inflation: extractInflationHistory(code, allEvents),
      labor: extractUnemploymentHistory(code, allEvents),
      growth: extractGrowthHistory(code, allEvents),
      demand: extractRetailSalesHistory(code, allEvents),
      pmi: extractPmiHistory(code, allEvents),
    };
  }

  const rawRowsToInsert = [];
  for (const code of currencyCodes) {
    for (const block of STATE_BLOCKS) {
      for (const obs of historiesByCode[code][block]) {
        if (!obs || obs.eventDay === null || obs.eventDay === undefined) continue; // bez event_day nejde PIT klíčovat
        rawRowsToInsert.push({
          currency_code: code,
          block,
          source_event_title: obs.title,
          source_event_day: obs.eventDay,
          vintage: obs.vintage,
          raw_value: obs.value,
          unit: obs.unit ?? null,
          model_version: SHADOW_MODEL_VERSION,
        });
      }
    }
  }
  if (rawRowsToInsert.length > 0) {
    const { error: insErr } = await supabase
      .from("fundamental_block_observations")
      .upsert(rawRowsToInsert, { onConflict: "currency_code,block,source_event_title,source_event_day", ignoreDuplicates: true });
    if (insErr) console.error("shadow-engine: chyba zápisu fundamental_block_observations:", insErr.message);
  }

  // 2) Pro každý blok/měnu načti PRIOR historii (striktně starší než aktuální pozorování) a
  // spočítej normalized hodnotu + trajectory vs. poslední předchozí normalized.
  const normalizedByCode = {};
  const trajectoryByCode = {};
  const missingFieldsByCode = {};

  for (const code of currencyCodes) {
    normalizedByCode[code] = {};
    trajectoryByCode[code] = {};
    missingFieldsByCode[code] = [];

    for (const block of STATE_BLOCKS) {
      const obs = extractedByCode[code][block];
      if (!obs) {
        normalizedByCode[code][block] = null;
        trajectoryByCode[code][block] = null;
        missingFieldsByCode[code].push(block);
        continue;
      }

      const { data: priorRows, error: histErr } = await supabase
        .from("fundamental_block_observations")
        .select("raw_value, source_event_day, normalized_value")
        .eq("currency_code", code)
        .eq("block", block)
        .lt("source_event_day", obs.eventDay)
        .order("source_event_day", { ascending: true });

      if (histErr) {
        console.error(`shadow-engine [${code}/${block}]: chyba čtení historie:`, histErr.message);
        normalizedByCode[code][block] = null;
        trajectoryByCode[code][block] = null;
        continue;
      }

      const priorRawValues = (priorRows ?? []).map((r) => Number(r.raw_value));
      const cfg = BLOCK_NORMALIZE_CONFIG[block](code);
      const result = normalizeAgainstHistory(obs.value, priorRawValues, cfg);
      normalizedByCode[code][block] = result.normalized;

      const lastPrior = (priorRows ?? []).filter((r) => r.normalized_value !== null).slice(-1)[0] ?? null;
      trajectoryByCode[code][block] = computeTrajectory(result.normalized, lastPrior ? Number(lastPrior.normalized_value) : null);

      // Doplň normalized_value do právě vloženého/existujícího raw řádku (append-only — UPDATE
      // POVOLEN JEN na sloupcích normalized_value/history_*/reference_value TOHOTO řádku, nikdy
      // na raw_value/source_event_*, takže PIT identita řádku (co appka VĚDĚLA) se nemění).
      const { error: updErr } = await supabase
        .from("fundamental_block_observations")
        .update({
          reference_value: result.referenceUsed,
          history_mean: result.historyMean,
          history_stdev: result.historyStdev,
          history_n: result.historyN,
          normalized_value: result.normalized,
        })
        .eq("currency_code", code)
        .eq("block", block)
        .eq("source_event_title", obs.title)
        .eq("source_event_day", obs.eventDay);
      if (updErr) console.error(`shadow-engine [${code}/${block}]: chyba doplnění normalized_value:`, updErr.message);
    }
  }

  // 3) Real Yield (reuse computeRealYieldAdj výstup z cbPolicyByCode, beze změny) + Absolute +
  // Relative + Data Quality.
  const absoluteByCode = {};
  for (const code of currencyCodes) {
    absoluteByCode[code] = computeAbsoluteFundamental(normalizedByCode[code]).absolute;
  }

  const results = {};
  for (const code of currencyCodes) {
    const abs = computeAbsoluteFundamental(normalizedByCode[code]);
    const rel = computeRelativeFundamental(code, absoluteByCode);
    const realYieldNorm = cbPolicyByCode[code]?.realYieldAdj ?? null;
    const dataQuality = classifyDataQuality(normalizedByCode[code], realYieldNorm);

    results[code] = {
      model_version: SHADOW_MODEL_VERSION,
      currency_code: code,
      inflation_norm: normalizedByCode[code].inflation,
      labor_norm: normalizedByCode[code].labor,
      growth_norm: normalizedByCode[code].growth,
      demand_norm: normalizedByCode[code].demand,
      pmi_norm: normalizedByCode[code].pmi,
      real_yield_norm: realYieldNorm,
      inflation_trajectory: trajectoryByCode[code].inflation,
      labor_trajectory: trajectoryByCode[code].labor,
      growth_trajectory: trajectoryByCode[code].growth,
      demand_trajectory: trajectoryByCode[code].demand,
      pmi_trajectory: trajectoryByCode[code].pmi,
      absolute_fundamental: abs.absolute,
      absolute_blocks_used: abs.blocksUsed,
      relative_fundamental: rel.relative,
      relative_rank: rel.rank,
      basket_mean: rel.basketMean,
      policy_context: cbPolicyByCode[code]
        ? {
            rate: cbPolicyByCode[code].rate,
            policy_label: cbPolicyByCode[code].policyLabel,
            last_move_bp: cbPolicyByCode[code].lastMoveBp,
            last_move_date: cbPolicyByCode[code].lastMoveDate,
            days_since_move: cbPolicyByCode[code].daysSinceMove,
          }
        : null,
      data_momentum: dataMomentumByCode[code]?.fundamentalScore ?? null,
      data_momentum_confidence: dataMomentumByCode[code]?.confidence ?? null,
      data_quality: dataQuality,
      blocks_available: abs.blocksAvailable,
      blocks_missing: abs.blocksMissing,
      missing_fields: missingFieldsByCode[code],
    };
  }

  // 4) Insert nového snapshotu jen pokud se STAV od posledního uloženého snapshotu skutečně
  // liší (stejná konvence jako score_snapshots) — ne při každém běhu beze změny.
  for (const code of currencyCodes) {
    const r = results[code];
    const { data: lastSnap } = await supabase
      .from("fundamental_shadow_snapshots")
      .select(
        "inflation_norm, labor_norm, growth_norm, demand_norm, pmi_norm, real_yield_norm, absolute_fundamental, relative_fundamental, relative_rank, data_quality"
      )
      .eq("currency_code", code)
      .order("snapshot_at", { ascending: false })
      .limit(1);

    const prev = lastSnap?.[0] ?? null;
    const changed =
      !prev ||
      prev.inflation_norm !== r.inflation_norm ||
      prev.labor_norm !== r.labor_norm ||
      prev.growth_norm !== r.growth_norm ||
      prev.demand_norm !== r.demand_norm ||
      prev.pmi_norm !== r.pmi_norm ||
      Number(prev.real_yield_norm ?? null) !== Number(r.real_yield_norm ?? null) ||
      prev.absolute_fundamental !== r.absolute_fundamental ||
      prev.relative_fundamental !== r.relative_fundamental ||
      prev.relative_rank !== r.relative_rank ||
      prev.data_quality !== r.data_quality;

    if (!changed) continue;

    const { error: snapErr } = await supabase.from("fundamental_shadow_snapshots").insert({
      currency_code: code,
      model_version: r.model_version,
      inflation_norm: r.inflation_norm,
      labor_norm: r.labor_norm,
      growth_norm: r.growth_norm,
      demand_norm: r.demand_norm,
      pmi_norm: r.pmi_norm,
      real_yield_norm: r.real_yield_norm,
      inflation_trajectory: r.inflation_trajectory,
      labor_trajectory: r.labor_trajectory,
      growth_trajectory: r.growth_trajectory,
      demand_trajectory: r.demand_trajectory,
      pmi_trajectory: r.pmi_trajectory,
      absolute_fundamental: r.absolute_fundamental,
      absolute_blocks_used: r.absolute_blocks_used,
      relative_fundamental: r.relative_fundamental,
      relative_rank: r.relative_rank,
      basket_mean: r.basket_mean,
      policy_context: r.policy_context,
      data_momentum: r.data_momentum,
      data_momentum_confidence: r.data_momentum_confidence,
      data_quality: r.data_quality,
      blocks_available: r.blocks_available,
      blocks_missing: r.blocks_missing,
      missing_fields: r.missing_fields,
    });
    if (snapErr) console.error(`shadow-engine [${code}]: chyba zápisu fundamental_shadow_snapshots:`, snapErr.message);
  }

  return results;
}
