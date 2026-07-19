import { useEffect, useMemo, useState } from "react";
import { CurrencyTabs } from "./components/CurrencyTabs";
import { Gauge } from "./components/Gauge";
import { RichText } from "./components/RichText";
import { convictionColor } from "./utils";
import { fetchCurrencies } from "./lib/fetchCurrencies";
import type { CurrencyData } from "./types";

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
              </div>
            </section>

            <section className="bg-panel border border-panelborder rounded-xl p-6">
              <div className="text-xs tracking-wide text-muted mb-3">SHRNUTÍ PŘÍBĚHU</div>
              <RichText text={currency.summary} className="text-sm leading-relaxed text-slate-300" />

              <div className="grid grid-cols-3 gap-4 mt-5 pt-5 border-t border-panelborder text-xs">
                <div>
                  <div className="text-muted mb-1">COT POZICOVÁNÍ</div>
                  <div className="text-emerald-400 font-mono">{currency.cotPositioning}</div>
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

            <section className="bg-panel border border-panelborder rounded-xl p-8 text-center">
              <div className="text-sm text-muted">
                Kalendář makro událostí — připravujeme (vyžaduje další datový zdroj: ekonomický
                kalendář a sazbová očekávání).
              </div>
            </section>
          </>
        )}

        <footer className="text-center text-xs text-muted pt-6 pb-4">
          COT pozicování je reálné, aktualizované týdně z oficiálních CFTC dat (Traders in Financial
          Futures). Ostatní plánované pilíře analýzy (zaceněnost trhu, ekonomický kalendář, dlouhodobý
          makro bias) zatím nejsou napojené — confluence skóre je proto omezené na COT a nejde o
          investiční doporučení.
        </footer>
      </main>
    </div>
  );
}
