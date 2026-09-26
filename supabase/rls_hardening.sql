-- Codeply: RLS hardening (2026-09-27)
-- 1. Users could set profiles.is_admin = true on their own row (column UPDATE
--    grant + an UPDATE policy on their own row) and become admin.
--    Postgres checks column privileges before RLS, so limiting the grant closes it.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, avatar_url, country, referral_source, starter_provider, updated_at)
  on public.profiles to authenticated;

-- 2. Admin analytics functions were callable by anyone with the public anon key.
revoke execute on function public.active_users(integer) from public, anon;
revoke execute on function public.usage_by_hour(integer) from public, anon;
revoke execute on function public.usage_by_model(integer, integer) from public, anon;
revoke execute on function public.users_by_country(integer) from public, anon;

-- 3. Duplicate policies (same rule twice) removed for clarity; behavior unchanged.
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Users can read own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Anyone can read app_config" on public.app_config;
