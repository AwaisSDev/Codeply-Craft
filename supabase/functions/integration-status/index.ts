// integration-status: lets the phone read Supabase's management API, which doesn't answer
// browsers (no CORS for codeply.app). Read-only and narrow on purpose:
//   - the caller must be signed in to Codeply (their own access token);
//   - only GET /v1/projects, /v1/projects/<ref> and /v1/projects/<ref>/health are passed on;
//   - the Supabase sign-in comes from the caller (the phone has it from the connections
//     function); nothing is stored here. When it has expired and a refresh token is sent,
//     the token is renewed for this call only.
// The reply is { status, json } with Supabase's own status code and body, so the phone can show
// exactly what Supabase said.
// Deploy: supabase functions deploy integration-status
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const url = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const API = 'https://api.supabase.com';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const ALLOWED = /^\/v1\/projects(\/[a-z0-9]{20}(\/health(\?(services=(auth|db|rest|storage|realtime|pooler)&?)+)?)?)?$/;

async function call(path: string, token: string) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 300) }; }
  return { status: r.status, body };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only.' });
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!auth) return json(401, { error: 'Sign in first.' });
  const { data, error } = await admin.auth.getUser(auth);
  if (error || !data?.user) return json(401, { error: 'Your sign-in expired. Sign in again.' });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (body.app !== 'supabase') return json(400, { error: 'Only Supabase is supported.' });
  const path = String(body.path || '');
  if (!ALLOWED.test(path)) return json(400, { error: 'That Supabase path is not allowed here.' });
  const token = String(body.token || '');
  if (!token) return json(400, { error: 'No Supabase sign-in was sent.' });

  let res = await call(path, token);
  const ref = body.refresh;
  if (res.status === 401 && ref && ref.refreshToken && ref.clientId && ref.clientSecret) {
    const r = await fetch(`${API}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${ref.clientId}:${ref.clientSecret}`)}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(ref.refreshToken) }),
      signal: AbortSignal.timeout(15_000),
    });
    const t = await r.json().catch(() => ({}));
    if (r.ok && t.access_token) res = await call(path, t.access_token);
  }
  return json(200, { status: res.status, json: res.body });
});
