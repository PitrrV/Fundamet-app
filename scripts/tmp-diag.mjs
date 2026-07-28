import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const todayStart = new Date();
todayStart.setUTCHours(0, 0, 0, 0);

const { data: ledger } = await supabase
  .from("thesis_ledger_feed")
  .select("*")
  .eq("currency_code", "EUR")
  .gte("occurred_at", todayStart.toISOString())
  .order("occurred_at", { ascending: false });
console.log("=== EUR thesis_ledger dnes ===");
console.log(JSON.stringify(ledger, null, 2));

const { data: narr } = await supabase
  .from("narratives")
  .select("id, generated_at, forward_flag, input_fingerprint")
  .eq("currency_code", "EUR")
  .gte("generated_at", todayStart.toISOString())
  .order("generated_at", { ascending: true });
console.log("=== EUR narratives dnes (kolikrát se přegenerovalo) ===");
console.log(JSON.stringify(narr, null, 2));

const { data: score } = await supabase
  .from("latest_confluence_scores")
  .select("currency_code, overall_score, conviction_stars, conviction_reasons")
  .eq("currency_code", "EUR");
console.log("=== EUR aktuální overall_score (jediná hodnota, historie se nedrží) ===");
console.log(JSON.stringify(score, null, 2));
