// DOČASNÝ diagnostický skript — smazat po použití.
// Ověří, že revoke select ... from anon skutečně zabírá — zkusí číst přes ANON klíč (ne
// service_role), stejně jako to dělá frontend appky bez přihlášení.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const tables = ["currencies", "latest_confluence_scores", "narratives", "cb_policy_state", "thesis_ledger_feed"];

for (const t of tables) {
  const { data, error } = await supabase.from(t).select("*").limit(1);
  if (error) {
    console.log(`${t}: ZABLOKOVÁNO (${error.code ?? "?"}) — ${error.message}`);
  } else {
    console.log(`${t}: STÁLE ČITELNÉ ANONYMNĚ — ${data.length} řádků vráceno! Toto je problém.`);
  }
}
