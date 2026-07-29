import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase.from("regime_shift_state").select("*").order("currency_code");
if (error) {
  console.log("REGIME_SHIFT_STATE TABLE ERROR:", JSON.stringify(error));
} else {
  console.log("REGIME_SHIFT_STATE rows:", data.length);
  for (const row of data) {
    console.log(JSON.stringify(row));
  }
}
