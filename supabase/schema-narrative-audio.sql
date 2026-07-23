-- Předčítání shrnutí příběhu — OpenAI TTS (tts-1), generováno vedle textu v generate-narrative.mjs
-- a uloženo do veřejného Storage bucketu, aby na něj frontend mohl rovnou odkázat <audio> tagem.

insert into storage.buckets (id, name, public)
values ('narrative-audio', 'narrative-audio', true)
on conflict (id) do nothing;

drop policy if exists "public read narrative-audio" on storage.objects;
create policy "public read narrative-audio" on storage.objects
  for select using (bucket_id = 'narrative-audio');

alter table narratives add column if not exists audio_url text;

-- latest_narratives je view přes `select *` — zamyká sloupce v čase vytvoření (stejná past
-- past chyba jako u latest_confluence_scores dřív v projektu). Bez tohohle by frontend
-- nový audio_url sloupec vůbec neviděl.
create or replace view latest_narratives as
  select distinct on (currency_code) *
  from narratives
  order by currency_code, generated_at desc;
