// DOČASNÝ diagnostický skript — smazat po použití. Ověření opraveného data v NZD agendě.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data } = await supabase.from("latest_narratives").select("scenarios, forward_flag").eq("currency_code", "NZD").single();
console.log("forward_flag:", data?.forward_flag);
console.log("scenarios:", JSON.stringify(data?.scenarios?.map((s) => ({ event: s.event, date: s.date })), null, 2));
