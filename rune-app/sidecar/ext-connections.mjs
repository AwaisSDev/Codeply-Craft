// Codeply's own sign-ins: Gmail, Slack, Vercel, Supabase and GitHub, the way the Electron app runs
// them (root main.js, "Connect Apps"). The browser is the user's own; the redirect lands on a
// one-shot loopback server on the same fixed port and path the registered OAuth apps expect, and
// the tokens are saved with config.js's saveIntegration in the same shape, so everything that
// reads them (the agent's gmail_*/slack_*/vercel_*/supabase_*/github_* tools, ext-prs, ext-cloud,
// the Electron app itself) keeps working.
//
// The OAuth apps' client ids and secrets come from where the Electron app gets them: the
// environment, a source checkout's .env, or the build-secrets.json a release build embeds
// (scripts/embed-secrets.js). An installed app keeps that file inside resources/app.asar, so it
// is read from the archive here. The Apps page (ext-apps.mjs) shows these as built-in apps.
//
//   GET /ext/connections     { connections: [{ id, title, connected, account }] }
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** The built-ins, in the order the Apps page features them. Ports and paths are main.js's. */
export const BUILT_INS = [
  { id: 'gmail', title: 'Gmail', domain: 'mail.google.com', category: 'Communication', env: 'GMAIL', port: 53681, path: '/gmail-callback',
    description: 'Read, search, draft and send email, and keep your Google Calendar' },
  { id: 'slack', title: 'Slack', domain: 'slack.com', category: 'Communication', env: 'SLACK', port: 53682, path: '/slack-callback',
    description: 'Post to channels and hear from your team in Slack' },
  { id: 'vercel', title: 'Vercel', domain: 'vercel.com', category: 'Developer', env: 'VERCEL', port: 53683, path: '/vercel-callback',
    description: 'Deploy your projects and manage them on Vercel' },
  { id: 'supabase', title: 'Supabase', domain: 'supabase.com', category: 'Developer', env: 'SUPABASE', port: 53684, path: '/supabase-callback',
    description: 'Create databases, run SQL and manage your Supabase projects' },
  { id: 'github', title: 'GitHub', domain: 'github.com', category: 'Developer', env: 'GITHUB', port: 53685, path: '/github-callback',
    description: 'Create repositories and work with your GitHub pull requests' },
];
const byId = new Map(BUILT_INS.map((b) => [b.id, b]));

/** The id the Apps page gives a built-in ("builtin:gmail"), so it never meets an MCP app's id. */
export const PREFIX = 'builtin:';
export const builtInOf = (appId) => (typeof appId === 'string' && appId.startsWith(PREFIX) ? byId.get(appId.slice(PREFIX.length)) || null : null);

/** What the agent can do with each, for Manage (the tools in codeply-cli/lib/tools.mjs). */
export const TOOLS = {
  gmail: [
    ['gmail_search', 'Search your mail', true], ['gmail_read', 'Read one message', true], ['gmail_draft', 'Save a draft', false],
    ['gmail_send', 'Send an email', false], ['calendar_list', 'List your calendar events', true], ['calendar_add', 'Add an event', false],
    ['calendar_update', 'Move, rename or cancel an event', false],
  ],
  slack: [['slack_post_message', 'Post a message to a channel', false]],
  vercel: [['vercel_deploy', 'Deploy a project', false], ['vercel_api', 'Read and change your Vercel projects', false]],
  supabase: [
    ['supabase_schema', 'Read a project\'s tables', true], ['supabase_sql', 'Run SQL on a project', false], ['supabase_setup', 'Set up a project for an app', false],
    ['supabase_create_project', 'Create a project', false], ['supabase_delete_project', 'Delete a project', false], ['supabase_api', 'Call the Management API', false],
  ],
  github: [['github_create_repo', 'Create a repository', false]],
};

// ---------- the OAuth apps' credentials ----------

const SECRET_KEYS = [
  'VERCEL_CLIENT_ID', 'VERCEL_CLIENT_SECRET', 'VERCEL_SLUG',
  'SUPABASE_CLIENT_ID', 'SUPABASE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET',
  'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET',
];

/** KEY=value lines, as dotenv reads them (comments, quotes, `export`). */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/**
 * One file out of an Electron asar archive (resources/app.asar), or null. The archive starts with
 * two Chromium pickles: [4][header size] then [payload size][json length][json]; file data starts
 * after the header, at each entry's offset. An unpacked entry lives in app.asar.unpacked/.
 */
export function readAsarFile(archive, name) {
  let fd;
  try {
    fd = fs.openSync(archive, 'r');
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16 || head.readUInt32LE(0) !== 4) return null;
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (jsonLen > headerSize || jsonLen > 256 * 1024 * 1024) return null;
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    let node = JSON.parse(json.toString('utf8'));
    for (const part of name.split('/')) {
      node = node && node.files && Object.prototype.hasOwnProperty.call(node.files, part) ? node.files[part] : null;
      if (!node) return null;
    }
    if (node.unpacked) return fs.readFileSync(path.join(`${archive}.unpacked`, name));
    const size = Number(node.size);
    if (!Number.isFinite(size) || size < 0 || size > 1024 * 1024) return null;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 8 + headerSize + Number(node.offset));
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** Folders that may hold the Codeply app's secrets: the ones the app found installs in, and codeply-cli's parent. */
function secretDirs(ctx) {
  const dirs = String(process.env.CODEPLY_SECRETS_DIRS || '').split(path.delimiter).filter(Boolean);
  if (ctx && ctx.CLI) dirs.push(path.dirname(ctx.CLI));
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

/** The credentials found in `dir`, in main.js's order: a source checkout's .env, then build-secrets.json. */
function secretsIn(dir) {
  const found = [];
  try { found.push(parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8'))); } catch {}
  for (const read of [
    () => fs.readFileSync(path.join(dir, 'build-secrets.json')),
    () => readAsarFile(path.join(dir, 'app.asar'), 'build-secrets.json'),
    () => fs.readFileSync(path.join(dir, 'app', 'build-secrets.json')),
  ]) {
    try { const b = read(); if (b) found.push(JSON.parse(b.toString('utf8'))); } catch {}
  }
  return found;
}

/**
 * Puts the OAuth apps' credentials into process.env, as main.js does at launch (never over a
 * value already set), so config.getIntegration fills client ids in and token refreshes work.
 * Returns where they came from, for messages.
 */
export function loadSecrets(ctx) {
  const from = [];
  for (const dir of secretDirs(ctx)) {
    for (const set of secretsIn(dir)) {
      let took = false;
      for (const k of SECRET_KEYS) {
        const v = set && typeof set[k] === 'string' ? set[k].trim() : '';
        if (v && !process.env[k]) { process.env[k] = v; took = true; }
      }
      if (took) from.push(dir);
    }
  }
  return from;
}

// ---------- status ----------

function accountOf(id, g) {
  if (id === 'gmail' || id === 'supabase') return g.email || '';
  if (id === 'slack') return g.teamName || '';
  return g.userName || '';
}

/** Each built-in's state: { id, title, connected, account }. */
export function status(ctx) {
  let config = null;
  try { config = ctx.need('config.js'); } catch {}
  return BUILT_INS.map((b) => {
    let g = {};
    try { g = config ? config.getIntegration(b.id) || {} : {}; } catch {}
    return { id: b.id, title: b.title, connected: !!g.accessToken, account: g.accessToken ? accountOf(b.id, g) : '' };
  });
}

export function disconnect(ctx, id) {
  if (!byId.has(id)) throw new Error('Unknown connection.');
  ctx.need('config.js').disconnectIntegration(id);
}

// ---------- signing in ----------

function page(ok, title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return '<!doctype html><html><head><meta charset="utf-8"><title>Codeply</title></head>'
    + '<body style="font-family:system-ui,sans-serif;background:#0a0a0c;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
    + `<div style="text-align:center"><div style="font-size:20px;font-weight:600;color:${ok ? '#e4e4e7' : '#f87171'}">${esc(title)}</div>`
    + `<div style="margin-top:8px;color:#a1a1aa">${esc(text)}</div></div></body></html>`;
}

/**
 * Opens `authUrl` with `openBrowser` once the loopback server listens on `port`, and resolves with
 * the `code` from the one request that lands on `pathname` (main.js's awaitOAuthRedirect). When
 * `state` is given, the redirect must carry it back. Rejects on the provider's error, a timeout,
 * a cancel (`signal`), or a port already in use.
 */
export function awaitRedirect({ authUrl, port, pathname, label, state, openBrowser, signal, timeoutMs = SIGN_IN_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== pathname) { res.writeHead(404); res.end(); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error_description') || url.searchParams.get('error');
      const badState = !error && state && url.searchParams.get('state') !== state;
      const ok = !error && !badState && !!code;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      if (badState) { // not ours (an old tab): keep waiting for the real one
        res.end(page(false, 'Sign-in didn\'t finish', 'This sign-in came from somewhere else, so Codeply ignored it.'));
        return;
      }
      // Settle once the page has gone out, so closing the server doesn't cut it off.
      res.on('finish', () => {
        if (error) finish(new Error(error));
        else if (!code) finish(new Error('No authorization code in the redirect.'));
        else finish(null, code);
      });
      res.end(ok ? page(true, `${label} is connected`, 'You can close this tab and go back to Codeply.')
        : page(false, 'Sign-in didn\'t finish', error || 'There was no authorization code in the redirect.'));
    });
    function finish(err, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      server.close();
      server.closeAllConnections?.();
      if (err) reject(err); else resolve(code);
    }
    const onAbort = () => finish(new Error('Sign-in cancelled.'));
    if (signal) {
      if (signal.aborted) return reject(new Error('Sign-in cancelled.'));
      signal.addEventListener('abort', onAbort);
    }
    server.on('error', (e) => finish(e && e.code === 'EADDRINUSE'
      ? new Error(`port ${port} is in use, so the ${label} sign-in can't come back to Codeply. Finish or close the other ${label} sign-in (the Codeply app's Connect Apps, perhaps) and try again.`)
      : e));
    timer = setTimeout(() => finish(new Error('Timed out waiting for the browser sign-in.')), timeoutMs);
    timer.unref?.();
    server.listen(port, '127.0.0.1', () => {
      try { openBrowser(authUrl); } catch (e) { finish(e); }
    });
  });
}

function withState(url, state) {
  return `${url}${url.includes('?') ? '&' : '?'}state=${encodeURIComponent(state)}`;
}

/**
 * Signs in to a built-in and saves it (main.js's integrations:connect* handlers).
 * @param {object} opts { openBrowser(url), signal? }
 * @returns {Promise<{ id, account }>}
 */
export async function connect(ctx, id, opts = {}) {
  const b = byId.get(id);
  if (!b) throw new Error('Unknown connection.');
  if (typeof opts.openBrowser !== 'function') throw new Error('connect needs openBrowser');
  const config = ctx.need('config.js');
  const oauth = ctx.need('oauth-connectors.js');
  loadSecrets(ctx);
  const stored = config.getIntegration(id);
  const { clientId, clientSecret } = stored;
  if (!clientId || !clientSecret) {
    throw new Error(`this copy of Codeply has no ${b.title} sign-in set up (its OAuth client ID and secret are missing). Install the Codeply app, or set ${b.env}_CLIENT_ID and ${b.env}_CLIENT_SECRET in the .env beside codeply-cli, then try again.`);
  }
  const redirectUri = `http://localhost:${b.port}${b.path}`;
  // Vercel's install flow doesn't hand a state back (main.js sends none); the others do.
  const state = id === 'vercel' ? '' : crypto.randomBytes(18).toString('base64url');
  const wait = (authUrl) => awaitRedirect({ authUrl: state ? withState(authUrl, state) : authUrl, port: b.port, pathname: b.path, label: b.title, state, openBrowser: opts.openBrowser, signal: opts.signal, timeoutMs: opts.timeoutMs });

  if (id === 'gmail') {
    const code = await wait(oauth.buildGmailAuthUrl(clientId, redirectUri));
    const tokens = await oauth.exchangeGmailCode(clientId, clientSecret, code, redirectUri);
    const email = await oauth.getGmailProfile(tokens.access_token);
    config.saveIntegration('gmail', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || config.getIntegration('gmail').refreshToken,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      email,
      scope: tokens.scope || '',
    });
    return { id, account: email || '' };
  }
  if (id === 'slack') {
    const code = await wait(oauth.buildSlackAuthUrl(clientId, redirectUri));
    const r = await oauth.exchangeSlackCode(clientId, clientSecret, code, redirectUri);
    config.saveIntegration('slack', {
      accessToken: r.access_token,
      userAccessToken: r.authed_user?.access_token || '',
      userId: r.authed_user?.id || '',
      teamId: r.team?.id || '',
      teamName: r.team?.name || '',
      botUserId: r.bot_user_id || '',
    });
    return { id, account: r.team?.name || '' };
  }
  if (id === 'vercel') {
    const slug = stored.slug || process.env.VERCEL_SLUG || 'codeply-craft';
    const code = await wait(oauth.buildVercelAuthUrl(slug));
    const tokens = await oauth.exchangeVercelCode(clientId, clientSecret, code, redirectUri);
    const userName = await oauth.getVercelProfile(tokens.access_token).catch(() => '');
    config.saveIntegration('vercel', { accessToken: tokens.access_token, teamId: tokens.team_id || '', userName });
    return { id, account: userName };
  }
  if (id === 'supabase') {
    const code = await wait(oauth.buildSupabaseAuthUrl(clientId, redirectUri));
    const tokens = await oauth.exchangeSupabaseCode(clientId, clientSecret, code, redirectUri);
    config.saveIntegration('supabase', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || config.getIntegration('supabase').refreshToken,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    });
    return { id, account: config.getIntegration('supabase').email || '' };
  }
  // github
  const code = await wait(oauth.buildGithubAuthUrl(clientId, redirectUri));
  const tokens = await oauth.exchangeGithubCode(clientId, clientSecret, code, redirectUri);
  const userName = await oauth.getGithubProfile(tokens.access_token).catch(() => '');
  config.saveIntegration('github', { accessToken: tokens.access_token, userName, scope: tokens.scope || '' });
  return { id, account: userName };
}

export function start(ctx) {
  // The agent's Gmail and Supabase tools refresh their tokens with these, so load them at launch.
  try { loadSecrets(ctx); } catch {}
}

export async function route(ctx, req, res, url, p, reply) {
  if (req.method === 'GET' && p === '/ext/connections') return reply(200, { connections: status(ctx) }), true;
  return false;
}
