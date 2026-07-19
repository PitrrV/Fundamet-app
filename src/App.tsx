import { useMemo, useState } from "react";
import { CURRENCIES } from "./data";
import { CurrencyTabs } from "./components/CurrencyTabs";
import { Gauge } from "./components/Gauge";
import { EventRow } from "./components/EventRow";
import { EventDetail } from "./components/EventDetail";
import { RichText } from "./components/RichText";
import { convictionColor } from "./utils";

export default function App() {
  const [currencyCode, setCurrencyCode] = useState(CURRENCIES[1].code); // default EUR
  const [selectedEventIdx, setSelectedEventIdx] = useState(2); // default last event, matches mockup

  const currency = useMemo(
    () => CURRENCIES.find((c) => c.code === currencyCode) ?? CURRENCIES[0],
    [currencyCode]
  );

  const selectedEvent =
    currency.events[Math.min(selectedEventIdx, currency.events.length - 1)] ?? currency.events[0];

  function handleSelectCurrency(code: string) {
    setCurrencyCode(code);
    setSelectedEventIdx(0);
  }

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
        <CurrencyTabs
          currencies={CURRENCIES.map((c) => c.code)}
          selected={currency.code}
          onSelect={handleSelectCurrency}
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
              <div className="font-mono">{currency.pricedIn}</div>
            </div>
            <div>
              <div className="text-muted mb-1">DLOUHODOBÝ BIAS</div>
              <div className="text-gold font-mono">{currency.longTermBias}</div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="font-serif text-lg mb-4">Nadcházejících 14 dní</h2>
          <div className="space-y-3">
            {currency.events.map((event, idx) => (
              <EventRow
                key={event.title}
                event={event}
                selected={idx === selectedEventIdx}
                onSelect={() => setSelectedEventIdx(idx)}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="font-serif text-lg mb-4">
            Detail eventu — {selectedEvent.title} ({selectedEvent.date})
          </h2>
          <EventDetail event={selectedEvent} />
        </section>

        <footer className="text-center text-xs text-muted pt-6 pb-4">
          Toto je statický vizuální návrh (mockup) s ukázkovými daty pro účely návrhu produktu. Žádná
          zobrazená čísla nejsou reálná tržní data. Confluence skóre je informační syntéza veřejně
          dostupných dat, nikoli investiční doporučení.
        </footer>
      </main>
    </div>
  );
}
