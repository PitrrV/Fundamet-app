import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { error: ledgerErr } = await supabase.from("thesis_ledger").delete().neq("id", -1);
if (ledgerErr) {
  console.error("Chyba mazání thesis_ledger:", ledgerErr.message);
  process.exit(1);
}
const { error: thesisErr } = await supabase.from("currency_thesis").delete().neq("id", -1);
if (thesisErr) {
  console.error("Chyba mazání currency_thesis:", thesisErr.message);
  process.exit(1);
}
console.log("Reset hotov — currency_thesis i thesis_ledger vyprázdněny (testovací data před opravou bugu).");
