import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, narrative, forward_flag, conviction_note")
  .order("currency_code");

if (error) {
  console.error("ERR", error.message);
  process.exit(1);
}

// Cíl: posoudit kvalitu češtiny v KRÁTKÝCH polích ze STEJNÉHO requestu, který vyprodukoval
// rozsypanou agendu. Když jsou tahle čistá, je problém v délce odpovědi, ne ve schopnostech
// modelu — a rozdělení generování na menší kroky ho vyřeší bez dražšího modelu.
for (const row of data ?? []) {
  console.log(`\n########## ${row.currency_code} ##########`);
  console.log(`NARRATIVE (${row.narrative?.length ?? 0} zn.):\n${row.narrative}`);
  console.log(`\nFORWARD_FLAG:\n${row.forward_flag ?? "—"}`);
  console.log(`\nCONVICTION_NOTE:\n${row.conviction_note ?? "—"}`);
}
