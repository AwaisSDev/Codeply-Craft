-- Iris: private model storage and counts-only telemetry.
-- Run once in the Supabase SQL editor (project zswkhfkfseclgadhvobg). Safe to run again.

-- 1. The model files live in a PRIVATE bucket. Nobody can list or read it anonymously;
--    a signed-in user can ask for a short-lived signed link to one file (iris-install.js
--    asks for 15 minutes). Upload the GGUF to models/iris/iris-1.gguf from the dashboard
--    or with the service role, never from the app.
insert into storage.buckets (id, name, public, file_size_limit)
values ('models', 'models', false, 4294967296)
on conflict (id) do update set public = false;

drop policy if exists "signed-in users can read Iris" on storage.objects;
create policy "signed-in users can read Iris"
  on storage.objects for select to authenticated
  using (bucket_id = 'models' and (storage.foldername(name))[1] = 'iris');

-- 2. Counts from testers who turned on "Help improve Iris": numbers only, never text.
create table if not exists public.iris_events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  model text not null default '',
  model_sha256 text not null default '',
  contract text not null default '',
  counts jsonb not null default '{}'::jsonb
);
create index if not exists iris_events_created on public.iris_events (created_at desc);

alter table public.iris_events enable row level security;

-- A user can add their own rows and read them back; nobody can change or read anyone else's.
drop policy if exists "add own iris counts" on public.iris_events;
create policy "add own iris counts" on public.iris_events
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "read own iris counts" on public.iris_events;
create policy "read own iris counts" on public.iris_events
  for select to authenticated using (user_id = auth.uid());

-- Keep rows small: counts is a handful of numbers.
alter table public.iris_events drop constraint if exists iris_events_counts_small;
alter table public.iris_events add constraint iris_events_counts_small check (pg_column_size(counts) < 4096);
