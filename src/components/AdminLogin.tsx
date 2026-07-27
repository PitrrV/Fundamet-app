import { useEffect, useState, type FormEvent } from "react";
import { sendLoginCode, verifyLoginCode } from "../lib/auth";

// Přihlášení je v samostatném panelu, ne přímo v hlavičce. Dvoukrokový formulář (e-mail →
// kód) se do 56px vysokého sticky pruhu na mobilu nevejde tak, aby se dal pohodlně ovládat.
export function AdminLogin() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setStep("email");
    setCode("");
    setError(null);
    setInfo(null);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleSendCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await sendLoginCode(email);
      setStep("code");
      setInfo(`Kód jsme poslali na ${email.trim().toLowerCase()}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nepodařilo se odeslat kód.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await verifyLoginCode(email, code);
      // Session zachytí onAuthStateChange v App.tsx a komponenta se odmountuje sama.
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kód se nepodařilo ověřit.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] text-muted border border-line rounded px-2.5 py-1.5 hover:text-ink hover:border-line2 transition-colors"
      >
        Admin
      </button>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={close} aria-hidden />

      <div className="fixed z-50 top-16 left-4 right-4 sm:left-auto sm:right-6 sm:w-80 bg-surface2 border border-line2 rounded-xl p-4 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">Přihlášení admina</h2>
          <button onClick={close} className="text-faint hover:text-ink text-lg leading-none px-1" aria-label="Zavřít">
            ×
          </button>
        </div>

        {step === "email" ? (
          <form onSubmit={handleSendCode} className="space-y-3">
            <label className="block">
              <span className="text-[11px] text-faint">E-mail</span>
              {/* text-base (16px) je záměr — při menším písmu iOS po fokusu zvětší celou stránku. */}
              <input
                type="email"
                required
                autoFocus
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vas@email.cz"
                className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2.5 text-base text-ink placeholder:text-faint focus:border-accent focus:outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-accent/15 text-accent border border-accent/40 rounded-lg px-3 py-2.5 text-sm font-semibold hover:bg-accent/25 disabled:opacity-50 transition-colors"
            >
              {busy ? "Odesílám…" : "Poslat kód"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-3">
            <label className="block">
              <span className="text-[11px] text-faint">Šestimístný kód z e-mailu</span>
              {/* autoComplete="one-time-code" — iOS i Android kód nabídnou k vyplnění samy. */}
              <input
                type="text"
                required
                autoFocus
                inputMode="numeric"
                pattern="[0-9 ]*"
                maxLength={7}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2.5 text-xl font-mono tracking-[0.3em] text-center text-ink placeholder:text-faint/50 focus:border-accent focus:outline-none"
              />
            </label>
            <button
              type="submit"
              disabled={busy || code.replace(/\s+/g, "").length < 6}
              className="w-full bg-accent/15 text-accent border border-accent/40 rounded-lg px-3 py-2.5 text-sm font-semibold hover:bg-accent/25 disabled:opacity-40 transition-colors"
            >
              {busy ? "Ověřuji…" : "Přihlásit se"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
                setInfo(null);
              }}
              className="w-full text-[11px] text-faint hover:text-muted py-1"
            >
              Zadat jiný e-mail nebo poslat kód znovu
            </button>
          </form>
        )}

        {info && !error && <p className="text-[11px] text-muted mt-3 leading-relaxed">{info}</p>}
        {error && <p className="text-[11px] text-neg mt-3 leading-relaxed">{error}</p>}
      </div>
    </>
  );
}
