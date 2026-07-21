import { useEffect, useMemo, useState } from "react";
import { CurrencyTabs } from "./components/CurrencyTabs";
import { Gauge } from "./components/Gauge";
import { RichText } from "./components/RichText";
import { convictionColor } from "./utils";
import { fetchCurrencies } from "./lib/fetchCurrencies";
import type { CurrencyData } from "./types";

function impactBadgeClasses(impact: "Low" | "Medium" | "High"): string {
  switch (impact) {
    case "High":
      return "border-red-500/50 text-red-300 bg-red-500/10";
    case "Medium":
      return "border-slate-500/50 text-slate-300 bg-slate-500/10";
    default:
      return "border-slate-700 text-muted bg-transparent";
  }
}

export default function App() {
  const [currencies, setCurrencies] = useState<CurrencyData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currencyCode, setCurrencyCode] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrencies()
      .then((data) => {
        setCurrencies(data);
        setCurrencyCode((prev) => prev ?? data.find((c) => c.code === "EUR")?.code ?? data[0]?.code ?? null);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  const currency = useMemo(
    () => currencies?.find((c) => c.code === currencyCode) ?? null,
    [currencies, currencyCode]
  );

  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-panelborder">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between">
          <h1 className="font-serif text-2xl tracking-wide">
            KON<span className="text-gold">FLUENCE</span>
          </h1>
          <div className="text-[11px] tracking-wide text-muted">
            INFORMAČNÍ NÁSTROJ · NENÍ INVESTIČNÍ DOPORUČENÍ
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        {loadError && (
          <section className="bg-panel border border-red-500/40 rounded-xl p-6 text-sm text-red-300">
            Nepodařilo se načíst data z databáze: {loadError}
          </section>
        )}

        {!loadError && !currencies && (
          <section className="bg-panel border border-panelborder rounded-xl p-8 text-center text-muted text-sm">
            Načítám confluence skóre…
          </section>
        )}

        {currencies && currencies.length === 0 && (
          <section className="bg-panel border border-panelborder rounded-xl p-8 text-center text-muted text-sm">
            Zatím nejsou k dispozici žádná data — ingest job ještě neproběhl.
          </section>
        )}

        {currencies && currencies.length > 0 && currency && (
          <>
            <CurrencyTabs
              currencies={currencies.map((c) => c.code)}
              selected={currency.code}
              onSelect={setCurrencyCode}
            />

            <section className="bg-panel border border-panelborder rounded-xl p-8">
              <div className="text-xs tracking-wide text-muted mb-4">
                CONFLUENCE SKÓRE — {currency.code}
              </div>
              <Gauge score={currency.score} />
              <div className="text-center mt-2">
                <div className="font-mono text-4xl text-gold">
                  {currency.score > 0 ? "+" : ""}
                  {currency.score.toFixed(1)}
                </div>
                <div className={`text-xs tracking-wide mt-1 ${convictionColor(currency.convictionLabel)}`}>
                  {currency.convictionLabel}
                </div>
                {currency.convictionNote && (
                  <div className="text-xs text-muted mt-2 max-w-md mx-auto italic">
                    {currency.convictionNote}
                  </div>
                )}
              </div>
            </section>

            <section className="bg-panel border border-panelborder rounded-xl p-6">
              <div className="text-xs tracking-wide text-muted mb-3">SHRNUTÍ PŘÍBĚHU</div>
              <RichText text={currency.summary} className="text-sm leading-relaxed text-slate-300" />

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t border-panelborder text-xs">
                <div>
                  <div className="text-muted mb-1">COT POZICOVÁNÍ</div>
                  <div className="text-emerald-400 font-mono">{currency.cotPositioning}</div>
                </div>
                <div>
                  <div className="text-muted mb-1">FUNDAMENTÁLNÍ SKÓRE</div>
                  <div className="font-mono text-muted italic">
                    {currency.fundamentalScore !== null
                      ? `${currency.fundamentalScore > 0 ? "+" : ""}${currency.fundamentalScore.toFixed(1)}`
                      : "Zatím nedostupné"}
                  </div>
                </div>
                <div>
                  <div className="text-muted mb-1">ZACENĚNOST</div>
                  <div className="font-mono text-muted italic">
                    {currency.pricedIn ?? "Zatím nedostupné"}
                  </div>
                </div>
                <div>
                  <div className="text-muted mb-1">DLOUHODOBÝ BIAS</div>
                  <div className="font-mono text-muted italic">
                    {currency.longTermBias ?? "Zatím nedostupné"}
                  </div>
                </div>
              </div>
            </section>

            {currency.forwardFlag && (
              <section className="bg-panel border-l-4 border-gold border-t border-r border-b border-panelborder rounded-lg p-5">
                <div className="text-xs tracking-wide text-gold mb-2">NAVAZUJÍCÍ EVENTY — POZOR</div>
                <div className="text-sm leading-relaxed text-slate-300">{currency.forwardFlag}</div>
              </section>
            )}

            <section>
              <h2 className="font-serif text-lg mb-4">Nadcházejících 21 dní</h2>
              {currency.calendarEvents.length === 0 ? (
                <div className="bg-panel border border-panelborder rounded-xl p-8 text-center text-sm text-muted">
                  Zatím žádné naplánované eventy pro tuhle měnu v databázi.
                </div>
              ) : (
                <div className="space-y-3">
                  {currency.calendarEvents.map((event) => (
                    <div
                      key={`${event.date}-${event.title}`}
                      className="bg-panel border border-panelborder rounded-lg p-5 flex items-start justify-between gap-4"
                    >
                      <div>
                        <div className="text-xs text-muted font-mono mb-1">{event.date}</div>
                        <div className="text-slate-100 font-medium mb-1">{event.title}</div>
                        <span
                          className={`inline-block text-[11px] tracking-wide px-2 py-0.5 rounded border ${impactBadgeClasses(
                            event.impact
                          )}`}
                        >
                          {event.impact}
                        </span>
                      </div>
                      <div className="text-right shrink-0 text-xs font-mono">
                        <div className="text-muted mb-0.5">Konsensus / Předchozí</div>
                        <div className="text-slate-200">
                          {event.estimate ?? "–"} / {event.previous ?? "–"}
                        </div>
                        {event.actual && (
                          <div className="text-gold mt-1">Actual: {event.actual}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <footer className="text-center text-xs text-muted pt-6 pb-4">
          COT pozicování (týdně, CFTC) a fundamentální skóre (ekonomický kalendář ForexFactory) jsou
          reálná a průběžně aktualizovaná. Shrnutí příběhu a upozornění na navazující eventy skládá
          jazykový model (OpenAI) na základě těchto dat — jde o syntézu veřejně dostupných informací,
          ne o investiční doporučení. Zaceněnost trhu a sazbová očekávání zatím nejsou napojené.
        </footer>
      </main>
    </div>
  );
}
