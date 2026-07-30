import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: narr } = await supabase
  .from("narratives")
  .select("generated_at, narrative, forward_flag, thesis_change_note")
  .eq("currency_code", "GBP")
  .order("generated_at", { ascending: false })
  .limit(1);

console.log("=== nejnovější narrativ GBP ===");
console.log(JSON.stringify(narr?.[0], null, 2));
