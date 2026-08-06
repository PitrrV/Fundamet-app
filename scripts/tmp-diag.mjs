// DOČASNÝ skript — READ ONLY, žádné volání OpenAI. Porovnává STARÝ (Σ→clamp, schodovitá
// recency) a NOVÝ (vážený průměr, exponenciální recency) výpočet fundamentálního skóre nad
// reálnými produkčními daty, aby bylo vidět, jak moc se čísla v appce reálně posunou.
import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore, matchRule, eventRelevance, eventDirection, surpriseStrength } from "./fundamental-scoring.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// --- STARÁ verze (před opravou), zkopírovaná pro srovnání ---
function oldRecency(daysAgo) {
  if (daysAgo <= 90) return 1.8;
  if (daysAgo <= 180) return 1.4;
  if (daysAgo <= 365) return 1.0;
  return 0.7;
}
const OLD_REFERENCE_EVENT_COUNT = 60;
function oldComputeFundamentalScore(currencyCode, calendarEvents, now) {
  const relevant = [];
  let rawSum = 0;
  let signedEventCount = 0;
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
    rawSum += dir * rule.w * surpriseStrength(ev) * oldRecency(daysAgo) * relevance.factor;
    signedEventCount++;
  }
  const dampingFactor = signedEventCount > 0 ? Math.min(1, OLD_REFERENCE_EVENT_COUNT / signedEventCount) : 1;
  const rawScore = Math.max(-10, Math.min(10, rawSum * dampingFactor));
  const scaledRaw = rawScore / 2;
  return { rawScore: Math.round(scaledRaw * 10) / 10 };
}

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

const now = new Date();
console.log("měna   STARÝ rawScore   NOVÝ rawScore   NOVÝ fundScore   confidence");
console.log("-".repeat(72));
for (const code of ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"]) {
  const oldR = oldComputeFundamentalScore(code, allCalendarEvents, now);
  const newR = computeFundamentalScore(code, allCalendarEvents, now);
  const oldSat = Math.abs(oldR.rawScore) >= 4.9 ? " (SATUROVÁNO)" : "";
  console.log(
    `${code}    ${String(oldR.rawScore).padStart(6)}${oldSat.padEnd(15)} ${String(newR.rawScore).padStart(6)}          ` +
    `${String(newR.fundamentalScore).padStart(6)}          ${newR.confidence}`
  );
}
