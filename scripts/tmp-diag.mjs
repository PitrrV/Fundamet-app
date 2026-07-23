import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: theses, error } = await supabase
  .from("currency_thesis")
  .select("id, currency_code, direction, conviction, drivers, status, confirm_streak, challenge_streak")
  .order("currency_code", { ascending: true });

if (error) {
  console.error("Chyba:", error.message);
  process.exit(1);
}

for (const t of theses) {
  console.log(JSON.stringify(t));
}
