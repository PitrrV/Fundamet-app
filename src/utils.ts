import type { Importance, Verdict } from "./types";

// Konvikce je míra SHODY nezávislých signálů, ne směr — vysoká je tedy dobrá zpráva.
// Původní mapování dávalo VYSOKÉ konvikci červenou, což se četlo jako varování; přehozeno
// na mátovou/jantarovou podle síly.
export function convictionColor(label: string): string {
  if (label.startsWith("VYSOKÁ")) return "text-pos";
  if (label.startsWith("STŘEDNÍ")) return "text-warn";
  return "text-muted";
}

export function verdictColor(v: Verdict): string {
  switch (v) {
    case "Souhlasí":
      return "text-pos";
    case "Nesouhlasí":
      return "text-neg";
    default:
      return "text-muted";
  }
}

export function importanceBadgeClasses(imp: Importance): string {
  switch (imp) {
    case "VYSOKÁ":
      return "border-neg/40 text-neg bg-neg/10";
    case "STŘEDNÍ":
      return "border-line2 text-muted bg-surface3";
    default:
      return "border-line text-faint bg-transparent";
  }
}
