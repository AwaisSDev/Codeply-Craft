// handoff-watchdog: starts Craft Cloud for runs whose PC went quiet.
//
// pg_cron calls this every 30 s while some lease is stale (supabase/handoff.sql).
// It claims every PC lease with no renewal for 60 s (one SQL statement, so a
// row is never claimed twice) and dispatches craft-cloud.yml with
// handoff=resume on the chat's repo. The runner checks out craft/wip-<chat>,
// reads the saved state and carries on.
//
// GitHub access, per repo: the Codeply GitHub App when it is installed there
// (a token that lasts an hour and only covers the repos the user picked),
// otherwise the user's own GitHub connection, if they keep it in Vault.
//
// A signed-in user can also ask { action: "app", repo } to learn whether the
// App is installed on a repo (the Cloud sheet shows it).
//
// Secrets (supabase secrets set ...): HANDOFF_CRON_SECRET, and for the App
// GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (the .pem GitHub gives you).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const STALE_SECONDS = 60;
const WORKFLOW = 'craft-cloud.yml';
const GH = 'https://api.github.com';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function gh(token: string, method: string, path: string, body?: unknown, scheme = 'token') {
  const r = await fetch(`${GH}${path}`, {
    method,
    headers: { Authorization: `${scheme} ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'codeply-handoff', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

// ─── GitHub App token ───────────────────────────────────────────────────

const b64url = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}

/** GitHub hands out PKCS#1 keys; Web Crypto wants PKCS#8. Wrap it. */
function pkcs8FromPem(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (pem.includes('BEGIN PRIVATE KEY')) return der;
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(der.length), ...der];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  return new Uint8Array([0x30, ...derLength(inner.length), ...inner]);
}

let appKey: CryptoKey | null = null;
async function appJwt(): Promise<string | null> {
  const id = Deno.env.get('GITHUB_APP_ID');
  const pem = Deno.env.get('GITHUB_APP_PRIVATE_KEY');
  if (!id || !pem) return null;
  if (!appKey) appKey = await crypto.subtle.importKey('pkcs8', pkcs8FromPem(pem.replace(/\\n/g, '\n')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', appKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

/** An installation token for the repo, or null when the App is not installed there. */
async function appToken(repo: string): Promise<string | null> {
  const jwt = await appJwt();
  if (!jwt) return null;
  const inst = await gh(jwt, 'GET', `/repos/${repo}/installation`, undefined, 'Bearer');
  if (inst.status !== 200) return null;
  const tok = await gh(jwt, 'POST', `/app/installations/${inst.data.id}/access_tokens`, { repositories: [repo.split('/')[1]] }, 'Bearer');
  return tok.status === 201 ? tok.data.token : null;
}

async function tokenFor(row: any): Promise<{ token: string; via: string } | null> {
  const app = await appToken(row.repo).catch(() => null);
  if (app) return { token: app, via: 'app' };
  const { data } = await admin.rpc('handoff_token_for', { p_user_id: row.user_id });
  return data ? { token: data as string, via: 'user' } : null;
}

// ─── The watchdog ───────────────────────────────────────────────────────

async function dispatch(row: any) {
  const access = await tokenFor(row);
  if (!access) {
    await admin.rpc('handoff_mark', { p_session_id: row.session_id, p_state: 'no_credentials', p_note: 'No GitHub access for the cloud: connect GitHub in Codeply or install the Codeply GitHub app.' });
    return { session: row.session_id, ok: false, why: 'no credentials' };
  }
  const r = await gh(access.token, 'POST', `/repos/${row.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    ref: row.base || 'main',
    inputs: { prompt: 'Carry on the task from the PC', mode: row.mode || 'Build', task_id: row.cloud_task_id, session_id: row.session_id, handoff: 'resume' },
  });
  if (r.status !== 204) {
    const note = `GitHub refused to start the cloud run (${r.status}${r.data && r.data.message ? `: ${r.data.message}` : ''}).`;
    await admin.rpc('handoff_mark', { p_session_id: row.session_id, p_state: 'cloud_failed', p_note: note });
    return { session: row.session_id, ok: false, why: note };
  }
  return { session: row.session_id, ok: true, via: access.via, task: row.cloud_task_id };
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') || '';
  const body = await req.json().catch(() => ({}));

  // A signed-in user asking whether the App covers a repo.
  if (body && body.action === 'app') {
    const { data } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
    if (!data || !data.user) return json(401, { error: 'Sign in first.' });
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(body.repo || ''))) return json(400, { error: 'Which repo?' });
    const jwt = await appJwt().catch(() => null);
    if (!jwt) return json(200, { configured: false, installed: false });
    const inst = await gh(jwt, 'GET', `/repos/${body.repo}/installation`, undefined, 'Bearer');
    return json(200, { configured: true, installed: inst.status === 200 });
  }

  const secret = Deno.env.get('HANDOFF_CRON_SECRET');
  if (!secret || auth !== `Bearer ${secret}`) return json(401, { error: 'unauthorized' });
  const { data: rows, error } = await admin.rpc('handoff_claim_stale', { p_stale_seconds: STALE_SECONDS });
  if (error) return json(500, { error: error.message });
  const results = [];
  for (const row of rows || []) results.push(await dispatch(row).catch((e) => ({ session: row.session_id, ok: false, why: String(e) })));
  return json(200, { claimed: results.length, results });
});
