import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Chybí VITE_SUPABASE_URL nebo VITE_SUPABASE_ANON_KEY — nastavte je v .env.local (lokálně) nebo jako build secrets (CI)."
  );
}

export const supabase = createClient(url, anonKey);
