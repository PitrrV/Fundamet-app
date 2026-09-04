-- Bod #7 z post-fix auditu (ChatGPT/Cowork Opus, 4.9.2026) — appka dosud viděla jen MINULÁ
-- sazbová rozhodnutí. Nadcházející rozhodnutí s validním tržním konsensem (`estimate`) appka
-- do teď ignorovala úplně, i když ta data už scrapuje — živě potvrzeno: EUR má 10.9.2026
-- "Main Refinancing Rate" s estimate 2,65 % proti aktuálním 2,40 % (validní konsensus na hike),
-- appka o tom ale na třech místech mlčela.
--
-- DŮLEŽITÉ: čistě informační sloupec pro UI/narrative (viz upcomingRateDecision, cb-policy.mjs).
-- NIKDY se nepoužívá jako vstup do policy_score/cb_policy_adj/real_yield_adj/overall_score —
-- ty všechny zůstávají výhradně z MINULÝCH rozhodnutí, přesně jak byly předtím.
alter table cb_policy_state add column if not exists upcoming_decision jsonb;
