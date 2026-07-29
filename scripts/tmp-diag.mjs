import { createClient } from "@supabase/supabase-js";
import { matchRule, eventDirection, surpriseStrength, recency, eventRelevance, ffConfidence, EVENT_RULES } from "./fundamental-scoring.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCORED = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];
const NOW = new Date("2026-07-29T00:00:00Z");

async function fetchAllCalendarEvents() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, currency_code, event_title, event_day, actual, estimate, previous")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function collectContributions(currencyCode, calendarEvents, now) {
  const relevant = [];
  const contributions = [];
  for (const ev of calendarEvents) {
    const relevance = eventRelevance(currencyCode, ev);
    if (!relevance) continue;
    if (!ev.actual || !ev.estimate) continue;
    const rule = matchRule(ev.event_title);
    if (!rule || rule.w === 0) continue;
    relevant.push(ev);
    const dir = eventDirection(ev, rule);
    if (dir === 0) continue;
    const daysAgo = (now.getTime() - new Date(ev.event_day).getTime()) / 86400000;
    if (daysAgo < 0) continue;
    const contribution = dir * rule.w * surpriseStrength(ev) * recency(daysAgo) * relevance.factor;
    contributions.push({ cat: rule.cat, w: rule.w, contribution, daysAgo, day: ev.event_day });
  }
  contributions.sort((a, b) => a.daysAgo - b.daysAgo); // nejnovější první
  const { confidence } = ffConfidence(relevant);
  return { contributions, confidence };
}

function finalize(rawSum, confidence) {
  const rawScore = clamp(rawSum, -10, 10);
  const scaledRaw = rawScore / 2;
  return Math.round(clamp(scaledRaw * confidence, -5, 5) * 100) / 100;
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events (celá dostupná historie, ~365d+).\n`);

const CATS = [...new Set(EVENT_RULES.map((r) => r.cat))];

console.log("═══ ČÁST 1: Rozklad podle kategorie (současná metoda — SOUČET) ═══\n");
const variantResults = {}; // ccy -> {A,B,C,D}

for (const ccy of SCORED) {
  const { contributions, confidence } = collectContributions(ccy, allEvents, NOW);
  const totalAbs = contributions.reduce((s, c) => s + Math.abs(c.contribution), 0);
  const totalSigned = contributions.reduce((s, c) => s + c.contribution, 0);

  const byCat = {};
  for (const c of contributions) {
    byCat[c.cat] ??= { count: 0, sum: 0, absSum: 0 };
    byCat[c.cat].count++;
    byCat[c.cat].sum += c.contribution;
    byCat[c.cat].absSum += Math.abs(c.contribution);
  }

  console.log(`--- ${ccy} (celkem ${contributions.length} eventů, netto=${totalSigned.toFixed(1)}, |netto|=${totalAbs.toFixed(1)}) ---`);
  for (const cat of CATS) {
    const b = byCat[cat];
    if (!b) continue;
    const pctOfAbs = totalAbs > 0 ? Math.round((b.absSum / totalAbs) * 1000) / 10 : 0;
    console.log(`  ${cat.padEnd(20)} n=${String(b.count).padStart(3)}  sum=${b.sum.toFixed(1).padStart(7)}  |podíl na |netto||=${pctOfAbs}%`);
  }
  console.log("");

  // ── VARIANTA A: současná (součet, clamp ±10) ──
  const fundA = finalize(totalSigned, confidence);

  // ── VARIANTA B: normalizace na průměr přes všechny eventy ──
  const meanAll = contributions.length > 0 ? totalSigned / contributions.length : 0;
  const fundB = finalize(meanAll * 2, confidence); // *2 aby škála byla srovnatelná s jedním "silným" eventem

  // ── VARIANTA C: strop na 6 nejnovějších eventů PER KATEGORII, pak součet ──
  const cappedByCat = {};
  for (const c of contributions) {
    cappedByCat[c.cat] ??= [];
    if (cappedByCat[c.cat].length < 6) cappedByCat[c.cat].push(c.contribution);
  }
  const cappedSum = Object.values(cappedByCat).flat().reduce((s, v) => s + v, 0);
  const fundC = finalize(cappedSum, confidence);

  // ── VARIANTA D: dvoufázová — průměr UVNITŘ kategorie, pak vážená kombinace podle EVENT_RULES.w ──
  let weightedSum = 0;
  let weightTotal = 0;
  for (const cat of CATS) {
    const b = byCat[cat];
    if (!b) continue;
    const catMean = b.sum / b.count; // průměrný směr+síla uvnitř kategorie, bez ohledu na počet výskytů
    const rule = EVENT_RULES.find((r) => r.cat === cat);
    weightedSum += catMean * rule.w;
    weightTotal += rule.w;
  }
  const dRaw = weightTotal > 0 ? (weightedSum / weightTotal) * 2 : 0; // *2 pro srovnatelnou škálu s A
  const fundD = finalize(dRaw, confidence);

  variantResults[ccy] = { A: fundA, B: fundB, C: fundC, D: fundD };
}

console.log("\n═══ ČÁST 2: Srovnání variant ═══\n");
console.log("Měna | A: současný součet | B: průměr přes vše | C: strop 6/kategorie | D: dvoufázová (kategorie->váha)");
for (const ccy of SCORED) {
  const v = variantResults[ccy];
  console.log(`${ccy}  |  ${v.A.toFixed(2).padStart(6)}            |  ${v.B.toFixed(2).padStart(6)}            |  ${v.C.toFixed(2).padStart(6)}             |  ${v.D.toFixed(2).padStart(6)}`);
}

function stdev(arr) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
console.log("\nSměrodatná odchylka finálních skóre napříč 8 měnami (vyšší = lepší diferenciace mezi měnami):");
for (const key of ["A", "B", "C", "D"]) {
  const vals = SCORED.map((c) => variantResults[c][key]);
  console.log(`  Varianta ${key}: sd=${stdev(vals).toFixed(2)}, min=${Math.min(...vals)}, max=${Math.max(...vals)}, počet saturovaných na ±5: ${vals.filter((v) => Math.abs(v) >= 4.9).length}/8`);
}
