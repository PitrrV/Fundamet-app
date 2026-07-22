import { supabase } from "./supabaseClient";

// Jediný účet, co smí editovat "actual" — vynucené i na úrovni databáze (RLS
// v supabase/schema-admin-edit.sql), tohle je jen pro rozhodnutí, co ukázat v UI.
export const ADMIN_EMAIL = "p.vospalek@gmail.com";

export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
