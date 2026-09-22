// Phase 4 — pre/post-deploy regresní gate. Ověřuje, že Shadow Fundamental Engine (zcela
// oddělený proces) nezměnil ANI JEDNU produkční hodnotu. Nezapisuje nic, jen čte a porovnává.
//
// Použití:
//   node scripts/regression-check.mjs snapshot before.json
//   ... (spustit scripts/run-shadow-engine.mjs) ...
//   node scripts/regression-check.mjs compare before.json

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SCORED_CURRENCIES = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];

export async function captureProductionSnapshot() {
  const snapshot = {};

  const { data: confluence } = await supabase
    .from("confluence_scores")
    .select("currency_code, report_date, overall_score, cot_score, cot_flow, retail_score, conviction_stars, freshness_cot")
    .in("currency_code", SCORED_CURRENCIES);
  snapshot.confluence_scores = confluence;

  const { data: thesis } = await supabase
    .from("currency_thesis")
    .select("currency_code, direction, conviction, status, thesis_summary, confirm_streak, challenge_streak")
    .in("currency_code", SCORED_CURRENCIES)
    .eq("status", "active");
  snapshot.currency_thesis = thesis;

  const { data: cbPolicy } = await supabase
    .from("cb_policy_state")
    .select("currency_code, rate, cpi, policy_score, policy_label, real_yield_adj, cb_policy_adj")
    .in("currency_code", SCORED_CURRENCIES);
  snapshot.cb_policy_state = cbPolicy;

  const latestFundamental = {};
  for (const code of SCORED_CURRENCIES) {
    const { data } = await supabase
      .from("fundamental_scores")
      .select("currency_code, raw_score, confidence, fundamental_score, computed_at")
      .eq("currency_code", code)
      .order("computed_at", { ascending: false })
      .limit(1);
    latestFundamental[code] = data?.[0] ?? null;
  }
  snapshot.latest_fundamental_scores = latestFundamental;

  return snapshot;
}

function diffField(label, before, after, diffs) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    diffs.push({ label, before, after });
  }
}

export function compareSnapshots(before, after) {
  const diffs = [];

  const byCurrency = (rows) => Object.fromEntries((rows ?? []).map((r) => [r.currency_code, r]));
  const beforeConf = byCurrency(before.confluence_scores);
  const afterConf = byCurrency(after.confluence_scores);
  for (const code of SCORED_CURRENCIES) {
    diffField(`confluence_scores.${code}`, beforeConf[code], afterConf[code], diffs);
  }

  const beforeThesis = byCurrency(before.currency_thesis);
  const afterThesis = byCurrency(after.currency_thesis);
  for (const code of SCORED_CURRENCIES) {
    diffField(`currency_thesis.${code}`, beforeThesis[code], afterThesis[code], diffs);
  }

  const beforeCb = byCurrency(before.cb_policy_state);
  const afterCb = byCurrency(after.cb_policy_state);
  for (const code of SCORED_CURRENCIES) {
    diffField(`cb_policy_state.${code}`, beforeCb[code], afterCb[code], diffs);
  }

  for (const code of SCORED_CURRENCIES) {
    diffField(`latest_fundamental_scores.${code}`, before.latest_fundamental_scores[code], after.latest_fundamental_scores[code], diffs);
  }

  return diffs;
}

async function main() {
  const [, , mode, path] = process.argv;
  if (mode === "snapshot") {
    const snap = await captureProductionSnapshot();
    writeFileSync(path, JSON.stringify(snap, null, 2));
    console.log(`Snapshot uložen do ${path}.`);
  } else if (mode === "compare") {
    const before = JSON.parse(readFileSync(path, "utf8"));
    const after = await captureProductionSnapshot();
    const diffs = compareSnapshots(before, after);
    if (diffs.length === 0) {
      console.log("REGRESE: ŽÁDNÁ — všechny produkční hodnoty (overall_score, COT, retail, thesis, cb_policy, fundamental_score) jsou identické.");
    } else {
      console.error(`REGRESE NALEZENA — ${diffs.length} rozdíl(ů):`);
      for (const d of diffs) {
        console.error(`  ${d.label}:`);
        console.error(`    před: ${JSON.stringify(d.before)}`);
        console.error(`    po:   ${JSON.stringify(d.after)}`);
      }
      process.exit(1);
    }
  } else {
    console.error("Použití: node scripts/regression-check.mjs snapshot|compare <soubor.json>");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("regression-check: neočekávaná chyba:", err);
    process.exit(1);
  });
}
