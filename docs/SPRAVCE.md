# Správce Fundament-app — předávací dokument

Tenhle soubor čte nová session, která přebírá roli správce aplikace. Nic z předchozí konverzace nezná, proto je tu vše podstatné. Uživatel mluví česky — piš česky, stručně, bez zbytečných slov. Neměň produkci bez vyžádání; když nevíš, zeptej se.

## 1. Co aplikace je
Čistě fundamentální aplikace pro 8 měn (USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD): má ukázat, jak se každé měně fundamentálně daří, a vyprávět to jako příběh. Žádný obchodní signál — timing, risk management a technickou analýzu řeší samostatný nástroj Fx Analyzer (repo `pitrrv/fx-analyzer`).

- Repo `PitrrV/Fundamet-app`, produkční větev `claude/fundament-app-setup-ehe8g0` (push přímo, bez PR, pokud o PR uživatel nepožádá). Push spustí nasazení na GitHub Pages.
- Frontend: React/Vite (`src/`). Výpočty a cron skripty: Node `.mjs` v `scripts/`, spouštěné GitHub Actions (`.github/workflows/`). Databáze: Supabase, projekt `wdcvxfbhauwvwzbatkfh`.

## 2. Pravidla, která uživatel výslovně stanovil
1. **Nic se nehádá a nedomýšlí.** Chybějící data jsou „nemáme", ne nula.
2. **COT, retail sentiment, VIX ani cena nikdy nevstupují do skóre.** COT je jen doplněk.
3. **Žádné změny produkce bez vyžádání.** Uživatel už jednou vytkl, že se refaktorovalo po otázce „co kdyby…". Nejdřív ukaž výsledky/plán, pak teprve nasazuj.
4. **Změny vzorce skóre jen po zpětném testu** (`research-lookback-backtest`) a s jeho souhlasem. Backtest je jediný důkaz; váhy a okno byly zvoleny na stejných datech, na kterých se měří (optimismus).
5. Nepřiznávej víc jistoty, než data dávají. Index je čtení fundamentální situace, ne předpověď ceny (rank-IC ≈ 0,1, po letech nestabilní).
6. **Aplikace musí být důvěryhodná.** Fundamentální aplikace stojí na tom, že čísla (sazby, CPI, skóre, texty) jsou pravdivá a ověřitelná. Ke každé věci přistupuj jako profesionální senior analytik: každou hodnotu ověř proti primárnímu zdroji (web centrální banky / statistického úřadu), rozliš fakt od odhadu, chybějící data označ jako „nemáme", nikdy je nedoplňuj tipem. Rozpor mezi aplikací a realitou je chyba, kterou je třeba opravit zdokumentovaně a nahlásit.
7. Do commitů a souborů v repu nepiš identifikátor modelu. Hesla/klíče nikdy do chatu ani do repa (secrets jsou v prostředí a v GitHub repo secrets).

## 3. Jak skóre vzniká (state-v1)
Modul `scripts/fundamental-state.mjs` (testy `fundamental-state.test.mjs`, `npm test`).
- 6 složek, každá +1 / 0 / −1 / null: politika centrální banky, reálný výnos (sazba − CPI y/y vůči koši), trh práce (míra nezaměstnanosti proti vlastní normě), růst (HDP), spotřeba (maloobchod; AUD Household Spending), PMI. Váhy 1 / 1,5 / 1,5 / 0,5 / 1 / 1.
- Okno 12 měsíců kalendáře. Index = vážený průměr dostupných složek (min. 3), skóre = index × 5 (−5…+5) = `confluence_scores.overall_score`. Pásma: Silný ≥ 0,5; Mírně pozitivní ≥ 0,2; Neutrální; Mírně negativní ≤ −0,2; Slabý ≤ −0,5.
- Překvapení vs. konsenzus (`fundamental_score`) je zvlášť, mimo skóre. Inflace je kontext a do skóre jde jen nepřímo přes reálný výnos.
- Přepínače oprav `STATE_OPTIONS_DEFAULT`: zapnuto HDP v jedné jednotce, PMI jen úplné měsíce, řady AUD/NZD; vypnuto vyhlazení spotřeby, práh materiality, trh práce se zaměstnaností a mzdami (backtest je zamítl). Výsledky: `docs/backtest-state-v1.md`.
- Ukládá se do `fundamental_state` (aktuální), `fundamental_state_history` (týdně), `cb_policy_state`, `confluence_scores`; teze v `currency_thesis`/`thesis_ledger` (historie před 2. 10. 2026 je označená „před změnou metodiky").

## 4. Tok dat
`fetch-calendar` (cron každých 15 min přes externí spouštěč) → ForexFactory přes Supabase Edge Function `ff-calendar-relay` (přímý přístup z GitHub Actions je blokovaný) → `calendar_events` → `recomputeScores` (stav, CB politika, teze, top příležitost) → při změně spustí přegenerování textů. Ceny `fx_price_daily` z `ingest-fx-daily-prices`, COT z `ingest-cot`.

## 5. Co z cloudového prostředí jde a nejde
- Z této session se **nedostaneš** přímo na ForexFactory ani na `*.supabase.co` přes HTTP (proxy to blokuje). Data čti/zapisuj přes **Supabase konektor** (`execute_sql`, projekt výše) nebo přes GitHub Actions.
- Spouštění workflowů: GitHub MCP (`actions_run_trigger`, `actions_list`, `get_job_logs`). Stav běhů v listu bývá zpožděný — ověř v logu nebo v DB.
- Internet na ověřování faktů: `WebSearch`/`WebFetch` fungují (ověřeno na RBA, RBNZ, BoC).
- Čtení tabulek je jen pro přihlášené (`schema-require-auth.sql`); anonymní klíč nečte nic kromě `fx_price_daily`.
- DDL přes MCP bývá pomalé (časový limit) — dělej po jednom příkazu.

## 6. Texty příběhů — dnes píše Claude, ne OpenAI
OpenAI kredit je vyčerpaný (`429 no credits`), proto `generate-narrative` selhává. Náhrada: `scripts/ai-narrative.mjs` + workflow `AI Narrative (Claude)`.
1. `mode=export`, `currencies=AUD,CAD,NZD` → v logu `===PAYLOAD XXX===` jsou přesné podklady (stejné, co by dostal OpenAI).
2. Napiš `data/ai-narratives/<datum>.json` (pole objektů: `currency_code`, `narrative`, `forward_flag`, `conviction_note`, `thesis_change_note`). Pravidla zadání jsou v `NARRATIVE_PROMPT` v `scripts/generate-narrative.mjs` — přečti je.
3. Commit + push, pak `mode=apply`, `dry_run=1` (kontroly: cizí písmo, uniklé názvy polí, srovnání vůči skóre koše, forward_flag o předvybraných eventech s datem jako „15. října"; `thesis_change_note` = null, když není `scoreChange`).
4. Po úspěchu `dry_run=0` (uloží s `model=claude-writer-v1`, otisk vstupů a snímek skóre jako u OpenAI).
Makro agenda (`scenarios`) se zatím z předchozího textu přenáší, nepřepisuje. Stav k 5. 10.: ručně napsané AUD, CAD, NZD; ostatní z 3. 10. od OpenAI.

## 7. Úrovně autonomie (dohodnuto)
1. **Texty příběhů** — píšeš sám, projdou kontrolami.
2. **Denní kontrola faktů** — ověř sazby, čerstvá čísla a konsenzus na internetu proti `cb_policy_state` a `calendar_events`; chyby dat opravuj jen zdokumentovaně (`scripts/manual-override.mjs`, záznam v logu); odchylky hlas uživateli.
3. **Změny vzorce skóre** — jen návrh + backtest + souhlas uživatele. Žádné tiché přepisování skóre podle názoru.

Denní kontrola (návrh): čerstvost kalendáře/cen/COT, shoda textů se skóre (`check-narrative-freshness`), shoda CB rozhodnutí s internetem, díry v datech, nadcházející události, krátký report uživateli.

## 8. Otevřené věci
- Dobít OpenAI kredit (uživatel udělá později) — nebo definitivně přejít na texty od Clauda a odstranit `generate-narrative` z workflow.
- Varování v UI u měny, jejíž text je starší než skóre (nabídnuto, neodsouhlaseno).
- Makro agenda a texty ostatních 5 měn z dnešních dat.
- Naplánovaný denní běh (Routine) s konektorem Supabase; předtím změřit spotřebu limitu (uživatel: procento z pětihodinového okna před/po — já ho nevidím).
- Karta „Fundamentální příběh" v Analyzeru: tabulky jsou nečitelné anonymně → potřeba přihlášená session, nebo read-only pohled/RPC. Potřebuje přístup k repu Analyzeru.
- Nákladová otázka: podle komentářů v kódu stojí OpenAI vypravěč jen pár dolarů měsíčně; 150–250 USD pravděpodobně z Analyzeru. Uživatel má v panelu OpenAI rozdělit spotřebu podle klíče/modelu.
- Datové díry: politika banky je jen znaménko cyklu; složka růst (HDP) v backtestu bez informace.
- **Záložní CPI pro CHF, CAD, NZD (od 9. 10. 2026, schváleno uživatelem):** FF u nich nemá roční CPI, proto je v `data/reference-cpi.json` ověřená hodnota se zdrojem, obdobím a datem vydání. Používá se jen když kalendář CPI nemá a jen `max_age_dni` od vydání, pak je „nemáme". **Po každém vydání ji musí správce obnovit** (ověřit na primárním zdroji, případně křížově složením měsíčních/čtvrtletních změn z kalendáře) a nahlásit změnu skóre. Nejbližší vydání: CAD 19. 10., NZD (Q3) 21. 10., JPY národní 22./23. 10., CHF začátkem listopadu. Zapíná to jen produkce (`fetch-calendar.mjs`); zpětný test ji nepoužívá (bez look-ahead).
- **JPY inflace = národní Core CPI** (ne Tokio, ne BOJ Core): `PREFERRED_CPI_TITLE` v `cb-policy.mjs` (schváleno 9. 10. 2026; důvod: Tokio je regionální předstih zkreslený jednorázovými efekty).
- Slabiny, o kterých uživatel ví: USD trh práce vychází jen z míry nezaměstnanosti (NFP a mzdy zůstávají v překvapení a textu); CHF „Silný" je na hraně pásma.
