import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data } = await supabase
  .from("latest_fundamental_scores")
  .select("currency_code, raw_score, confidence, fundamental_score, history_months")
  .order("currency_code");

console.log("=== latest_fundamental_scores (confidence damping v praxi) ===");
console.log(JSON.stringify(data, null, 2));
