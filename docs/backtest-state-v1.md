# Backtest fundamentálního stavu měny (state-v1)

Skript: `scripts/research-lookback-backtest.mjs` (ruční workflow `Research - Lookback Backtest`, čte data, nic nezapisuje).
Data: kalendář ForexFactory 2020-01 → 2026-10 (relay), ceny `fx_price_daily`. Vyhodnocení od 2023-01-06 (196 pátků × 8 měn = 1568 pozorování).
Index se pro každý pátek počítá **jen z událostí známých před tímto dnem** (point-in-time). Cíl: pozdější relativní pohyb ceny měny
(průměr % pohybu proti ostatním sedmi, pár po páru). Metrika: týdenní rank-IC (pořadová korelace napříč měnami), `t` přepočtené na nepřekrývající se vzorky.

## Délka okna historie (k = 3 předchozí tisky)

| Okno | IC 4 týdny | t | Pokrytí |
|---|---|---|---|
| 6 měsíců | 0,10 | 1,8 | 88 % |
| **12 měsíců** | **0,11** | **2,2** | **100 %** |
| 24 měsíců | 0,10 | 1,9 | 100 % |
| 36 měsíců | 0,08 | 1,5 | 100 % |
| vše od 2020 | 0,07 | 1,2 | 100 % |

Společný vzorek (platný ve všech oknech): okno 6/12/24/36/vše → IC 4 týdny 0,10 / 0,10 / 0,10 / 0,09 / 0,07 — rozdíly jsou v rámci šumu, delší historie index nezlepšila.

## Produkční modul state-v1 (váhy 1,5 / 1,5 / 1 / 1 / 1 / 0,5, okno 12 m)

| Varianta | IC 1t | IC 2t | IC 4t | IC 8t | IC 13t |
|---|---|---|---|---|---|
| vážený (produkce) | 0,08 (t 3,3) | 0,09 (t 2,4) | 0,13 (t 2,5) | 0,12 (t 1,4) | 0,09 (t 0,8) |
| rovné váhy | 0,07 (t 2,6) | 0,07 (t 1,8) | 0,11 (t 2,2) | 0,09 (t 1,2) | 0,04 (t 0,4) |

Po letech (vážený), IC 4 týdny / 13 týdnů: 2023 0,10 / 0,04 · 2024 0,18 / 0,13 · 2025 0,02 / −0,05 · 2026 0,26 / 0,36.

## Jednotlivé složky samostatně (okno 36 m, k = 3), IC 4 týdny

politika CB 0,00 · reálný výnos 0,11 (t 1,5) · trh práce 0,12 (t 2,1) · růst −0,01 · spotřeba 0,07 · PMI 0,08.

## Benchmark: staré skóre z překvapení vs. konsenzus

IC 1/2/4/8/13 týdnů: −0,02 / −0,02 / 0,01 / 0,00 / −0,08 (t kolem 0) — bez vztahu k pozdější ceně, proto je překvapení v aplikaci mimo skóre.

## Omezení (poctivě)

- Okno 12 m i váhy byly zvoleny na stejných datech 2023–2026, na kterých se měří; skutečný out-of-sample test teprve přijde s novými daty.
- Rank-IC ≈ 0,10 je slabá a po letech nestabilní souvislost (2025 ≈ 0). Index je čtení fundamentální situace, ne předpověď ceny.
- Průřez má jen 8 měn; týdenní pozorování se překrývají (proto přepočtené `t`).
- `calendar_events` drží poslední známé hodnoty (actual se po vydání může revidovat); historie je tedy point-in-time jen přibližně.

## Varianty oprav dat (testováno 2026-10-04, produkce beze změny)

Stejný postup, stejné váhy a okno; mění se jen přepínače `STATE_OPTIONS_DEFAULT` ve `scripts/fundamental-state.mjs`. Rank-IC (t přepočtené na nepřekrývající se vzorky):

| Varianta | IC 1t | IC 2t | IC 4t | IC 8t | IC 13t |
|---|---|---|---|---|---|
| V0 současná produkce | 0,08 (3,3) | 0,09 (2,4) | 0,13 (2,5) | 0,12 (1,4) | 0,09 (0,8) |
| V1 HDP v jedné jednotce | 0,08 (3,2) | 0,09 (2,4) | 0,13 (2,5) | 0,11 (1,3) | 0,08 (0,8) |
| V2 PMI jen úplné měsíce | 0,08 (3,1) | 0,09 (2,4) | 0,13 (2,5) | 0,12 (1,5) | 0,09 (0,9) |
| V3 nové řady AUD/NZD | 0,07 (2,9) | 0,09 (2,3) | 0,12 (2,3) | 0,11 (1,3) | 0,07 (0,7) |
| V4 spotřeba po blocích | 0,07 (2,7) | 0,09 (2,5) | 0,13 (2,6) | 0,13 (1,6) | 0,11 (1,1) |
| V5 vše dohromady | 0,05 (1,9) | 0,08 (2,0) | 0,12 (2,1) | 0,11 (1,4) | 0,09 (0,8) |
| V6 opravy dat (V1+V2+V3) | 0,07 (2,7) | 0,08 (2,1) | 0,11 (2,1) | 0,10 (1,2) | 0,06 (0,6) |

- Žádná varianta backtest nezlepšila; V1 a V2 jsou neutrální (opravy chyb), V3 a V6 o ~0,01–0,02 níž (v rámci šumu), V5 nejhorší na krátkém horizontu.
- Pokrytí: NZD 4,0 → 5,0 složek (BusinessNZ Manufacturing + Services Index); AUD beze změny v historii (Retail Sales m/m existoval do roku 2025), nová řada pomáhá jen v posledních měsících.
- Samotná složka spotřeba: jednotlivý tisk IC 4t 0,01 (t 0,1, n=1546) vs. průměr po blocích 0,05 (t 0,8, n=1341) — lepší, ale pořád nevýznamné a s nižším pokrytím (potřebuje 6 tisků).
- Po letech (IC 4t) V0: 0,10 / 0,18 / 0,02 / 0,26; V6: 0,07 / 0,18 / −0,00 / 0,25 (2023–2026).

**Rozhodnutí (2026-10-04):** nasazeno V1 + V2 + V3 (`STATE_OPTIONS_DEFAULT`); V4 (spotřeba po blocích) zůstává vypnuté. Důvod: V1/V2 jsou opravy chyb bez dopadu na backtest, V3 zvyšuje pokrytí NZD za cenu rozdílu ~0,01–0,02 IC v rámci šumu; V4 zhoršila krátký horizont a snižuje pokrytí spotřeby.

## Audit 2026-10-04: trh práce se zaměstnaností a mzdami, práh materiality (produkce beze změny)

Základ = produkce po V1+V2+V3. Přepínače `laborComposite` a `materialityFloor` v `fundamental-state.mjs` zůstávají VYPNUTÉ.

| Varianta | IC 1t | IC 2t | IC 4t | IC 8t | IC 13t |
|---|---|---|---|---|---|
| W0 současná produkce | 0,07 (2,7) | 0,08 (2,1) | 0,11 (2,1) | 0,10 (1,2) | 0,06 (0,6) |
| W1 práh materiality (0,2 / 0,2 / 0,3 p. b.) | 0,04 (1,7) | 0,06 (1,6) | 0,08 (1,5) | 0,08 (0,9) | 0,05 (0,4) |
| W2 práce = nezaměstnanost + zaměstnanost + mzdy | 0,05 (1,9) | 0,06 (1,5) | 0,09 (1,7) | 0,08 (1,0) | 0,05 (0,5) |
| W3 obojí | 0,05 (1,7) | 0,06 (1,6) | 0,07 (1,3) | 0,07 (0,9) | 0,04 (0,4) |

Samotná složka trh práce (IC 4 týdny): W0 0,15 (t 3,2) · W1 0,12 · W2 0,08 · W3 0,06. Práh materiality vynuluje 66 % nenulových signálů trhu práce (24 % u HDP, 4 % u spotřeby) — a právě malé pohyby míry nezaměstnanosti nesou informaci. Přidání zaměstnanosti a mezd složku trhu práce zhoršilo.

Samotná složka růst (HDP): IC 4 týdny −0,03 (t −0,7), 13 týdnů −0,11 (t −1,3) — v tomto vzorku bez informace (nevýznamně záporná).

**Rozhodnutí:** nic z toho se nenasazuje. Audit tvrdil, že drobné odchylky a chybějící NFP/mzdy zkreslují trh práce; data to nepotvrdila — současná definice (míra nezaměstnanosti proti vlastní normě) je nejlepší ze čtyř variant. NFP a mzdy zůstávají v aplikaci jako překvapení/kontext, ne ve skóre.

## Screening všech ukazatelů a kombinací (2026-10-13, produkce beze změny)

Skript `scripts/research-indicator-screen.mjs` (workflow `Research - Indicator Screen`, read-only). 1576 pozorování měna × týden (leden 2023 → říjen 2026), signály point-in-time. Pooled korelace signálu s relativním pohybem měny za 4 týdny, `t` přepočtené na nepřekrývající se vzorky, v závorce počet let (z 4) s kladnou korelací.

| Ukazatel (signál) | r 4t | t | roky + | Závěr |
|---|---|---|---|---|
| **Míra nezaměstnanosti (trend)** = současná složka „trh práce" | **0,13** | **2,5** | **4/4** | jediný konzistentní |
| Míra nezaměstnanosti (překvapení vs. konsenzus) | 0,08 | 1,5 | 3/4 | slabé |
| Mzdy (překvapení / trend) | 0,09 / 0,08 | 1,2 / 1,1 | 3/4 | slabé, 2026 záporné |
| Reálný výnos | 0,06 | 0,9 | 4/4 | slabé, konzistentní znaménko |
| **Změna zaměstnanosti (NFP, Employment Change) trend / překvapení** | **−0,03 / 0,01** | −0,4 / 0,1 | 2/4 | **žádná informace** (USD: −0,03 / 0,04) |
| HDP, spotřeba, PMI (výroba), politika CB, důvěra, obchodní bilance, průmysl, inflace (úroveň i trend), sazbový rozdíl (carry), staré skóre z překvapení | −0,08 … 0,01 | |t| < 1,5 | 0–3/4 | žádná informace |
| Produkce (celý index state-v1) | 0,08 | 1,5 | 3/4 | |

Detail USD (časová řada): míra nezaměstnanosti trend 0,29 a překvapení 0,30; NFP trend −0,03 a překvapení 0,04.

Kombinace (výběr na tréninku 2023–2024, 838 podmnožin; hodnocení na testu 2025–2026): produkce trénink 0,11 → test 0,05; **jen trh práce 0,13 → 0,16 (t 2,1)**; trh práce + reálný výnos 0,13 → 0,15 (rank-IC test 0,17); všechny ukazatele rovné váhy 0,06 → −0,01. Nejlepší tréninková kombinace 0,21 → test 0,11; medián přes všech 838: trénink 0,12 → test 0,05 (typický propad po výběru).

Omezení: čtyři roky, osm měn; při ~25 testovaných ukazatelích je t ≈ 2,5 u nejlepšího jen hraniční po korekci na vícenásobné testování (asi 1 ku 4, že by náhodná sada dala něco takového); signály jsou jedna z mnoha možných definic (trend proti 3 posledním tiskům, znaménko překvapení); horizonty 1/4/13 týdnů — okamžitou reakci ceny na NFP v řádu hodin až dnů to nezachycuje.
