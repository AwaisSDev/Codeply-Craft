-- Codeply Design: designs synced between Craft on the PC and the phone app (2026-10-15).
-- A design is a row here (its title, kind and its chat in short) plus its files in
-- the private "designs" storage bucket under <user id>/<design id>/ (index.html, assets/...).
-- Run once in the Supabase SQL editor.

create table if not exists public.designs (
  id text primary key check (char_length(id) between 4 and 40),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Untitled design' check (char_length(title) <= 160),
  kind text not null default 'website' check (kind in ('website', 'app', 'slides', 'doc', 'poster', 'social', 'logo')),
  summary text not null default '' check (char_length(summary) <= 400),
  -- the conversation in short, so either device can show and continue it:
  -- [{ "role": "user" | "assistant", "text": "...", "at": 1760000000000 }]
  chat jsonb not null default '[]'::jsonb,
  origin text not null default 'pc' check (origin in ('pc', 'phone')),
  version integer not null default 1,            -- goes up every time index.html changes
  deleted boolean not null default false,        -- deleted on one device: the other removes it too
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists designs_user_updated on public.designs (user_id, updated_at desc);

alter table public.designs enable row level security;
drop policy if exists "Users manage their own designs" on public.designs;
create policy "Users manage their own designs" on public.designs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Files: a private bucket; each user reads and writes only their own folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('designs', 'designs', false, 10485760)
on conflict (id) do nothing;

drop policy if exists "Users read their own design files" on storage.objects;
create policy "Users read their own design files" on storage.objects
  for select to authenticated
  using (bucket_id = 'designs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users add their own design files" on storage.objects;
create policy "Users add their own design files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'designs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users change their own design files" on storage.objects;
create policy "Users change their own design files" on storage.objects
  for update to authenticated
  using (bucket_id = 'designs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users delete their own design files" on storage.objects;
create policy "Users delete their own design files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'designs' and (storage.foldername(name))[1] = auth.uid()::text);
