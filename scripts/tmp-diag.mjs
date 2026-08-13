import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, generated_at, score_snapshot");

if (error) {
  console.error("chyba:", error.message);
  process.exit(1);
}

const { data: live } = await supabase.from("latest_confluence_scores").select("currency_code, overall_score");
const { data: liveFund } = await supabase.from("latest_fundamental_scores").select("currency_code, fundamental_score");

const liveByCode = new Map((live ?? []).map((r) => [r.currency_code, r.overall_score]));
const fundByCode = new Map((liveFund ?? []).map((r) => [r.currency_code, r.fundamental_score]));

for (const n of data ?? []) {
  const textOverall = n.score_snapshot?.overall_score;
  const textFund = n.score_snapshot?.fundamental_score;
  const liveOverall = liveByCode.get(n.currency_code);
  const liveFundVal = fundByCode.get(n.currency_code);
  const overallDrift = Math.abs(Number(textOverall) - Number(liveOverall));
  const fundDrift = Math.abs(Number(textFund) - Number(liveFundVal));
  const flag = overallDrift > 0.05 || fundDrift > 0.05 ? " <<< DRIFT" : "";
  console.log(`${n.currency_code}: text_overall=${textOverall} živé=${liveOverall} | text_fund=${textFund} živé=${liveFundVal} | generated_at=${n.generated_at}${flag}`);
}
