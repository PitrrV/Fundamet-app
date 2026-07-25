import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase.from("weekly_top_opportunity").select("*");
console.log("=== weekly_top_opportunity ===");
console.log(JSON.stringify(data, null, 2));
if (error) console.error("ERR", error.message);
