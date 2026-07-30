import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Chybí VITE_SUPABASE_URL nebo VITE_SUPABASE_ANON_KEY — nastavte je v .env.local (lokálně) nebo jako build secrets (CI)."
  );
}

// persistSession/autoRefreshToken/detectSessionInUrl jsou defaultní hodnoty supabase-js,
// ale vypsané natvrdo, aby se náhodou neztratily při budoucí úpravě — na nich stojí "při
// příštím otevření appky se admin nemusí znovu ověřovat", dokud session nevyprší.
// detectSessionInUrl zachytává tokeny z magic-linku (viz emailRedirectTo v lib/auth.ts),
// kdyby ho admin otevřel místo opsání kódu.
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage,
  },
});
