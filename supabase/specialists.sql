-- Codeply specialists in the user's account (2026-11-06).
-- The PC, the phone and the server timer all read and write these, so a
-- specialist made on one shows up on the others, and an always-on
-- specialist's jobs run on time with the PC off (specialists-tick, run by
-- pg_cron: see specialists_cron.sql).
--
--   specialists       one row per specialist: the ones you made (id = its slug)
--                     and your settings on the built-in ones (id = 'builtin:<id>').
--   specialist_jobs   standing jobs ("every Monday at 9, check ..."). next_at is
--                     the source of truth for when a job runs; a device claims a
--                     run (claimed_by / claimed_until) so it never runs twice.
--   specialist_runs   what each run did, wherever it ran (pc, cloud or phone).
--
-- Run once in the Supabase SQL editor (safe to run again).

create table if not exists public.specialists (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  data jsonb not null default '{}'::jsonb,       -- name, focus, instructions, voice, shape, color, gear, model, ...
  always_on boolean not null default false,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.specialist_jobs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  specialist text not null,
  data jsonb not null default '{}'::jsonb,       -- task, when, rule, tz, cwd, runs, lastAt, lastError, ...
  next_at timestamptz,
  claimed_by text,
  claimed_until timestamptz,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists specialist_jobs_due on public.specialist_jobs (next_at) where not deleted;

create table if not exists public.specialist_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  job_id text,
  specialist text not null,
  task text not null default '' check (char_length(task) <= 2000),
  output text not null default '' check (char_length(output) <= 20000),
  ok boolean not null default true,
  origin text not null default 'pc' check (origin in ('pc', 'cloud', 'phone')),
  at timestamptz not null default now()
);
create index if not exists specialist_runs_user_at on public.specialist_runs (user_id, at desc);

alter table public.specialists enable row level security;
alter table public.specialist_jobs enable row level security;
alter table public.specialist_runs enable row level security;

drop policy if exists "specialists: own rows" on public.specialists;
create policy "specialists: own rows" on public.specialists
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "specialist_jobs: own rows" on public.specialist_jobs;
create policy "specialist_jobs: own rows" on public.specialist_jobs
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "specialist_runs: own rows" on public.specialist_runs;
create policy "specialist_runs: own rows" on public.specialist_runs
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
