import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase.from("latest_narratives").select("currency_code, audio_url").order("currency_code");
if (error) {
  console.error("Chyba:", error.message);
  process.exit(1);
}

for (const row of data ?? []) {
  console.log(`${row.currency_code}: ${row.audio_url}`);
}

const first = data?.find((r) => r.audio_url);
if (first) {
  const res = await fetch(first.audio_url);
  console.log(`\nTest fetch ${first.currency_code}: HTTP ${res.status}, content-type=${res.headers.get("content-type")}, content-length=${res.headers.get("content-length")}`);
}
