// DOČASNÝ diagnostický skript — smazat po použití. Ověření migrace na gpt-5.6-luna:
// (1) žádné cizí písmo napříč všemi měnami, (2) spot-check obsahu pro kontrolu přesnosti.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FOREIGN_SCRIPT_RANGES = [
  "\\u0370-\\u03FF",
  "\\u0400-\\u04FF\\u0500-\\u052F",
  "\\u0590-\\u05FF",
  "\\u0600-\\u06FF",
  "\\u0900-\\u097F",
  "\\u0E00-\\u0E7F",
  "\\u3040-\\u30FF",
  "\\u3400-\\u4DBF\\u4E00-\\u9FFF",
  "\\uAC00-\\uD7A3",
].join("");
const FOREIGN_SCRIPT_RE = new RegExp(`[${FOREIGN_SCRIPT_RANGES}]`, "u");

function scan(value, path, hits) {
  if (typeof value === "string") {
    if (FOREIGN_SCRIPT_RE.test(value)) hits.push({ path, snippet: value.slice(0, 120) });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${i}]`, hits));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([k, v]) => scan(v, `${path}.${k}`, hits));
  }
}

const { data, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, model, narrative, forward_flag, conviction_note, thesis_change_note, scenarios");

if (error) {
  console.error("Chyba dotazu:", error.message);
  process.exit(1);
}

let totalHits = 0;
for (const row of data ?? []) {
  const hits = [];
  scan(row, row.currency_code, hits);
  totalHits += hits.length;
  if (hits.length > 0) {
    console.log(`CIZÍ PÍSMO [${row.currency_code}]:`);
    for (const h of hits) console.log(`  ${h.path}: ${h.snippet}`);
  }
}
console.log(`\nCelkem měn: ${data?.length ?? 0}, nálezů cizího písma: ${totalHits}`);
console.log(`Model použitý naposledy: ${data?.[0]?.model ?? "?"}`);

console.log("\n--- SPOT-CHECK: NZD ---");
const nzd = data?.find((r) => r.currency_code === "NZD");
if (nzd) {
  console.log("narrative:", nzd.narrative);
  console.log("forward_flag:", nzd.forward_flag);
  console.log("conviction_note:", nzd.conviction_note);
  console.log("thesis_change_note:", nzd.thesis_change_note);
  console.log("scenarios count:", nzd.scenarios?.length);
  for (const s of nzd.scenarios ?? []) {
    console.log(`  [${s.tier}] ${s.date} ${s.event}: why=${s.why_it_matters}`);
  }
}
