// DOČASNÝ diagnostický skript — smazat po použití.
// Ověřuje nahlášenou chybu: NZD narrativ tvrdí, že COT pozicování "se zhoršilo z -4.8 na -4.6".
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CURRENCIES = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "USD"];

for (const code of CURRENCIES) {
  const { data: snaps } = await supabase
    .from("score_snapshots")
    .select("overall_score, fundamental_score_adj, cot_score, retail_score, risk_adj, recorded_at")
    .eq("currency_code", code)
    .order("recorded_at", { ascending: false })
    .limit(2);

  const { data: narr } = await supabase.from("latest_narratives").select("narrative, thesis_change_note").eq("currency_code", code).single();

  console.log(`\n=== ${code} ===`);
  console.log("posledni 2 snapshoty (desc):", JSON.stringify(snaps));
  console.log("thesis_change_note:", narr?.thesis_change_note);
}
