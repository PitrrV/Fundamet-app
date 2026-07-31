import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: mr } = await supabase.from("market_regime").select("*").limit(1);
console.log("=== market_regime (uložené v appce) ===");
console.log(JSON.stringify(mr?.[0], null, 2));

const res = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS", {
  headers: { "User-Agent": "Mozilla/5.0" },
});
const text = await res.text();
const lines = text.trim().split("\n").slice(-8);
console.log("\n=== posledních 8 řádků přímo z FRED VIXCLS ===");
console.log(lines.join("\n"));

console.log("\n=== aktuální čas (UTC) ===");
console.log(new Date().toISOString());
