// "Vypravěč" — skládá ze VŠECH pilířů (COT + retail pozicování + fundament/kalendář +
// CB politika/real yield/zaceněnost + risk režim + basket kontext) soudržný fundamentální
// příběh přes OpenAI, včetně explicitní scénářové predikce ("když X, tak Y") pro nejbližší
// důležité eventy. Tohle je jediný krok v pipeline, který skutečně "rozumí" datům, ne jen
// počítá vzorec — proto LLM, ne deterministický kód.

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { getEventHistoryTrend, getWeight, eventDirection, matchRule } from "./fundamental-scoring.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// gpt-5.6-luna — živě ověřeno (2026-08-03): funguje na strict json_schema, nepodporuje
// temperature (viz samplingParams níž), podporuje reasoning_effort a je novější/kvalitnější
// rodina než gpt-4o-mini při cca $0.20/$1.20 za 1M tokenů (in/out) — o něco dražší na token
// než gpt-4o-mini ($0.15/$0.60), ale při objemu appky (řádově desítky volání denně) je rozdíl
// v absolutních dolarech zanedbatelný a appka tím řeší reálný požadavek na kvalitu (konzistence
// jazyka, méně halucinací), ne primárně cenu.
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const truthy = (v) => /^(1|true|yes|on)$/i.test((v ?? "").trim());

// Jednorázové vynucení z workflow_dispatch — přegeneruje všechno bez ohledu na otisk vstupů.
const FORCE_REGENERATE = truthy(process.env.FORCE_REGENERATE);
// Trvalý vypínač celé detekce změn (repo variable). Návrat k původnímu chování "generuj vždy
// všechno" bez revertu kódu — kdyby se přeskakování chovalo nečekaně.
const DISABLE_INPUT_HASH = truthy(process.env.DISABLE_INPUT_HASH);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Chybí OPENAI_API_KEY v prostředí.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const UPCOMING_DAYS = 21;
const RECENT_DAYS = 90;
// 8 položek, ne 3 — agenda má pokrýt VŠECHNY kategorie, co reálně hýbou tezí (sazby, inflace/PCE,
// nezaměstnanost, zaměstnanost/mzdy, HDP, PMI, maloobchod = 7 kategorií z EVENT_RULES) + jeden
// slot navíc. Se starým limitem 3 a čistě váhovým výběrem se PMI/maloobchod/HDP do agendy
// prakticky nikdy nedostaly, protože je vždy vytlačily sazby (w 3.5) a inflace/práce (w 3.0).
const MAX_AGENDA_ITEMS = 8;
const MAX_KEY_ITEMS = 2; // strop na tier "klíčový" — viz degradace po parsování odpovědi
const SCENARIO_LOOKBACK_DAYS = 5; // jak dlouho po zveřejnění actual event ještě zůstává v agendě (s komentářem k výsledku)

// Enumy, které smí model použít. Normalizujeme deterministicky (viz zpracování odpovědi níž) —
// UI se musí spolehnout na to, že tam nikdy nepřistane nečekaná hodnota.
const VALID_TIERS = new Set(["klíčový", "druhořadý", "kontext"]);
const VALID_REACTIONS = new Set(["silná", "omezená", "asymetrická"]);

// Sub-národní printy uvnitř eurozóny spadají do stejných kategorií EVENT_RULES jako
// celoeurozónové agregáty, ale tezí o EUR hýbou míň. Bez tohohle útlumu obsadil kategorii
// "GDP" francouzský Flash GDP a eurozónový agregát se do agendy vůbec nedostal (ověřeno
// živě). Útlum, ne vyřazení — německé CPI je pořád předstihový ukazatel pro eurozónu.
const SUBNATIONAL_PREFIXES = ["french", "german", "spanish", "italian"];
const SUBNATIONAL_DAMP = 0.6;

function agendaWeight(title) {
  const lower = (title || "").toLowerCase();
  const damp = SUBNATIONAL_PREFIXES.some((p) => lower.startsWith(p)) ? SUBNATIONAL_DAMP : 1;
  return getWeight(title) * damp;
}

// Směrový dopad překvapení je ČISTÁ LOGIKA (EVENT_RULES.dir × směr teze), ne úsudek — a model
// ho v živém běhu opakovaně obracel: "růst zaměstnanosti nad 20 000 by posílil naši bearish
// tezi" nebo "pokles nezaměstnanosti potvrzuje bearish obavy". Obrácený směr je horší než
// neohrabaná věta, protože čtenáře aktivně zmate zrovna v poli, kvůli kterému sekce existuje.
// Počítáme to tady a do promptu to jde jako fakt, který model nesmí popřít.
function beatImplication(title, thesisDirection) {
  const rule = matchRule(title);
  if (!rule) return null;

  // dir === -1 jsou kategorie, kde vyšší číslo je HORŠÍ (nezaměstnanost, žádosti o podporu).
  const beatIsBullish = rule.dir !== -1;
  const bias = beatIsBullish ? "býčí" : "medvědí";

  if (thesisDirection !== "bullish" && thesisDirection !== "bearish") {
    return `vyšší hodnota než odhad je ${bias} pro tuhle měnu`;
  }

  const supports = beatIsBullish === (thesisDirection === "bullish");
  return `vyšší hodnota než odhad je ${bias} pro tuhle měnu → ${
    supports ? "POTVRZUJE" : "ZPOCHYBŇUJE"
  } současnou ${thesisDirection} tezi`;
}

// U JIŽ VYŠLÝCH eventů nestačí dát modelu směrové pravidlo — v živém běhu selhal už na samotném
// porovnání dvou čísel: "187K překonalo odhad" (odhad byl 211K, tedy actual byl NIŽŠÍ) a z toho
// odvodil opačný závěr. Verdikt proto počítáme celý kódem přes eventDirection(), který zná
// i obrácené kategorie, a model ho jen převypráví.
function resolvedVerdict(ev, thesisDirection) {
  if (!ev.actual || !ev.estimate) return null;

  const dir = eventDirection({ event_title: ev.title, actual: ev.actual, estimate: ev.estimate });
  const head = `actual ${ev.actual} vs odhad ${ev.estimate}`;
  if (dir === 0) return `${head} → V SOULADU s konsensem`;

  const bias = dir > 0 ? "býčí" : "medvědí";
  if (thesisDirection !== "bullish" && thesisDirection !== "bearish") {
    return `${head} → ${bias} pro tuhle měnu`;
  }

  const supports = (dir > 0) === (thesisDirection === "bullish");
  return `${head} → ${bias} pro tuhle měnu → ${
    supports ? "POTVRZUJE" : "ZPOCHYBŇUJE"
  } současnou ${thesisDirection} tezi`;
}

// Model dostává anglické názvy polí (convictionStars, pricedIn) a bez tohohle glosáře si k nim
// vymýšlel české ekvivalenty — v jednom běhu "Konviktce", "konvicí" i "konviktivnost" pro tentýž
// pojem napříč měnami. Sdílené oběma kroky, protože jde o vadu jazyka, ne o vadu délky odpovědi.
const GLOSSARY = `ZÁVAZNÁ TERMINOLOGIE — appka tyhle výrazy používá v UI, drž se jich doslova a nevymýšlej vlastní tvary:
- conviction / convictionStars → "konvikce" (NIKDY "konviktce", "konvicita", "konviktivnost", "konvice", "konvicience")
- pricedIn → "zaceněnost"
- positioning → "pozicování"
- leveraged funds → "velcí spekulanti"
- retail sentiment → "retail sentiment" nebo "pozicování drobných spekulantů"
- beat / miss → "překonal odhad" / "zaostal za odhadem"
- driver → "driver" (běžně se v češtině v tomhle oboru nepřekládá)

Piš spisovnou, gramaticky správnou češtinou. Nepoužívej anglické slovo tam, kde má tenhle seznam český tvar. Když si nejsi jistý odborným výrazem, opiš ho běžnými slovy — srozumitelný opis je vždy lepší než vymyšlený patvar. Tohle čte profesionál a zkomolená věta je horší než žádná. Piš VÝHRADNĚ latinkou s českou diakritikou — appka živě zachytila případ, kdy se v jinak českém textu objevila azbuka; žádné jiné písmo (cyrilice, řečtina, CJK znaky...) se do odpovědi nesmí dostat ani omylem.`;

const SHARED_CONTEXT = `Jsi profesionální makro trader FX fondu. Dostaneš strukturovaná fundamentální data o jedné měně:
- COT pozicování velkých spekulantů (cot) a retail pozicování malých spekulantů (retailSentiment) — pozicování je RIZIKOVÝ FILTR, ne směrový signál: přeplněný obchod je křehký, i správná teze se dá vyždímat.
- Kvantitativní fundamentální skóre z nedávných ekonomických dat (fundamental).
- Politiku centrální banky — trajektorie (hiking/cutting/hold cyklus), real yield vůči ostatním měnám koše, a "zaceněnost" (pricedIn) — jak moc trh poslední rozhodnutí čekal (cbPolicy).
- Risk-on/risk-off tržní režim (riskRegime) — v risk-off táhnou JPY/CHF bez ohledu na vlastní data, v risk-on táhnou AUD/NZD/CAD.
- Kontext zbytku koše měn (basketContext) — FX je vždy relativní, píš o měně i VE VZTAHU k ostatním, ne v izolaci.
- Konvikce jako shoda nezávislých signálů (convictionStars/convictionReasons) — kolik nezávislých pohledů souhlasí, ne jak velké je jedno číslo.
- Aktuální otevřenou tezi appky (thesis) — směr, konvikce, jednotlivé drivery s hodnotami a stavem, a jestli je teze aktivní nebo se jen sleduje. TOHLE je "současný příběh", vůči kterému se poměřuje všechno ostatní.

Důležité ohraničení role: tvůj úkol je vysvětlit PROČ — makro kontext, důvody, souvislosti mezi pilíři. NIKDY nepiš přímé obchodní doporučení ("kup", "prodej", "vstup", "vystup", konkrétní cenové úrovně, stop-loss/take-profit) — appka neřeší timing, risk management ani technickou konfluenci na grafu, to je úloha samostatného nástroje (Fx Analyzer). Piš jako institucionální analytik, co vysvětluje kontext šéfovi, ne jako signál generátor.

Buď upřímný ohledně nejistoty: pokud jsou signály smíšené, je málo historických dat, nebo "zaceněnost" vychází jen z konsensu posledního rozhodnutí (ne z reálných tržních dat), řekni to — nepředstírej jistotu, kterou data nemají.

Čísla ber VÝHRADNĚ z dat, která jsi dostal, a hlídej si směr: když je hodnota nižší než předchozí, je to POKLES, ne růst. Nikdy si číslo nedomýšlej — radši ho vynech a popiš trend slovy.

KRITICKÉ — přechod přes nulu mění POJEM, ne jen tempo. Živě zachycená chyba: CHF CPI m/m odhad -0,1 % z předchozích 0,0 % byl popsán jako "potvrzení dezinflace" — správně jde o DEFLAČNÍ tisk, ne dezinflaci.
- "dezinflace" smíš použít JEN když je hodnota (m/m i y/y) pořád KLADNÁ a jen zpomaluje tempo (např. 2,6 % → 2,4 %).
- Jakmile je hodnota — ODHAD, ACTUAL, nebo i jen PŘEDCHOZÍ — ZÁPORNÁ, jde o DEFLACI (skutečný pokles cen v tom období), i kdyby šlo jen o jeden měsíc. Nikdy tomu neříkej "dezinflace".
- Stejné pravidlo plať i jinde, kde přechod přes nulu mění kvalitativní pojem, ne jen velikost: záporný růst HDP je RECESE/KONTRAKCE, ne "zpomalení růstu" (to je jen pro pořád kladný, ale nižší růst).

${GLOSSARY}`;

const NARRATIVE_PROMPT = `${SHARED_CONTEXT}

Dostaneš navíc kontext zbytku koše měn (basketContext) — FX je vždy relativní, piš o měně i VE VZTAHU k ostatním, ne v izolaci — a nadcházející (upcomingEvents) i nedávno vyšlé eventy (recentEvents).

Tvým úkolem je napsat soudržný fundamentální příběh v češtině — ne jen popsat čísla, ale vysvětlit PROČ se měna chová, jak se chová, včetně situací, kdy jednotlivá data protiřečí (např. "poslední data vyšla hůř, než se čekalo, ALE COT pozicování zůstává extrémně long a historicky se po podobných zklamáních měna spíš stabilizovala"). Dej explicitní upozornění na navazující eventy — pokud se blíží důležité rozhodnutí, ale předtím vyjde jiný klíčový event, řekni to jasně a vysvětli, proč na to čekat.

POLE "thesis_change_note" — vysvětlení posledního pohybu skóre. Píšeš ho jako makro analytik hedgeového fondu, který vysvětluje kolegovi, co se změnilo a jestli to má nějaký význam.

Podklady dostaneš dva, oba SPOČÍTANÉ, ne odhadnuté:
- "scoreChange" — předchozí a aktuální skóre, rozdíl, a rozpad po komponentách (pole "components", seřazené sestupně podle velikosti pohybu; první položka je hlavní viník změny). Tahle čísla jsou fakt, přebírej je, nepřepočítávej ani nezaokrouhluj jinak. KAŽDÁ položka v "components" má i "verdict" ("zlepšilo"/"zhoršilo"/"beze změny") — jestli se komponenta pro tu měnu zlepšila nebo zhoršila, je SPOČÍTANÉ z delty, ne k odhadu. Živě nahlášená chyba: model u záporného čísla, co se přiblížilo k nule (např. -4.8 → -4.6), napsal "zhoršilo", i když je to zlepšení (méně bearish). NIKDY neurčuj zlepšilo/zhoršilo sám ze znaménka čísla — vždy použij "verdict" doslova.
- "recentLedger" — deterministické klasifikace z Thesis Enginu za posledních 7 dní: "confirms" = driver dál sedí, "challenges" = poprvé nesedí, "invalidates_driver" = nesedí podruhé a byl z teze odebrán, "closed" = teze uzavřena, "opened" = nová teze.

Napiš 2-4 věty, které odpoví na tohle pořadí otázek:
1. KTERÁ komponenta skóre pohnula — vezmi první položku z "components" a uveď její pohyb číselně i slovní verdikt ("verdict") tak, jak je spočítaný.
2. PROČ se pohnula — a tady smíš čerpat VÝHRADNĚ z "recentEvents" a "scenarioSeeds", které máš v kontextu. Když se hnul fundament, hledej mezi nedávno vyšlými daty ten konkrétní print, který to způsobil, a pojmenuj ho. Když v datech žádné vysvětlení není, napiš na rovinu, že se skóre posunulo bez jediného zřejmého katalyzátoru — TO JE SPRÁVNÁ ODPOVĚĎ, ne selhání. NIKDY si důvod nedomýšlej a nikdy nezmiňuj událost, kterou v datech nemáš.
3. MĚNÍ TO PŘÍBĚH, NEBO NE — rozhodni podle "recentLedger", ne podle velikosti čísla: "invalidates_driver" nebo "closed" znamená zásah do konstrukce teze (příběh se mění), samé "confirms" znamená, že jde jen o pohyb v rámci běžícího příběhu. Řekni to natvrdo, ne vyhýbavě.

Když "scoreChange" chybí nebo je null (appka ještě nemá dva snímky k porovnání), vrať "thesis_change_note" jako null. Nevymýšlej si změnu, která se nestala.

POLE "forward_flag" — appka ho zobrazuje jako "navazující eventy", pod hlavním příběhem. Dostaneš k tomu "flaggedEvents" — appka ti TAM UŽ VYBRALA, které nadcházející eventy jsou důležité (podle stejné váhové logiky jako makro agenda: sazby/inflace/práce mají přednost před vedlejšími printy typu komoditní indexy). VÝBĚR EVENTŮ NENÍ TVOJE ROZHODNUTÍ — "forward_flag" smí mluvit JEN o eventech z "flaggedEvents", nikdy o jiném (i kdyby byl chronologicky blíž). Živě nahlášená chyba: model bez týhle pojistky vzal nejbližší nadcházející event (nízkovážený mléčný cenový index hned zítra) místo skutečně důležitého Employment Change/Unemployment Rate o den později, které appka jinde v agendě sama označuje jako "klíčový" — appka teď posílá jen tu důležitou množinu, takže si nic nepleteš.

Napiš JEDNU AŽ DVĚ CELÉ VĚTY (nikdy jen holé datum nebo název eventu bez vysvětlení), které obsahují tři věci najednou:
1. KDY — konkrétní datum doslova podle "flaggedEvents" / "date", ve tvaru jako v příkladu "5. srpna". NIKDY vágní/domýšlenou relativní frázi jako "příští týden" nebo "brzy".
2. CO — název eventu/eventů z "flaggedEvents" (pokud jich je v seznamu víc a jsou v řadě po sobě, klidně zmiň víc než jeden — proto se pole jmenuje "navazující eventy").
3. PROČ — na co si má trader u toho eventu dát pozor vzhledem k současné tezi, ne obecnou definici indikátoru.
Appka živě zachytila i opačnou chybu, než tu s vágním datem: model jednou vrátil doslova jen "5. srpna" bez jediného slova vysvětlení — holé datum bez kontextu je pro čtenáře k ničemu a appka takovou odpověď zahazuje a nahrazuje záložním textem, takže ji nikdy nevracej. Vrať null jen když je "flaggedEvents" prázdné pole.

Odpověz strukturovaným JSON: "narrative" (hlavní příběh, 3-6 vět), "forward_flag" (viz výš, nebo null), "conviction_note" (jedna až dvě věty vysvětlující, jak moc si má trader být jistý tímhle čtením a proč — zmiň konvikci, pokud je nízká), "thesis_change_note" (viz výš, nebo null).`;

const AGENDA_PROMPT = `${SHARED_CONTEXT}

Dostaneš navíc HOTOVÉ shrnutí příběhu ("narrative"), které appka právě zveřejnila, a předvybrané eventy (scenarioSeeds) napříč kategoriemi (sazby, inflace/PCE, nezaměstnanost, zaměstnanost/mzdy, HDP, PMI, maloobchod). Tvým úkolem je napsat MAKRO AGENDU, která na to shrnutí přímo navazuje — stejný příběh, stejné pojmy, stejná teze. Čtenář právě dočetl "narrative"; agenda mu má říct, co s tím příběhem může pohnout, ne začínat znovu od nuly.

Agenda NENÍ ekonomický kalendář. Rozdíl: kalendář říká "kdy co vyjde", agenda říká "co z toho může změnit můj současný pohled a co je už dávno v ceně".

KRITICKÉ — směr překvapení. Appka ti dvě věci spočítala DETERMINISTICKY a ty je NESMÍŠ popřít ani přeformulovat do opaku. Jsou to fakta, ne návrhy k posouzení:
- "beatImplication" — co znamená vyšší hodnota než odhad (u nezaměstnanosti a žádostí o podporu je VYŠŠÍ číslo pro měnu HORŠÍ, takže "lepší data" tam znamenají NIŽŠÍ číslo).
- "resolvedVerdict" — u eventů, které už vyšly: hotové porovnání actual vs odhad včetně toho, jestli výsledek tezi potvrzuje, nebo zpochybňuje. Sám čísla NEPOROVNÁVEJ a nedomýšlej, jestli něco "překonalo odhad" — přečti si verdikt a jen ho vysvětli vlastními slovy. Když verdikt říká ZPOCHYBŇUJE, nesmí "outcome" tvrdit, že výsledek tezi potvrdil. Rozdíl: kalendář říká "kdy co vyjde", agenda říká "co z toho může změnit můj současný pohled a co je už dávno v ceně". Nikdy nepiš popis toho, co daný indikátor obecně měří — čtenář ví, co je CPI. Piš, co ten konkrétní print znamená PRO TUHLE MĚNU a PRO TUHLE TEZI právě teď.

Pro KAŽDÝ event ve "scenarioSeeds" vyplň:
- "tier": "klíčový" = může sám o sobě překlopit nebo výrazně potvrdit tezi; "druhořadý" = posune konvikci, ale sám tezi nezmění; "kontext" = tezí hne jen při extrémním překvapení. TVRDÉ PRAVIDLO: nejvýš DVĚ položky v celé agendě smí být "klíčový" — když váháš mezi klíčový a druhořadý, je to druhořadý. Co je plně zaceněné nebo co tezí realisticky pohnout nemůže, patří do "kontext" bez ohledu na to, jak sledovaný ten indikátor obecně je. "kontext" není známka selhání — poctivé zařazení je přesně to, co čtenáři šetří čas.
- "why_it_matters": proč tenhle konkrétní print teď rozhoduje — napoj to na konkrétní driver teze (thesis.drivers) nebo na to, co tvrdí "narrative". ZAKÁZANÉ jsou učebnicové definice typu "HDP je klíčové měřítko ekonomické výkonnosti", "mzdy ovlivňují kupní sílu domácností" nebo "rozhodnutí o sazbách je zásadní pro měnovou politiku" — to čtenář ví a nemá z toho vůbec nic. Správně zní: "teze stojí na tom, že trh podceňuje odolnost trhu práce — tohle je první přímý test toho předpokladu".
- "market_expectation": co trh čeká, přeložené do makro věty, ne holé číslo — konsensus VŮČI předchozí hodnotě a co ta trajektorie implikuje ("čeká se zpomalení na 2.4 % z 2.6 %, tedy potvrzení dezinflace a prostor pro další cut").
- "thesis_test": KONKRÉTNÍ laťka — co by muselo vyjít, aby to současnou tezi skutečně změnilo, ne vágní "kdyby to bylo horší". Kde to jde, uveď přibližnou hodnotu nebo rozsah a řekni, kterého driveru teze by se to dotklo. Pokud tenhle event tezí realisticky pohnout NEMŮŽE, napiš to na rovinu — to je cenná informace, ne selhání.
- "reaction": "silná" = trh na to reálně zareaguje; "omezená" = z velké části už v ceně nebo nízká informační hodnota; "asymetrická" = jedna strana překvapení hne trhem výrazně víc než druhá.
- "reaction_note": jedna věta PROČ — opři se o zaceněnost (cbPolicy.pricedIn), pozicování (cot/retailSentiment, cotPercentile — přeplněný obchod zvětšuje reakci na překvapení proti pozici) a risk režim. U "asymetrická" VŽDY řekni, KTERÁ strana překvapení váží víc a proč.

Navíc: pokud má seed vyplněné pole "actual" (výsledek už je zveřejněný), napiš i "outcome" — profesionální zhodnocení SKUTEČNÉHO výsledku, ne jen zopakování čísel. Řekni, jestli to bylo beat/miss/v souladu s konsensem, JAK moc to bylo signifikantní, a co to znamená DÁL — potvrdil ten výsledek tezi, nebo jí odporuje? Piš to jako trader, co právě dostal číslo na obrazovku. "outcome" MUSÍ být VŽDY buď null (event ještě neproběhl), NEBO alespoň jedna celá věta s vysvětlením (minimálně 15-20 slov) — NIKDY jen holé slovo jako "beat", "miss" nebo "v souladu", to je pro tradera k ničemu.

KAŽDOU položku agendy zpracuj stejně důkladně — i sedmou a osmou. Nezkracuj kvalitu u pozdějších položek; radši piš u všech krátce a hutně než u prvních rozvláčně a u posledních jednoslovně.

Odpověz strukturovaným JSON: "scenarios" (agenda, pole max 8 položek — jedna položka na každý event ve scenarioSeeds, prázdné pole pokud scenarioSeeds nic neobsahuje).`;

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

// Bezpečnostní síť proti tomu, co jsme viděli živě: model občas u pozdější položky v poli
// "scenarios" zkratkuje a vrátí jen holé slovo ("beat"), ne vysvětlující větu — i přes
// explicitní instrukci v system promptu. Prompt engineering to omezí, ale nezaručí; tenhle
// deterministický fallback garantuje, že do UI se nikdy nedostane nic kratšího než pár slov.
const MIN_OUTCOME_WORDS = 6;

function isTooShortOutcome(text) {
  return !text || text.trim().split(/\s+/).length < MIN_OUTCOME_WORDS;
}

function buildFallbackOutcome(seed) {
  const dir = eventDirection({ event_title: seed.title, actual: seed.actual, estimate: seed.estimate });
  const verdict = dir > 0 ? "překonalo odhad" : dir < 0 ? "zaostalo za odhadem" : "odpovídalo konsensu";
  return `${seed.title} vyšlo na ${seed.actual} (odhad ${seed.estimate ?? "N/A"}, předchozí ${seed.previous ?? "N/A"}) — data ${verdict}.`;
}

const CZ_MONTHS_GENITIVE = [
  "ledna", "února", "března", "dubna", "května", "června",
  "července", "srpna", "září", "října", "listopadu", "prosince",
];

function formatCzechDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return `${d.getUTCDate()}. ${CZ_MONTHS_GENITIVE[d.getUTCMonth()]}`;
}

// Stejná bezpečnostní síť jako u "outcome" (viz výš), pro stejnou třídu chyby v jiném poli.
// Živě nahlášená chyba (NZD, audit 2026-08-03): poté, co prompt začal vyžadovat doslovné datum
// místo vágní fráze, model to vzal příliš doslovně a vrátil jako CELÝ obsah pole "forward_flag"
// jen "5. srpna" — žádný název eventu, žádné vysvětlení, proč na to dávat pozor. Holé datum bez
// věty je pro čtenáře stejně k ničemu jako vágní fráze, kterou to nahradilo. Prompt engineering
// (viz NARRATIVE_PROMPT) tomu teď brání explicitně, ale stejně jako u "outcome" to negarantuje —
// proto deterministický fallback, co poskládá větu přímo z nadcházejících eventů appky.
const MIN_FORWARD_FLAG_WORDS = 6;

function isTooShortForwardFlag(text) {
  return !text || text.trim().split(/\s+/).length < MIN_FORWARD_FLAG_WORDS;
}

// Druhá bezpečnostní síť pro stejné pole, pro tu skutečnou třídu chyby, co appka živě nahlásila:
// model nepsal moc krátce, psal PLYNULOU větu, ale o ŠPATNÉM eventu (nejbližší chronologicky
// mléčný cenový index místo skutečně důležitého Employment Change/Unemployment Rate o den
// později). Kontrola délky by tohle nikdy nechytila — proto ověřujeme, že text doslova obsahuje
// datum aspoň jednoho z "flaggedEvents" (appkou předvybraných podle důležitosti).
function forwardFlagCitesFlaggedEvent(text, flaggedEvents) {
  if (!text || !flaggedEvents || flaggedEvents.length === 0) return false;
  return flaggedEvents.some((e) => text.includes(formatCzechDate(e.date)));
}

// Poskládá záložní větu přímo z "flaggedEvents" (viz selectFlaggedEvents níž — appka je tam už
// vybrala podle důležitosti, ne chronologické blízkosti, a chronologicky seřadila). Zmíní i
// DRUHÝ nejbližší den, pokud existuje, aby fallback pokryl i případ "napřed méně důležitý event,
// pak zásadní rozhodnutí", který appka v UI zobrazuje jako "navazující eventy" — ne jen jeden
// izolovaný event bez návaznosti.
function buildFallbackForwardFlag(flaggedEvents) {
  if (!flaggedEvents || flaggedEvents.length === 0) return null;

  const firstDate = flaggedEvents[0].date;
  const sameDay = flaggedEvents.filter((e) => e.date === firstDate);
  const laterDay = flaggedEvents.find((e) => e.date !== firstDate);

  let text = `${formatCzechDate(firstDate)} vychází ${sameDay.map((e) => e.title).join(" a ")} — sleduj, jestli výsledek potvrdí, nebo zpochybní současnou tezi.`;
  if (laterDay) {
    text += ` Navazuje ${formatCzechDate(laterDay.date)}: ${laterDay.title}.`;
  }
  return text;
}

async function loadBasketContext() {
  const { data } = await supabase
    .from("latest_confluence_scores")
    .select("currency_code, overall_score, conviction_label");
  const map = {};
  for (const row of data ?? []) {
    map[row.currency_code] = { overallScore: row.overall_score, convictionLabel: row.conviction_label };
  }
  return map;
}

async function loadMarketRegime() {
  const { data } = await supabase.from("market_regime").select("vix, vix_5d_change, regime").limit(1);
  return data?.[0] ?? null;
}

// Vybere eventy pro makro agendu z kombinovaného okna (nedávno vyšlé + nadcházející).
// Eventy, co ve svém okně `actual` UŽ mají, zůstávají v agendě pár dní
// (SCENARIO_LOOKBACK_DAYS) po zveřejnění, aby appka mohla okomentovat i skutečný výsledek,
// ne jen hypotézu — viz `outcome` v system promptu. `candidates` je filtrované jen na PŘÍMÉ
// eventy tyhle měny (viz loadCurrencyContext), takže relevance faktor je vždy 1.
//
// Výběr jde ve TŘECH kolech, ne čistě podle váhy. Čistě váhový výběr (původní chování) totiž
// systematicky zahazoval celé kategorie: sazby (3.5) a inflace/práce (3.0) vždy obsadily
// všechny sloty a HDP (2.2) / PMI (1.8) / maloobchod (1.7) se do agendy nedostaly nikdy,
// i když právě ty často testují růstovou část teze.
function selectScenarioSeeds(candidates) {
  const weighted = candidates
    .map((ev) => ({ ...ev, _weight: agendaWeight(ev.title), _cat: matchRule(ev.title)?.cat ?? null }))
    .filter((ev) => ev._weight > 0)
    .sort((a, b) => b._weight - a._weight || a.date.localeCompare(b.date));

  // 1. kolo — zaručený slot pro NEJČERSTVĚJŠÍ již známý výsledek (ne nutně nejvýše váhou
  // ohodnocený v okně): jinak by ho vytlačil jak vyšší váhou ohodnocený budoucí event
  // (typicky sazby), tak starší stejně važený resolvnutý event. Mezi eventy ze stejného dne
  // rozhoduje váha.
  const topResolved = weighted
    .filter((ev) => ev.actual)
    .sort((a, b) => b.date.localeCompare(a.date) || b._weight - a._weight)[0];

  const seeds = [];
  const seen = new Set();
  const usedCats = new Set();
  const addSeed = (ev) => {
    const key = `${ev.date}|${ev.title}`;
    if (seen.has(key) || seeds.length >= MAX_AGENDA_ITEMS) return;
    seen.add(key);
    usedCats.add(ev._cat);
    seeds.push(ev);
  };

  if (topResolved) addSeed(topResolved);

  // 2. kolo — nejvýše vážený event z KAŽDÉ dosud nepokryté kategorie (weighted je řazené
  // podle váhy, takže první nalezený z kategorie je ten nejdůležitější).
  for (const ev of weighted) {
    if (!usedCats.has(ev._cat)) addSeed(ev);
  }

  // 3. kolo — zbylé sloty doplní nejvýše vážené eventy bez ohledu na kategorii.
  for (const ev of weighted) addSeed(ev);

  // Chronologicky — agenda se čte jako časová osa "co nás čeká", ne jako žebříček vah.
  return seeds
    .map(({ _weight, _cat, ...ev }) => ev)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const MAX_FLAGGED_EVENTS = 3;

// Vybere, na které konkrétní eventy smí "forward_flag" upozornit — čistě podle důležitosti
// (stejná agendaWeight jako u agendy), NE podle chronologické blízkosti. Živě nahlášená chyba
// (NZD, audit 2026-08-03): model bez týhle pojistky vzal nejbližší nadcházející event (GDT Price
// Index, nízkovážený mléčný index, hned zítra) místo skutečně důležitého Employment Change/
// Unemployment Rate o den později, které appka sama v agendě označuje jako "klíčový". Model má
// psát PROČ na to dávat pozor, ale KTERÉ eventy jsou hodny zmínky je fakt, ne jeho úsudek —
// stejný princip jako beatImplication/resolvedVerdict výš v souboru.
function selectFlaggedEvents(upcoming, max = MAX_FLAGGED_EVENTS) {
  return upcoming
    .map((ev) => ({ ...ev, _weight: agendaWeight(ev.title) }))
    .filter((ev) => ev._weight > 0)
    .sort((a, b) => b._weight - a._weight || a.date.localeCompare(b.date))
    .slice(0, max)
    .map(({ _weight, ...ev }) => ev)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Změna skóre ─────────────────────────────────────────────────────────────────────────
// Atribuce je čistá aritmetika nad dvěma uloženými snímky, ne úsudek. Model dostane hotové
// delty a smí je jen převyprávět — tím je vyloučené, že by si "co pohnulo skóre" domyslel.
const SCORE_COMPONENTS = [
  { key: "fundamental_score_adj", label: "Fundament + CB politika / real yield" },
  { key: "cot_score", label: "COT pozicování" },
  { key: "retail_score", label: "Retail sentiment" },
  { key: "risk_adj", label: "Risk režim" },
];

function buildScoreChange(snapsDesc) {
  if (!Array.isArray(snapsDesc) || snapsDesc.length < 2) return null;

  const [current, previous] = snapsDesc;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const round2 = (v) => Math.round(v * 100) / 100;

  const components = SCORE_COMPONENTS.map(({ key, label }) => {
    const prev = num(previous[key]);
    const curr = num(current[key]);
    if (prev === null || curr === null) return null;
    const delta = round2(curr - prev);
    // Živě nahlášená chyba (NZD, audit 2026-08-03): cot_score šel z -4.8 na -4.6 (delta +0.2,
    // tedy MÉNĚ bearish = zlepšení), ale narrativ napsal "zhoršení". Model měl na výběr jen
    // syrová čísla a "zlepšilo/zhoršilo" si domýšlel sám ze znaménka záporné hodnoty, ne z
    // delty — přesně stejná třída chyby jako beatImplication/resolvedVerdict výš v souboru.
    // Verdikt proto počítá kód (delta > 0 = zlepšilo, < 0 = zhoršilo, škála komponent je vždy
    // "vyšší = bullish pro měnu" bez ohledu na aktuální znaménko), model ho jen přebírá.
    const verdict = delta > 0.05 ? "zlepšilo" : delta < -0.05 ? "zhoršilo" : "beze změny";
    return { component: label, previous: prev, current: curr, delta, verdict };
  })
    .filter(Boolean)
    // Sestupně podle velikosti pohybu — na prvním místě je vždy hlavní viník změny.
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    previousScore: num(previous.overall_score),
    currentScore: num(current.overall_score),
    delta: round2(num(current.overall_score) - num(previous.overall_score)),
    previousConvictionStars: previous.conviction_stars ?? null,
    currentConvictionStars: current.conviction_stars ?? null,
    changedAt: current.recorded_at,
    previousAt: previous.recorded_at,
    components,
  };
}

// ── Detekce změny vstupů ────────────────────────────────────────────────────────────────
// Otisk je rozpadlý po sekcích, ne jeden slepený hash — díky tomu z porovnání vypadne rovnou
// DŮVOD regenerace ("změna: teze, kalendář") místo pouhého "něco se změnilo".
const SECTION_LABELS = {
  scores: "skóre/pozicování",
  thesis: "teze",
  cbPolicy: "CB politika",
  riskRegime: "risk režim",
  basket: "koš měn (překlopení směru)",
  seeds: "kalendář/výsledky",
};

function sectionHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

// Zaokrouhlení na 1 desetinné místo — skóre se počítají ve floatech a bez tohohle by otisk
// měnil i numerický šum na 15. desetinném místě, který se nikde nezobrazuje.
function round1(n) {
  return typeof n === "number" ? Math.round(n * 10) / 10 : null;
}

function buildInputFingerprint(context) {
  const { cot, fundamental, cbPolicy, thesis, retailSentiment, riskRegime, basketContext, scenarioSeeds } = context;

  return {
    scores: sectionHash({
      cot: round1(cot?.cotScore),
      overall: round1(cot?.overallScore),
      fundamental: round1(fundamental?.fundamental_score),
      stars: cot?.convictionStars ?? null,
      positioning: cot?.positioningLabel ?? null,
      percentile: cot?.cotPercentile ?? null,
      retail: round1(retailSentiment?.score),
    }),
    thesis: sectionHash({
      direction: thesis?.direction ?? null,
      conviction: thesis?.conviction ?? null,
      status: thesis?.status ?? null,
      drivers: (thesis?.drivers ?? []).map((d) => [d.driver_key, round1(d.value), d.status]),
    }),
    cbPolicy: sectionHash({
      rate: cbPolicy?.rate ?? null,
      cpi: cbPolicy?.cpi ?? null,
      label: cbPolicy?.policy_label ?? null,
      realYield: cbPolicy?.real_yield_adj ?? null,
      policyAdj: cbPolicy?.cb_policy_adj ?? null,
      pricedIn: cbPolicy?.priced_in?.label ?? null,
    }),
    // Jen REŽIM, ne surový VIX. VIX se hýbe každých 15 minut a jeho zahrnutí by otisk
    // zneplatňovalo prakticky pořád, aniž by se příběh reálně změnil.
    riskRegime: sectionHash(riskRegime?.regime ?? null),
    // Jen ZNAMÉNKO skóre ostatních měn, ne hodnota. Relativní rámování v příběhu se mění, až
    // když některá měna překlopí směr. Kdyby se hashovaly hodnoty, jakýkoli pohyb kterékoli
    // měny by přegeneroval všech osm a optimalizace by ztratila smysl.
    basket: sectionHash(
      Object.entries(basketContext ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, v]) => [code, Math.sign(v?.overallScore ?? 0)])
    ),
    // Nové výsledky, změněné konsensy i posun okna agendy. Tohle je sekce, která zajišťuje,
    // že se po zveřejnění dat doplní komentář k výsledku (outcome).
    seeds: sectionHash(
      (scenarioSeeds ?? []).map((s) => [s.date, s.title, s.estimate ?? null, s.previous ?? null, s.actual ?? null])
    ),
  };
}

// Vrací seznam změněných sekcí. Chybějící/neplatný předchozí otisk = generovat (bezpečná
// strana): radši jednou navíc než tiše nechat zastaralý text.
function changedSections(previous, next) {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    return ["poprvé (uložený otisk chybí)"];
  }
  return Object.keys(next).filter((key) => previous[key] !== next[key]);
}

async function loadCurrencyContext(currencyCode, allCalendarEvents, basketContext, marketRegime) {
  const today = isoToday();
  const upcomingCutoff = new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString().slice(0, 10);
  const recentCutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);

  const { data: cotRows } = await supabase
    .from("latest_confluence_scores")
    .select("cot_score, overall_score, cot_positioning_label, conviction_label, conviction_stars, conviction_reasons, retail_score, cot_percentile, data_tier, summary")
    .eq("currency_code", currencyCode)
    .limit(1);
  const cotRow = cotRows?.[0] ?? null;

  const { data: fundRows } = await supabase
    .from("latest_fundamental_scores")
    .select("fundamental_score, confidence, history_months")
    .eq("currency_code", currencyCode)
    .limit(1);
  const fundamental = fundRows?.[0] ?? null;

  const { data: cbRows } = await supabase
    .from("cb_policy_state")
    .select("rate, cpi, policy_score, policy_label, policy_confidence, real_yield_adj, cb_policy_adj, priced_in")
    .eq("currency_code", currencyCode)
    .limit(1);
  const cbPolicy = cbRows?.[0] ?? null;

  // Otevřená teze z Thesis Enginu — bez ní model nemá vůči čemu poměřovat "co by tezi
  // změnilo" a psal by jen obecné komentáře k datům.
  const { data: thesisRows } = await supabase
    .from("latest_currency_thesis")
    .select("direction, conviction, drivers, thesis_summary, status, confirm_streak, challenge_streak")
    .eq("currency_code", currencyCode)
    .limit(1);
  const thesis = thesisRows?.[0] ?? null;

  // Poslední dva snímky skóre — rozdíl mezi nimi je JEDINÝ ověřený podklad pro vysvětlení
  // změny. Model nesmí atribuci odhadovat; dostane spočítané delty po komponentách.
  const { data: snaps } = await supabase
    .from("score_snapshots")
    .select("overall_score, fundamental_score_adj, cot_score, retail_score, risk_adj, conviction_stars, recorded_at")
    .eq("currency_code", currencyCode)
    .order("recorded_at", { ascending: false })
    .limit(2);

  const scoreChange = buildScoreChange(snaps ?? []);

  // Klasifikace z thesis_ledger za posledních 7 dní — deterministický verdikt, jestli šlo
  // o strukturální zásah (invalidates_driver / closed), nebo jen o potvrzení běžícího příběhu.
  const ledgerCutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: ledgerRows } = await supabase
    .from("thesis_ledger_feed")
    .select("driver_key, classification, reasoning, occurred_at")
    .eq("currency_code", currencyCode)
    .gte("occurred_at", ledgerCutoff)
    .order("occurred_at", { ascending: false })
    .limit(12);

  const currencyEvents = allCalendarEvents.filter((e) => e.currency_code === currencyCode);

  const upcoming = currencyEvents
    // !e.actual je klíčové — bez něj by dnešní JIŽ VYŠLÝ event (event_day === today) zůstal
    // mezi "nadcházejícími" jen s odhadem/předchozí hodnotou a model by ho psal jako budoucí,
    // i když skutečný výsledek už dávno existuje (viz `recent` níže, kam patří).
    .filter((e) => e.event_day >= today && e.event_day <= upcomingCutoff && !e.actual)
    .sort((a, b) => a.event_day.localeCompare(b.event_day))
    .map((e) => ({
      date: e.event_day,
      title: e.event_title,
      impact: e.impact,
      estimate: e.estimate,
      previous: e.previous,
      historicalTrend: getEventHistoryTrend(e.event_title, currencyCode, allCalendarEvents),
    }));

  const recent = currencyEvents
    // <= today (ne jen < today) — dnešní už vyšlý event patří sem, ne do "upcoming" (viz výš).
    .filter((e) => e.event_day <= today && e.event_day >= recentCutoff && e.actual)
    .sort((a, b) => b.event_day.localeCompare(a.event_day))
    .map((e) => ({
      date: e.event_day,
      title: e.event_title,
      impact: e.impact,
      actual: e.actual,
      estimate: e.estimate,
      previous: e.previous,
    }));

  // Vlastní (širší) okno pro scénáře: pár dní zpět (aby čerstvě vyšlé číslo ještě dostalo
  // komentář k výsledku) až po upcomingCutoff dopředu — nezávislé na `upcoming`/`recent`
  // oknech výše, které slouží jen jako obecný kontext pro zbytek příběhu.
  const scenarioLookbackCutoff = new Date(Date.now() - SCENARIO_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const scenarioCandidates = currencyEvents
    .filter((e) => e.event_day >= scenarioLookbackCutoff && e.event_day <= upcomingCutoff)
    .sort((a, b) => a.event_day.localeCompare(b.event_day))
    .map((e) => ({
      date: e.event_day,
      title: e.event_title,
      impact: e.impact,
      estimate: e.estimate,
      previous: e.previous,
      actual: e.actual,
      historicalTrend: getEventHistoryTrend(e.event_title, currencyCode, allCalendarEvents),
      beatImplication: beatImplication(e.event_title, thesis?.direction),
      resolvedVerdict: resolvedVerdict(
        { title: e.event_title, actual: e.actual, estimate: e.estimate },
        thesis?.direction
      ),
    }));

  const scenarioSeeds = selectScenarioSeeds(scenarioCandidates);
  const flaggedEvents = selectFlaggedEvents(upcoming);

  const cot = cotRow
    ? {
        cotScore: cotRow.cot_score,
        overallScore: cotRow.overall_score,
        positioningLabel: cotRow.cot_positioning_label,
        convictionLabel: cotRow.conviction_label,
        convictionStars: cotRow.conviction_stars,
        convictionReasons: cotRow.conviction_reasons,
        cotPercentile: cotRow.cot_percentile,
        summary: cotRow.summary,
      }
    : null;

  const retailSentiment = cotRow?.retail_score != null ? { score: cotRow.retail_score, cotPercentile: cotRow.cot_percentile } : null;

  const otherCurrencies = Object.fromEntries(Object.entries(basketContext).filter(([code]) => code !== currencyCode));

  return {
    cot,
    fundamental,
    cbPolicy,
    thesis,
    scoreChange,
    recentLedger: ledgerRows ?? [],
    retailSentiment,
    riskRegime: marketRegime,
    basketContext: otherCurrencies,
    upcoming,
    recent,
    scenarioSeeds,
    flaggedEvents,
  };
}

// Předčítání shrnutí příběhu (tlačítko se zvukovou ikonou u SHRNUTÍ PŘÍBĚHU ve frontendu).
// Fixní cesta per měna (ne per generování) — nová verze audia přepíše starou, žádné
// hromadění osiřelých souborů ve storage. Nekritické: selhání TTS/uploadu nikdy nesmí
// zablokovat uložení textového narrativu, který je hlavní věc.
async function generateNarrativeAudio(currencyCode, text) {
  try {
    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice: "onyx",
      input: text,
      response_format: "mp3",
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    const path = `${currencyCode.toLowerCase()}.mp3`;

    const { error: uploadErr } = await supabase.storage
      .from("narrative-audio")
      .upload(path, buffer, { contentType: "audio/mpeg", upsert: true });
    if (uploadErr) {
      console.error(`[${currencyCode}] chyba nahrání audia do storage:`, uploadErr.message);
      return null;
    }

    const { data } = supabase.storage.from("narrative-audio").getPublicUrl(path);
    return data?.publicUrl ? `${data.publicUrl}?v=${Date.now()}` : null;
  } catch (err) {
    console.error(`[${currencyCode}] TTS generování selhalo (nekriticky, text narrative pokračuje):`, err.message);
    return null;
  }
}

// ── Volání OpenAI: sdílený jádrový kód pro oba kroky ────────────────────────────────────
// Modelová rodina GPT-5.x je "reasoning" model — nepodporuje temperature (appka si to živě
// ověřila: 400 "Unsupported value: 'temperature' does not support 0.4 with this model. Only
// the default (1) value is supported."), místo toho má reasoning_effort (none/low/medium/
// high/xhigh). Starší modely (gpt-4o-mini apod.) naopak reasoning_effort neznají, ale
// temperature ano. Appka musí umět běžet na obojí, protože OPENAI_MODEL je repo secret, ne
// konstanta — proto se parametr vybírá podle prefixu jména modelu, ne natvrdo.
const REASONING_MODEL_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

function isReasoningModel(model) {
  return REASONING_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

// "low" necháme modelu malý prostor si to "rozmyslet" před odpovědí (appka věří, že to omezí
// halucinace/prohození faktů), ale zůstává to v levném/rychlém pásmu modelu (na rozdíl od
// medium/high/xhigh) — Luna je navržená jako rychlá/levná vrstva, ne na hloubkové uvažování.
function samplingParams(model) {
  return isReasoningModel(model) ? { reasoning_effort: "low" } : { temperature: 0.4 };
}

// Appka živě zachytila případ, kdy se v jinak českém textu objevila azbuka (typický artefakt
// token kolize u LLM, ne úmysl modelu) — v produkčním textu je to nepřehlédnutelně rušivé a
// vypadá to jako rozbitá appka. Rozsahy pokrývají písma, co v gramaticky správné češtině nemají
// co dělat (cyrilice, řečtina, hebrejština, arabština, dévanágarí, thajština, CJK, hangul);
// latinka vč. české diakritiky, čísla a běžná interpunkce/symboly jsou v pořádku.
const FOREIGN_SCRIPT_RANGES = [
  "\\u0370-\\u03FF", // řečtina
  "\\u0400-\\u04FF\\u0500-\\u052F", // cyrilice (+ doplněk)
  "\\u0590-\\u05FF", // hebrejština
  "\\u0600-\\u06FF", // arabština
  "\\u0900-\\u097F", // dévanágarí
  "\\u0E00-\\u0E7F", // thajština
  "\\u3040-\\u30FF", // hiragana/katakana
  "\\u3400-\\u4DBF\\u4E00-\\u9FFF", // CJK ideogramy
  "\\uAC00-\\uD7A3", // hangul
].join("");
const FOREIGN_SCRIPT_RE = new RegExp(`[${FOREIGN_SCRIPT_RANGES}]`, "u");

// Projde celou strukturu odpovědi a vrátí cesty ke všem textovým polím s cizím písmem — appka
// pak přesně ví, KTERÉ pole je špatně (pro log i pro to, aby šlo případně cíleně opakovat).
function findForeignScript(value, path = "$") {
  if (typeof value === "string") {
    return FOREIGN_SCRIPT_RE.test(value) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findForeignScript(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => findForeignScript(v, `${path}.${k}`));
  }
  return [];
}

// Sdílené jádro obou kroků (dřív byl `openai.chat.completions.create` duplikovaný v
// generateNarrativePart i generateAgendaPart se stejnou strukturou, jen jiným promptem/
// schématem). Navíc bezpečnostní síť na cizí písmo: při zásahu appka JEDNOU zopakuje dotaz s
// explicitním upozorněním na chybu, než výsledek přijme — stejný princip "prompt engineering
// snižuje pravděpodobnost, kód garantuje" jako u ostatních pojistek v souboru (isTooShortOutcome,
// forwardFlagCitesFlaggedEvent...), jen tady řešíme celou odpověď najednou, ne jedno pole.
async function callStructuredCompletion({ currencyCode, label, systemPrompt, payload, schemaName, schema }) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(payload) },
  ];

  const runOnce = async (msgs) => {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: msgs,
      ...samplingParams(OPENAI_MODEL),
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
    });
    return JSON.parse(completion.choices[0].message.content);
  };

  let result = await runOnce(messages);
  let badPaths = findForeignScript(result);

  if (badPaths.length > 0) {
    console.warn(`[${currencyCode}] ${label}: cizí písmo v poli(ích) ${badPaths.join(", ")} — opakuji dotaz.`);
    result = await runOnce([
      ...messages,
      { role: "assistant", content: JSON.stringify(result) },
      {
        role: "user",
        content:
          "Tvoje odpověď obsahovala znaky mimo latinku (např. azbuku) — to je chyba. Přepiš CELOU odpověď znovu, čistě spisovnou češtinou, jen latinka a česká diakritika.",
      },
    ]);
    badPaths = findForeignScript(result);
    if (badPaths.length > 0) {
      console.error(
        `[${currencyCode}] ${label}: cizí písmo přetrvává i po opakování v poli(ích) ${badPaths.join(", ")} — ukládám i tak, appka to zaloguje pro ruční kontrolu.`
      );
    } else {
      console.log(`[${currencyCode}] ${label}: opakování dotazu cizí písmo opravilo.`);
    }
  }

  return result;
}

// Krok 1 — shrnutí příběhu. Krátká odpověď, dostane široký kontext (koš měn, oba proudy eventů).
async function generateNarrativePart(currencyCode, context) {
  const { cot, fundamental, cbPolicy, thesis, scoreChange, recentLedger, retailSentiment, riskRegime, basketContext, upcoming, recent, flaggedEvents } = context;

  const payload = {
    currency: currencyCode,
    cot,
    fundamental,
    cbPolicy,
    thesis,
    scoreChange,
    recentLedger,
    retailSentiment,
    riskRegime,
    basketContext,
    upcomingEvents: upcoming,
    recentEvents: recent,
    flaggedEvents,
  };

  return callStructuredCompletion({
    currencyCode,
    label: "shrnutí",
    systemPrompt: NARRATIVE_PROMPT,
    payload,
    schemaName: "fx_narrative",
    schema: {
      type: "object",
      properties: {
        narrative: { type: "string" },
        forward_flag: { type: ["string", "null"] },
        conviction_note: { type: "string" },
        thesis_change_note: { type: ["string", "null"] },
      },
      required: ["narrative", "forward_flag", "conviction_note", "thesis_change_note"],
      additionalProperties: false,
    },
  });
}

// Krok 2 — makro agenda. Samostatné volání ze dvou důvodů: (1) v jedné odpovědi s narrativem se
// kvalita u pozdějších položek viditelně rozpadala (živě ověřeno: patvary typu "zamrcháním"),
// (2) takhle agenda dostane HOTOVÝ text shrnutí a může na něj skutečně navazovat — dokud se
// generovalo obojí naráz, agenda shrnutí vůbec neviděla. Užší payload než krok 1 (bez koše měn
// a bez obou proudů eventů), takže rozdělení nezdvojnásobí vstupní tokeny.
async function generateAgendaPart(currencyCode, context, narrative) {
  const { cot, cbPolicy, thesis, retailSentiment, riskRegime, scenarioSeeds } = context;

  if (scenarioSeeds.length === 0) return [];

  const payload = {
    currency: currencyCode,
    narrative,
    cot,
    cbPolicy,
    thesis,
    retailSentiment,
    riskRegime,
    scenarioSeeds,
  };

  const result = await callStructuredCompletion({
    currencyCode,
    label: "agenda",
    systemPrompt: AGENDA_PROMPT,
    payload,
    schemaName: "fx_agenda",
    schema: {
      type: "object",
      properties: {
        scenarios: {
          type: "array",
          // Živě nahlášená chyba (NZD, audit 2026-08-03): appka poslala modelu 6-7 seedů
          // (scenarioSeeds), ale model dvakrát po sobě vrátil jen 1 položku — schéma to
          // nezakazovalo, protože mělo jen strop (maxItems), žádné vynucené minimum.
          // minItems napevno vynutí přesně tolik položek, kolik seedů appka dala (schéma se
          // staví čerstvě na každé volání, takže scenarioSeeds.length je tu k dispozici).
          minItems: scenarioSeeds.length,
          maxItems: MAX_AGENDA_ITEMS,
          items: {
            type: "object",
            properties: {
              event: { type: "string" },
              date: { type: "string" },
              tier: { type: "string", enum: ["klíčový", "druhořadý", "kontext"] },
              why_it_matters: { type: "string" },
              market_expectation: { type: "string" },
              thesis_test: { type: "string" },
              reaction: { type: "string", enum: ["silná", "omezená", "asymetrická"] },
              reaction_note: { type: "string" },
              outcome: { type: ["string", "null"] },
            },
            required: [
              "event",
              "date",
              "tier",
              "why_it_matters",
              "market_expectation",
              "thesis_test",
              "reaction",
              "reaction_note",
              "outcome",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["scenarios"],
      additionalProperties: false,
    },
  });

  return result.scenarios ?? [];
}

// Modely i ve "strict" json_schema módu občas vrátí doslovný string "null" místo opravdového
// JSON null — bez týhle normalizace by se u nevyřešených eventů ve frontendu zobrazil text "null".
const normalizeNullable = (v) => (typeof v === "string" && v.trim().toLowerCase() === "null" ? null : v);

function normalizeAgenda(currencyCode, scenarios, scenarioSeeds) {
  let items = scenarios.map((s) => {
    const outcome = normalizeNullable(s.outcome);
    const seed = scenarioSeeds.find((sd) => sd.title === s.event && sd.date === s.date);
    return {
      ...s,
      // Enumy řídí barvy a řazení v UI — nesmí do nich prosáknout nic mimo množinu, i kdyby
      // model json_schema enum obešel (viděli jsme ho obcházet i "strict" pravidla dřív).
      tier: VALID_TIERS.has(s.tier) ? s.tier : "kontext",
      reaction: VALID_REACTIONS.has(s.reaction) ? s.reaction : "omezená",
      outcome: seed?.actual && isTooShortOutcome(outcome) ? buildFallbackOutcome(seed) : outcome,
    };
  });

  // Strop na "klíčový" vynucený i kódem, ne jen promptem: v prvním živém běhu model označil
  // 4 ze 7 položek za klíčové, čímž hierarchie ztratila smysl (když je klíčové skoro všechno,
  // není klíčové nic). Přebytek degraduje na "druhořadý", přednost mají eventy s vyšší váhou.
  const keyItems = items.filter((s) => s.tier === "klíčový");
  if (keyItems.length > MAX_KEY_ITEMS) {
    const keep = new Set(
      keyItems
        .slice()
        .sort((a, b) => agendaWeight(b.event) - agendaWeight(a.event))
        .slice(0, MAX_KEY_ITEMS)
        .map((s) => `${s.date}|${s.event}`)
    );
    items = items.map((s) =>
      s.tier === "klíčový" && !keep.has(`${s.date}|${s.event}`) ? { ...s, tier: "druhořadý" } : s
    );
    console.log(`[${currencyCode}] agenda: ${keyItems.length} klíčových → degradováno na ${MAX_KEY_ITEMS}.`);
  }

  return items;
}

async function generateForCurrency(currencyCode, context, inputFingerprint) {
  const { cot, fundamental, upcoming, recent, scenarioSeeds } = context;

  if (!cot && !fundamental && upcoming.length === 0 && recent.length === 0) {
    console.log(`[${currencyCode}] žádná data — přeskočeno.`);
    return false;
  }

  let narrativePart;
  try {
    narrativePart = await generateNarrativePart(currencyCode, context);
  } catch (err) {
    console.error(`[${currencyCode}] generování shrnutí selhalo:`, err.message);
    return false;
  }

  const narrative = narrativePart.narrative;

  // Agenda je nekritická: když spadne její volání, shrnutí se stejně uloží. Prázdná agenda je
  // pořád lepší než zahozený příběh, který se povedl.
  let agenda = [];
  try {
    const rawAgenda = await generateAgendaPart(currencyCode, context, narrative);
    agenda = normalizeAgenda(currencyCode, rawAgenda, scenarioSeeds);
  } catch (err) {
    console.error(`[${currencyCode}] generování agendy selhalo (shrnutí se uloží i tak):`, err.message);
  }

  const audioUrl = await generateNarrativeAudio(currencyCode, narrative);

  // Model vrátil forward_flag (nechtěl null), ale buď je moc krátký na použitelnou větu, nebo
  // mluví o eventu mimo appkou předvybrané "flaggedEvents" (viz isTooShortForwardFlag a
  // forwardFlagCitesFlaggedEvent výš) → nahradit deterministickým fallbackem.
  const rawForwardFlag = normalizeNullable(narrativePart.forward_flag);
  const forwardFlagNeedsFallback =
    rawForwardFlag &&
    context.flaggedEvents?.length > 0 &&
    (isTooShortForwardFlag(rawForwardFlag) || !forwardFlagCitesFlaggedEvent(rawForwardFlag, context.flaggedEvents));
  const forwardFlag = forwardFlagNeedsFallback
    ? (buildFallbackForwardFlag(context.flaggedEvents) ?? rawForwardFlag)
    : rawForwardFlag;

  const { error: insErr } = await supabase.from("narratives").insert({
    currency_code: currencyCode,
    narrative,
    forward_flag: forwardFlag,
    conviction_note: narrativePart.conviction_note,
    // Pojistka: model občas u nullable pole vrátí string "null" i ve strict módu. A když appka
    // nemá dva snímky k porovnání, nesmí tam přistát vymyšlené vysvětlení neexistující změny.
    thesis_change_note: context.scoreChange ? normalizeNullable(narrativePart.thesis_change_note) : null,
    scenarios: agenda,
    model: OPENAI_MODEL,
    audio_url: audioUrl,
    input_fingerprint: inputFingerprint ?? null,
  });

  if (insErr) {
    console.error(`[${currencyCode}] chyba zápisu narrative:`, insErr.message);
    return false;
  }

  console.log(
    `[${currencyCode}] OK — ${narrative.length} znaků shrnutí, ${agenda.length} položek agendy, audio: ${audioUrl ? "ano" : "ne"}.`
  );
  return true;
}

async function main() {
  const { data: currencies, error } = await supabase.from("currencies").select("code").eq("is_active", true);

  if (error) {
    console.error("Nepodařilo se načíst tabulku currencies:", error.message);
    process.exit(1);
  }

  // PostgREST vrací max 1000 řádků na dotaz bez explicitní stránkování — calendar_events má
  // přes 4000 řádků a bez ORDER BY navíc Postgres negarantuje, KTERÝCH 1000 se vrátí (může se
  // lišit běh od běhu). Živě nahlášená chyba (NZD, audit 2026-08-03): Employment Change/
  // Unemployment Rate (vysoké ID, nedávno vložené) se do prvních 1000 řádků tiše nevešly, takže
  // appka o nich vůbec nevěděla a vypadly z agendy. Stejný problém byl už dřív opravený ve
  // fetch-calendar.mjs (fetchAllCalendarEvents) — sem se ta oprava nikdy nedostala, protože je
  // to nezávislý dotaz ve druhém souboru.
  const allCalendarEvents = [];
  {
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data: page, error: calErr } = await supabase
        .from("calendar_events")
        .select("currency_code, event_title, event_day, actual, estimate, previous, impact")
        .range(from, from + pageSize - 1);

      if (calErr) {
        console.error("Nepodařilo se načíst calendar_events:", calErr.message);
        process.exit(1);
      }
      allCalendarEvents.push(...page);
      if (page.length < pageSize) break;
    }
  }

  const basketContext = await loadBasketContext();
  const marketRegime = await loadMarketRegime();

  // Otisky vstupů z posledních narrativů — jeden dotaz pro všechny měny.
  // Kdyby dotaz selhal (typicky ještě neproběhla migrace schema-input-fingerprint.sql),
  // mapa zůstane prázdná → všechny měny se vyhodnotí jako "otisk chybí" → vygeneruje se
  // všechno. Selhání detekce tedy nikdy nevede k tichému přeskočení, jen ke staré ceně.
  const fingerprintByCode = new Map();
  if (!DISABLE_INPUT_HASH) {
    const { data, error: fpErr } = await supabase
      .from("latest_narratives")
      .select("currency_code, input_fingerprint");
    if (fpErr) {
      console.warn(`Nepodařilo se načíst otisky vstupů (${fpErr.message}) — pro jistotu generuji všechny měny.`);
    } else {
      for (const row of data ?? []) fingerprintByCode.set(row.currency_code, row.input_fingerprint);
    }
  }

  if (DISABLE_INPUT_HASH) console.log("DISABLE_INPUT_HASH=1 → detekce změn vypnutá, generuji všechny měny.");
  else if (FORCE_REGENERATE) console.log("FORCE_REGENERATE=1 → vynucené přegenerování všech měn.");

  let ok = 0;
  let skipped = 0;
  for (const { code } of currencies ?? []) {
    const context = await loadCurrencyContext(code, allCalendarEvents ?? [], basketContext, marketRegime);
    const fingerprint = buildInputFingerprint(context);
    const changed = changedSections(fingerprintByCode.get(code), fingerprint);

    if (changed.length === 0 && !FORCE_REGENERATE && !DISABLE_INPUT_HASH) {
      // Žádný zápis do DB — uložený narrativ (včetně textu, agendy i audia) zůstává platný
      // a frontend ho dál čte z latest_narratives beze změny.
      console.log(`[${code}] beze změny vstupů → přeskočeno, platí uložený narrativ.`);
      skipped++;
      continue;
    }

    const reason = DISABLE_INPUT_HASH
      ? "detekce změn vypnutá"
      : FORCE_REGENERATE
        ? "vynuceno přepínačem"
        : `změna: ${changed.map((k) => SECTION_LABELS[k] ?? k).join(", ")}`;
    console.log(`[${code}] generuji — ${reason}.`);

    const success = await generateForCurrency(code, context, fingerprint);
    if (success) ok++;
  }

  console.log(
    `\nHotovo: ${ok} vygenerováno, ${skipped} přeskočeno beze změny (z ${currencies?.length ?? 0} měn).`
  );
}

main().catch((err) => {
  console.error("Neočekávaná chyba:", err);
  process.exit(1);
});
