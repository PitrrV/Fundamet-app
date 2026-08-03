// DOČASNÝ diagnostický skript — smazat po použití. Finální ověření forward_flag opravy.
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data } = await supabase.from("latest_narratives").select("currency_code, forward_flag").in("currency_code", ["NZD"]);
for (const row of data ?? []) console.log(`${row.currency_code}: ${row.forward_flag}`);
