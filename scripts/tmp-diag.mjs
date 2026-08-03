// DOČASNÝ diagnostický skript — smazat po použití.
// Přesně replikuje scenarioCandidates/selectScenarioSeeds logiku z generate-narrative.mjs pro
// NZD, ať se zjistí, kolik seedů appka modelu reálně poslala.
import { createClient } from "@supabase/supabase-js";
import { getWeight, matchRule } from "./fundamental-scoring.mjs";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SUBNATIONAL_PREFIXES = ["french", "german", "spanish", "italian"];
const SUBNATIONAL_DAMP = 0.6;
function agendaWeight(title) {
  const lower = (title || "").toLowerCase();
  const damp = SUBNATIONAL_PREFIXES.some((p) => lower.startsWith(p)) ? SUBNATIONAL_DAMP : 1;
  return getWeight(title) * damp;
}

const { data: allEvents } = await supabase
  .from("calendar_events")
  .select("currency_code, event_title, event_day, actual, estimate, previous, impact");

const today = new Date().toISOString().slice(0, 10);
const SCENARIO_LOOKBACK_DAYS = 5;
const UPCOMING_DAYS = 21;
const scenarioLookbackCutoff = new Date(Date.now() - SCENARIO_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
const upcomingCutoff = new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString().slice(0, 10);

console.log("today (UTC):", today, "| lookback cutoff:", scenarioLookbackCutoff, "| upcoming cutoff:", upcomingCutoff);

const currencyEvents = (allEvents ?? []).filter((e) => e.currency_code === "NZD");
const scenarioCandidates = currencyEvents.filter(
  (e) => e.event_day >= scenarioLookbackCutoff && e.event_day <= upcomingCutoff
);

console.log(`\nscenarioCandidates (v okně, bez ohledu na váhu): ${scenarioCandidates.length}`);
for (const ev of scenarioCandidates) {
  const w = agendaWeight(ev.event_title);
  const cat = matchRule(ev.event_title)?.cat ?? null;
  console.log(`  ${ev.event_day} | ${ev.event_title} | weight=${w} | cat=${cat} | actual=${ev.actual}`);
}

const weighted = scenarioCandidates.filter((ev) => agendaWeight(ev.event_title) > 0);
console.log(`\nPo filtru weight>0: ${weighted.length}`);
