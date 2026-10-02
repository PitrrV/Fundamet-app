import type { CurrencyData } from "../types";
import { bandClasses, componentSymbol } from "./FundamentalStateCard";

// Pořadí všech měn podle fundamentálního stavu. Měny bez dost dat (index null) jdou na konec
// s jasným označením — nezamíchají se do pořadí jako nula.
export function CurrencyRanking({
  currencies,
  selected,
  onSelect,
}: {
  currencies: CurrencyData[];
  selected: string | undefined;
  onSelect: (code: string) => void;
}) {
  const sorted = [...currencies].sort((a, b) => {
    const sa = a.fundamentalState?.score;
    const sb = b.fundamentalState?.score;
    if (sa == null && sb == null) return a.code.localeCompare(b.code);
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sb - sa;
  });

  return (
    <div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
        {sorted.map((c, i) => {
          const st = c.fundamentalState;
          return (
            <li key={c.code}>
              <button
                onClick={() => onSelect(c.code)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-colors duration-200 ${
                  c.code === selected ? "bg-accent/[.14] border-accent/50" : "border-line hover:border-line2 hover:bg-surface2"
                }`}
              >
                <span className="w-4 text-[11px] font-mono text-faint">{st?.score == null ? "–" : i + 1}</span>
                <span className="text-sm font-bold text-ink w-10">{c.code}</span>
                <span className="font-mono text-sm w-12 text-ink">
                  {st?.score == null ? "—" : `${st.score > 0 ? "+" : ""}${st.score.toFixed(1)}`}
                </span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold ${bandClasses(
                    st?.bandKey ?? "insufficient"
                  )}`}
                >
                  {st?.bandLabel ?? "Bez dat"}
                </span>
                <span className="ml-auto flex items-center gap-1" title="Složky: politika · reálný výnos · práce · růst · spotřeba · PMI">
                  {(st?.components ?? []).map((comp) => {
                    const sym = componentSymbol(comp.score);
                    return (
                      <span
                        key={comp.key}
                        title={`${comp.label}: ${sym.title}`}
                        className={`w-1.5 h-1.5 rounded-full ${
                          comp.score === null ? "bg-line" : comp.score > 0 ? "bg-pos" : comp.score < 0 ? "bg-neg" : "bg-muted"
                        }`}
                      />
                    );
                  })}
                  <span className="ml-1 text-[10px] font-mono text-faint">
                    {st ? `${st.availableCount}/${st.totalCount}` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
