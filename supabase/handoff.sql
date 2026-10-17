-- Local <-> cloud handoff (codeply-cli/lib/handoff.mjs, handoff-desktop.js).
-- Run once in the Supabase SQL editor. Needs the pg_cron, pg_net and
-- supabase_vault extensions (Database -> Extensions).
--
-- run_leases: one row per chat that has a protected run. The PC renews it
-- every 15 s (handoff_beat, server clock). The watchdog (edge function
-- handoff-watchdog, called by pg_cron every 30 s) claims rows that went 60 s
-- without a renewal and starts the cloud run.

create table if not exists public.run_leases (
  session_id    text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_id     text,
  device_name   text,
  holder        text not null default 'pc' check (holder in ('pc', 'cloud', 'none')),
  epoch         integer not null default 1,
  state         text not null default 'running', -- running | done | stopped | handed_back | cloud_failed | no_credentials
  beat_at       timestamptz not null default now(),
  repo          text not null,
  base          text not null default 'main',
  kind          text not null default 'mirror',
  project_name  text,
  mode          text not null default 'Build',
  wip_sha       text,          -- the last WIP commit the PC pushed (where the cloud starts)
  cloud_task_id text,
  cloud_from_sha text,         -- wip_sha when the cloud took over (the hand-back diff starts here)
  dispatched_at timestamptz,
  note          text,
  updated_at    timestamptz not null default now()
);
create index if not exists run_leases_stale on public.run_leases (beat_at) where holder = 'pc' and state = 'running';

alter table public.run_leases enable row level security;
-- The account's own PCs and phones read their rows. Writes go through the functions below.
drop policy if exists "own leases" on public.run_leases;
create policy "own leases" on public.run_leases for select using (auth.uid() = user_id);

-- Start (or restart) a protected run on this PC. Refused while the cloud holds
-- the chat, unless p_takeover (the PC just took it back).
create or replace function public.handoff_begin(
  p_session_id text, p_device_id text, p_device_name text, p_repo text, p_base text, p_kind text,
  p_project_name text, p_mode text, p_wip_sha text, p_takeover boolean default false
) returns integer language plpgsql security definer set search_path = public as $$
declare cur public.run_leases; next_epoch integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into cur from public.run_leases where session_id = p_session_id for update;
  if found and cur.user_id <> auth.uid() then raise exception 'not your chat'; end if;
  if found and cur.holder = 'cloud' and cur.state = 'running' and not p_takeover then
    raise exception 'cloud holds this chat';
  end if;
  next_epoch := coalesce(cur.epoch, 0) + 1;
  insert into public.run_leases as l (session_id, user_id, device_id, device_name, holder, epoch, state, beat_at, repo, base, kind, project_name, mode, wip_sha, cloud_task_id, cloud_from_sha, dispatched_at, note, updated_at)
  values (p_session_id, auth.uid(), p_device_id, p_device_name, 'pc', next_epoch, 'running', now(), p_repo, coalesce(p_base, 'main'), coalesce(p_kind, 'mirror'), p_project_name, coalesce(p_mode, 'Build'), p_wip_sha, null, null, null, null, now())
  on conflict (session_id) do update set
    device_id = excluded.device_id, device_name = excluded.device_name, holder = 'pc', epoch = next_epoch, state = 'running',
    beat_at = now(), repo = excluded.repo, base = excluded.base, kind = excluded.kind, project_name = excluded.project_name,
    mode = excluded.mode, wip_sha = excluded.wip_sha, cloud_task_id = null, cloud_from_sha = null, dispatched_at = null, note = null, updated_at = now();
  return next_epoch;
end $$;

-- Renew. Returns the row; holder/epoch tell the PC whether it still holds the chat.
create or replace function public.handoff_beat(p_session_id text, p_epoch integer, p_wip_sha text default null)
returns public.run_leases language plpgsql security definer set search_path = public as $$
declare r public.run_leases;
begin
  update public.run_leases set beat_at = now(), wip_sha = coalesce(p_wip_sha, wip_sha), updated_at = now()
   where session_id = p_session_id and user_id = auth.uid() and holder = 'pc' and epoch = p_epoch and state = 'running'
   returning * into r;
  if not found then select * into r from public.run_leases where session_id = p_session_id and user_id = auth.uid(); end if;
  return r;
end $$;

-- Finish: done, stopped, or handed_back (the PC took the chat back and the cloud is finished with it).
create or replace function public.handoff_end(p_session_id text, p_epoch integer, p_state text)
returns void language sql security definer set search_path = public as $$
  update public.run_leases set holder = 'none', state = p_state, updated_at = now()
   where session_id = p_session_id and user_id = auth.uid() and epoch = p_epoch;
$$;

-- The watchdog's claim: every stale PC lease moves to the cloud in one statement,
-- so two watchdog calls can never claim the same row.
create or replace function public.handoff_claim_stale(p_stale_seconds integer default 60)
returns setof public.run_leases language sql security definer set search_path = public as $$
  update public.run_leases
     set holder = 'cloud', epoch = epoch + 1, dispatched_at = now(), cloud_from_sha = wip_sha,
         cloud_task_id = to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint) || substr(md5(random()::text), 1, 6),
         updated_at = now()
   where holder = 'pc' and state = 'running' and wip_sha is not null
     and beat_at < now() - make_interval(secs => p_stale_seconds)
  returning *;
$$;

create or replace function public.handoff_mark(p_session_id text, p_state text, p_note text)
returns void language sql security definer set search_path = public as $$
  update public.run_leases set state = p_state, note = p_note, updated_at = now() where session_id = p_session_id;
$$;

-- ─── GitHub access for the watchdog ──────────────────────────────────────
-- Either the Codeply GitHub App is installed on the repo (nothing stored per
-- user), or the user's own GitHub connection is kept here, encrypted in Vault.

create table if not exists public.handoff_tokens (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  secret_id  uuid not null,
  updated_at timestamptz not null default now()
);
alter table public.handoff_tokens enable row level security; -- no policies: only the functions below touch it

create or replace function public.handoff_save_token(p_token text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select secret_id into sid from public.handoff_tokens where user_id = auth.uid();
  if sid is null then
    sid := vault.create_secret(p_token, 'handoff_gh_' || auth.uid()::text, 'GitHub token for Craft cloud handoff');
    insert into public.handoff_tokens (user_id, secret_id) values (auth.uid(), sid);
  else
    perform vault.update_secret(sid, p_token);
    update public.handoff_tokens set updated_at = now() where user_id = auth.uid();
  end if;
end $$;

create or replace function public.handoff_forget_token()
returns void language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  select secret_id into sid from public.handoff_tokens where user_id = auth.uid();
  if sid is not null then
    delete from vault.secrets where id = sid;
    delete from public.handoff_tokens where user_id = auth.uid();
  end if;
end $$;

create or replace function public.handoff_has_token()
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.handoff_tokens where user_id = auth.uid());
$$;

-- Service role only (the watchdog).
create or replace function public.handoff_token_for(p_user_id uuid)
returns text language sql security definer set search_path = public, vault as $$
  select s.decrypted_secret from public.handoff_tokens t join vault.decrypted_secrets s on s.id = t.secret_id where t.user_id = p_user_id;
$$;

revoke all on function public.handoff_claim_stale(integer) from public, anon, authenticated;
revoke all on function public.handoff_mark(text, text, text) from public, anon, authenticated;
revoke all on function public.handoff_token_for(uuid) from public, anon, authenticated;
grant execute on function public.handoff_claim_stale(integer), public.handoff_mark(text, text, text), public.handoff_token_for(uuid) to service_role;
grant execute on function public.handoff_begin(text, text, text, text, text, text, text, text, text, boolean), public.handoff_beat(text, integer, text),
  public.handoff_end(text, integer, text), public.handoff_save_token(text), public.handoff_forget_token(), public.handoff_has_token() to authenticated;

-- ─── The schedule ───────────────────────────────────────────────────────
-- Store the watchdog's URL and a random secret in Vault first (the same secret
-- goes in the function's HANDOFF_CRON_SECRET):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/handoff-watchdog', 'handoff_watchdog_url');
--   select vault.create_secret('<random secret>', 'handoff_cron_secret');
select cron.unschedule('handoff-watchdog') where exists (select 1 from cron.job where jobname = 'handoff-watchdog');
select cron.schedule('handoff-watchdog', '30 seconds', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'handoff_watchdog_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'handoff_cron_secret')),
    body := '{}'::jsonb
  ) where exists (select 1 from public.run_leases where holder = 'pc' and state = 'running' and beat_at < now() - interval '60 seconds');
$$);
