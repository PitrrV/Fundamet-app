import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { CurrencyTabs } from "./components/CurrencyTabs";
import { Gauge } from "./components/Gauge";
import { ConvictionMeter } from "./components/ConvictionMeter";
import { RichText } from "./components/RichText";
import { AdminLogin } from "./components/AdminLogin";
import { EditActualField } from "./components/EditActualField";
import { convictionColor } from "./utils";
import { fetchCurrencies, fetchTopOpportunity, isAuthError } from "./lib/fetchCurrencies";
import { supabase } from "./lib/supabaseClient";
import { ADMIN_EMAIL, signOut } from "./lib/auth";
import type { AgendaReaction, AgendaTier, CurrencyData, LedgerEntry, TopOpportunity } from "./types";

// ── Sdílené primitivy ───────────────────────────────────────────────────────────────────
// Dřív měla každá sekce vlastní kombinaci paddingu, rámečku a nadpisu, takže všechny působily
// stejně důležitě. Teď jsou tři úrovně vyvýšení a nadpis je jednotný.

function Card({
  children,
  tone = "base",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "base" | "raised" | "quiet";
  className?: string;
}) {
  const tones = {
    base: "bg-surface border-line",
    raised: "bg-surface2 border-line2",
    quiet: "bg-surface/60 border-line/70",
  };
  return <section className={`${tones[tone]} border rounded-xl ${className}`}>{children}</section>;
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">{children}</h2>
      {hint && <p className="text-[11px] text-faint mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
}

function Badge({ children, classes }: { children: React.ReactNode; classes: string }) {
  return (
    <span
      className={`inline-flex items-center text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded border whitespace-nowrap ${classes}`}
    >
      {children}
    </span>
  );
}

// ── Barevná sémantika ───────────────────────────────────────────────────────────────────
// Mátová = potvrzuje/silné, korálová = odporuje/riziko, jantarová = pozor/slábne,
// indigo = interaktivní a značka, fialová = zvláštní případ. Stejný klíč jako v Analyzeru.

function impactBadgeClasses(impact: "Low" | "Medium" | "High"): string {
  if (impact === "High") return "border-neg/40 text-neg bg-neg/10";
  if (impact === "Medium") return "border-line2 text-muted bg-surface3";
  return "border-line text-faint";
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
  return `${label} · VIX ${regime.vix.toFixed(1)} (5d ${regime.vix5dChange > 0 ? "+" : ""}${regime.vix5dChange.toFixed(1)})`;
}

// Jednověté, okamžitě čitelné shrnutí "co to znamená" nad syrová čísla pilíře — deterministicky
// odvozené z už spočtených polí cbPolicy (žádné nové LLM volání, žádné domýšlení).
function pricedInInterpretation(cbPolicy: CurrencyData["cbPolicy"]): string {
  if (!cbPolicy) return "Zaceněnost zatím nelze určit, chybí data o sazbách.";
  const level = cbPolicy.pricedIn.confidenceLevel;
  if (level === "HIGH") return "Trh má další krok centrální banky jasně zaceněný.";
  if (level === "MEDIUM") return "Trh částečně počítá s dalším krokem, prostor pro překvapení zůstává.";
  return "Trh zatím nemá jednoznačné očekávání dalšího kroku.";
}

function longTermBiasInterpretation(cbPolicy: CurrencyData["cbPolicy"]): string {
  if (!cbPolicy || cbPolicy.policyLabel === "nedostatek dat") {
    return "Zatím nedostatek dat pro jasný dlouhodobý směr politiky.";
  }
  if (cbPolicy.policyConfidence === "LOW") {
    return "Signály jsou smíšené, vyčkejte na potvrzení.";
  }
  const label = cbPolicy.policyLabel.toLowerCase();
  if (/hik/.test(label)) return "Centrální banka drží jestřábí kurz, sazby mohou dál růst.";
  if (/cut|řez|snižování/.test(label)) return "Centrální banka směřuje k uvolňování, sazby mohou dál klesat.";
  return "Centrální banka drží sazby beze změny, žádný jasný směr zatím.";
}

// Real yield (sazba - CPI, relativně vůči koši měn) se počítá stejně pro všechny měny
// (computeRealYieldAdj, cb-policy.mjs) — v "AI komentáři" ale text "Real yield: X" ukazuje
// jen conviction reasons, které se přidají výhradně když souhlasí se směrem overall skóre
// (computeConviction, fetch-calendar.mjs). Proto u měn s nesouhlasícím znaménkem appka dřív
// nezobrazovala vůbec nic a nešlo poznat, jestli chybí data nebo se jen nehodí do seznamu
// shody. Tahle dlaždice je nezávislá na tom filtru — ukazuje se vždy, se třemi jasnými stavy.
function realYieldDisplay(cbPolicy: CurrencyData["cbPolicy"]): { value: string; sub: string | null } {
  if (!cbPolicy) {
    return { value: "Data nejsou dostupná", sub: null };
  }
  // cbPolicy.rate === null <=> měna vůbec nebyla zahrnuta do relativního výpočtu
  // (computeRealYieldAdj vrací 0 jako sentinel, ne jako spočtenou hodnotu) — CPI naopak
  // ve vzorci má bezpečný výchozí odhad 2 %, takže jeho absence výpočet neblokuje.
  if (cbPolicy.rate === null) {
    return { value: "Real yield se pro tuto měnu nevyhodnocuje", sub: "chybí zachycená úroková sazba v kalendáři" };
  }
  const adj = cbPolicy.realYieldAdj;
  const cpiPart = cbPolicy.cpi !== null ? `CPI ${cbPolicy.cpi.toFixed(1)} %` : "CPI odhad 2 % (chybí data)";
  return {
    value: `${adj > 0 ? "+" : ""}${adj.toFixed(2)} vůči průměru koše měn`,
    sub: `sazba ${cbPolicy.rate.toFixed(2)} % · ${cpiPart}`,
  };
}

function thesisDirectionLabel(direction: string): string {
  return direction === "bullish" ? "Bullish" : direction === "bearish" ? "Bearish" : "Neutrální";
}

function thesisDirectionColor(direction: string): string {
  if (direction === "bullish") return "text-pos";
  if (direction === "bearish") return "text-neg";
  return "text-muted";
}

function dataQualityBadgeClasses(level: "HIGH" | "MEDIUM" | "LOW"): string {
  if (level === "HIGH") return "border-pos/40 text-pos bg-pos/10";
  if (level === "MEDIUM") return "border-warn/40 text-warn bg-warn/10";
  return "border-neg/40 text-neg bg-neg/10";
}

// Pořadí je zároveň pořadím sekcí v UI — nejdřív to, co může tezí skutečně pohnout.
const AGENDA_TIER_ORDER: AgendaTier[] = ["klíčový", "druhořadý", "kontext"];

function agendaTierMeta(tier: AgendaTier): { heading: string; hint: string; classes: string; rail: string } {
  if (tier === "klíčový") {
    return {
      heading: "KLÍČOVÉ",
      hint: "může tezi překlopit nebo výrazně potvrdit",
      classes: "border-warn/50 text-warn bg-warn/10",
      rail: "border-warn/50",
    };
  }
  if (tier === "druhořadý") {
    return {
      heading: "DRUHOŘADÉ",
      hint: "posune konvikci, samo o sobě tezi nezmění",
      classes: "border-line2 text-muted bg-surface3",
      rail: "border-line2",
    };
  }
  return {
    heading: "KONTEXT",
    hint: "tezí pohne jen při extrémním překvapení",
    classes: "border-line text-faint",
    rail: "border-line",
  };
}

function agendaReactionMeta(reaction: AgendaReaction): { label: string; classes: string } {
  if (reaction === "silná") return { label: "SILNÁ REAKCE", classes: "border-neg/40 text-neg bg-neg/10" };
  if (reaction === "asymetrická")
    return { label: "ASYMETRICKÁ", classes: "border-special/40 text-special bg-special/10" };
  return { label: "OMEZENÁ · V CENĚ", classes: "border-line text-faint" };
}

function topOpportunityTierMeta(tier: "strong" | "soft" | "flat" | null): {
  label: string;
  note: string;
  classes: string;
  frame: string;
} {
  if (tier === "strong") {
    return {
      label: "SILNÝ PŘÍBĚH",
      note: "Obě strany podpořené více nezávislými signály, kvalita dat není nízká.",
      classes: "border-pos/40 text-pos bg-pos/10",
      frame: "border-pos/25",
    };
  }
  if (tier === "soft") {
    return {
      label: "NEJVÝRAZNĚJŠÍ DOSTUPNÝ ROZDÍL",
      note: "Konvikce nebo kvalita dat zatím nejsou na plné úrovni — ber jako slabší podnět k prozkoumání.",
      classes: "border-warn/40 text-warn bg-warn/10",
      frame: "border-warn/25",
    };
  }
  return {
    label: "TRH BEZ JASNÉHO PŘÍBĚHU",
    note: "Rozestup mezi nejsilnější a nejslabší měnou je teď malý — tenhle týden nikdo jasně nevyčnívá.",
    classes: "border-line2 text-muted",
    frame: "border-line",
  };
}

function ledgerEntryMeta(entry: LedgerEntry): { label: string; classes: string } {
  switch (entry.classification) {
    case "opened":
      return { label: "NOVÁ TEZE", classes: "border-accent/40 text-accent bg-accent/10" };
    case "confirms":
      return { label: "TEZE POSÍLENA", classes: "border-pos/40 text-pos bg-pos/10" };
    case "challenges":
      return { label: "TEZE OSLABENA", classes: "border-warn/40 text-warn bg-warn/10" };
    case "invalidates_driver":
      return { label: "DRIVER INVALIDOVÁN", classes: "border-warn/40 text-warn bg-warn/10" };
    case "closed":
      return { label: "TEZE UZAVŘENA", classes: "border-neg/40 text-neg bg-neg/10" };
    default:
      return { label: entry.classification, classes: "border-line text-muted" };
  }
}

function thesisStatusBadge(status: "active" | "watching" | "invalidated"): { label: string; classes: string } {
  if (status === "watching") {
    return { label: "SLEDUJE SE", classes: "border-warn/40 text-warn bg-warn/10" };
  }
  if (status === "invalidated") {
    return { label: "ZRUŠENO", classes: "border-neg/40 text-neg bg-neg/10" };
  }
  return { label: "AKTIVNÍ", classes: "border-pos/40 text-pos bg-pos/10" };
}

// Jeden pilíř ve stripu vstupů. Vlastní komponenta, aby šlo těch šest držet v mřížce
// se stejnou výškou a typografií.
function Pillar({
  label,
  value,
  sub,
  interpretation,
  barPct,
}: {
  label: string;
  value: string;
  sub?: string | null;
  interpretation?: string | null;
  barPct?: number | null;
}) {
  // COT percentil >80/<20 = "crowded" pozicování — stejný práh jako zbytek appky (viz
  // top-opportunity.mjs), proto se pruh přebarví na warn.
  const barColor = barPct !== undefined && barPct !== null && (barPct > 80 || barPct < 20) ? "bg-warn" : "bg-accent";
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="bg-surface2 border border-line rounded-lg px-3 py-2.5 min-w-0 transition duration-200 hover:border-line2 hover:-translate-y-px">
      <div className="text-[10px] tracking-wider text-faint uppercase mb-1 truncate">{label}</div>
      {interpretation && (
        <div className="text-[12px] text-accent font-medium leading-snug mb-1.5">{interpretation}</div>
      )}
      <div className="text-[13px] text-ink font-mono leading-snug break-words">{value}</div>
      {sub && <div className="text-[10px] text-faint mt-1 leading-snug break-words">{sub}</div>}
      {barPct !== undefined && barPct !== null && (
        <div className="w-full h-1 bg-line rounded-full mt-2.5 overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-[900ms] ease-[cubic-bezier(.16,1,.3,1)] ${barColor}`}
            style={{ width: revealed ? `${Math.max(0, Math.min(100, barPct))}%` : "0%" }}
          />
        </div>
      )}
    </div>
  );
}

// Agenda jako accordion po tierech — vlastní lokální stav, ne stav App.tsx, protože se týká
// jen "jak je tahle sekce zrovna rozbalená" a nemá cenu ho tahat výš. `key={currency.code}`
// na callsite komponentu při přepnutí měny odmountuje a nastaví defaulty znovu.
function AgendaSection({ scenarios }: { scenarios: CurrencyData["scenarios"] }) {
  const [expanded, setExpanded] = useState<Record<AgendaTier, boolean>>({
    klíčový: true,
    druhořadý: true,
    kontext: false,
  });

  return (
    <>
      {AGENDA_TIER_ORDER.map((tier) => {
        const items = scenarios.filter((s) => s.tier === tier);
        if (items.length === 0) return null;
        const meta = agendaTierMeta(tier);
        const isOpen = expanded[tier];

        return (
          <div key={tier} className="mb-3 last:mb-0">
            <button
              onClick={() => setExpanded((prev) => ({ ...prev, [tier]: !prev[tier] }))}
              className="w-full flex flex-wrap items-center gap-2 py-1.5 text-left"
            >
              <Badge classes={meta.classes}>{meta.heading}</Badge>
              <span className="text-[11px] text-faint italic">{meta.hint}</span>
              <span className="text-[11px] text-faint font-mono">({items.length})</span>
              <span
                className={`ml-auto text-faint text-[11px] transition-transform duration-200 ${
                  isOpen ? "rotate-180" : ""
                }`}
              >
                ▾
              </span>
            </button>

            <div
              className="overflow-hidden transition-[max-height,opacity] duration-300 ease-[cubic-bezier(.16,1,.3,1)]"
              style={{ maxHeight: isOpen ? "3000px" : "0px", opacity: isOpen ? 1 : 0 }}
            >
              <div className="grid md:grid-cols-2 gap-3 mt-3 mb-4">
                {items.map((scenario) => {
                  const reaction = agendaReactionMeta(scenario.reaction);
                  return (
                    <div
                      key={`${scenario.date}-${scenario.event}`}
                      className={`bg-surface2 border border-line rounded-lg p-4 border-l-2 ${meta.rail} transition-transform duration-200 hover:-translate-y-[2px]`}
                    >
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className="text-faint font-mono text-[11px]">{scenario.date}</span>
                        <span className="text-sm text-ink font-semibold">{scenario.event}</span>
                        <Badge classes={reaction.classes}>{reaction.label}</Badge>
                      </div>

                      <dl className="space-y-2 text-xs leading-relaxed">
                        {scenario.whyItMatters && (
                          <div>
                            <dt className="text-[10px] tracking-wider text-faint uppercase">Proč teď rozhoduje</dt>
                            <dd className="text-muted mt-0.5">{scenario.whyItMatters}</dd>
                          </div>
                        )}
                        {scenario.marketExpectation && (
                          <div>
                            <dt className="text-[10px] tracking-wider text-faint uppercase">Co čeká trh</dt>
                            <dd className="text-muted mt-0.5">{scenario.marketExpectation}</dd>
                          </div>
                        )}
                        {scenario.thesisTest && (
                          <div>
                            <dt className="text-[10px] tracking-wider text-warn uppercase">Co by změnilo tezi</dt>
                            <dd className="text-ink/90 mt-0.5">{scenario.thesisTest}</dd>
                          </div>
                        )}
                      </dl>

                      {scenario.reactionNote && (
                        <p className="text-[11px] text-faint italic mt-2.5">{scenario.reactionNote}</p>
                      )}

                      {scenario.outcome && (
                        <div className="mt-3 pt-3 border-t border-line">
                          <div className="text-[10px] tracking-wider text-pos uppercase mb-1">Výsledek</div>
                          <p className="text-xs text-muted leading-relaxed">{scenario.outcome}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function App() {
  const [currencies, setCurrencies] = useState<CurrencyData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currencyCode, setCurrencyCode] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [topOpportunity, setTopOpportunity] = useState<TopOpportunity | null>(null);
  // Ruční "Zkusit znovu" tlačítko u chybové hlášky mění tenhle counter, což znovu nakopne
  // efekt níž (je v jeho dependency poli) — bez toho by šel jediný způsob obnovy přes reload
  // celé stránky.
  const [loadRetryToken, setLoadRetryToken] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Appka teď vyžaduje přihlášení pro KOHOKOLI (DB granty na anon jsou zrušené, viz
  // schema-require-auth.sql) — data se tedy nemá cenu tahat, dokud session neexistuje, jinak
  // by to skončilo jen zbytečnou 401/403 chybou z Supabase.
  //
  // Živě nahlášeno 13.8.2026: přihlášený uživatel dostal "Databáze neodpověděla do 10 s." — DB
  // granty pro authenticated roli jsou přitom ověřeně v pořádku (12/12 dotazů projde), takže šlo
  // o přechodný síťový zádrhel na jednom z 12 souběžných dotazů. Appka na to dřív neměla žádnou
  // pojistku — jediná záchrana byl ruční reload celé stránky. Teď: 1× tichý automatický retry po
  // krátké pauze, a teprve když selže i ten, ukázat chybu (s ručním tlačítkem, viz níž).
  //
  // Živě nahlášeno znovu 13.8.2026 (pár hodin po nasazení výše): appka uživatele sama odhlásila
  // bez zjevného důvodu. Příčina — první verze týhle opravy: jakmile ZPRÁVA chyby jen VYPADALA
  // jako vypršelá session (isAuthError — obsahuje "permission denied"/"jwt"/"401"/"403"),
  // OKAMŽITĚ (bez retry) volala signOut(), aniž by ověřila, že session je fakt mrtvá. Jenže
  // stejně vypadající 401/403 dostane i souběžný dotaz, který jen zachytil token těsně před
  // jeho tichým obnovením na pozadí (autoRefreshToken) — to není vypršelá session, jen dotaz,
  // co odešel o pár desítek ms dřív. Výsledkem bylo nucené odhlášení i s platnou session.
  // Oprava: než se odhlásí, appka se sama zeptá Supabase na aktuální session (getSession() ji
  // obnoví, pokud je potřeba a jde to) — teprve když TA potvrdí, že session je pryč, jde o
  // skutečně vypršelé přihlášení a odhlášení dává smysl. Jinak se chyba bere jako přechodná a
  // pokračuje se běžným tichým retry níž.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    async function isReallySignedOut(): Promise<boolean> {
      const { data } = await supabase.auth.getSession();
      return !data.session;
    }

    async function load() {
      try {
        const data = await fetchCurrencies();
        if (cancelled) return;
        setCurrencies(data);
        setLoadError(null);
        setCurrencyCode((prev) => prev ?? data.find((c) => c.code === "EUR")?.code ?? data[0]?.code ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isAuthError(message) && (await isReallySignedOut())) {
          if (!cancelled) setLoadError("Přihlášení vypršelo — přihlaste se prosím znovu.");
          await signOut();
          return;
        }
        // Jeden tichý pokus navíc — nezobrazí se žádná chyba, pokud se povede.
        await new Promise((r) => setTimeout(r, 1500));
        if (cancelled) return;
        try {
          const data = await fetchCurrencies();
          if (cancelled) return;
          setCurrencies(data);
          setLoadError(null);
          setCurrencyCode((prev) => prev ?? data.find((c) => c.code === "EUR")?.code ?? data[0]?.code ?? null);
        } catch (err2) {
          const message2 = err2 instanceof Error ? err2.message : String(err2);
          if (isAuthError(message2) && (await isReallySignedOut())) {
            if (!cancelled) setLoadError("Přihlášení vypršelo — přihlaste se prosím znovu.");
            await signOut();
            return;
          }
          if (!cancelled) setLoadError(message2);
        }
      }
    }

    load();
    fetchTopOpportunity()
      .then(setTopOpportunity)
      .catch(() => setTopOpportunity(null));

    return () => {
      cancelled = true;
    };
  }, [session, loadRetryToken]);

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

  const currency = useMemo(() => currencies?.find((c) => c.code === currencyCode) ?? null, [currencies, currencyCode]);

  // Dokud neproběhne první getSession(), nevíme, jestli ukázat bránu, nebo dashboard — krátká
  // prázdná obrazovka je lepší než blesknutí přihlašovací brány každému, kdo má platnou session.
  if (!sessionChecked) {
    return <div className="min-h-screen bg-bg" />;
  }

  // Appka je teď jen po přihlášení (viz notify-admin-login a schema-require-auth.sql) —
  // kdokoli se svým e-mailem, admin oprávnění na úpravu dat má ale pořád jen ADMIN_EMAIL.
  if (!session) {
    return <AdminLogin />;
  }

  return (
    <div className="min-h-screen bg-bg">
      {/* Hlavička je sticky a užší — na mobilu zabírala pětinu obrazovky. */}
      <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-lg font-extrabold tracking-tight shrink-0">
              KON<span className="text-accent">FLUENCE</span>
            </h1>
            <div className="flex items-center gap-1.5 shrink-0 pl-2 pr-2.5 py-1 bg-surface border border-line rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-pos animate-live-pulse" />
              <span className="text-[10px] tracking-[0.1em] text-muted font-bold">ŽIVÁ DATA</span>
            </div>
            <span className="hidden md:inline text-[10px] tracking-wider text-faint uppercase truncate">
              Fundamentální kontext · není investiční doporučení
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 text-[11px] text-muted">
              {isAdmin && <span className="text-accent font-semibold">admin</span>}
              <button
                onClick={() => signOut()}
                className="border border-line rounded px-2 py-1 hover:border-line2 hover:bg-surface2 hover:text-ink transition-colors duration-200"
              >
                Odhlásit
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {loadError && (
          <Card className="p-5 border-neg/40 text-sm text-neg flex items-center justify-between gap-4 flex-wrap">
            <span>Nepodařilo se načíst data z databáze: {loadError}</span>
            <button
              onClick={() => {
                setLoadError(null);
                setLoadRetryToken((n) => n + 1);
              }}
              className="shrink-0 bg-neg/10 border border-neg/40 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-neg/20 transition-colors"
            >
              Zkusit znovu
            </button>
          </Card>
        )}

        {!loadError && !currencies && (
          <Card className="p-10 text-center text-muted text-sm">Načítám confluence skóre…</Card>
        )}

        {currencies && currencies.length === 0 && (
          <Card className="p-10 text-center text-muted text-sm">
            Zatím nejsou k dispozici žádná data — ingest job ještě neproběhl.
          </Card>
        )}

        {/* KDE JE DNES SIGNÁL — UX audit 2026-08-06: appka měla flow "vyber měnu → 12 sekcí",
            ale většina měn je většinu času neutrální s nízkou konvikcí — uživatel musel
            proklikat všech 8, aby zjistil, které z nich vůbec stojí za pozornost. Tenhle pruh
            odpovídá na otázku, se kterou do appky trader přichází, hned za pár vteřin: kde je
            dnes síla skóre podložená shodou signálů, ne abecedně první měna. Řadí, neskrývá —
            zbytek appky (CurrencyTabs níž) je pořád po ruce beze změny. */}
        {currencies && currencies.length > 0 && (
          <Card tone="raised" className="p-4 sm:p-5">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
              Kde je dnes signál
            </span>
            <div className="flex flex-wrap gap-2 mt-3">
              {[...currencies]
                .map((c) => ({ ...c, _weight: Math.abs(c.score) * (c.convictionStars ?? 0) }))
                .sort((a, b) => b._weight - a._weight)
                .slice(0, 4)
                .map((c) => {
                  const dotColor = c.score > 0.05 ? "bg-pos" : c.score < -0.05 ? "bg-neg" : "bg-muted";
                  return (
                    <button
                      key={c.code}
                      onClick={() => setCurrencyCode(c.code)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-colors duration-200 ${
                        c.code === currency?.code
                          ? "bg-accent/[.14] border-accent/50"
                          : "border-line hover:border-line2 hover:bg-surface2"
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                      <span className="text-sm font-bold text-ink">{c.code}</span>
                      <span className="font-mono text-xs text-muted">
                        {c.score > 0 ? "+" : ""}
                        {c.score.toFixed(1)}
                      </span>
                      <span className={`text-[10px] tracking-wide ${convictionColor(c.convictionLabel)}`}>
                        {c.convictionStars ?? 0}/5
                      </span>
                    </button>
                  );
                })}
            </div>
            <p className="text-[11px] text-faint italic mt-3">
              Seřazeno podle síly skóre × konvikce (shody nezávislých signálů) — kde má appka
              nejvíc co říct právě teď, ne abecedně.
            </p>
          </Card>
        )}

        {/* TOP PŘÍLEŽITOST — pruh napříč měnami, patří nad výběr měny, protože se ho netýká. */}
        {topOpportunity && !topOpportunity.insufficientData && (
          <Card tone="raised" className={`p-4 sm:p-5 ${topOpportunityTierMeta(topOpportunity.confidenceTier).frame}`}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <span className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
                Top fundamentální příležitost týdne
              </span>
              <Badge classes={topOpportunityTierMeta(topOpportunity.confidenceTier).classes}>
                {topOpportunityTierMeta(topOpportunity.confidenceTier).label}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-pos tracking-tight">
                  {topOpportunity.strongestCurrency}
                </span>
                <span className="text-[11px] text-faint uppercase tracking-wider">nejsilnější</span>
              </div>
              <span className="text-line2 text-xl">/</span>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-extrabold text-neg tracking-tight">
                  {topOpportunity.weakestCurrency}
                </span>
                <span className="text-[11px] text-faint uppercase tracking-wider">nejslabší</span>
              </div>
            </div>

            <p className="text-[11px] text-faint italic mt-2">
              {topOpportunityTierMeta(topOpportunity.confidenceTier).note}
            </p>
            {topOpportunity.rationale && (
              <p className="text-xs text-muted mt-3 leading-relaxed">{topOpportunity.rationale}</p>
            )}
            <p className="text-[11px] text-faint italic mt-3 pt-3 border-t border-line">
              Jen inspirace k dalšímu zkoumání, ne signál ke vstupu — timing, risk management a technickou
              konfluenci řeší Fx Analyzer.
            </p>
          </Card>
        )}

        {currencies && currencies.length > 0 && currency && (
          <>
            {/* Přepínač měny je sticky hned pod hlavičkou — při dlouhém scrollu agendou
                je pořád po ruce a je jasné, o které měně čtu. */}
            <div className="sticky top-14 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-bg/95 backdrop-blur border-b border-line">
              <CurrencyTabs
                currencies={currencies.map((c) => ({ code: c.code, score: c.score }))}
                selected={currency.code}
                onSelect={setCurrencyCode}
              />
            </div>

            {/* HERO — skóre a teze vedle sebe. Patří k sobě: obojí odpovídá na "co si myslíme". */}
            <div className="grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-4">
              <Card tone="raised" className="p-5 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
                    Confluence skóre
                  </span>
                  {currency.dataQuality && (
                    <Badge classes={dataQualityBadgeClasses(currency.dataQuality.level)}>
                      DATA {currency.dataQuality.level} · {currency.dataQuality.coveragePct} %
                    </Badge>
                  )}
                </div>

                <Gauge score={currency.score} />

                <div className="text-center mt-1">
                  <div className="font-mono text-5xl font-bold text-ink tracking-tight">
                    {currency.score > 0 ? "+" : ""}
                    {currency.score.toFixed(1)}
                  </div>
                  {currency.scoreChange && currency.scoreChange.delta !== 0 && (
                    <div
                      className={`font-mono text-sm font-semibold mt-0.5 ${
                        currency.scoreChange.delta > 0 ? "text-pos" : "text-neg"
                      }`}
                      title={`Předchozí skóre ${currency.scoreChange.previousScore.toFixed(1)} · změna ${new Date(
                        currency.scoreChange.changedAt
                      ).toLocaleString("cs-CZ")}`}
                    >
                      {currency.scoreChange.delta > 0 ? "+" : ""}
                      {currency.scoreChange.delta.toFixed(1)}
                    </div>
                  )}
                  <div className={`text-[11px] tracking-wider mt-1.5 ${convictionColor(currency.convictionLabel)}`}>
                    {currency.convictionLabel}
                  </div>
                  {currency.convictionStars !== null && (
                    <div className="mt-2">
                      <ConvictionMeter filled={currency.convictionStars} />
                    </div>
                  )}
                </div>

                {/* Nezávislý indikátor — NEOVLIVŇUJE currency.score, jen upozorňuje, když se
                    krátkodobý (90 dní) a dlouhodobý fundamentální pohled výrazně rozejdou. */}
                {currency.regimeShift?.alert && (
                  <div className="mt-3 border-l-2 border-warn/60 bg-warn/5 rounded-r-lg px-3 py-2">
                    <div className="text-[10px] tracking-wider text-warn uppercase mb-1">Možná změna režimu</div>
                    <p className="text-[11px] text-ink/80 leading-relaxed">
                      Krátkodobá data (90 dní: {currency.regimeShift.shortTermScore > 0 ? "+" : ""}
                      {currency.regimeShift.shortTermScore.toFixed(1)}) se rozcházejí s dlouhodobým trendem (
                      {currency.regimeShift.longTermScore > 0 ? "+" : ""}
                      {currency.regimeShift.longTermScore.toFixed(1)}).
                    </p>
                  </div>
                )}

                {(currency.convictionNote || currency.convictionReasons.length > 0) && (
                  <div className="mt-4 pt-4 border-t border-line space-y-2">
                    {currency.convictionNote && (
                      <p className="text-[11px] text-muted italic leading-relaxed">{currency.convictionNote}</p>
                    )}
                    {currency.convictionReasons.length > 0 && (
                      <ul className="text-[11px] text-faint space-y-1">
                        {currency.convictionReasons.map((reason) => (
                          <li key={reason} className="flex gap-1.5">
                            <span className="text-accent/60">·</span>
                            <span>{reason}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </Card>

              {currency.thesis ? (
                <Card tone="raised" className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
                      Makro teze
                    </span>
                    <Badge classes={thesisStatusBadge(currency.thesis.status).classes}>
                      {thesisStatusBadge(currency.thesis.status).label}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className={`text-3xl font-extrabold tracking-tight ${thesisDirectionColor(currency.thesis.direction)}`}>
                      {thesisDirectionLabel(currency.thesis.direction)}
                    </span>
                    <ConvictionMeter filled={Math.round(currency.thesis.conviction)} />
                  </div>

                  <div className="text-[11px] text-faint mt-2">
                    otevřeno {new Date(currency.thesis.openedAt).toLocaleDateString("cs-CZ")} · potvrzeno{" "}
                    {currency.thesis.confirmStreak}×
                    {currency.thesis.challengeStreak > 0 && `, zpochybněno ${currency.thesis.challengeStreak}×`}
                  </div>

                  {currency.thesis.thesisSummary && (
                    <p className="text-sm text-muted mt-4 leading-relaxed">{currency.thesis.thesisSummary}</p>
                  )}

                  {currency.thesisChangeNote && (
                    <div className="mt-4 border-l-2 border-accent bg-accent/5 rounded-r-lg px-4 py-3">
                      <div className="text-[10px] tracking-wider text-accent uppercase mb-1">
                        Poslední pohyb skóre
                      </div>
                      <p className="text-sm text-ink/90 leading-relaxed">{currency.thesisChangeNote}</p>
                    </div>
                  )}

                  {currency.thesis.drivers.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-line">
                      {currency.thesis.drivers.map((driver) => (
                        <span
                          key={driver.driverKey}
                          className={`inline-flex items-center gap-2 text-[11px] px-2.5 py-1 rounded-md border ${
                            driver.status === "weakening"
                              ? "border-warn/40 text-warn bg-warn/5"
                              : "border-pos/40 text-pos bg-pos/5"
                          }`}
                        >
                          {driver.label}
                          <span className="font-mono text-faint">
                            {driver.value > 0 ? "+" : ""}
                            {driver.value.toFixed(2)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </Card>
              ) : (
                <Card tone="raised" className="p-5 flex items-center justify-center text-sm text-faint">
                  Pro tuhle měnu zatím není otevřená žádná teze.
                </Card>
              )}
            </div>

            {/* PILÍŘE — vstupy, ze kterých skóre vzniklo. Dřív byly schované uvnitř panelu
                se shrnutím, kam logicky nepatří: nejsou to závěry, jsou to data. */}
            <Card className="p-5">
              <SectionTitle hint="Vstupy, ze kterých skóre a teze vznikly.">Pilíře</SectionTitle>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
                <Pillar
                  label="COT pozicování"
                  value={currency.cotPositioning}
                  sub={currency.cotPercentile !== null ? `${currency.cotPercentile}. percentil` : null}
                  barPct={currency.cotPercentile}
                />
                <Pillar
                  label="Fundamentální skóre"
                  value={
                    currency.fundamentalScore !== null
                      ? `${currency.fundamentalScore > 0 ? "+" : ""}${currency.fundamentalScore.toFixed(1)}`
                      : "—"
                  }
                />
                <Pillar label="Retail sentiment" value={retailSentimentLabel(currency.retailScore)} />
                <Pillar
                  label="Zaceněnost"
                  interpretation={pricedInInterpretation(currency.cbPolicy)}
                  value={currency.pricedIn ?? "—"}
                  sub={
                    currency.cbPolicy
                      ? `${
                          currency.cbPolicy.pricedIn.method === "yield_gap"
                            ? "2Y výnos vs. sazba (FRED)"
                            : "konsensus rozhodnutí"
                        } · ${currency.cbPolicy.pricedIn.confidenceLevel}`
                      : null
                  }
                />
                <Pillar
                  label="Dlouhodobý bias (CB)"
                  interpretation={longTermBiasInterpretation(currency.cbPolicy)}
                  value={currency.longTermBias ?? "—"}
                />
                <Pillar label="Real yield" {...realYieldDisplay(currency.cbPolicy)} />
                <Pillar label="Risk režim" value={riskRegimeLabel(currency.riskRegime)} />
              </div>
            </Card>

            {/* SHRNUTÍ + navazující upozornění — hlavní text, dostává nejvíc prostoru. */}
            <Card tone="raised" className="p-5 sm:p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
                  Shrnutí příběhu
                </span>
              </div>
              <RichText text={currency.summary} className="text-[15px] leading-[1.75] text-ink/90" />

              {currency.forwardFlag && (
                <div className="mt-5 border-l-2 border-accent bg-accent/5 rounded-r-lg px-4 py-3">
                  <div className="text-[10px] tracking-wider text-accent uppercase mb-1">Navazující eventy</div>
                  <p className="text-sm text-muted leading-relaxed">{currency.forwardFlag}</p>
                </div>
              )}
            </Card>

            {/* AGENDA — hlavní obsah, proto tři úrovně a vlastní rytmus. */}
            {currency.scenarios.length > 0 && (
              <Card className="p-5 sm:p-6">
                <SectionTitle hint="Makro agenda, ne kalendář — u každé události proč teď rozhoduje, co čeká trh, jaká laťka by změnila tezi a jestli je reakce ještě před námi, nebo už v ceně.">
                  Co může změnit příběh
                </SectionTitle>

                <AgendaSection key={currency.code} scenarios={currency.scenarios} />
              </Card>
            )}

            {/* Spodní dvojice — historie a kalendář jsou referenční, ne hlavní čtení,
                proto tišší plocha a vedle sebe. */}
            <div className="grid lg:grid-cols-2 gap-4">
              {currency.ledgerFeed.length > 0 && (
                <Card tone="quiet" className="p-5">
                  <SectionTitle hint="Kdy a proč appka tezi potvrdila nebo zpochybnila.">Co se změnilo?</SectionTitle>
                  <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                    {currency.ledgerFeed.map((entry, i) => {
                      const meta = ledgerEntryMeta(entry);
                      return (
                        <div key={`${entry.occurredAt}-${i}`} className="border-l border-line pl-3">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <Badge classes={meta.classes}>{meta.label}</Badge>
                            <span className="text-[10px] text-faint font-mono">
                              {new Date(entry.occurredAt).toLocaleDateString("cs-CZ")}
                            </span>
                            {entry.driverKey && <span className="text-[10px] text-faint">· {entry.driverKey}</span>}
                          </div>
                          <p className="text-xs text-muted leading-relaxed">{entry.reasoning}</p>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}

              <Card tone="quiet" className="p-5">
                <SectionTitle hint="Vše naplánované, včetně méně důležitých položek.">
                  Kalendář — nadcházejících 21 dní
                </SectionTitle>
                {currency.calendarEvents.length === 0 ? (
                  <p className="text-sm text-faint py-6 text-center">
                    Zatím žádné naplánované eventy pro tuhle měnu.
                  </p>
                ) : (
                  <div className="divide-y divide-line max-h-[420px] overflow-y-auto pr-1">
                    {currency.calendarEvents.map((event) => (
                      <div
                        key={`${event.date}-${event.title}`}
                        className="py-3 first:pt-0 last:pb-0 flex items-start justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <div className="text-[10px] text-faint font-mono mb-0.5">{event.date}</div>
                          <div className="text-[13px] text-ink leading-snug mb-1.5">{event.title}</div>
                          <Badge classes={impactBadgeClasses(event.impact)}>{event.impact}</Badge>
                        </div>
                        <div className="text-right shrink-0 text-[11px] font-mono">
                          <div className="text-faint mb-0.5 text-[10px]">kons. / předch.</div>
                          <div className="text-muted">
                            {event.estimate ?? "–"} / {event.previous ?? "–"}
                          </div>
                          {event.actual && !isAdmin && <div className="text-pos mt-1">{event.actual}</div>}
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
              </Card>
            </div>
          </>
        )}

        <footer className="text-xs text-faint pt-6 pb-10 space-y-3 border-t border-line leading-relaxed">
          <p>
            COT pozicování a retail sentiment (týdně, CFTC), fundamentální skóre a CB politika/real yield
            (ekonomický kalendář ForexFactory) a risk režim (VIX, FRED) jsou reálná a průběžně aktualizovaná
            data. „Zaceněnost" je u většiny měn odvozená z konsensu posledního rozhodnutí, ne z reálné
            OIS/futures křivky — metoda je vždy uvedená u čísla.
          </p>
          <p>
            Shrnutí příběhu, upozornění na navazující eventy a makro agenda vznikají jazykovým modelem
            (OpenAI) na základě těchto dat — jde o syntézu veřejně dostupných informací a heuristických
            odhadů, ne o investiční doporučení.
          </p>
          <p className="text-muted">
            <span className="text-accent font-semibold">Konfluence</span> vysvětluje PROČ — makro kontext,
            fundamentální bias a jak se v čase mění. Neřeší timing vstupu, risk management ani technickou
            konfluenci na grafu; o to, jestli je konkrétní obchod podpořený daty a potvrzený napříč zdroji,
            se stará samostatný nástroj <span className="text-ink font-semibold">Fx Analyzer</span>.
          </p>
        </footer>
      </main>
    </div>
  );
}
