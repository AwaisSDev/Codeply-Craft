-- Local <-> cloud handoff, resilience (run after handoff.sql; safe to run again).
-- Run once in the Supabase SQL editor, BEFORE deploying the new handoff-watchdog.
--
--   * the cloud runner renews its lease too (handoff_cloud_beat, called by the
--     watchdog's "cloud_beat" action), and a dead cloud runner is replaced
--   * dispatching the cloud run is retried with backoff instead of once
--   * a lease with no WIP yet can be resumed from the base branch
--   * a final failure leaves a plain-words notice on the row

alter table public.run_leases add column if not exists attempt integer not null default 0;            -- dead cloud runners replaced so far
alter table public.run_leases add column if not exists dispatch_attempts integer not null default 0;  -- tries to start the cloud run so far
alter table public.run_leases add column if not exists next_try_at timestamptz;                       -- when the next dispatch try is due (state dispatch_retry)
alter table public.run_leases add column if not exists prompt text;                                   -- the run's request, for resuming without a WIP commit
alter table public.run_leases add column if not exists notice text;                                   -- plain words for the person after a final failure
alter table public.run_leases add column if not exists notice_at timestamptz;

-- States: running | done | stopped | handed_back | cloud_failed | no_credentials   (from handoff.sql)
--         dispatch_retry (the cloud run could not be started yet, next_try_at says when we try again)
--         cloud_done     (the cloud runner finished; the PC picks the work up and ends the lease as handed_back)
create index if not exists run_leases_cloud_stale on public.run_leases (beat_at) where holder = 'cloud' and state = 'running';
create index if not exists run_leases_retry on public.run_leases (next_try_at) where holder = 'cloud' and state = 'dispatch_retry';

-- Same as handoff.sql's handoff_begin, and a new run starts with clean retry counters.
create or replace function public.handoff_begin(
  p_session_id text, p_device_id text, p_device_name text, p_repo text, p_base text, p_kind text,
  p_project_name text, p_mode text, p_wip_sha text, p_takeover boolean default false
) returns integer language plpgsql security definer set search_path = public as $$
declare cur public.run_leases; next_epoch integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into cur from public.run_leases where session_id = p_session_id for update;
  if found and cur.user_id <> auth.uid() then raise exception 'not your chat'; end if;
  if found and cur.holder = 'cloud' and cur.state in ('running', 'dispatch_retry') and not p_takeover then
    raise exception 'cloud holds this chat';
  end if;
  next_epoch := coalesce(cur.epoch, 0) + 1;
  insert into public.run_leases as l (session_id, user_id, device_id, device_name, holder, epoch, state, beat_at, repo, base, kind, project_name, mode, wip_sha, cloud_task_id, cloud_from_sha, dispatched_at, note, updated_at, attempt, dispatch_attempts, next_try_at, prompt, notice, notice_at)
  values (p_session_id, auth.uid(), p_device_id, p_device_name, 'pc', next_epoch, 'running', now(), p_repo, coalesce(p_base, 'main'), coalesce(p_kind, 'mirror'), p_project_name, coalesce(p_mode, 'Build'), p_wip_sha, null, null, null, null, now(), 0, 0, null, null, null, null)
  on conflict (session_id) do update set
    device_id = excluded.device_id, device_name = excluded.device_name, holder = 'pc', epoch = next_epoch, state = 'running',
    beat_at = now(), repo = excluded.repo, base = excluded.base, kind = excluded.kind, project_name = excluded.project_name,
    mode = excluded.mode, wip_sha = excluded.wip_sha, cloud_task_id = null, cloud_from_sha = null, dispatched_at = null, note = null, updated_at = now(),
    attempt = 0, dispatch_attempts = 0, next_try_at = null, prompt = null, notice = null, notice_at = null;
  return next_epoch;
end $$;

-- The PC tells the server what the run is about, so the cloud can start it from the base branch if the PC dies before its first save.
create or replace function public.handoff_set_prompt(p_session_id text, p_epoch integer, p_prompt text)
returns void language sql security definer set search_path = public as $$
  update public.run_leases set prompt = left(p_prompt, 4000), updated_at = now()
   where session_id = p_session_id and user_id = auth.uid() and holder = 'pc' and epoch = p_epoch;
$$;

-- The watchdog's claim, version 2. One statement per case, so a row is never claimed twice.
--   1. a PC lease stale for p_stale_seconds           -> the cloud takes it (a new task id)
--   2. a cloud lease stale for p_cloud_stale_seconds  -> the runner is dead: a replacement is dispatched (same task id,
--                                                        new epoch, so the dead runner's token stops working); after
--                                                        p_max_reclaims replacements the lease fails with a notice
--   3. a lease in dispatch_retry whose next_try_at has passed -> try to start the cloud run again (same epoch)
-- beat_at is reset on every claim: the new runner gets p_cloud_stale_seconds to start and renew.
create or replace function public.handoff_claim_v2(
  p_stale_seconds integer default 60, p_cloud_stale_seconds integer default 180, p_max_reclaims integer default 2
) returns setof public.run_leases language plpgsql security definer set search_path = public as $$
begin
  update public.run_leases
     set state = 'cloud_failed', updated_at = now(), notice_at = now(),
         note = 'The cloud run stopped responding and could not be restarted.',
         notice = 'The cloud run stopped responding' || case when attempt > 0 then ' and was restarted ' || attempt || ' time' || case when attempt = 1 then '' else 's' end else '' end
                  || ', but it did not finish. Your work up to the last save is on a craft/wip-* branch of your repo, and the task carries on on your PC when it is back online.'
   where holder = 'cloud' and state = 'running' and attempt >= p_max_reclaims
     and beat_at < now() - make_interval(secs => p_cloud_stale_seconds);

  return query
  update public.run_leases l
     set holder = 'cloud',
         epoch = l.epoch + (case when l.state = 'dispatch_retry' then 0 else 1 end),
         state = 'running',
         dispatched_at = now(),
         beat_at = now(),
         next_try_at = null,
         cloud_from_sha = case when l.holder = 'pc' then l.wip_sha else l.cloud_from_sha end,
         cloud_task_id = case when l.holder = 'pc' then to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint) || substr(md5(random()::text), 1, 6) else l.cloud_task_id end,
         attempt = l.attempt + (case when l.holder = 'cloud' and l.state = 'running' then 1 else 0 end),
         dispatch_attempts = case when l.state = 'dispatch_retry' then l.dispatch_attempts else 0 end,
         note = null,
         updated_at = now()
   where (l.holder = 'pc' and l.state = 'running' and l.beat_at < now() - make_interval(secs => p_stale_seconds))
      or (l.holder = 'cloud' and l.state = 'running' and l.attempt < p_max_reclaims and l.beat_at < now() - make_interval(secs => p_cloud_stale_seconds))
      or (l.holder = 'cloud' and l.state = 'dispatch_retry' and l.next_try_at <= now())
  returning l.*;
end $$;

-- A dispatch try failed. p_delay_seconds null = give up (p_final_state: cloud_failed or no_credentials) and leave the notice.
create or replace function public.handoff_dispatch_failed(p_session_id text, p_epoch integer, p_note text, p_final_state text, p_delay_seconds integer)
returns void language sql security definer set search_path = public as $$
  update public.run_leases
     set dispatch_attempts = dispatch_attempts + 1,
         state = case when p_delay_seconds is null then p_final_state else 'dispatch_retry' end,
         next_try_at = case when p_delay_seconds is null then null else now() + make_interval(secs => p_delay_seconds) end,
         note = p_note,
         notice = case when p_delay_seconds is null then p_note else notice end,
         notice_at = case when p_delay_seconds is null then now() else notice_at end,
         updated_at = now()
   where session_id = p_session_id and epoch = p_epoch and holder = 'cloud';
$$;

-- The runner's renewal (through the watchdog's "cloud_beat" action, which checks the runner's token first).
-- Returns 'running' while this runner still owns the lease, 'finished' after p_finish, 'lost' when it does not
-- (a replacement was dispatched, the PC took the chat back, or it was already finished): the runner must stop.
create or replace function public.handoff_cloud_beat(p_session_id text, p_task_id text, p_epoch integer, p_finish boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare hit integer;
begin
  update public.run_leases
     set beat_at = now(), state = case when p_finish then 'cloud_done' else state end, updated_at = now()
   where session_id = p_session_id and holder = 'cloud' and cloud_task_id = p_task_id and epoch = p_epoch and state = 'running';
  get diagnostics hit = row_count;
  if hit = 0 then return 'lost'; end if;
  return case when p_finish then 'finished' else 'running' end;
end $$;

revoke all on function public.handoff_claim_v2(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.handoff_dispatch_failed(text, integer, text, text, integer) from public, anon, authenticated;
revoke all on function public.handoff_cloud_beat(text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.handoff_claim_v2(integer, integer, integer), public.handoff_dispatch_failed(text, integer, text, text, integer),
  public.handoff_cloud_beat(text, text, integer, boolean) to service_role;
grant execute on function public.handoff_set_prompt(text, integer, text) to authenticated;

-- The schedule: wake the watchdog when a PC lease is stale, a cloud lease is stale, or a dispatch retry is due.
select cron.unschedule('handoff-watchdog') where exists (select 1 from cron.job where jobname = 'handoff-watchdog');
select cron.schedule('handoff-watchdog', '30 seconds', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'handoff_watchdog_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'handoff_cron_secret')),
    body := '{}'::jsonb
  ) where exists (
    select 1 from public.run_leases
     where (holder = 'pc' and state = 'running' and beat_at < now() - interval '60 seconds')
        or (holder = 'cloud' and state = 'running' and beat_at < now() - interval '180 seconds')
        or (holder = 'cloud' and state = 'dispatch_retry' and next_try_at <= now())
  );
$$);
