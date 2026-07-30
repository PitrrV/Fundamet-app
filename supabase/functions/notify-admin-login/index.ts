// Bezpečnostní upozornění: appka zavolá tuhle funkci hned po úspěšném ověření kódu
// v AdminLogin.tsx, ať admin ví o každém přihlášení do appky (i kdyby to nebyl on).
// Nekritické, fire-and-forget — pokud e-mail neodejde, přihlášení samotné tím není dotčené.
//
// RESEND_API_KEY je Supabase secret (https://resend.com, free tier stačí) — bez API klíče
// pro odesílání e-mailů. "onboarding@resend.dev" funguje bez ověřené domény, jen může
// občas skončit ve spamu; pro vlastní doménu stačí v Resendu doménu ověřit a change FROM.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_EMAIL = "p.vospalek@gmail.com"; // stejná hodnota jako v src/lib/auth.ts a RLS policy

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "chybí Authorization" }), { status: 401 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return new Response(JSON.stringify({ error: "nepovoleno" }), { status: 403 });
  }

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) {
    // Nekritické — přihlášení samotné proběhlo v pořádku, jen se o něm admin nedozví e-mailem.
    return new Response(JSON.stringify({ ok: false, reason: "RESEND_API_KEY není nastavený" }), { status: 200 });
  }

  const loggedInEmail = (user.email ?? "neznámý e-mail").toLowerCase();
  const isAdminAccount = loggedInEmail === ADMIN_EMAIL;
  const when = new Date().toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Konfluence <onboarding@resend.dev>",
      to: [ADMIN_EMAIL],
      subject: isAdminAccount ? "Nové přihlášení do Konfluence" : "⚠️ Přihlášení do Konfluence jiným e-mailem",
      text: `${isAdminAccount ? "Přihlásil ses" : "Někdo se přihlásil"} do appky Konfluence.\n\nE-mail: ${loggedInEmail}\nČas: ${when}\n\n${
        isAdminAccount
          ? "Pokud jsi to nebyl ty, změň si přístup k e-mailu."
          : "Tenhle účet nemá admin oprávnění (ta má jen p.vospalek@gmail.com), ale někdo prošel ověřovacím krokem přihlášení."
      }`,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({ ok: false, error: `Resend ${res.status}: ${text}` }), { status: 200 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
