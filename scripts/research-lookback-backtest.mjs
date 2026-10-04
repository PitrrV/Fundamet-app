// Výzkumný backtest (READ-ONLY): jak dlouhá historie dává nejlepší fundamentální "stav" měny.
//
// Nic nezapisuje do žádné tabulky ani nevolá recomputeScores(). Starší týdny kalendáře
// (2020 → říjen 2025) stáhne přes stejné relay jako produkce a drží je jen v paměti/souboru
// research-cache/ (GitHub Actions cache). Novější data bere z calendar_events (čtení).
//
// Otázka: kolik historie (okno W měsíců, počet předchozích tisků k) má index používat, aby
// co nejlépe sedělo na to, co se s cenou měny stalo POZDĚJI — vždy jen z dat známých k danému
// pátku (point-in-time).
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fetchWeek, dedupePreferComplete } from "./fetch-calendar.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";
import { computeFundamentalScore } from "./fundamental-scoring.mjs";
import { computeFundamentalState } from "./fundamental-state.mjs";
import {
  extractUnemploymentHistory, extractGrowthHistory, extractRetailSalesHistory, extractPmiHistory,
} from "./shadow-fundamental-engine.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("chybí SUPABASE_URL / SUPABASE_SERVICE_KEY");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const CODES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];
const DAY = 86400000;
const SCRAPE_FROM = "2020-01-01"; // středa
const SCRAPE_TO = "2025-10-08"; // středa — DB kalendář začíná 2025-10-07
const EVAL_FROM = "2023-01-06";
const WINDOWS = [6, 12, 24, 36, null]; // měsíce; null = všechno od roku 2020
const KS = [1, 3, 6]; // kolik předchozích tisků tvoří "normu"
const HORIZONS = [1, 2, 4, 8, 13]; // týdny dopředu
const THRESH = 0.5;
const CACHE = "research-cache/calendar-old.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addMonths = (day, m) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + m); return iso(d); };

// ---------- data ----------
async function loadOldCalendar() {
  if (existsSync(CACHE) && !process.env.FORCE_SCRAPE) {
    console.log("Kalendář z cache:", CACHE);
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
  const now = Date.now();
  const all = [];
  let failed = 0, weeks = 0;
  for (let d = new Date(`${SCRAPE_TO}T00:00:00Z`).getTime(); d >= new Date(`${SCRAPE_FROM}T00:00:00Z`).getTime(); d -= 7 * DAY) {
    weeks++;
    const offset = Math.round((d - now) / DAY);
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try { all.push(...(await fetchWeek(offset))); ok = true; } catch (e) { await sleep(3000); }
    }
    if (!ok) { failed++; console.warn(`týden ${iso(d)} selhal`); }
    await sleep(1500);
  }
  console.log(`Staženo ${weeks} týdnů, ${failed} selhalo, ${all.length} událostí.`);
  const deduped = dedupePreferComplete(all);
  mkdirSync("research-cache", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(deduped));
  return deduped;
}

async function pageAll(table, columns, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ---------- komponenty indexu ----------
function trendSign(hist, k, invert) {
  if (hist.length < k + 1) return null;
  const v = hist.map((h) => h.value);
  const z = (v[v.length - 1] - mean(v.slice(-1 - k, -1))) / (sd(v) || 1);
  const s = z >= THRESH ? 1 : z <= -THRESH ? -1 : 0;
  return invert ? -s : s;
}
function pmiSign(hist) {
  if (!hist.length) return null;
  const l = hist[hist.length - 1].value;
  return l > 50.5 ? 1 : l < 49.5 ? -1 : 0;
}

// ---------- statistika ----------
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  if (x.length < 3) return null;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

let RET = {}; // RET[f][c] = {tr13, f1, f2, f4, f8, f13}

// rows: [{f, c, v}] — vyhodnocení proti budoucí relativní síle měny
function evaluate(rows) {
  const out = {};
  const byWeek = new Map();
  for (const r of rows) { if (!byWeek.has(r.f)) byWeek.set(r.f, []); byWeek.get(r.f).push(r); }
  for (const h of HORIZONS) {
    const key = `f${h}`;
    const px = [], py = [], ics = [];
    let hit = 0, hitN = 0;
    for (const [f, rs] of byWeek) {
      const use = rs.filter((r) => RET[f]?.[r.c]?.[key] != null);
      if (use.length < 5) continue;
      const v = use.map((r) => r.v), y = use.map((r) => RET[f][r.c][key]);
      const mv = mean(v), my = mean(y);
      use.forEach((r, i) => { px.push(v[i] - mv); py.push(y[i] - my); if (v[i] - mv !== 0) { hitN++; if (Math.sign(v[i] - mv) === Math.sign(y[i] - my)) hit++; } });
      const ic = pearson(ranks(v), ranks(y));
      if (ic !== null) ics.push(ic);
    }
    const mic = ics.length ? mean(ics) : null;
    const teff = ics.length > 3 ? mic / (sd(ics) / Math.sqrt(ics.length / h)) : null;
    out[h] = { n: px.length, weeks: ics.length, corr: pearson(px, py), ic: mic, t: teff, hit: hitN ? hit / hitN : null };
  }
  return out;
}
const years0 = (fr) => [...new Set(fr.map((f) => f.slice(0, 4)))];
const fmt = (x, d = 2) => (x === null || x === undefined ? "  n/a" : x.toFixed(d).padStart(5));
function line(label, ev, extra = "") {
  const cells = HORIZONS.map((h) => `${fmt(ev[h].ic)}(t${fmt(ev[h].t, 1)})`).join("  ");
  console.log(`${label.padEnd(26)} ${cells}  ${extra}`);
}

// ---------- hlavní ----------
async function main() {
  const old = await loadOldCalendar();
  const dbRows = await pageAll("calendar_events", "currency_code,event_title,event_day,event_time,impact,actual,estimate,previous");
  const dbMin = dbRows.reduce((m, r) => (r.event_day < m ? r.event_day : m), "9999");
  const events = [...old.filter((e) => e.event_day < dbMin), ...dbRows].sort((a, b) => (a.event_day < b.event_day ? -1 : 1));
  console.log(`Události: ${events.length} (staré ${old.length}, DB ${dbRows.length}, DB od ${dbMin}); rozsah ${events[0].event_day} → ${events[events.length - 1].event_day}`);

  // ceny
  const prices = await pageAll("fx_price_daily", "pair,price_date,close", (q) => q.gte("price_date", "2022-10-01").order("price_date", { ascending: true }).order("pair", { ascending: true }));
  const byPair = new Map();
  for (const p of prices) { if (p.pair.length !== 6) continue; if (!byPair.has(p.pair)) byPair.set(p.pair, []); byPair.get(p.pair).push([p.price_date, Number(p.close)]); }
  const lastPriceDay = prices.reduce((m, p) => (p.price_date > m ? p.price_date : m), "0");
  const closeAt = (pair, day) => { const a = byPair.get(pair); let lo = 0, hi = a.length - 1, res = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid][0] <= day) { res = a[mid][1]; lo = mid + 1; } else hi = mid - 1; } return res; };
  const ccyRet = (c, d0, d1) => { const xs = []; for (const pair of byPair.keys()) { const b = pair.slice(0, 3), q = pair.slice(3); if (b !== c && q !== c) continue; const p0 = closeAt(pair, d0), p1 = closeAt(pair, d1); if (!p0 || !p1) continue; xs.push((b === c ? 1 : -1) * Math.log(p1 / p0) * 100); } return xs.length >= 4 ? mean(xs) : null; };

  const fridays = [];
  for (let t = new Date(`${EVAL_FROM}T00:00:00Z`).getTime(); iso(t) <= lastPriceDay; t += 7 * DAY) fridays.push(iso(t));
  RET = {};
  for (const f of fridays) {
    RET[f] = {};
    for (const c of CODES) {
      const r = { tr13: ccyRet(c, iso(new Date(f).getTime() - 91 * DAY), f) };
      for (const h of HORIZONS) { const end = iso(new Date(f).getTime() + 7 * h * DAY); r[`f${h}`] = end <= lastPriceDay ? ccyRet(c, f, end) : null; }
      RET[f][c] = r;
    }
  }
  console.log(`Pátků: ${fridays.length} (${fridays[0]} → ${fridays[fridays.length - 1]}), poslední cena ${lastPriceDay}`);

  // komponenty per (pátek, okno, měna)
  const comp = new Map(); // `${f}|${W}|${c}` -> {pol, ry, labHist, grHist, deHist, pmiHist}
  const surprise = new Map();
  for (const f of fridays) {
    for (const W of WINDOWS) {
      const from = W ? addMonths(f, -W) : "0000-00-00";
      const ev = events.filter((e) => e.event_day < f && e.event_day >= from);
      for (const c of CODES) {
        const cb = computeCbPolicyState(c, CODES, ev);
        comp.set(`${f}|${W}|${c}`, {
          pol: Math.sign(cb.policyScore),
          ry: cb.realYieldAdj === null || cb.realYieldAdj === undefined ? null : cb.realYieldAdj > 0.05 ? 1 : cb.realYieldAdj < -0.05 ? -1 : 0,
          lab: extractUnemploymentHistory(c, ev), gr: extractGrowthHistory(c, ev), de: extractRetailSalesHistory(c, ev), pmi: pmiSign(extractPmiHistory(c, ev)),
        });
      }
    }
    const evS = events.filter((e) => e.event_day < f && e.event_day >= iso(new Date(f).getTime() - 120 * DAY));
    for (const c of CODES) surprise.set(`${f}|${c}`, computeFundamentalScore(c, evS, new Date(`${f}T00:00:00Z`)).fundamentalScore);
  }

  const buildRows = (W, k) => {
    const rows = [];
    for (const f of fridays) for (const c of CODES) {
      const x = comp.get(`${f}|${W}|${c}`);
      const s = [x.pol, x.ry, trendSign(x.lab, k, true), trendSign(x.gr, k, false), trendSign(x.de, k, false), x.pmi].filter((v) => v !== null);
      if (s.length >= 3) rows.push({ f, c, v: mean(s), n: s.length });
    }
    return rows;
  };

  const head = `${"varianta".padEnd(26)} ${HORIZONS.map((h) => `IC ${h}t`.padStart(14)).join("  ")}`;
  console.log(`\n=== Týdenní rank-IC (t = přepočtené na nepřekrývající se vzorky) — vlastní pokrytí každé varianty ===`);
  console.log(head);
  const sets = {};
  for (const W of WINDOWS) for (const k of KS) {
    const rows = buildRows(W, k);
    sets[`${W}|${k}`] = rows;
    const e = evaluate(rows);
    line(`okno ${W ?? "vše"} m, k=${k}`, e, `pokrytí ${(100 * rows.length / (fridays.length * 8)).toFixed(0)} %, prům. složek ${rows.length ? mean(rows.map((r) => r.n)).toFixed(1) : "-"}`);
  }

  // společný vzorek (k=3): jen (pátek, měna) platné ve všech oknech
  const common = new Set(WINDOWS.map((W) => new Set(sets[`${W}|3`].map((r) => `${r.f}|${r.c}`))).reduce((a, b) => new Set([...a].filter((x) => b.has(x)))));
  console.log(`\n=== Společný vzorek (k=3, platné ve všech oknech, ${common.size} pozorování) ===`);
  console.log(head);
  for (const W of WINDOWS) line(`okno ${W ?? "vše"} m`, evaluate(sets[`${W}|3`].filter((r) => common.has(`${r.f}|${r.c}`))));

  // benchmark: skóre z překvapení (původní fundamentální skóre)
  const surpRows = []; for (const f of fridays) for (const c of CODES) { const v = surprise.get(`${f}|${c}`); if (v !== null && v !== undefined) surpRows.push({ f, c, v }); }
  console.log(`\n=== Benchmark: staré skóre z překvapení (okno 120 dní) ===`);
  console.log(head);
  line("překvapení", evaluate(surpRows));
  line("překvapení (společný vz.)", evaluate(surpRows.filter((r) => common.has(`${r.f}|${r.c}`))));

  // jednotlivé složky (okno 36 m, k=3)
  console.log(`\n=== Jednotlivé složky samostatně (okno 36 m, k=3) ===`);
  console.log(head);
  const parts = { "politika CB": (x) => x.pol, "reálný výnos": (x) => x.ry, "trh práce": (x) => trendSign(x.lab, 3, true), "růst": (x) => trendSign(x.gr, 3, false), "spotřeba": (x) => trendSign(x.de, 3, false), "PMI": (x) => x.pmi };
  for (const [name, fn] of Object.entries(parts)) {
    const rows = []; for (const f of fridays) for (const c of CODES) { const v = fn(comp.get(`${f}|36|${c}`)); if (v !== null) rows.push({ f, c, v }); }
    line(name, evaluate(rows), `n=${rows.length}`);
  }

  // produkční modul state-v1 (váhy 1,5/1,5/1/1/1/0,5, okno 12 m) vs. stejné složky s rovnými vahami
  console.log(`\n=== Produkční modul state-v1: vážený vs. rovné váhy (události striktně před pátkem) ===`);
  console.log(head);
  const weighted = [], equal = [], byYear = {};
  for (const f of fridays) for (const c of CODES) {
    const st = computeFundamentalState(c, CODES, events, { asOfDay: iso(new Date(f).getTime() - DAY) });
    if (st.index === null) continue;
    weighted.push({ f, c, v: st.index });
    const av = st.components.filter((x) => x.score !== null);
    equal.push({ f, c, v: av.reduce((a, x) => a + x.score, 0) / av.length });
  }
  line("vážený (produkce od 4.10. = V6)", evaluate(weighted), `n=${weighted.length}`);
  line("rovné váhy", evaluate(equal), `n=${equal.length}`);
  console.log(`${"po letech (vážený)".padEnd(12)} ` + years0(fridays).map((y) => { const e = evaluate(weighted.filter((r) => r.f.startsWith(y))); return `${y}: IC4=${fmt(e[4].ic)} IC13=${fmt(e[13].ic)}`; }).join("  "));

  // varianty oprav (kroky 2–4 plánu) — stejné váhy a okno, mění se jen přepínače
  console.log(`\n=== Varianty oprav state-v1 (události striktně před pátkem) ===`);
  console.log(head);
  const OFF = { consistentGrowthUnit: false, completePmiMonths: false, extraSeries: false, smoothDemand: false };
  const VARIANTS0 = [
    ["V0 původní state-v1 (vše vypnuto)", {}],
    ["V1 HDP v jedné jednotce", { consistentGrowthUnit: true }],
    ["V2 PMI jen úplné měsíce", { completePmiMonths: true }],
    ["V3 nové řady AUD/NZD", { extraSeries: true }],
    ["V4 spotřeba po blocích", { smoothDemand: true }],
    ["V5 vše dohromady", { consistentGrowthUnit: true, completePmiMonths: true, extraSeries: true, smoothDemand: true }],
    ["V6 opravy dat (V1+V2+V3)", { consistentGrowthUnit: true, completePmiMonths: true, extraSeries: true }],
  ];
  // Výchozí hodnoty v produkci se od 2026-10-04 liší (V6 zapnuto) — varianty proto vždy od vypnutého základu.
  const VARIANTS = VARIANTS0.map(([name, options]) => [name, { ...OFF, ...options }]);
  const vrows = {}, vdemand = {}, vcover = {};
  for (const [name, options] of VARIANTS) {
    const rows = [], dem = [];
    const cov = { AUD: [0, 0, 0], NZD: [0, 0, 0] }; // [týdnů s indexem, součet složek, týdnů celkem]
    for (const f of fridays) for (const c of CODES) {
      const st = computeFundamentalState(c, CODES, events, { asOfDay: iso(new Date(f).getTime() - DAY), options });
      if (cov[c]) { cov[c][2]++; if (st.index !== null) { cov[c][0]++; cov[c][1] += st.availableCount; } }
      if (st.index !== null) rows.push({ f, c, v: st.index, n: st.availableCount });
      const d = st.components.find((x) => x.key === "demand");
      if (d.score !== null) dem.push({ f, c, v: d.score });
    }
    vrows[name] = rows; vdemand[name] = dem; vcover[name] = cov;
    line(name, evaluate(rows), `n=${rows.length}`);
  }
  const keyOf = (r) => `${r.f}|${r.c}`;
  const commonV = new Set(vrows[VARIANTS[0][0]].map(keyOf));
  for (const [name] of VARIANTS) { const k = new Set(vrows[name].map(keyOf)); for (const x of [...commonV]) if (!k.has(x)) commonV.delete(x); }
  console.log(`\n--- společný vzorek variant (${commonV.size} pozorování) ---`);
  console.log(head);
  for (const [name] of VARIANTS) line(name, evaluate(vrows[name].filter((r) => commonV.has(keyOf(r)))));
  console.log(`\n--- samotná složka spotřeba: tisk vs. průměr po blocích ---`);
  console.log(head);
  line("spotřeba — jednotlivý tisk", evaluate(vdemand[VARIANTS[0][0]]), `n=${vdemand[VARIANTS[0][0]].length}`);
  line("spotřeba — po blocích (V4)", evaluate(vdemand[VARIANTS[4][0]]), `n=${vdemand[VARIANTS[4][0]].length}`);
  console.log(`\n--- pokrytí AUD / NZD (týdnů s indexem z N, prům. složek) ---`);
  for (const [name] of [VARIANTS[0], VARIANTS[3], VARIANTS[6]]) {
    const c = vcover[name];
    console.log(`${name.padEnd(26)} AUD ${c.AUD[0]}/${c.AUD[2]} (${(c.AUD[1] / Math.max(1, c.AUD[0])).toFixed(1)})   NZD ${c.NZD[0]}/${c.NZD[2]} (${(c.NZD[1] / Math.max(1, c.NZD[0])).toFixed(1)})`);
  }
  console.log(`\n--- po letech, IC 4 týdny / 13 týdnů ---`);
  for (const [name] of [VARIANTS[0], VARIANTS[5], VARIANTS[6]]) {
    console.log(`${name.padEnd(26)} ` + years0(fridays).map((y) => { const e = evaluate(vrows[name].filter((r) => r.f.startsWith(y))); return `${y}: ${fmt(e[4].ic)}/${fmt(e[13].ic)}`; }).join("  "));
  }

  // stabilita po letech (h=4 t., k=3)
  console.log(`\n=== Stabilita po letech: IC pro 4 týdny dopředu (k=3) ===`);
  const years = [...new Set(fridays.map((f) => f.slice(0, 4)))];
  console.log(`${"okno".padEnd(12)} ${years.map((y) => y.padStart(8)).join(" ")}`);
  for (const W of WINDOWS) {
    const cells = years.map((y) => { const e = evaluate(sets[`${W}|3`].filter((r) => r.f.startsWith(y))); return e[4].ic === null ? "     n/a" : `${e[4].ic.toFixed(2).padStart(5)}/${String(e[4].weeks).padStart(2)}`; });
    console.log(`${(W ?? "vše").toString().padEnd(12)} ${cells.join(" ")}   (IC/počet týdnů)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
