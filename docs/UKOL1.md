# Úkol 1 — zvýšení důvěryhodnosti aplikace (plán uložen 9. 10. 2026)

**Stav: PŘIPRAVENO, ČEKÁ NA POKYN.** Nezačínat, dokud uživatel nenapíše **„vracíme se k úkolu1"** (případně „vracime se k ukolu1 !"). Teprve pak se plán rozjede. Do té doby se na něm nic nedělá.

## Cíl
Čísla v aplikaci (sazby, CPI, skóre, texty) musí být ověřitelná proti primárním zdrojům a rozpor s realitou se musí ukázat sám, ne náhodou. Pravidlo 6 v `docs/SPRAVCE.md` (aplikace musí být důvěryhodná, přístup senior analytika).

## Doporučené pořadí
| # | Krok | Co řeší | Mění skóre? | Práce |
|---|---|---|---|---|
| 1 | Zkušební čtení oficiálních zdrojů z GitHub Actions (jen čtení; vypíše poslední hodnotu z každého zdroje) | Zjistí, které zdroje jsou dosažitelné a v jakém formátu; rozhodne o kroku 3 | Ne | hodiny |
| 2 | Hlídač děr a čerstvosti dat: denní kontrola počtu událostí po týdnech, chybějících zasedání centrálních bank a expirace záložního CPI | Díra z června 2026 by se našla hned; upozorní na blížící se expiraci CPI pro CAD, CHF, NZD | Ne | 1 den |
| 3 | Referenční tabulka (`reference_macro`) a denní porovnání s oficiálními zdroji (sazby a CPI všech 8 měn, zdroj a datum u každé hodnoty) | Rozpor aplikace s realitou se ukáže v denním reportu; záložní CPI jde obnovovat automaticky nebo s upozorněním | Ne (alarm) | 2–3 dny |
| 4 | Automatická kontrola čísel v textech příběhů před uložením (číslo a datum v textu vs. podklady) | Zachytí chyby, které dnešní kontroly nepokryjí | Ne | 1–2 dny |
| 5 | Plánovaný denní běh (Routine) s kroky 2–4 a krátkým reportem; předtím změřit spotřebu limitu | Kontrola se děje sama | Ne | půl dne |
| 6 | Poctivější zobrazení v aplikaci: zdroj a stáří u čísel, upozornění „skóre blízko hrany pásma", hlavně pásmo místo desetinného čísla | Uživatel vidí, kolik jistoty skóre má | Ne (jen UI) — vyžaduje souhlas s vzhledem | 2–3 dny |
| 7 | Měření na nových datech: měsíční rank-IC jen z dat po 9. 10. 2026, postup popsán předem, žádné ladění vah | Jediný skutečný out-of-sample důkaz | Ne | 1 den + průběžně |

## Zásady
- Kroky 1–5 a 7 skóre nemění. Vzorec skóre se nemění, dokud krok 7 nenasbírá data (pravidlo 4).
- Primární zdroje (StatCan, BFS, Stats NZ, …) jsou z cloudového prostředí nedostupné (DNS); proto krok 1 běží v GitHub Actions.
- Číslo, které nejde ověřit primárně, se bere jen při potvrzení dvěma nezávislými zdroji nebo křížovou kontrolou složením měsíčních/čtvrtletních změn z kalendáře (osvědčilo se 9. 10.: CAD 3,03 %, CHF 1,00 %, NZD 4,06 %). Jinak „nemáme".

## Potřeba od uživatele při rozjezdu
1. Souhlas s kroky 1 a 2 (bezpečné, nic nemění).
2. Pro krok 3 případně API klíč k BLS jako GitHub secret (nikdy do chatu).
3. Kam má jít výstup kroku 5: jen report v chatu, nebo i oznámení.

## Co už je hotovo (kontext, 9. 10. 2026)
Záložní CPI pro CHF/CAD/NZD (`data/reference-cpi.json`), JPY z národního Core CPI, doplněná díra v kalendáři (týden od 8. 6.), texty příběhů přepsané. Ruční obnova záložního CPI po vydáních: CAD 19. 10., NZD 21. 10., JPY národní 22./23. 10., CHF začátkem listopadu (dokud nebude hotový krok 3).
