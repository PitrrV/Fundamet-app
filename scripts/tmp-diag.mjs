// DOČASNÝ finální ověřovací skript — READ ONLY. Potvrzuje, že nová narrace pro NZD nemá
// audio_url a že obsah je konzistentní s novým (mírnějším) fundamentálním skóre.
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data } = await supabase
  .from("latest_narratives")
  .select("currency_code, narrative, model, audio_url, generated_at")
  .eq("currency_code", "NZD");

for (const row of data ?? []) {
  console.log(`model: ${row.model}`);
  console.log(`audio_url: ${row.audio_url === null ? "null (spravne)" : row.audio_url}`);
  console.log(`generated_at: ${row.generated_at}`);
  console.log(`narrative: ${row.narrative}`);
}

const { data: score } = await supabase
  .from("latest_confluence_scores")
  .select("overall_score, cot_score")
  .eq("currency_code", "NZD");
const { data: fund } = await supabase
  .from("latest_fundamental_scores")
  .select("fundamental_score, confidence")
  .eq("currency_code", "NZD");
console.log("\nNZD confluence:", JSON.stringify(score));
console.log("NZD fundamental:", JSON.stringify(fund));
