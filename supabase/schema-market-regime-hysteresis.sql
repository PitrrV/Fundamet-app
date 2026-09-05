-- Post-audit oprava B (5.9.2026): hystereze pro překlápění risk režimu (RISK_ON/NEUTRAL/
-- RISK_OFF), aby VIX kolísající na hraně prahu 15/20 nezpůsoboval přepínání každých 15 minut.
-- Viz scripts/fetch-calendar.mjs, REGIME_HYSTERESIS_CONFIRMATIONS.
alter table market_regime add column if not exists pending_regime text;
alter table market_regime add column if not exists pending_regime_count integer not null default 0;
