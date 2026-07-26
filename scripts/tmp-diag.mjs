import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, narrative, conviction_note, scenarios")
  .order("currency_code");

if (error) {
  console.error("ERR", error.message);
  process.exit(1);
}

for (const row of data ?? []) {
  const items = row.scenarios ?? [];
  console.log(`\n########## ${row.currency_code} — ${items.length} položek ##########`);
  console.log(`NARRATIVE:\n${row.narrative}`);
  console.log(`CONVICTION_NOTE:\n${row.conviction_note}`);
  for (const s of items) {
    console.log(`\n--- [${s.tier}/${s.reaction}] ${s.date} ${s.event}`);
    console.log(`  proč:     ${s.why_it_matters}`);
    console.log(`  trh čeká: ${s.market_expectation}`);
    console.log(`  laťka:    ${s.thesis_test}`);
    console.log(`  reakce:   ${s.reaction_note}`);
    console.log(`  výsledek: ${s.outcome ?? "—"}`);
  }
}
