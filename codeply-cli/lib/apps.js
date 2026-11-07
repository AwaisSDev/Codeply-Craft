/**
 * Codeply Apps: connect any app that has a remote MCP server, the way ChatGPT
 * apps work (an app is a remote MCP server; the user signs in to it once with
 * OAuth; its tools then show up in every chat, and anything that changes
 * something still asks first).
 *
 *   Directory   a short Featured list Codeply checked by hand (each one is the
 *               vendor's own server, published by them in the official MCP
 *               Registry), plus search over the whole official registry
 *               (registry.modelcontextprotocol.io, 18,000+ remote servers).
 *               Registry results are not reviewed by Codeply and say so.
 *   Sign-in     MCP authorization (spec 2025-06-18 / 2025-11-25): the server
 *               answers 401 and names its protected-resource metadata
 *               (RFC 9728), that names the authorization server (RFC 8414 /
 *               OpenID discovery), Codeply registers itself there (dynamic
 *               client registration, RFC 7591) and signs in with PKCE (S256)
 *               and the resource indicator (RFC 8707). The browser is the
 *               user's own; the redirect lands on a one-shot loopback server
 *               (RFC 8252).
 *   Store       ~/.codeply/apps.json, user-only permissions, never in a repo.
 *               Tokens refresh on their own before they expire.
 *
 * lib/mcp.js connects to every app here as one more MCP server (global, not
 * per project) and asks this file for the Authorization header per request.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const storeDir = path.join(os.homedir(), '.codeply');
const storePath = path.join(storeDir, 'apps.json');

const REGISTRY = (process.env.CODEPLY_MCP_REGISTRY || 'https://registry.modelcontextprotocol.io').replace(/\/+$/, '');
const REDIRECT_PORT = Number(process.env.CODEPLY_APPS_REDIRECT_PORT) || 53690;
const REDIRECT_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'codeply', version: '1.0' };
const HTTP_TIMEOUT_MS = 15000;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const UA = 'Codeply (+https://codeply.app)';

// ─── Featured ───────────────────────────────────────────────────────────────
// Every entry is the vendor's own server as the vendor published it in the
// official MCP Registry (`registry` is its registry name, under the vendor's
// own domain), and each was checked live to answer at `url`. Order is the
// order the directory shows them in.
const FEATURED = [
  { id: 'notion', title: 'Notion', domain: 'notion.so', registry: 'com.notion/mcp', url: 'https://mcp.notion.com/mcp', category: 'Productivity', description: 'Search, read and write pages and databases in your Notion workspace' },
  { id: 'linear', title: 'Linear', domain: 'linear.app', registry: 'app.linear/linear', url: 'https://mcp.linear.app/mcp', category: 'Productivity', description: 'Find, create and update issues, projects and comments' },
  { id: 'atlassian', title: 'Atlassian', domain: 'atlassian.com', registry: 'com.atlassian/atlassian-mcp-server', url: 'https://mcp.atlassian.com/v1/mcp/authv2', category: 'Productivity', description: 'Jira issues and Confluence pages: search, create and update' },
  { id: 'monday', title: 'monday.com', domain: 'monday.com', registry: 'com.monday/monday.com', url: 'https://mcp.monday.com/mcp', category: 'Productivity', description: 'Boards, items and updates in your monday.com account' },
  { id: 'airtable', title: 'Airtable', domain: 'airtable.com', registry: 'com.airtable/mcp', url: 'https://mcp.airtable.com/mcp', category: 'Productivity', description: 'Read and update records in your Airtable bases' },
  { id: 'zapier', title: 'Zapier', domain: 'zapier.com', registry: 'com.zapier/mcp', url: 'https://mcp.zapier.com/api/v1/connect', category: 'Automation', description: 'Reach 8,000+ apps through the actions you set up in Zapier' },
  { id: 'make', title: 'Make', domain: 'make.com', registry: 'com.make/mcp-server', url: 'https://mcp.make.com/v2', category: 'Automation', description: 'Run your Make scenarios as tools' },
  { id: 'canva', title: 'Canva', domain: 'canva.com', registry: 'com.canva.mcp/mcp', url: 'https://mcp.canva.com/mcp', category: 'Design', description: 'Find, create and export your Canva designs' },
  { id: 'webflow', title: 'Webflow', domain: 'webflow.com', registry: 'com.webflow/mcp', url: 'https://mcp.webflow.com/mcp', category: 'Design', description: 'Manage Webflow sites, pages and CMS collections' },
  { id: 'wix', title: 'Wix', domain: 'wix.com', registry: 'com.wix/mcp', url: 'https://mcp.wix.com/mcp', category: 'Design', description: 'Build and manage Wix sites and their business apps' },
  { id: 'stripe', title: 'Stripe', domain: 'stripe.com', registry: 'com.stripe/mcp', url: 'https://mcp.stripe.com', category: 'Business', description: 'Customers, payments, invoices and products in Stripe' },
  { id: 'close', title: 'Close', domain: 'close.com', registry: 'com.close/close-mcp', url: 'https://mcp.close.com/mcp', category: 'Business', description: 'Leads, contacts and deals in your Close CRM' },
  { id: 'amplitude', title: 'Amplitude', domain: 'amplitude.com', registry: 'com.amplitude/mcp-server', url: 'https://mcp.amplitude.com/mcp', category: 'Business', description: 'Ask questions about your product analytics' },
  { id: 'sentry', title: 'Sentry', domain: 'sentry.io', registry: 'io.github.getsentry/sentry-mcp', url: 'https://mcp.sentry.dev/mcp', category: 'Developer', description: 'Look into errors, issues and releases' },
  { id: 'vercel', title: 'Vercel', domain: 'vercel.com', registry: 'com.vercel/vercel-mcp', url: 'https://mcp.vercel.com', category: 'Developer', description: 'Projects, deployments and logs on Vercel' },
  { id: 'supabase', title: 'Supabase', domain: 'supabase.com', registry: 'com.supabase/mcp', url: 'https://mcp.supabase.com/mcp', category: 'Developer', description: 'Projects, tables, SQL and edge functions on Supabase' },
  { id: 'neon', title: 'Neon', domain: 'neon.tech', registry: 'com.neon/mcp', url: 'https://mcp.neon.tech/mcp', category: 'Developer', description: 'Postgres projects, branches and queries on Neon' },
  { id: 'gitlab', title: 'GitLab', domain: 'gitlab.com', registry: 'com.gitlab/mcp', url: 'https://gitlab.com/api/v4/mcp', category: 'Developer', description: 'Issues, merge requests and pipelines on GitLab.com' },
  { id: 'cloudflare', title: 'Cloudflare Docs', domain: 'cloudflare.com', registry: 'com.cloudflare.mcp/mcp', url: 'https://docs.mcp.cloudflare.com/mcp', category: 'Developer', description: 'Search the Cloudflare developer documentation' },
  { id: 'huggingface', title: 'Hugging Face', domain: 'huggingface.co', registry: 'co.huggingface/hf-mcp-server', url: 'https://huggingface.co/mcp?login', category: 'Developer', description: 'Search models, datasets, Spaces and papers' },
  { id: 'exa', title: 'Exa', domain: 'exa.ai', registry: 'ai.exa/exa', url: 'https://mcp.exa.ai/mcp', category: 'Research', description: 'Web search and page reading built for AI' },
  { id: 'mslearn', title: 'Microsoft Learn', domain: 'learn.microsoft.com', registry: 'com.microsoft/microsoft-learn-mcp', url: 'https://learn.microsoft.com/api/mcp', category: 'Research', description: 'Search Microsoft\'s official documentation and code samples' },
];

const BUILT_IN_IDS = new Set(['gmail', 'slack', 'github', 'codeply']); // names the app's own connections use

// ─── Store ──────────────────────────────────────────────────────────────────

function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return j && typeof j === 'object' && j.apps && typeof j.apps === 'object' ? j : { apps: {} };
  } catch { return { apps: {} }; }
}

function writeStore(store) {
  fs.mkdirSync(storeDir, { recursive: true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  try { fs.chmodSync(storePath, 0o600); } catch {}
}

function updateApp(id, patch) {
  const store = readStore();
  const cur = store.apps[id];
  if (!cur) return null;
  store.apps[id] = { ...cur, ...patch, auth: { ...(cur.auth || {}), ...(patch.auth || {}) } };
  writeStore(store);
  return store.apps[id];
}

/** What the UI may see about an app: never a token or a client secret. */
function publicView(app) {
  if (!app) return null;
  const a = app.auth || {};
  return {
    id: app.id, title: app.title, description: app.description || '', url: app.url, domain: app.domain || hostOf(app.url),
    icon: app.icon || '', category: app.category || '', source: app.source, verified: !!app.verified, registry: app.registry || '',
    connectedAt: app.connectedAt || 0, auth: a.type || 'none', account: app.account || '',
    needsReconnect: !!app.needsReconnect, toolCount: Number(app.toolCount) || 0,
  };
}

/** Connected apps, for the UI. */
function listConnected() {
  return Object.values(readStore().apps).sort((x, y) => (y.connectedAt || 0) - (x.connectedAt || 0)).map(publicView);
}

/** Connected apps as MCP server specs for lib/mcp.js: { [id]: { url, app: id } }. */
function mcpServers() {
  const out = {};
  for (const app of Object.values(readStore().apps)) {
    if (!app || !app.url || app.disabled) continue;
    out[app.id] = { url: app.url, app: app.id, title: app.title };
  }
  return out;
}

function getApp(id) { return readStore().apps[id] || null; }

function removeApp(id) {
  const store = readStore();
  const app = store.apps[id];
  if (!app) return false;
  delete store.apps[id];
  writeStore(store);
  // Best effort: tell the authorization server the tokens are gone (RFC 7009).
  const a = app.auth || {};
  if (a.revocationEndpoint && (a.refreshToken || a.accessToken)) {
    const body = new URLSearchParams({ token: a.refreshToken || a.accessToken, client_id: a.clientId || '' });
    fetch(a.revocationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body, signal: AbortSignal.timeout(8000) }).catch(() => {});
  }
  return true;
}

/** Notes from lib/mcp.js after it connects: how many tools, or that sign-in ran out. */
function noteStatus(id, { toolCount, needsReconnect } = {}) {
  const app = getApp(id);
  if (!app) return;
  const patch = {};
  if (typeof toolCount === 'number' && toolCount !== app.toolCount) patch.toolCount = toolCount;
  if (typeof needsReconnect === 'boolean' && needsReconnect !== !!app.needsReconnect) patch.needsReconnect = needsReconnect;
  if (Object.keys(patch).length) updateApp(id, patch);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'app';
}

/** A free id for a new app: its slug, or slug_2, slug_3... (never a built-in's name). */
function freeId(base) {
  const apps = readStore().apps;
  let id = slug(base);
  if (BUILT_IN_IDS.has(id)) id = `${id}_app`;
  for (let n = 2; apps[id]; n++) id = `${slug(base).slice(0, 20)}_${n}`;
  return id;
}

/** Only http(s) URLs, and plain http only to this computer. */
function checkServerUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('That is not a valid URL.'); }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return u;
  throw new Error('An app\'s server must be an https:// URL.');
}

/** The canonical resource URI for RFC 8707: no fragment, lowercase scheme and host. */
function canonicalResource(url) {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA, 'MCP-Protocol-Version': PROTOCOL_VERSION }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** WWW-Authenticate: Bearer resource_metadata="...", scope="...", error="..." */
function parseWwwAuthenticate(header) {
  const out = {};
  if (!header) return out;
  const re = /([a-zA-Z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]);
  return out;
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Ask the server who it is without a token. Either it answers (no sign-in
 * needed) or it answers 401 and says where its sign-in lives.
 * @returns {Promise<{ open: boolean, www: object, status: number, serverName?: string }>}
 */
async function probe(url) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION, 'User-Agent': UA },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Could not reach ${hostOf(url)}: ${e.cause?.code || e.message}`);
  }
  const www = parseWwwAuthenticate(res.headers.get('www-authenticate'));
  if (res.status === 401 || res.status === 403 && www.resource_metadata) return { open: false, www, status: res.status };
  if (!res.ok) {
    throw new Error(`${hostOf(url)} answered HTTP ${res.status}. It may not be an MCP server, or it may need a key Codeply can't add for you.`);
  }
  let serverName = '';
  try {
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    const json = type.includes('text/event-stream')
      ? JSON.parse(text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).find((d) => d.includes('"result"')) || 'null')
      : JSON.parse(text);
    serverName = json?.result?.serverInfo?.title || json?.result?.serverInfo?.name || '';
  } catch {}
  return { open: true, www, status: res.status, serverName };
}

/** Protected resource metadata (RFC 9728): from the 401's hint, else the well-known paths. */
async function protectedResourceMetadata(url, www) {
  const u = new URL(url);
  const candidates = [];
  if (www.resource_metadata) candidates.push(www.resource_metadata);
  const p = u.pathname.replace(/\/+$/, '');
  if (p) candidates.push(`${u.origin}/.well-known/oauth-protected-resource${p}`);
  candidates.push(`${u.origin}/.well-known/oauth-protected-resource`);
  for (const c of candidates) {
    const j = await getJson(c);
    if (j && Array.isArray(j.authorization_servers) && j.authorization_servers.length) return j;
  }
  return null;
}

/** Authorization server metadata (RFC 8414, then OpenID discovery), path-aware. */
async function authServerMetadata(issuer) {
  const u = new URL(issuer);
  const p = u.pathname.replace(/\/+$/, '');
  const candidates = p
    ? [`${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}/.well-known/openid-configuration${p}`, `${u.origin}${p}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const c of candidates) {
    const j = await getJson(c);
    if (j && j.authorization_endpoint && j.token_endpoint) return j;
  }
  return null;
}

/**
 * Everything needed to sign in to a server, or { open: true } when it needs
 * no sign-in at all.
 */
async function discover(url) {
  const pr = await probe(url);
  if (pr.open) return { open: true, serverName: pr.serverName };
  const prm = await protectedResourceMetadata(url, pr.www);
  let issuer;
  let resource = canonicalResource(url);
  let scopes = [];
  if (prm) {
    issuer = prm.authorization_servers[0];
    if (prm.resource) resource = prm.resource;
    if (Array.isArray(prm.scopes_supported)) scopes = prm.scopes_supported;
  } else {
    issuer = new URL(url).origin; // 2025-03-26 servers: the authorization server is the server's own origin
  }
  if (pr.www.scope) scopes = pr.www.scope.split(/\s+/).filter(Boolean);
  let as = await authServerMetadata(issuer);
  if (!as && !prm) {
    const o = new URL(url).origin; // the older spec's default endpoints
    as = { issuer: o, authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register` };
  }
  if (!as) throw new Error(`${hostOf(url)} asks for a sign-in but doesn't say where (no OAuth metadata at ${hostOf(issuer)}).`);
  const methods = as.code_challenge_methods_supported;
  if (Array.isArray(methods) && methods.length && !methods.includes('S256')) {
    throw new Error(`${hostOf(url)}'s sign-in doesn't support PKCE (S256), so Codeply won't use it.`);
  }
  return { open: false, issuer: as.issuer || issuer, as, resource, scopes };
}

// ─── Client registration ────────────────────────────────────────────────────

async function registerClient(as) {
  if (!as.registration_endpoint) {
    throw new Error('This app\'s sign-in doesn\'t let new apps register on their own. Add it under "Add by URL" with a client ID from the app\'s developer settings.');
  }
  const res = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      client_name: 'Codeply',
      client_uri: 'https://codeply.app',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      software_id: 'app.codeply.desktop',
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.client_id) {
    const why = j?.error_description || j?.error || `HTTP ${res.status}`;
    throw new Error(`Couldn't register Codeply with this app's sign-in: ${why}`);
  }
  return { clientId: j.client_id, clientSecret: j.client_secret || '', authMethod: j.token_endpoint_auth_method || (j.client_secret ? 'client_secret_post' : 'none') };
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

async function tokenRequest(a, params) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA };
  const body = new URLSearchParams(params);
  if (a.clientSecret && a.authMethod === 'client_secret_basic') {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(a.clientId)}:${encodeURIComponent(a.clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_id', a.clientId);
    if (a.clientSecret) body.set('client_secret', a.clientSecret);
  }
  const res = await fetch(a.tokenEndpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); } // a few servers answer form-encoded
  if (!res.ok || !j || !j.access_token) {
    const err = new Error(j?.error_description || j?.error || `token endpoint HTTP ${res.status}`);
    err.oauthError = j?.error || '';
    throw err;
  }
  return j;
}

function tokenPatch(t, prev = {}) {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || prev.refreshToken || '',
    expiresAt: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : 0,
    grantedScope: t.scope || prev.grantedScope || '',
  };
}

const refreshing = new Map(); // id -> Promise, so parallel calls share one refresh

/** Trade the refresh token for a new access token. Returns false when sign-in has to happen again. */
function refresh(id) {
  if (refreshing.has(id)) return refreshing.get(id);
  const p = (async () => {
    const app = getApp(id);
    const a = app?.auth;
    if (!a || a.type !== 'oauth' || !a.refreshToken) return false;
    try {
      const params = { grant_type: 'refresh_token', refresh_token: a.refreshToken };
      if (a.resource) params.resource = a.resource;
      const t = await tokenRequest(a, params);
      updateApp(id, { auth: tokenPatch(t, a), needsReconnect: false });
      return true;
    } catch (e) {
      if (/invalid_grant|invalid_client|unauthorized_client/.test(e.oauthError || e.message)) updateApp(id, { needsReconnect: true });
      return false;
    }
  })().finally(() => refreshing.delete(id));
  refreshing.set(id, p);
  return p;
}

/** The headers lib/mcp.js sends with every request to this app (refreshing first if the token is about to run out). */
async function authHeaders(id) {
  let app = getApp(id);
  if (!app) return {};
  const a = app.auth || {};
  if (a.type === 'header') return { ...(a.headers || {}) };
  if (a.type !== 'oauth' || !a.accessToken) return {};
  if (a.expiresAt && a.expiresAt - Date.now() < 60_000 && a.refreshToken) {
    await refresh(id);
    app = getApp(id);
  }
  return app?.auth?.accessToken ? { Authorization: `Bearer ${app.auth.accessToken}` } : {};
}

// ─── Sign-in ────────────────────────────────────────────────────────────────

let signInActive = null; // one browser sign-in at a time (they share the loopback port)

/** One-shot loopback server: resolves with the redirect's query, or rejects. */
function awaitRedirect(authUrl, state, openBrowser, title, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Drop the browser's kept-alive connection too, or the next sign-in's
      // redirect could land on this old server instead of the new one.
      try { server.close(); server.closeAllConnections?.(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Codeply</title><body style="font-family:system-ui,sans-serif;background:#0a0a0c;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div>${msg}</div></body>`;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== REDIRECT_PATH) { res.writeHead(404); res.end(); return; }
      const q = Object.fromEntries(u.searchParams);
      if (q.state !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(page('This sign-in link is out of date. Start again from Codeply.'));
        return; // not ours: keep waiting for the real one
      }
      const ok = !q.error && q.code;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      res.end(page(ok ? `${esc(title)} is connected to Codeply. You can close this tab.` : `Couldn't connect ${esc(title)}: ${esc(q.error_description || q.error || 'no code came back')}`));
      if (q.error) finish(new Error(q.error_description || q.error));
      else if (!q.code) finish(new Error('The sign-in came back without a code.'));
      else finish(null, q);
    });
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the browser sign-in.')), SIGN_IN_TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => finish(new Error('Sign-in cancelled.')), { once: true });
    server.on('error', (e) => finish(new Error(e.code === 'EADDRINUSE' ? `Port ${REDIRECT_PORT} is busy, so the sign-in can't come back. Close whatever uses it and try again.` : e.message)));
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      Promise.resolve(openBrowser(authUrl)).catch((e) => finish(new Error(`Couldn't open the browser: ${e.message}`)));
    });
  });
}

/**
 * Connect an app: sign in if it needs it, save it, return its public view.
 * @param {object} entry  { url, title?, description?, icon?, domain?, category?, registry?, id? }
 * @param {object} opts   { openBrowser(url), signal?, clientId?, clientSecret? }
 */
async function connect(entry, opts = {}) {
  if (typeof opts.openBrowser !== 'function') throw new Error('connect needs openBrowser');
  const u = checkServerUrl(entry.url);
  const url = u.href;
  const featured = FEATURED.find((f) => f.url === url || (entry.id && f.id === entry.id && f.url === url));
  const meta = featured ? { ...featured, verified: true, source: 'featured' } : {
    title: String(entry.title || '').trim().slice(0, 60) || hostOf(url),
    description: String(entry.description || '').trim().slice(0, 300),
    domain: entry.domain || hostOf(url),
    category: entry.category || '',
    registry: entry.registry || '',
    icon: /^https:\/\//.test(entry.icon || '') ? entry.icon : '',
    verified: false,
    source: entry.registry ? 'registry' : 'custom',
  };
  // Already connected to this same server: sign in again in place.
  const existing = Object.values(readStore().apps).find((a) => a.url === url);
  const id = existing ? existing.id : freeId(featured ? featured.id : meta.title);

  if (signInActive) throw new Error('Another app is signing in right now. Finish that one first.');
  signInActive = id;
  try {
    const d = await discover(url);
    let auth;
    let account = '';
    if (d.open) {
      auth = { type: 'none' };
    } else {
      const reuse = existing?.auth?.type === 'oauth' && existing.auth.issuer === d.issuer && existing.auth.redirectUri === REDIRECT_URI && existing.auth.clientId ? existing.auth : null;
      const client = opts.clientId
        ? { clientId: String(opts.clientId).trim(), clientSecret: String(opts.clientSecret || '').trim(), authMethod: opts.clientSecret ? 'client_secret_post' : 'none' }
        : reuse ? { clientId: reuse.clientId, clientSecret: reuse.clientSecret || '', authMethod: reuse.authMethod || 'none' }
          : await registerClient(d.as);
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const state = b64url(crypto.randomBytes(24));
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        resource: d.resource,
      });
      if (d.scopes.length) q.set('scope', d.scopes.join(' '));
      const authUrl = `${d.as.authorization_endpoint}${d.as.authorization_endpoint.includes('?') ? '&' : '?'}${q}`;
      const back = await awaitRedirect(authUrl, state, opts.openBrowser, meta.title, opts.signal);
      if (back.iss && d.as.issuer && back.iss !== d.as.issuer) throw new Error('The sign-in came back from a different server than it went to, so Codeply stopped.'); // RFC 9207
      const a = { ...client, tokenEndpoint: d.as.token_endpoint, resource: d.resource };
      const t = await tokenRequest(a, { grant_type: 'authorization_code', code: back.code, redirect_uri: REDIRECT_URI, code_verifier: verifier, resource: d.resource });
      auth = {
        type: 'oauth', issuer: d.issuer, clientId: client.clientId, clientSecret: client.clientSecret, authMethod: client.authMethod,
        tokenEndpoint: d.as.token_endpoint, revocationEndpoint: d.as.revocation_endpoint || '', resource: d.resource, redirectUri: REDIRECT_URI,
        scope: d.scopes.join(' '), ...tokenPatch(t),
      };
      account = idTokenEmail(t.id_token);
    }
    const store = readStore();
    const { id: _featuredId, url: _featuredUrl, ...info } = meta; // the saved id and url are this app's own
    store.apps[id] = {
      ...info, id, url, auth, account,
      connectedAt: existing?.connectedAt || Date.now(), needsReconnect: false, toolCount: existing?.toolCount || 0,
    };
    writeStore(store);
    return publicView(store.apps[id]);
  } finally {
    signInActive = null;
  }
}

/** The email in an OpenID id_token, for the "connected as" line. Not verified: display only. */
function idTokenEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64').toString('utf8'));
    return String(payload.email || payload.preferred_username || '').slice(0, 120);
  } catch { return ''; }
}

/**
 * Add an app that takes a fixed header (an API key the user pastes) instead
 * of OAuth. Only for "Add by URL"; the key stays in apps.json.
 */
function addWithHeader(entry, headerName, headerValue) {
  const u = checkServerUrl(entry.url);
  const name = String(headerName || '').trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new Error('That header name isn\'t valid.');
  const value = String(headerValue || '').trim();
  if (!value) throw new Error('Paste the key or token for this app.');
  const existing = Object.values(readStore().apps).find((a) => a.url === u.href);
  const id = existing ? existing.id : freeId(entry.title || hostOf(u.href));
  const store = readStore();
  store.apps[id] = {
    id, url: u.href, title: String(entry.title || '').trim().slice(0, 60) || hostOf(u.href), description: '', domain: hostOf(u.href),
    source: 'custom', verified: false, auth: { type: 'header', headers: { [name]: value } }, connectedAt: existing?.connectedAt || Date.now(), toolCount: 0,
  };
  writeStore(store);
  return publicView(store.apps[id]);
}

// ─── Directory ──────────────────────────────────────────────────────────────

function featured() {
  const connected = readStore().apps;
  const byUrl = new Map(Object.values(connected).map((a) => [a.url, a.id]));
  return FEATURED.map((f) => ({ ...f, verified: true, source: 'featured', connectedId: byUrl.get(f.url) || '' }));
}

/** A registry entry Codeply can connect to: a streamable-HTTP remote with no required headers and no URL placeholders. */
function usableRemote(server) {
  for (const r of server.remotes || []) {
    if (r.type !== 'streamable-http' || !r.url || /[{}]/.test(r.url)) continue;
    if ((r.headers || []).some((h) => h.isRequired)) continue;
    if ((r.variables && Object.keys(r.variables).length)) continue;
    try { checkServerUrl(r.url); } catch { continue; }
    return r.url;
  }
  return '';
}

function iconOf(server) {
  const icons = Array.isArray(server.icons) ? server.icons : [];
  const png = icons.find((i) => /^https:\/\//.test(i.src || '') && /png|jpe?g|webp/.test(i.mimeType || i.src));
  const any = icons.find((i) => /^https:\/\//.test(i.src || ''));
  return (png || any)?.src || '';
}

const registryCache = new Map(); // key -> { at, value }

/**
 * Search the official MCP Registry. Returns apps Codeply can connect to,
 * newest version of each, Featured ones marked.
 * @returns {Promise<{ apps: object[], next: string, error?: string }>}
 */
async function searchRegistry(query, cursor = '') {
  const q = String(query || '').trim().slice(0, 80);
  const key = `${q}::${cursor}`;
  const hit = registryCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const params = new URLSearchParams({ version: 'latest', limit: '60' });
  if (q) params.set('search', q);
  if (cursor) params.set('cursor', cursor);
  let j;
  try {
    const res = await fetch(`${REGISTRY}/v0.1/servers?${params}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return { apps: [], next: '', error: `The MCP Registry answered HTTP ${res.status}.` };
    j = await res.json();
  } catch (e) {
    return { apps: [], next: '', error: `Couldn't reach the MCP Registry: ${e.cause?.code || e.message}` };
  }
  const connected = Object.values(readStore().apps);
  const featuredByRegistry = new Map(FEATURED.map((f) => [f.registry, f]));
  const seen = new Set();
  const apps = [];
  for (const row of j.servers || []) {
    const s = row.server || {};
    if (!s.name || seen.has(s.name)) continue;
    const status = row._meta?.['io.modelcontextprotocol.registry/official']?.status;
    if (status && status !== 'active') continue;
    const f = featuredByRegistry.get(s.name);
    const url = f ? f.url : usableRemote(s);
    if (!url) continue;
    seen.add(s.name);
    const title = f?.title || s.title || prettyName(s.name);
    apps.push({
      id: f?.id || '', registry: s.name, title, url,
      description: f?.description || String(s.description || '').slice(0, 220),
      domain: f?.domain || hostOf(s.websiteUrl || url), icon: iconOf(s), website: /^https:\/\//.test(s.websiteUrl || '') ? s.websiteUrl : '',
      repository: /^https:\/\//.test(s.repository?.url || '') ? s.repository.url : '',
      verified: !!f, source: f ? 'featured' : 'registry',
      connectedId: connected.find((a) => a.url === url)?.id || '',
    });
  }
  // Featured first, then the rest in the registry's order.
  apps.sort((a, b) => Number(b.verified) - Number(a.verified));
  const value = { apps, next: j.metadata?.nextCursor || '' };
  registryCache.set(key, { at: Date.now(), value });
  if (registryCache.size > 200) registryCache.delete(registryCache.keys().next().value);
  return value;
}

/** "io.github.someone/cool-server" -> "Cool Server" */
function prettyName(name) {
  const last = String(name).split('/').pop() || name;
  return last.replace(/[-_.]+/g, ' ').replace(/\b(mcp|server)\b/gi, '').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || last;
}

module.exports = {
  FEATURED, REDIRECT_URI, storePath,
  featured, searchRegistry, listConnected, mcpServers, getApp, removeApp, noteStatus,
  connect, addWithHeader, authHeaders, refresh, discover,
  // for tests
  _internal: { parseWwwAuthenticate, canonicalResource, usableRemote, prettyName, slug, checkServerUrl, readStore, writeStore },
};
