-- Codeply chats in the user's account (2026-11-09), so a chat is the same on every device:
-- the phone app, mobile.codeply.app and codeply.app/chat (phone-sync.js).
--
--   chats   one row per chat: meta (title, kind, project, specialist, updatedAt...) and
--           body (messages, cloud tasks, the PC steps the phone saw). deleted = removed
--           on one device, so the others remove it too.
--
-- Only the signed-in user can read or write their rows (row level security).
-- Run once in the Supabase SQL editor (safe to run again).

create table if not exists public.chats (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  meta jsonb not null default '{}'::jsonb,
  body jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists chats_user_updated on public.chats (user_id, updated_at desc);

alter table public.chats enable row level security;
drop policy if exists "chats: own rows" on public.chats;
create policy "chats: own rows" on public.chats
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live updates: another device's change shows up at once (without this, devices still sync every 20 seconds).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chats') then
    alter publication supabase_realtime add table public.chats;
  end if;
exception when undefined_object then null; -- no realtime publication in this project
end $$;
