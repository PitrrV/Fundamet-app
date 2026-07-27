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

  async function handleSave() {
    setSaving(true);
    setError(null);
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
  }

  return (
    <div className="flex items-center gap-1 mt-1.5">
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
      {error && <span className="text-[10px] text-neg">{error}</span>}
    </div>
  );
}
