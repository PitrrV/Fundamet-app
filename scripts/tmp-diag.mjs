import { createClient } from "@supabase/supabase-js";

// Service key = plný přístup, obchází RLS/granty — zjistíme skutečný stav grantů pro anon roli.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const anon = createClient(process.env.SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

const tables = [
  "latest_confluence_scores",
  "latest_narratives",
  "calendar_events",
  "latest_fundamental_scores",
  "market_regime",
  "cb_policy_state",
];

for (const t of tables) {
  const [svc, anonRes] = await Promise.all([
    supabase.from(t).select("*").limit(1),
    anon.from(t).select("*").limit(1),
  ]);
  console.log(
    `${t}: service=${svc.error ? "ERR:" + svc.error.message : "OK(" + (svc.data?.length ?? 0) + ")"} | anon=${
      anonRes.error ? "ERR:" + anonRes.error.message : "OK(" + (anonRes.data?.length ?? 0) + ")"
    }`
  );
}

console.log("\nAnon key použitý v testu (prvních/posledních 8 znaků):",
  process.env.VITE_SUPABASE_ANON_KEY?.slice(0, 8) + "..." + process.env.VITE_SUPABASE_ANON_KEY?.slice(-8),
  "délka:", process.env.VITE_SUPABASE_ANON_KEY?.length);

// Porovnat se skutečně nasazeným klíčem v GitHub Pages buildu — jestli se secret liší od
// toho, co je reálně v běžícím JS bundlu, testujeme jiný klíč, než jaký appka doopravdy má.
try {
  const pagesUrl = "https://pitrrv.github.io/Fundamet-app/";
  const html = await (await fetch(pagesUrl)).text();
  const scriptMatch = html.match(/src="([^"]+\.js)"/);
  console.log("\nGitHub Pages HTML fetch OK, script tag:", scriptMatch?.[1]);
  if (scriptMatch) {
    const scriptUrl = new URL(scriptMatch[1], pagesUrl).toString();
    const js = await (await fetch(scriptUrl)).text();
    const jwtMatches = [...js.matchAll(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g)].map((m) => m[0]);
    console.log("Nalezené JWT-like řetězce v bundlu:", jwtMatches.length);
    for (const jwt of jwtMatches.slice(0, 3)) {
      console.log("  ", jwt.slice(0, 8) + "..." + jwt.slice(-8), "délka:", jwt.length,
        "shoduje se s GH secret VITE_SUPABASE_ANON_KEY:", jwt === process.env.VITE_SUPABASE_ANON_KEY);
    }
  }
} catch (e) {
  console.log("\nGitHub Pages fetch selhal:", e.message);
}
