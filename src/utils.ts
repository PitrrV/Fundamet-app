import type { Importance, Verdict } from "./types";

export function convictionColor(label: string): string {
  if (label.startsWith("VYSOKÁ")) return "text-red-400";
  if (label.startsWith("STŘEDNÍ")) return "text-emerald-400";
  return "text-muted";
}

export function verdictColor(v: Verdict): string {
  switch (v) {
    case "Souhlasí":
      return "text-emerald-400";
    case "Nesouhlasí":
      return "text-red-400";
    default:
      return "text-gold";
  }
}

export function importanceBadgeClasses(imp: Importance): string {
  switch (imp) {
    case "VYSOKÁ":
      return "border-red-500/50 text-red-300 bg-red-500/10";
    case "STŘEDNÍ":
      return "border-slate-500/50 text-slate-300 bg-slate-500/10";
    default:
      return "border-slate-700 text-muted bg-transparent";
  }
}
