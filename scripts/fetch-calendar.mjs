// Server-side scraper ekonomického kalendáře ForexFactory — adaptace fetch-calendar.js
// z FX Analyzeru. Běží přes GitHub Actions (reálný network access, obchází Cloudflare,
// který blokuje přímé klientské volání z prohlížeče). Na rozdíl od originálu (který nemá
// backend a historii lepí v localStorage) tenhle skript upsertuje rovnou do Supabase —
// historie je tak od začátku konzistentní napříč zařízeními, ne per-prohlížeč.

import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore, computeRegimeShift, matchRule } from "./fundamental-scoring.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";
import { computeMarketRegime, riskAdjForCurrency, yieldGapPricedIn } from "./market-regime.mjs";
import { runThesisEngineForCurrency } from "./thesis-engine.mjs";
import { runMarketExpectationsForCurrency } from "./market-expectations.mjs";
import { runDataQualityForCurrency } from "./data-quality.mjs";
import { computeTopOpportunity } from "./top-opportunity.mjs";

// Editorská volba vah blendu (NE zpětně testováno — stejně jako zbytek systému, viz
// scoring.mjs a fundamental-scoring.mjs komentáře). Přibližně odpovídá neutrálním váhám
// Fx-Analyzeru (fund .42/cot .45/sent .11/sea .02), s přerozdělenou sezónností (chybí pilíř).
const BLEND_WEIGHTS = { fund: 0.43, cot: 0.46, retail: 0.11 };

// "Den eventu" appka počítá podle pražského (uživatelova) místního času, ne podle UTC — živě
// nahlášená chyba (NZD, audit 2026-08-03): event v 22:45 UTC je 4.8. v UTC, ale 5.8. i v Praze
// (krátce po půlnoci) i v místě publikace (NZ, UTC+12/13, dopoledne 5.8.). Čistý UTC datum tak
// systematicky posouval pozdně-večerní UTC eventy (typicky NZ/Asie-Pacifik) o den dřív, než je
// uživatel reálně vidí — jak na ForexFactory ve vlastní časové zóně, tak na hodinkách.
// sv-SE (švédská lokalizace) formátuje datum jako YYYY-MM-DD, takže jde použít rovnou jako ISO
// datum bez ruční skladby — jediný spolehlivý trik na "lokální datum v jiné časové zóně" bez
// externí knihovny (Intl.DateTimeFormat je součást Node, žádná nová závislost).
function pragueDateString(date) {
  return date.toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

// Jediný driver, u kterého jde v okamžiku klasifikace dohledat KONKRÉTNÍ dnešní event (na
// rozdíl od cot/retail/cb_policy/risk_regime, což jsou agregátní čísla bez jednoho jasného
// "zdroje") — najde dnešní event s nejvyšší váhou (matchRule) a vyplněným actual, ať
// thesis-engine.mjs může do reasoning textu napsat "PPI", ne jen obecně "Fundamentální data".
// Vrací null, když dnes u téhle měny žádný takový event nepřišel — thesis-engine pak použije
// obecný text jako dřív.
function todaysFundamentalEventLabel(currencyCode, allEvents) {
  const today = pragueDateString(new Date());
  let best = null;
  let bestWeight = 0;
  for (const ev of allEvents) {
    if (ev.currency_code !== currencyCode || ev.event_day !== today) continue;
    if (ev.actual === null || ev.actual === undefined) continue;
    const w = matchRule(ev.event_title)?.w ?? 0;
    if (w > bestWeight) {
      bestWeight = w;
      best = ev.event_title;
    }
  }
  return best;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// CNY je navíc oproti obchodovaným měnám appky — potřebujeme ji jen pro nepřímou
// relevanci AUD/NZD (viz fundamental-scoring.mjs), neskóruje se sama.
const TRACKED_CURRENCIES = new Set(["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD", "CNY"]);
const SCORED_CURRENCIES = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];
const WEEK_OFFSETS_DAYS = [-42, -35, -28, -21, -14, -7, 0, 7, 14];
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function weekParam(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${MONTH_ABBR[d.getUTCMonth()]}${d.getUTCDate()}.${d.getUTCFullYear()}`;
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]+>/g, "").trim();
}

function classifyImpact(ev) {
  const raw = `${ev.impactClass || ""} ${ev.impactName || ""} ${ev.impactTitle || ""}`.toLowerCase();
  if (/red|high/.test(raw)) return "High";
  if (/ora|med/.test(raw)) return "Medium";
  if (/yel|low/.test(raw)) return "Low";
  return "Medium";
}

// FF vkládá data jako `window.calendarComponentStates[1] = { days: [...] }` — vnější
// objekt není validní JSON (klíče bez uvozovek), ale pole za "days:" JSON validní je.
// Prohledá CELÉ HTML pro všechny výskyty "days:" (ne jen po jednom konkrétním markeru —
// stránka jich může mít víc a přesná pozice markeru se může časem posunout) a pro
// každý najde vyváženou hranatou závorku (respektuje stringy), spojí všechny nalezené dny.
function extractDaysArray(html) {
  const allDays = [];
  let i = 0;
  while ((i = html.indexOf("days:", i)) !== -1) {
    const arrStart = html.indexOf("[", i);
    if (arrStart === -1) break;

    let depth = 0;
    let inString = false;
    let stringChar = "";
    let escaped = false;
    let end = -1;
    for (let k = arrStart; k < html.length; k++) {
      const ch = html[k];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end !== -1) {
      try {
        const arr = JSON.parse(html.slice(arrStart, end + 1));
        if (Array.isArray(arr)) allDays.push(...arr);
      } catch {
        // ignoruj neplatný blok, zkus další výskyt "days:"
      }
      i = end + 1;
    } else {
      i += 5;
    }
  }
  if (allDays.length === 0) throw new Error('žádné platné pole "days:" nenalezeno v HTML');
  return allDays;
}

// Stejná minimální hlavičková sada jako v FX Analyzeru (ověřeno živě funkční) —
// bez Sec-Fetch-*/Sec-Ch-Ua/cookie handshake, který jsme zkoušeli navíc a nepomohl.
// 403 z prvních dvou pokusů byl pravděpodobně zásah do konkrétní (dočasně) blokované
// IP z rotujícího poolu GitHub Actions runnerů, ne deterministický blok podle hlaviček.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml",
};

export async function fetchWeek(offsetDays) {
  const week = weekParam(offsetDays);
  const url = `https://www.forexfactory.com/calendar?week=${week}`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} pro week=${week}`);
  const html = await res.text();
  const days = extractDaysArray(html);

  const events = [];
  for (const day of days) {
    for (const ev of day.events ?? []) {
      const currency = (ev.currency || ev.country || "").toUpperCase();
      if (!TRACKED_CURRENCIES.has(currency)) continue;

      const dateline = ev.dateline ? Number(ev.dateline) * 1000 : null;
      const eventTime = dateline ? new Date(dateline) : null;
      const dayDateline = day.dateline ? Number(day.dateline) * 1000 : null;
      const eventDay = eventTime
        ? pragueDateString(eventTime)
        : dayDateline
          ? pragueDateString(new Date(dayDateline))
          : null;
      if (!eventDay) continue;

      const title = stripHtml(ev.name || ev.title || "");
      if (!title) continue;

      const clean = (v) => (v && v !== "&nbsp;" ? String(v).trim() : null);

      events.push({
        currency_code: currency,
        event_title: title,
        event_day: eventDay,
        event_time: eventTime ? eventTime.toISOString() : null,
        impact: classifyImpact(ev),
        actual: clean(ev.actual),
        estimate: clean(ev.forecast),
        previous: clean(ev.previous),
      });
    }
  }
  return events;
}

export function dedupePreferComplete(events) {
  const map = new Map();
  for (const ev of events) {
    const key = `${ev.currency_code}|${ev.event_title}|${ev.event_day}`;
    const existing = map.get(key);
    if (!existing || (!existing.actual && ev.actual)) {
      map.set(key, ev);
    }
  }
  return [...map.values()];
}

export async function mergeUpsert(events) {
  let count = 0;
  // Jestli během tohohle běhu přibyl actual u eventu, na kterém appce záleží (má váhu v
  // EVENT_RULES) — pokud ano, stojí za to hned po přepočtu spustit generate-narrative.yml,
  // ne čekat na jeho jednou-denní cron (viz triggerNarrativeRegeneration níže). Sleduje se PO
  // MĚNĚ (Set), ne jako jeden globální boolean — nákladový audit (2026-08-05) živě odhalil, že
  // appka na jediný "něco se změnilo" signál pravidelně přegenerovala všech 8 měn místo té
  // jedné, co skutečně dostala nový tisk (7-8× denně, ne 1× — desítky USD/měsíc navíc na LLM
  // i TTS). Auto-trigger teď appce řekne PŘESNĚ které měny, ne "spusť to znovu a zkontroluj si to sám".
  const materialCurrencies = new Set();

  for (const ev of events) {
    const { data: existingRows, error: selErr } = await supabase
      .from("calendar_events")
      .select("actual, estimate, previous")
      .eq("currency_code", ev.currency_code)
      .eq("event_title", ev.event_title)
      .eq("event_day", ev.event_day)
      .limit(1);

    if (selErr) {
      console.error(`Chyba čtení eventu ${ev.currency_code}/${ev.event_title}:`, selErr.message);
      continue;
    }

    const existing = existingRows?.[0];

    if (!existing?.actual && ev.actual && (matchRule(ev.event_title)?.w ?? 0) > 0) {
      materialCurrencies.add(ev.currency_code);
    }

    const merged = {
      ...ev,
      // nikdy neztratit dřív zachycený actual/estimate/previous kvůli neúplnému re-scrapu
      actual: ev.actual ?? existing?.actual ?? null,
      estimate: ev.estimate ?? existing?.estimate ?? null,
      previous: ev.previous ?? existing?.previous ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from("calendar_events")
      .upsert(merged, { onConflict: "currency_code,event_title,event_day" });

    if (upsertErr) {
      console.error(`Chyba upsertu eventu ${ev.currency_code}/${ev.event_title}:`, upsertErr.message);
      continue;
    }
    count++;
  }
  return { count, materialCurrencies };
}

// Spustí generate-narrative.yml přes GitHub API místo čekání na jeho denní cron — potřebuje
// actions:write oprávnění GITHUB_TOKEN (nastaveno ve fetch-calendar.yml) a běží jen uvnitř
// GitHub Actions (GITHUB_TOKEN/GITHUB_REPOSITORY/GITHUB_REF_NAME appka nastavuje automaticky).
//
// `currencyCodes` (nepovinné) appku omezí jen na tyhle měny přes input "only_currencies" —
// nákladový audit (2026-08-05) živě odhalil, že appka bez tohohle omezení dispatchovala tenhle
// workflow v průměru 7× za 24h a KAŽDÝ běh přegeneroval 7-8 z 8 měn (ne jen tu jednu, co měla
// nový tisk) — fingerprint appky totiž reaguje i na drobný drift skóre (VIX režim, time-decay),
// ne jen na skutečně relevantní změnu. Bez explicitního omezení appka radši přegeneruje víc, ne
// míň (chybějící/prázdné `currencyCodes` = starý plošný běh, viz volání níž u forceNarrative).
async function triggerNarrativeRegeneration(reason, currencyCodes) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF_NAME;

  if (!token || !repo || !ref) {
    console.warn("Přeskakuji okamžitý trigger generate-narrative.yml — chybí GITHUB_TOKEN/GITHUB_REPOSITORY/GITHUB_REF_NAME.");
    return;
  }

  // currencyCodes je Set (ne pole) — .size, ne .length! Bez tyhle poznámky je to nenápadná
  // past: Set.length je undefined, takže by se podmínka tiše vždycky vyhodnotila jako false a
  // celé omezení na měny by nikdy nic neposlalo (přesně ta drahá "beze změny" cesta, co appka
  // řeší).
  const onlyCurrencies = currencyCodes && currencyCodes.size > 0 ? [...currencyCodes].join(",") : "";

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/generate-narrative.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref, inputs: { only_currencies: onlyCurrencies } }),
    });
    if (res.ok) {
      console.log(
        `Spuštěn okamžitý přepočet narrativu (${reason})${onlyCurrencies ? ` — omezeno na: ${onlyCurrencies}` : " — bez omezení měn"}.`
      );
    } else {
      console.error(`Nepodařilo se spustit generate-narrative.yml: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("Chyba při triggerování generate-narrative.yml:", err.message);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Konvicience ze SHODY nezávislých signálů (ne z velikosti overall_score) — kolik z 5
// nezávislých pohledů (CB politika, real yield, fundament/kalendář, pozicování-ne-crowded,
// risk režim) ukazuje stejným směrem jako výsledné skóre. Vzor calcConvictionScore
// z Fx-Analyzeru, přizpůsobeno na naši sadu signálů.
function computeConviction(overallScore, { cbPolicyAdj, realYieldAdj, fundamentalScoreAdj, cotPercentile, riskAdj, regime, policyLabel }) {
  if (overallScore === 0) return { stars: 0, reasons: [] };
  const dir = overallScore > 0 ? 1 : -1;
  const signAgrees = (v) => v !== 0 && Math.sign(v) === dir;

  const reasons = [];
  let stars = 0;

  if (signAgrees(cbPolicyAdj)) {
    stars++;
    reasons.push(`CB politika: ${policyLabel}`);
  }
  if (signAgrees(realYieldAdj)) {
    stars++;
    reasons.push(`Real yield: ${realYieldAdj > 0 ? "+" : ""}${realYieldAdj} vůči průměru koše měn`);
  }
  if (Math.abs(fundamentalScoreAdj) >= 1 && signAgrees(fundamentalScoreAdj)) {
    stars++;
    reasons.push(`Fundament/kalendář: ${fundamentalScoreAdj > 0 ? "+" : ""}${fundamentalScoreAdj}`);
  }
  const crowdedAgainst = cotPercentile !== null && ((dir > 0 && cotPercentile >= 88) || (dir < 0 && cotPercentile <= 12));
  if (!crowdedAgainst && Math.abs(overallScore) >= 1) {
    stars++;
    reasons.push(cotPercentile !== null ? `Pozicování: ${cotPercentile}. percentil, není crowded proti směru` : "Pozicování: bez dat o extrému");
  }
  if (signAgrees(riskAdj)) {
    stars++;
    reasons.push(`Risk režim: ${regime} podporuje směr`);
  }

  return { stars: Math.min(5, stars), reasons };
}

function convictionLabelFromStars(stars) {
  const base = stars >= 4 ? "VYSOKÁ" : stars >= 2 ? "STŘEDNÍ" : "NÍZKÁ";
  return `${base} CONVICTION (${stars}/5 NEZÁVISLÝCH SIGNÁLŮ SOUHLASÍ)`;
}

// PostgREST vrací max 1000 řádků na dotaz bez explicitní stránkování — od backfillu historie
// (3000+ řádků v calendar_events) by neomezený .select() tiše ořezal část měn/historie
// použité pro fundamentální i CB Policy scoring. Stránkuje po 1000, dokud nedojdou řádky.
async function fetchAllCalendarEvents() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, currency_code, event_title, event_day, actual, estimate, previous")
      .range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return { data: rows, error: null };
}

export async function recomputeScores() {
  const { data: allEvents, error } = await fetchAllCalendarEvents();

  if (error) {
    console.error("Nepodařilo se načíst calendar_events pro scoring:", error.message);
    return;
  }

  console.log("Stahuji risk režim (VIX) a US 2Y výnos z FRED...");
  const { regimeInfo, usd2yYield } = await computeMarketRegime();

  if (regimeInfo) {
    const { error: regimeErr } = await supabase
      .from("market_regime")
      .upsert({ id: true, vix: regimeInfo.vix, vix_5d_change: regimeInfo.vix5dChange, regime: regimeInfo.regime, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (regimeErr) console.error("Chyba upsertu market_regime:", regimeErr.message);
    else console.log(`Risk režim: ${regimeInfo.regime} (VIX ${regimeInfo.vix}, 5d ${regimeInfo.vix5dChange >= 0 ? "+" : ""}${regimeInfo.vix5dChange})`);
  } else {
    console.warn("FRED VIX fetch selhal — risk režim pro tenhle běh vynechán (riskAdj=0 pro všechny měny).");
  }

  // Druhý, nezávislý spouštěč přegenerování narrativu (viz komentář u runThesisEngineForCurrency
  // v thesis-engine.mjs) — na rozdíl od materialCurrencies (scrape-diff, per-event) tohle
  // sleduje, u KTERÝCH měn se reálně pohnul stav teze (nová teze, obrat, watching...). Set, ne
  // boolean — viz komentář u triggerNarrativeRegeneration, appka musí vědět KTERÉ měny, ne jen že
  // "něco, někde".
  const thesisSignalCurrencies = new Set();

  // Třetí, nezávislý spouštěč přegenerování narrativu (2026-08-08): materialCurrencies a
  // thesisSignalCurrencies chytí NOVÁ data/tezi, ale žádný z nich nesleduje, jestli text, co už
  // je uložený, pořád odpovídá aktuálnímu skóre — a to se hýbe i BEZ nové teze/eventu (VIX risk
  // režim, plynulý time-decay recency). Živě zachyceno check-narrative-freshness.mjs: text GBP
  // vygenerovaný v 10:30 tvrdil overall_score 1,2, o 80 minut později appka reálně ukazovala 1,5
  // — nic to netriggerovalo, dokud si toho nevšiml automatický test. Řešení: porovnat aktuálně
  // spočítané skóre s tím, co je uložené v score_snapshot POSLEDNÍHO narrativu té měny (stejný
  // sloupec, co čte scripts/check-narrative-freshness.mjs) — a při odchylce nad práh přidat měnu
  // do stejného scoped triggeru jako ostatní dva mechanismy, ne přegenerovat všech 8.
  const staleTextCurrencies = new Set();
  const STALE_TEXT_EPSILON = 0.05; // stejný práh jako FRESHNESS_EPSILON v generate-narrative.mjs

  for (const currencyCode of SCORED_CURRENCIES) {
    const result = computeFundamentalScore(currencyCode, allEvents ?? []);

    const { error: insErr } = await supabase.from("fundamental_scores").insert({
      currency_code: currencyCode,
      raw_score: result.rawScore,
      confidence: result.confidence,
      fundamental_score: result.fundamentalScore,
      history_months: result.historyMonths,
    });
    if (insErr) {
      console.error(`[${currencyCode}] chyba zápisu fundamental_scores:`, insErr.message);
      continue;
    }

    // Nezávislý indikátor "možná se mění fundamentální režim" — dlouhodobé (celá historie)
    // vs. krátkodobé (90 dní) fundamentální skóre STEJNOU funkcí. Neblenduje se do
    // overall_score, jen upozorňuje, když se výrazně rozejdou (viz fundamental-scoring.mjs).
    const regimeShift = computeRegimeShift(currencyCode, allEvents ?? []);
    const { error: regimeShiftErr } = await supabase.from("regime_shift_state").upsert(
      {
        currency_code: currencyCode,
        long_term_score: regimeShift.longTermScore,
        short_term_score: regimeShift.shortTermScore,
        divergence: regimeShift.divergence,
        alert: regimeShift.alert,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "currency_code" }
    );
    if (regimeShiftErr) console.error(`[${currencyCode}] chyba upsertu regime_shift_state:`, regimeShiftErr.message);

    const cbPolicy = computeCbPolicyState(currencyCode, SCORED_CURRENCIES, allEvents ?? []);

    // USD má jediné ověřené live tržní "priced-in" data (FRED DGS2 2Y výnos) — kde je
    // k dispozici, přepiš decision_consensus proxy kvalitnější yield_gap metodou.
    if (currencyCode === "USD" && usd2yYield !== null && cbPolicy.rate !== null) {
      const yieldGap = yieldGapPricedIn(usd2yYield, cbPolicy.rate);
      if (yieldGap) cbPolicy.pricedIn = yieldGap;
    }

    const { error: cbErr } = await supabase.from("cb_policy_state").upsert(
      {
        currency_code: currencyCode,
        rate: cbPolicy.rate,
        cpi: cbPolicy.cpi,
        policy_score: cbPolicy.policyScore,
        policy_label: cbPolicy.policyLabel,
        policy_confidence: cbPolicy.policyConfidence,
        real_yield_adj: cbPolicy.realYieldAdj,
        cb_policy_adj: cbPolicy.cbPolicyAdj,
        priced_in: cbPolicy.pricedIn,
        rate_history: cbPolicy.rateHistory,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "currency_code" }
    );
    if (cbErr) console.error(`[${currencyCode}] chyba upsertu cb_policy_state:`, cbErr.message);

    const { data: latestCot, error: cotSelectErr } = await supabase
      .from("latest_confluence_scores")
      .select("report_date, cot_score, retail_score, cot_percentile")
      .eq("currency_code", currencyCode)
      .limit(1);

    if (cotSelectErr) {
      console.error(`[${currencyCode}] chyba čtení latest_confluence_scores:`, cotSelectErr.message);
      continue;
    }

    const cotRow = latestCot?.[0];
    if (!cotRow) {
      console.log(`[${currencyCode}] žádné COT skóre zatím — fundamentální skóre uloženo samostatně.`);
      continue;
    }

    const fundamentalScoreAdj = clamp(result.fundamentalScore + cbPolicy.realYieldAdj + cbPolicy.cbPolicyAdj, -5, 5);
    const riskAdj = regimeInfo ? riskAdjForCurrency(currencyCode, regimeInfo.regime) : 0;
    const retailScore = cotRow.retail_score ?? 0;

    const overallRaw =
      fundamentalScoreAdj * BLEND_WEIGHTS.fund + cotRow.cot_score * BLEND_WEIGHTS.cot + retailScore * BLEND_WEIGHTS.retail + riskAdj;
    const overallScore = Math.round(clamp(overallRaw, -5, 5) * 10) / 10;

    const conviction = computeConviction(overallScore, {
      cbPolicyAdj: cbPolicy.cbPolicyAdj,
      realYieldAdj: cbPolicy.realYieldAdj,
      fundamentalScoreAdj,
      cotPercentile: cotRow.cot_percentile ?? null,
      riskAdj,
      regime: regimeInfo?.regime ?? "NEUTRAL",
      policyLabel: cbPolicy.policyLabel,
    });

    const { error: updErr } = await supabase
      .from("confluence_scores")
      .update({
        overall_score: overallScore,
        data_tier: "partial",
        conviction_stars: conviction.stars,
        conviction_reasons: conviction.reasons,
        conviction_label: convictionLabelFromStars(conviction.stars),
      })
      .eq("currency_code", currencyCode)
      .eq("report_date", cotRow.report_date);

    if (updErr) {
      console.error(`[${currencyCode}] chyba aktualizace overall_score:`, updErr.message);
    } else {
      console.log(
        `[${currencyCode}] fund_adj=${fundamentalScoreAdj.toFixed(1)} cot=${cotRow.cot_score} retail=${retailScore} risk=${riskAdj} ` +
          `-> overall_score=${overallScore} (${conviction.stars}/5 hvězd)`
      );

      // Porovnání s tím, co cituje POSLEDNÍ uložený text (viz komentář u staleTextCurrencies výš).
      // Nekritické — chyba čtení narrativu nesmí shodit zbytek přepočtu skóre. POZOR: supabase-js
      // chybu VRACÍ v poli "error", nevyhazuje ji — bez explicitní kontroly by selhání dotazu
      // tiše prošlo jako "snap == null" a appka by o něm vůbec nevěděla (živě nahlášená past,
      // 2026-08-08: AUD skočilo z 0,5 na 1,9 a kontrola to bez tohodle logu nezachytila).
      try {
        const { data: lastNarrative, error: snapReadErr } = await supabase
          .from("latest_narratives")
          .select("score_snapshot")
          .eq("currency_code", currencyCode)
          .limit(1);
        if (snapReadErr) {
          console.error(`[${currencyCode}] kontrola stáří textu: čtení score_snapshot selhalo:`, snapReadErr.message);
        } else {
          const snap = lastNarrative?.[0]?.score_snapshot;
          if (!snap) {
            console.log(`[${currencyCode}] kontrola stáří textu: žádný score_snapshot u posledního narrativu (starší řádek) — přeskočeno.`);
          } else {
            const overallDrift = Math.abs(Number(snap.overall_score) - overallScore);
            const fundDrift = Math.abs(Number(snap.fundamental_score) - result.fundamentalScore);
            if (overallDrift > STALE_TEXT_EPSILON || fundDrift > STALE_TEXT_EPSILON) {
              staleTextCurrencies.add(currencyCode);
              console.log(
                `[${currencyCode}] text neodpovídá skóre (overall text=${snap.overall_score} živé=${overallScore}, fund text=${snap.fundamental_score} živé=${result.fundamentalScore}) — přidáno k přegenerování.`
              );
            }
          }
        }
      } catch (staleErr) {
        console.error(`[${currencyCode}] kontrola stáří textu selhala (nekriticky):`, staleErr.message);
      }

      // Snímek skóre do historie — jen když se overall_score SKUTEČNĚ pohnulo. Zapisovat každých
      // 15 minut i beze změny by tabulku zaplnilo identickými řádky a "poslední změna" by pak
      // ukazovala delta 0 z doby před pár minutami místo skutečného posledního pohybu.
      // Ukládá se i rozpad na pilíře, protože bez něj nejde určit, KTERÁ komponenta skóre pohnula
      // (fundamentalScoreAdj a riskAdj jinde v DB neexistují — počítají se jen v paměti výš).
      try {
        const { data: lastSnap } = await supabase
          .from("score_snapshots")
          .select("overall_score")
          .eq("currency_code", currencyCode)
          .order("recorded_at", { ascending: false })
          .limit(1);

        const previous = lastSnap?.[0]?.overall_score ?? null;
        if (previous === null || Math.abs(Number(previous) - overallScore) >= 0.05) {
          const { error: snapErr } = await supabase.from("score_snapshots").insert({
            currency_code: currencyCode,
            overall_score: overallScore,
            fundamental_score_adj: Math.round(fundamentalScoreAdj * 100) / 100,
            cot_score: cotRow.cot_score,
            retail_score: retailScore,
            risk_adj: Math.round(riskAdj * 100) / 100,
            conviction_stars: conviction.stars,
          });
          if (snapErr) console.error(`[${currencyCode}] chyba zápisu score_snapshots:`, snapErr.message);
          else if (previous !== null) {
            const d = Math.round((overallScore - Number(previous)) * 100) / 100;
            console.log(`[${currencyCode}] skóre se pohnulo: ${previous} -> ${overallScore} (${d > 0 ? "+" : ""}${d})`);
          }
        }
      } catch (snapErr) {
        console.error(`[${currencyCode}] score_snapshots selhalo (nekriticky):`, snapErr.message);
      }

      // Gen2 Thesis Engine, Fáze 1 — běží "ve stínu" vedle stávajícího scoringu (currency_thesis/
      // thesis_ledger se plní, ale frontend je zatím nečte). Nesmí shodit zbytek přepočtu, kdyby
      // selhal — proto vlastní try/catch, ne propagace chyby výš.
      try {
        const thesisChanged = await runThesisEngineForCurrency(currencyCode, {
          overallScore,
          convictionStars: conviction.stars,
          fundamentalScoreAdj,
          cotScore: cotRow.cot_score,
          cbPolicyAdj: cbPolicy.cbPolicyAdj,
          realYieldAdj: cbPolicy.realYieldAdj,
          riskAdj,
          retailScore,
          fundamentalEventLabel: todaysFundamentalEventLabel(currencyCode, allEvents ?? []),
        });
        if (thesisChanged) thesisSignalCurrencies.add(currencyCode);
      } catch (thesisErr) {
        console.error(`[${currencyCode}] thesis-engine selhal (nekriticky, scoring pokračuje):`, thesisErr.message);
      }

      // Gen2 Market Expectations Engine — snapshot nadcházejících klíčových eventů + vyhodnocení
      // reakce u eventů, co mezitím dostaly actual. Stejný princip: vlastní try/catch, nesmí
      // shodit zbytek přepočtu.
      try {
        await runMarketExpectationsForCurrency(currencyCode, allEvents ?? [], cotRow.cot_percentile ?? null);
      } catch (meeErr) {
        console.error(`[${currencyCode}] market-expectations selhal (nekriticky, scoring pokračuje):`, meeErr.message);
      }

      // Gen3.5 Confidence & Data Quality Engine, Fáze 1 — jen Data Quality + Coverage.
      try {
        await runDataQualityForCurrency(currencyCode, allEvents ?? [], cotRow.report_date ?? null);
      } catch (cdqeErr) {
        console.error(`[${currencyCode}] data-quality selhal (nekriticky, scoring pokračuje):`, cdqeErr.message);
      }
    }
  }

  // "Top Fundamentální příležitosti týdne" — potřebuje přehled VŠECH měn najednou, proto se
  // volá jednou tady, ne uvnitř smyčky per měna.
  try {
    await computeTopOpportunity();
  } catch (topErr) {
    console.error("top-opportunity selhal (nekriticky):", topErr.message);
  }

  return { thesisSignalCurrencies, staleTextCurrencies };
}

async function main() {
  console.log("Stahuji ForexFactory kalendář (9 týdnů)...");
  const allEvents = [];
  for (const offset of WEEK_OFFSETS_DAYS) {
    try {
      const weekEvents = await fetchWeek(offset);
      console.log(`  offset ${offset}: ${weekEvents.length} eventů`);
      allEvents.push(...weekEvents);
    } catch (err) {
      console.error(`  offset ${offset} selhal:`, err.message);
    }
    await sleep(1500);
  }

  const deduped = dedupePreferComplete(allEvents);
  console.log(`Celkem po deduplikaci: ${deduped.length} eventů`);

  if (deduped.length < 20) {
    console.error("Méně než 20 eventů celkem — pravděpodobně selhal scraping. DB se nemění.");
    process.exit(1);
  }

  const { count, materialCurrencies } = await mergeUpsert(deduped);
  console.log(`Upsertnuto ${count}/${deduped.length} eventů do calendar_events.`);

  const { thesisSignalCurrencies, staleTextCurrencies } = await recomputeScores();

  // FORCE_NARRATIVE_REGEN přichází z workflow_dispatch inputs.force_narrative — appka ho
  // nastaví, když admin ručně přepíše "actual" v kalendáři (EditActualField.tsx přes Edge
  // Function trigger-recompute). Ruční zásah scraper sám o sobě nevidí jako "nový actual"
  // (v DB už existuje, jen ho nezapsal on), proto se materialCurrencies samo nenaplní. Appka
  // nezná KTEROU měnu admin upravil (trigger-recompute appce ID měny nepředává), takže tenhle
  // případ zůstává plošný běh přes všech 8 — je to vzácná ruční akce, ne 15minutový cron, takže
  // cenu neovlivňuje.
  //
  // thesisSignalCurrencies je druhý, nezávislý spouštěč (viz runThesisEngineForCurrency) — chrání
  // proti tomu, že materialCurrencies (scrape-diff) může minout skutečnou změnu, když dva běhy
  // scraperu proběhnou blízko sebe (živě zachyceno 30.7.2026 u GBP — viz git historie).
  //
  // staleTextCurrencies je třetí, nezávislý spouštěč (viz komentář v recomputeScores) — chrání
  // proti tomu, že text zůstane citovat starší skóre, než appka právě zobrazuje, i když nedošlo
  // k žádné nové tezi ani novému eventu (jen plynulý time-decay/VIX posun).
  const forceNarrative = process.env.FORCE_NARRATIVE_REGEN === "true";
  const changedCurrencies = new Set([...materialCurrencies, ...thesisSignalCurrencies, ...staleTextCurrencies]);

  if (changedCurrencies.size > 0 || forceNarrative) {
    await triggerNarrativeRegeneration(
      forceNarrative
        ? "ruční úprava actual administrátorem"
        : materialCurrencies.size === 0 && thesisSignalCurrencies.size === 0
          ? "text neodpovídá aktuálnímu skóre"
          : materialCurrencies.size === 0
            ? "změnil se stav teze (nová/obrat/watching)"
            : "nový actual u důležitého eventu",
      // Plošný běh (bez omezení) jen u ruční admin úpravy, kde appka neví, kterou měnu má na
      // mysli — automatické spouštěče vždy omezí jen na měny, co se SKUTEČNĚ změnily.
      forceNarrative ? null : changedCurrencies
    );
  }
}

// Spustit scraping jen když je soubor volaný přímo (`node scripts/fetch-calendar.mjs`),
// ne když se z něj importuje `recomputeScores` (viz scripts/manual-override.mjs) — jinak
// by import sám o sobě spustil celý 9týdenní scrape jako vedlejší efekt.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Neočekávaná chyba:", err);
    process.exit(1);
  });
}
