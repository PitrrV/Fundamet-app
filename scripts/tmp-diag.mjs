// DOČASNÝ diagnostický skript — smazat po použití.
// Ověření opravy dezinflace/deflace: vytáhne CHF scénář CPI m/m z nejnovějšího narrativu.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, scenarios, narrative")
  .eq("currency_code", "CHF")
  .single();

if (error) {
  console.error("Chyba čtení:", error.message);
  process.exit(1);
}

console.log("Narrative:", data.narrative);
console.log("\nScénáře:");
for (const s of data.scenarios ?? []) {
  console.log(`\n--- ${s.event ?? s.title} (${s.date}) ---`);
  console.log("market_expectation:", s.market_expectation ?? s.marketExpectation);
}
