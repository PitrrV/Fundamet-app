-- Perzistentní stav backoffu pro externí scrapery (ForexFactory kalendář, 10.9.2026).
-- Každý běh GH Actions je čerstvý proces bez paměti mezi běhy — počítadlo po sobě
-- jdoucích 403 a cooldown okno musí přežít mezi cron spuštěními, proto v DB, ne v paměti.
-- Jediný spotřebitel je service-key skript (fetch-calendar.mjs), žádná veřejná policy.
create table if not exists scraper_backoff_state (
  scraper text primary key,
  consecutive_failures int not null default 0,
  cooldown_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table scraper_backoff_state enable row level security;
