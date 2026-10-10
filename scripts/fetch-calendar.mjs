// Server-side scraper ekonomického kalendáře ForexFactory — adaptace fetch-calendar.js
// z FX Analyzeru. Běží přes GitHub Actions (reálný network access, obchází Cloudflare,
// který blokuje přímé klientské volání z prohlížeče). Na rozdíl od originálu (který nemá
// backend a historii lepí v localStorage) tenhle skript upsertuje rovnou do Supabase —
// historie je tak od začátku konzistentní napříč zařízeními, ne per-prohlížeč.

import { createClient } from "@supabase/supabase-js";
import { computeFundamentalScore, computeRegimeShift, matchRule } from "./fundamental-scoring.mjs";
import { planCalendarMerge } from "./calendar-merge.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";
import { trackRateDecisionDrift } from "./rate-decision-drift.mjs";
import { fetchUsd2yYield, yieldGapPricedIn } from "./market-regime.mjs";
import { computeFundamentalState, describeSurprise, weekEndFriday, componentSigns } from "./fundamental-state.mjs";
import { runThesisEngineForCurrency } from "./thesis-engine.mjs";
import { runMarketExpectationsForCurrency } from "./market-expectations.mjs";
import { runDataQualityForCurrency } from "./data-quality.mjs";
import { computeTopOpportunity } from "./top-opportunity.mjs";
import { readFileSync } from "node:fs";

// Ověřené záložní roční CPI pro měny, kterým ForexFactory headline CPI y/y nedává (CHF, CAD, NZD).
// Zdroj, období a datum vydání jsou v souboru; po uplynutí max_age_dni se hodnota nepoužije.
const REFERENCE_CPI = JSON.parse(
  readFileSync(new URL("../data/reference-cpi.json", import.meta.url), "utf8")
).entries;

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

// ForexFactory/Cloudflare blokuje GitHub Actions IP rozsah nepřetržitě od 22.9.2026 ~04:00 UTC
// (HTTP 403 na VŠECH offsetech, potvrzeno živě). Fx-Analyzer (sesterský projekt, sdílí tenhle
// Supabase projekt) má stejný problém už od 9.9.2026 a řeší ho přes Edge Function relay
// (ff-calendar-relay) — čistý HTTP proxy na ForexFactory z egressu Supabase (ten blokovaný
// není), whitelist jen na `week` parametr (žádný obecný open proxy), viz zdroj funkce. Živě
// ověřeno 23.9.2026: Fx-Analyzer přes relay úspěšně scrapuje, zatímco přímý fetch z GitHub
// Actions dostává 403 na stejné URL ve stejnou chvíli.
//
// ANON klíč je veřejný/publishable (ne service role), bezpečně hardcodovatelný — stejný, co
// appka posílá z prohlížeče (src/lib) a co Fx-Analyzer už takhle používá.
const FF_RELAY_BASE = "https://wdcvxfbhauwvwzbatkfh.supabase.co/functions/v1/ff-calendar-relay";
const FF_RELAY_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndkY3Z4ZmJoYXV3dnd6YmF0a2ZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NjU2NjEsImV4cCI6MjA5NzE0MTY2MX0.7ofHhBK6OxTug6l3MgnLJFNECZOmaKB_Z35v9v80I2o";

// `fetch()` v Node nemá defaultní timeout — bez AbortSignal by zaseknutý relay (nebo
// zaseknutý přímý fetch) mohl viset donekonečna a zablokovat celý 15minutový cron (živě
// zachyceno při prvním nasazení relaye: běh, co normálně trvá ~60s, po 6+ minutách pořád
// visel na kroku fetch-calendar.mjs). 15s je dost na cold start Edge Function i pomalejší
// odpověď ForexFactory, ale krátké dost, aby 9 offsetů v nejhorším případě (relay i fallback
// oba timeoutnou) zabralo řádově ~5 min, ne hodiny.
const FETCH_TIMEOUT_MS = 15000;

async function fetchFFWeek(week) {
  try {
    const relayRes = await fetch(`${FF_RELAY_BASE}?week=${week}`, {
      headers: { Authorization: `Bearer ${FF_RELAY_KEY}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (relayRes.ok) return relayRes;
    console.warn(`FF relay ${week}: status=${relayRes.status} — zkouším přímý fetch...`);
  } catch (err) {
    console.warn(`FF relay ${week}: ERR ${err.message} — zkouším přímý fetch...`);
  }
  return fetch(`https://www.forexfactory.com/calendar?week=${week}`, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

export async function fetchWeek(offsetDays) {
  const week = weekParam(offsetDays);
  const res = await fetchFFWeek(week);
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

// Dřív SELECT + UPSERT zvlášť pro každý z ~830 eventů (~1660 dotazů za sebou) — živě změřeno
// 25.9.2026: 5 min 25 s jen na zápis, přičemž dnešní eventy jsou v pořadí až na konci, takže
// čerstvý actual (BOJ Core CPI, vydán 05:00) se do DB dostal až v 05:09. Teď jedno hromadné
// načtení existujících řádků pro celý rozsah dní + dávkový upsert jen řádků, které se opravdu
// změnily (planCalendarMerge v calendar-merge.mjs).
const UPSERT_BATCH_SIZE = 200;

async function fetchExistingInRange(fromDay, toDay) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("currency_code, event_title, event_day, event_time, impact, actual, estimate, previous")
      .gte("event_day", fromDay)
      .lte("event_day", toDay)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return { data: rows, error: null };
}

export async function mergeUpsert(events) {
  if (events.length === 0) return { count: 0, unchanged: 0, materialCurrencies: new Set() };

  const days = events.map((e) => e.event_day).sort();
  const { data: existingRows, error: readErr } = await fetchExistingInRange(days[0], days[days.length - 1]);
  if (readErr) {
    // Bez znalosti existujících řádků by merge mohl přepsat dřív zachycený actual prázdnou
    // hodnotou — radši tenhle běh nezapsat vůbec, další za 15 min to dožene.
    console.error("Nepodařilo se načíst existující calendar_events, kalendář se v tomhle běhu nezapisuje:", readErr.message);
    return { count: 0, unchanged: 0, materialCurrencies: new Set() };
  }

  // materialCurrencies: u KTERÝCH měn přibyl actual u eventu s váhou v EVENT_RULES — spouštěč
  // přegenerování narrativu jen pro ně (nákladový audit 2026-08-05), viz triggerNarrativeRegeneration.
  const { rows, unchanged, materialCurrencies } = planCalendarMerge(events, existingRows, new Date().toISOString());

  let count = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error: upsertErr } = await supabase
      .from("calendar_events")
      .upsert(batch, { onConflict: "currency_code,event_title,event_day" });
    if (upsertErr) {
      console.error(`Chyba dávkového upsertu (${batch.length} eventů od ${batch[0].currency_code}/${batch[0].event_title}):`, upsertErr.message);
      continue;
    }
    count += batch.length;
  }
  return { count, unchanged, materialCurrencies };
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
  // Texty příběhů od 2026-10 píše správce (Claude) přes ai-narrative.yml, ne OpenAI. Automatické
  // spouštění OpenAI generátoru je proto VYPNUTÉ (bez kreditu každý běh selhával a chodily e-maily).
  // Zapnutí zpět: repo variable OPENAI_NARRATIVE_ENABLED=1 (Settings → Variables).
  if (process.env.OPENAI_NARRATIVE_ENABLED !== "1") {
    console.log(`Přegenerování textů přes OpenAI je vypnuté (${reason}) — texty píše správce; neshodu ukáže check-narrative-freshness.`);
    return;
  }
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

// Práh pro Telegram alert na skokovou změnu skóre — nezávislý na SCORE_SNAPSHOT logice
// (ta loguje od 0.05, aby "poslední změna" nikdy neukazovala zastaralou hodnotu); alert je
// užší filtr NAD ní, jen na pohyby, co stojí za upozornění.
const SCORE_ALERT_THRESHOLD = 0.2;


// Pošle zprávu do Telegramu přes Bot API. Volitelné — bez TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID
// (secrets ve fetch-calendar.yml) se jen tiše přeskočí, ať appka funguje i bez nastaveného
// bota. Nesmí shodit zbytek přepočtu, kdyby Telegram API selhalo — vlastní try/catch.
async function sendTelegramAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.error(`Telegram alert selhal: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("Telegram alert selhal:", err.message);
  }
}

function daysBetween(isoDateA, isoDateB) {
  return Math.round((new Date(isoDateA).getTime() - new Date(isoDateB).getTime()) / 86400000);
}

// Nezávislý report (Cowork, 21.9.2026), P1.1/P1.2 — čerstvost pozicování. COT se publikuje
// týdně (pátek, data z předchozího úterý) a mezi vydáními je to jediný pevný bod vrstvy A
// (pozice/struktura) — appka to dřív blendovala se stejnou vahou bez ohledu na to, jestli od
// `report_date` mezitím proběhlo rozhodnutí centrální banky. Živě zachyceno: USD i JPY COT
// z 15.9. (před Fed 16.9. i BOJ 18.9.) neslo skoro polovinu váhy overall_score, i když
// pozicování změřené PŘED zasedáním nic neříká o světě PO něm.
//
// decay: 1,00 do 3 dní stáří (pá-ne po pátečním vydání), lineárně 1,00->0,50 mezi 3 a 10 dny,
// pak drženo na podlaze 0,50 (appka dál nespekuluje, o kolik dál by to mělo klesat — report
// dál nespecifikuje, a COT starší než ~2 týdny by měl spíš spadnout do P1.3 "insufficient"
// stavu, ne do čím dál menšího čísla; P1.3 zatím není implementován, viz commit message).
//
// event_penalty: 1,00 žádná HIGH událost dané měny po report_date; 0,50 proběhla libovolná
// HIGH událost; 0,25 proběhlo přímo rozhodnutí centrální banky (kategorie "Interest Rates") —
// pozicování měřené před zasedáním pořád nese informaci o tom, jak byl trh nastavený, jen ne
// o tom, co se stalo NA zasedání (viz zdůvodnění v reportu, proč ne 0 a ne 1,0).
const FRESHNESS_FULL_DAYS = 3;
const FRESHNESS_DECAY_END_DAYS = 10;
const FRESHNESS_DECAY_FLOOR = 0.5;
const EVENT_PENALTY_HIGH = 0.5;
const EVENT_PENALTY_CB_DECISION = 0.25;

function computeCotFreshness(currencyCode, cotReportDate, allEvents, todayIso) {
  if (!cotReportDate) return { freshness: 1, ageDays: null, staleReason: null };

  const ageDays = Math.max(0, daysBetween(todayIso, cotReportDate));
  let decay;
  if (ageDays <= FRESHNESS_FULL_DAYS) decay = 1;
  else if (ageDays >= FRESHNESS_DECAY_END_DAYS) decay = FRESHNESS_DECAY_FLOOR;
  else {
    const t = (ageDays - FRESHNESS_FULL_DAYS) / (FRESHNESS_DECAY_END_DAYS - FRESHNESS_FULL_DAYS);
    decay = 1 - t * (1 - FRESHNESS_DECAY_FLOOR);
  }

  // Živě nahlášená chyba (Petr, 22.9.2026): appka o pár hodin zpátky ukazovala skóre, co se
  // měnilo skoro každých 15 minut, i když se COT ani "tvrdá" fundamentální data vůbec nehnula.
  // Příčina: filtr dřív testoval jen `event_day <= todayIso` — BEZ ohledu na to, jestli událost
  // UŽ SKUTEČNĚ PROBĚHLA. Živě zachyceno: "RBA Gov Bullock Speaks" (impact High, event_day
  // dnešní, naplánovaná na 03:10 UTC) začala počítat jako "proběhlá HIGH událost" hned po
  // půlnoci, hodiny PŘED tím, než se proslov vůbec konal — a ForexFactory scraper takové
  // "speaker slot" řádky (impact/datum) navíc průběžně revidoval při každém 15minutovém běhu,
  // takže freshness_cot (a s ním overall_score) se přepočítával pokaždé jinak, i beze změny
  // čehokoliv reálného.
  //
  // Oprava #1 (příliš přísná, zpětně opravena tímhle commitem): vyžadovat `actual` vyplněné —
  // stejná zásada jako extractRateHistory/decisionConsensusPricedIn v cb-policy.mjs. Jenže
  // "RBA Gov Bullock Speaks" (a proslovy/tiskovky obecně, viz hasNoNumericActual
  // v data-quality.mjs) NIKDY actual nedostanou — appka by takovou událost nepočítala jako
  // "proběhlou" ani měsíce poté, co se skutečně stala. Actual != "proběhlo to", actual jen
  // znamená "appka má z toho číslo" — u proslovů žádné číslo neexistuje.
  //
  // Oprava #2 (tahle): appka to, jestli událost UŽ NASTALA, testuje proti `event_time`
  // (naplánovaný čas z ForexFactory) vs. aktuální čas běhu, ne proti `actual`. Funguje
  // stejně dobře pro číselné eventy (actual dorazí AŽ PO event_time, takže "proběhlo" i
  // "má actual" spadají prakticky vjedno) i pro proslovy/tiskovky (actual nikdy, ale
  // event_time pořád spolehlivě říká, kdy se to skutečně konalo). Bez `event_time` (starší
  // řádky) appka nemá lepší signál než `event_day <= todayIso` — stejné chování jako předtím.
  const nowMs = Date.now();
  const eventsSince = allEvents.filter((e) => {
    if (e.currency_code !== currencyCode || e.impact !== "High") return false;
    if (!(e.event_day > cotReportDate && e.event_day <= todayIso)) return false;
    if (e.event_time) return new Date(e.event_time).getTime() <= nowMs;
    return true;
  });
  const cbDecisionSince = eventsSince.find((e) => matchRule(e.event_title)?.cat === "Interest Rates");

  let eventPenalty = 1;
  let staleReason = null;
  if (cbDecisionSince) {
    eventPenalty = EVENT_PENALTY_CB_DECISION;
    staleReason = `COT z ${cotReportDate} předchází rozhodnutí centrální banky (${cbDecisionSince.event_title}, ${cbDecisionSince.event_day}).`;
  } else if (eventsSince.length > 0) {
    eventPenalty = EVENT_PENALTY_HIGH;
    staleReason = `COT z ${cotReportDate} předchází ${eventsSince.length} HIGH událost${eventsSince.length === 1 ? "i" : "em"} (např. ${eventsSince[0].event_title}, ${eventsSince[0].event_day}).`;
  } else if (ageDays > FRESHNESS_FULL_DAYS) {
    staleReason = `COT z ${cotReportDate} je ${ageDays} dní staré.`;
  }

  return { freshness: Math.round(decay * eventPenalty * 100) / 100, ageDays, staleReason };
}

// PostgREST vrací max 1000 řádků na dotaz bez explicitní stránkování — od backfillu historie
// (3000+ řádků v calendar_events) by neomezený .select() tiše ořezal část měn/historie
// použité pro fundamentální i CB Policy scoring. Stránkuje po 1000, dokud nedojdou řádky.
//
// KRITICKÉ: .range() bez .order() negarantuje stabilní pořadí mezi jednotlivými stránkami —
// bez ORDER BY Postgres nemá povinnost vracet řádky ve stejném pořadí napříč samostatnými
// dotazy, a calendar_events navíc dostává souběžné zápisy z 15minutového cronu (nové eventy,
// doplňování "actual"). Živě zachyceno 11.8.2026: USD mělo fundamentální skóre uvízlé na 0.0
// přes 24 hodin, protože Non-Farm Employment Change ze 7.8. (obří miss -23K vs. 85K, zdaleka
// nejsilnější nedávný signál) se do fetchnutých řádků vůbec nedostal — ne jen s nízkou váhou,
// ÚPLNĚ chyběl. Stejný problém byl už dřív diagnostikován pro generate-narrative.mjs (NZD,
// 3.8.2026) s komentářem, že tahle funkce už má opravu — omyl, .order() tu nikdy nebyl. Teď
// opraveno na obou místech: explicitní `order by id` dělá stránkování deterministické.
export async function fetchAllCalendarEvents() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, currency_code, event_title, event_day, event_time, impact, actual, estimate, previous")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return { data: rows, error: null };
}

// Uloží fundamentální STAV měny (state-v1, viz fundamental-state.mjs): aktuální řádek + řádek
// týdenní historie (klíč = pátek týdne, aktuální týden se přepisuje, dokud neskončí). Nekritické —
// chyba zápisu se jen zaloguje, přepočet skóre pokračuje.
export async function persistFundamentalState(state, surpriseScore) {
  const now = new Date().toISOString();
  const { error } = await supabase.from("fundamental_state").upsert(
    {
      currency_code: state.currencyCode,
      model_version: state.modelVersion,
      as_of_day: state.asOfDay,
      window_months: state.windowMonths,
      index_value: state.index,
      score: state.score,
      band_key: state.band.key,
      band_label: state.band.label,
      available_count: state.availableCount,
      total_count: state.totalCount,
      components: state.components.map(({ key, label, weight, score, detail }) => ({ key, label, weight, score, detail })),
      activity_score: state.activityScore,
      inflation: state.inflation,
      surprise_score: surpriseScore,
      surprise_label: describeSurprise(surpriseScore),
      updated_at: now,
    },
    { onConflict: "currency_code" }
  );
  if (error) console.error(`[${state.currencyCode}] chyba upsertu fundamental_state:`, error.message);

  const { error: histErr } = await supabase.from("fundamental_state_history").upsert(
    {
      currency_code: state.currencyCode,
      week_end: weekEndFriday(state.asOfDay),
      index_value: state.index,
      score: state.score,
      available_count: state.availableCount,
      component_signs: componentSigns(state),
      updated_at: now,
    },
    { onConflict: "currency_code,week_end" }
  );
  if (histErr) console.error(`[${state.currencyCode}] chyba upsertu fundamental_state_history:`, histErr.message);
}

export async function recomputeScores() {
  // Stejná konvence jako todaysFundamentalEventLabel výš (pražský, ne UTC den) — pro
  // computeCotFreshness níž, ať "je HIGH událost po report_date, ale ještě ne dnes" počítá se
  // stejným dnem, co appka jinde v tomhle souboru používá jako "dnes".
  const today = pragueDateString(new Date());
  const { data: allEvents, error } = await fetchAllCalendarEvents();

  if (error) {
    // Oprava (12.9.2026, živý výpadek — Supabase "Gateway Timeout" při čtení calendar_events):
    // holé `return;` tu vracelo undefined místo { thesisSignalCurrencies, staleTextCurrencies },
    // což volající main() (řádek ~932) rovnou destructuruje bez ošetření — TypeError shodil celý
    // běh přes top-level `main().catch(...) -> process.exit(1)` a poslal "Run failed" e-mail 3x
    // (1:00, 3:00, 6:30 UTC), i když šlo jen o přechodnou chybu čtení, ne o skutečné selhání
    // scoringu. Stejný princip jako u ForexFactory 403 výše: dočasná chyba čtení jednoho zdroje
    // se má přeskočit (další běh za 15 min to dožene), ne shodit celý proces.
    console.error("Nepodařilo se načíst calendar_events pro scoring:", error.message);
    return { thesisSignalCurrencies: new Set(), staleTextCurrencies: new Set() };
  }

  console.log("Stahuji US 2Y výnos z FRED (priced-in USD)...");
  const usd2yYield = await fetchUsd2yYield();

  // Druhý, nezávislý spouštěč přegenerování narrativu (viz komentář u runThesisEngineForCurrency
  // v thesis-engine.mjs) — na rozdíl od materialCurrencies (scrape-diff, per-event) tohle
  // sleduje, u KTERÝCH měn se reálně pohnul stav teze (nová teze, obrat, watching...). Set, ne
  // boolean — viz komentář u triggerNarrativeRegeneration, appka musí vědět KTERÉ měny, ne jen že
  // "něco, někde".
  const thesisSignalCurrencies = new Set();

  // Telegram alert na skok skóre — jen SESBÍRAT přes celou smyčku měn, ne posílat rovnou.
  // Zpráva chce i "nejsilnější/nejslabší měna", což potřebuje přehled VŠECH měn najednou —
  // ten je hotový až po computeTopOpportunity() níž, po skončení smyčky.
  const pendingScoreAlerts = [];

  // Telegram alert na REVIZI tržního konsensu k nadcházejícímu sazbovému rozhodnutí (živý
  // podnět uživatele, 18.9.2026) — stejný princip jako pendingScoreAlerts výš: jen sesbírat
  // přes smyčku měn, poslat až po jejím skončení. Posílá se JEN při justRevised (viz
  // rate-decision-drift.mjs) — ne při prvním zachycení nové nadcházející sazby.
  const pendingDriftAlerts = [];

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

    const cbPolicy = computeCbPolicyState(currencyCode, SCORED_CURRENCIES, allEvents ?? [], { referenceCpi: REFERENCE_CPI });

    // USD má jediné ověřené live tržní "priced-in" data (FRED DGS2 2Y výnos) — kde je
    // k dispozici, přepiš decision_consensus proxy kvalitnější yield_gap metodou.
    if (currencyCode === "USD" && usd2yYield !== null && cbPolicy.rate !== null) {
      const yieldGap = yieldGapPricedIn(usd2yYield, cbPolicy.rate);
      if (yieldGap) cbPolicy.pricedIn = yieldGap;
    }

    // Živý podnět uživatele (16.9.2026): appka dřív u nadcházejícího sazbového rozhodnutí
    // viděla jen AKTUÁLNÍ snímek konsensu (bod #7), ne jak se k němu trh dopracoval. Obohatí
    // upcomingDecision o `drift` — kdy appka konsensus poprvé zachytila, jestli se od té doby
    // posunul a jestli je rozhodnutí už blízko (viz rate-decision-drift.mjs). Čistě informační,
    // nikam jinam se nepromítá.
    if (cbPolicy.upcomingDecision) {
      cbPolicy.upcomingDecision = await trackRateDecisionDrift(currencyCode, cbPolicy.upcomingDecision);
      if (cbPolicy.upcomingDecision.drift?.justRevised) {
        pendingDriftAlerts.push({ currencyCode, decision: cbPolicy.upcomingDecision });
      }
    }

    const { error: cbErr } = await supabase.from("cb_policy_state").upsert(
      {
        currency_code: currencyCode,
        rate: cbPolicy.rate,
        cpi: cbPolicy.cpi,
        policy_score: cbPolicy.policyScore,
        policy_label: cbPolicy.policyLabel,
        policy_confidence: cbPolicy.policyConfidence,
        // P0.1 (Cowork report, 21.9.2026) — viz autoDetectPolicy v cb-policy.mjs. Bez tohohle
        // by nové sloupce zůstaly navždy null, přestože computeCbPolicyState() je počítá
        // správně — živě odhaleno hned po prvním ostrém běhu po nasazení (policy_label se
        // opravil, last_move_* zůstaly null, protože sem chyběly v upsertu).
        last_move_bp: cbPolicy.lastMoveBp,
        last_move_date: cbPolicy.lastMoveDate,
        days_since_move: cbPolicy.daysSinceMove,
        real_yield_adj: cbPolicy.realYieldAdj,
        cb_policy_adj: cbPolicy.cbPolicyAdj,
        priced_in: cbPolicy.pricedIn,
        // Bod #7 (ChatGPT/Cowork Opus, 4.9.2026) — čistě informační (viz upcomingRateDecision,
        // cb-policy.mjs), nikam jinam v tomhle souboru se nepromítá.
        upcoming_decision: cbPolicy.upcomingDecision,
        rate_history: cbPolicy.rateHistory,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "currency_code" }
    );
    if (cbErr) console.error(`[${currencyCode}] chyba upsertu cb_policy_state:`, cbErr.message);

    // Fundamentální STAV měny (state-v1) = hlavní skóre a pořadí. Skládá se ze 6 složek (politika
    // CB, reálný výnos, trh práce, růst, spotřeba, PMI) z posledních 12 měsíců kalendáře; chybějící
    // data jsou "nemáme", ne nula. Skóre z překvapení (result.fundamentalScore) se ukládá vedle,
    // mimo index. Viz fundamental-state.mjs (včetně výsledků backtestu).
    const state = computeFundamentalState(currencyCode, SCORED_CURRENCIES, allEvents ?? [], { asOfDay: today, cb: cbPolicy });
    try {
      await persistFundamentalState(state, result.fundamentalScore);
    } catch (stateErr) {
      console.error(`[${currencyCode}] uložení fundamentálního stavu selhalo (nekriticky):`, stateErr.message);
    }

    const { data: latestCot, error: cotSelectErr } = await supabase
      .from("latest_confluence_scores")
      .select("report_date, cot_score, cot_flow, retail_score, cot_percentile")
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

    // Celkové skóre = fundamentální STAV měny (index × 5, viz fundamental-state.mjs). COT, retail
    // sentiment, VIX ani cena do něj nevstupují — COT se ukládá a zobrazuje zvlášť jako doplněk.
    // Nedostatek dat (méně než 3 složky) = skóre neexistuje: nic se nedomýšlí, uložená hodnota
    // zůstane a UI ukáže "nedostatek dat" z fundamental_state.
    if (state.score === null) {
      console.log(`[${currencyCode}] stav: nedostatek dat (${state.availableCount}/${state.totalCount} složek) — overall_score se nemění.`);
      continue;
    }
    const overallScore = state.score;
    const fundamentalScoreAdj = state.activityScore ?? 0; // reálná ekonomika — driver tezí

    // Čerstvost COT se dál počítá a ukládá (freshness_cot/stale_reason) — už jen pro zobrazení
    // doplňkového údaje, ne jako váha ve skóre.
    const cotFreshness = computeCotFreshness(currencyCode, cotRow.report_date, allEvents ?? [], today);

    const conviction = { stars: state.convictionStars, reasons: state.convictionReasons };

    const { error: updErr } = await supabase
      .from("confluence_scores")
      .update({
        overall_score: overallScore,
        data_tier: "partial",
        conviction_stars: conviction.stars,
        conviction_reasons: conviction.reasons,
        conviction_label: state.convictionLabel,
        freshness_cot: cotFreshness.freshness,
        stale_reason: cotFreshness.staleReason,
      })
      .eq("currency_code", currencyCode)
      .eq("report_date", cotRow.report_date);

    if (updErr) {
      console.error(`[${currencyCode}] chyba aktualizace overall_score:`, updErr.message);
    } else {
      console.log(
        `[${currencyCode}] stav ${state.index} (${state.availableCount}/${state.totalCount} složek, ${state.band.label}; cot ${cotRow.cot_score} jen jako doplněk, freshness ${cotFreshness.freshness ?? "N/A"}) ` +
          `-> overall_score=${overallScore} (shoda ${state.agreeCount}/${state.availableCount})`
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
            // Porovnává se přímo stejná pole, co kontroluje check-narrative-freshness.mjs.
            // Retail sentiment už v textech není (není to fundament), COT je jen doplňkový údaj.
            const overallDrift = Math.abs(Number(snap.overall_score) - overallScore);
            const fundDrift = Math.abs(Number(snap.fundamental_score) - result.fundamentalScore);
            const cotDrift = Math.abs(Number(snap.cot_score ?? 0) - cotRow.cot_score);
            if (
              overallDrift > STALE_TEXT_EPSILON ||
              fundDrift > STALE_TEXT_EPSILON ||
              cotDrift > STALE_TEXT_EPSILON
            ) {
              staleTextCurrencies.add(currencyCode);
              console.log(
                `[${currencyCode}] text neodpovídá skóre (overall text=${snap.overall_score} živé=${overallScore}, ` +
                  `fund text=${snap.fundamental_score} živé=${result.fundamentalScore}, ` +
                  `cot text=${snap.cot_score ?? 0} živé=${cotRow.cot_score}) — přidáno k přegenerování.`
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
      // (fundamentalScoreAdj jinde v DB neexistuje — počítá se jen v paměti výš).
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
            retail_score: null,
            risk_adj: null,
            conviction_stars: conviction.stars,
          });
          if (snapErr) console.error(`[${currencyCode}] chyba zápisu score_snapshots:`, snapErr.message);
          else if (previous !== null) {
            const d = Math.round((overallScore - Number(previous)) * 100) / 100;
            console.log(`[${currencyCode}] skóre se pohnulo: ${previous} -> ${overallScore} (${d > 0 ? "+" : ""}${d})`);
            if (Math.abs(d) >= SCORE_ALERT_THRESHOLD) {
              pendingScoreAlerts.push({ currencyCode, delta: d, overallScore });
            }
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
          cbPolicyAdj: cbPolicy.cbPolicyAdj,
          realYieldAdj: cbPolicy.realYieldAdj,
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
  // volá jednou tady, ne uvnitř smyčky per měna. Vrácené strongest/weakest se zároveň hodí
  // do Telegram alertů níž — ať appka pro to samé kolo nepočítá "nejsilnější/nejslabší"
  // podruhé vlastním dotazem.
  let topOpportunity = null;
  try {
    topOpportunity = await computeTopOpportunity();
  } catch (topErr) {
    console.error("top-opportunity selhal (nekriticky):", topErr.message);
  }

  // Telegram alerty na skok skóre — posílané až tady, po dopočtení celého kola, aby zpráva
  // mohla vedle konkrétního pohybu ukázat i "nejsilnější/nejslabší měna právě teď" (viz
  // pendingScoreAlerts výš).
  for (const alert of pendingScoreAlerts) {
    const arrow = alert.delta > 0 ? "📈" : "📉";
    const fmt = (n) => `${n > 0 ? "+" : ""}${n}`;
    let text = `${arrow} <b>${alert.currencyCode}</b> ${fmt(alert.delta)} bodu → celkem <b>${fmt(alert.overallScore)}</b>`;
    if (topOpportunity) {
      text +=
        `\n\nNejsilnější: ${topOpportunity.strongest.currencyCode} (${fmt(topOpportunity.strongest.overallScore)})` +
        `\nNejslabší: ${topOpportunity.weakest.currencyCode} (${fmt(topOpportunity.weakest.overallScore)})`;
    }
    await sendTelegramAlert(text);
  }

  // Telegram alert na revizi konsensu (živý podnět uživatele, 18.9.2026) — posláno až tady,
  // po dopočtení celého kola, stejná konvence jako pendingScoreAlerts výš.
  for (const { currencyCode, decision } of pendingDriftAlerts) {
    const d = decision.drift;
    const fmtRate = (n) => `${n.toFixed(2)} %`;
    let text =
      `📊 <b>${currencyCode}</b> — konsensus na "${decision.eventTitle}" se posunul: ` +
      `${fmtRate(d.previousEstimateRate)} → ${fmtRate(decision.estimateRate)}` +
      `\nRozhodnutí za ${d.daysUntilDecision} ${d.daysUntilDecision === 1 ? "den" : "dní"} (${decision.eventDay}), aktuální sazba ${fmtRate(decision.currentRate)}.`;
    if (d.imminent) text += "\n⚠️ Rozhodnutí je už blízko.";
    await sendTelegramAlert(text);
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

  // Oprava (10.9.2026, živý výpadek ForexFactory — bot ochrana vrací HTTP 403 na celý rozsah):
  // dřív `process.exit(1)` tady ukončil CELÝ skript. Scraping kalendáře a přepočet
  // skóre/konvikce/teze (recomputeScores níž) byly v jednom procesu, takže selhání
  // ForexFactory vedlejším efektem zamrazilo recomputeScores() pro všech 8 měn, i když s
  // kalendářem nemají nic společného. Živě zachyceno: 20+ hodin bez jediného přepočtu tezí
  // (9.9. 14:05 -> 10.9.), zatímco poslední report appce tvrdil jen "nerefreshuje se
  // kalendář". Appka teď jen zaloguje varování a NEZAPÍŠE kalendář (stejná ochrana jako
  // dřív — žádná prázdná/polámaná data), ale pokračuje na recomputeScores(), aby COT/
  // fundament/retail/konvikce/teze fungovaly normálně i během výpadku externího scrapingu.
  // Bez process.exit(1) navíc GitHub Actions job neoznačí běh jako selhání — přestanou
  // chodit e-maily "Run failed", dokud se ForexFactory sám neuvolní (uživatel o výpadku ví
  // a sleduje ho zvlášť, viz konzolový warning níž, co v logu zůstává).
  let materialCurrencies = new Set();
  if (deduped.length < 20) {
    console.warn("Méně než 20 eventů celkem — pravděpodobně selhal scraping ForexFactory. Kalendář se nezapisuje, skóre/konvikce/teze se přepočítají dál.");
  } else {
    const merged = await mergeUpsert(deduped);
    materialCurrencies = merged.materialCurrencies;
    console.log(`Zapsáno ${merged.count} nových/změněných eventů, ${merged.unchanged} beze změny (z ${deduped.length}).`);
  }

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
