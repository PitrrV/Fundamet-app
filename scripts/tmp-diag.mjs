// DOČASNÝ diagnostický skript — smazat po použití.
// Proč zmizely Employment Change/Unemployment Rate/Labor Cost Index ze scenarios agendy?
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: nzdEvents } = await supabase
  .from("calendar_events")
  .select("id, event_title, event_day, event_time, actual, estimate")
  .eq("currency_code", "NZD")
  .gte("event_day", "2026-07-25")
  .lte("event_day", "2026-08-10")
  .order("event_day", { ascending: true });
console.log("NZD eventy 25.7-10.8:", JSON.stringify(nzdEvents, null, 2));
