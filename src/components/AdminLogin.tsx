import { useEffect, useState, type FormEvent } from "react";
import { sendLoginCode, verifyLoginCode } from "../lib/auth";

// Přihlášení je v samostatném panelu, ne přímo v hlavičce. Dvoukrokový formulář (e-mail →
// kód) se do 56px vysokého sticky pruhu na mobilu nevejde tak, aby se dal pohodlně ovládat.
//
// Session je perzistentní (supabaseClient.ts, persistSession: true) — po úspěšném ověření
// se appka příště sama přihlásí ze storage, dokud session nevyprší nebo se admin sám neodhlásí.
// Účet v auth.users vzniká automaticky při prvním ověření kódu (signInWithOtp/verifyOtp),
// žádný samostatný "registrační" krok není potřeba.
export function AdminLogin() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"email" | "code" | "done">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setStep("email");
    setEmail("");
    setCode("");
    setError(null);
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
      // Session zachytí onAuthStateChange v App.tsx. Krátká "hotovo" obrazovka místo
      // okamžitého zavření — potvrzení, že se přihlášení skutečně povedlo, ne jen tichý zánik.
      setStep("done");
      setTimeout(close, 900);
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
        className="text-[11px] text-muted border border-line rounded px-2.5 py-1.5 hover:text-ink hover:border-line2 hover:bg-surface2 transition-colors duration-200"
      >
        Admin
      </button>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40 backdrop-blur-[2px]" onClick={close} aria-hidden />

      <div className="fixed z-50 top-16 left-4 right-4 sm:left-auto sm:right-6 sm:w-[380px] bg-surface2 border border-line2 rounded-xl shadow-2xl overflow-hidden">
        <div className="px-5 pt-5 pb-4 border-b border-line">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-ink">Přihlášení administrátora</h2>
            <button onClick={close} className="text-faint hover:text-ink text-lg leading-none px-1" aria-label="Zavřít">
              ×
            </button>
          </div>

          {/* Krokový indikátor — dva segmenty, aktivní/dokončený je accent, budoucí je line2. */}
          <div className="flex items-center gap-2">
            <StepDot label="E-mail" state={step === "email" ? "active" : "done"} />
            <div className={`flex-1 h-px ${step === "email" ? "bg-line2" : "bg-accent/50"}`} />
            <StepDot
              label="Kód"
              state={step === "code" ? "active" : step === "done" ? "done" : "pending"}
            />
            <div className={`flex-1 h-px ${step === "done" ? "bg-accent/50" : "bg-line2"}`} />
            <StepDot label="Hotovo" state={step === "done" ? "active" : "pending"} />
          </div>
        </div>

        <div className="p-5">
          {step === "email" && (
            <form onSubmit={handleSendCode} className="space-y-4">
              <p className="text-[12px] text-faint leading-relaxed">
                Pošleme vám šestimístný ověřovací kód e-mailem. Přihlásí se jen účet{" "}
                <span className="text-muted">p.vospalek@gmail.com</span> — ostatní e-maily kód dostanou, ale
                nezískají admin oprávnění.
              </p>
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
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2.5 text-base text-ink placeholder:text-faint focus:border-accent focus:outline-none transition-colors"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full bg-accent/15 text-accent border border-accent/40 rounded-lg px-3 py-2.5 text-sm font-semibold hover:bg-accent/25 disabled:opacity-50 transition-colors duration-200"
              >
                {busy ? "Odesílám…" : "Poslat ověřovací kód"}
              </button>
            </form>
          )}

          {step === "code" && (
            <form onSubmit={handleVerify} className="space-y-4">
              <div className="border-l-2 border-pos bg-pos/5 rounded-r-lg px-3 py-2.5">
                <p className="text-[12px] text-ink/90 leading-relaxed">
                  Kód jsme poslali na <span className="font-semibold">{email.trim().toLowerCase()}</span>.
                </p>
              </div>
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
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2.5 text-xl font-mono tracking-[0.3em] text-center text-ink placeholder:text-faint/50 focus:border-accent focus:outline-none transition-colors"
                />
              </label>
              <button
                type="submit"
                disabled={busy || code.replace(/\s+/g, "").length < 6}
                className="w-full bg-accent/15 text-accent border border-accent/40 rounded-lg px-3 py-2.5 text-sm font-semibold hover:bg-accent/25 disabled:opacity-40 transition-colors duration-200"
              >
                {busy ? "Ověřuji…" : "Přihlásit se"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                }}
                className="w-full text-[11px] text-faint hover:text-muted py-1"
              >
                Zadat jiný e-mail nebo poslat kód znovu
              </button>
            </form>
          )}

          {step === "done" && (
            <div className="flex flex-col items-center gap-2 py-4">
              <div className="w-9 h-9 rounded-full bg-pos/15 border border-pos/40 flex items-center justify-center text-pos text-lg">
                ✓
              </div>
              <p className="text-sm text-ink font-semibold">Přihlášeno</p>
            </div>
          )}

          {error && <p className="text-[11px] text-neg mt-3 leading-relaxed">{error}</p>}
        </div>
      </div>
    </>
  );
}

function StepDot({ label, state }: { label: string; state: "pending" | "active" | "done" }) {
  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <div
        className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors duration-200 ${
          state === "done"
            ? "bg-accent border-accent text-bg"
            : state === "active"
              ? "border-accent text-accent"
              : "border-line2 text-faint"
        }`}
      >
        {state === "done" ? "✓" : ""}
      </div>
      <span className={`text-[9px] tracking-wide uppercase ${state === "pending" ? "text-faint" : "text-muted"}`}>
        {label}
      </span>
    </div>
  );
}
