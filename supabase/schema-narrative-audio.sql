-- Předčítání shrnutí příběhu — OpenAI TTS (tts-1), generováno vedle textu v generate-narrative.mjs
-- a uloženo do veřejného Storage bucketu, aby na něj frontend mohl rovnou odkázat <audio> tagem.

insert into storage.buckets (id, name, public)
values ('narrative-audio', 'narrative-audio', true)
on conflict (id) do nothing;

drop policy if exists "public read narrative-audio" on storage.objects;
create policy "public read narrative-audio" on storage.objects
  for select using (bucket_id = 'narrative-audio');

alter table narratives add column if not exists audio_url text;
