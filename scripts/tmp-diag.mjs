// DOČASNÝ audit skript — READ ONLY, žádné volání OpenAI (nulový náklad).
// Měří: (1) skutečnou velikost payloadu posílaného modelu, (2) rozložení stáří eventů
// vstupujících do fundamentálního skóre, (3) citlivost skóre na nový event.
import { createClient } from "@supabase/supabase-js";
import { loadCurrencyContext, loadBasketContext, loadMarketRegime } from "./generate-narrative.mjs";
import { computeFundamentalScore, matchRule, eventRelevance, recency } from "./fundamental-scoring.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TOK = 3.4; // čeština/JSON ~3.4 znaku na token

const allCalendarEvents = [];
{
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data: page, error } = await supabase
      .from("calendar_events")
      .select("currency_code, event_title, event_day, actual, estimate, previous, impact")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    allCalendarEvents.push(...page);
    if (page.length < pageSize) break;
  }
}
console.log(`calendar_events celkem: ${allCalendarEvents.length} řádků\n`);

const basketContext = await loadBasketContext();
const marketRegime = await loadMarketRegime();

console.log("=== 1. VELIKOST PAYLOADU (co se reálně posílá modelu) ===");
const ctx = await loadCurrencyContext("USD", allCalendarEvents, basketContext, marketRegime);

const narrativePayload = {
  currency: "USD",
  cot: ctx.cot, fundamental: ctx.fundamental, cbPolicy: ctx.cbPolicy, thesis: ctx.thesis,
  scoreChange: ctx.scoreChange, recentLedger: ctx.recentLedger, retailSentiment: ctx.retailSentiment,
  riskRegime: ctx.riskRegime, basketContext: ctx.basketContext,
  upcomingEvents: ctx.upcoming, recentEvents: ctx.recent, flaggedEvents: ctx.flaggedEvents,
};
const agendaPayload = {
  currency: "USD", narrative: "x".repeat(900), cot: ctx.cot, cbPolicy: ctx.cbPolicy,
  thesis: ctx.thesis, retailSentiment: ctx.retailSentiment, riskRegime: ctx.riskRegime,
  scenarioSeeds: ctx.scenarioSeeds,
};

function size(label, obj) {
  const chars = JSON.stringify(obj).length;
  console.log(`  ${label.padEnd(28)} ${String(chars).padStart(7)} znaků  ~${String(Math.round(chars / TOK)).padStart(6)} tok`);
  return chars;
}
console.log(" NARRATIVE payload, rozpad po polích:");
let total = 0;
for (const [k, v] of Object.entries(narrativePayload)) total += size(k, v);
console.log(`  ${"CELKEM narrative payload".padEnd(28)} ${String(total).padStart(7)} znaků  ~${String(Math.round(total / TOK)).padStart(6)} tok`);
console.log(`  (z toho recentEvents: ${Math.round(JSON.stringify(narrativePayload.recentEvents).length / total * 100)} %, upcomingEvents: ${Math.round(JSON.stringify(narrativePayload.upcomingEvents).length / total * 100)} %)`);
console.log("");
console.log(" AGENDA payload:");
let atotal = 0;
for (const [k, v] of Object.entries(agendaPayload)) atotal += size(k, v);
console.log(`  ${"CELKEM agenda payload".padEnd(28)} ${String(atotal).padStart(7)} znaků  ~${String(Math.round(atotal / TOK)).padStart(6)} tok`);
console.log(`\n  => vstupní tokeny na 1 měnu (oba kroky, bez system promptu): ~${Math.round((total + atotal) / TOK)} tok`);
console.log(`  => system prompty na 1 měnu: ~2928 tok`);
console.log(`  => na 8 měn celkem vstup: ~${Math.round(((total + atotal) / TOK + 2928) * 8)} tok`);

console.log("\n=== 2. STÁŘÍ EVENTŮ VE FUNDAMENTÁLNÍM SKÓRE ===");
const now = new Date();
for (const code of ["USD", "EUR", "NZD"]) {
  const buckets = { "0-90d": 0, "91-180d": 0, "181-365d": 0, ">365d": 0 };
  let weighted = { "0-90d": 0, "91-180d": 0, "181-365d": 0, ">365d": 0 };
  let signed = 0;
  for (const ev of allCalendarEvents) {
    const rel = eventRelevance(code, ev);
    if (!rel) continue;
    if (!ev.actual || !ev.estimate) continue;
    const rule = matchRule(ev.event_title);
    if (!rule || rule.w === 0) continue;
    const daysAgo = (now.getTime() - new Date(ev.event_day).getTime()) / 86400000;
    if (daysAgo < 0) continue;
    signed++;
    const b = daysAgo <= 90 ? "0-90d" : daysAgo <= 180 ? "91-180d" : daysAgo <= 365 ? "181-365d" : ">365d";
    buckets[b]++;
    weighted[b] += rule.w * recency(daysAgo);
  }
  const wTotal = Object.values(weighted).reduce((a, b) => a + b, 0) || 1;
  console.log(`\n ${code}: ${signed} eventů vstupuje do skóre, dampingFactor = ${Math.min(1, 60 / signed).toFixed(3)}`);
  for (const b of Object.keys(buckets)) {
    console.log(`   ${b.padEnd(10)} ${String(buckets[b]).padStart(4)} eventů   podíl na váze: ${(weighted[b] / wTotal * 100).toFixed(1)} %`);
  }
}

console.log("\n=== 3. CITLIVOST: co udělá JEDEN nový silný beat s celkovým skóre ===");
for (const code of ["USD", "EUR", "NZD"]) {
  const base = computeFundamentalScore(code, allCalendarEvents, now);
  const fake = {
    currency_code: code, event_title: "Non-Farm Employment Change",
    event_day: now.toISOString().slice(0, 10), actual: "300K", estimate: "150K", previous: "150K", impact: "High",
  };
  const withNew = computeFundamentalScore(code, [...allCalendarEvents, fake], now);
  console.log(
    `  ${code}: fundamental_score ${base.fundamentalScore} -> ${withNew.fundamentalScore} ` +
    `(zmena ${(withNew.fundamentalScore - base.fundamentalScore).toFixed(2)}), ` +
    `dopad na overall pri vaze 0.43: ${((withNew.fundamentalScore - base.fundamentalScore) * 0.43).toFixed(3)}`
  );
}

console.log("\n=== 4. AUDIO: kolik se ho generuje ===");
const { data: narr } = await supabase
  .from("narratives").select("currency_code, generated_at, audio_url, narrative")
  .gte("generated_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
const withAudio = (narr ?? []).filter((r) => r.audio_url).length;
const chars = (narr ?? []).reduce((s, r) => s + (r.narrative?.length ?? 0), 0);
console.log(`  Za 24h vygenerováno ${narr?.length ?? 0} narrativů, z toho ${withAudio} s audiem.`);
console.log(`  TTS znaků: ${chars} => $${(chars / 1e6 * 15).toFixed(4)} (tts-1 @ $15/1M znaků)`);
