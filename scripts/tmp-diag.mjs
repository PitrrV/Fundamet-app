// DOČASNÝ diagnostický skript — smazat po použití. Ověření aktuálního forward_flag pro NZD.
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data } = await supabase.from("latest_narratives").select("forward_flag, narrative").eq("currency_code", "NZD").single();
console.log("forward_flag:", data?.forward_flag);
console.log("narrative:", data?.narrative);
