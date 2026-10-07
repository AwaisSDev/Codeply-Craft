/**
 * Codeply - end-to-end publishing.
 *
 * "Publish the website" turns into: a database on Supabase when the app needs
 * one (project picked or created, URL + anon key written into the app the way
 * its stack reads them, schema applied with RLS), a live Vercel deployment
 * (project, env vars, file upload, build polled until READY) and, if the user
 * wants it, a GitHub repo linked to the Vercel project so later pushes deploy
 * on their own. The user only connects Vercel and Supabase (and GitHub if
 * they opt in); the agent does the rest through the tools made here.
 *
 * Nothing in this file runs unless the user asked to publish: the tools
 * refuse when the request in front of them is not a publish request, every
 * step that creates something or goes live asks first, and no token is ever
 * written to output, logs or files. Progress is reported as a card (Database,
 * Vercel, GitHub, Live) that the desktop app draws from each result's meta.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const oauth = require('./oauth-connectors.js');

const STATE_FILE = path.join('.codeply', 'publish.json');
const LABEL = { supabase: 'Supabase', vercel: 'Vercel', github: 'GitHub' };

// Only a request that is about putting the app online opens this flow. Checked
// against the user's own message, so a model that drifts into "let me deploy
// it for you" after an unrelated edit is stopped by the tool itself.
const PUBLISH_INTENT = /\b(publish|deploy|re-?deploy|go live|put (?:it|this|the \w+) (?:live|online|on the (?:web|internet))|make (?:it|this) live|ship (?:it|this)|host (?:it|this)|launch|vercel|live link|live url|online)\b/i;

function wantsPublish(message) {
  return message == null || PUBLISH_INTENT.test(String(message));
}

const NOT_ASKED =
  'The user has not asked to publish or deploy in this request, so nothing was published. Never publish unprompted. ' +
  'Finish what they asked for; you may mention in one line that you can publish it when they want.';

// ─── Project state (.codeply/publish.json) ─────────────────────────────────
// Ids and names only, never a token or key: which Vercel project, which
// Supabase project, the GitHub repo and whether the user wanted GitHub.

function readState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8')) || {}; } catch { return {}; }
}

function saveState(root, patch) {
  const prev = readState(root);
  const next = { ...prev };
  for (const [k, v] of Object.entries(patch)) next[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(prev[k] || {}), ...v } : v;
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, '.codeply'), { recursive: true });
  fs.writeFileSync(path.join(root, STATE_FILE), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// ─── Stack detection ────────────────────────────────────────────────────────
// Decides three things: Vercel's framework preset, whether Vercel runs a
// build, and where the Supabase URL/key go so this stack actually reads them.

function readPackage(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
}

function depsOf(pkg) {
  return { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
}

const STACKS = [
  { id: 'next', label: 'Next.js', dep: 'next', framework: 'nextjs', envFile: '.env.local', prefix: 'NEXT_PUBLIC_' },
  { id: 'sveltekit', label: 'SvelteKit', dep: '@sveltejs/kit', framework: 'sveltekit', envFile: '.env', prefix: 'PUBLIC_' },
  { id: 'nuxt', label: 'Nuxt', dep: 'nuxt', framework: 'nuxtjs', envFile: '.env', prefix: 'NUXT_PUBLIC_' },
  { id: 'astro', label: 'Astro', dep: 'astro', framework: 'astro', envFile: '.env', prefix: 'PUBLIC_' },
  { id: 'remix', label: 'Remix', dep: '@remix-run/react', framework: 'remix', envFile: '.env', prefix: '' },
  { id: 'vite', label: 'Vite', dep: 'vite', framework: 'vite', envFile: '.env', prefix: 'VITE_' },
  { id: 'cra', label: 'Create React App', dep: 'react-scripts', framework: 'create-react-app', envFile: '.env', prefix: 'REACT_APP_' },
  { id: 'angular', label: 'Angular', dep: '@angular/core', framework: 'angular', envFile: '.env', prefix: 'NG_APP_' },
];
const SERVER_DEPS = ['express', 'fastify', 'koa', 'hono', '@hapi/hapi', 'restify'];

function detectStack(root) {
  const pkg = readPackage(root);
  const deps = depsOf(pkg);
  for (const s of STACKS) {
    if (deps[s.dep]) return { ...s, builds: true, server: false };
  }
  if (pkg) {
    const server = SERVER_DEPS.find((d) => deps[d]);
    if (server) return { id: 'node', label: `Node (${server})`, framework: null, envFile: '.env', prefix: '', builds: false, server: true };
    if (pkg.scripts?.build) return { id: 'npm', label: 'npm build', framework: null, envFile: '.env', prefix: '', builds: true, server: false, buildCommand: 'npm run build', outputDirectory: 'dist' };
  }
  // Plain HTML/CSS/JS: nothing builds, so the browser reads the values from a
  // small env.js that the pages load before their own scripts.
  return { id: 'static', label: 'Static site', framework: null, envFile: null, configJs: 'env.js', prefix: '', builds: false, server: false };
}

function envNames(stack) {
  return { url: `${stack.prefix}SUPABASE_URL`, key: `${stack.prefix}SUPABASE_ANON_KEY` };
}

// ─── Project files ──────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.codeply', '.vercel', '.next', '.svelte-kit', '.nuxt', '.output', '.astro',
  '.cache', '.turbo', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build', 'out']);
const SKIP_FILES = /^(\.env(\..*)?|\.DS_Store|Thumbs\.db|npm-debug\.log.*|yarn-error\.log.*)$/i;
const MAX_DEPLOY_FILES = 5000;
const MAX_DEPLOY_BYTES = 200 * 1024 * 1024;

/** Every file Vercel gets: no .env files, no dependencies, no local build output when Vercel builds it again. */
function listProjectFiles(root, { builds = false, max = MAX_DEPLOY_FILES } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.well-known') continue;
        if (builds && dir === root && BUILD_OUTPUT_DIRS.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile() && !SKIP_FILES.test(e.name)) {
        out.push(abs);
        if (out.length >= max) break;
      }
    }
  }
  return out.sort();
}

// ─── Does the app need a database? ──────────────────────────────────────────
// Evidence, not a verdict the agent must follow: it reads the reasons and
// makes the call with what it knows about the app.

const SCAN_EXT = /\.(html?|jsx?|tsx?|mjs|cjs|vue|svelte|astro|py|sql|prisma)$/i;
const DB_LIBS = ['@supabase/supabase-js', '@supabase/ssr', 'pg', 'mysql2', 'mongoose', 'mongodb', 'prisma', '@prisma/client', 'sqlite3',
  'better-sqlite3', 'drizzle-orm', 'firebase', 'knex', 'sequelize'];

function detectDatabaseNeed(root) {
  const strong = [];
  const weak = [];
  let usesSupabase = false;
  const schemaFiles = [];
  const pkg = readPackage(root);
  const deps = depsOf(pkg);
  for (const lib of DB_LIBS) {
    if (!deps[lib]) continue;
    if (lib.startsWith('@supabase/')) usesSupabase = true;
    strong.push(`package.json depends on ${lib}`);
  }
  const seen = new Set();
  const note = (list, key, text) => { if (!seen.has(key) && list.length < 12) { seen.add(key); list.push(text); } };
  for (const abs of listProjectFiles(root, { max: 800 })) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (/\.sql$/i.test(rel) || /schema\.prisma$/i.test(rel)) {
      schemaFiles.push(rel);
      note(strong, `schema:${rel}`, `schema file ${rel}`);
      continue;
    }
    if (!SCAN_EXT.test(rel)) continue;
    if (/(^|\/)(api|pages\/api|app\/api)\//.test(rel)) note(weak, 'api', `server routes (${rel})`);
    let text;
    try {
      if (fs.statSync(abs).size > 300 * 1024) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (/@supabase\/supabase-js|supabase\.createClient|createClient\(\s*['"`]https:\/\/[a-z0-9]+\.supabase\.co|SUPABASE_URL/i.test(text)) {
      usesSupabase = true;
      note(strong, 'supabase', `uses Supabase already (${rel})`);
    }
    if (/type\s*=\s*["']password["']|\b(signUp|signIn|signInWithPassword|signInWithOAuth|logIn|register)\s*\(/.test(text)) note(strong, 'auth', `sign-in or sign-up (${rel})`);
    if (/<form[^>]*method\s*=\s*["']post/i.test(text) || /method\s*:\s*['"]POST['"]/i.test(text)) note(weak, 'post', `sends form data (${rel})`);
    if (/\b(app|router)\.(post|put|patch|delete)\s*\(/.test(text)) note(weak, 'routes', `server code that accepts data (${rel})`);
    if (/localStorage\.setItem/.test(text)) note(weak, 'local', `saves data only in the visitor's browser with localStorage (${rel})`);
  }
  const verdict = strong.length ? 'yes' : weak.length ? 'maybe' : 'no';
  return { verdict, reasons: [...strong, ...weak], strong, weak, usesSupabase, schemaFiles };
}

// ─── Writing Supabase settings into the app ─────────────────────────────────

/** Add or replace KEY=value lines, leaving the rest of the file alone. */
function upsertEnv(file, vars) {
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch {}
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  for (const { key, value } of vars) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i === -1) lines.push(`${key}=${value}`);
    else lines[i] = `${key}=${value}`;
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function readEnvFile(file) {
  const out = {};
  try {
    for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
    }
  } catch {}
  return out;
}

/** .env files stay out of git, so a push to GitHub never carries them. */
function ensureGitignore(root, entries = ['.env', '.env.local', '.env*.local', '.vercel', 'node_modules']) {
  const file = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (!missing.length) return false;
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, 'utf8');
  return true;
}

const ENV_JS_HEADER =
  '// Written by Codeply when publishing. The anon (publishable) key is meant to be\n' +
  '// public: Row Level Security on each table decides what it may read or write.\n' +
  '// Never put the service role key here.\n';

/**
 * Puts the project URL and anon key where this stack reads them. Returns the
 * files touched and the variables, so the same values can go to Vercel.
 */
function writeSupabaseConfig(root, stack, { url, anonKey }) {
  const names = envNames(stack);
  const vars = [{ key: names.url, value: url }, { key: names.key, value: anonKey }];
  const files = [];
  if (stack.configJs) {
    const js = `${ENV_JS_HEADER}window.SUPABASE_URL = ${JSON.stringify(url)};\nwindow.SUPABASE_ANON_KEY = ${JSON.stringify(anonKey)};\n`;
    fs.writeFileSync(path.join(root, stack.configJs), js, 'utf8');
    files.push(stack.configJs);
    // Load it before the page's own scripts, in every page that talks to
    // Supabase (and index.html, the usual entry point).
    for (const abs of listProjectFiles(root, { max: 400 })) {
      if (!/\.html?$/i.test(abs)) continue;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      let html;
      try { html = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (/<script[^>]+env\.js/i.test(html)) continue;
      if (!/supabase/i.test(html) && path.basename(rel).toLowerCase() !== 'index.html') continue;
      const depth = rel.split('/').length - 1;
      const src = `${'../'.repeat(depth)}${stack.configJs}`;
      const tag = `<script src="${src}"></script>`;
      let next;
      if (/<script\b/i.test(html)) next = html.replace(/<script\b/i, `${tag}\n<script`);
      else if (/<\/head>/i.test(html)) next = html.replace(/<\/head>/i, `${tag}\n</head>`);
      else next = `${tag}\n${html}`;
      fs.writeFileSync(abs, next, 'utf8');
      files.push(rel);
    }
  } else {
    upsertEnv(path.join(root, stack.envFile), vars);
    files.push(stack.envFile);
    ensureGitignore(root);
  }
  return { files, vars, names };
}

/** The public Supabase values to hand Vercel, read back from where supabase_setup wrote them. */
function publicEnvFor(root, state, stack) {
  const sb = state.supabase;
  if (!sb || !sb.envFile || stack.configJs) return [];
  const values = readEnvFile(path.join(root, sb.envFile));
  return (sb.vars || []).filter((k) => values[k]).map((k) => ({ key: k, value: values[k] }));
}

// ─── SQL schema with RLS ────────────────────────────────────────────────────

/**
 * Every table the SQL creates gets Row Level Security turned on (added when
 * the SQL forgot it). Tables with RLS but no policy are reported, because the
 * browser then can neither read nor write them.
 */
function prepareSchemaSql(sql) {
  const text = String(sql || '').trim();
  const tables = [];
  for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)/gi)) {
    const full = m[1].replace(/"/g, '');
    if (!tables.includes(full)) tables.push(full);
  }
  const bare = (t) => t.replace(/^public\./i, '');
  const mentions = (t, re) => re.test(text.replace(/"/g, '')) ? true : false;
  const addedRls = [];
  const lines = [text.replace(/;?\s*$/, ';')];
  for (const t of tables) {
    const name = bare(t).replace(/[.$]/g, '\\$&');
    if (!mentions(t, new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:public\\.)?${name}\\s+enable\\s+row\\s+level\\s+security`, 'i'))) {
      lines.push(`alter table ${t} enable row level security;`);
      addedRls.push(t);
    }
  }
  const noPolicy = tables.filter((t) => !new RegExp(`create\\s+policy[\\s\\S]*?\\bon\\s+(?:public\\.)?${bare(t)}\\b`, 'i').test(text.replace(/"/g, '')));
  return { sql: lines.join('\n'), tables, addedRls, noPolicy };
}

const DESTRUCTIVE_SQL = /\b(drop|truncate|delete\s+from)\b/i;

// ─── Vercel ─────────────────────────────────────────────────────────────────

function vercelCall(v, method, apiPath, body) {
  return oauth.apiCall(oauth.API.vercel(), v.accessToken, method, apiPath, body, { teamId: v.teamId || undefined });
}

/** Vercel's error in plain words, with what the user can do about it. */
function vercelError(r, what) {
  const msg = r.body?.error?.message || (typeof r.body === 'string' ? r.body.slice(0, 200) : '') || `HTTP ${r.status}`;
  let hint = '';
  if (r.status === 401 || r.status === 403) hint = ' The Vercel connection was refused. Reconnect Vercel in Connect Apps.';
  else if (r.status === 402) hint = ' Vercel says this needs a paid plan.';
  else if (r.status === 429) hint = ' Vercel is rate limiting this account. Wait a minute and try again.';
  const e = new Error(`${what} failed: ${msg}.${hint}`);
  e.status = r.status;
  return e;
}

async function ensureVercelProject(v, name, stack) {
  const got = await vercelCall(v, 'GET', `/v9/projects/${encodeURIComponent(name)}`);
  if (got.ok) return { id: got.body.id, name: got.body.name, created: false };
  if (got.status !== 404) throw vercelError(got, 'Looking up the Vercel project');
  const made = await vercelCall(v, 'POST', '/v11/projects', { name, framework: stack.framework });
  if (!made.ok) throw vercelError(made, 'Creating the Vercel project');
  return { id: made.body.id, name: made.body.name, created: true };
}

async function setVercelEnv(v, projectId, vars) {
  if (!vars.length) return;
  const r = await vercelCall(v, 'POST', `/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`,
    vars.map((x) => ({ key: x.key, value: x.value, type: 'encrypted', target: ['production', 'preview', 'development'] })));
  if (!r.ok) throw vercelError(r, 'Setting the Vercel environment variables');
}

/** Uploads each file once by its SHA-1 (Vercel skips ones it already has), a few at a time. */
async function uploadFiles(v, root, files) {
  const out = [];
  const base = oauth.API.vercel();
  const qs = v.teamId ? `?teamId=${encodeURIComponent(v.teamId)}` : '';
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const abs = files[next++];
      const data = fs.readFileSync(abs);
      const sha = crypto.createHash('sha1').update(data).digest('hex');
      const res = await fetch(`${base}/v2/files${qs}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${v.accessToken}`, 'Content-Type': 'application/octet-stream', 'x-vercel-digest': sha, 'Content-Length': String(data.length) },
        body: data,
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch {}
        throw vercelError({ status: res.status, body }, `Uploading ${path.relative(root, abs)}`);
      }
      out.push({ file: path.relative(root, abs).replace(/\\/g, '/'), sha, size: data.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function projectSettingsFor(stack) {
  const s = { framework: stack.framework };
  if (stack.buildCommand) s.buildCommand = stack.buildCommand;
  if (stack.outputDirectory) s.outputDirectory = stack.outputDirectory;
  return s;
}

async function createDeployment(v, { name, projectId, files, stack }) {
  const r = await vercelCall(v, 'POST', '/v13/deployments?skipAutoDetectionConfirmation=1', {
    name, project: projectId, target: 'production', files, projectSettings: projectSettingsFor(stack),
  });
  if (!r.ok) throw vercelError(r, 'Starting the Vercel deployment');
  return r.body;
}

const POLL_MS = () => Number(process.env.CODEPLY_PUBLISH_POLL_MS) || 3000;
const DEPLOY_TIMEOUT_MS = () => Number(process.env.CODEPLY_PUBLISH_TIMEOUT_MS) || 10 * 60 * 1000;
const FINAL_STATES = new Set(['READY', 'ERROR', 'CANCELED']);

async function waitForDeployment(v, id, signal) {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS();
  let last = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ...(last || {}), readyState: 'CANCELED' };
    const r = await vercelCall(v, 'GET', `/v13/deployments/${encodeURIComponent(id)}`);
    if (!r.ok) throw vercelError(r, 'Checking the deployment');
    last = r.body;
    const st = last.readyState || last.status;
    if (FINAL_STATES.has(st)) return { ...last, readyState: st };
    await new Promise((res) => setTimeout(res, POLL_MS()));
  }
  return { ...(last || {}), readyState: 'TIMEOUT' };
}

/** The last lines of the build log, errors first in mind. */
async function buildLog(v, id) {
  const r = await vercelCall(v, 'GET', `/v3/deployments/${encodeURIComponent(id)}/events?builds=1&limit=400`);
  if (!r.ok || !Array.isArray(r.body)) return '';
  const lines = r.body.map((e) => String(e.payload?.text ?? e.text ?? '').trimEnd()).filter(Boolean);
  return lines.slice(-40).join('\n');
}

async function liveUrl(v, project, deployment) {
  const r = await vercelCall(v, 'GET', `/v9/projects/${encodeURIComponent(project.id)}/domains`);
  const domains = r.ok ? (r.body.domains || []) : [];
  const custom = domains.find((d) => d.verified !== false && !/\.vercel\.app$/i.test(d.name));
  if (custom) return `https://${custom.name}`;
  // <project>.vercel.app is public; per-deployment URLs can sit behind Vercel login.
  const own = domains.filter((d) => /\.vercel\.app$/i.test(d.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (own) return `https://${own.name}`;
  if (project.name) return `https://${project.name}.vercel.app`;
  const alias = (deployment.alias || [])[0] || deployment.url;
  return alias ? `https://${String(alias).replace(/^https?:\/\//, '')}` : '';
}

async function linkGitRepo(v, projectId, repo) {
  const r = await vercelCall(v, 'POST', `/v9/projects/${encodeURIComponent(projectId)}/link`, { type: 'github', repo });
  if (r.ok) return { linked: true };
  const msg = r.body?.error?.message || `HTTP ${r.status}`;
  const needsApp = /install|permission|access|not found|integration|login connection/i.test(msg) || r.status === 400 || r.status === 404 || r.status === 403;
  return {
    linked: false,
    why: needsApp
      ? `Vercel could not reach ${repo} (${msg}). Install the Vercel app on your GitHub account at https://github.com/apps/vercel/installations/new, give it access to this repo, then publish again.`
      : `Vercel would not link ${repo}: ${msg}.`,
  };
}

// ─── Supabase ───────────────────────────────────────────────────────────────

function supabaseCall(token, method, apiPath, body) {
  return oauth.apiCall(oauth.API.supabase(), token, method, apiPath, body);
}

function supabaseError(r, what) {
  const msg = r.body?.message || r.body?.error || (typeof r.body === 'string' ? r.body.slice(0, 200) : '') || `HTTP ${r.status}`;
  const hint = r.status === 401 || r.status === 403 ? ' The Supabase connection was refused. Reconnect Supabase in Connect Apps.' : '';
  const e = new Error(`${what} failed: ${msg}.${hint}`);
  e.status = r.status;
  return e;
}

/** The project URL and its public key (publishable first, else anon). Never a secret or service role key. */
async function getPublicKeys(token, ref) {
  const r = await supabaseCall(token, 'GET', `/v1/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`);
  if (!r.ok || !Array.isArray(r.body)) throw supabaseError(r, 'Reading the project API keys');
  const safe = r.body.filter((k) => !/secret|service/i.test(`${k.type || ''} ${k.name || ''}`) && k.api_key);
  const key = safe.find((k) => /publishable/i.test(k.type || '')) || safe.find((k) => /^anon$/i.test(k.name || '')) || safe.find((k) => /anon|publishable/i.test(`${k.type} ${k.name}`));
  if (!key) throw new Error(`Project ${ref} has no public (anon) key yet. It may still be starting; try again in a minute.`);
  return { url: `https://${ref}.supabase.co`, anonKey: key.api_key };
}

// ─── Git ────────────────────────────────────────────────────────────────────

function git(args, cwd, extraEnv) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(extraEnv || {}) } }, (err, stdout, stderr) => {
      if (err) { err.output = `${stdout || ''}${stderr || ''}`; reject(err); return; }
      resolve(String(stdout || '').trim());
    });
  });
}

/** owner/name from a GitHub remote URL (https or ssh), or null. */
function githubRepoFromUrl(url) {
  const m = String(url || '').trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function sanitizeProjectName(raw) {
  const base = String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52);
  return base || 'codeply-site';
}

function sanitizeRepoName(raw) {
  return String(raw || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'codeply-site';
}

function hideSecrets(text, secrets) {
  let out = String(text || '');
  for (const s of secrets) if (s && s.length > 6) out = out.split(s).join('[hidden]');
  return out;
}

// ─── The progress card ──────────────────────────────────────────────────────

const STEPS = ['database', 'vercel', 'github', 'live'];

/** Merges a step update into this turn's card and returns a copy for meta.publish. */
function card(ctx, patch = {}) {
  if (!ctx.publishCard) {
    ctx.publishCard = { id: `pub-${Date.now().toString(36)}`, steps: Object.fromEntries(STEPS.map((s) => [s, { status: 'pending' }])), url: '' };
  }
  const c = ctx.publishCard;
  for (const [k, v] of Object.entries(patch.steps || {})) c.steps[k] = { ...c.steps[k], ...v };
  if (patch.url !== undefined) c.url = patch.url;
  return JSON.parse(JSON.stringify(c));
}

// ─── The tools ──────────────────────────────────────────────────────────────

/**
 * `deps` comes from tools.mjs: the config module (read through so tests can
 * stand in for the stored connections), a Supabase token getter that
 * refreshes OAuth tokens, and resolvePath.
 */
function makePublishTools({ config, getSupabaseToken, resolveDir }) {
  const integration = (name) => config.getIntegration(name);
  const connected = (name) => !!integration(name).accessToken;
  const rootOf = (args, ctx) => (args.path ? resolveDir(args.path, ctx.cwd) : ctx.cwd);

  function notConnected(service, ctx) {
    const label = LABEL[service];
    return {
      ok: false,
      output: `${label} is not connected. Call publish_connect with <service>${service}</service> so the user can connect it in one click, then carry on. Do not use a CLI instead.`,
      meta: { label: `${label} not connected`, publish: card(ctx, { steps: { [service === 'supabase' ? 'database' : service]: { status: 'waiting', detail: `Connect ${label}` } } }) },
    };
  }

  async function publish_check(args, ctx) {
    const root = rootOf(args, ctx);
    if (!fs.existsSync(root)) return { ok: false, output: `${args.path} does not exist.` };
    const stack = detectStack(root);
    const db = detectDatabaseNeed(root);
    const state = readState(ctx.cwd);
    const files = listProjectFiles(root, { builds: stack.builds });
    let remote = '';
    try { remote = await git(['remote', 'get-url', 'origin'], root); } catch {}
    const lines = [
      `Stack: ${stack.label}${stack.framework ? ` (Vercel preset "${stack.framework}")` : ''}${stack.builds ? ', Vercel runs the build' : ', no build step'}.`,
      `Files to upload: ${files.length}.`,
      `Database: ${db.verdict === 'yes' ? 'likely needed' : db.verdict === 'maybe' ? 'maybe' : 'no sign of one'}.`,
      ...db.reasons.map((r) => `  - ${r}`),
      db.usesSupabase ? 'The code already uses Supabase.' : '',
      db.schemaFiles.length ? `Schema files: ${db.schemaFiles.join(', ')}` : '',
      `Supabase settings go in: ${stack.configJs ? `${stack.configJs} (loaded by the pages, as window.SUPABASE_URL and window.SUPABASE_ANON_KEY)` : `${stack.envFile} as ${envNames(stack).url} and ${envNames(stack).key}`}.`,
      `Connected: Vercel ${connected('vercel') ? 'yes' : 'no'}, Supabase ${connected('supabase') ? 'yes' : 'no'}, GitHub ${connected('github') ? 'yes' : 'no'}.`,
      remote ? `Git remote: ${githubRepoFromUrl(remote) || 'not GitHub'}.` : 'No git remote yet.',
      state.vercel?.projectName ? `Published before as Vercel project "${state.vercel.projectName}"${state.vercel.url ? ` at ${state.vercel.url}` : ''}.` : 'Never published from here.',
      state.supabase?.ref ? `Supabase project already set up: ${state.supabase.name || state.supabase.ref} (${state.supabase.ref}).` : '',
      state.github?.choice ? `GitHub auto-deploy: ${state.github.choice === 'yes' ? (state.github.linked ? `linked to ${state.github.repo}` : 'wanted, not linked yet') : 'the user said no'}.` : 'GitHub auto-deploy: not asked yet (publish_deploy asks before the first deploy).',
      '',
      'Decide yourself whether the app needs a database: sign-in, data that must be saved and shared across visitors or devices, or code that already uses Supabase means yes; a brochure site or a page whose forms only need email means no.',
    ].filter((l) => l !== '');
    const needsDb = db.verdict !== 'no' || !!state.supabase?.ref;
    return {
      ok: true,
      output: lines.join('\n'),
      meta: {
        label: `${stack.label}, database ${db.verdict}`,
        publish: card(ctx, { steps: {
          database: state.supabase?.ref ? { status: 'done', detail: state.supabase.name || state.supabase.ref } : needsDb ? { status: 'pending', detail: 'Checking' } : { status: 'skipped', detail: 'Not needed' },
          github: state.github?.choice === 'no' ? { status: 'skipped', detail: 'Direct deploy' } : state.github?.linked ? { status: 'done', detail: state.github.repo } : {},
        } }),
      },
    };
  }

  async function publish_connect(args, ctx) {
    const service = String(args.service || '').trim().toLowerCase();
    if (!LABEL[service]) return { ok: false, output: 'publish_connect needs <service>: supabase, vercel or github.' };
    const label = LABEL[service];
    const step = service === 'supabase' ? 'database' : service;
    if (connected(service)) return { ok: true, output: `${label} is already connected. Carry on.`, meta: { label: `${label} connected` } };
    if (typeof ctx.ask !== 'function') {
      return {
        ok: false,
        output: `${label} is not connected and the user cannot be asked from here. Tell them to connect ${label} in Connect Apps (account menu, Connect Apps, ${label}) and to say "continue" when it is done. Stop here.`,
        meta: { label: `${label} not connected` },
      };
    }
    const why = String(args.reason || '').trim();
    const question = service === 'supabase'
      ? `${why || 'This app needs a database to save its data.'} Log in to your Supabase account so Codeply can set it up.`
      : service === 'vercel'
        ? `${why || 'Publishing puts the site on Vercel.'} Connect your Vercel account to continue.`
        : `${why || 'GitHub keeps the code and redeploys the site on every push.'} Connect your GitHub account to continue.`;
    const skip = service === 'supabase' ? 'Skip the database' : service === 'github' ? 'Skip GitHub, just deploy' : 'Not now';
    card(ctx, { steps: { [step]: { status: 'waiting', detail: `Waiting for you to connect ${label}` } } });
    const answer = await ctx.ask({ question, options: [skip], connect: service });
    if (connected(service)) {
      const who = integration(service);
      return {
        ok: true,
        output: `${label} is connected now${who.userName || who.email ? ` (${who.userName || who.email})` : ''}. Carry on with the publish right away, without asking again.`,
        meta: { label: `${label} connected`, publish: card(ctx, { steps: { [step]: { status: step === 'github' ? 'active' : 'pending', detail: `${label} connected` } } }) },
      };
    }
    const said = answer ? ` They answered: "${String(answer).slice(0, 200)}".` : '';
    const next = service === 'supabase'
      ? 'Publish without a database only if the app still works without one; otherwise stop and explain in plain words that the app needs Supabase to save its data.'
      : service === 'github'
        ? 'Deploy directly with publish_deploy instead.'
        : 'Stop here and tell the user publishing needs a Vercel connection.';
    return {
      ok: false,
      output: `The user did not connect ${label}.${said} ${next}`,
      meta: { label: `${label} not connected`, publish: card(ctx, { steps: { [step]: { status: 'skipped', detail: `${label} not connected` } } }) },
    };
  }

  async function supabase_setup(args, ctx) {
    if (!wantsPublish(ctx.userMessage) && !/supabase|database/i.test(String(ctx.userMessage || ''))) return { ok: false, output: NOT_ASKED };
    const token = await getSupabaseToken();
    if (!token) return notConnected('supabase', ctx);
    const root = ctx.cwd;
    const stack = detectStack(root);
    const state = readState(root);
    card(ctx, { steps: { database: { status: 'active', detail: 'Setting up Supabase' } } });
    const fail = (msg) => ({ ok: false, output: msg, meta: { label: 'Supabase setup failed', publish: card(ctx, { steps: { database: { status: 'error', detail: msg.slice(0, 200) } } }) } });

    const list = await supabaseCall(token, 'GET', '/v1/projects');
    if (!list.ok) return fail(supabaseError(list, 'Listing your Supabase projects').message);
    const projects = Array.isArray(list.body) ? list.body : [];
    const wanted = String(args.project || '').trim();
    let chosen = null;
    let create = wanted.toLowerCase() === 'new';
    if (wanted && !create) {
      chosen = projects.find((p) => p.ref === wanted) || projects.find((p) => p.name?.toLowerCase() === wanted.toLowerCase());
      if (!chosen) return fail(`No Supabase project "${wanted}". Projects on this account: ${projects.map((p) => `${p.name} (${p.ref})`).join(', ') || 'none'}.`);
    } else if (!create) {
      chosen = state.supabase?.ref ? projects.find((p) => p.ref === state.supabase.ref) : null;
      if (!chosen && projects.length) {
        if (typeof ctx.ask !== 'function') {
          return fail(`Ask the user which Supabase project to use, then call supabase_setup again with <project> set to its ref, or "new". Their projects: ${projects.map((p) => `${p.name} (${p.ref})`).join(', ')}.`);
        }
        const options = [...projects.slice(0, 4).map((p) => `${p.name} (${p.ref})`), 'Create a new project'];
        const answer = await ctx.ask({ question: 'Which Supabase project should this app use?', options });
        if (answer == null) return fail('The user did not pick a Supabase project. Stop and ask them which one to use.');
        const ref = String(answer).match(/\(([a-z0-9]{6,})\)\s*$/i)?.[1];
        chosen = ref ? projects.find((p) => p.ref === ref) : projects.find((p) => p.name?.toLowerCase() === String(answer).trim().toLowerCase());
        if (!chosen) create = /new|create/i.test(String(answer));
        if (!chosen && !create) return fail(`"${answer}" is not one of the Supabase projects. Ask again.`);
      } else if (!chosen) create = true;
    }

    let created = false;
    if (create) {
      const name = sanitizeProjectName(args.name || path.basename(root));
      const orgs = await supabaseCall(token, 'GET', '/v1/organizations');
      if (!orgs.ok) return fail(supabaseError(orgs, 'Listing your Supabase organizations').message);
      if (!Array.isArray(orgs.body) || !orgs.body.length) return fail('This Supabase account has no organization yet. Create one at supabase.com/dashboard, then publish again.');
      let org = orgs.body[0];
      if (orgs.body.length > 1 && typeof ctx.ask === 'function') {
        const answer = await ctx.ask({ question: 'Which Supabase organization should own the new project?', options: orgs.body.slice(0, 5).map((o) => o.name) });
        org = orgs.body.find((o) => o.name === answer) || org;
      }
      const detail = await supabaseCall(token, 'GET', `/v1/organizations/${encodeURIComponent(org.slug || org.id)}`);
      const plan = String((detail.ok && detail.body?.plan) || 'unknown').toLowerCase();
      const region = String(args.region || 'us-east-1').trim();
      const paid = plan !== 'free';
      const verdict = await ctx.approve({
        tool: 'supabase_setup',
        title: `Create Supabase project "${name}"`,
        detail: `Organization: ${org.name} (plan: ${plan}). Region: ${region}.\n` +
          (paid ? 'This organization is on a paid plan (or its plan is unknown), so a new project can add to your Supabase bill.\n' : 'Free plan: no charge. A free organization can have two active projects.\n') +
          'A strong database password is generated for you and not shown or saved in the app.',
        danger: paid,
      });
      if (verdict === 'reject') return { ok: false, output: 'The user declined creating a Supabase project. Ask whether to use an existing project or publish without a database.', meta: { rejected: true, publish: card(ctx, { steps: { database: { status: 'skipped', detail: 'Declined' } } }) } };
      try {
        chosen = await oauth.supabaseCreateProject(token, {
          name, organizationSlug: org.slug || org.id, region,
          dbPass: crypto.randomBytes(24).toString('base64url'),
          pollMs: Number(process.env.CODEPLY_PUBLISH_POLL_MS) || undefined,
        });
        created = true;
      } catch (e) {
        return fail(`Creating the Supabase project failed: ${e.message}`);
      }
    }

    let keys;
    try { keys = await getPublicKeys(token, chosen.ref); } catch (e) { return fail(e.message); }
    let written;
    try { written = writeSupabaseConfig(root, stack, keys); } catch (e) { return fail(`Could not write the Supabase settings into the app: ${e.message}`); }
    saveState(root, { supabase: { ref: chosen.ref, name: chosen.name, url: keys.url, envFile: stack.configJs ? null : stack.envFile, configJs: stack.configJs || null, vars: written.vars.map((v) => v.key) } });

    const readHow = stack.configJs
      ? `The pages now load ${stack.configJs} first, so the app code reads window.SUPABASE_URL and window.SUPABASE_ANON_KEY (for example supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)).`
      : `The app code must read ${written.names.url} and ${written.names.key} (the way ${stack.label} exposes env vars to the browser). publish_deploy copies them to the Vercel project.`;
    return {
      ok: true,
      output: `${created ? 'Created' : 'Using'} Supabase project "${chosen.name}" (ref ${chosen.ref}, ${keys.url}). Wrote its URL and anon key to ${written.files.join(', ')}. ` +
        `${readHow} The anon key is public by design; Row Level Security protects the data. Never put the service role key in client code. ` +
        'If the app needs tables, write the SQL and run it with supabase_schema (the user sees it and approves first). Check that the code uses these values before deploying.',
      meta: { label: `${chosen.name} (${chosen.ref})`, files: written.files, publish: card(ctx, { steps: { database: { status: 'done', detail: `${chosen.name}${created ? ' (new)' : ''}` } } }) },
    };
  }

  async function supabase_schema(args, ctx) {
    const state = readState(ctx.cwd);
    const ref = String(args.ref || state.supabase?.ref || '').trim();
    if (!ref) return { ok: false, output: 'No Supabase project yet. Run supabase_setup first, or pass <ref>.' };
    let sql = String(args.sql || '').trim();
    if (!sql && args.path) {
      try { sql = fs.readFileSync(resolveDir(args.path, ctx.cwd), 'utf8'); } catch (e) { return { ok: false, output: `Could not read ${args.path}: ${e.message}` }; }
    }
    if (!sql.trim()) return { ok: false, output: 'supabase_schema needs <sql> (or <path> to a .sql file).' };
    const token = await getSupabaseToken();
    if (!token) return notConnected('supabase', ctx);
    const prep = prepareSchemaSql(sql);
    const notes = [
      prep.addedRls.length ? `-- Codeply added: row level security on ${prep.addedRls.join(', ')}` : '',
      prep.noPolicy.length ? `-- Warning: no policy on ${prep.noPolicy.join(', ')}, so the app cannot read or write ${prep.noPolicy.length === 1 ? 'it' : 'them'} yet` : '',
    ].filter(Boolean);
    const verdict = await ctx.approve({
      tool: 'supabase_schema',
      title: `Run SQL on Supabase project ${state.supabase?.name || ref}`,
      detail: [...notes, prep.sql].join('\n').slice(0, 6000),
      danger: DESTRUCTIVE_SQL.test(prep.sql),
    });
    if (verdict === 'reject') return { ok: false, output: 'The user declined running that SQL. Nothing changed in the database. Ask what they want changed.', meta: { rejected: true } };
    let r;
    try { r = await oauth.supabaseQuery(token, ref, prep.sql); } catch (e) { return { ok: false, output: `Running the SQL failed: ${e.message}` }; }
    if (!r.ok) {
      const msg = r.body?.message || r.body?.error || JSON.stringify(r.body).slice(0, 400);
      return { ok: false, output: `Supabase rejected the SQL (HTTP ${r.status}): ${msg}. Fix the SQL and run supabase_schema again.`, meta: { label: 'SQL failed' } };
    }
    const warn = prep.noPolicy.length
      ? ` Warning: ${prep.noPolicy.join(', ')} ${prep.noPolicy.length === 1 ? 'has' : 'have'} RLS on but no policy, so the app can neither read nor write ${prep.noPolicy.length === 1 ? 'it' : 'them'}. Add policies (create policy ... on <table> for select/insert using (...)) with supabase_schema.`
      : '';
    return {
      ok: true,
      output: `Applied the SQL to ${ref}.${prep.tables.length ? ` Tables: ${prep.tables.join(', ')}.` : ''}${prep.addedRls.length ? ` Turned on row level security for ${prep.addedRls.join(', ')}.` : ''}${warn}`,
      meta: { label: prep.tables.length ? `tables ${prep.tables.join(', ')}` : 'SQL applied', publish: card(ctx, { steps: { database: { status: 'done', detail: prep.tables.length ? `${prep.tables.length} table(s) ready` : 'Schema applied' } } }) },
    };
  }

  async function publish_deploy(args, ctx) {
    if (!wantsPublish(ctx.userMessage)) return { ok: false, output: NOT_ASKED };
    const root = rootOf(args, ctx);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { ok: false, output: `${args.path || '.'} is not a folder.` };
    const v = integration('vercel');
    if (!v.accessToken) return notConnected('vercel', ctx);
    let state = readState(ctx.cwd);
    const stack = detectStack(root);

    // Before the very first deploy: GitHub or not. Asked once per project.
    if (!state.github?.choice && !state.vercel?.lastDeploymentId && typeof ctx.ask === 'function') {
      const answer = await ctx.ask({ question: 'Connect GitHub so pushes deploy automatically?', options: ['Yes, connect GitHub', 'No, just deploy'] });
      const yes = answer != null && /^\s*(yes|y|sure|ok)/i.test(String(answer));
      state = saveState(ctx.cwd, { github: { choice: yes ? 'yes' : 'no' } });
      if (yes) {
        return {
          ok: true,
          output: 'The user wants GitHub. Run publish_github now (it connects GitHub if needed, creates or reuses the repo, pushes and links it to Vercel), then call publish_deploy again for the first deploy.',
          meta: { label: 'GitHub first', publish: card(ctx, { steps: { github: { status: 'active', detail: 'Setting up GitHub' } } }) },
        };
      }
      card(ctx, { steps: { github: { status: 'skipped', detail: 'Direct deploy' } } });
    }

    const files = listProjectFiles(root, { builds: stack.builds });
    if (!files.length) return { ok: false, output: 'There are no files to publish in this folder.' };
    let bytes = 0;
    for (const f of files) bytes += fs.statSync(f).size;
    if (bytes > MAX_DEPLOY_BYTES) return { ok: false, output: `The folder is ${(bytes / 1e6).toFixed(0)}MB, over the ${MAX_DEPLOY_BYTES / 1e6}MB publish limit. Remove large files (videos, archives) or publish a smaller folder.` };
    const name = sanitizeProjectName(args.name || state.vercel?.projectName || path.basename(root));
    const env = publicEnvFor(ctx.cwd, state, stack);

    const verdict = await ctx.approve({
      tool: 'publish_deploy',
      title: `Publish "${name}" to Vercel`,
      detail: `${files.length} file(s), ${(bytes / 1024).toFixed(0)}KB, ${stack.label}.` +
        (env.length ? `\nEnvironment variables: ${env.map((e) => e.key).join(', ')}` : '') +
        '\nProduction deployment: it will be live on the internet.',
      danger: true,
    });
    if (verdict === 'reject') return { ok: false, output: 'The user declined publishing. Nothing was deployed.', meta: { rejected: true, publish: card(ctx, { steps: { vercel: { status: 'skipped', detail: 'Declined' } } }) } };

    const fail = (msg, extra = {}) => ({ ok: false, output: hideSecrets(msg, [v.accessToken]), meta: { label: 'publish failed', ...extra, publish: card(ctx, { steps: { vercel: { status: 'error', detail: hideSecrets(msg, [v.accessToken]).split('\n')[0].slice(0, 220) } } }) } });
    let project, deployment, final;
    try {
      card(ctx, { steps: { vercel: { status: 'active', detail: 'Preparing the project' } } });
      project = await ensureVercelProject(v, name, stack);
      state = saveState(ctx.cwd, { vercel: { projectId: project.id, projectName: project.name } });
      await setVercelEnv(v, project.id, env);
      const uploaded = await uploadFiles(v, root, files);
      deployment = await createDeployment(v, { name: project.name, projectId: project.id, files: uploaded, stack });
      final = await waitForDeployment(v, deployment.id, ctx.signal);
    } catch (e) {
      return fail(`Publishing to Vercel failed: ${e.message}`);
    }

    if (final.readyState === 'READY') {
      const url = await liveUrl(v, project, final).catch(() => `https://${project.name}.vercel.app`);
      saveState(ctx.cwd, { vercel: { url, lastDeploymentId: deployment.id, lastPublishedAt: new Date().toISOString() } });
      ctx.publishBuildFailures = 0;
      const gh = readState(ctx.cwd).github;
      return {
        ok: true,
        output: `Published. The site is live at ${url} (Vercel project "${project.name}", deployment ${deployment.id} is READY).` +
          (gh?.linked ? ` GitHub ${gh.repo} is linked, so every push to ${gh.branch || 'the main branch'} deploys on its own.` : '') +
          ' Give the user this link.',
        meta: { label: url, liveUrl: url, publish: card(ctx, { url, steps: { vercel: { status: 'done', detail: project.name }, live: { status: 'done', detail: url } } }) },
      };
    }
    if (final.readyState === 'ERROR') {
      ctx.publishBuildFailures = (ctx.publishBuildFailures || 0) + 1;
      const log = hideSecrets(await buildLog(v, deployment.id).catch(() => ''), [v.accessToken]);
      const first = ctx.publishBuildFailures === 1;
      return fail(
        `The build failed on Vercel (deployment ${deployment.id}).${log ? `\nBuild log, last lines:\n${log}` : ''}\n` +
          (first
            ? 'Find the cause in the project (the log above names it), fix it, check it locally if you can, then call publish_deploy again. You get one retry.'
            : 'It failed again after a fix. Stop retrying. Tell the user in plain words what failed and what you tried.'),
        { buildFailed: true },
      );
    }
    if (final.readyState === 'TIMEOUT') return fail(`Vercel is still building deployment ${deployment.id} after ${Math.round(DEPLOY_TIMEOUT_MS() / 60000)} minutes. Check it with vercel_api GET /v13/deployments/${deployment.id} before telling the user anything.`);
    return fail(`The deployment was canceled (${deployment.id}).`);
  }

  async function publish_github(args, ctx) {
    if (!wantsPublish(ctx.userMessage) && !/github|repo|push/i.test(String(ctx.userMessage || ''))) return { ok: false, output: NOT_ASKED };
    const root = rootOf(args, ctx);
    const gh = integration('github');
    if (!gh.accessToken) return notConnected('github', ctx);
    const v = integration('vercel');
    if (!v.accessToken) return notConnected('vercel', ctx);
    const secrets = [gh.accessToken, v.accessToken];
    const fail = (msg) => ({ ok: false, output: hideSecrets(msg, secrets), meta: { label: 'GitHub failed', publish: card(ctx, { steps: { github: { status: 'error', detail: hideSecrets(msg, secrets).slice(0, 220) } } }) } });

    const isRepo = fs.existsSync(path.join(root, '.git'));
    let remote = '';
    if (isRepo) { try { remote = await git(['remote', 'get-url', 'origin'], root); } catch {} }
    const existing = githubRepoFromUrl(remote);
    const repoName = sanitizeRepoName(args.name || path.basename(root));
    const isPrivate = !/^(false|no|public)$/i.test(String(args.private || ''));
    const verdict = await ctx.approve({
      tool: 'publish_github',
      title: existing ? `Push to ${existing} and link it to Vercel` : `Create GitHub repo "${repoName}" and link it to Vercel`,
      detail: (existing ? `Commits any changes and pushes to ${existing}.` : `Creates a ${isPrivate ? 'private' : 'public'} repo under ${gh.userName || 'your account'}, commits the project and pushes it.`) +
        '\n.env files are kept out of git. Then the Vercel project is linked to the repo, so every push deploys on its own.',
      danger: false,
    });
    if (verdict === 'reject') return { ok: false, output: 'The user declined the GitHub step. Deploy directly with publish_deploy.', meta: { rejected: true, publish: card(ctx, { steps: { github: { status: 'skipped', detail: 'Direct deploy' } } }) } };

    card(ctx, { steps: { github: { status: 'active', detail: existing ? `Pushing to ${existing}` : 'Creating the repo' } } });
    let full = existing;
    let branch = 'main';
    try {
      ensureGitignore(root);
      if (!isRepo) await git(['init', '-b', 'main'], root).catch(() => git(['init'], root));
      const name = await git(['config', 'user.name'], root).catch(() => '');
      const email = await git(['config', 'user.email'], root).catch(() => '');
      const ident = name && email ? [] : ['-c', `user.name=${name || gh.userName || 'Codeply'}`, '-c', `user.email=${email || `${gh.userName || 'codeply'}@users.noreply.github.com`}`];
      await git(['add', '-A'], root);
      const status = await git(['status', '--porcelain'], root);
      let hasHead = true;
      try { await git(['rev-parse', 'HEAD'], root); } catch { hasHead = false; }
      if (status || !hasHead) await git([...ident, 'commit', '-m', hasHead ? 'Publish with Codeply' : 'First commit', '--allow-empty'], root);
      branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)) || 'main';
      if (!existing) {
        const made = await oauth.githubCreateRepo(gh.accessToken, repoName, { private: isPrivate });
        full = made.full_name;
        await git(['remote', remote ? 'set-url' : 'add', 'origin', made.clone_url], root);
      }
      // The token rides an HTTP header for this one push only, never the
      // remote URL, so it is not left in .git/config.
      const basic = Buffer.from(`x-access-token:${gh.accessToken}`).toString('base64');
      await git(['-c', `http.extraHeader=Authorization: Basic ${basic}`, 'push', '-u', 'origin', branch], root);
    } catch (e) {
      const why = /already exists/i.test(e.message) ? `A repo named "${repoName}" already exists on your GitHub. Pick another <name>.` : (e.output || e.message);
      return fail(`The GitHub step failed: ${String(why).slice(0, 600)}`);
    }

    let project, link;
    try {
      const stack = detectStack(root);
      const state = readState(ctx.cwd);
      project = await ensureVercelProject(v, sanitizeProjectName(state.vercel?.projectName || path.basename(root)), stack);
      saveState(ctx.cwd, { vercel: { projectId: project.id, projectName: project.name } });
      link = await linkGitRepo(v, project.id, full);
    } catch (e) {
      link = { linked: false, why: e.message };
    }
    saveState(ctx.cwd, { github: { choice: 'yes', repo: full, branch, linked: link.linked } });
    if (!link.linked) {
      return {
        ok: true,
        output: `Pushed the code to ${full} (branch ${branch}), but linking it to Vercel did not work: ${link.why} Carry on with publish_deploy now; pushes will deploy on their own once the link works.`,
        meta: { label: full, publish: card(ctx, { steps: { github: { status: 'error', detail: link.why.slice(0, 220) } } }) },
      };
    }
    return {
      ok: true,
      output: `Pushed the code to ${full} (branch ${branch}) and linked it to the Vercel project "${project.name}". From now on every push to ${branch} deploys on its own. Now call publish_deploy for the first deploy.`,
      meta: { label: full, publish: card(ctx, { steps: { github: { status: 'done', detail: `${full}, auto-deploy on` } } }) },
    };
  }

  return { publish_check, publish_connect, supabase_setup, supabase_schema, publish_deploy, publish_github };
}

module.exports = {
  makePublishTools, wantsPublish, detectStack, detectDatabaseNeed, envNames, writeSupabaseConfig, prepareSchemaSql,
  listProjectFiles, readState, saveState, githubRepoFromUrl, ensureGitignore, STATE_FILE,
};
