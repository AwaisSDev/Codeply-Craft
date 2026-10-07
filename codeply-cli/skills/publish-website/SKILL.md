---
name: publish-website
description: Publish the user's website or app end to end when they ask to publish, deploy or put it live. Decides whether a database is needed, sets up Supabase (project, URL and anon key in the app, schema with RLS), deploys to Vercel, optionally links GitHub for automatic deploys, and returns the live link.
metadata:
  origin: Codeply
---

# Publish a website

Use this only when the user asked to publish, deploy, ship, host or put the
app live. Never start it on your own after building something; at most offer
it in one line.

The user only connects Vercel and Supabase (and GitHub if they want it). You do
everything else. Keep replies short and in plain words.

## 1. Look first

Run `publish_check`. It reports the stack, the files, signs of a database,
which services are connected and what was published before.

## 2. Does it need a database?

Decide yourself, using the report and what you know about the app:

- Yes: sign-in or sign-up, data that must be saved and seen again later or by
  other visitors (notes, orders, comments, bookings), code that already uses
  Supabase, a schema or `.sql` file.
- No: a brochure site, a portfolio, a landing page, a game that keeps nothing,
  a contact form that only needs to send an email.
- Data kept only in `localStorage` works without a database; ask the user only
  if it is unclear whether they want it shared across devices.

If no database is needed, skip to step 4.

## 3. Supabase

1. If Supabase is not connected, call `publish_connect` with
   `<service>supabase</service>` and one sentence on why. It shows a Connect
   button and waits. When it returns connected, carry on at once without asking
   again. If the user skips it, publish without a database only if the app
   still works; otherwise stop and explain.
2. Call `supabase_setup`. It asks the user to pick an existing project or
   create a new one (creating asks first and warns when it may cost money),
   then writes the project URL and anon key where the stack reads them:
   `env.js` for a plain HTML site, `.env` with `VITE_` for Vite,
   `.env.local` with `NEXT_PUBLIC_` for Next.js, and so on.
3. Make sure the code actually uses those values (`supabase.createClient(url,
   anonKey)`). Edit the app if it uses placeholders or hardcoded values. The
   service role key never goes into client code.
4. If the app needs tables, write the SQL with policies and run it with
   `supabase_schema`. The user sees the SQL and approves it. RLS is switched on
   for every new table; write `create policy` statements so the app can read
   and write what it should (usually rows owned by `auth.uid()`).

## 4. Vercel

1. If Vercel is not connected, call `publish_connect` with
   `<service>vercel</service>`.
2. Call `publish_deploy`. Before the first deploy it asks the user
   "Connect GitHub so pushes deploy automatically?".
   - Yes: it tells you to run `publish_github` (connect GitHub first with
     `publish_connect` if needed), which creates or reuses the repo, pushes and
     links it to Vercel. Then call `publish_deploy` again.
   - No: it deploys directly.
3. `publish_deploy` uploads the files, sets the Supabase env vars on the
   Vercel project, and waits until the deployment is READY.
4. If the build fails, the result has the build log. Fix the real cause, check
   it locally if you can (`npm run build`), and call `publish_deploy` once more.
   If it fails a second time, stop and tell the user what failed in plain words.

## 5. Finish

Reply with the live URL exactly as `publish_deploy` returned it, one line on
what was set up (database, GitHub auto-deploy), and nothing invented. Never
print tokens or keys.
