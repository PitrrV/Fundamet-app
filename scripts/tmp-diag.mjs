import { createClient } from "@supabase/supabase-js";

// Krok 1: pošle přihlašovací kód na admin e-mail, přesně stejnou cestou jako AdminLogin.tsx
// (signInWithOtp). Krok 2 (v druhém běhu, po přečtení kódu) ověří kód a otestuje stejné
// dotazy jako fetchCurrencies.ts s reálnou authenticated session.
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

const { error } = await supabase.auth.signInWithOtp({
  email: "p.vospalek@gmail.com",
  options: { emailRedirectTo: "https://pitrrv.github.io/Fundamet-app/" },
});

if (error) {
  console.error("signInWithOtp selhal:", error.message);
  process.exit(1);
}
console.log("Kód odeslán na p.vospalek@gmail.com.");
