// Výzkum (READ-ONLY): které fundamentální ukazatele opravdu nesou informaci o pozdějším pohybu ceny měny.
//
// 1) SCREENING: každý ukazatel zvlášť (trend proti vlastní normě; u některých i "překvapení" vs. konsenzus),
//    pooled i po letech — včetně NFP/Employment Change, mezd, inflace, důvěry, obchodní bilance, průmyslu,
//    sazbového rozdílu (carry) a současných 6 složek.
// 2) KOMBINACE: výběr podmnožin ukazatelů na TRÉNOVACÍCH letech (2023–2024) a ověření na TESTOVACÍCH
//    (2025–2026) — hodnotí se jen testovací část, ať se nevybírá to, co jen náhodou sedí na minulost.
// Žádný zápis do DB, žádná změna produkce. Data: kalendář z cache (research-lookback-backtest) + ceny.
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { computeFundamentalState } from "./fundamental-state.mjs";
import { computeCbPolicyState } from "./cb-policy.mjs";
import { computeFundamentalScore } from "./fundamental-scoring.mjs";
import { extractInflationHistory, CB_INFLATION_TARGET } from "./shadow-fundamental-engine.mjs";

const supabase = createClient(process.env.SUPABASE_URL ?? "http://localhost", process.env.SUPABASE_SERVICE_KEY ?? "x");
const CODES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];
const DAY = 86400000;
const EVAL_FROM = process.env.SMOKE_EVENTS ? "2026-01-02" : "2023-01-06";
const SPLIT = process.env.SMOKE_EVENTS ? "2026-06-01" : "2025-01-01"; // trénink < SPLIT <= test
const HORIZONS = [1, 4, 13];
const CACHE = "research-cache/calendar-old.json";

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addMonths = (day, m) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + m); return iso(d); };

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  if (x.length < 5) return null;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
const tStat = (r, n, h) => { if (r === null) return null; const ne = Math.max(5, n / Math.max(1, h)); return (r * Math.sqrt(ne - 2)) / Math.sqrt(Math.max(1e-9, 1 - r * r)); };
const f2 = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "  n/a" : x.toFixed(d).padStart(5));

// ---------- parsování a řady ----------
function parseValue(actual) {
  const m = String(actual).trim().match(/^(-?\d+(?:[.,]\d+)?)\s*([KMBT%]?)/i);
  if (!m) return NaN;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()] ?? 1;
  return parseFloat(m[1].replace(",", ".")) * mult;
}
const titleOk = (e, res) => res.some((re) => re.test((e.event_title || "").trim()));
function seriesOf(code, ev, res) {
  return ev
    .filter((e) => e.currency_code === code && e.actual != null && titleOk(e, res))
    .map((e) => ({ value: parseValue(e.actual), day: e.event_day, est: e.estimate == null ? NaN : parseValue(e.estimate) }))
    .filter((o) => !Number.isNaN(o.value))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}
function trendSign(hist, k = 3, thr = 0.5) {
  if (hist.length < k + 1) return null;
  const v = hist.map((h) => h.value);
  const z = (v[v.length - 1] - mean(v.slice(-1 - k, -1))) / (sd(v) || 1);
  return z >= thr ? 1 : z <= -thr ? -1 : 0;
}
function surpriseSign(hist, asOf) {
  const last = hist[hist.length - 1];
  if (!last || Number.isNaN(last.est)) return null;
  if ((new Date(asOf) - new Date(last.day)) / DAY > 45) return null;
  const d = last.value - last.est;
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

// Kategorie ukazatelů (dir = směr pro MĚNU: +1 vyšší = silnější měna, −1 opačně). Vlastní řady per měna.
const CATS = {
  unemp: { dir: -1, titles: Object.fromEntries(CODES.map((c) => [c, [/^unemployment rate$/i]])) },
  employment: { dir: { GBP: -1 }, defDir: 1, titles: { USD: [/^non-farm employment change$/i], CAD: [/^employment change$/i], AUD: [/^employment change$/i], GBP: [/^claimant count change$/i], NZD: [/^employment change q\/q$/i] } },
  wages: { dir: 1, titles: { USD: [/^average hourly earnings m\/m$/i], GBP: [/^average earnings index 3m\/y$/i], JPY: [/^average cash earnings y\/y$/i], AUD: [/^wage price index q\/q$/i] } },
  claims: { dir: -1, titles: { USD: [/^unemployment claims$/i] } },
  conf: { dir: 1, titles: {
    USD: [/^cb consumer confidence$/i, /^revised uom consumer sentiment$/i], EUR: [/^zew economic sentiment$/i, /^consumer confidence$/i, /^german ifo business climate$/i], GBP: [/^gfk consumer confidence$/i],
    JPY: [/^consumer confidence$/i, /^economy watchers sentiment$/i], CHF: [/^ubs economic expectations$/i, /^kof economic barometer$/i, /^seco consumer climate$/i],
    AUD: [/^westpac consumer sentiment$/i, /^nab business confidence$/i], NZD: [/^anz business confidence$/i] } },
  trade: { dir: 1, titles: { USD: [/^trade balance$/i], EUR: [/^trade balance$/i], CAD: [/^trade balance$/i], JPY: [/^trade balance$/i], NZD: [/^trade balance$/i], AUD: [/^goods trade balance$/i], GBP: [/^goods trade balance$/i] } },
  indprod: { dir: 1, titles: { USD: [/^industrial production m\/m$/i], EUR: [/^industrial production m\/m$/i], GBP: [/^industrial production m\/m$/i], JPY: [/^(prelim|revised) industrial production m\/m$/i] } },
  pmi_mfg: { dir: "pmi", titles: { USD: [/^ism manufacturing pmi$/i], EUR: [/^(final|flash) manufacturing pmi$/i], GBP: [/^(final|flash) manufacturing pmi$/i], JPY: [/^(final|flash) manufacturing pmi$/i], AUD: [/^flash manufacturing pmi$/i], CAD: [/^manufacturing pmi$/i], CHF: [/^manufacturing pmi$/i], NZD: [/^businessnz manufacturing index$/i] } },
  pmi_svc: { dir: "pmi", titles: { USD: [/^ism services pmi$/i], EUR: [/^(final|flash) services pmi$/i], GBP: [/^(final|flash) services pmi$/i], AUD: [/^flash services pmi$/i], NZD: [/^businessnz services index$/i] } },
};
const dirOf = (cat, code) => (typeof CATS[cat].dir === "object" ? CATS[cat].dir[code] ?? CATS[cat].defDir : CATS[cat].dir);

function pmiLevel(hist) {
  if (!hist.length) return null;
  const l = hist[hist.length - 1].value;
  return l > 50.5 ? 1 : l < 49.5 ? -1 : 0;
}

// Všechny kandidátní signály pro (měna, den) z oken událostí
function featuresFor(code, ev, asOf, st, cb, rateMean) {
  const out = {};
  // současné složky stavu (produkční definice)
  for (const c of st.components) out[`cur_${c.key}`] = c.score;
  // nové kategorie: trend a překvapení
  for (const [cat, def] of Object.entries(CATS)) {
    const res = def.titles[code];
    if (!res) continue;
    const hist = seriesOf(code, ev, res);
    const d = dirOf(cat, code);
    if (d === "pmi") out[`${cat}_level`] = pmiLevel(hist);
    else {
      const t = trendSign(hist);
      out[`${cat}_trend`] = t === null ? null : t * d;
      const s = surpriseSign(hist, asOf);
      out[`${cat}_sur`] = s === null ? null : s * d;
    }
  }
  // inflace: úroveň proti cíli banky a trend (rostoucí inflace = jestřábí = silnější měna)
  const infl = extractInflationHistory(code, ev);
  if (infl.length) {
    const gap = infl[infl.length - 1].value - (CB_INFLATION_TARGET[code] ?? 2);
    out.infl_level = gap > 0.5 ? 1 : gap < -0.5 ? -1 : 0;
    out.infl_trend = trendSign(infl);
  }
  // carry: úroveň sazby proti průměru koše
  if (cb.rate !== null && cb.rate !== undefined && rateMean !== null) {
    const diff = cb.rate - rateMean;
    out.rate_level = diff > 0.25 ? 1 : diff < -0.25 ? -1 : 0;
  }
  // stará "překvapení" složka (okno 120 dní)
  const evS = ev.filter((e) => e.event_day >= iso(new Date(asOf).getTime() - 120 * DAY));
  const sur = computeFundamentalScore(code, evS, new Date(`${asOf}T00:00:00Z`)).fundamentalScore;
  out.old_surprise = sur === null || sur === undefined ? null : sur > 0.3 ? 1 : sur < -0.3 ? -1 : 0;
  return out;
}

// ---------- data ----------
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

async function main() {
  let events, prices;
  if (process.env.SMOKE_EVENTS) {
    // Lokální kouřový test bez DB: události z lokálního souboru, ceny = náhodná procházka (výsledky nic neznamenají).
    events = JSON.parse(readFileSync(process.env.SMOKE_EVENTS, "utf8"));
    prices = [];
    const pairs = CODES.flatMap((a) => CODES.filter((b) => b !== a).map((b) => a + b)).filter((p) => p < p.slice(3) + p.slice(0, 3));
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    for (const pair of pairs) { let v = 1; for (let t = new Date("2022-10-01").getTime(); t <= new Date("2026-10-08").getTime(); t += DAY) { v *= 1 + rnd() * 0.01; prices.push({ pair, price_date: iso(t), close: v }); } }
  } else {
    if (!existsSync(CACHE)) throw new Error("chybí cache kalendáře (spusť nejdřív Research - Lookback Backtest)");
    const old = JSON.parse(readFileSync(CACHE, "utf8"));
    const dbRows = await pageAll("calendar_events", "currency_code,event_title,event_day,event_time,impact,actual,estimate,previous");
    const dbMin = dbRows.reduce((m, r) => (r.event_day < m ? r.event_day : m), "9999");
    events = [...old.filter((e) => e.event_day < dbMin), ...dbRows].sort((a, b) => (a.event_day < b.event_day ? -1 : 1));
    prices = await pageAll("fx_price_daily", "pair,price_date,close", (q) => q.gte("price_date", "2022-10-01").order("price_date", { ascending: true }).order("pair", { ascending: true }));
  }
  const byPair = new Map();
  for (const p of prices) { if (p.pair.length !== 6) continue; if (!byPair.has(p.pair)) byPair.set(p.pair, []); byPair.get(p.pair).push([p.price_date, Number(p.close)]); }
  const lastPriceDay = prices.reduce((m, p) => (p.price_date > m ? p.price_date : m), "0");
  const closeAt = (pair, day) => { const a = byPair.get(pair); let lo = 0, hi = a.length - 1, res = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid][0] <= day) { res = a[mid][1]; lo = mid + 1; } else hi = mid - 1; } return res; };
  const ccyRet = (c, d0, d1) => { const xs = []; for (const pair of byPair.keys()) { const b = pair.slice(0, 3), q = pair.slice(3); if (b !== c && q !== c) continue; const p0 = closeAt(pair, d0), p1 = closeAt(pair, d1); if (!p0 || !p1) continue; xs.push((b === c ? 1 : -1) * Math.log(p1 / p0) * 100); } return xs.length >= 4 ? mean(xs) : null; };

  const fridays = [];
  for (let t = new Date(`${EVAL_FROM}T00:00:00Z`).getTime(); iso(t) <= lastPriceDay; t += 7 * DAY) fridays.push(iso(t));

  // pozorování: {f, c, y:{h}, feats}
  const obs = [];
  for (const f of fridays) {
    const asOf = iso(new Date(f).getTime() - DAY);
    const win = events.filter((e) => e.event_day >= addMonths(asOf, -12) && e.event_day <= asOf);
    const cbs = {};
    for (const c of CODES) cbs[c] = computeCbPolicyState(c, CODES, win);
    const rates = CODES.map((c) => cbs[c].rate).filter((r) => r !== null && r !== undefined);
    const rateMean = rates.length >= 5 ? mean(rates) : null;
    const rawY = {};
    for (const c of CODES) { rawY[c] = {}; for (const h of HORIZONS) { const end = iso(new Date(f).getTime() + 7 * h * DAY); rawY[c][h] = end <= lastPriceDay ? ccyRet(c, f, end) : null; } }
    for (const c of CODES) {
      const st = computeFundamentalState(c, CODES, events, { asOfDay: asOf, cb: cbs[c] });
      const feats = featuresFor(c, win, asOf, st, cbs[c], rateMean);
      feats.__index = st.index; // současná produkce
      const y = {};
      for (const h of HORIZONS) { const all = CODES.map((x) => rawY[x][h]); y[h] = rawY[c][h] === null || all.some((v) => v === null) ? null : rawY[c][h] - mean(all); }
      obs.push({ f, c, y, feats });
    }
  }
  console.log(`Pozorování: ${obs.length} (${fridays[0]} → ${fridays[fridays.length - 1]}), trénink < ${SPLIT} ≤ test`);

  const years = [...new Set(fridays.map((f) => f.slice(0, 4)))];
  const names = [...new Set(obs.flatMap((o) => Object.keys(o.feats)))].filter((n) => n !== "__index").sort();

  // ---- 1) SCREENING ----
  function evalSignal(rows, getV, h) {
    const px = [], py = [];
    for (const o of rows) { const v = getV(o); if (v === null || v === undefined || o.y[h] === null) continue; px.push(v); py.push(o.y[h]); }
    const r = pearson(px, py);
    let hit = 0, hn = 0;
    px.forEach((v, i) => { if (v !== 0) { hn++; if (Math.sign(v) === Math.sign(py[i])) hit++; } });
    return { n: px.length, r, t: tStat(r, px.length, h), hit: hn ? hit / hn : null };
  }
  console.log(`\n=== 1) SCREENING: každý ukazatel zvlášť (pooled korelace signálu s relativním pohybem měny; t přepočtené na nepřekrývající se vzorky) ===`);
  console.log(`${"ukazatel".padEnd(20)} ${"n".padStart(5)}   r1t    r4t(t)        r13t   trefa4t  roky r4t>0   (${years.join("/")})`);
  const rowsAll = [];
  for (const n of [...names, "__index"]) {
    const g = (o) => o.feats[n];
    const e1 = evalSignal(obs, g, 1), e4 = evalSignal(obs, g, 4), e13 = evalSignal(obs, g, 13);
    const yr = years.map((y) => evalSignal(obs.filter((o) => o.f.startsWith(y)), g, 4).r);
    const pos = yr.filter((r) => r !== null && r > 0).length, tot = yr.filter((r) => r !== null).length;
    rowsAll.push({ n, e4 });
    console.log(`${(n === "__index" ? "** PRODUKCE (index)" : n).padEnd(20)} ${String(e4.n).padStart(5)} ${f2(e1.r)} ${f2(e4.r)}(${f2(e4.t, 1)}) ${f2(e13.r)}  ${f2(e4.hit)}   ${pos}/${tot}   ${yr.map((r) => f2(r)).join(" ")}`);
  }

  // ---- NFP a spol. po měnách (časová řada v rámci měny) ----
  console.log(`\n=== Detail po měnách: korelace signálu s relativním pohybem TÉHOŽ měnového páru za 4 týdny (časová řada, n ≈ 190) ===`);
  for (const n of ["employment_trend", "employment_sur", "unemp_trend", "unemp_sur", "wages_trend", "wages_sur", "infl_level", "rate_level"]) {
    const cells = CODES.map((c) => { const e = evalSignal(obs.filter((o) => o.c === c), (o) => o.feats[n], 4); return e.n >= 30 ? `${c} ${f2(e.r)}(n${e.n})` : null; }).filter(Boolean);
    console.log(`${n.padEnd(18)} ${cells.join("  ") || "—"}`);
  }

  // ---- 2) KOMBINACE (výběr na tréninku, hodnocení na testu) ----
  const train = obs.filter((o) => o.f < SPLIT), test = obs.filter((o) => o.f >= SPLIT);
  function indexOf(o, subset, minAvail) {
    const s = subset.map((k) => o.feats[k]).filter((v) => v !== null && v !== undefined);
    return s.length >= minAvail ? mean(s) : null;
  }
  function objective(rows, subset, h = 4) {
    const minAvail = Math.min(2, subset.length);
    const byWeek = new Map();
    for (const o of rows) { const v = indexOf(o, subset, minAvail); if (v === null || o.y[h] === null) continue; if (!byWeek.has(o.f)) byWeek.set(o.f, []); byWeek.get(o.f).push([v, o.y[h]]); }
    const px = [], py = [];
    const ics = [];
    for (const arr of byWeek.values()) {
      if (arr.length < 3) continue;
      const mv = mean(arr.map((a) => a[0]));
      for (const a of arr) { px.push(a[0] - mv); py.push(a[1]); } // y už je demeaned přes všech 8
      if (arr.length >= 5) { const ic = pearson(ranks(arr.map((a) => a[0])), ranks(arr.map((a) => a[1]))); if (ic !== null) ics.push(ic); }
    }
    const r = pearson(px, py);
    return { r, n: px.length, t: tStat(r, px.length, h), ic: ics.length ? mean(ics) : null, weeks: ics.length };
  }
  const totalTrain = train.filter((o) => o.y[4] !== null).length;
  const cover = (subset) => { const m = Math.min(2, subset.length); return train.filter((o) => o.y[4] !== null && indexOf(o, subset, m) !== null).length / totalTrain; };

  const single = names.map((n) => ({ n, tr: objective(train, [n]), cov: cover([n]) })).filter((x) => x.cov >= 0.15 && x.tr.r !== null);
  single.sort((a, b) => b.tr.r - a.tr.r);
  const top = single.slice(0, 10).map((x) => x.n);
  console.log(`\n=== 2) KOMBINACE: výběr na tréninku (${train.length} poz.), vyhodnocení na testu (${test.length} poz.) ===`);
  console.log(`Kandidáti (top 10 podle tréninkové korelace, pokrytí ≥ 15 %): ${top.join(", ")}`);

  const results = [];
  const pushRes = (label, subset) => {
    const tr = objective(train, subset), te = objective(test, subset);
    results.push({ label, subset, tr, te, cov: cover(subset) });
  };
  // exhaustivně: podmnožiny 2–6 z top 10
  const k = top.length;
  for (let mask = 1; mask < 1 << k; mask++) {
    const sub = top.filter((_, i) => mask & (1 << i));
    if (sub.length < 2 || sub.length > 6) continue;
    pushRes(sub.join("+"), sub);
  }
  // greedy forward (celé množiny kandidátů)
  const greedy = [];
  let best = -1;
  for (let step = 0; step < 8; step++) {
    let pick = null;
    for (const n of names) {
      if (greedy.includes(n)) continue;
      const sub = [...greedy, n];
      if (cover(sub) < 0.3) continue;
      const o = objective(train, sub);
      if (o.r !== null && o.r > best + 0.004 && (!pick || o.r > pick.r)) pick = { n, r: o.r };
    }
    if (!pick) break;
    greedy.push(pick.n); best = pick.r;
  }
  if (greedy.length) pushRes(`GREEDY: ${greedy.join("+")}`, greedy);

  const baselines = [
    ["PRODUKCE (index state-v1)", null],
    ["6 současných složek, rovné váhy", ["cur_policy", "cur_realYield", "cur_labor", "cur_growth", "cur_demand", "cur_pmi"]],
    ["jen trh práce (cur_labor)", ["cur_labor"]],
    ["jen reálný výnos", ["cur_realYield"]],
    ["všechny ukazatele rovné váhy (trendy+úrovně, bez překvapení)", names.filter((n) => !n.endsWith("_sur") && n !== "old_surprise")],
  ];
  const pr = (o) => `r=${f2(o.r)} (t ${f2(o.t, 1)}) IC=${f2(o.ic)} n=${o.n}`;
  console.log(`\n--- základy pro srovnání ---`);
  for (const [name, sub] of baselines) {
    if (sub === null) {
      const prodObj = (rows) => { const px = [], py = []; const byWeek = new Map(); for (const o of rows) { if (o.feats.__index === null || o.y[4] === null) continue; if (!byWeek.has(o.f)) byWeek.set(o.f, []); byWeek.get(o.f).push([o.feats.__index, o.y[4]]); } const ics = []; for (const arr of byWeek.values()) { if (arr.length < 3) continue; const mv = mean(arr.map((a) => a[0])); for (const a of arr) { px.push(a[0] - mv); py.push(a[1]); } if (arr.length >= 5) { const ic = pearson(ranks(arr.map((a) => a[0])), ranks(arr.map((a) => a[1]))); if (ic !== null) ics.push(ic); } } const r = pearson(px, py); return { r, n: px.length, t: tStat(r, px.length, 4), ic: ics.length ? mean(ics) : null }; };
      console.log(`${name.padEnd(48)} TRÉNINK ${pr(prodObj(train))} | TEST ${pr(prodObj(test))}`);
    } else console.log(`${name.padEnd(48)} TRÉNINK ${pr(objective(train, sub))} | TEST ${pr(objective(test, sub))}`);
  }

  results.sort((a, b) => (b.tr.r ?? -9) - (a.tr.r ?? -9));
  console.log(`\n--- TOP 12 kombinací podle TRÉNINKU (a jejich TEST — ten rozhoduje) ---`);
  for (const r of results.slice(0, 12)) console.log(`${r.label.slice(0, 100)}\n    TRÉNINK ${pr(r.tr)} | TEST ${pr(r.te)}`);
  const byTest = [...results].filter((r) => r.tr.r !== null && r.tr.r > 0.1).sort((a, b) => (b.te.r ?? -9) - (a.te.r ?? -9));
  console.log(`\n--- TOP 8 podle TESTU mezi kombinacemi s tréninkovou r > 0,10 (pozor: výběr podle testu je optimistický, jen orientačně) ---`);
  for (const r of byTest.slice(0, 8)) console.log(`${r.label.slice(0, 100)}\n    TRÉNINK ${pr(r.tr)} | TEST ${pr(r.te)}`);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const trs = results.map((r) => r.tr.r).filter((x) => x !== null), tes = results.map((r) => r.te.r).filter((x) => x !== null);
  console.log(`\nKontrola přeučení: medián korelace přes všech ${results.length} kombinací: trénink ${f2(med(trs))}, test ${f2(med(tes))}; nejlepší tréninková ${f2(Math.max(...trs))}, test u ní ${f2(results[0].te.r)}.`);

  // ---- 3) VÁHY současných 6 složek: mřížka na tréninku, ověření na testu (a obráceně) ----
  const COMP = ["cur_policy", "cur_realYield", "cur_labor", "cur_growth", "cur_demand", "cur_pmi"];
  const LAB = ["politika", "reál.výnos", "práce", "HDP", "spotřeba", "PMI"];
  const GRID = [0, 0.5, 1, 2, 4];
  const idxW = (o, w) => {
    let sw = 0, sm = 0, n = 0, pos = 0;
    for (let i = 0; i < COMP.length; i++) {
      if (w[i] === 0) continue;
      pos++;
      const v = o.feats[COMP[i]];
      if (v === null || v === undefined) continue;
      sm += w[i] * v; sw += w[i]; n++;
    }
    return n >= Math.min(3, pos) && pos > 0 ? sm / sw : null;
  };
  const objFn = (rows, fn, h = 4) => {
    const byWeek = new Map();
    for (const o of rows) { const v = fn(o); if (v === null || o.y[h] === null) continue; if (!byWeek.has(o.f)) byWeek.set(o.f, []); byWeek.get(o.f).push([v, o.y[h]]); }
    const px = [], py = [], ics = [];
    for (const arr of byWeek.values()) {
      if (arr.length < 3) continue;
      const mv = mean(arr.map((a) => a[0]));
      for (const a of arr) { px.push(a[0] - mv); py.push(a[1]); }
      if (arr.length >= 5) { const ic = pearson(ranks(arr.map((a) => a[0])), ranks(arr.map((a) => a[1]))); if (ic !== null) ics.push(ic); }
    }
    const r = pearson(px, py);
    return { r, n: px.length, t: tStat(r, px.length, h), ic: ics.length ? mean(ics) : null };
  };
  const wl = (w) => w.map((x, i) => `${LAB[i]} ${x}`).join(" · ");
  const grid = [];
  const w = new Array(6).fill(0);
  const rec = (i) => {
    if (i === 6) { if (w.some((x) => x > 0)) grid.push([...w]); return; }
    for (const g of GRID) { w[i] = g; rec(i + 1); }
  };
  rec(0);
  const SPLITS = [
    { name: "trénink 2023–2024 → test 2025–2026", tr: obs.filter((o) => o.f < SPLIT), te: obs.filter((o) => o.f >= SPLIT) },
    { name: "OBRÁCENĚ: trénink 2025–2026 → test 2023–2024", tr: obs.filter((o) => o.f >= SPLIT), te: obs.filter((o) => o.f < SPLIT) },
  ];
  console.log(`\n=== 3) VÁHY šesti současných složek (mřížka ${GRID.join("/")}, ${grid.length} kombinací vah) ===`);
  const named = [
    ["PRODUKCE (1 / 1,5 / 1,5 / 0,5 / 1 / 1)", [1, 1.5, 1.5, 0.5, 1, 1]],
    ["rovné váhy", [1, 1, 1, 1, 1, 1]],
    ["jen trh práce", [0, 0, 1, 0, 0, 0]],
    ["trh práce 2 + reálný výnos 1", [0, 1, 2, 0, 0, 0]],
    ["práce 4, reál.výnos 1,5, ostatní 0,5", [0.5, 1.5, 4, 0.5, 0.5, 0.5]],
    ["práce 4, ostatní 1", [1, 1, 4, 1, 1, 1]],
  ];
  const fmtO = (o) => `r=${f2(o.r)} (t ${f2(o.t, 1)}) IC=${f2(o.ic)}`;
  for (const sp of SPLITS) {
    console.log(`\n--- ${sp.name} (trénink ${sp.tr.length}, test ${sp.te.length} poz.) ---`);
    for (const [nm, ww] of named) console.log(`${nm.padEnd(42)} TRÉNINK ${fmtO(objFn(sp.tr, (o) => idxW(o, ww)))} | TEST ${fmtO(objFn(sp.te, (o) => idxW(o, ww)))}`);
    const scored = grid.map((ww) => ({ ww, tr: objFn(sp.tr, (o) => idxW(o, ww)) })).filter((x) => x.tr.r !== null && x.tr.n >= 0.6 * sp.tr.filter((o) => o.y[4] !== null).length);
    scored.sort((a, b) => b.tr.r - a.tr.r);
    console.log(`Nejlepších 8 vah podle tréninku (a jejich TEST):`);
    for (const x of scored.slice(0, 8)) console.log(`  ${wl(x.ww).padEnd(70)} TRÉNINK ${fmtO(x.tr)} | TEST ${fmtO(objFn(sp.te, (o) => idxW(o, x.ww)))}`);
    // zploštění: průměr normalizovaných vah top 20 (méně náchylné k šumu jedné kombinace)
    const top20 = scored.slice(0, 20).map((x) => { const sum = x.ww.reduce((a, b) => a + b, 0); return x.ww.map((v) => v / sum); });
    const avgW = COMP.map((_, i) => mean(top20.map((t) => t[i])) * 6);
    console.log(`Průměr top 20 (zploštěné váhy): ${wl(avgW.map((v) => Math.round(v * 100) / 100))}  → TRÉNINK ${fmtO(objFn(sp.tr, (o) => idxW(o, avgW)))} | TEST ${fmtO(objFn(sp.te, (o) => idxW(o, avgW)))}`);
    const trs = scored.map((x) => x.tr.r), tes = scored.map((x) => objFn(sp.te, (o) => idxW(o, x.ww)).r).filter((v) => v !== null);
    const med = (a) => { const q = [...a].sort((u, v) => u - v); return q[Math.floor(q.length / 2)]; };
    console.log(`Medián přes ${scored.length} vah: trénink ${f2(med(trs))}, test ${f2(med(tes))}; podíl vah s kladným testem: ${(100 * tes.filter((v) => v > 0).length / tes.length).toFixed(0)} %`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
