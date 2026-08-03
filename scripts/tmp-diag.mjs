// DOČASNÝ diagnostický skript — smazat po použití. Ověření opraveného NZD narrativu.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data } = await supabase.from("latest_narratives").select("thesis_change_note").eq("currency_code", "NZD").single();
console.log("NZD thesis_change_note:", data?.thesis_change_note);
