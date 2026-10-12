// Makro agenda — výběr událostí a kontrola ručně napsané agendy. Čisté funkce bez databáze a bez
// OpenAI, aby šly testovat (generate-narrative.mjs při importu vyžaduje klíče v prostředí).
import { getWeight, matchRule } from "./fundamental-scoring.mjs";

export const MAX_AGENDA_ITEMS = 8;
// Zveřejněné výsledky smí zabrat nejvýš tolik míst. Agenda je hlavně pohled DOPŘEDU (co přijde);
// původní výběr nechával zveřejněné události zabírat místa a nadcházející vypadávaly (USD měla
// 7 hotových a 1 nadcházející, CPI z 14. 10. chybělo).
export const MAX_RESOLVED_ITEMS = 2;
export const MIN_RESOLVED_WEIGHT = 1.5;
export const MAX_KEY_ITEMS = 2;

export const VALID_TIERS = new Set(["klíčový", "druhořadý", "kontext"]);
export const VALID_REACTIONS = new Set(["silná", "omezená", "asymetrická"]);

// Sub-národní printy uvnitř eurozóny tezí o EUR hýbou míň než celoeurozónový agregát.
const SUBNATIONAL_PREFIXES = ["french", "german", "spanish", "italian"];
const SUBNATIONAL_DAMP = 0.6;

export function agendaWeight(title) {
  const lower = (title || "").toLowerCase();
  const damp = SUBNATIONAL_PREFIXES.some((p) => lower.startsWith(p)) ? SUBNATIONAL_DAMP : 1;
  return getWeight(title) * damp;
}

// Méně výpovědní ukazatele uvnitř téže kategorie (týdenní žádosti, ADP, mzdy, ceny výrobců) ustoupí
// hlavním (míra nezaměstnanosti, zaměstnanost, CPI). Bez toho týdenní žádosti o podporu obsadily
// slot celé kategorie práce a PPI slot inflace (japonské národní CPI se do agendy nedostalo).
// Platí jen pro výběr agendy; forward_flag a skóre dál používají agendaWeight.
const LOW_PRIORITY = /\b(ppi|adp|weekly)\b|producer price|claims|claimant|earnings|wage|payrolls/i;
const LOW_PRIORITY_PENALTY = 0.6;

export function seedPriority(title) {
  return agendaWeight(title) - (LOW_PRIORITY.test(title || "") ? LOW_PRIORITY_PENALTY : 0);
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Vybere události pro agendu. `candidates`: {date, title, actual, ...} (okno: pár dní zpět až
 * 21 dní dopředu). Pravidla:
 *  - nadcházející = bez výsledku a ode dneška dál; událost z minulosti bez výsledku se vynechá
 *    (výsledek zatím nemáme, ukazovat ji jako „nadcházející" by klamalo);
 *  - nejvýš MAX_RESOLVED_ITEMS zveřejněných (nejčerstvější, z různých kategorií, s váhou ≥ 1,5);
 *  - zbytek nadcházející: nejdřív nejdůležitější z každé kategorie, pak doplnit podle váhy;
 *  - události s nulovou váhou nikdy;
 *  - výsledek je seřazen chronologicky.
 */
export function selectScenarioSeeds(candidates, today = isoToday()) {
  const weighted = candidates
    .map((ev) => ({ ...ev, _weight: seedPriority(ev.title), _cat: matchRule(ev.title)?.cat ?? null }))
    .filter((ev) => agendaWeight(ev.title) > 0);

  const resolved = weighted
    .filter((ev) => ev.actual && ev._weight >= MIN_RESOLVED_WEIGHT)
    .sort((a, b) => b.date.localeCompare(a.date) || b._weight - a._weight);
  const pending = weighted
    .filter((ev) => !ev.actual && ev.date >= today)
    .sort((a, b) => b._weight - a._weight || a.date.localeCompare(b.date));

  const seeds = [];
  const seen = new Set();
  const add = (ev) => {
    const key = `${ev.date}|${ev.title}`;
    if (seen.has(key) || seeds.length >= MAX_AGENDA_ITEMS) return false;
    seen.add(key);
    seeds.push(ev);
    return true;
  };

  const resolvedCats = new Set();
  let nResolved = 0;
  for (const ev of resolved) {
    if (nResolved >= MAX_RESOLVED_ITEMS) break;
    if (resolvedCats.has(ev._cat)) continue;
    if (add(ev)) {
      resolvedCats.add(ev._cat);
      nResolved++;
    }
  }

  const pendingCats = new Set();
  for (const ev of pending) {
    if (pendingCats.has(ev._cat)) continue;
    if (add(ev)) pendingCats.add(ev._cat);
  }
  for (const ev of pending) add(ev);

  return seeds
    .map(({ _weight, _cat, ...ev }) => ev)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const MIN_OUTCOME_WORDS = 6;
const wordCount = (t) => (typeof t === "string" ? t.trim().split(/\s+/).filter(Boolean).length : 0);
const REQUIRED_TEXT = ["why_it_matters", "market_expectation", "thesis_test", "reaction_note"];

/**
 * Zkontroluje ručně napsanou agendu proti vybraným událostem. Vrací seznam problémů (prázdný = OK).
 * Agenda musí pokrýt přesně vybrané události, žádná navíc ani chybějící — tím se zabrání vymyšleným
 * událostem a zastaralým přenosům.
 */
export function validateAgenda(scenarios, seeds) {
  const problems = [];
  if (!Array.isArray(scenarios)) return ["scenarios musí být pole"];
  const key = (title, date) => `${date}|${title}`;
  const seedByKey = new Map(seeds.map((s) => [key(s.title, s.date), s]));
  const used = new Set();
  for (const s of scenarios) {
    const k = key(s?.event, s?.date);
    const seed = seedByKey.get(k);
    if (!seed) {
      problems.push(`agenda obsahuje událost mimo výběr aplikace: ${s?.date} ${s?.event}`);
      continue;
    }
    if (used.has(k)) problems.push(`událost je v agendě dvakrát: ${k}`);
    used.add(k);
    if (!VALID_TIERS.has(s.tier)) problems.push(`${k}: neplatný tier`);
    if (!VALID_REACTIONS.has(s.reaction)) problems.push(`${k}: neplatná reaction`);
    for (const f of REQUIRED_TEXT) {
      if (wordCount(s[f]) < 4) problems.push(`${k}: pole ${f} je prázdné nebo příliš krátké`);
    }
    if (seed.actual) {
      if (wordCount(s.outcome) < MIN_OUTCOME_WORDS) problems.push(`${k}: výsledek už vyšel, outcome musí být celá věta`);
    } else if (s.outcome != null) {
      problems.push(`${k}: událost ještě nevyšla, outcome musí být null`);
    }
    // Chybějící konsenzus se nesmí tvářit jako číslo.
    if ((seed.estimate == null || seed.estimate === "") && /\d/.test(String(s.market_expectation ?? "")) && !/bez konsen|konsens(us)? (není|chybí)|nemáme/i.test(s.market_expectation)) {
      problems.push(`${k}: konsenzus v datech není, market_expectation ale uvádí čísla bez poznámky „bez konsenzu"`);
    }
  }
  for (const k of seedByKey.keys()) if (!used.has(k)) problems.push(`v agendě chybí vybraná událost: ${k}`);
  if (scenarios.filter((s) => s?.tier === "klíčový").length > MAX_KEY_ITEMS) {
    problems.push(`nejvýš ${MAX_KEY_ITEMS} položky smí být „klíčový"`);
  }
  return problems;
}
