-- Ruční editace "actual" přímo v appce — jen pro účet administrátora (ověřeno podle
-- e-mailu v JWT), ne pro veřejnost. Bezpečnost je vynucená na úrovni databáze (RLS +
-- sloupcové oprávnění), ne jen v UI — i kdyby někdo obešel frontend (devtools apod.),
-- zápis pod jiným účtem nebo do jiného sloupce selže přímo v Postgresu.
--
-- Předpokládá, že v Supabase Authentication je zapnutý Email provider (magic link) —
-- to je v novém projektu zapnuté ve výchozím nastavení, není potřeba nic měnit.

-- Sloupcové oprávnění: přihlášení uživatelé smí UPDATE pouze actual/updated_at,
-- nic jiného (ne currency_code/event_title/estimate/impact/...), i kdyby RLS policy
-- níže měla chybu — druhá nezávislá vrstva ochrany.
grant update (actual, updated_at) on calendar_events to authenticated;

drop policy if exists "admin can update actual" on calendar_events;
create policy "admin can update actual" on calendar_events
  for update
  to authenticated
  using (lower(auth.jwt() ->> 'email') = 'p.vospalek@gmail.com')
  with check (lower(auth.jwt() ->> 'email') = 'p.vospalek@gmail.com');
