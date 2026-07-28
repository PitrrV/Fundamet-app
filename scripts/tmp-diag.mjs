import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { count } = await supabase.from("calendar_events").select("*", { count: "exact", head: true });
console.log(`Celkem řádků v calendar_events: ${count}`);

const { data } = await supabase
  .from("calendar_events")
  .select("id, currency_code");
console.log(`Počet řádků vrácených neomezeným .select() (bez .range()): ${data?.length}`);

const byCurrency = {};
for (const row of data ?? []) byCurrency[row.currency_code] = (byCurrency[row.currency_code] ?? 0) + 1;
console.log("Rozložení podle měny v tomhle (možná oříznutém) výsledku:", JSON.stringify(byCurrency));
