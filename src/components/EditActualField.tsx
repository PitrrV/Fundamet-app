import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

interface Props {
  eventId: number;
  currentActual: string | null;
  onSaved: (newActual: string | null) => void;
}

// Zápis jde přímo z prohlížeče přes přihlášenou session (ne přes anon klíč) — RLS
// (supabase/schema-admin-edit.sql) na serveru vynucuje, že projde jen z účtu
// administrátora a jen na sloupec actual, i kdyby se tenhle formulář obešel.
export function EditActualField({ eventId, currentActual, onSaved }: Props) {
  const [value, setValue] = useState(currentActual ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recomputeStatus, setRecomputeStatus] = useState<"idle" | "triggering" | "triggered" | "failed">("idle");

  async function handleSave() {
    setSaving(true);
    setError(null);
    setRecomputeStatus("idle");
    const trimmed = value.trim();
    const { error: updErr } = await supabase
      .from("calendar_events")
      .update({ actual: trimmed || null, updated_at: new Date().toISOString() })
      .eq("id", eventId);
    setSaving(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    onSaved(trimmed || null);

    // Bez tohohle by se skóre/shrnutí přepočítaly až při příštím 15minutovém cronu a
    // shrnutí příběhu by se nepřegenerovalo vůbec (scraper ruční zásah nevidí jako "nový
    // actual", protože v DB už existuje) — viz supabase/functions/trigger-recompute.
    // Nekritické: pokud se nepovede spustit, ruční hodnota v calendar_events zůstává uložená
    // a přepočet doběhne nejpozději při dalším pravidelném běhu.
    setRecomputeStatus("triggering");
    const { error: fnErr } = await supabase.functions.invoke("trigger-recompute", { method: "POST" });
    setRecomputeStatus(fnErr ? "failed" : "triggered");
  }

  return (
    <div className="flex flex-col items-end gap-1 mt-1.5">
      <div className="flex items-center gap-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="actual"
          className="w-20 bg-transparent border border-accent/40 rounded px-1.5 py-0.5 text-xs text-accent font-mono placeholder:text-faint"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-[10px] text-accent border border-accent/40 rounded px-1.5 py-0.5 hover:bg-accent/10 disabled:opacity-50"
        >
          {saving ? "…" : "Uložit"}
        </button>
      </div>
      {error && <span className="text-[10px] text-neg">{error}</span>}
      {recomputeStatus === "triggering" && (
        <span className="text-[10px] text-faint">spouštím přepočet skóre a shrnutí…</span>
      )}
      {recomputeStatus === "triggered" && (
        <span className="text-[10px] text-pos">přepočet spuštěn, výsledek bude za pár minut</span>
      )}
      {recomputeStatus === "failed" && (
        <span className="text-[10px] text-warn">uloženo, ale okamžitý přepočet se nespustil — doběhne s cronem</span>
      )}
    </div>
  );
}
