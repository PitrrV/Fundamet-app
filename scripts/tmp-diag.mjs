// DOČASNÝ audit skript — READ ONLY, žádné volání OpenAI. Ověřuje reálnou úsporu payloadu po
// dietě (RECENT_DAYS 90->30 + strop, historicalTrend jen pro flaggedEvents).
import { createClient } from "@supabase/supabase-js";
import { loadCurrencyContext, loadBasketContext, loadMarketRegime } from "./generate-narrative.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TOK = 3.4;

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

let totalNarrative = 0;
let totalAgenda = 0;
for (const code of ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"]) {
  const ctx = await loadCurrencyContext(code, allCalendarEvents, basketContext, marketRegime);
  const narrativePayload = {
    currency: code, cot: ctx.cot, fundamental: ctx.fundamental, cbPolicy: ctx.cbPolicy, thesis: ctx.thesis,
    scoreChange: ctx.scoreChange, recentLedger: ctx.recentLedger, retailSentiment: ctx.retailSentiment,
    riskRegime: ctx.riskRegime, basketContext: ctx.basketContext,
    upcomingEvents: ctx.upcoming, recentEvents: ctx.recent, flaggedEvents: ctx.flaggedEvents,
  };
  const agendaPayload = {
    currency: code, narrative: "x".repeat(900), cot: ctx.cot, cbPolicy: ctx.cbPolicy,
    thesis: ctx.thesis, retailSentiment: ctx.retailSentiment, riskRegime: ctx.riskRegime,
    scenarioSeeds: ctx.scenarioSeeds,
  };
  const nChars = JSON.stringify(narrativePayload).length;
  const aChars = JSON.stringify(agendaPayload).length;
  totalNarrative += nChars;
  totalAgenda += aChars;
  console.log(
    `${code}  narrative ${String(nChars).padStart(6)} zn (~${Math.round(nChars/TOK)} tok, recentEvents=${ctx.recent.length}, upcoming=${ctx.upcoming.length})` +
    `  agenda ${String(aChars).padStart(5)} zn (~${Math.round(aChars/TOK)} tok)`
  );
}
console.log("");
console.log(`PRŮMĚR narrative payload: ${Math.round(totalNarrative/8)} zn (~${Math.round(totalNarrative/8/TOK)} tok) — dřív bylo 45299 zn (~13323 tok) na USD`);
console.log(`PRŮMĚR agenda payload:    ${Math.round(totalAgenda/8)} zn (~${Math.round(totalAgenda/8/TOK)} tok)`);
console.log(`Vstup na 1 měnu (oba kroky + system prompty ~2928 tok): ~${Math.round(totalNarrative/8/TOK + totalAgenda/8/TOK + 2928)} tok`);
console.log(`Vstup na 8 měn: ~${Math.round((totalNarrative/8/TOK + totalAgenda/8/TOK + 2928) * 8)} tok (dřív ~141700 tok)`);
