// DOČASNÝ diagnostický skript — smazat po použití. Proč je NZD thesis_change_note null?
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: snaps, error } = await supabase
  .from("score_snapshots")
  .select("*")
  .eq("currency_code", "NZD")
  .order("recorded_at", { ascending: false })
  .limit(5);

console.log("chyba:", error?.message);
console.log("snapshoty:", JSON.stringify(snaps, null, 2));

const { data: narr } = await supabase.from("latest_narratives").select("*").eq("currency_code", "NZD").single();
console.log("cely narrative radek:", JSON.stringify(narr, null, 2));
