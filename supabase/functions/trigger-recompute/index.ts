// Spustí okamžitý přepočet (fetch-calendar.yml, force_narrative=true) po ruční editaci
// "actual" v appce (EditActualField.tsx) — bez tohohle by se skóre/shrnutí přepočítaly
// až při nejbližším 15minutovém cronu a shrnutí příběhu by se nepřegenerovalo vůbec,
// protože scraper sám o sobě ruční zásah nevidí jako "nový actual" (v DB už existuje).
//
// GITHUB_ACTIONS_TOKEN (fine-grained PAT, jen tenhle repo, jen "Actions: read and write")
// je Supabase secret — do prohlížeče se nikdy nedostane, appka volá jen tuhle funkci.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_EMAIL = "p.vospalek@gmail.com"; // stejná hodnota jako v supabase/schema-admin-edit.sql RLS policy
const REPO_OWNER = "PitrrV";
const REPO_NAME = "Fundamet-app";
const REPO_REF = "claude/fundament-app-setup-ehe8g0";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "chybí Authorization" }), { status: 401 });
  }

  // Ověření JWT + zjištění e-mailu jde přes Supabase klienta s předaným Authorization
  // headerem (ne ruční dekódování JWT) — server si token ověří proti Supabase Auth sám.
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user || (user.email ?? "").toLowerCase() !== ADMIN_EMAIL) {
    return new Response(JSON.stringify({ error: "nepovoleno" }), { status: 403 });
  }

  const githubToken = Deno.env.get("GITHUB_ACTIONS_TOKEN");
  if (!githubToken) {
    return new Response(JSON.stringify({ error: "GITHUB_ACTIONS_TOKEN není nastavený" }), { status: 500 });
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/fetch-calendar.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REPO_REF, inputs: { force_narrative: true } }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({ error: `GitHub API ${res.status}: ${text}` }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
