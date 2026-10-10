# Změna: falešná upozornění kvality dat (category_expectations) — 10. 10. 2026

Schváleno uživatelem jako krok 1 první etapy. **Mění jen data v tabulce `category_expectations`, žádný kód ani výpočet skóre.**

## Proč
Tabulka měla pro všechny měny stejnou očekávanou frekvenci vydání (32 dní). U NZD vycházejí tyto řady **čtvrtletně**, takže `data-quality.mjs` hlásil „chybí" i při úplných datech (NZD skóre kvality 35).

## Původní → nová hodnota (`expected_frequency_days`)
| Měna | Kategorie | Původně | Nově | Důvod (ověřeno v kalendáři) |
|---|---|---|---|---|
| NZD | Inflation | 32 | 95 | CPI q/q – 4 výskyty za 13 měsíců, čtvrtletní |
| NZD | Labor -Unemployment | 32 | 95 | Unemployment Rate – čtvrtletně (poslední 5. 8.) |
| NZD | Labor +Jobs | 32 | 95 | Employment Change q/q – čtvrtletně (poslední 5. 8.) |
| NZD | Retail Sales | 32 | 95 | Retail Sales q/q – čtvrtletně (poslední 24. 8.; falešný poplach hrozil kolem 18. 10.) |
| NZD | Interest Rates | 42 | 60 | RBNZ má letní pauzu 84 dní (26. 11. 2025 → 18. 2. 2026); s prahem 63 dní by naskočil falešný poplach na přelomu roku |

## Co zůstává záměrně beze změny (strukturální nepřítomnost v datech, ne chyba kadence)
- NZD PMI – ForexFactory nemá PMI pro NZD; skóre používá BusinessNZ Manufacturing/Services Index (řada, kterou kategorie PMI nevidí).
- AUD Retail Sales – ForexFactory ho už nepublikuje (nahrazeno Household Spending m/m).
- CHF Labor +Jobs – ForexFactory nemá švýcarskou zaměstnanost.
Tato upozornění jsou pravdivá (kategorie v datech není), zůstávají viditelná a čekají na tvé rozhodnutí.

## Kontrola, že skutečná upozornění nezmizela
Simulace nad skutečnými daty (`data-quality.mjs` logika, NZD): viz report. Kompromis: při uvíznutí čtvrtletní řady se upozornění objeví později (po 142 dnech místo 48); tuto mezeru kryje příznak `pending_actual_overdue` (událost proběhla bez `actual`) a nový hlídač děr (krok 2).

## Vrácení změny (rollback)
```sql
update category_expectations set expected_frequency_days = 32 where currency_code='NZD' and category in ('Inflation','Labor -Unemployment','Labor +Jobs','Retail Sales');
update category_expectations set expected_frequency_days = 42 where currency_code='NZD' and category='Interest Rates';
```
Celá původní tabulka: `data/backup/category_expectations-2026-10-10.json`.
