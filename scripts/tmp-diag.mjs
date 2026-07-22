import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, scenarios, generated_at")
  .eq("currency_code", "GBP");

if (error) {
  console.error("Chyba:", error.message);
  process.exit(1);
}

for (const row of data) {
  console.log(JSON.stringify(row, null, 2));
}
