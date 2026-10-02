import type { CurrencyData, FundamentalState, StateComponent, StateHistoryPoint } from "../types";

// Sdílené pomocníky pro zobrazení stavu měny (karta měny + žebříček).

export function bandClasses(bandKey: FundamentalState["bandKey"]): string {
  switch (bandKey) {
    case "strong":
      return "border-pos/50 text-pos bg-pos/10";
    case "mild_positive":
      return "border-pos/30 text-pos bg-pos/5";
    case "mild_negative":
      return "border-neg/30 text-neg bg-neg/5";
    case "weak":
      return "border-neg/50 text-neg bg-neg/10";
    case "insufficient":
      return "border-warn/40 text-warn bg-warn/10";
    default:
      return "border-line2 text-muted bg-surface2";
  }
}

export function componentSymbol(score: StateComponent["score"]): { text: string; classes: string; title: string } {
  if (score === null) return { text: "n/a", classes: "text-faint border-line", title: "Data nemáme — nic se nedomýšlí" };
  if (score > 0) return { text: "+", classes: "text-pos border-pos/50 bg-pos/10", title: "Podporuje měnu" };
  if (score < 0) return { text: "−", classes: "text-neg border-neg/50 bg-neg/10", title: "Zatěžuje měnu" };
  return { text: "0", classes: "text-muted border-line2 bg-surface2", title: "Neutrální" };
}

function fmtSigned(n: number, digits = 1): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(digits).replace(".", ",")}`;
}

// Týdenní vývoj skóre stavu — prostý SVG řádek, bez knihoven. Nuly jsou osa; mezery (null) se
// nepropojují čárou, aby chybějící týden nevypadal jako reálná hodnota.
function StateSparkline({ history }: { history: StateHistoryPoint[] }) {
  const pts = history.filter((h) => h.score !== null) as (StateHistoryPoint & { score: number })[];
  if (pts.length < 3) {
    return <p className="text-[11px] text-faint">Historie stavu se teprve plní — zatím příliš málo týdnů.</p>;
  }
  const W = 280;
  const H = 56;
  const pad = 4;
  const x = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(1, history.length - 1);
  const y = (v: number) => pad + ((5 - v) / 10) * (H - 2 * pad);
  let d = "";
  let pen = false;
  history.forEach((h, i) => {
    if (h.score === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(h.score).toFixed(1)} `;
    pen = true;
  });
  const last = pts[pts.length - 1];
  const first = pts[0];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-14" role="img" aria-label="Týdenní vývoj fundamentálního stavu">
        <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} className="stroke-line2" strokeWidth="1" strokeDasharray="3 3" />
        <path d={d} fill="none" className="stroke-accent" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(history.indexOf(last))} cy={y(last.score)} r="2.5" className="fill-accent" />
      </svg>
      <div className="flex justify-between text-[10px] text-faint font-mono mt-0.5">
        <span>
          {first.weekEnd} · {fmtSigned(first.score)}
        </span>
        <span>
          {last.weekEnd} · {fmtSigned(last.score)}
        </span>
      </div>
    </div>
  );
}

export function FundamentalStateCard({ currency }: { currency: CurrencyData }) {
  const st = currency.fundamentalState;
  if (!st) {
    return <p className="text-sm text-muted">Fundamentální stav pro tuhle měnu ještě nebyl spočítán.</p>;
  }
  const missing = st.components.filter((c) => c.score === null).length;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={`inline-flex items-center px-2.5 py-1 rounded-md border text-[12px] font-semibold ${bandClasses(st.bandKey)}`}>
          {st.bandLabel}
        </span>
        <span className="font-mono text-2xl font-bold text-ink">{st.score === null ? "—" : fmtSigned(st.score)}</span>
        <span className="text-[11px] text-muted">
          pokrytí <span className="font-mono text-ink">{st.availableCount}/{st.totalCount}</span> složek
          {missing > 0 ? ` · ${missing} bez dat` : ""}
        </span>
      </div>

      <ul className="divide-y divide-line border border-line rounded-lg overflow-hidden">
        {st.components.map((c) => {
          const sym = componentSymbol(c.score);
          return (
            <li key={c.key} className="flex items-start gap-3 px-3 py-2.5 bg-surface2/50">
              <span
                title={sym.title}
                className={`mt-0.5 shrink-0 w-8 text-center text-[12px] font-mono font-bold rounded border ${sym.classes}`}
              >
                {sym.text}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] text-ink font-medium">{c.label}</span>
                  <span className="text-[10px] text-faint uppercase tracking-wider shrink-0">
                    váha {c.weight >= 1.5 ? "vysoká" : c.weight >= 1 ? "střední" : "nízká"}
                  </span>
                </div>
                <div className="text-[11px] text-muted leading-snug break-words">{c.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>

      {st.inflation && (
        <p className="text-[12px] text-muted leading-relaxed">
          <span className="text-faint uppercase tracking-wider text-[10px] mr-2">Kontext · inflace</span>
          {st.inflation.value.toFixed(1).replace(".", ",")} % y/y
          {st.inflation.target !== null && st.inflation.gap !== null
            ? ` (cíl banky ${st.inflation.target.toFixed(1).replace(".", ",")} %, ${fmtSigned(st.inflation.gap)} p. b.)`
            : ""}
          . Do skóre nevstupuje — jen ukazuje, jak daleko je cenový tlak od cíle.
        </p>
      )}

      <div className="border-l-2 border-line2 bg-surface2/40 rounded-r-lg px-3 py-2.5">
        <div className="text-[10px] tracking-wider text-faint uppercase mb-1">Překvapení vs. očekávání · mimo skóre</div>
        <p className="text-[12px] text-ink/85 leading-relaxed">
          <span className="font-mono font-semibold">
            {currency.fundamentalScore !== null ? fmtSigned(currency.fundamentalScore) : "—"}
          </span>{" "}
          · {st.surpriseLabel ?? "nemáme"}. Ukazuje, jak se poslední čísla odchýlila od konsensu — tedy co už trh
          zaceňoval. Silný stav a překvapení „v souladu s očekáváním" znamená silnou, ale už zaceněnou měnu, ne slabou.
        </p>
      </div>

      <div>
        <div className="text-[10px] tracking-wider text-faint uppercase mb-1.5">Vývoj stavu po týdnech</div>
        <StateSparkline history={currency.stateHistory} />
      </div>

      <p className="text-[11px] text-faint italic leading-relaxed">
        Stav se skládá z posledních {st.windowMonths} měsíců kalendáře a je čtením fundamentální situace, ne
        předpovědí ceny: ve zpětném testu (2023–2026) odpovídal pořadí měn pozdějšímu pohybu ceny jen slabě a
        v různých letech nestejně.
      </p>
    </div>
  );
}
