// DOČASNÝ diagnostický skript — smazat po použití. Ověření, jaký model appka SKUTEČNĚ používá
// v produkční tabulce narratives (ne v testu, ne v kódu — přímo v datech).
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from("latest_narratives")
  .select("currency_code, model, generated_at")
  .order("currency_code", { ascending: true });

if (error) {
  console.error("Chyba dotazu:", error.message);
  process.exit(1);
}

console.log("Aktuální model v produkčních datech (latest_narratives):\n");
for (const row of data ?? []) {
  console.log(`  ${row.currency_code}: model=${row.model}  generated_at=${row.generated_at}`);
}

const models = new Set((data ?? []).map((r) => r.model));
console.log(`\nPočet měn: ${data?.length ?? 0}, unikátní modely: ${[...models].join(", ")}`);
