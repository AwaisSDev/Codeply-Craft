// Run: node sidecar/ext-connections.test.mjs
// Codeply's own sign-ins (ext-connections.mjs) and the Apps page's built-ins (ext-apps.mjs), with
// fetch and the browser stubbed: no real sign-in and no network. HOME is a temp folder, so the
// real config.js, oauth-connectors.js and apps.js write there and nowhere else.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'codeply-cli');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-conn-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.CODEPLY_MCP_REGISTRY = 'https://registry.invalid';
for (const k of Object.keys(process.env)) if (/_(CLIENT_ID|CLIENT_SECRET|SLUG)$/.test(k)) delete process.env[k];
assert.equal(os.homedir(), tmp);

const require = createRequire(path.join(CLI, 'lib', 'x.js'));
const need = (name) => require(path.join(CLI, 'lib', name));
const events = [];
const ctx = { CLI, DATA: path.join(tmp, 'rune'), need, missing: {}, shared: {}, emit: (_s, e) => events.push(e), readJson: async (req) => req.body };

const conn = await import('./ext-connections.mjs');
const appsExt = await import('./ext-apps.mjs');
const config = need('config.js');

// ---------- the OAuth apps' credentials ----------

assert.deepEqual(conn.parseEnv('# c\nexport A=1\nB = "two words"\nC=x # note\nbad line\nD=\'q\''), { A: '1', B: 'two words', C: 'x', D: 'q' });

/** An asar archive as Electron writes one: [4][header size][payload size][json length][json] then the files. */
function writeAsar(file, files) {
  const tree = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const buf = Buffer.from(body);
    tree.files[name] = { size: buf.length, offset: String(offset) };
    blobs.push(buf);
    offset += buf.length;
  }
  tree.files.lib = { files: { 'x.js': { size: 3, offset: String(offset) } } };
  blobs.push(Buffer.from('x=1'));
  const json = Buffer.from(JSON.stringify(tree));
  const strPadded = Buffer.alloc(json.length + ((4 - (json.length % 4)) % 4));
  json.copy(strPadded);
  const headerPickle = Buffer.alloc(8 + strPadded.length);
  headerPickle.writeUInt32LE(4 + strPadded.length, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  strPadded.copy(headerPickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(headerPickle.length, 4);
  fs.writeFileSync(file, Buffer.concat([size, headerPickle, ...blobs]));
}

const installed = path.join(tmp, 'Codeply Craft', 'resources');
fs.mkdirSync(installed, { recursive: true });
writeAsar(path.join(installed, 'app.asar'), {
  'main.js': '// main',
  'build-secrets.json': JSON.stringify({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', VERCEL_CLIENT_ID: 'v-id', VERCEL_CLIENT_SECRET: 'v-secret', VERCEL_SLUG: 'codeply-test',
    SUPABASE_CLIENT_ID: 'sb-id', SUPABASE_CLIENT_SECRET: 'sb-secret', GMAIL_CLIENT_ID: 'gm-id', GMAIL_CLIENT_SECRET: 'gm-secret', OLLAMA_API_KEY: 'not-taken' }),
});
assert.equal(conn.readAsarFile(path.join(installed, 'app.asar'), 'main.js').toString(), '// main');
assert.equal(conn.readAsarFile(path.join(installed, 'app.asar'), 'lib/x.js').toString(), 'x=1');
assert.equal(conn.readAsarFile(path.join(installed, 'app.asar'), 'nope.json'), null);
assert.equal(conn.readAsarFile(path.join(tmp, 'missing.asar'), 'build-secrets.json'), null);

// Nothing found yet: Slack has no credentials anywhere, and connecting says so plainly.
process.env.SLACK_CLIENT_ID = '';
await assert.rejects(conn.connect(ctx, 'slack', { openBrowser: () => assert.fail('no browser without credentials') }), /no Slack sign-in set up.*SLACK_CLIENT_ID/);

process.env.CODEPLY_SECRETS_DIRS = installed;
process.env.GITHUB_CLIENT_ID = 'from-env'; // the environment wins, as in main.js
const from = conn.loadSecrets(ctx);
assert.ok(from.includes(path.resolve(installed)));
assert.equal(process.env.GITHUB_CLIENT_ID, 'from-env');
assert.equal(process.env.VERCEL_SLUG, 'codeply-test');
assert.equal(process.env.OLLAMA_API_KEY, undefined, 'only the sign-in credentials are taken');
assert.equal(config.getIntegration('gmail').clientId, 'gm-id');
delete process.env.GITHUB_CLIENT_ID;
conn.loadSecrets(ctx);
assert.equal(process.env.GITHUB_CLIENT_ID, 'gh-id');

// A source checkout's .env next to codeply-cli counts too (main.js loads it with dotenv).
const checkout = path.join(tmp, 'checkout');
fs.mkdirSync(checkout);
fs.writeFileSync(path.join(checkout, '.env'), 'SLACK_CLIENT_ID=sl-id\nSLACK_CLIENT_SECRET=sl-secret\n');
process.env.CODEPLY_SECRETS_DIRS = [installed, checkout].join(path.delimiter);
conn.loadSecrets(ctx);
assert.equal(config.getIntegration('slack').clientSecret, 'sl-secret');

// ---------- signing in, with the providers and the browser stubbed ----------

const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init.body ? String(init.body) : '';
  calls.push({ url, body, auth: init.headers?.Authorization || '' });
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'gm-at', refresh_token: 'gm-rt', expires_in: 3600, scope: 'gmail.readonly' });
  if (url === 'https://www.googleapis.com/gmail/v1/users/me/profile') return json({ emailAddress: 'ada@example.com' });
  if (url === 'https://slack.com/api/oauth.v2.access') return json({ ok: true, access_token: 'xoxb-1', team: { id: 'T1', name: 'Analytical Engines' }, authed_user: { id: 'U1', access_token: 'xoxp-1' }, bot_user_id: 'B1' });
  if (url === 'https://api.vercel.com/v2/oauth/access_token') return json({ access_token: 'v-at', team_id: 'team_1' });
  if (url === 'https://api.vercel.com/v2/user') return json({ user: { username: 'ada-v' } });
  if (url === 'https://api.supabase.com/v1/oauth/token') return json({ access_token: 'sb-at', refresh_token: 'sb-rt', expires_in: 3600 });
  if (url === 'https://github.com/login/oauth/access_token') return json({ access_token: 'gh-at', scope: 'repo' });
  if (url === 'https://api.github.com/user') return json({ login: 'ada' });
  if (url.startsWith('https://registry.invalid/')) return json({ servers: [], metadata: {} });
  return json({ error: `unexpected ${url}` }, 500);
};

function get(u) {
  return new Promise((resolve, reject) => {
    http.get(u, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}

/** The user's browser: checks where it was sent, then lands on the redirect with a code. */
function browser(expectHost, extra = {}) {
  const seen = { urls: [] };
  seen.open = (authUrl) => {
    const u = new URL(authUrl);
    seen.urls.push(u);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.host, expectHost);
    const redirect = u.searchParams.get('redirect_uri') || extra.redirect;
    const back = new URL(redirect);
    if (extra.query) for (const [k, v] of Object.entries(extra.query)) back.searchParams.set(k, v);
    else back.searchParams.set('code', 'the-code');
    if (u.searchParams.get('state') && !extra.dropState) back.searchParams.set('state', extra.state || u.searchParams.get('state'));
    seen.page = get(back.href);
  };
  return seen;
}

{
  const b = browser('accounts.google.com');
  const r = await conn.connect(ctx, 'gmail', { openBrowser: b.open });
  assert.deepEqual(r, { id: 'gmail', account: 'ada@example.com' });
  assert.equal(b.urls[0].searchParams.get('redirect_uri'), 'http://localhost:53681/gmail-callback');
  assert.match((await b.page).body, /Gmail is connected/);
  const g = config.getIntegration('gmail');
  assert.equal(g.accessToken, 'gm-at');
  assert.equal(g.refreshToken, 'gm-rt');
  assert.equal(g.email, 'ada@example.com');
  assert.equal(g.scope, 'gmail.readonly');
  assert.ok(g.expiresAt > Date.now());
  assert.match(calls.find((c) => c.url.includes('oauth2.googleapis.com')).body, /code=the-code.*redirect_uri=http%3A%2F%2Flocalhost%3A53681%2Fgmail-callback|redirect_uri=http%3A%2F%2Flocalhost%3A53681%2Fgmail-callback.*code=the-code/);
}
{
  const b = browser('slack.com');
  assert.deepEqual(await conn.connect(ctx, 'slack', { openBrowser: b.open }), { id: 'slack', account: 'Analytical Engines' });
  assert.equal(b.urls[0].searchParams.get('redirect_uri'), 'http://localhost:53682/slack-callback');
  const s = config.getIntegration('slack');
  assert.equal(s.accessToken, 'xoxb-1');
  assert.equal(s.userAccessToken, 'xoxp-1');
  assert.equal(s.teamName, 'Analytical Engines');
  assert.equal(s.botUserId, 'B1');
}
{
  // Vercel's install page takes the slug and gives no state back; the redirect is main.js's.
  const b = browser('vercel.com', { redirect: 'http://localhost:53683/vercel-callback' });
  assert.deepEqual(await conn.connect(ctx, 'vercel', { openBrowser: b.open }), { id: 'vercel', account: 'ada-v' });
  assert.equal(b.urls[0].pathname, '/integrations/codeply-test/new');
  assert.equal(b.urls[0].searchParams.get('state'), null);
  assert.match(calls.find((c) => c.url.endsWith('/v2/oauth/access_token')).body, /redirect_uri=http%3A%2F%2Flocalhost%3A53683%2Fvercel-callback/);
  assert.deepEqual([config.getIntegration('vercel').accessToken, config.getIntegration('vercel').teamId, config.getIntegration('vercel').userName], ['v-at', 'team_1', 'ada-v']);
}
{
  const b = browser('api.supabase.com');
  assert.deepEqual(await conn.connect(ctx, 'supabase', { openBrowser: b.open }), { id: 'supabase', account: '' });
  assert.equal(b.urls[0].searchParams.get('redirect_uri'), 'http://localhost:53684/supabase-callback');
  assert.equal(calls.find((c) => c.url.endsWith('/v1/oauth/token')).auth, `Basic ${Buffer.from('sb-id:sb-secret').toString('base64')}`);
  assert.equal(config.getIntegration('supabase').refreshToken, 'sb-rt');
}
{
  // A stale tab with another state is turned away; the real redirect still lands.
  let stale;
  const b = browser('github.com');
  const open = (u) => {
    const back = new URL(new URL(u).searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'old'); back.searchParams.set('state', 'someone-else');
    stale = get(back.href).then((r) => { b.open(u); return r; });
  };
  assert.deepEqual(await conn.connect(ctx, 'github', { openBrowser: open }), { id: 'github', account: 'ada' });
  assert.equal((await stale).status, 400);
  assert.equal(b.urls[0].searchParams.get('redirect_uri'), 'http://localhost:53685/github-callback');
  assert.match(calls.find((c) => c.url === 'https://github.com/login/oauth/access_token').body, /code=the-code/);
  assert.deepEqual([config.getIntegration('github').accessToken, config.getIntegration('github').userName], ['gh-at', 'ada']);
}

assert.deepEqual(conn.status(ctx).map((s) => [s.id, s.connected, s.account]), [
  ['gmail', true, 'ada@example.com'], ['slack', true, 'Analytical Engines'], ['vercel', true, 'ada-v'], ['supabase', true, ''], ['github', true, 'ada'],
]);

// The provider says no.
{
  const b = browser('accounts.google.com', { query: { error: 'access_denied' } });
  await assert.rejects(conn.connect(ctx, 'gmail', { openBrowser: b.open }), /access_denied/);
  assert.match((await b.page).body, /didn't finish/);
  assert.equal(config.getIntegration('gmail').accessToken, 'gm-at', 'a failed sign-in leaves the old one');
}
// Cancel while the browser is open: the port is free again afterwards.
{
  const ctl = new AbortController();
  const p = conn.connect(ctx, 'slack', { openBrowser: () => setTimeout(() => ctl.abort(), 20), signal: ctl.signal });
  await assert.rejects(p, /cancelled/);
  const again = browser('slack.com');
  await conn.connect(ctx, 'slack', { openBrowser: again.open });
}
// The port is taken (the Electron app is signing in to GitHub at the same moment).
{
  const blocker = net.createServer().listen(53685, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  await assert.rejects(conn.connect(ctx, 'github', { openBrowser: () => assert.fail('no browser when the port is taken') }), /port 53685 is in use/);
  blocker.close();
}
// The browser never comes back.
await assert.rejects(conn.connect(ctx, 'github', { openBrowser: () => {}, timeoutMs: 50 }), /Timed out/);
await assert.rejects(conn.connect(ctx, 'dropbox', { openBrowser: () => {} }), /Unknown connection/);

// ---------- the Apps page ----------

const apps = need('apps.js');
appsExt.start(ctx);
let out;
const reply = (status, body) => { out = [status, body]; };
const call = async (method, p, body) => {
  const url = new URL(`http://x${p}`);
  out = null;
  const took = await appsExt.route(ctx, { method, body: body || {} }, {}, url, url.pathname, reply);
  assert.ok(took, `${method} ${p} answered`);
  return out;
};

// Featured: the five built-ins first, then 20 vendors' own servers; Vercel and Supabase once.
let [st, page] = await call('GET', '/ext/apps?limit=60');
assert.equal(st, 200);
const names = page.apps.filter((a) => a.verified).map((a) => a.name);
assert.deepEqual(names.slice(0, 5), ['Gmail', 'Slack', 'Vercel', 'Supabase', 'GitHub']);
assert.equal(names.length, 25);
assert.deepEqual(names.slice(5, 9), ['Notion', 'Linear', 'Figma', 'Atlassian']);
assert.equal(names.filter((n) => n === 'Vercel').length, 1);
assert.equal(names.filter((n) => n === 'Supabase').length, 1);
const gmail = page.apps[0];
assert.equal(gmail.id, 'builtin:gmail');
assert.equal(gmail.builtin, true);
assert.equal(gmail.connected, true);
assert.equal(gmail.account, 'ada@example.com');
assert.equal(gmail.domain, 'mail.google.com');
assert.deepEqual(page.connected.slice(0, 5).map((a) => a.id), ['builtin:gmail', 'builtin:slack', 'builtin:vercel', 'builtin:supabase', 'builtin:github']);
// An older apps.js (Vercel's and Supabase's servers still in FEATURED) shows each once too.
const old = appsExt._test.featuredEntries({ FEATURED: [
  { id: 'notion', title: 'Notion', url: 'https://mcp.notion.com/mcp', category: 'Productivity' },
  { id: 'vercel', title: 'Vercel', url: 'https://mcp.vercel.com', category: 'Developer' },
  { id: 'supabase', title: 'Supabase', url: 'https://mcp.supabase.com/mcp', category: 'Developer' },
] });
assert.deepEqual(old.map((e) => e.title), ['Gmail', 'Slack', 'Vercel', 'Supabase', 'GitHub', 'Notion']);
// A crawl that finds Vercel's server doesn't list it again.
const built = appsExt._test.build(appsExt._test.featuredEntries(apps), [{ id: 'com.vercel/vercel-mcp', title: 'Vercel MCP', desc: '', url: 'https://mcp.vercel.com', domain: 'vercel.com', icon: '', cat: 'Developer', rank: 9, header: '', tmpl: '' }]);
assert.equal(built.filter((e) => e.title.startsWith('Vercel')).length, 1);
// Search finds a built-in by name.
[st, page] = await call('GET', '/ext/apps?q=slack');
assert.equal(page.apps[0].id, 'builtin:slack');

// Manage: what the agent can do with it, then Disconnect.
[st, page] = await call('GET', '/ext/apps/tools?id=builtin:gmail');
assert.ok(page.tools.some((t) => t.name === 'gmail_send' && t.title === 'Send an email' && !t.readOnly));
assert.ok(page.tools.some((t) => t.name === 'gmail_search' && t.readOnly));
events.length = 0;
[st] = await call('POST', '/ext/apps/disconnect', { id: 'builtin:github' });
assert.equal(st, 200);
assert.equal(config.getIntegration('github').accessToken, '');
assert.equal(config.getIntegration('github').clientId, 'gh-id', 'disconnect keeps the client id');
assert.ok(events.some((e) => e.type === 'apps_changed'));
[st, page] = await call('GET', '/ext/apps/tools?id=builtin:github');
assert.match(page.error, /not connected/);

// Connect from the page: progress in the banner's events, the browser opened through the app.
events.length = 0;
[st, page] = await call('POST', '/ext/apps/connect', { id: 'builtin:github' });
assert.equal(st, 202);
for (let i = 0; i < 100 && !events.some((e) => e.type === 'open_url'); i++) await new Promise((r) => setTimeout(r, 10));
const opened = events.find((e) => e.type === 'open_url');
assert.match(opened.url, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
// A second connect while this one waits is refused.
[st, page] = await call('POST', '/ext/apps/connect', { id: 'builtin:slack' });
assert.equal(st, 409);
assert.match(page.error, /GitHub is signing in/);
browser('github.com').open(opened.url);
for (let i = 0; i < 200 && !events.some((e) => e.type === 'apps_changed'); i++) await new Promise((r) => setTimeout(r, 10));
const prog = events.filter((e) => e.type === 'apps_progress').map((e) => e.state);
assert.deepEqual(prog, ['start', 'waiting', 'done']);
assert.equal(events.filter((e) => e.type === 'apps_progress').at(-1).message, 'GitHub is connected as ada.');
[st, page] = await call('GET', '/ext/apps?q=github');
assert.equal(page.apps[0].connected, true);

// A failed connect says why in the banner.
delete process.env.SUPABASE_CLIENT_ID;
const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.codeply', 'config.json'), 'utf8'));
process.env.CODEPLY_SECRETS_DIRS = path.join(tmp, 'nowhere');
ctx.CLI = path.join(tmp, 'nowhere', 'codeply-cli');
events.length = 0;
await call('POST', '/ext/apps/connect', { id: 'builtin:supabase' });
for (let i = 0; i < 100 && !events.some((e) => e.type === 'apps_changed'); i++) await new Promise((r) => setTimeout(r, 10));
const err = events.find((e) => e.type === 'apps_progress' && e.state === 'error');
assert.match(err.message, /^Couldn't connect Supabase: this copy of Codeply has no Supabase sign-in set up/);
assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, '.codeply', 'config.json'), 'utf8')).supabase.accessToken, saved.supabase.accessToken);

// The status route.
const r2 = [];
await conn.route(ctx, { method: 'GET' }, {}, new URL('http://x/ext/connections'), '/ext/connections', (s, b) => r2.push(s, b));
assert.equal(r2[0], 200);
assert.equal(r2[1].connections.length, 5);
assert.ok(!JSON.stringify(r2[1]).includes('gm-at'), 'no token leaves the engine');
assert.ok(!JSON.stringify(await call('GET', '/ext/apps?limit=60')).includes('gm-at'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ext-connections ok');
process.exit(0);
