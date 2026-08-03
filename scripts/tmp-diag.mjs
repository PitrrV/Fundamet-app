// DOČASNÝ diagnostický skript — smazat po použití. Finální ověření po minItems fixu.
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data } = await supabase.from("latest_narratives").select("scenarios").eq("currency_code", "NZD").single();
console.log("pocet scenarios:", data?.scenarios?.length);
console.log("scenarios:", JSON.stringify(data?.scenarios?.map((s) => ({ event: s.event, date: s.date })), null, 2));
