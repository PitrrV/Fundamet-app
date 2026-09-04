// Politika centrální banky, real yield a "zaceněnost" — odvozeno z calendar_events (kategorie
// "Interest Rates"/"Inflation" z fundamental-scoring.mjs EVENT_RULES), BEZ jakéhokoli nového
// datového zdroje — adaptace extractCBRatesFromCalendar/extractCPIFromCalendar/
// autoDetectCBPolicy/getRealYieldScore/getCBPolicyScore z Fx-Analyzeru (engine.js).
// Čisté funkce, žádné I/O.

import { matchRule, eventDirection } from "./fundamental-scoring.mjs";

// Extrahuje historii skutečných sazbových rozhodnutí (kategorie "Interest Rates") pro danou
// měnu z calendar_events. Vrací chronologicky seřazené {date, rate}.
export function extractRateHistory(currencyCode, calendarEvents) {
  const history = [];
  for (const ev of calendarEvents) {
    if (ev.currency_code !== currencyCode || !ev.actual) continue;
    if (matchRule(ev.event_title)?.cat !== "Interest Rates") continue;
    // "MPC Official Bank Rate Votes" apod. — actual je hlasování ("7-2"), ne sazba.
    if (/votes?/i.test(ev.event_title || "")) continue;

    const raw = String(ev.actual).trim();
    if (!/^[<>~≈]?\s*-?\d+(\.\d+)?\s*%?$/.test(raw)) continue;
    const val = parseFloat(raw.replace(/^[<>~≈\s]+/, ""));
    if (Number.isNaN(val) || val < -1 || val > 25) continue;

    history.push({ date: ev.event_day, rate: val });
  }
  history.sort((a, b) => new Date(a.date) - new Date(b.date));
  return history;
}

// Poslední známá roční inflace (kategorie "Inflation"), preferuje YoY pojmenované eventy
// (m/m hodnota by rozbila real yield výpočet, který počítá s roční mírou).
export function extractLatestCpi(currencyCode, calendarEvents) {
  const inflationEvents = calendarEvents
    .filter((ev) => ev.currency_code === currencyCode && ev.actual && matchRule(ev.event_title)?.cat === "Inflation")
    .sort((a, b) => new Date(b.event_day) - new Date(a.event_day));

  // Živě nahlášeno (nezávislý audit, 3.9.2026): tyhle regexy nikdy netrefily skutečný formát
  // ForexFactory titulků. `/y\/?o\/?y/` vyžaduje písmeno "o" MEZI oběma "y" (matchne "yoy",
  // "y/o/y"), ale ForexFactory píše "y/y" — bez "o". Stejně `/m\/?o\/?m/` nikdy netrefilo "m/m".
  // Protože isYoY nikdy nic nenašel, funkce vždycky spadla do fallbacku `!isMoM(...)` — a
  // protože isMoM TAKY nikdy nic nenašel, `!isMoM` bylo vždycky true → fallback ve skutečnosti
  // bral prostě PRVNÍ událost v kategorii "Inflation", bez ohledu na to, jestli je to CPI, PPI,
  // PCE, m/m nebo y/y. Živě ověřeno: real yield appka počítala z "Core PCE Price Index m/m 0,2 %"
  // pro USD (skutečná CPI y/y byla 3,4 %), "PPI m/m 1,6 %" pro EUR (skutečná Flash CPI y/y 3,3 %),
  // "CPI m/m 1,0 %" pro AUD (skutečná CPI y/y 3,5 %) — tedy měsíční/jiná čísla dosazená tam, kde
  // funkce počítá s ROČNÍ mírou (viz komentář výš) — chyba o řád, ne o desetinu procentního bodu.
  //
  // Oprava: vyžadovat přesně formát ForexFactory ("y/y"/"m/m", případně slovní "yoy"/"mom"), ne
  // libovolně permisivní vzor. POZOR na past č. 2, do které jsem sám nejdřív spadl při opravě:
  // plně nepovinné "o" (`o?` místo `o`) by matchlo i holé "mm"/"yy" schované UVNITŘ jiných slov
  // (např. "Trimmed" nebo "Committee" obsahují "mm") — proto \b hranice slova u slovních variant
  // a žádné "o?" bez alespoň jednoho lomítka.
  const isYoY = (title) => /y\/y|\byoy\b|annual|\byear\b/i.test(title || "");
  // Core/Trimmed/Median/Common y/y čísla jsou legitimní, ale headline CPI y/y je standardní
  // referenční hodnota pro real yield — když obojí vyjde stejný den (živě zachyceno: USD
  // 12.8.2026 mělo "CPI y/y 3,4 %" i "Core CPI y/y 2,5 %" tentýž den), preferuj headline.
  const isCoreVariant = (title) => /\b(core|trimmed|median|common|weighted|underlying)\b/i.test(title || "");
  // Kategorie "Inflation" v EVENT_RULES chytá klíčové slovo "ppi" — což omylem matchne i "SPPI"
  // (services producer price index, "sppi" obsahuje "ppi" jako podřetězec). Živě zachyceno: JPY
  // mělo "Tokyo Core CPI y/y 1,8 %" (28.8., nejčerstvější), ale protože obsahuje "core", spadl
  // na "SPPI y/y 3,6 %" (26.8.) jako "preferovaný nekvalifikovaný" y/y — index cen producentů
  // služeb, ne spotřebitelská inflace. Musí se explicitně vyžadovat "cpi" v názvu, ne jen
  // "cokoli, co není core/trimmed/…".
  const isCpiTitle = (title) => /\bcpi\b/i.test(title || "");

  // Nezávislý audit (ChatGPT/Cowork Opus, 4.9.2026), post-fix kontrola bodu #1: CAD na
  // ForexFactory nemá ŽÁDNÝ titul jen "CPI y/y" — jen "Trimmed CPI y/y", "Median CPI y/y",
  // "Common CPI y/y" (tři BoC alternativní statistické konstrukty, ne "core" v obvyklém smyslu).
  // Starší verze týhle funkce (fallback `?? yoyEvents[0]`) je tiše vydávala za CAD headline CPI
  // — živě zachyceno: appka počítala s ~1,9-2,0 %, skutečná CAD CPI y/y (StatCan) je 3,0 %,
  // což u real yieldu otočilo znaménko (viz computeRealYieldAdj níž).
  //
  // Řešení NENÍ blanket zákaz "core" fallbacku obecně — JPY na ForexFactory taky nemá žádný
  // prostý "CPI y/y" titul, jen "Tokyo/National/BOJ Core CPI y/y", a tahle hodnota byla
  // NEZÁVISLE OVĚŘENA jako správná (Japonsko svou "Core CPI" — bez čerstvých potravin — běžně
  // cituje jako headline inflaci, na rozdíl od US-stylu "core" bez potravin+energií). Zákaz by
  // JPY real yield tiše shodil na null bez důvodu, což nikdo nežádal a byla by to regrese.
  //
  // Proto dvouúrovňový fallback: (1) skutečný headline (bez core/trimmed/median/...), (2) JEDNA
  // obecná "core" varianta (jako JPY) — ale NIKDY konkrétně trimmed/median/common (CAD alternativní
  // konstrukty). Když zbydou jen ty, appka radši nemá číslo, než aby ho tiše domýšlela.
  const isAltMeasureOnly = (title) => /\b(trimmed|median|common)\b/i.test(title || "");

  const yoyEvents = inflationEvents.filter((ev) => isYoY(ev.event_title) && isCpiTitle(ev.event_title));
  const candidate =
    yoyEvents.find((ev) => !isCoreVariant(ev.event_title)) ??
    yoyEvents.find((ev) => !isAltMeasureOnly(ev.event_title)) ??
    null;
  if (!candidate) return null;

  const val = parseFloat(candidate.actual);
  if (Number.isNaN(val) || val < -2 || val > 20) return null;
  return Math.round(val * 10) / 10;
}

// Detekuje hiking/cutting/hold cyklus ze skutečných změn sazby (min. 0.1 bps) — adaptace
// autoDetectCBPolicy. Vrací score -2..+2, label a confidence podle počtu skutečných rozhodnutí.
export function autoDetectPolicy(rateHistory) {
  if (!rateHistory || rateHistory.length < 2) {
    return { score: 0, label: "nedostatek dat", confidence: "LOW" };
  }

  const changes = [];
  for (let i = 1; i < rateHistory.length; i++) {
    const diff = rateHistory[i].rate - rateHistory[i - 1].rate;
    if (Math.abs(diff) >= 0.1) changes.push({ date: rateHistory[i].date, change: diff, rate: rateHistory[i].rate });
  }

  const recent = changes.slice(-6);
  const hikeCount = recent.filter((c) => c.change > 0).length;
  const cutCount = recent.filter((c) => c.change < 0).length;
  const lastChange = changes[changes.length - 1]?.change ?? 0;

  // Ukotveno na datu POSLEDNÍHO zachyceného rozhodnutí, ne na Date.now() — jinak by se
  // klasifikace (viz větve níž) tiše měnila jen plynutím dní beze změny vstupních dat,
  // pokaždé když starší rozhodnutí vypadne z 365denního okna. Živě ověřeno (audit 2026-07-29):
  // se stejnou historií GBP/USD po 200 dnech "beze změny" sklouzly z "poslední cut" (-1) na
  // "plateau, hold" (0) jen kvůli posunu wall-clock data.
  const referenceTime = new Date(rateHistory[rateHistory.length - 1].date).getTime();
  const yearAgo = rateHistory.filter((r) => new Date(r.date).getTime() > referenceTime - 365 * 86400000);
  const yearChange = yearAgo.length >= 2 ? yearAgo[yearAgo.length - 1].rate - yearAgo[0].rate : 0;

  const last6 = rateHistory.slice(-6);
  const holdCount = last6.filter((r, i) => i > 0 && Math.abs(r.rate - last6[i - 1].rate) < 0.1).length;

  let score = 0;
  let desc = "hold";
  if (hikeCount >= 3 || (hikeCount >= 2 && yearChange > 1.0)) {
    score = 2;
    desc = `agresivní hiking (${yearChange >= 0 ? "+" : ""}${yearChange.toFixed(2)} % za rok)`;
  } else if (hikeCount >= 2 && holdCount <= 2) {
    score = 2;
    desc = "aktivní cyklus hikování";
  } else if (hikeCount >= 1 && cutCount === 0 && holdCount <= 3) {
    score = 1;
    desc = "cyklus hikování";
  } else if (cutCount >= 3 || (cutCount >= 2 && yearChange < -1.0)) {
    score = -2;
    desc = `agresivní řezy (${yearChange.toFixed(2)} % za rok)`;
  } else if (cutCount >= 2 && hikeCount === 0) {
    score = -2;
    desc = "aktivní cyklus řezů";
  } else if (cutCount >= 1 && hikeCount === 0 && holdCount <= 3) {
    score = -1;
    desc = "cyklus snižování";
  } else if (holdCount >= 4) {
    // Bez podmínky na `yearChange` — živě nahlášená chyba (USD, audit 2026-08-02): jediný
    // skutečný cut z prosince 2025, následovaný 5 rozhodnutími beze změny (do 29.7.2026),
    // padal do 365denního okna a |yearChange| (0.25) přesáhlo tehdejší práh 0.15, takže
    // klasifikace spadla na fallback "poslední cut, pozorujeme" — i když jde o 8 měsíců
    // staré, dávno stabilní plató. `holdCount >= 4` (aspoň 4 z posledních 6 ROZHODNUTÍ beze
    // změny) je sám o sobě dostatečný důkaz aktuálního plató — agresivní cykly už odchytily
    // dřívější větve (ty vyžadují holdCount <= 3), takže sem se dostane jen skutečně stabilní
    // sazba bez ohledu na to, jak starý je poslední skutečný pohyb.
    // Bez "@ rate %" tady v `desc` — `label` o pár řádků níž sazbu připojuje sám, stejně jako
    // u ostatních větví ("cyklus hikování", "poslední cut, pozorujeme" apod.). Dřív duplicitně
    // dávalo "plateau, hold @ 3.75 % @ 3.75 %" — nikdy předtím naživo neprojevené, protože tahle
    // větev díky bugu výš (viz komentář nad `holdCount >= 4`) v praxi nikdy nenaskočila.
    score = 0;
    desc = "plateau, hold";
  } else if (lastChange > 0) {
    score = 1;
    desc = "poslední hike, pozorujeme";
  } else if (lastChange < 0) {
    score = -1;
    desc = "poslední cut, pozorujeme";
  }

  const confidence = changes.length >= 4 ? "HIGH" : changes.length >= 2 ? "MEDIUM" : "LOW";
  const currentRate = rateHistory[rateHistory.length - 1]?.rate;
  const label = `${desc}${currentRate !== undefined ? ` @ ${currentRate.toFixed(2)} %` : ""}`;
  return { score, label, confidence };
}

// Real yield (sazba - CPI) RELATIVNĚ k průměru ostatních měn v košíku — capnuto ±1.0
// (polovina originálních ±2 v Fx-Analyzeru, konzistentní s tím, že náš celý systém je na
// poloviční škále -5..+5).
//
// Nezávislý audit (ChatGPT/Cowork Opus, 4.9.2026), post-fix kontrola bodu #1 — CRITICAL:
// `cpiByCode[c] ?? 2` dřív tiše dosazovalo 2 % za chybějící CPI (NZD/CHF nikdy nepublikují
// roční CPI na ForexFactory — viz extractLatestCpi výš). Vlastní komentář z předchozí opravy
// tohle popisoval jako "bezpečný fallback na průměr košíku" — byl to omyl: 2 % se dosazovalo
// jako PŘEDPOKLÁDANÁ VLASTNÍ inflace TÉ MĚNY, ne jako průměr ostatních. Živě ověřeno spuštěním
// skutečné funkce proti primárním zdrojům: NZD skutečná inflace 4,1 % (Stats NZ) → appka s 2 %
// počítala real yield adj +0,14, se skutečnou inflací −0,19 — OTOČENÉ ZNAMÉNKO. CAD skutečná
// 3,0 % (StatCan) → +0,07 vs. −0,08, taky otočené. CHF skutečná ~0,5 % → −0,34 vs. −0,04,
// 8,5× přehnaně záporné.
//
// Oprava: žádný tichý default. Měna bez vlastního CPI nedostane real yield vůbec (null) —
// nevstupuje do fundamentálního skóre, konvikce ani narrativu (viz volající místa). Měny BEZ
// CPI se navíc vyřadí i z výpočtu průměru košíku (jinak by domyšlené číslo kontaminovalo
// srovnání i pro měny, které svoje CPI mají).
export function computeRealYieldAdj(currencyCode, ratesByCode, cpiByCode) {
  if (cpiByCode[currencyCode] === null || cpiByCode[currencyCode] === undefined) return null;
  if (!(currencyCode in ratesByCode)) return null;

  const codesWithCpi = Object.keys(ratesByCode).filter(
    (c) => cpiByCode[c] !== null && cpiByCode[c] !== undefined
  );
  if (codesWithCpi.length === 0) return null;

  const realYields = codesWithCpi.map((c) => ratesByCode[c] - cpiByCode[c]);
  const avg = realYields.reduce((a, b) => a + b, 0) / realYields.length;
  const ry = ratesByCode[currencyCode] - cpiByCode[currencyCode];

  return Math.round(Math.max(-1, Math.min(1, (ry - avg) * 0.175)) * 100) / 100;
}

// CB policy score RELATIVNĚ k průměru ostatních měn — capnuto ±0.75 (polovina originálních ±1.5).
export function computeCbPolicyAdj(currencyCode, policyScoresByCode) {
  const codes = Object.keys(policyScoresByCode);
  if (codes.length === 0) return 0;

  const avg = codes.reduce((sum, c) => sum + (policyScoresByCode[c] ?? 0), 0) / codes.length;
  const pol = policyScoresByCode[currencyCode] ?? 0;

  return Math.round(Math.max(-0.75, Math.min(0.75, (pol - avg) * 0.2)) * 100) / 100;
}

// "Zaceněnost" — jak moc trh nejnovější rozhodnutí čekal. Funguje pro VŠECHNY měny bez
// nového datového zdroje: poslední Interest Rate event má pole `estimate` (konsensus trhu
// PRO TENHLE meeting) — beat/miss na něm (nejvyšší váha v EVENT_RULES) JE fakticky
// "překvapilo/nepřekvapilo trh". Volající (fetch-calendar.mjs) může výsledek přepsat na
// metodu 'yield_gap' tam, kde má reálná tržní data (zatím jen USD, viz market-regime.mjs).
export function decisionConsensusPricedIn(currencyCode, calendarEvents, policyConfidence) {
  const lastDecision = calendarEvents
    .filter(
      (ev) =>
        ev.currency_code === currencyCode &&
        ev.actual &&
        ev.estimate &&
        matchRule(ev.event_title)?.cat === "Interest Rates" &&
        // Stejný guard jako extractRateHistory výš — GBP (a další měny s výborovým hlasováním)
        // publikuje k rozhodnutí o sazbě samostatný event "MPC Official Bank Rate Votes" se
        // STEJNOU kategorií "Interest Rates" a vyplněným actual i estimate (formát hlasů, např.
        // "7-2"). Bez tohohle guardu ho tahle funkce mohla vybrat jako "poslední rozhodnutí" —
        // parseNum("7-2") vrátí 7 (parseFloat se zastaví na "-"), takže by se hlasy tiše
        // porovnávaly jako by šlo o sazbu v %, a `pricedIn.label` (jde přímo do promptu pro
        // generate-narrative.mjs) by tvrdil něco jako "poslední rozhodnutí (MPC Official Bank
        // Rate Votes) překvapilo jestřábí stranou vůči konsensu (7-2)" — nesmyslná věta o
        // hlasování vydávaná za sazbové rozhodnutí. Živě zachyceno (nezávislý audit, 3.9.2026).
        !/votes?/i.test(ev.event_title || "")
    )
    .sort((a, b) => new Date(b.event_day) - new Date(a.event_day))[0];

  if (!lastDecision) {
    return { method: "decision_consensus", label: "žádné nedávné rozhodnutí k porovnání", confidenceLevel: "LOW" };
  }

  const dir = eventDirection(lastDecision);
  const label =
    dir === 0
      ? `poslední rozhodnutí (${lastDecision.event_title}) odpovídalo konsensu (${lastDecision.estimate})`
      : `poslední rozhodnutí (${lastDecision.event_title}) ${
          dir > 0 ? "překvapilo jestřábí stranou" : "překvapilo holubičí stranou"
        } vůči konsensu (${lastDecision.estimate})`;

  return { method: "decision_consensus", label, confidenceLevel: policyConfidence ?? "MEDIUM" };
}

// Nezávislý návrh (ChatGPT, po konzultaci s uživatelem, 4.9.2026), bod #7 z post-fix auditu:
// appka dosud viděla jen MINULÁ rozhodnutí (extractRateHistory vyžaduje `actual`) — nadcházející
// rozhodnutí s validním `estimate` appka do teď úplně ignorovala, i když ta data už scrapuje.
// Živě potvrzeno PŘED opravou: EUR má 10.9.2026 "Main Refinancing Rate" s estimate 2.65 % proti
// aktuálním 2.40 % (validní konsensus na hike), ale appka na třech místech (policy_label, UI
// "Dlouhodobý bias", pricedIn) mlčela / tvrdila "plateau, hold, žádný jasný směr" — 6 dní před
// očekávaným rozhodnutím appka o něm vůbec nevěděla.
//
// DŮLEŽITÉ OMEZENÍ (explicitně schváleno uživatelem): tohle je ČISTĚ INFORMAČNÍ vrstva pro
// UI/narrative, ne nový vstup do skóre. Vrácený objekt se nikde v tomhle souboru nepoužívá jako
// vstup do policy_score/cbPolicyAdj/realYieldAdj — jen se dál předává (fetch-calendar.mjs → DB →
// generate-narrative.mjs / App.tsx). "estimate" je KONSENSUS trhu, ne fakt — volající (UI i
// narrativní prompt) to musí takhle explicitně označit, nikdy jako už hotové rozhodnutí.
export function upcomingRateDecision(currencyCode, calendarEvents, currentRate) {
  if (currentRate === null || currentRate === undefined) return null;

  const candidate = calendarEvents
    .filter(
      (ev) =>
        ev.currency_code === currencyCode &&
        !ev.actual &&
        ev.estimate &&
        matchRule(ev.event_title)?.cat === "Interest Rates" &&
        // Stejný guard jako extractRateHistory/decisionConsensusPricedIn výš — nadcházející
        // "MPC Official Bank Rate Votes" má taky vyplněný estimate (formát hlasů), ne sazbu.
        !/votes?/i.test(ev.event_title || "")
    )
    .sort((a, b) => new Date(a.event_day) - new Date(b.event_day))[0];

  if (!candidate) return null;

  const raw = String(candidate.estimate).trim();
  if (!/^[<>~≈]?\s*-?\d+(\.\d+)?\s*%?$/.test(raw)) return null;
  const estimateRate = parseFloat(raw.replace(/^[<>~≈\s]+/, ""));
  if (Number.isNaN(estimateRate)) return null;

  const diffPct = Math.round((estimateRate - currentRate) * 100) / 100;
  const direction = diffPct > 0.01 ? "hike" : diffPct < -0.01 ? "cut" : "hold";

  return {
    eventTitle: candidate.event_title,
    eventDay: candidate.event_day,
    currentRate,
    estimateRate: Math.round(estimateRate * 100) / 100,
    diffPct,
    direction,
  };
}

/**
 * Hlavní orchestrátor — pro danou měnu spočítá kompletní CB-policy stav z calendar_events
 * VŠECH měn (potřeba pro relativní srovnání vůči průměru).
 * @param {string} currencyCode
 * @param {string[]} allCurrencyCodes
 * @param {Array} allCalendarEvents
 */
export function computeCbPolicyState(currencyCode, allCurrencyCodes, allCalendarEvents) {
  const ratesByCode = {};
  const cpiByCode = {};
  const policyByCode = {};
  const histories = {};

  for (const code of allCurrencyCodes) {
    const history = extractRateHistory(code, allCalendarEvents);
    histories[code] = history;
    if (history.length > 0) ratesByCode[code] = history[history.length - 1].rate;

    const cpi = extractLatestCpi(code, allCalendarEvents);
    if (cpi !== null) cpiByCode[code] = cpi;

    policyByCode[code] = autoDetectPolicy(history).score;
  }

  const policy = autoDetectPolicy(histories[currencyCode] ?? []);
  const realYieldAdj = computeRealYieldAdj(currencyCode, ratesByCode, cpiByCode);
  const cbPolicyAdj = computeCbPolicyAdj(currencyCode, policyByCode);
  const pricedIn = decisionConsensusPricedIn(currencyCode, allCalendarEvents, policy.confidence);
  // Bod #7 — čistě informační, nevstupuje do policy_score/cbPolicyAdj/realYieldAdj výš (viz
  // komentář u funkce).
  const upcomingDecision = upcomingRateDecision(currencyCode, allCalendarEvents, ratesByCode[currencyCode] ?? null);

  return {
    rate: ratesByCode[currencyCode] ?? null,
    cpi: cpiByCode[currencyCode] ?? null,
    policyScore: policy.score,
    policyLabel: policy.label,
    policyConfidence: policy.confidence,
    realYieldAdj,
    cbPolicyAdj,
    pricedIn,
    upcomingDecision,
    rateHistory: histories[currencyCode] ?? [],
  };
}
