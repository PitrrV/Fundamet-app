// DOČASNÝ diagnostický skript — smazat po použití. Proč zbylo 7 párů po úklidu?
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const pairs = [
  ["GBP", "Nationwide HPI m/m"],
  ["USD", "FOMC Member Bowman Speaks"],
  ["USD", "Fed Chairman Warsh Testifies"],
  ["CNY", "Foreign Direct Investment ytd/y"],
  ["EUR", "German Buba Monthly Report"],
  ["GBP", "30-y Bond Auction"],
];

for (const [code, title] of pairs) {
  const { data } = await supabase
    .from("calendar_events")
    .select("id, event_day, event_time, actual")
    .eq("currency_code", code)
    .eq("event_title", title)
    .order("event_day", { ascending: true });
  console.log(`${code} | ${title}:`, JSON.stringify(data));
}
