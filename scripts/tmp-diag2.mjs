import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("confluence_scores")
  .select("currency_code, report_date, overall_score, conviction_stars, conviction_reasons")
  .order("conviction_stars", { ascending: false })
  .limit(20);

if (error) {
  console.error("ERR", error.message);
} else {
  console.log("=== top 20 conviction_stars historicky (napříč celou historií confluence_scores) ===");
  console.log(JSON.stringify(data, null, 2));
}

const { data: dist } = await supabase.from("confluence_scores").select("conviction_stars");
const counts = {};
for (const row of dist ?? []) {
  counts[row.conviction_stars] = (counts[row.conviction_stars] ?? 0) + 1;
}
console.log("=== distribuce conviction_stars napříč celou historií ===");
console.log(JSON.stringify(counts, null, 2));
console.log("celkem řádků:", dist?.length ?? 0);
