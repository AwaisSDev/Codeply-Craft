// delete-account: a signed-in user deletes their own Codeply account (the
// phone's Settings, Delete account; Apple requires it in the app).
//
// The caller's own access token says who they are; only that user is ever
// deleted. Rows that reference auth.users with ON DELETE CASCADE go with it.
// Needs the project's SUPABASE_SERVICE_ROLE_KEY (set for every function).
// Deploy: supabase functions deploy delete-account
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const url = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only.' });
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in first.' });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return json(401, { error: 'Your sign-in expired. Sign in again.' });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  // The phone sends the email the user typed to confirm; it has to match.
  if (String(body.confirm || '').trim().toLowerCase() !== String(data.user.email || '').toLowerCase()) {
    return json(400, { error: 'Type your email exactly to confirm.' });
  }
  const del = await admin.auth.admin.deleteUser(data.user.id);
  if (del.error) return json(500, { error: `Could not delete the account: ${del.error.message}` });
  return json(200, { ok: true });
});
