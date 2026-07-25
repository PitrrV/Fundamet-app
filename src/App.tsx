import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { CurrencyTabs } from "./components/CurrencyTabs";
import { Gauge } from "./components/Gauge";
import { RichText } from "./components/RichText";
import { AdminLogin } from "./components/AdminLogin";
import { EditActualField } from "./components/EditActualField";
import { NarrativeAudioButton } from "./components/NarrativeAudioButton";
import { convictionColor } from "./utils";
import { fetchCurrencies, fetchTopOpportunity } from "./lib/fetchCurrencies";
import { supabase } from "./lib/supabaseClient";
import { ADMIN_EMAIL, signOut } from "./lib/auth";
import type { CurrencyData, LedgerEntry, TopOpportunity } from "./types";

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

function retailSentimentLabel(score: number | null): string {
  if (score === null) return "Zatím nedostupné";
  const formatted = `${score > 0 ? "+" : ""}${score.toFixed(1)}`;
  if (score <= -2.5) return `${formatted} — dav nakoupen nahoru (kontrariánsky medvědí)`;
  if (score >= 2.5) return `${formatted} — dav prodává (kontrariánsky býčí)`;
  return `${formatted} — bez extrému`;
}

function riskRegimeLabel(regime: CurrencyData["riskRegime"]): string {
  if (!regime) return "Zatím nedostupné";
  const label = regime.regime === "RISK_ON" ? "RISK-ON" : regime.regime === "RISK_OFF" ? "RISK-OFF" : "NEUTRÁLNÍ";
  return `${label} (VIX ${regime.vix.toFixed(1)}, 5d ${regime.vix5dChange > 0 ? "+" : ""}${regime.vix5dChange.toFixed(1)})`;
}

function convictionStars(stars: number | null): string {
  if (stars === null) return "";
  return "★".repeat(stars) + "☆".repeat(Math.max(0, 5 - stars));
}

function thesisDirectionLabel(direction: string): string {
  return direction === "bullish" ? "Bullish" : direction === "bearish" ? "Bearish" : "Neutrální";
}

function thesisDirectionColor(direction: string): string {
  if (direction === "bullish") return "text-emerald-400";
  if (direction === "bearish") return "text-red-400";
  return "text-muted";
}

function dataQualityBadgeClasses(level: "HIGH" | "MEDIUM" | "LOW"): string {
  if (level === "HIGH") return "border-emerald-500/50 text-emerald-300 bg-emerald-500/10";
  if (level === "MEDIUM") return "border-amber-500/50 text-amber-300 bg-amber-500/10";
  return "border-red-500/50 text-red-300 bg-red-500/10";
}

function topOpportunityTierMeta(tier: "strong" | "soft" | "flat" | null): { label: string; note: string; classes: string } {
  if (tier === "strong") {
    return {
      label: "SILNÝ PŘÍBĚH",
      note: "Obě strany podpořené více nezávislými signály, kvalita dat není nízká.",
      classes: "border-gold/50 text-gold bg-gold/10",
    };
  }
  if (tier === "soft") {
    return {
      label: "NEJVÝRAZNĚJŠÍ DOSTUPNÝ ROZDÍL",
      note: "Konvikce nebo kvalita dat zatím nejsou na plné úrovni — ber jako slabší podnět k prozkoumání.",
      classes: "border-amber-500/50 text-amber-300 bg-amber-500/10",
    };
  }
  return {
    label: "TRH BEZ JASNÉHO PŘÍBĚHU",
    note: "Rozestup mezi nejsilnější a nejslabší měnou je teď malý — tenhle týden nikdo jasně nevyčnívá.",
    classes: "border-panelborder text-muted",
  };
}

function ledgerEntryMeta(entry: LedgerEntry): { label: string; classes: string } {
  switch (entry.classification) {
    case "opened":
      return { label: "NOVÁ TEZE", classes: "border-gold/50 text-gold bg-gold/10" };
    case "confirms":
      return { label: "TEZE POSÍLENA", classes: "border-emerald-500/50 text-emerald-300 bg-emerald-500/10" };
    case "challenges":
      return { label: "TEZE OSLABENA", classes: "border-amber-500/50 text-amber-300 bg-amber-500/10" };
    case "invalidates_driver":
      return { label: "DRIVER INVALIDOVÁN", classes: "border-amber-500/50 text-amber-300 bg-amber-500/10" };
    case "closed":
      return { label: "TEZE UZAVŘENA", classes: "border-red-500/50 text-red-300 bg-red-500/10" };
    default:
      return { label: entry.classification, classes: "border-panelborder text-muted" };
  }
}

function thesisStatusBadge(status: "active" | "watching" | "invalidated"): { label: string; classes: string } {
  if (status === "watching") {
    return { label: "SLEDUJE SE — driver invalidován", classes: "border-amber-500/50 text-amber-300 bg-amber-500/10" };
  }
  if (status === "invalidated") {
    return { label: "ZRUŠENO", classes: "border-red-500/50 text-red-300 bg-red-500/10" };
  }
  return { label: "AKTIVNÍ", classes: "border-emerald-500/50 text-emerald-300 bg-emerald-500/10" };
}

export default function App() {
  const [currencies, setCurrencies] = useState<CurrencyData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currencyCode, setCurrencyCode] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [topOpportunity, setTopOpportunity] = useState<TopOpportunity | null>(null);

  useEffect(() => {
    fetchCurrencies()
      .then((data) => {
        setCurrencies(data);
        setCurrencyCode((prev) => prev ?? data.find((c) => c.code === "EUR")?.code ?? data[0]?.code ?? null);
      })
      .catch((err: Error) => setLoadError(err.message));
    fetchTopOpportunity()
      .then(setTopOpportunity)
      .catch(() => setTopOpportunity(null));
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const isAdmin = session?.user?.email?.toLowerCase() === ADMIN_EMAIL;

  function handleActualSaved(currencyCode: string, eventId: number, newActual: string | null) {
    setCurrencies((prev) =>
      prev?.map((c) =>
        c.code !== currencyCode
          ? c
          : {
              ...c,
              calendarEvents: c.calendarEvents.map((e) => (e.id === eventId ? { ...e, actual: newActual } : e)),
            }
      ) ?? null
    );
  }

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
          <div className="flex items-center gap-4">
            <div className="text-[11px] tracking-wide text-muted">
              INFORMAČNÍ NÁSTROJ · NENÍ INVESTIČNÍ DOPORUČENÍ
            </div>
            {session ? (
              isAdmin ? (
                <div className="flex items-center gap-2 text-[11px] text-muted">
                  <span className="text-gold">admin</span>
                  <button
                    onClick={() => signOut()}
                    className="border border-panelborder rounded px-2 py-1 hover:bg-panelborder/40"
                  >
                    Odhlásit se
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => signOut()}
                  className="text-[11px] text-muted border border-panelborder rounded px-2 py-1 hover:bg-panelborder/40"
                >
                  Odhlásit se
                </button>
              )
            ) : (
              <AdminLogin />
            )}
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

        {topOpportunity && (
          <section className="bg-panel border border-gold/30 rounded-xl p-6">
            <div className="text-xs tracking-wide text-gold mb-3">TOP FUNDAMENTÁLNÍ PŘÍLEŽITOST TÝDNE</div>
            {topOpportunity.insufficientData ? (
              <div className="text-sm text-muted italic">
                Appka zatím nemá spočítané skóre aspoň u dvou měn — jakmile naběhne první přepočet,
                objeví se tu srovnání.
              </div>
            ) : (
              <>
                <div className="flex justify-center mb-3">
                  <span
                    className={`inline-block text-[10px] tracking-wide px-2 py-0.5 rounded border ${
                      topOpportunityTierMeta(topOpportunity.confidenceTier).classes
                    }`}
                  >
                    {topOpportunityTierMeta(topOpportunity.confidenceTier).label}
                  </span>
                </div>
                <div className="flex items-center justify-center gap-3 text-lg font-serif">
                  <span className="text-emerald-400">{topOpportunity.strongestCurrency}</span>
                  <span className="text-muted text-sm">nejsilnější bias</span>
                  <span className="text-muted">·</span>
                  <span className="text-red-400">{topOpportunity.weakestCurrency}</span>
                  <span className="text-muted text-sm">nejslabší bias</span>
                </div>
                <div className="text-[11px] text-muted italic text-center mt-2">
                  {topOpportunityTierMeta(topOpportunity.confidenceTier).note}
                </div>
                {topOpportunity.rationale && (
                  <div className="text-xs text-slate-300 mt-3 max-w-xl mx-auto text-center">
                    {topOpportunity.rationale}
                  </div>
                )}
                <div className="text-[11px] text-muted italic text-center mt-3 pt-3 border-t border-panelborder">
                  Jen inspirace k dalšímu zkoumání, ne signál ke vstupu — timing, risk management a
                  technickou konfluenci řeší Fx Analyzer, ne tahle appka.
                </div>
              </>
            )}
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
              <div className="flex items-center justify-between mb-4">
                <div className="text-xs tracking-wide text-muted">
                  CONFLUENCE SKÓRE — {currency.code}
                </div>
                {currency.dataQuality && (
                  <span
                    className={`inline-flex items-center gap-1.5 text-[10px] tracking-wide px-2 py-0.5 rounded border ${dataQualityBadgeClasses(
                      currency.dataQuality.level
                    )}`}
                    title={
                      currency.dataQuality.missingCategories.length > 0
                        ? `Chybí: ${currency.dataQuality.missingCategories.join(", ")}`
                        : "Žádná chybějící core data"
                    }
                  >
                    KVALITA DAT: {currency.dataQuality.level} · pokrytí {currency.dataQuality.coveragePct}%
                  </span>
                )}
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
                {currency.convictionStars !== null && (
                  <div className="text-gold text-sm mt-1 tracking-wider">{convictionStars(currency.convictionStars)}</div>
                )}
                {currency.convictionNote && (
                  <div className="text-xs text-muted mt-2 max-w-md mx-auto italic">
                    {currency.convictionNote}
                  </div>
                )}
                {currency.convictionReasons.length > 0 && (
                  <ul className="text-xs text-muted mt-2 max-w-md mx-auto space-y-0.5 text-left mx-auto">
                    {currency.convictionReasons.map((reason) => (
                      <li key={reason}>· {reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {currency.thesis && (
              <section className="bg-panel border border-panelborder rounded-xl p-6">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs tracking-wide text-muted">MAKRO TEZE</div>
                  <span
                    className={`inline-block text-[10px] tracking-wide px-2 py-0.5 rounded border ${
                      thesisStatusBadge(currency.thesis.status).classes
                    }`}
                  >
                    {thesisStatusBadge(currency.thesis.status).label}
                  </span>
                </div>
                <div className={`text-xl font-serif ${thesisDirectionColor(currency.thesis.direction)}`}>
                  {thesisDirectionLabel(currency.thesis.direction)}
                </div>
                <div className="text-gold text-sm mt-1 tracking-wider">
                  {convictionStars(Math.round(currency.thesis.conviction))}
                </div>
                <div className="text-xs text-muted mt-1">
                  otevřeno {new Date(currency.thesis.openedAt).toLocaleDateString("cs-CZ")} · potvrzeno {currency.thesis.confirmStreak}×
                  {currency.thesis.challengeStreak > 0 && `, zpochybněno ${currency.thesis.challengeStreak}×`}
                </div>
                {currency.thesis.thesisSummary && (
                  <div className="text-sm text-slate-300 mt-3">{currency.thesis.thesisSummary}</div>
                )}
                {currency.thesis.drivers.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {currency.thesis.drivers.map((driver) => (
                      <span
                        key={driver.driverKey}
                        className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border ${
                          driver.status === "weakening"
                            ? "border-amber-500/40 text-amber-300 bg-amber-500/5"
                            : "border-emerald-500/40 text-emerald-300 bg-emerald-500/5"
                        }`}
                      >
                        {driver.label}
                        <span className="font-mono text-muted">
                          {driver.value > 0 ? "+" : ""}
                          {driver.value.toFixed(2)}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </section>
            )}

            {currency.ledgerFeed.length > 0 && (
              <section className="bg-panel border border-panelborder rounded-xl p-6">
                <div className="text-xs tracking-wide text-muted mb-4">CO SE ZMĚNILO?</div>
                <div className="space-y-3">
                  {currency.ledgerFeed.map((entry, i) => {
                    const meta = ledgerEntryMeta(entry);
                    return (
                      <div key={`${entry.occurredAt}-${i}`} className="border-l-2 border-panelborder pl-4">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`inline-block text-[10px] tracking-wide px-2 py-0.5 rounded border ${meta.classes}`}
                          >
                            {meta.label}
                          </span>
                          <span className="text-[11px] text-muted font-mono">
                            {new Date(entry.occurredAt).toLocaleDateString("cs-CZ")}
                          </span>
                          {entry.driverKey && <span className="text-[11px] text-muted">· {entry.driverKey}</span>}
                        </div>
                        <div className="text-xs text-slate-300">{entry.reasoning}</div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="bg-panel border border-panelborder rounded-xl p-6">
              <div className="flex items-center gap-2 mb-3">
                <div className="text-xs tracking-wide text-muted">SHRNUTÍ PŘÍBĚHU</div>
                <NarrativeAudioButton audioUrl={currency.summaryAudioUrl} />
              </div>
              <RichText text={currency.summary} className="text-sm leading-relaxed text-slate-300" />

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-5 pt-5 border-t border-panelborder text-xs">
                <div>
                  <div className="text-muted mb-1">COT POZICOVÁNÍ</div>
                  <div className="text-emerald-400 font-mono">
                    {currency.cotPositioning}
                    {currency.cotPercentile !== null && (
                      <span className="text-muted"> · {currency.cotPercentile}. percentil</span>
                    )}
                  </div>
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
                  <div className="text-muted mb-1">RETAIL SENTIMENT</div>
                  <div className="font-mono text-muted italic">{retailSentimentLabel(currency.retailScore)}</div>
                </div>
                <div>
                  <div className="text-muted mb-1">ZACENĚNOST (POSLEDNÍ ROZHODNUTÍ)</div>
                  <div className="font-mono text-muted italic">
                    {currency.pricedIn ?? "Zatím nedostupné"}
                    {currency.cbPolicy && (
                      <span className="text-[10px] text-muted/70 block mt-0.5">
                        metoda: {currency.cbPolicy.pricedIn.method === "yield_gap" ? "2Y výnos vs. sazba (FRED)" : "konsensus rozhodnutí"} ·{" "}
                        {currency.cbPolicy.pricedIn.confidenceLevel}
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-muted mb-1">DLOUHODOBÝ BIAS (CB POLITIKA)</div>
                  <div className="font-mono text-muted italic">
                    {currency.longTermBias ?? "Zatím nedostupné"}
                  </div>
                </div>
                <div>
                  <div className="text-muted mb-1">RISK REŽIM</div>
                  <div className="font-mono text-muted italic">{riskRegimeLabel(currency.riskRegime)}</div>
                </div>
              </div>
            </section>

            {currency.forwardFlag && (
              <section className="bg-panel border-l-4 border-gold border-t border-r border-b border-panelborder rounded-lg p-5">
                <div className="text-xs tracking-wide text-gold mb-2">NAVAZUJÍCÍ EVENTY — POZOR</div>
                <div className="text-sm leading-relaxed text-slate-300">{currency.forwardFlag}</div>
              </section>
            )}

            {currency.scenarios.length > 0 && (
              <section className="bg-panel border border-panelborder rounded-xl p-6">
                <div className="text-xs tracking-wide text-muted mb-4">MOŽNÉ SCÉNÁŘE</div>
                <div className="space-y-4">
                  {currency.scenarios.map((scenario) => (
                    <div key={`${scenario.date}-${scenario.event}`} className="border-l-2 border-panelborder pl-4">
                      <div className="text-sm text-slate-100 font-medium mb-1.5">
                        {scenario.event} <span className="text-muted font-mono text-xs">({scenario.date})</span>
                      </div>
                      <div className="text-xs text-emerald-400/90 mb-1">
                        <span className="text-muted">Pokud PŘEKONÁ odhad:</span> {scenario.ifBeat}
                      </div>
                      <div className="text-xs text-red-400/90">
                        <span className="text-muted">Pokud ZAOSTANE:</span> {scenario.ifMiss}
                      </div>
                      {scenario.outcome && (
                        <div className="text-xs text-slate-300 mt-2 pt-2 border-t border-panelborder/60">
                          <span className="text-gold tracking-wide">VÝSLEDEK:</span> {scenario.outcome}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
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
                        {event.actual && !isAdmin && (
                          <div className="text-gold mt-1">Actual: {event.actual}</div>
                        )}
                        {isAdmin && (
                          <EditActualField
                            eventId={event.id}
                            currentActual={event.actual}
                            onSaved={(newActual) => handleActualSaved(currency.code, event.id, newActual)}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <footer className="text-center text-xs text-muted pt-6 pb-4 space-y-1">
          <p>
            COT pozicování a retail sentiment (týdně, CFTC), fundamentální skóre a CB politika/real
            yield (ekonomický kalendář ForexFactory) a risk režim (VIX, FRED) jsou reálná a průběžně
            aktualizovaná data. "Zaceněnost" je u většiny měn odvozená z konsensu posledního
            rozhodnutí (ne z reálné OIS/futures křivky) — metoda je vždy uvedená u čísla.
          </p>
          <p>
            Shrnutí příběhu, upozornění na navazující eventy a scénářová predikce vznikají jazykovým
            modelem (OpenAI) na základě těchto dat — jde o syntézu veřejně dostupných informací a
            heuristických odhadů, ne o investiční doporučení.
          </p>
          <p className="pt-2 border-t border-panelborder/60">
            Konfluence vysvětluje PROČ — makro kontext, fundamentální bias a jak se v čase mění. Neřeší
            timing vstupu, risk management ani technickou konfluenci na grafu — o to, jestli je
            konkrétní obchod podpořený daty a potvrzený napříč zdroji, se stará samostatný nástroj Fx
            Analyzer.
          </p>
        </footer>
      </main>
    </div>
  );
}
