// DOČASNÝ skript — A/B test gpt-4o-mini vs gpt-5.6-luna nad STEJNÝMI produkčními daty
// (stejný loadCurrencyContext/generateNarrativePart/generateAgendaPart jako produkce, jen
// s vynuceným modelem a bez zápisu do tabulky narratives).
import { createClient } from "@supabase/supabase-js";
import {
  loadCurrencyContext,
  loadBasketContext,
  loadMarketRegime,
  generateNarrativePart,
  generateAgendaPart,
} from "./generate-narrative.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PRICING = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2 },
};

function cost(model, usage) {
  if (!usage) return 0;
  const p = PRICING[model];
  return (usage.prompt_tokens / 1e6) * p.in + (usage.completion_tokens / 1e6) * p.out;
}

const { data: scores, error: scoresErr } = await supabase
  .from("latest_confluence_scores")
  .select("currency_code, overall_score")
  .order("overall_score", { ascending: true });
if (scoresErr) throw new Error(scoresErr.message);

let closestPair = null;
for (let i = 0; i < scores.length - 1; i++) {
  const diff = Math.abs(scores[i + 1].overall_score - scores[i].overall_score);
  if (!closestPair || diff < closestPair.diff) {
    closestPair = { diff, a: scores[i].currency_code, b: scores[i + 1].currency_code };
  }
}
const remaining = scores.map((s) => s.currency_code).filter((c) => c !== closestPair.a && c !== closestPair.b);
const thirdCurrency = remaining[Math.floor(remaining.length / 2)];
const testCurrencies = [closestPair.a, closestPair.b, thirdCurrency];

console.log(
  `Testovací měny: ${testCurrencies.join(", ")} (nejbližší pár skóre: ${closestPair.a}/${closestPair.b}, rozdíl ${closestPair.diff.toFixed(2)})`
);

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
const basketContext = await loadBasketContext();
const marketRegime = await loadMarketRegime();

const MODELS = ["gpt-4o-mini", "gpt-5.6-luna"];
const results = {};

for (const code of testCurrencies) {
  const context = await loadCurrencyContext(code, allCalendarEvents, basketContext, marketRegime);
  results[code] = {};
  for (const model of MODELS) {
    const usage = { narrative: null, agenda: null };
    const t0 = Date.now();
    const narrativePart = await generateNarrativePart(code, context, model, (u) => (usage.narrative = u));
    const scenarios = await generateAgendaPart(code, context, narrativePart.narrative, model, (u) => (usage.agenda = u));
    const elapsedMs = Date.now() - t0;
    const totalCost = cost(model, usage.narrative) + cost(model, usage.agenda);
    results[code][model] = { narrativePart, scenarios, usage, totalCost, elapsedMs };
    console.log(`[${code}/${model}] hotovo — $${totalCost.toFixed(5)}, ${elapsedMs}ms`);
  }
}

for (const code of testCurrencies) {
  console.log(`\n${"=".repeat(90)}\n${code}\n${"=".repeat(90)}`);
  for (const model of MODELS) {
    const r = results[code][model];
    console.log(
      `\n--- ${model} | cena $${r.totalCost.toFixed(5)} | ${r.elapsedMs}ms | narrativ ${r.narrativePart.narrative.length} znaků ---`
    );
    console.log("narrative:", r.narrativePart.narrative);
    console.log("forward_flag:", r.narrativePart.forward_flag);
    console.log("conviction_note:", r.narrativePart.conviction_note);
    console.log("thesis_change_note:", r.narrativePart.thesis_change_note);
    console.log(`scenarios (${r.scenarios.length}):`);
    for (const s of r.scenarios) {
      console.log(`  [${s.tier}] ${s.date} ${s.event}: why=${s.why_it_matters}`);
      console.log(`      expect=${s.market_expectation}`);
      console.log(`      test=${s.thesis_test}`);
    }
  }
}

const grandTotal = testCurrencies.reduce(
  (sum, code) => sum + MODELS.reduce((s2, m) => s2 + results[code][m].totalCost, 0),
  0
);
console.log(`\n\nCELKOVÁ CENA TESTU: $${grandTotal.toFixed(5)}`);
