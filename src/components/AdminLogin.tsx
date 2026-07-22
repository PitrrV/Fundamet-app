import { useState, type FormEvent } from "react";
import { sendMagicLink } from "../lib/auth";

export function AdminLogin() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      await sendMagicLink(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nepodařilo se odeslat přihlašovací odkaz.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return <div className="text-[11px] text-muted">Přihlašovací odkaz odeslán na {email} — zkontroluj e-mail.</div>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
      <input
        type="email"
        required
        placeholder="e-mail pro přihlášení"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="bg-transparent border border-panelborder rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-muted w-40"
      />
      <button
        type="submit"
        disabled={sending}
        className="text-[11px] text-gold border border-gold/40 rounded px-2 py-1 hover:bg-gold/10 disabled:opacity-50 whitespace-nowrap"
      >
        {sending ? "…" : "Přihlásit se"}
      </button>
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </form>
  );
}
