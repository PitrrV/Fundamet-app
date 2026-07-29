import { createClient } from "@supabase/supabase-js";
import { matchRule, eventDirection, surpriseStrength, recency, eventRelevance, ffConfidence } from "./fundamental-scoring.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCORED = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];
const FOCUS = ["USD", "AUD", "EUR", "GBP"];
const NOW = new Date("2026-07-29T00:00:00Z");
const AS_OF_DAYS_AGO = [300, 220, 140, 60, 0];

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
    contributions.push({ cat: rule.cat, contribution });
  }
  const { confidence } = ffConfidence(relevant);
  return { contributions, confidence };
}

function variantA(contributions, confidence) {
  const totalSigned = contributions.reduce((s, c) => s + c.contribution, 0);
  const rawScore = clamp(totalSigned, -10, 10);
  return Math.round(clamp((rawScore / 2) * confidence, -5, 5) * 100) / 100;
}

// ── PŘESNĚ podle zadání: tvrdý tsrop ±CAP na kumulativní příspěvek KAŽDÉ kategorie
// (stejné jednotky jako celkové skóre, žádné škálování podle váhy kategorie), pak součet
// capnutých kategorií, pak STEJNÝ finální ±10/škálování/confidence jako dnes.
function variantCatCap(contributions, confidence, CAP) {
  const byCat = {};
  for (const c of contributions) {
    byCat[c.cat] ??= 0;
    byCat[c.cat] += c.contribution;
  }
  let rawSum = 0;
  const catDetail = {};
  for (const cat of Object.keys(byCat)) {
    const capped = clamp(byCat[cat], -CAP, CAP);
    rawSum += capped;
    catDetail[cat] = { raw: byCat[cat], capped };
  }
  const rawScore = clamp(rawSum, -10, 10);
  const score = Math.round(clamp((rawScore / 2) * confidence, -5, 5) * 100) / 100;
  return { score, catDetail, rawSumBeforeOuterClamp: rawSum };
}

const allEvents = await fetchAllCalendarEvents();
console.log(`Načteno ${allEvents.length} calendar_events.\n`);

for (const CAP of [10, 15, 20]) {
  console.log(`\n\n================ TVRDÝ STROP NA KATEGORII, CAP=±${CAP} ================`);

  console.log("\n═══ Historická validace vs. reálná CB Policy kotva ═══");
  for (const ccy of FOCUS) {
    console.log(`\n--- ${ccy} ---`);
    console.log("dní zpět | CB Policy (kotva)                          | A       | Cat-Cap");
    for (const daysAgo of AS_OF_DAYS_AGO) {
      const asOf = new Date(NOW.getTime() - daysAgo * 86400000);
      const eventsUpTo = allEvents.filter((e) => new Date(e.event_day).getTime() <= asOf.getTime());
      const cb = computeCbPolicyState(ccy, SCORED, eventsUpTo);
      const { contributions, confidence } = collectContributions(ccy, eventsUpTo, asOf);
      const a = variantA(contributions, confidence);
      const { score, rawSumBeforeOuterClamp } = variantCatCap(contributions, confidence, CAP);
      console.log(`${String(daysAgo).padStart(4)} (${asOf.toISOString().slice(0, 10)}) | ${cb.policyLabel.padEnd(43)} | ${a.toFixed(2).padStart(6)} | ${score.toFixed(2).padStart(6)} (rawSum před ±10 stropem=${rawSumBeforeOuterClamp.toFixed(1)})`);
    }
  }

  // Detailní rozklad GBP dnes, aby bylo vidět PŘESNĚ co se capne a co ne
  console.log("\n--- GBP dnes, rozklad po kategoriích (raw vs. capped) ---");
  const { contributions: gbpContrib, confidence: gbpConf } = collectContributions("GBP", allEvents, NOW);
  const gbpResult = variantCatCap(gbpContrib, gbpConf, CAP);
  for (const [cat, d] of Object.entries(gbpResult.catDetail)) {
    console.log(`  ${cat.padEnd(20)} raw=${d.raw.toFixed(1).padStart(7)}  capped=${d.capped.toFixed(1).padStart(7)}`);
  }
  console.log(`  součet capnutých kategorií = ${gbpResult.rawSumBeforeOuterClamp.toFixed(1)} -> finální skóre = ${gbpResult.score}`);

  console.log("\n═══ Diferenciace mezi 8 měnami dnes ═══");
  const vals = [];
  for (const ccy of SCORED) {
    const { contributions, confidence } = collectContributions(ccy, allEvents, NOW);
    const { score } = variantCatCap(contributions, confidence, CAP);
    vals.push(score);
    console.log(`${ccy}: ${score.toFixed(2)}`);
  }
  function stdev(arr) {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  }
  console.log(`sd=${stdev(vals).toFixed(2)}, min=${Math.min(...vals)}, max=${Math.max(...vals)}`);
}
