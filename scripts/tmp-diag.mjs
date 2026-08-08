// DOČASNÝ diagnostický skript — smazat po použití. Jen čte, nic nezapisuje.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Chybí SUPABASE_URL nebo SUPABASE_SERVICE_KEY v prostředí.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, score_snapshot, generated_at")
  .eq("currency_code", "AUD")
  .limit(1);

console.log("error:", error);
console.log("data:", JSON.stringify(data, null, 2));

const { data: conf } = await supabase
  .from("latest_confluence_scores")
  .select("currency_code, overall_score")
  .eq("currency_code", "AUD");
console.log("live overall_score:", JSON.stringify(conf, null, 2));
