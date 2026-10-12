// Ruční "vypravěč" — texty příběhů píše Claude (ne OpenAI) a tenhle skript je PŘED uložením pustí
// přes STEJNÉ kontroly jako generátor (cizí písmo, uniklé názvy polí, relativní srovnání vůči
// skutečnému skóre koše, pravidla forward_flag) a uloží je do STEJNÉ tabulky narratives se STEJNÝM
// otiskem vstupů a snímkem skóre, takže UI i freshness-check fungují beze změny.
//
// MODE=export  — vytiskne payload (co by jinak dostal model) pro vybrané měny
// MODE=apply   — načte data/ai-narratives/<FILE>, zkontroluje a (jen při DRY_RUN=0) uloží
//
// Cokoli, co neprojde kontrolou, se NEULOŽÍ (na rozdíl od generátoru, který po druhém pokusu uloží i
// vadný text): tady je autor člověku/Claudovi k dispozici hned, takže se text opraví a pustí znovu.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  loadBasketContext,
  loadCurrencyContext,
  buildInputFingerprint,
  contextScoreSnapshot,
  findForeignScript,
  findLeakedFieldNames,
  findRelativeComparisonErrors,
  isTooShortForwardFlag,
  forwardFlagCitesFlaggedEvent,
} from "./generate-narrative.mjs";
import { validateAgenda } from "./agenda.mjs";

const MODEL_LABEL = "claude-writer-v1";
const MODE = (process.env.MODE ?? "export").toLowerCase();
const DRY_RUN = process.env.DRY_RUN !== "0";
const CURRENCIES = (process.env.CURRENCIES ?? "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const FILE = process.env.FILE ?? "";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function loadAllCalendarEvents() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("currency_code, event_title, event_day, actual, estimate, previous, impact")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`calendar_events: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

function payloadOf(code, ctx) {
  return {
    currency: code,
    cot: ctx.cot,
    fundamental: ctx.fundamental,
    fundamentalState: ctx.fundamentalState,
    cbPolicy: ctx.cbPolicy,
    thesis: ctx.thesis,
    scoreChange: ctx.scoreChange,
    recentLedger: ctx.recentLedger,
    rankingSummary: ctx.rankingSummary,
    basketContext: ctx.basketContext,
    upcomingEvents: ctx.upcoming,
    recentEvents: ctx.recent,
    flaggedEvents: ctx.flaggedEvents,
    // události, ze kterých se skládá agenda; entry.scenarios musí pokrýt přesně tyhle
    scenarioSeeds: ctx.scenarioSeeds,
  };
}

function check(entry, ctx) {
  const problems = [];
  const text = { narrative: entry.narrative, forward_flag: entry.forward_flag, conviction_note: entry.conviction_note, thesis_change_note: entry.thesis_change_note };
  if (typeof entry.narrative !== "string" || entry.narrative.trim().length < 200) problems.push("narrative je prázdný nebo příliš krátký (min. 200 znaků)");
  if (typeof entry.conviction_note !== "string" || entry.conviction_note.trim().length < 40) problems.push("conviction_note je prázdná nebo příliš krátká");
  if (findForeignScript(text).length) problems.push(`cizí písmo v polích: ${findForeignScript(text).join(", ")}`);
  if (findLeakedFieldNames(text).length) problems.push(`uniklý název interního pole v polích: ${findLeakedFieldNames(text).join(", ")}`);
  const ownScore = ctx.cot?.overallScore == null ? null : Number(ctx.cot.overallScore);
  const rel = findRelativeComparisonErrors(text, ownScore, entry.currency_code, ctx.basketContext);
  if (rel.length) problems.push(...rel);
  const flagged = ctx.flaggedEvents ?? [];
  if (flagged.length > 0) {
    if (!entry.forward_flag) problems.push("forward_flag chybí, ale appka předvybrala důležité nadcházející eventy");
    else if (isTooShortForwardFlag(entry.forward_flag)) problems.push("forward_flag je příliš krátký (holé datum bez vysvětlení)");
    else if (!forwardFlagCitesFlaggedEvent(entry.forward_flag, flagged)) problems.push("forward_flag nemluví o žádném z předvybraných eventů");
  } else if (entry.forward_flag) problems.push("forward_flag má být null, když nejsou žádné předvybrané eventy");
  if (ctx.scoreChange && !entry.thesis_change_note) problems.push("thesis_change_note chybí, ale appka má dva snímky skóre k porovnání");
  if (!ctx.scoreChange && entry.thesis_change_note) problems.push("thesis_change_note má být null, když nejsou dva snímky skóre");
  if (entry.scenarios !== undefined) problems.push(...validateAgenda(entry.scenarios, ctx.scenarioSeeds ?? []));
  return problems;
}

async function main() {
  const events = await loadAllCalendarEvents();
  const basket = await loadBasketContext();

  if (MODE === "export") {
    for (const code of CURRENCIES) {
      const ctx = await loadCurrencyContext(code, events, basket);
      console.log(`===PAYLOAD ${code}===`);
      console.log(JSON.stringify(payloadOf(code, ctx)));
      console.log(`===END ${code}===`);
    }
    return;
  }

  if (MODE !== "apply") throw new Error(`neznámý MODE: ${MODE}`);
  if (!/^data\/ai-narratives\/[\w.-]+\.json$/.test(FILE)) throw new Error("FILE musí být data/ai-narratives/<soubor>.json");
  const entries = JSON.parse(readFileSync(FILE, "utf8"));
  let failed = 0;
  for (const rawEntry of entries) {
    const code = rawEntry.currency_code;
    if (CURRENCIES.length && !CURRENCIES.includes(code)) continue;
    const ctx = await loadCurrencyContext(code, events, basket);
    // Záznam bez pole "narrative" = jen aktualizace agendy / forward_flag: text příběhu se převezme
    // z posledního uloženého řádku (vznikne nová verze, historie zůstává). Platí jen pro případ, kdy
    // se skóre od uloženého textu nezměnilo — jinak je třeba napsat text znovu.
    const { data: prev } = await supabase.from("latest_narratives").select("narrative, forward_flag, conviction_note, thesis_change_note, scenarios, score_snapshot").eq("currency_code", code).limit(1);
    let entry = rawEntry;
    if (rawEntry.narrative === undefined) {
      const p0 = prev?.[0];
      const snapScore = Number(p0?.score_snapshot?.overall_score);
      const nowScore = Number(ctx.cot?.overallScore);
      if (!p0 || !(Math.abs(snapScore - nowScore) < 0.05)) {
        failed++;
        console.error(`[${code}] NEPROŠLO: záznam bez "narrative", ale skóre se od uloženého textu změnilo (${snapScore} → ${nowScore}) — napiš text znovu.`);
        continue;
      }
      entry = { currency_code: code, narrative: p0.narrative, forward_flag: p0.forward_flag, conviction_note: p0.conviction_note, thesis_change_note: p0.thesis_change_note, ...rawEntry };
    }
    const problems = check(entry, ctx);
    if (problems.length) {
      failed++;
      console.error(`[${code}] NEPROŠLO kontrolou:\n  - ${problems.join("\n  - ")}`);
      continue;
    }
    const row = {
      currency_code: code,
      narrative: entry.narrative.trim(),
      forward_flag: entry.forward_flag ?? null,
      conviction_note: entry.conviction_note.trim(),
      thesis_change_note: ctx.scoreChange ? entry.thesis_change_note : null,
      // Agenda: nová (zkontrolovaná proti výběru událostí), jinak přenesená beze změny.
      scenarios: entry.scenarios !== undefined ? entry.scenarios : prev?.[0]?.scenarios ?? [],
      model: MODEL_LABEL,
      input_fingerprint: buildInputFingerprint(ctx),
      score_snapshot: contextScoreSnapshot(ctx),
    };
    if (entry.scenarios === undefined) console.log(`[${code}] POZOR: agenda se nemění (v souboru chybí "scenarios") — přenáší se stará.`);
    if (DRY_RUN) {
      console.log(`[${code}] prošlo kontrolou — DRY_RUN, neukládám (${row.narrative.length} znaků, skóre ${JSON.stringify(row.score_snapshot)}).`);
      continue;
    }
    const { error } = await supabase.from("narratives").insert(row);
    if (error) {
      failed++;
      console.error(`[${code}] chyba zápisu: ${error.message}`);
    } else console.log(`[${code}] uloženo (model ${MODEL_LABEL}, ${row.narrative.length} znaků).`);
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
