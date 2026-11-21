// Apps (codeply-cli/lib/apps.js + lib/mcp.js): the whole MCP sign-in against a
// fake app on this computer. Discovery from the 401, dynamic client
// registration, PKCE, the resource indicator, tools through mcp.js, an expired
// session, refresh after a 401 and before expiry, a dead refresh token, sign
// in again in place, a stray redirect, cancel. No network: the store is a temp
// folder (node scripts/apps-test.mjs).
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-apps-test-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.CODEPLY_APPS_REDIRECT_PORT = '53791';
const LIB = path.join(ROOT, 'codeply-cli', 'lib');
const PORT = 47123, BASE = `http://localhost:${PORT}`;
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const st = { clients: {}, codes: {}, tokens: {}, refresh: {}, sessions: new Set(), log: [] };
const tokenTtl = 3600;
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE); let body = ''; for await (const c of req) body += c;
  const json = (code, obj, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };
  st.log.push(`${req.method} ${u.pathname}`);
  if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/auth`], scopes_supported: ['read', 'write'] });
  if (u.pathname === '/.well-known/oauth-authorization-server/auth') return json(200, { issuer: `${BASE}/auth`, authorization_endpoint: `${BASE}/auth/authorize`, token_endpoint: `${BASE}/auth/token`, registration_endpoint: `${BASE}/auth/register`, code_challenge_methods_supported: ['S256'] });
  if (u.pathname === '/auth/register') { const j = JSON.parse(body); const id = 'cl_' + crypto.randomBytes(4).toString('hex'); st.clients[id] = j; return json(201, { client_id: id, ...j }); }
  if (u.pathname === '/auth/authorize') {
    const q = Object.fromEntries(u.searchParams);
    if (!st.clients[q.client_id] || !st.clients[q.client_id].redirect_uris.includes(q.redirect_uri)) return json(400, { error: 'bad client/redirect' });
    if (q.resource !== `${BASE}/mcp` || q.code_challenge_method !== 'S256' || q.scope !== 'read write') return json(400, { error: 'bad params ' + JSON.stringify(q) });
    const code = 'c_' + crypto.randomBytes(6).toString('hex'); st.codes[code] = q;
    res.writeHead(302, { Location: `${q.redirect_uri}?code=${code}&state=${q.state}&iss=${encodeURIComponent(BASE + '/auth')}` }); return res.end();
  }
  if (u.pathname === '/auth/token') {
    const p = Object.fromEntries(new URLSearchParams(body));
    if (p.grant_type === 'authorization_code') {
      const q = st.codes[p.code]; delete st.codes[p.code];
      if (!q) return json(400, { error: 'invalid_grant' });
      if (b64url(crypto.createHash('sha256').update(p.code_verifier).digest()) !== q.code_challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE failed' });
      if (p.resource !== `${BASE}/mcp` || p.client_id !== q.client_id || p.redirect_uri !== q.redirect_uri) return json(400, { error: 'invalid_request' });
    } else if (p.grant_type === 'refresh_token') {
      if (!st.refresh[p.refresh_token]) return json(400, { error: 'invalid_grant' });
      delete st.refresh[p.refresh_token]; st.log.push('REFRESHED');
    } else return json(400, { error: 'unsupported_grant_type' });
    const at = 'at_' + crypto.randomBytes(6).toString('hex'), rt = 'rt_' + crypto.randomBytes(6).toString('hex');
    st.tokens[at] = Date.now() + tokenTtl * 1000; st.refresh[rt] = true;
    return json(200, { access_token: at, refresh_token: rt, token_type: 'Bearer', expires_in: tokenTtl });
  }
  if (u.pathname === '/mcp') {
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!st.tokens[tok] || st.tokens[tok] < Date.now()) return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"` });
    const m = JSON.parse(body);
    if (m.method === 'initialize') { const sid = 's_' + crypto.randomBytes(4).toString('hex'); st.sessions.add(sid); return json(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }, { 'Mcp-Session-Id': sid }); }
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    if (!st.sessions.has(req.headers['mcp-session-id'])) { res.writeHead(404); return res.end(); }
    if (m.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'create_task', description: 'Make a task', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }, { name: 'list_tasks', description: 'List', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } }] } });
    if (m.method === 'tools/call') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'made ' + (m.params.arguments.title || 'list') }] } })}\n\n`); }
  }
  json(404, {});
});

srv.listen(PORT, '127.0.0.1', async () => {
  const apps = require(LIB + '/apps.js'); const mcp = require(LIB + '/mcp.js');
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const browser = (url) => fetch(url, { redirect: 'follow' }).then((r) => r.text());
  const cwd = process.cwd();
  try {
    const v = await apps.connect({ url: `${BASE}/mcp`, title: 'Fake Tasks' }, { openBrowser: browser });
    ok(v.auth === 'oauth' && v.id === 'fake_tasks' && !JSON.stringify(v).includes('at_'), `connected via OAuth, public view has no token (${v.id})`);
    const raw = apps._internal.readStore().apps.fake_tasks;
    ok(raw.auth.redirectUri === apps.REDIRECT_URI && raw.auth.clientId.startsWith('cl_'), 'registered client saved with its redirect');
    console.log('     store mode', (fs.statSync(apps.storePath).mode & 0o777).toString(8), '(Windows ignores modes)');
    let list = await mcp.listServers(cwd);
    ok(list[0].tools.length === 2 && list[0].app && list[0].title === 'Fake Tasks', 'tools listed through mcp.js with the sign-in header');
    let r = await mcp.callTool(cwd, 'fake_tasks', 'create_task', { title: 'buy milk' });
    ok(r.text === 'made buy milk', 'tool call over SSE works');
    st.sessions.clear();
    r = await mcp.callTool(cwd, 'fake_tasks', 'create_task', { title: 'after session loss' });
    ok(r.text === 'made after session loss', 'expired session is re-initialized');
    for (const k of Object.keys(st.tokens)) st.tokens[k] = 0;
    r = await mcp.callTool(cwd, 'fake_tasks', 'create_task', { title: 'after revoke' });
    ok(r.text === 'made after revoke' && st.log.includes('REFRESHED'), 'refreshes after a 401');
    st.log.length = 0;
    const s1 = apps._internal.readStore(); s1.apps.fake_tasks.auth.expiresAt = Date.now() + 1000; apps._internal.writeStore(s1);
    r = await mcp.callTool(cwd, 'fake_tasks', 'list_tasks', {});
    ok(st.log.includes('REFRESHED') && r.text === 'made list', 'refreshes before expiry');
    for (const k of Object.keys(st.tokens)) st.tokens[k] = 0;
    for (const k of Object.keys(st.refresh)) delete st.refresh[k];
    let err = ''; try { await mcp.callTool(cwd, 'fake_tasks', 'list_tasks', {}); } catch (e) { err = e.message; }
    ok(/sign in again/.test(err) && apps.listConnected()[0].needsReconnect, `dead refresh token asks to reconnect (${err})`);
    const before = apps._internal.readStore().apps.fake_tasks.auth.clientId; const n = Object.keys(st.clients).length;
    const v2 = await apps.connect({ url: `${BASE}/mcp` }, { openBrowser: browser });
    ok(v2.id === 'fake_tasks' && !v2.needsReconnect && Object.keys(st.clients).length === n && apps._internal.readStore().apps.fake_tasks.auth.clientId === before, 'reconnect in place keeps the id and the client');
    mcp.forget('fake_tasks');
    list = await mcp.listServers(cwd);
    ok(!list[0].error && list[0].tools.length === 2, 'works again after reconnect');
    const ac = new AbortController();
    const p = apps.connect({ url: `${BASE}/mcp` }, { signal: ac.signal, openBrowser: async () => { await fetch(apps.REDIRECT_URI + '?code=x&state=wrong').then((x) => x.text()); setTimeout(() => ac.abort(), 200); } });
    let e2 = ''; try { await p; } catch (e) { e2 = e.message; }
    ok(e2 === 'Sign-in cancelled.', 'a wrong state is ignored, cancel works');
    let e3 = ''; try { await apps.connect({ url: 'http://example.com/mcp' }, { openBrowser: browser }); } catch (e) { e3 = e.message; }
    ok(/https/.test(e3), 'plain http to another host is refused');
    ok(apps.removeApp('fake_tasks') && apps.listConnected().length === 0, 'removed');
  } catch (e) { console.log('FAIL exception', e.stack); process.exitCode = 1; }
  mcp.closeAll(); srv.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(process.exitCode ? '\nSOME FAILED' : '\nALL PASSED');
});
