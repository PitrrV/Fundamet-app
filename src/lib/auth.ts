import { supabase } from "./supabaseClient";

// Jediný účet, co smí editovat "actual" — vynucené i na úrovni databáze (RLS
// v supabase/schema-admin-edit.sql), tohle je jen pro rozhodnutí, co ukázat v UI.
export const ADMIN_EMAIL = "p.vospalek@gmail.com";

// Přihlášení jde přes šestimístný kód, ne přes odkaz v e-mailu. Důvod je praktický: odkaz se
// na mobilu ukazoval jako neklikatelný text a i kdyby klikatelný byl, otevřel by se ve
// vestavěném prohlížeči e-mailového klienta. Kód opsaný do appky tuhle třídu problémů celou
// obchází — přihlašuje se přesně ten prohlížeč, ve kterém uživatel stojí.
//
// `emailRedirectTo` tu zůstává schválně: pokud šablona v Supabase posílá i odkaz, na desktopu
// dál funguje. Kód a odkaz se nevylučují, jsou to dvě cesty ke stejnému ověření.
export async function sendLoginCode(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function verifyLoginCode(email: string, code: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    // Mezery uživatel nasype snadno (kopírování z e-mailu), server je netoleruje.
    token: code.replace(/\s+/g, ""),
    type: "email",
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
