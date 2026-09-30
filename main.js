/**
 * Codeply Craft - Electron main process.
 *
 * The AI engine is NOT reimplemented here: it is the exact agent loop the
 * Codeply CLI ships (codeply-cli/lib/agent.mjs + ai.js + tools.mjs), bundled
 * into this app under ./codeply-cli (see the CLI_DIR resolution below - a
 * packaged install has no sibling checkout to load it from, so it now ships
 * inside the app itself). Same tag protocol, same providers, same
 * ~/.codeply auth session and daily caps. This file only hosts it: window
 * chrome, chat session persistence, and the approval bridge between the
 * agent's ctx.approve() callback and the renderer's Accept/Reject UI.
 */
const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell, screen, Tray, Menu, nativeImage, powerSaveBlocker, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { pathToFileURL } = require('url');
const { execSync } = require('child_process');
// App-wide OAuth app credentials (Vercel / Supabase / GitHub / Gmail / Slack
// "Connect Apps"). From source they come from a local, gitignored .env (see
// .env.example). A release build has no .env - instead scripts/embed-secrets.js
// writes build-secrets.json (also gitignored) at build time and it ships
// inside the app, so connecting works for everyone who installs it.
require('dotenv').config({ path: path.join(__dirname, '.env') });
try {
  const baked = require('./build-secrets.json');
  for (const [key, value] of Object.entries(baked)) {
    if (value && !process.env[key]) process.env[key] = value;
  }
} catch {}

// ─── CLI engine location ────────────────────────────────────────────────────
// The engine is bundled INSIDE this app now (./codeply-cli), not loaded from
// a sibling checkout next to it - a packaged install has no such sibling, so
// that layout only ever worked from this repo's own source tree.
//
// codeply-cli is copied in via `extraResources` (see the build config), NOT
// packed into app.asar with the rest of this app's own code - on purpose,
// for two independent reasons that both point the same way:
//   1. electron-builder's asar packing runs its own dependency-pruning over
//      any node_modules it finds, keyed off THIS package's own dependency
//      tree. codeply-cli/node_modules is a separate package's dependencies,
//      unrelated to that tree, and got silently dropped when it was left
//      for that step to pick up - extraResources is a plain recursive copy,
//      no pruning, so what's on disk in the source tree is what ships.
//   2. agent.mjs is loaded with a dynamic `import()`, and Node's ESM loader
//      doesn't reliably follow Electron's asar interception the way
//      require() does even for paths that ARE correctly unpacked.
// A plain resources/codeply-cli folder on real disk sidesteps both at once.
const CLI_DIR = process.env.CODEPLY_CLI_PATH || (app.isPackaged
  ? path.join(process.resourcesPath, 'codeply-cli')
  : path.join(__dirname, 'codeply-cli'));

let agentMod = null;      // ESM: { runAgent, buildProjectContext }
let authLib = null;       // CJS: auth.js
let configLib = null;     // CJS: config.js - provider config, user-added models, integrations
let skillsLib = null;     // CJS: skills.js
let aiLib = null;         // CJS: ai.js - planning/title/goal-check calls, model tests
let oauthLib = null;      // CJS: oauth-connectors.js - Gmail/Slack/Vercel/Supabase/GitHub OAuth
let rolesLib = null;      // CJS: subagents.js - the roles the single agent switches between
let snapshotLib = null;   // CJS: snapshot.js - undo for what a message changed
let commandsLib = null;   // CJS: commands.js - custom slash commands (.codeply/commands/*.md)
let permissionsLib = null; // CJS: permissions.js - standing allow/deny rules (.codeply/permissions.json)

async function loadEngine() {
  if (agentMod) return true;
  const agentPath = path.join(CLI_DIR, 'lib', 'agent.mjs');
  if (!fs.existsSync(agentPath)) return false;

  // Electron 29 bundles Node 20, which has no global WebSocket (that only
  // landed in Node 21+) - Supabase's client reaches for it during
  // getSession()/auth calls and throws "native WebSocket not found" with no
  // other symptom than every call silently returning null. codeply-cli's own
  // node_modules already carries `ws` as a transitive dep of supabase-js; it
  // just isn't wired up as the runtime's WebSocket here the way it implicitly
  // is under a plain, newer Node process. Polyfilling before auth.js/
  // Supabase's client is ever touched fixes every auth call in this app.
  if (typeof globalThis.WebSocket === 'undefined') {
    try { globalThis.WebSocket = require(path.join(CLI_DIR, 'node_modules', 'ws')); } catch {}
  }

  authLib = require(path.join(CLI_DIR, 'lib', 'auth.js'));
  configLib = require(path.join(CLI_DIR, 'lib', 'config.js'));
  skillsLib = require(path.join(CLI_DIR, 'lib', 'skills.js'));
  oauthLib = require(path.join(CLI_DIR, 'lib', 'oauth-connectors.js'));
  aiLib = require(path.join(CLI_DIR, 'lib', 'ai.js'));
  rolesLib = require(path.join(CLI_DIR, 'lib', 'subagents.js'));
  snapshotLib = require(path.join(CLI_DIR, 'lib', 'snapshot.js'));
  commandsLib = require(path.join(CLI_DIR, 'lib', 'commands.js'));
  permissionsLib = require(path.join(CLI_DIR, 'lib', 'permissions.js'));
  agentMod = await import(pathToFileURL(agentPath).href);
  return true;
}

// ─── Session store ──────────────────────────────────────────────────────────
// One JSON file in userData. Each session keeps the renderer-facing message
// list (user / assistant / tool rows) - the model-facing history is rebuilt
// from the user+assistant rows on each send.

let storePath = null;
let store = { sessions: [], projects: [], lastProject: null };
let sessionDb = null; // SQLite (craft-store.db); null means the JSON file below is the store

function loadStore() {
  storePath = path.join(app.getPath('userData'), 'craft-store.json');
  const dbPath = path.join(app.getPath('userData'), 'craft-store.db');
  try {
    sessionDb = require(path.join(CLI_DIR, 'lib', 'session-db.js')).openSessionDb(dbPath, {
      modulePaths: [__dirname, path.join(CLI_DIR)],
    });
  } catch { sessionDb = null; }

  if (sessionDb) {
    let imported = false;
    if (sessionDb.isEmpty()) {
      // First run on SQLite: bring the old JSON store over, then keep it as a backup.
      try {
        store = { ...store, ...JSON.parse(fs.readFileSync(storePath, 'utf8')) };
        imported = true;
      } catch {}
    } else {
      try { store = { ...store, ...sessionDb.load() }; } catch {}
    }
    if (imported) {
      try { sessionDb.save(store); fs.renameSync(storePath, `${storePath}.migrated`); } catch {}
    }
  } else {
    try { store = { ...store, ...JSON.parse(fs.readFileSync(storePath, 'utf8')) }; } catch {}
  }

  // Migration: a stored `autoRouting: false` is always stale. No current code
  // path writes it - it survives only from an older build that had an
  // in-app model picker capable of pinning a provider and turning routing
  // off, which no longer exists (Auto is the only mode now). Dropping the
  // key restores the default rather than leaving an old install silently
  // stuck on whatever provider ~/.codeply/config.json happened to still name.
  if (store.autoRouting === false) {
    delete store.autoRouting;
    saveStore();
  }
}

function saveStore() {
  if (sessionDb) {
    try { sessionDb.save(store); return; } catch (e) { console.warn('[store] sqlite save failed, using JSON:', e.message); }
  }
  try { fs.writeFileSync(storePath, JSON.stringify(store), 'utf8'); } catch {}
}

// ─── Chat history - Supabase-backed (chat_sessions table), not local-only ──
// The local craft-store.json above stays as a same-device cache (so a chat
// mid-run doesn't hang on a network hiccup), but the DB is authoritative:
// loadSessionsFromDb() overwrites store.sessions on every login, so a
// different account signed into the same machine never sees a previous
// account's chats, and deleting the account (auth.users row) cascades to
// delete every chat_sessions row via its FK - nothing lingers locally once
// the account is gone from the account's own device.
async function loadSessionsFromDb(userId) {
  if (!userId) { store.sessions = []; return; }
  try {
    const { data, error } = await authLib.getClient()
      .from('chat_sessions')
      .select('id, title, cwd, messages, always_allowed, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    store.sessions = (data || []).map((row) => ({
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      messages: row.messages || [],
      alwaysAllowed: row.always_allowed || [],
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    }));
  } catch (e) {
    console.warn('[chat-sync] load failed, starting with an empty list:', e.message);
    store.sessions = [];
  }
}

/** Fire-and-forget upsert of one session's full state. Called at the same
 * points saveStore() already persists a session mutation locally - a few
 * times per turn, never per streamed token. */
function syncSessionToDb(session) {
  getLoggedInUserId().then((userId) => {
    if (!userId) return;
    authLib.getClient().from('chat_sessions').upsert({
      id: session.id,
      user_id: userId,
      title: session.title,
      cwd: session.cwd,
      messages: session.messages,
      always_allowed: session.alwaysAllowed || [],
      updated_at: new Date(session.updatedAt || Date.now()).toISOString(),
    }).then(({ error }) => { if (error) console.warn('[chat-sync] upsert failed:', error.message); });
  }).catch(() => {});
}

function deleteSessionFromDb(id) {
  getLoggedInUserId().then((userId) => {
    if (!userId) return;
    authLib.getClient().from('chat_sessions').delete().eq('id', id).eq('user_id', userId)
      .then(({ error }) => { if (error) console.warn('[chat-sync] delete failed:', error.message); });
  }).catch(() => {});
}

function renameSessionInDb(id, title) {
  getLoggedInUserId().then((userId) => {
    if (!userId) return;
    authLib.getClient().from('chat_sessions').update({ title }).eq('id', id).eq('user_id', userId)
      .then(({ error }) => { if (error) console.warn('[chat-sync] rename failed:', error.message); });
  }).catch(() => {});
}

// Fired once, right after a brand-new session's first turn finishes - swaps
// the raw truncated-first-message title for a short AI-written one, the same
// way ChatGPT/Claude retitle a chat once there's enough to summarize. Never
// awaited by the caller: a slow or failed title call should never hold up
// `run_finished`, so any failure here just leaves the truncated title in place.
async function generateSessionTitle(session) {
  try {
    const firstUser = session.messages.find((m) => m.kind === 'user');
    const firstAssistant = session.messages.find((m) => m.kind === 'assistant');
    if (!firstUser) return;
    const transcript = `User: ${(firstUser.text || '').slice(0, 500)}` +
      (firstAssistant ? `\nAssistant: ${(firstAssistant.text || '').slice(0, 500)}` : '');
    const r = await aiLib.chat([{
      role: 'user',
      content: `Write a short title (3-6 words, title case, no quotes, no trailing punctuation) that names what this chat is about. Reply with only the title, nothing else.\n\n${transcript}`,
    }], { maxTokens: 20, route: currentRoute() });
    if (!r.success) return;
    const raw = r.data.choices?.[0]?.message?.content || '';
    const title = raw.trim().replace(/^["'“”]+|["'“”]+$/g, '').split('\n')[0].slice(0, 60);
    if (!title || !store.sessions.includes(session)) return;
    session.title = title;
    saveStore();
    renameSessionInDb(session.id, title);
    sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
  } catch {}
}

function sessionMeta(s) {
  const last = s.messages?.[s.messages.length - 1];
  return {
    id: s.id, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt,
    preview: last?.text || last?.label || '', messageCount: s.messages?.length || 0,
  };
}

function rememberProject(cwd) {
  if (!cwd) return;
  store.projects = [cwd, ...store.projects.filter((p) => p !== cwd)].slice(0, 8);
  store.lastProject = cwd;
  saveStore();
}

function gitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).toString().trim();
  } catch { return null; }
}

// ─── Window ─────────────────────────────────────────────────────────────────

let win = null;
let tray = null;
// Set by the tray's own "Quit" item, and by 'before-quit' as a catch-all for
// every other way the app can end (OS shutdown, mac Cmd+Q, ...) - so the
// window's 'close' handler below can tell a real quit apart from the user
// just clicking the titlebar's X, which should hide to the tray instead.
// 'before-quit' alone isn't enough for the tray path specifically: a
// BrowserWindow's 'close' fires before 'before-quit' does, so by the time
// 'before-quit' could set this flag, 'close' has already had to decide.
let isQuitting = false;
const APP_ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1050,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#141414',
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Launch maximized; the width/height above become the restore size when
  // the user later unmaximizes, and the window stays freely resizable.
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.loadFile('index.html');
  // Surface renderer problems in the terminal - a silent white/empty pane is
  // undebuggable for users otherwise.
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('preload-error', (e, p, err) => console.log('[preload-error]', p, err.message));
  win.webContents.on('did-fail-load', (e, code, desc) => console.log('[load-failed]', code, desc));
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));
  win.on('resize', () => { if (panelVisible) positionCheckerView(); });
  // The whole point of the phone companion is that Craft keeps running (and
  // keeps serving the remote server) after you walk away from the desktop -
  // closing the window hides it instead of tearing it, and the tray icon
  // below is what's left to get back in or actually quit from.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(APP_ICON_PATH));
  tray.setToolTip('Codeply Craft');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Codeply Craft', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit Codeply Craft',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]));
  // Windows/Linux convention: a left-click on the tray icon itself opens the
  // app (the menu above is reserved for right-click, which Electron already
  // routes to setContextMenu on its own).
  tray.on('click', showWindow);
}

ipcMain.handle('win:getState', () => ({ maximized: !!(win && win.isMaximized()) }));
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());

// ─── Google sign-in (OAuth via the system browser + codeply:// deep link) ──
// Mirrors the desktop app exactly, including reusing its `codeply://`
// redirect URI - that's the one already whitelisted in the Supabase
// project's auth settings, so a second/different scheme here would just
// fail at the provider. (If both apps are installed, whichever registered
// the protocol most recently wins the deep link - an accepted limitation of
// two separate apps sharing one OAuth redirect URI.)

const DEEP_LINK_PREFIX = 'codeply://';

function getDeepLinkFromArgv(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith(DEEP_LINK_PREFIX)) || null;
}

// In case Craft itself was launched fresh BY the deep link (not already running).
let pendingAuthUrl = getDeepLinkFromArgv(process.argv);

async function handleAuthCallback(url) {
  if (!url) return;
  const ok = await loadEngine();
  if (!ok || !win) return;
  const send = (payload) => win.webContents.send('auth:callback', payload);
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    if (!code) { send({ ok: false, error: 'No auth code in the callback URL.' }); return; }
    const { data, error } = await authLib.getClient().auth.exchangeCodeForSession(code);
    if (error) { send({ ok: false, error: error.message }); return; }
    const user = data.session?.user;
    if (!user) { send({ ok: false, error: 'Sign-in succeeded but no user was returned.' }); return; }
    const onboarding = await getOnboardingProfile();
    startRelay();
    send({ ok: true, email: user.email, onboarding });
  } catch (e) {
    send({ ok: false, error: e.message });
  }
}

// Single-instance lock + protocol registration must happen before the app is
// ready: a second launch (the OS relaunching us to hand off the deep link)
// needs to find an existing instance to hand off to instead of opening a
// second window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('codeply', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('codeply');
  }

  app.on('second-instance', (event, commandLine) => {
    const url = getDeepLinkFromArgv(commandLine);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    if (url) handleAuthCallback(url);
  });

  // macOS delivers the deep link this way instead of via second-instance.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (url.startsWith(DEEP_LINK_PREFIX)) handleAuthCallback(url);
  });
}

ipcMain.handle('auth:signInGoogle', async () => {
  const ok = await loadEngine();
  if (!ok) return { ok: false, error: 'Engine not available.' };
  try {
    const { data, error } = await authLib.getClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'codeply://auth-callback', skipBrowserRedirect: true },
    });
    if (error) return { ok: false, error: error.message };
    if (!data?.url) return { ok: false, error: 'Could not start browser sign-in.' };
    await shell.openExternal(data.url);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ─── App init ───────────────────────────────────────────────────────────────

ipcMain.handle('app:init', async () => {
  const engineOk = await loadEngine();
  if (!engineOk) {
    return {
      engineOk: false,
      engineError: `Codeply CLI engine not found at ${CLI_DIR}. ` +
        'Set CODEPLY_CLI_PATH to your codeply-cli folder and restart.',
    };
  }
  let user = null;
  try {
    const session = await authLib.getSession();
    if (session) user = { email: session.user.email };
  } catch {}

  let onboarding = null;
  if (user) onboarding = await getOnboardingProfile();

  // Chat history is sourced from Supabase, not the local cache file, every
  // time the app boots signed in - so a different account on this same
  // machine (or the same account after deleting and recreating it) never
  // sees a previous account's chats. Signed-out just clears the list.
  await loadSessionsFromDb(user ? await getLoggedInUserId() : null);
  if (user) startRelay();

  return {
    engineOk: true,
    user,
    models: modelsState(),
    needsLogin: !user,
    needsOnboarding: !!user && !!onboarding && (!onboarding.referral_source || !onboarding.country),
    onboarding,
    sessions: store.sessions.map(sessionMeta).sort((a, b) => b.updatedAt - a.updatedAt),
    projects: store.projects,
    lastProject: store.lastProject,
    lastProjectBranch: store.lastProject ? gitBranch(store.lastProject) : null,
  };
});

// ─── Auth (same Supabase project + ~/.codeply session as the CLI/desktop app,
// same account, same sign-in/sign-up/onboarding flow as the Codeply desktop
// app - see Codeply-App/main.js's auth:sign-in-email / auth:sign-up-email /
// auth:verify-otp / profile:get for the implementation this mirrors) ────────

/** Humanizes Supabase auth errors - same phrasing as the desktop app. */
function formatAuthError(raw, context = 'login') {
  let msg = raw?.message || raw?.msg || String(raw || '');
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (parsed?.msg) msg = parsed.msg;
    if (parsed?.message) msg = parsed.message;
  } catch {}
  const lower = msg.toLowerCase();
  if (lower.includes('invalid login credentials') || lower.includes('invalid credentials')) {
    return 'Incorrect email or password.';
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return 'An account with this email already exists. Try signing in.';
  }
  if (lower.includes('signup') && lower.includes('disabled')) {
    return 'New account registration is disabled. Contact support.';
  }
  if (context === 'signup') return msg || 'Failed to create account.';
  return msg || 'Failed to sign in.';
}

/** Humanizes errors for the emailed sign-in code step. */
function formatOtpError(raw) {
  let msg = typeof raw === 'string' ? raw : (raw?.message || raw?.msg || '');
  try { const p = JSON.parse(msg); msg = p.msg || p.message || msg; } catch {}
  const lower = String(msg).toLowerCase();
  if (lower.includes('expired')) return 'That code has expired. Request a fresh one.';
  if (lower.includes('rate') || lower.includes('too many') || lower.includes('seconds')) {
    return 'Please wait a moment before requesting another code.';
  }
  if (lower.includes('invalid') || lower.includes('token') || lower.includes('otp')) {
    return 'Incorrect code. Double-check it and try again.';
  }
  return msg || 'Could not verify the code. Try again.';
}

async function getLoggedInUserId() {
  try {
    const session = await authLib.getSession();
    return session?.user?.id || null;
  } catch { return null; }
}

/** referral_source + country from the shared `profiles` row - same table, same columns, same gating-per-account the desktop app uses (see Codeply-App/supabase/referral_source.sql + country.sql). */
async function getOnboardingProfile() {
  const userId = await getLoggedInUserId();
  if (!userId) return { referral_source: null, country: null };
  try {
    const { data, error } = await authLib.getClient()
      .from('profiles').select('referral_source, country').eq('id', userId).single();
    if (error || !data) return { referral_source: null, country: null };
    return { referral_source: data.referral_source || null, country: data.country || null };
  } catch { return { referral_source: null, country: null }; }
}

ipcMain.handle('profile:get', () => getOnboardingProfile());

ipcMain.handle('profile:saveOnboarding', async (e, { referralSource, country }) => {
  const userId = await getLoggedInUserId();
  if (!userId) return { ok: false, error: 'Not signed in.' };
  const supabase = authLib.getClient();
  try {
    const patch = {};
    if (referralSource) patch.referral_source = referralSource;
    if (country) patch.country = country;
    if (Object.keys(patch).length) await supabase.from('profiles').update(patch).eq('id', userId);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Email + password is two-factor here too: validate the password, then email
// a fresh sign-in code. Not signed in until that code is verified.
ipcMain.handle('auth:signInEmail', async (e, { email, password }) => {
  const supabase = authLib.getClient();
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: formatAuthError(error, 'login') };
    try { await supabase.auth.signOut({ scope: 'local' }); } catch {}
    const { error: otpErr } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (otpErr) return { ok: false, error: formatOtpError(otpErr) };
    return { ok: true, needsOtp: true, email, mode: 'login' };
  } catch (err) { return { ok: false, error: formatAuthError(err, 'login') }; }
});

ipcMain.handle('auth:signUpEmail', async (e, { email, password, name }) => {
  const supabase = authLib.getClient();
  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name: name || email.split('@')[0] } },
    });
    if (error) return { ok: false, error: formatAuthError(error, 'signup') };
    if (data.user && (!data.user.identities || data.user.identities.length === 0)) {
      return { ok: false, error: 'An account with this email already exists. Try signing in.' };
    }
    if (data.session) {
      try { await supabase.auth.signOut({ scope: 'local' }); } catch {}
      try { await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }); } catch {}
      return { ok: true, needsOtp: true, email, mode: 'login' };
    }
    return { ok: true, needsOtp: true, email, mode: 'signup' };
  } catch (err) { return { ok: false, error: formatAuthError(err, 'signup') }; }
});

ipcMain.handle('auth:verifyOtp', async (e, { email, token, mode }) => {
  const supabase = authLib.getClient();
  const code = String(token || '').replace(/\D+/g, '');
  if (!email || !code) return { ok: false, error: 'Enter the code we emailed you.' };
  try {
    const primaryType = mode === 'signup' ? 'signup' : 'email';
    let { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: primaryType });
    if (error) {
      const fallbackType = mode === 'signup' ? 'email' : 'signup';
      const retry = await supabase.auth.verifyOtp({ email, token: code, type: fallbackType });
      if (!retry.error) { data = retry.data; error = null; }
    }
    if (error) return { ok: false, error: formatOtpError(error) };
    const user = data?.user || data?.session?.user;
    if (!user) return { ok: false, error: 'Could not verify the code. Please try again.' };
    const onboarding = await getOnboardingProfile();
    startRelay();
    return { ok: true, email: user.email, onboarding };
  } catch (err) { return { ok: false, error: formatOtpError(err) }; }
});

ipcMain.handle('auth:resendOtp', async (e, { email, mode }) => {
  const supabase = authLib.getClient();
  if (!email) return { ok: false, error: 'Missing email address.' };
  try {
    if (mode === 'signup') {
      const { error } = await supabase.auth.resend({ type: 'signup', email });
      if (error) {
        const alt = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        if (alt.error) return { ok: false, error: formatOtpError(error) };
      }
    } else {
      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error) return { ok: false, error: formatOtpError(error) };
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: formatOtpError(err) }; }
});

ipcMain.handle('auth:logout', async () => {
  // Paired phones belong to this account - sign them out with it, and stop
  // advertising this PC under the account before the session goes away.
  await stopRelay();
  remoteTokens.clear();
  for (const client of remoteEventClients) { try { client.end(); } catch {} }
  remoteEventClients.clear();
  try { await authLib.getClient().auth.signOut(); } catch {}
  // Otherwise the next account signed in on this machine would see this
  // account's chats until the next full app:init (e.g. a restart).
  store.sessions = [];
  return { ok: true };
});

// Re-pulls chat history from Supabase for whoever is signed in right now -
// called after a fresh login/signup (afterVerified in app.js), since
// app:init only runs once at boot and won't otherwise notice an account
// switch mid-session.
ipcMain.handle('sessions:refresh', async () => {
  await loadSessionsFromDb(await getLoggedInUserId());
  return store.sessions.map(sessionMeta).sort((a, b) => b.updatedAt - a.updatedAt);
});

// ─── Skills - the same 282-skill library the CLI's agent already searches
// and auto-loads via use_skill/list_skills mid-run; this just gives the
// renderer a way to browse/search the same catalog and drop one into the
// composer. Loaded straight from skills.js, not a separate copy. ───────────

ipcMain.handle('skills:list', () => {
  try {
    return skillsLib.listSkills().map((s) => ({
      name: s.name, description: s.description, daily: !!s.daily, source: s.source,
    }));
  } catch { return []; }
});

// ─── Models ─────────────────────────────────────────────────────────────────
// "Auto" is the hosted Codeply model. Anything else is a model the user added
// (an OpenAI-compatible endpoint, or Ollama). Model entries - API keys
// included - live only in ~/.codeply/config.json on this machine (see
// config.js); the renderer only ever gets a masked preview of a key, and a
// key is only ever sent to the base URL the user entered for it.

/** The route for a turn, decided once when the turn starts. */
function currentRoute() {
  const m = configLib.getSelectedModel();
  return m ? { custom: m } : { auto: true };
}

function publicModel(m) {
  return {
    id: m.id, name: m.name, kind: m.kind, baseUrl: m.baseUrl, model: m.model,
    hasKey: !!m.apiKey, keyPreview: m.apiKey ? configLib.maskKey(m.apiKey) : '',
  };
}

function modelsState() {
  return { selected: configLib.getSelectedModelId(), models: configLib.getModels().map(publicModel) };
}

function modelLabel(route) {
  return route && route.custom ? (route.custom.name || route.custom.model) : 'Auto';
}

ipcMain.handle('models:list', async () => {
  if (!(await loadEngine())) return { selected: 'auto', models: [] };
  return modelsState();
});

ipcMain.handle('models:select', async (e, id) => {
  if (!(await loadEngine())) return { ok: false, error: 'Engine not available.' };
  const r = configLib.selectModel(id || configLib.AUTO_MODEL_ID);
  return r.ok ? { ok: true, state: modelsState() } : r;
});

// Saves (and selects) a model, testing it with a tiny real request first so a
// typo'd URL/key/model id is caught here rather than mid-task. `skipTest`
// saves anyway (e.g. Ollama not running right now).
ipcMain.handle('models:save', async (e, input) => {
  if (!(await loadEngine())) return { ok: false, error: 'Engine not available.' };
  const existing = input?.id ? configLib.getModel(input.id) : null;
  const candidate = {
    kind: input?.kind === 'ollama' ? 'ollama' : 'openai',
    name: String(input?.name || '').trim(),
    baseUrl: String(input?.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(input?.model || '').trim(),
    apiKey: input?.apiKey === undefined || input?.apiKey === null ? (existing?.apiKey || '') : String(input.apiKey).trim(),
  };
  // A saved key only ever goes to the URL it was entered for.
  if (existing && candidate.baseUrl !== existing.baseUrl && (input?.apiKey === undefined || input?.apiKey === null)) {
    return { ok: false, error: 'You changed the base URL, so enter the API key again for the new address.' };
  }
  if (!candidate.model) return { ok: false, error: 'Enter the model id.' };
  if (!/^https?:\/\//i.test(candidate.baseUrl)) return { ok: false, error: 'The base URL must start with http:// or https://.' };
  if (!input?.skipTest) {
    const t = await aiLib.testModel(candidate);
    if (!t.ok) return { ok: false, testFailed: true, error: t.error };
  }
  const saved = configLib.saveModel({ ...input, ...candidate, id: existing?.id });
  if (!saved.ok) return saved;
  configLib.selectModel(saved.model.id);
  return { ok: true, model: publicModel(saved.model), state: modelsState() };
});

ipcMain.handle('models:delete', async (e, id) => {
  if (!(await loadEngine())) return { ok: false, error: 'Engine not available.' };
  const r = configLib.deleteModel(id);
  return r.ok ? { ok: true, state: modelsState() } : r;
});

ipcMain.handle('models:detectOllama', async (e, host) => {
  if (!(await loadEngine())) return { ok: false, error: 'Engine not available.' };
  return aiLib.listOllamaModels(host || 'http://localhost:11434');
});

// ─── Gmail / Slack integrations (real OAuth via the system browser) ───────
// Desktop OAuth per RFC 8252: open the consent screen in the user's actual
// system browser (never an embedded webview - that's exactly what providers
// increasingly refuse for OAuth, and rightly so), and catch the redirect on
// a short-lived local HTTP server bound to a fixed loopback port. Slack
// requires that port to exactly match what's registered in its app config;
// Gmail's "Desktop app" client type is lenient about the port but the exact
// same approach works for both, so one mechanism serves both.
const GMAIL_REDIRECT_PORT = 53681;
const SLACK_REDIRECT_PORT = 53682;
const VERCEL_REDIRECT_PORT = 53683;
const SUPABASE_REDIRECT_PORT = 53684;
const GITHUB_REDIRECT_PORT = 53685;

// App-wide OAuth app credentials (one registration covers every user - they
// each still do their own one-time browser sign-in). client_id is public by
// design; client_secret can't truly be kept secret in a shipped desktop app
// either way, so this follows the same accepted tradeoff Google/Slack ship
// for "installed apps" rather than standing up a token-exchange proxy. That
// tradeoff is about a COMPILED binary, though - it does not extend to
// plaintext in a public source repo, so these are read from the environment
// (see .env.example) rather than hardcoded; anyone building from source
// registers their own OAuth apps and supplies their own credentials.
// Fill these in after registering the OAuth apps:
//   Vercel:   vercel.com/dashboard -> Integrations Console -> New Integration (OAuth2)
//             redirect URI: http://localhost:53683/vercel-callback
//   Supabase: supabase.com/dashboard/org/_/apps -> New OAuth App
//             redirect URI: http://localhost:53684/supabase-callback
const VERCEL_CLIENT_ID = process.env.VERCEL_CLIENT_ID || '';
const VERCEL_CLIENT_SECRET = process.env.VERCEL_CLIENT_SECRET || '';
// The integration's "URL Slug" from the Integrations Console (its live URL is
// vercel.com/integrations/<slug>) - required to start the install flow; the
// client id/secret above are only used for the later token exchange.
const VERCEL_SLUG = process.env.VERCEL_SLUG || 'codeply-craft';
const SUPABASE_CLIENT_ID = process.env.SUPABASE_CLIENT_ID || '';
const SUPABASE_CLIENT_SECRET = process.env.SUPABASE_CLIENT_SECRET || '';
// GitHub: github.com/settings/developers -> OAuth Apps -> New OAuth App
// Authorization callback URL: http://localhost:53685/github-callback
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';

const http = require('http');

/**
 * Opens `authUrl` in the system browser and resolves with the `code` query
 * param from the one request that lands on `port` - or rejects on timeout /
 * an error/missing-code redirect. The server exists only for that single
 * request; torn down immediately after, success or failure.
 */
function awaitOAuthRedirect(authUrl, port, path, providerLabel) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== path) { res.writeHead(404); res.end(); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<html><body style="font-family:sans-serif;background:#0a0a0c;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">` +
        `<div>${error ? `Connection failed: ${error}` : `${providerLabel} connected. You can close this tab.`}</div></body></html>`,
      );
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        server.close();
        if (error) reject(new Error(error));
        else if (!code) reject(new Error('No authorization code in the redirect.'));
        else resolve(code);
      }
    });
    server.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; server.close(); reject(new Error('Timed out waiting for the browser sign-in.')); }
    }, 5 * 60 * 1000);
    server.listen(port, '127.0.0.1', () => { shell.openExternal(authUrl); });
  });
}

ipcMain.handle('integrations:status', async () => {
  const ok = await loadEngine();
  if (!ok) return { gmail: null, slack: null, vercel: null, supabase: null, github: null };
  const gmail = configLib.getIntegration('gmail');
  const slack = configLib.getIntegration('slack');
  const vercel = configLib.getIntegration('vercel');
  const supabase = configLib.getIntegration('supabase');
  const github = configLib.getIntegration('github');
  return {
    gmail: gmail.accessToken ? { connected: true, email: gmail.email } : { connected: false },
    slack: slack.accessToken ? { connected: true, teamName: slack.teamName } : { connected: false },
    vercel: vercel.accessToken ? { connected: true, userName: vercel.userName } : { connected: false },
    supabase: supabase.accessToken ? { connected: true, email: supabase.email } : { connected: false },
    github: github.accessToken ? { connected: true, userName: github.userName } : { connected: false },
  };
});

ipcMain.handle('integrations:connectGmail', async () => {
  const ok = await loadEngine();
  if (!ok) return { ok: false, error: 'Engine not available.' };
  const { clientId, clientSecret } = configLib.getIntegration('gmail');
  if (!clientId || !clientSecret) return { ok: false, error: 'No Gmail client ID/secret configured.' };
  const redirectUri = `http://localhost:${GMAIL_REDIRECT_PORT}/gmail-callback`;
  try {
    const authUrl = oauthLib.buildGmailAuthUrl(clientId, redirectUri);
    const code = await awaitOAuthRedirect(authUrl, GMAIL_REDIRECT_PORT, '/gmail-callback', 'Gmail');
    const tokens = await oauthLib.exchangeGmailCode(clientId, clientSecret, code, redirectUri);
    const email = await oauthLib.getGmailProfile(tokens.access_token);
    configLib.saveIntegration('gmail', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || configLib.getIntegration('gmail').refreshToken,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      email,
    });
    return { ok: true, email };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('integrations:connectSlack', async () => {
  const ok = await loadEngine();
  if (!ok) return { ok: false, error: 'Engine not available.' };
  const { clientId, clientSecret } = configLib.getIntegration('slack');
  if (!clientId || !clientSecret) return { ok: false, error: 'No Slack client ID/secret configured.' };
  const redirectUri = `http://localhost:${SLACK_REDIRECT_PORT}/slack-callback`;
  try {
    const authUrl = oauthLib.buildSlackAuthUrl(clientId, redirectUri);
    const code = await awaitOAuthRedirect(authUrl, SLACK_REDIRECT_PORT, '/slack-callback', 'Slack');
    const result = await oauthLib.exchangeSlackCode(clientId, clientSecret, code, redirectUri);
    // authed_user carries the separate user token from the same OAuth
    // exchange (see buildSlackAuthUrl's user_scope) - present whenever the
    // user actually approved the "act on your behalf" permission, absent
    // otherwise, so this degrades cleanly to bot-only if they didn't.
    configLib.saveIntegration('slack', {
      accessToken: result.access_token,
      userAccessToken: result.authed_user?.access_token || '',
      userId: result.authed_user?.id || '',
      teamId: result.team?.id || '',
      teamName: result.team?.name || '',
    });
    return { ok: true, teamName: result.team?.name || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('integrations:connectVercel', async () => {
  const ok = await loadEngine();
  if (!ok) return { ok: false, error: 'Engine not available.' };
  const stored = configLib.getIntegration('vercel');
  const clientId = stored.clientId || VERCEL_CLIENT_ID;
  const clientSecret = stored.clientSecret || VERCEL_CLIENT_SECRET;
  const slug = stored.slug || VERCEL_SLUG;
  if (!clientId || !clientSecret) return { ok: false, error: 'No Vercel client ID/secret configured yet.' };
  if (!slug) return { ok: false, error: 'No Vercel integration slug configured yet.' };
  const redirectUri = `http://localhost:${VERCEL_REDIRECT_PORT}/vercel-callback`;
  try {
    const authUrl = oauthLib.buildVercelAuthUrl(slug);
    const code = await awaitOAuthRedirect(authUrl, VERCEL_REDIRECT_PORT, '/vercel-callback', 'Vercel');
    const tokens = await oauthLib.exchangeVercelCode(clientId, clientSecret, code, redirectUri);
    const userName = await oauthLib.getVercelProfile(tokens.access_token).catch(() => '');
    configLib.saveIntegration('vercel', {
      accessToken: tokens.access_token,
      teamId: tokens.team_id || '',
      userName,
    });
    return { ok: true, userName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('integrations:connectSupabase', async () => {
  const ok = await loadEngine();
  if (!ok) return { ok: false, error: 'Engine not available.' };
  const stored = configLib.getIntegration('supabase');
  const clientId = stored.clientId || SUPABASE_CLIENT_ID;
  const clientSecret = stored.clientSecret || SUPABASE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: 'No Supabase client ID/secret configured yet.' };
  const redirectUri = `http://localhost:${SUPABASE_REDIRECT_PORT}/supabase-callback`;
  try {
    const authUrl = oauthLib.buildSupabaseAuthUrl(clientId, redirectUri);
    const code = await awaitOAuthRedirect(authUrl, SUPABASE_REDIRECT_PORT, '/supabase-callback', 'Supabase');
    const tokens = await oauthLib.exchangeSupabaseCode(clientId, clientSecret, code, redirectUri);
    configLib.saveIntegration('supabase', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || configLib.getIntegration('supabase').refreshToken,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('integrations:connectGithub', async () => {
  const ok = await loadEngine();
  if (!ok) return { ok: false, error: 'Engine not available.' };
  const stored = configLib.getIntegration('github');
  const clientId = stored.clientId || GITHUB_CLIENT_ID;
  const clientSecret = stored.clientSecret || GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: 'No GitHub client ID/secret configured yet.' };
  const redirectUri = `http://localhost:${GITHUB_REDIRECT_PORT}/github-callback`;
  try {
    const authUrl = oauthLib.buildGithubAuthUrl(clientId, redirectUri);
    const code = await awaitOAuthRedirect(authUrl, GITHUB_REDIRECT_PORT, '/github-callback', 'GitHub');
    const tokens = await oauthLib.exchangeGithubCode(clientId, clientSecret, code, redirectUri);
    const userName = await oauthLib.getGithubProfile(tokens.access_token).catch(() => '');
    configLib.saveIntegration('github', { accessToken: tokens.access_token, userName, scope: tokens.scope || '' });
    return { ok: true, userName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('integrations:disconnect', async (e, name) => {
  const ok = await loadEngine();
  if (!ok) return { ok: false, error: 'Engine not available.' };
  if (!configLib.INTEGRATIONS.includes(name)) return { ok: false, error: 'Unknown integration.' };
  configLib.disconnectIntegration(name);
  return { ok: true };
});

// ─── Browser check - the agent's own "open it and look" tool ───────────────
// This is what makes browser_check (agent.mjs/tools.mjs) real instead of
// theoretical: a genuine embedded Chromium view (a BrowserView docked into
// Craft's own window - no Puppeteer/Playwright, no separate OS window) that
// loads whatever page the agent just built or edited and reports back
// console errors, failed requests, broken images, and the visible text. The
// CLI has no such view to hand tools.mjs, which is exactly why ctx.browser
// is optional - this is the one thing only the desktop app can provide.

const PANEL_WIDTH_RATIO = 0.45;
const TITLEBAR_HEIGHT = 36;

let checkerView = null;
let checkerCollector = null; // { errors:[], warnings:[] } for whichever check is in flight
let panelVisible = false;

// The address bar / back / forward / refresh strip lives in Craft's own HTML
// (index.html's #browserChrome), not inside the BrowserView - a BrowserView
// is raw page content with no chrome of its own. Reserving this much height
// above it is what turns "a page pasted on top of the window" into something
// that reads as a real browser, and is also why the checker view's bounds
// start BROWSER_CHROME_HEIGHT below the titlebar, not right at it.
const BROWSER_CHROME_HEIGHT = 40;

function sendPanelState() {
  if (!win || win.isDestroyed()) return;
  const { width } = win.getContentBounds();
  const panelWidth = panelVisible ? Math.round(width * PANEL_WIDTH_RATIO) : 0;
  win.webContents.send('browserpanel:state', {
    visible: panelVisible,
    width: panelWidth,
    canGoBack: checkerView ? checkerView.webContents.canGoBack() : false,
    canGoForward: checkerView ? checkerView.webContents.canGoForward() : false,
  });
}

function getCheckerView() {
  if (checkerView) return checkerView;
  checkerView = new BrowserView({
    webPreferences: {
      // Isolated from the app's own session so this view's network
      // listeners (webRequest, below) never see the app's own traffic.
      partition: 'persist:codeply-browser-check',
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  checkerView.setBackgroundColor('#1e1e1e');
  checkerView.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (!checkerCollector) return;
    // Electron's own dev-mode CSP nag fires on every single page regardless
    // of what's actually on it - real signal from the checked page, not it.
    if (message.includes('Electron Security Warning')) return;
    const loc = sourceId ? ` (${sourceId.split(/[\\/]/).pop()}:${line})` : '';
    if (level >= 3) checkerCollector.errors.push(message + loc);
    else if (level === 2) checkerCollector.warnings.push(message + loc);
  });
  const onNavigated = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('browserpanel:url', { url: checkerView.webContents.getURL() });
    sendPanelState();
  };
  checkerView.webContents.on('did-navigate', onNavigated);
  checkerView.webContents.on('did-navigate-in-page', onNavigated);
  return checkerView;
}

/** Docks the panel to the right side of Craft's own content area, below the titlebar AND the chrome strip. */
function positionCheckerView() {
  if (!win || win.isDestroyed() || !checkerView) return;
  const { width, height } = win.getContentBounds();
  const panelWidth = Math.round(width * PANEL_WIDTH_RATIO);
  const top = TITLEBAR_HEIGHT + BROWSER_CHROME_HEIGHT;
  // Tablet/mobile: a centered frame of the real width, so the page lays out
  // exactly as it would on that device.
  const viewWidth = panelSize ? Math.min(panelSize.width, panelWidth) : panelWidth;
  checkerView.setBounds({
    x: width - panelWidth + Math.floor((panelWidth - viewWidth) / 2), y: top,
    width: viewWidth, height: height - top,
  });
}

function showCheckerPanel() {
  if (!win || win.isDestroyed()) return;
  getCheckerView();
  if (!panelVisible) {
    win.addBrowserView(checkerView);
    panelVisible = true;
  }
  positionCheckerView();
  sendPanelState();
}

function hideCheckerPanel() {
  if (!win || win.isDestroyed() || !checkerView || !panelVisible) return;
  win.removeBrowserView(checkerView);
  panelVisible = false;
  sendPanelState();
}

function toggleCheckerPanel() {
  if (panelVisible) hideCheckerPanel();
  else showCheckerPanel();
}

ipcMain.on('browserpanel:back', () => { if (checkerView?.webContents.canGoBack()) checkerView.webContents.goBack(); });
ipcMain.on('browserpanel:forward', () => { if (checkerView?.webContents.canGoForward()) checkerView.webContents.goForward(); });
ipcMain.on('browserpanel:reload', () => { checkerView?.webContents.reload(); });

// The address bar accepting real input, not just displaying whatever the
// agent last checked, is what makes this an actual browser panel instead of
// a one-way report viewer. A bare "example.com" (no scheme) is the common
// case typed by hand, so it's defaulted to https:// the same way every real
// browser's address bar does - but a local file check still needs an exact
// file:// URL to work, which is why that scheme (and any other explicit
// scheme) is left untouched rather than rewritten.
ipcMain.on('browserpanel:navigate', (e, rawUrl) => {
  const input = String(rawUrl || '').trim();
  if (!input) return;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  showCheckerPanel();
  checkerView.webContents.loadURL(url).catch(() => {});
});

ipcMain.on('browserpanel:toggle', toggleCheckerPanel);

// Serialized globally so two chats triggering a check around the same time
// can't cross-contaminate each other's console/network capture - the shared
// hidden window can only look at one page at a time anyway, same as a human
// only has one tab in front of them.
let browserCheckQueue = Promise.resolve();
function browserCheck(url, opts) {
  const run = browserCheckQueue.then(() => doBrowserCheck(url, opts));
  browserCheckQueue = run.catch(() => {});
  return run;
}

// ─── Viewport sizes (responsive checks) ─────────────────────────────────────
// Used both by the agent's browser_check (<viewport>) and the size switcher in
// the browser panel. A size is applied by making the page's viewport really
// that wide (the panel shrinks to a centered frame; off-screen captures use a
// window of exactly that size) plus a phone user agent. Chromium's device
// emulation is deliberately NOT used: it lets the layout viewport stretch to
// fit the content, which hides the exact sideways-scroll bug this checks for.
const VIEWPORTS = {
  desktop: null,
  tablet: { width: 768, height: 1024, mobile: true },
  mobile: { width: 390, height: 844, mobile: true },
};
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let defaultCheckerUA = null;

function parseViewport(v) {
  const key = String(v || 'desktop').trim().toLowerCase();
  if (key in VIEWPORTS) return { name: key, size: VIEWPORTS[key] };
  const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(key);
  if (m) {
    const width = Number(m[1]);
    const height = Number(m[2]);
    return { name: `${width}x${height}`, size: { width, height, mobile: width < 1024 } };
  }
  return { name: 'desktop', size: null };
}

function applyViewport(wc, size) {
  if (!defaultCheckerUA) defaultCheckerUA = wc.getUserAgent();
  wc.setUserAgent(size && size.mobile ? MOBILE_UA : defaultCheckerUA);
}

let panelSize = null; // null = fill the panel (desktop)
function setPanelViewport(name) {
  const vp = parseViewport(name);
  panelSize = vp.size;
  if (checkerView) {
    applyViewport(checkerView.webContents, vp.size);
    positionCheckerView();
  }
  if (win && !win.isDestroyed()) win.webContents.send('browserpanel:viewport', { name: vp.name });
  return vp;
}

ipcMain.on('browserpanel:viewport', (e, name) => {
  getCheckerView();
  setPanelViewport(name);
  if (checkerView.webContents.getURL()) checkerView.webContents.reload();
});

/** Loads a page in an invisible off-screen window and captures it (works while Craft is hidden). */
async function captureOffscreen(url, wait = 700, size = null) {
  const shot = new BrowserWindow({
    show: false, width: size ? size.width : 1280, height: size ? size.height : 860, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, partition: 'persist:codeply-browser-check', contextIsolation: true, nodeIntegration: false },
  });
  try {
    if (size) applyViewport(shot.webContents, size);
    await shot.loadURL(url);
    await new Promise((r) => setTimeout(r, Math.max(600, wait + 400)));
    const img = await shot.webContents.capturePage();
    return img && !img.isEmpty() ? img : null;
  } catch {
    return null;
  } finally {
    // close(), not destroy(): destroying it mid-teardown broke the next page load.
    if (!shot.isDestroyed()) shot.close();
  }
}

async function doBrowserCheck(url, { wait = 700, viewport } = {}) {
  getCheckerView();
  // The agent picks the size per check; the panel follows so you see it too.
  const vp = setPanelViewport(viewport || 'desktop');
  showCheckerPanel(); // auto-opens the panel so the user can watch it work, without stealing focus off the chat
  if (win && !win.isDestroyed()) win.webContents.send('browserpanel:url', { url });
  const wc = checkerView.webContents;
  const failedRequests = [];

  wc.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (details.statusCode >= 400) {
      failedRequests.push(`HTTP ${details.statusCode} - ${details.url}`);
    }
  });
  wc.session.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
    if (details.error && details.error !== 'net::ERR_ABORTED') {
      failedRequests.push(`${details.error} - ${details.url}`);
    }
  });

  checkerCollector = { errors: [], warnings: [] };

  // Cache-busting: this view's own isolated partition (see getCheckerView
  // above), so clearing it has zero effect on the app's own session - but
  // without it a repeat check of the SAME url can serve a stale cached copy
  // of a linked stylesheet/script that was just edited, which is exactly the
  // "looks the same but it says different" (or vice versa) failure this
  // check exists to prevent. Correctness here matters more than the reload
  // being a few hundred ms slower.
  try { await wc.session.clearCache(); } catch {}

  let loadError = null;
  const failListener = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) loadError = `${errorDescription} (${errorCode})`;
  };
  wc.on('did-fail-load', failListener);

  try {
    // bypassCache: true belt-and-suspenders on top of the clearCache() above -
    // handles the case where the page being checked is the *same* URL that's
    // already the active one in this view (a plain loadURL there is a no-op
    // reload in some Electron versions and can skip re-fetching entirely).
    await wc.loadURL(url, { extraHeaders: 'Cache-Control: no-cache\n' });
  } catch (e) {
    loadError = loadError || e.message;
  }
  wc.off('did-fail-load', failListener);

  if (loadError) {
    checkerCollector = null;
    return { ok: false, error: loadError };
  }

  await new Promise((resolve) => setTimeout(resolve, wait));

  let extracted = { title: '', text: '', brokenImages: [] };
  try {
    extracted = await wc.executeJavaScript(`(() => {
      const imgs = Array.from(document.images || [])
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.src)
        .slice(0, 20);
      const pageWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
      // Elements poking past the right edge are the usual cause of sideways scrolling on phones.
      const wide = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 2 && r.width > 0) {
          const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
          wide.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls);
          if (wide.length >= 5) break;
        }
      }
      return {
        title: document.title || '',
        text: (document.body ? document.body.innerText : '').trim(),
        brokenImages: imgs,
        viewportWidth: window.innerWidth,
        pageWidth,
        overflowX: pageWidth > window.innerWidth + 1,
        wideElements: wide,
        hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
      };
    })()`);
  } catch {}

  let screenshotPath = null;
  let screenshotDataUrl = null;
  try {
    let image = await wc.capturePage().catch(() => null);
    // With Craft minimized or hidden in the tray (e.g. driven from Codeply
    // Away) the panel isn't painted and the capture comes back empty; render
    // the page off-screen instead, which works no matter what's on screen.
    if (!image || image.isEmpty()) image = await captureOffscreen(url, wait, vp.size);
    if (!image || image.isEmpty()) throw new Error('empty capture');
    const png = image.toPNG();
    const dir = path.join(app.getPath('userData'), 'browser-checks');
    fs.mkdirSync(dir, { recursive: true });
    screenshotPath = path.join(dir, `check-${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, png);
    // The same buffer, as a data: URL - this is what actually lets the model
    // SEE the page instead of only reading a text extraction of it. Without
    // this, "browser_check" was verifying blind: console errors and
    // document.body.innerText say nothing about whether the layout is
    // actually broken, whether an image rendered as a broken icon vs the
    // real photo, or whether a visual edit took effect at all.
    screenshotDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  } catch {}

  const report = {
    ok: true,
    title: extracted.title,
    text: extracted.text,
    brokenImages: extracted.brokenImages,
    viewport: vp.size ? `${vp.name} (${vp.size.width}x${vp.size.height})` : 'desktop',
    viewportWidth: extracted.viewportWidth,
    pageWidth: extracted.pageWidth,
    overflowX: !!extracted.overflowX,
    wideElements: extracted.wideElements || [],
    hasViewportMeta: extracted.hasViewportMeta,
    consoleErrors: checkerCollector.errors,
    consoleWarnings: checkerCollector.warnings,
    failedRequests,
    screenshotPath,
    screenshotDataUrl,
  };
  checkerCollector = null;
  return report;
}

// ─── Projects ───────────────────────────────────────────────────────────────

ipcMain.handle('project:choose', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a project folder',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  rememberProject(p);
  return { path: p, branch: gitBranch(p) };
});

ipcMain.handle('project:use', async (e, p) => {
  if (!fs.existsSync(p)) return null;
  rememberProject(p);
  return { path: p, branch: gitBranch(p) };
});

// Drops a folder from the sidebar's Projects list ONLY - nothing on disk is
// touched, and re-opening the folder puts it straight back (rememberProject
// unshifts it again). It's the counterpart to rememberProject: that list is a
// convenience of recently-used folders, capped at 8, and once it's full a
// stale entry can otherwise only be pushed out by opening eight newer ones.
// lastProject is cleared alongside it so the next launch doesn't reopen the
// very folder that was just removed.
ipcMain.handle('project:remove', (e, p) => {
  store.projects = store.projects.filter((x) => x !== p);
  if (store.lastProject === p) store.lastProject = store.projects[0] || null;
  saveStore();
  return { ok: true, projects: store.projects, lastProject: store.lastProject };
});

// ─── Sessions ───────────────────────────────────────────────────────────────

ipcMain.handle('session:get', (e, id) => store.sessions.find((s) => s.id === id) || null);

// The chat list as this PC knows it right now, including chats a phone started.
ipcMain.handle('sessions:list', () => ({
  sessions: store.sessions.map(sessionMeta).sort((a, b) => b.updatedAt - a.updatedAt),
  running: [...activeRuns.keys()],
}));

// Full-text search across every message of every chat (SQLite store only).
ipcMain.handle('sessions:search', (e, query) => {
  if (!sessionDb) return { ok: false, results: [], reason: 'Chat search needs the SQLite store, which is not available on this install.' };
  try { return { ok: true, results: sessionDb.search(query, 50) }; } catch (err) { return { ok: false, results: [], reason: err.message }; }
});

function deleteSessionRecord(id) {
  store.sessions = store.sessions.filter((s) => s.id !== id);
  saveStore();
  deleteSessionFromDb(id);
}

ipcMain.handle('session:delete', (e, id) => {
  deleteSessionRecord(id);
  return { ok: true };
});

ipcMain.handle('session:rename', (e, { id, title }) => {
  const session = store.sessions.find((s) => s.id === id);
  if (!session) return { ok: false };
  session.title = title;
  saveStore();
  renameSessionInDb(id, title);
  return { ok: true };
});

// ─── Image search (Openverse, with a Wikimedia Commons fallback) ──────────
// Backs the image picker: whenever the agent is about to download a
// placeholder/hero/etc image and isn't running unattended (bypass/always-
// allow), the user gets to search and click a real photo instead of the
// model's single auto-pick landing on disk unseen.
//
// Openverse's /v1/images/ search now requires an OAuth2 bearer token even
// for anonymous use (a plain unauthenticated request comes back 401 with a
// `WWW-Authenticate: Bearer` header) - it used to work keyless, so this
// registers a throwaway anonymous client once, caches the credentials in
// userData, and refreshes the short-lived access token as needed. All of
// this is automatic; nothing for the user to sign up for.

const OPENVERSE_BASE = 'https://api.openverse.org/v1';
const IMAGE_SEARCH_TIMEOUT_MS = 10000;
const openverseCredsPath = () => path.join(app.getPath('userData'), 'openverse-creds.json');

let openverseToken = null; // { access_token, expiresAt }

function readOpenverseCreds() {
  try { return JSON.parse(fs.readFileSync(openverseCredsPath(), 'utf8')); } catch { return null; }
}

async function registerOpenverseClient() {
  const res = await fetch(`${OPENVERSE_BASE}/auth_tokens/register/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(IMAGE_SEARCH_TIMEOUT_MS),
    body: JSON.stringify({
      name: 'CodeplyCraft-' + Math.random().toString(36).slice(2, 10),
      description: 'Codeply Craft desktop app - in-app image picker',
      email: 'hello@codeply.online',
    }),
  });
  if (!res.ok) throw new Error(`Openverse registration failed (HTTP ${res.status}).`);
  const body = await res.json();
  const creds = { client_id: body.client_id, client_secret: body.client_secret };
  fs.mkdirSync(path.dirname(openverseCredsPath()), { recursive: true });
  fs.writeFileSync(openverseCredsPath(), JSON.stringify(creds), 'utf8');
  return creds;
}

async function getOpenverseToken() {
  if (openverseToken && openverseToken.expiresAt > Date.now() + 30000) return openverseToken.access_token;

  let creds = readOpenverseCreds();
  if (!creds?.client_id) creds = await registerOpenverseClient();

  const doTokenRequest = async (c) => fetch(`${OPENVERSE_BASE}/auth_tokens/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(IMAGE_SEARCH_TIMEOUT_MS),
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret }),
  });

  let res = await doTokenRequest(creds);
  if (!res.ok) {
    // Cached credentials may have been revoked/expired server-side - register
    // a fresh anonymous client once and retry before giving up.
    creds = await registerOpenverseClient();
    res = await doTokenRequest(creds);
  }
  if (!res.ok) throw new Error(`Openverse token request failed (HTTP ${res.status}).`);

  const body = await res.json();
  openverseToken = { access_token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return openverseToken.access_token;
}

async function searchOpenverse(q) {
  const token = await getOpenverseToken();
  const res = await fetch(`${OPENVERSE_BASE}/images/?q=${encodeURIComponent(q)}&page_size=24&mature=false`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(IMAGE_SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Openverse search failed (HTTP ${res.status}).`);
  const body = await res.json();
  return (body.results || [])
    .filter((r) => r.thumbnail && r.url)
    .map((r) => ({
      id: r.id, thumbnail: r.thumbnail, full: r.url, title: r.title || q,
      creator: r.creator || '', source: r.source || r.provider || '',
      width: r.width, height: r.height,
    }));
}

/** Keyless fallback so the picker still works if Openverse is unreachable. */
async function searchWikimedia(q) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: '24',
    gsrsearch: `filetype:bitmap ${q}`, prop: 'imageinfo', iiprop: 'url|user',
    iiurlwidth: '400', format: 'json', origin: '*',
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wikimedia search failed (HTTP ${res.status}).`);
  const body = await res.json();
  const pages = Object.values(body?.query?.pages || {});
  return pages
    .filter((p) => p.imageinfo?.[0]?.thumburl)
    .map((p) => {
      const info = p.imageinfo[0];
      return {
        id: p.pageid, thumbnail: info.thumburl, full: info.url,
        title: (p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
        creator: (info.user || '').replace(/<[^>]+>/g, ''), source: 'wikimedia',
      };
    });
}

async function searchImages(query) {
  const q = (query || '').trim();
  if (!q) return { ok: true, results: [] };
  try {
    const results = await searchOpenverse(q);
    if (results.length) return { ok: true, results };
  } catch (e) {
    console.log('[images] Openverse search failed, falling back to Wikimedia:', e.message);
  }
  try {
    return { ok: true, results: await searchWikimedia(q) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** loremflickr URLs bake keywords into the path: /<w>/<h>/<kw1>,<kw2>. */
function guessImageKeywords(url, targetPath) {
  try {
    const u = new URL(url);
    if (/loremflickr\.com$/i.test(u.hostname)) {
      const parts = u.pathname.split('/').filter(Boolean);
      const kwPart = parts.find((p) => !/^\d+$/.test(p));
      if (kwPart) return kwPart.split(',').join(' ');
    }
  } catch {}
  const base = path.basename(targetPath || '', path.extname(targetPath || ''));
  return base.replace(/[-_]+/g, ' ').trim() || 'photo';
}

ipcMain.handle('images:search', (e, query) => searchImages(query));

// ─── Agent runs ─────────────────────────────────────────────────────────────
// One agent, one run per chat at a time. A turn may take on a role (Frontend,
// Backend, ...) picked from what it's working on; a multi-part request is
// split into tasks that run one after another, each in its own role, and a
// /goal keeps iterating - work, then verify - until the goal is met.

const activeRuns = new Map();        // sessionId -> { signal, abortController }

// Keeps the machine from auto-sleeping mid-run - a long agent task (several
// minutes of tool calls) getting killed by Windows' own sleep timer would be
// a much worse failure than the small battery/idle cost of blocking it. This
// only blocks system SLEEP, not the display turning off, and only while at
// least one run is active.
let sleepBlockerId = null;
function updateSleepBlocker() {
  // Also held while "keep this PC awake" is on, so the phone can reach it.
  if (activeRuns.size > 0 || store.keepAwake) {
    if (sleepBlockerId === null || !powerSaveBlocker.isStarted(sleepBlockerId)) {
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

// A native OS notification when a run finishes - only while the window
// isn't focused (if you're watching it work, you already know it's done).
function notifyTaskComplete(session) {
  if (!Notification.isSupported() || !win || win.isDestroyed() || win.isFocused()) return;
  const last = session.messages?.filter((m) => m.kind === 'assistant').at(-1);
  const notification = new Notification({
    title: session.title || 'Craft finished',
    body: last?.text ? (last.text.length > 120 ? last.text.slice(0, 119) + '…' : last.text) : 'Your task is done.',
    silent: false,
  });
  notification.on('click', () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  notification.show();
}

// Matches the wording ai.js returns when the provider has said no - rate
// limited, over quota, revoked, out of credit - rather than a one-off
// transient error, so it reaches you even when you're not looking.
const PROVIDER_EXHAUSTED_RE = /rate limit|too many requests|quota|insufficient|billing|payment required|exceed|out of credit|both ollama accounts were tried|daily .* (limit|cap)/i;

function notifyProviderExhausted(session, message) {
  if (!Notification.isSupported() || !win || win.isDestroyed() || win.isFocused()) return;
  const notification = new Notification({
    title: 'Codeply Craft - the model is unavailable',
    body: message.length > 160 ? message.slice(0, 159) + '…' : message,
    silent: false,
  });
  notification.on('click', () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  notification.show();
}

const pendingApprovals = new Map();  // requestId -> { sessionId, resolve(verdict) }
const pendingImagePicks = new Map(); // requestId -> { sessionId, resolve(chosenUrl) }
let approvalCounter = 0;

// ─── Phone companion (signed in with the same account) ─────────────────────
// The phone signs in with the user's Codeply account; there is no QR code and
// no pairing code. From anywhere it reaches this PC through the Supabase
// Realtime relay (see "Phone relay" below). This small HTTP server is the
// same-network path: it serves the phone page directly and trades the
// phone's Supabase access token for a bridge session. Both paths only accept
// a phone signed in as the SAME account as this desktop, and the phone never
// gets filesystem access or a shell: every action still runs here, in this
// process, behind the same approval gate as the desktop UI.
const REMOTE_PORT = 45671;
let remoteServer = null;
const remoteTokens = new Map(); // bridge token -> { userId, email, createdAt }
const remoteEventClients = new Set();

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) out.push(item.address);
    }
  }
  return out;
}

function remoteUrls() {
  return localAddresses().map((a) => `http://${a}:${REMOTE_PORT}`);
}

function deviceId() {
  if (!store.deviceId) {
    store.deviceId = 'd_' + crypto.randomBytes(8).toString('hex');
    saveStore();
  }
  return store.deviceId;
}

function remoteToken(req, url) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
}

async function remoteAuthorized(req, url) {
  const entry = remoteTokens.get(remoteToken(req, url));
  if (!entry) return false;
  // Still the same account on this desktop? (Signing out clears the map, but
  // a different account signing in must not inherit old phone sessions.)
  const current = await getLoggedInUserId();
  return !!current && current === entry.userId;
}

async function remoteAccount() {
  const ok = await loadEngine();
  if (!ok) return { email: '', signedIn: false };
  try {
    const session = await authLib.getSession();
    if (session?.user) return { email: session.user.email, signedIn: true, id: session.user.id };
  } catch {}
  return { email: '', signedIn: false };
}

// The phone app runs from its own origin (Capacitor's https://localhost) and
// talks to this bridge cross-origin. Auth is a bearer token, never a cookie,
// so a permissive CORS policy exposes nothing extra.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

function remoteJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}
function broadcastRemote(sessionId, event) {
  relayEmit(sessionId, event);
  const line = `event: agent\ndata: ${JSON.stringify({ sessionId, ...event })}\n\n`;
  for (const client of remoteEventClients) {
    try { client.write(line); } catch { remoteEventClients.delete(client); }
  }
}
function readRemoteBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 250000) { reject(new Error('Request is too large.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}

// Light throttle on the sign-in exchange - each attempt costs a Supabase call.
const loginAttempts = [];
function loginThrottled() {
  const now = Date.now();
  while (loginAttempts.length && now - loginAttempts[0] > 60_000) loginAttempts.shift();
  loginAttempts.push(now);
  return loginAttempts.length > 20;
}

function serveStatic(res, file, type, cache = 'no-store') {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ...CORS_HEADERS });
  return fs.createReadStream(path.join(__dirname, file)).pipe(res);
}

// ─── Bridge API (shared by the local-network server and the relay) ─────────
// Every JSON route the phone uses, in one place, so a request behaves the same
// whether it arrived over the LAN or through the Realtime relay.
function screenshotFile(p) {
  const checksDir = path.join(app.getPath('userData'), 'browser-checks');
  const resolved = path.resolve(checksDir, path.basename(p || ''));
  return resolved.startsWith(checksDir) && fs.existsSync(resolved) ? resolved : null;
}

async function handleBridgeApi(method, pathname, query, body) {
  body = body || {};
  if (method === 'GET' && pathname === '/api/bootstrap') {
    const account = await remoteAccount();
    return {
      status: 200,
      body: {
        device: os.hostname(), projects: store.projects, lastProject: store.lastProject,
        sessions: store.sessions.map(sessionMeta), activeSessionIds: [...activeRuns.keys()],
        account: { email: account.email, signedIn: account.signedIn },
        model: modelLabel(currentRoute()),
        models: modelsState(),
      },
    };
  }
  if (method === 'GET' && pathname === '/api/session') {
    const session = store.sessions.find((s) => s.id === query.get('id'));
    return session ? { status: 200, body: session } : { status: 404, body: { error: 'Session not found.' } };
  }
  if (method === 'GET' && pathname === '/api/screenshot-data') {
    const file = screenshotFile(query.get('path'));
    if (!file) return { status: 404, body: { error: 'Screenshot not found.' } };
    return { status: 200, body: { dataUrl: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` } };
  }
  if (method === 'GET' && pathname === '/api/images/search') {
    return { status: 200, body: await searchImages(query.get('q') || '') };
  }
  // The phone chooses approve-manually vs bypass itself (same-account phones only).
  if (method === 'POST' && pathname === '/api/send') return { status: 200, body: await startChatRun({ ...body, bypass: body.bypass === true }) };
  // Models: names only. API keys never leave this PC.
  if (method === 'GET' && pathname === '/api/models') return { status: 200, body: modelsState() };
  if (method === 'POST' && pathname === '/api/models/select') {
    const r = configLib.selectModel(String(body.id || configLib.AUTO_MODEL_ID));
    if (!r.ok) return { status: 400, body: { error: r.error || 'Could not switch model.' } };
    const state = modelsState();
    if (win && !win.isDestroyed()) win.webContents.send('models:changed', state);
    return { status: 200, body: state };
  }
  if (method === 'POST' && pathname === '/api/stop') { stopChatRun(body.sessionId); return { status: 200, body: { ok: true } }; }
  if (method === 'POST' && pathname === '/api/approval') { respondApproval(body.requestId, body.verdict); return { status: 200, body: { ok: true } }; }
  if (method === 'POST' && pathname === '/api/image-pick') { respondImagePick(body.requestId, body.chosenUrl); return { status: 200, body: { ok: true } }; }
  if (method === 'POST' && pathname === '/api/session/rename') {
    const session = store.sessions.find((s) => s.id === body.sessionId);
    if (!session) return { status: 404, body: { error: 'Session not found.' } };
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return { status: 400, body: { error: 'Title cannot be empty.' } };
    session.title = title;
    saveStore();
    renameSessionInDb(session.id, title);
    sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/session/delete') {
    stopChatRun(body.sessionId);
    deleteSessionRecord(body.sessionId);
    sendEvent(body.sessionId, { type: 'session_deleted', sessionId: body.sessionId });
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: 'Not found.' } };
}

// ─── Phone relay (use Craft from anywhere) ─────────────────────────────────
// The PC and the phone both connect OUT to a Supabase Realtime channel, so the
// phone works from any network as long as this PC is on and signed in. No
// server of our own, no open ports.
//   · channel: craft-<userId>-<secret>. The secret is random and lives in the
//     account's own user_metadata (craft_relay), readable only when signed in
//     as that account.
//   · presence: this PC announces itself; the phone sees whether it's online.
//   · requests: the phone sends {id, to, method, path, body, accessToken};
//     the PC checks the token belongs to the same account before running it.
//   · events: everything sendEvent() emits is mirrored to the channel.
// Realtime caps message size, so payloads travel in chunks.
const RELAY_CHUNK = 60000;
let relayChannel = null;
let relayUserId = null;
let relayStatus = 'off';
const relayParts = new Map();     // message id -> { n, got, chunks, at }
const relayAuthCache = new Map(); // phone access token -> { userId, until }

function relayNewId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function relaySend(event, obj) {
  if (!relayChannel || relayStatus !== 'SUBSCRIBED') return;
  const str = JSON.stringify(obj);
  const id = relayNewId();
  const n = Math.max(1, Math.ceil(str.length / RELAY_CHUNK));
  for (let i = 0; i < n; i++) {
    relayChannel.send({ type: 'broadcast', event, payload: { id, i, n, d: str.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK) } })
      .catch(() => {});
  }
}

function relayAssemble(payload) {
  if (!payload || typeof payload.d !== 'string') return null;
  if (payload.n === 1) { try { return JSON.parse(payload.d); } catch { return null; } }
  if (payload.n > 200) return null;
  let entry = relayParts.get(payload.id);
  if (!entry) { entry = { n: payload.n, got: 0, chunks: [], at: Date.now() }; relayParts.set(payload.id, entry); }
  if (entry.chunks[payload.i] === undefined) { entry.chunks[payload.i] = payload.d; entry.got++; }
  // Drop half-received messages that will never complete.
  for (const [key, e] of relayParts) if (Date.now() - e.at > 60_000) relayParts.delete(key);
  if (entry.got < entry.n) return null;
  relayParts.delete(payload.id);
  try { return JSON.parse(entry.chunks.join('')); } catch { return null; }
}

async function relayVerify(token) {
  if (!token) return null;
  const cached = relayAuthCache.get(token);
  if (cached && cached.until > Date.now()) return cached.userId;
  const { data, error } = await authLib.getClient().auth.getUser(token);
  if (error || !data?.user) return null;
  if (relayAuthCache.size > 50) relayAuthCache.clear();
  relayAuthCache.set(token, { userId: data.user.id, until: Date.now() + 5 * 60 * 1000 });
  return data.user.id;
}

async function handleRelayRequest(payload) {
  const msg = relayAssemble(payload);
  if (!msg || !msg.id) return;
  if (msg.to && msg.to !== deviceId()) return; // addressed to another of this account's PCs
  const reply = (status, body) => relaySend('res', { id: msg.id, status, body });
  try {
    const phoneUser = await relayVerify(msg.accessToken);
    const me = await getLoggedInUserId();
    if (!phoneUser) return reply(401, { error: 'Your sign-in expired. Sign in again.' });
    if (!me || phoneUser !== me) return reply(403, { error: 'This phone is signed in to a different account than your PC.' });
    const u = new URL(String(msg.path || '/'), 'http://relay');
    const r = await handleBridgeApi(String(msg.method || 'GET').toUpperCase(), u.pathname, u.searchParams, msg.body);
    let body = r.body;
    if (u.pathname === '/api/session' && body && Array.isArray(body.messages)) {
      body = { ...body, messages: body.messages.map((m) => (m.images ? { ...m, images: undefined, imageCount: m.images.length } : m)) };
    }
    reply(r.status, body);
  } catch (e) {
    reply(400, { error: e.message || 'Request failed.' });
  }
}

/** Screenshot bytes and pasted images stay out of relayed events (the phone fetches screenshots on demand). */
function relaySafeEvent(event) {
  const out = { ...event };
  if (out.meta && (out.meta.screenshotDataUrl || out.meta.imageDataUrls)) {
    out.meta = { ...out.meta };
    delete out.meta.screenshotDataUrl;
    delete out.meta.imageDataUrls;
  }
  if (out.message && out.message.images) out.message = { ...out.message, images: undefined };
  if (out.type === 'tool_end' && out.name === 'write_file' && out.args) out.args = { path: out.args.path };
  return out;
}

// session_sync fires after every agent event; over the relay the metadata-only
// ones are coalesced per chat so a busy run doesn't flood the channel.
const relaySyncTimers = new Map();
function relayEmit(sessionId, event) {
  if (!relayChannel || relayStatus !== 'SUBSCRIBED') return;
  const payload = { sessionId, ...relaySafeEvent(event), from: deviceId() };
  if (event.type === 'session_sync' && !event.message) {
    const key = sessionId || '_';
    clearTimeout(relaySyncTimers.get(key));
    relaySyncTimers.set(key, setTimeout(() => { relaySyncTimers.delete(key); relaySend('event', payload); }, 1200));
    return;
  }
  relaySend('event', payload);
}

let relayStarting = null;
function startRelay() {
  if (!relayStarting) relayStarting = startRelayOnce().finally(() => { relayStarting = null; });
  return relayStarting;
}

async function startRelayOnce() {
  if (!(await loadEngine())) return;
  try {
    const supabase = authLib.getClient();
    const { data } = await supabase.auth.getSession();
    const session = data?.session;
    if (!session) return;
    if (relayChannel && relayUserId === session.user.id) return;
    await stopRelay();

    let secret = session.user.user_metadata?.craft_relay;
    if (!secret) {
      secret = crypto.randomBytes(18).toString('base64url');
      const { error } = await supabase.auth.updateUser({ data: { craft_relay: secret } });
      if (error) throw error;
    }
    relayUserId = session.user.id;
    const channel = supabase.channel(`craft-${relayUserId}-${secret}`, {
      config: { broadcast: { self: false }, presence: { key: deviceId() } },
    });
    channel.on('broadcast', { event: 'req' }, ({ payload }) => { handleRelayRequest(payload); });
    channel.subscribe(async (status) => {
      relayStatus = status;
      if (status === 'SUBSCRIBED') {
        try { await channel.track({ device: os.hostname(), since: Date.now() }); } catch {}
      }
    });
    relayChannel = channel;
  } catch (e) {
    console.warn('[phone] relay could not start:', e.message);
  }
}

async function stopRelay() {
  const channel = relayChannel;
  relayChannel = null;
  relayUserId = null;
  relayStatus = 'off';
  relayAuthCache.clear();
  if (channel) { try { await authLib.getClient().removeChannel(channel); } catch {} }
}

function startRemoteServer() {
  if (remoteServer) return;
  remoteServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/') return serveStatic(res, 'mobile.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/mobile.css') return serveStatic(res, 'mobile.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/mobile.js') return serveStatic(res, 'mobile.js', 'application/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/supabase.js') return serveStatic(res, path.join('vendor', 'supabase', 'supabase.js'), 'application/javascript; charset=utf-8', 'public, max-age=86400');
    if (req.method === 'GET' && url.pathname === '/manifest.json') return serveStatic(res, 'mobile.manifest.json', 'application/manifest+json');
    if (req.method === 'GET' && url.pathname === '/logo.png') return serveStatic(res, 'logo.png', 'image/png', 'public, max-age=86400');
    if (req.method === 'GET' && /^\/agent-mascots\/[a-z]+\.png$/.test(url.pathname)) {
      return serveStatic(res, path.join('assets', 'agents', path.basename(url.pathname)), 'image/png', 'public, max-age=86400');
    }
    try {
      // Unauthenticated liveness probe the phone uses to find which of the
      // advertised addresses is reachable from its network. Reveals nothing
      // about the account.
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        return remoteJson(res, 200, { app: 'codeply-craft', device: os.hostname(), deviceId: deviceId() });
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (loginThrottled()) return remoteJson(res, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
        const body = await readRemoteBody(req);
        const accessToken = String(body.accessToken || '');
        if (!accessToken) return remoteJson(res, 400, { error: 'Missing sign-in token.' });
        if (!(await loadEngine())) return remoteJson(res, 503, { error: 'Craft is still starting. Try again in a moment.' });
        const desktop = await remoteAccount();
        if (!desktop.signedIn) return remoteJson(res, 403, { error: 'Craft on your PC is signed out. Sign in there with the same account first.' });
        const { data, error } = await authLib.getClient().auth.getUser(accessToken);
        if (error || !data?.user) return remoteJson(res, 401, { error: 'Your sign-in expired. Sign in again.' });
        if (data.user.id !== desktop.id) {
          return remoteJson(res, 403, { error: `This PC is signed in to Craft as ${desktop.email}. Sign in on your phone with that account.` });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        remoteTokens.set(token, { userId: data.user.id, email: data.user.email, createdAt: Date.now() });
        return remoteJson(res, 200, { token, device: os.hostname(), account: { email: data.user.email, signedIn: true } });
      }
      if (!(await remoteAuthorized(req, url))) return remoteJson(res, 401, { error: 'Sign in again to connect to your PC.' });
      if (req.method === 'GET' && url.pathname === '/api/screenshot') {
        const file = screenshotFile(url.searchParams.get('path'));
        if (!file) return remoteJson(res, 404, { error: 'Screenshot not found.' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', ...CORS_HEADERS });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS_HEADERS });
        res.write('retry: 2000\n\n');
        remoteEventClients.add(res);
        // Mobile networks kill an idle SSE socket after ~30-60s; a comment
        // ping keeps bytes flowing without looking like a real event.
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); remoteEventClients.delete(res); }
        }, 20000);
        req.on('close', () => { clearInterval(heartbeat); remoteEventClients.delete(res); });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') { remoteTokens.delete(remoteToken(req, url)); return remoteJson(res, 200, { ok: true }); }
      const body = req.method === 'POST' ? await readRemoteBody(req) : {};
      const r = await handleBridgeApi(req.method, url.pathname, url.searchParams, body);
      return remoteJson(res, r.status, r.body);
    } catch (err) { return remoteJson(res, 400, { error: err.message || 'Request failed.' }); }
  });
  remoteServer.on('error', (err) => {
    console.error('Codeply Away local server failed to start:', err.message);
    remoteServer = null;
    if (err.code === 'EADDRINUSE' && win && !win.isDestroyed()) {
      win.webContents.send('remote:server-error', {
        message: `Port ${REMOTE_PORT} is already in use. Close any other running copy of Craft and reopen this dialog.`,
      });
    }
  });
  remoteServer.listen(REMOTE_PORT, '0.0.0.0');
}

// Where the phone web app is hosted (override for a staging deploy).
const MOBILE_APP_URL = process.env.CRAFT_MOBILE_URL || 'https://mobile.codeply.app';

async function remoteInfo() {
  const account = await remoteAccount();
  if (account.signedIn && !relayChannel) startRelay();
  return {
    mobileUrl: MOBILE_APP_URL,
    keepAwake: !!store.keepAwake,
    relay: relayStatus === 'SUBSCRIBED',
    relayStatus,
    running: !!remoteServer,
    urls: remoteUrls(),
    port: REMOTE_PORT,
    device: os.hostname(),
    signedIn: account.signedIn,
    email: account.email,
    phones: new Set([...remoteTokens.values()].map((t) => t.createdAt)).size,
  };
}

function sendEvent(sessionId, event) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', { sessionId, ...event });
  broadcastRemote(sessionId, event);
}

// Which chats have a run in flight - lets every window/phone keep its
// send/stop button honest even for events it missed while looking elsewhere.
function broadcastRunStatus() {
  const active = [...activeRuns.keys()];
  if (win && !win.isDestroyed()) win.webContents.send('runs:status', active);
  broadcastRemote(null, { type: 'runs_status', active });
}

const MAX_HISTORY_IMAGES = 4;

/** One line per tool call the agent really made, for grounding later turns. */
function describeAction(m) {
  const verb = { write_file: 'wrote', edit_file: 'edited', run: 'ran', fetch_image: 'downloaded', browser_check: 'checked in browser',
    vercel_deploy: 'deployed', supabase_sql: 'ran SQL', supabase_api: 'called Supabase API', vercel_api: 'called Vercel API',
    github_create_repo: 'pushed to GitHub', supabase_create_project: 'created Supabase project', gmail_send: 'emailed',
    slack_post_message: 'posted to Slack' }[m.name];
  if (!verb) return null;
  const exit = typeof m.exitCode === 'number' ? ` (exit ${m.exitCode})` : '';
  return `${verb} ${m.label || ''}${exit}${m.ok === false ? ' - FAILED' : ''}`.trim();
}

/**
 * Model-facing history: alternating prose turns. Each assistant turn carries
 * a short, factual list of the actions it really performed - so on a
 * follow-up the model knows what it actually changed last time instead of
 * reconstructing it from its own (possibly wrong) summary. Also carries
 * forward a bounded number of the most recent pasted images.
 */
function buildHistory(session) {
  const turns = [];
  let pendingActions = [];
  const flushActions = () => {
    if (!pendingActions.length) return;
    const last = turns[turns.length - 1];
    const note = `[Actions actually performed: ${pendingActions.slice(0, 12).join('; ')}${pendingActions.length > 12 ? `; +${pendingActions.length - 12} more` : ''}]`;
    if (last && last.role === 'assistant') last.content += `\n\n${note}`;
    else turns.push({ role: 'assistant', content: note });
    pendingActions = [];
  };
  for (const m of session.messages) {
    if (m.kind === 'user') {
      flushActions();
      turns.push({ role: 'user', content: m.text, images: m.images || null });
    } else if (m.kind === 'assistant' && m.text) {
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') last.content += '\n\n' + m.text;
      else turns.push({ role: 'assistant', content: m.text });
    } else if (m.kind === 'tool') {
      const line = describeAction(m);
      if (line) pendingActions.push(line);
    }
  }
  flushActions();
  const kept = turns.slice(-20);
  // A history must start with a user turn for most providers.
  while (kept.length && kept[0].role !== 'user') kept.shift();

  let imageBudget = MAX_HISTORY_IMAGES;
  for (let i = kept.length - 1; i >= 0; i--) {
    const t = kept[i];
    if (t.role !== 'user' || !t.images || !t.images.length || imageBudget <= 0) { delete t.images; continue; }
    const take = t.images.slice(0, imageBudget);
    imageBudget -= take.length;
    t.content = [{ type: 'text', text: t.content }, ...take.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } }))];
    delete t.images;
  }

  return kept;
}

// ─── Roles ──────────────────────────────────────────────────────────────────
// The single agent takes on the role that fits what it's doing (see
// codeply-cli/lib/subagents.js). The badge only appears when the role changes,
// so a chat shows "now working as Backend" at the moment it switches, not on
// every single turn.
function emitRoleBadge(session, roleId) {
  const role = roleId ? rolesLib.getRole(roleId) : null;
  const key = role ? role.id : 'general';
  if (session.lastRole === key) return;
  session.lastRole = key;
  const badge = role
    ? { id: role.id, name: role.tagline.replace(/ Specialist$/i, ''), tagline: 'role', color: role.color, mascot: role.mascot }
    : { id: 'general', name: 'General', tagline: 'role', color: '', mascot: 'general.png' };
  sendEvent(session.id, { type: 'role_active', ...badge });
  session.messages.push({ kind: 'role_active', ...badge, at: Date.now() });
}

// ─── Task Maker ─────────────────────────────────────────────────────────────
// A message that bundles more than one distinct ask ("change this color and
// this font, then on the next page change the padding") gets split into an
// ordered checklist and worked through one task at a time - its own step
// budget and role per task, history threaded forward so later tasks see what
// earlier ones actually did - followed by a verification pass over the whole
// list. A plain single ask never pays for any of this.

const MAX_TASKS = 10;

// Cheap local pre-filter so a normal single ask doesn't cost an extra model
// call. A false negative just runs as one turn; a false positive costs one
// classification call that comes back with a single task.
const MULTI_PART_CONNECTORS = /\b(and then|then\s|also\s|next page|next[,:]|after that|once (that'?s )?done|additionally|as well as|first[, ].*then\b)/i;
function looksMultiPart(text) {
  if (text.length < 20) return false;
  if (MULTI_PART_CONNECTORS.test(text)) return true;
  const clauses = text.split(/\n+|;|(?<=[a-z0-9])\.\s+(?=[A-Z])|\d+[.)]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
  return clauses.length >= 2;
}

async function planTaskList(text, route) {
  const prompt = `A user sent this message to a coding agent. Decide whether it actually contains more than one distinct, separately actionable instruction (e.g. "change the button color to blue and make the heading font bigger, then on the settings page increase the padding to 5px" is 3 tasks; "fix the login bug" is 1 task - do not invent extra tasks that were not asked for).

If it's genuinely more than one, break it into an ordered checklist. Each task must be specific enough to act on by itself (name the file/element/change) AND have a concrete, checkable deliverable - a file written or changed, a feature that now works. Never emit a standalone task that is just reading, exploring, or "understanding" the code - reading whatever files a task needs is part of THAT task. Never emit a standalone "test/verify everything" task either; verification runs automatically after the list. If it's really just one task, return exactly one task that is the request itself, worded the same way. Use at most ${MAX_TASKS} tasks.

Respond with ONLY a JSON object of the shape {"tasks": ["first task", "second task", ...]} and nothing else.

Message:
${text}`;

  const r = await aiLib.chatJson([{ role: 'user', content: prompt }], { route });
  if (!r.success) return { ok: false, error: r.error };
  const tasks = Array.isArray(r.json?.tasks) ? r.json.tasks.map((t) => String(t || '').trim()).filter(Boolean) : [];
  if (tasks.length === 0) return { ok: false, error: 'Could not break this request into tasks.' };
  return { ok: true, tasks: tasks.slice(0, MAX_TASKS) };
}

/**
 * Drives exactly one runAgent() turn to completion, forwarding every event to
 * the renderer/phone and persisting what matters on the session.
 *
 * @returns {{status:'done'|'error'|'aborted', madeAnyEdit:boolean, replyText:string, error?:string}}
 */
async function runOneTurn({ session, userMessage, images, history, mode, cwd, approve, signal, route, roleId, goal, maxSteps, verifyOnly }) {
  let status = 'error';
  let madeAnyEdit = false;
  let replyText = '';
  let error = '';
  // No role detected for this particular text (a vague follow-up like "it
  // still doesn't work"): keep the role the chat is already working in.
  if (!roleId) roleId = session.stickyRole || null;
  emitRoleBadge(session, roleId);
  try {
    const run = agentMod.runAgent({
      userMessage, history, mode: mode || 'Build', cwd, approve, browser: browserCheck, images, signal, route,
      roleId, goal, maxSteps, verifyOnly,
    });
    for await (const ev of run) {
      if (ev.type === 'text') {
        session.messages.push({ kind: 'assistant', text: ev.text, interim: !!ev.interim, at: Date.now() });
        replyText += (replyText ? '\n\n' : '') + ev.text;
      } else if (ev.type === 'reasoning') {
        session.messages.push({ kind: 'reasoning', text: ev.text, ms: ev.ms, at: Date.now() });
      } else if (ev.type === 'tool_end') {
        const persistedArgs = ev.args && ev.name === 'write_file' ? { path: ev.args.path } : ev.args;
        session.messages.push({
          kind: 'tool', name: ev.name,
          label: ev.summary || ev.args?.path || ev.args?.command || ev.args?.pattern || '',
          ok: ev.ok, args: persistedArgs, at: Date.now(),
          exitCode: typeof ev.meta?.exitCode === 'number' ? ev.meta.exitCode : undefined,
          added: typeof ev.meta?.added === 'number' ? ev.meta.added : undefined,
          removed: typeof ev.meta?.removed === 'number' ? ev.meta.removed : undefined,
          screenshotPath: ev.meta?.screenshotPath || undefined,
        });
      } else if (ev.type === 'notice') {
        session.messages.push({ kind: 'notice', level: ev.level || 'info', text: ev.text, at: Date.now() });
      } else if (ev.type === 'done' && Array.isArray(ev.actions)) {
        // The factual record of what this turn changed - rendered as a
        // "what actually happened" card, independent of the model's prose.
        const changed = ev.actions.filter((a) => a.ok && ['write_file', 'edit_file', 'fetch_image'].includes(a.tool));
        const checks = ev.actions.filter((a) => ['run', 'browser_check'].includes(a.tool));
        if (changed.length || checks.length) {
          const summary = {
            kind: 'turn_summary',
            files: [...new Set(changed.map((a) => a.label))].slice(0, 30),
            // Same check repeated (e.g. the page re-opened after each fix): show its latest result once.
            checks: [...new Map(checks.map((a) => [`${a.tool}|${a.label}`, a])).values()].slice(-8)
              .map((a) => ({ tool: a.tool, label: a.label, ok: a.ok, exitCode: a.exitCode })),
            unverified: ev.unverifiedFiles || [],
            at: Date.now(),
          };
          session.messages.push(summary);
          sendEvent(session.id, { type: 'turn_summary', ...summary });
        }
      }
      session.updatedAt = Date.now();
      if (ev.type === 'error' && typeof ev.error === 'string' && PROVIDER_EXHAUSTED_RE.test(ev.error)) {
        notifyProviderExhausted(session, ev.error);
      }
      if (ev.type === 'error') session.messages.push({ kind: 'notice', level: 'error', text: ev.error, at: Date.now() });
      sendEvent(session.id, ev);
      sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
      if (ev.type === 'done') { status = 'done'; madeAnyEdit = !!ev.madeAnyEdit; break; }
      if (ev.type === 'error') { status = 'error'; error = String(ev.error || ''); break; }
      if (ev.type === 'aborted') { status = 'aborted'; break; }
    }
  } catch (err) {
    sendEvent(session.id, { type: 'error', error: err.message });
    session.messages.push({ kind: 'notice', level: 'error', text: `Something went wrong: ${err.message}`, at: Date.now() });
    status = 'error';
    error = err.message;
  }
  return { status, madeAnyEdit, replyText, error };
}

const TASK_STATUS_DONE = new Set(['done', 'done-no-changes']);

/**
 * Runs a message: a single turn, or - when it bundles several asks - a
 * checklist of tasks followed by a verification pass. Returns the overall
 * outcome and the history threaded through it (used by /goal).
 */
async function runTaskMaker({ session, originalMessage, history, mode, cwd, approve, signal, route, forceClassify = false, goal, maxSteps }) {
  if (!forceClassify && !looksMultiPart(originalMessage)) {
    const r = await runOneTurn({ session, userMessage: originalMessage, history, mode, cwd, approve, signal, route, roleId: rolesLib.detectRole(originalMessage), goal, maxSteps });
    return { ...r, history: [...history, { role: 'user', content: originalMessage }, { role: 'assistant', content: r.replyText || '(no reply)' }] };
  }

  const plan = await planTaskList(originalMessage, route);
  if (!plan.ok || plan.tasks.length < 2) {
    if (!plan.ok) {
      sendEvent(session.id, { type: 'helper_note', label: 'Task list', why: `couldn't be planned (${plan.error}). Continuing as a single task.`, failed: true });
    }
    const r = await runOneTurn({ session, userMessage: originalMessage, history, mode, cwd, approve, signal, route, roleId: rolesLib.detectRole(originalMessage), goal, maxSteps });
    return { ...r, history: [...history, { role: 'user', content: originalMessage }, { role: 'assistant', content: r.replyText || '(no reply)' }] };
  }

  const tasks = plan.tasks.map((t, i) => ({ id: i + 1, text: t, status: 'pending', role: rolesLib.detectRole(t) || null }));
  const tasklistMsg = { kind: 'tasklist', tasks: tasks.map((t) => ({ ...t })), at: Date.now() };
  session.messages.push(tasklistMsg);
  session.updatedAt = Date.now();
  const syncList = () => { tasklistMsg.tasks = tasks.map((t) => ({ ...t })); };
  sendEvent(session.id, { type: 'tasklist', tasks: tasklistMsg.tasks });
  sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });

  let runHistory = history;
  let anyEdits = false;
  let lastError = '';

  for (const task of tasks) {
    if (signal.aborted) {
      task.status = 'skipped';
      syncList();
      sendEvent(session.id, { type: 'task_end', id: task.id, status: 'skipped' });
      continue;
    }

    task.status = 'in_progress';
    syncList();
    sendEvent(session.id, { type: 'task_start', id: task.id, text: task.text });
    sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });

    const priorSummary = tasks
      .filter((t) => t.id < task.id)
      .map((t) => `- [${TASK_STATUS_DONE.has(t.status) ? 'done' : t.status}] ${t.text}`).join('\n');
    const taskMessage = `You are working through a checklist for this overall request: "${originalMessage}"\n\n` +
      (priorSummary ? `Earlier tasks:\n${priorSummary}\n\n` : '') +
      `Do ONLY this task now (task ${task.id} of ${tasks.length}):\n${task.text}\n\n` +
      'Verify this task before you finish it, and describe only what you actually did.';

    const result = await runOneTurn({ session, userMessage: taskMessage, history: runHistory, mode, cwd, approve, signal, route, roleId: task.role, goal, maxSteps });

    if (result.status === 'aborted') {
      task.status = 'skipped';
      syncList();
      sendEvent(session.id, { type: 'task_end', id: task.id, status: 'skipped' });
      break;
    }

    if (result.status === 'done') {
      task.status = result.madeAnyEdit ? 'done' : 'done-no-changes';
      if (result.madeAnyEdit) anyEdits = true;
      runHistory = [...runHistory, { role: 'user', content: taskMessage }, { role: 'assistant', content: result.replyText || '(no reply text)' }];
    } else {
      task.status = 'failed';
      lastError = result.error;
      // A dead provider will fail every remaining task the same way - stop
      // rather than burning through the list.
      if (PROVIDER_EXHAUSTED_RE.test(result.error || '') || /not signed in|api key|unauthor|can't reach|couldn't find ollama/i.test(result.error || '')) {
        syncList();
        sendEvent(session.id, { type: 'task_end', id: task.id, status: task.status });
        for (const rest of tasks.filter((t) => t.status === 'pending')) {
          rest.status = 'skipped';
          sendEvent(session.id, { type: 'task_end', id: rest.id, status: 'skipped' });
        }
        syncList();
        break;
      }
    }

    syncList();
    sendEvent(session.id, { type: 'task_end', id: task.id, status: task.status });
    session.updatedAt = Date.now();
    sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
  }

  // ── Verification loop ──
  // After the tasks, one more turn that checks each task against the real
  // project (reads the changed code, runs checks, browser_checks pages),
  // fixes what's missing, and reports task by task.
  let verifyResult = null;
  if (anyEdits && !signal.aborted) {
    const list = tasks.map((t) => `${t.id}. [${TASK_STATUS_DONE.has(t.status) ? 'reported done' : t.status}] ${t.text}`).join('\n');
    const verifyMessage = `All checklist tasks for this request have been attempted: "${originalMessage}"\n\n${list}\n\n` +
      'Now run a verification pass. For EACH task, check it is really done by looking at the actual project - read the changed code, ' +
      'run the syntax check / tests / build that applies, and browser_check any page that was touched (look at the screenshot). ' +
      'Fix anything missing or broken and re-check it. Finish with a short verification report, one line per task: ' +
      '"✅ <task> - verified by <how>", "⚠️ <task> - not verified: <why>", or "❌ <task> - not done: <what is missing>".';
    sendEvent(session.id, { type: 'verification_start' });
    verifyResult = await runOneTurn({ session, userMessage: verifyMessage, history: runHistory, mode, cwd, approve, signal, route, roleId: 'testing', goal, maxSteps, verifyOnly: true });
    if (verifyResult.status === 'done') {
      runHistory = [...runHistory, { role: 'user', content: verifyMessage }, { role: 'assistant', content: verifyResult.replyText || '' }];
    }
  }

  const failed = tasks.filter((t) => t.status === 'failed').length;
  if (failed && !verifyResult) {
    const text = `Finished the checklist with ${failed} task(s) that failed.${lastError ? ` Last error: ${lastError}` : ''}`;
    session.messages.push({ kind: 'assistant', text, at: Date.now() });
    sendEvent(session.id, { type: 'text', text });
  }

  const status = signal.aborted ? 'aborted' : failed === tasks.length ? 'error' : 'done';
  return {
    status,
    madeAnyEdit: anyEdits,
    replyText: verifyResult?.replyText || '',
    error: lastError,
    history: runHistory,
  };
}

// ─── /goal ──────────────────────────────────────────────────────────────────
// "/goal <objective>" keeps the agent working until the objective is met:
// work (split into tasks when it has several parts) → an independent
// verification turn that inspects the real project and ends with
// GOAL_STATUS: ACHIEVED or NOT_ACHIEVED - <what remains> → repeat with what
// remains. Bounded, stoppable, and it gives up honestly when stuck.

const GOAL_PREFIX_RE = /^\/goal\b[:\s]*/i;
const MAX_GOAL_ITERATIONS = 8;
const GOAL_STEPS_PER_TURN = 60;

function parseGoalStatus(text) {
  const m = /GOAL_STATUS:\s*(ACHIEVED|NOT[_\s-]?ACHIEVED)\s*(?:[\u2014\u2013:-]+\s*)?([\s\S]*)$/i.exec(text || '');
  if (!m) return { achieved: false, remaining: '', parsed: false };
  const achieved = /^ACHIEVED$/i.test(m[1]);
  return { achieved, remaining: achieved ? '' : m[2].trim().slice(0, 1500), parsed: true };
}

async function runGoal({ session, goal, history, mode, cwd, approve, signal, route }) {
  const goalMsg = { kind: 'goal', goal, status: 'running', iteration: 0, max: MAX_GOAL_ITERATIONS, note: '', at: Date.now() };
  session.messages.push(goalMsg);
  const syncGoal = (patch) => {
    Object.assign(goalMsg, patch);
    sendEvent(session.id, { type: 'goal_update', goal: goalMsg.goal, status: goalMsg.status, iteration: goalMsg.iteration, max: goalMsg.max, note: goalMsg.note });
    sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
  };
  syncGoal({});

  let runHistory = history;
  let remaining = '';
  let previousRemaining = null;
  let quietIterations = 0;

  for (let i = 1; i <= MAX_GOAL_ITERATIONS; i++) {
    if (signal.aborted) break;
    syncGoal({ iteration: i, status: 'running', note: i === 1 ? 'Working on it' : 'Working on what is left' });

    // ── Work ──
    let work;
    if (i === 1) {
      work = await runTaskMaker({
        session, originalMessage: goal, history: runHistory, mode, cwd, approve, signal, route,
        forceClassify: looksMultiPart(goal), goal, maxSteps: GOAL_STEPS_PER_TURN,
      });
    } else {
      const msg = `Keep working toward the goal: "${goal}"\n\nThe last verification found this still missing:\n${remaining || '(no details were given - re-check the goal against the project)'}\n\n` +
        'Do that now, verify it, and describe only what you actually did.';
      const r = await runOneTurn({ session, userMessage: msg, history: runHistory, mode, cwd, approve, signal, route, roleId: rolesLib.detectRole(remaining || goal), goal, maxSteps: GOAL_STEPS_PER_TURN });
      work = { ...r, history: [...runHistory, { role: 'user', content: msg }, { role: 'assistant', content: r.replyText || '(no reply)' }] };
    }
    runHistory = work.history || runHistory;
    if (signal.aborted || work.status === 'aborted') break;
    if (work.status === 'error' && (PROVIDER_EXHAUSTED_RE.test(work.error || '') || /not signed in|api key|unauthor|can't reach|couldn't find ollama/i.test(work.error || ''))) {
      syncGoal({ status: 'failed', note: 'Stopped - the model is unavailable.' });
      return;
    }

    // ── Verify ──
    syncGoal({ status: 'verifying', note: 'Checking whether the goal is met' });
    const checkMsg = `Goal: "${goal}"\n\nCheck whether this goal is now FULLY achieved by inspecting the real project - read the relevant files, ` +
      'run the tests/build/syntax checks that apply, and browser_check any pages involved. Do not assume; only trust what you see in tool results. ' +
      'If something small is broken or missing and you can fix it right now, fix it and re-check. ' +
      'End your reply with exactly one final line in one of these two forms:\n' +
      'GOAL_STATUS: ACHIEVED\nGOAL_STATUS: NOT_ACHIEVED - <what is still missing, specifically>';
    const check = await runOneTurn({ session, userMessage: checkMsg, history: runHistory, mode, cwd, approve, signal, route, roleId: 'testing', goal, maxSteps: 30, verifyOnly: true });
    runHistory = [...runHistory, { role: 'user', content: checkMsg }, { role: 'assistant', content: check.replyText || '' }];
    if (signal.aborted || check.status === 'aborted') break;

    const verdict = parseGoalStatus(check.replyText);
    if (verdict.achieved) {
      syncGoal({ status: 'achieved', note: `Achieved after ${i} iteration${i === 1 ? '' : 's'}` });
      return;
    }
    remaining = verdict.remaining || (verdict.parsed ? '' : 'The check did not give a clear verdict.');

    // Stuck: the same thing is still missing and nothing changed.
    const madeProgress = work.madeAnyEdit || check.madeAnyEdit;
    quietIterations = madeProgress ? 0 : quietIterations + 1;
    if ((previousRemaining !== null && remaining === previousRemaining && !madeProgress) || quietIterations >= 2) {
      syncGoal({ status: 'blocked', note: `Stuck - no progress on: ${remaining.slice(0, 200)}` });
      return;
    }
    previousRemaining = remaining;
  }

  if (signal.aborted) syncGoal({ status: 'stopped', note: 'Stopped' });
  else syncGoal({ status: 'incomplete', note: `Not finished after ${MAX_GOAL_ITERATIONS} iterations. Still missing: ${remaining.slice(0, 200)}` });
}

async function startChatRun({ sessionId, cwd, mode, bypass, text, images, clientId = null }) {
  text = String(text || '').trim();
  images = Array.isArray(images) ? images.slice(0, 6) : undefined;
  if (!text && !images?.length) return { error: 'Write a task before sending it.' };
  const ok = await loadEngine();
  if (!ok) return { error: 'Engine not available.' };
  if (!cwd || !fs.existsSync(cwd)) return { error: 'Pick a project folder first.' };
  mode = ['Build', 'Plan', 'Ask'].includes(mode) ? mode : 'Build';

  // The model is decided once, when the turn starts - switching models
  // mid-run never changes a run that's already going.
  const route = currentRoute();
  if (route.auto && !(await getLoggedInUserId())) {
    return { error: 'Sign in to use Auto, or pick one of your own models from the model menu.' };
  }

  const goalMatch = GOAL_PREFIX_RE.exec(text);
  const goal = goalMatch ? text.slice(goalMatch[0].length).trim() : null;
  if (goalMatch && !goal) return { error: 'Add the goal after /goal - for example: /goal make the checkout page work end to end.' };
  if (goal && mode !== 'Build') return { error: '/goal needs Build mode, since it changes files. Switch the mode chip to Build.' };

  let session = sessionId ? store.sessions.find((s) => s.id === sessionId) : null;
  if (!session) {
    const titleSource = goal || text;
    session = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: titleSource.length > 46 ? titleSource.slice(0, 46) + '…' : titleSource,
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      alwaysAllowed: [],
    };
    store.sessions.unshift(session);
  }
  if (activeRuns.has(session.id)) return { error: 'A run is already in progress for this chat.' };

  rememberProject(cwd);
  const detectedRole = rolesLib.detectRole(goal || text);
  if (detectedRole) session.stickyRole = detectedRole;
  session.lastRole = null; // every reply opens with a "Working as ..." badge
  const history = buildHistory(session);
  // images are kept on the session record so reopening the chat still shows
  // them; buildHistory() only re-sends the last few to the model.
  session.messages.push({ kind: 'user', text, images: images?.length ? images : undefined, at: Date.now() });
  session.updatedAt = Date.now();
  session.cwd = cwd;
  saveStore();
  syncSessionToDb(session);
  sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session), message: session.messages.at(-1), origin: clientId });

  // A real AbortController - fetch() only cancels an in-flight request when
  // handed a genuine AbortSignal.
  const abortController = new AbortController();
  const signal = abortController.signal;

  // "Always allow" is scoped to this chat and persists across its messages.
  // fetch_image never offers it (every image is a different pick).
  if (!Array.isArray(session.alwaysAllowed)) session.alwaysAllowed = [];
  session.alwaysAllowed = session.alwaysAllowed.filter((t) => t !== 'fetch_image');
  const alwaysAllowed = new Set(session.alwaysAllowed);
  activeRuns.set(session.id, { signal, abortController });
  updateSleepBlocker();
  broadcastRunStatus();

  const approve = async (req) => {
    if (signal.aborted) return 'reject';
    if (bypass || (req.tool !== 'fetch_image' && alwaysAllowed.has(req.tool))) {
      sendEvent(session.id, { type: 'approval_auto', tool: req.tool, title: req.title, bypass: !!bypass });
      return 'once';
    }

    // fetch_image gets a picker instead of a plain accept/reject card: the
    // user searches and clicks a real photo rather than trusting whatever the
    // model auto-picked.
    if (req.tool === 'fetch_image') {
      const id = ++approvalCounter;
      sendEvent(session.id, {
        type: 'image_pick_request',
        requestId: id,
        path: req.path || '',
        url: req.detail || '',
        keywords: guessImageKeywords(req.detail || '', req.path || ''),
        danger: !!req.danger,
      });
      return new Promise((resolve) => {
        pendingImagePicks.set(id, { sessionId: session.id, resolve: (chosenUrl) => {
          pendingImagePicks.delete(id);
          sendEvent(session.id, { type: 'image_pick_resolved', requestId: id });
          resolve(chosenUrl ? { action: 'once', url: chosenUrl } : 'reject');
        } });
      });
    }

    const id = ++approvalCounter;
    sendEvent(session.id, {
      type: 'approval_request',
      requestId: id,
      tool: req.tool,
      title: req.title,
      detail: req.detail || '',
      danger: !!req.danger,
      diff: req.diff || null,
    });
    return new Promise((resolve) => {
      pendingApprovals.set(id, { sessionId: session.id, resolve: (verdict) => {
        pendingApprovals.delete(id);
        if (verdict === 'always') {
          alwaysAllowed.add(req.tool);
          session.alwaysAllowed = Array.from(alwaysAllowed);
          saveStore();
          syncSessionToDb(session);
        }
        // Tell every other device showing this card that it's been answered.
        sendEvent(session.id, { type: 'approval_resolved', requestId: id, verdict });
        resolve(verdict === 'reject' ? 'reject' : verdict);
      } });
    });
  };

  (async () => {
    try {
      if (goal) {
        await runGoal({ session, goal, history, mode, cwd, approve, signal, route });
      } else if (mode === 'Build' && !images?.length) {
        // Plan/Ask are single coherent answers, and an image belongs in one
        // turn the model can look at - only text-only Build sends can split.
        await runTaskMaker({ session, originalMessage: text, history, mode, cwd, approve, signal, route });
      } else {
        await runOneTurn({ session, userMessage: text, images, history, mode, cwd, approve, signal, route, roleId: rolesLib.detectRole(text) });
      }
    } catch (err) {
      sendEvent(session.id, { type: 'error', error: err.message });
      session.messages.push({ kind: 'notice', level: 'error', text: `Something went wrong: ${err.message}`, at: Date.now() });
    } finally {
      activeRuns.delete(session.id);
      updateSleepBlocker();
      broadcastRunStatus();
      saveStore();
      syncSessionToDb(session);
      sendEvent(session.id, { type: 'run_finished' });
      sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
      notifyTaskComplete(session);
      if (session.messages.filter((m) => m.kind === 'user').length === 1) {
        generateSessionTitle(session);
      }
    }
  })();

  return { sessionId: session.id, title: session.title, route: { label: modelLabel(route) } };
}

function stopChatRun(sessionId) {
  const run = activeRuns.get(sessionId);
  if (!run) return;
  run.abortController.abort();
  // A pending approval (or image pick) blocks the loop from noticing the
  // abort until it resolves - cancel both so it notices immediately.
  // Only this chat's - other chats' runs keep their own prompts.
  for (const [, p] of [...pendingApprovals]) if (p.sessionId === sessionId) p.resolve('reject');
  for (const [, p] of [...pendingImagePicks]) if (p.sessionId === sessionId) p.resolve(null);
}

function respondApproval(requestId, verdict) {
  const p = pendingApprovals.get(Number(requestId));
  if (p) p.resolve(['once', 'always', 'reject'].includes(verdict) ? verdict : 'reject');
}
function respondImagePick(requestId, chosenUrl) {
  const p = pendingImagePicks.get(Number(requestId));
  if (p) p.resolve(chosenUrl || null);
}

ipcMain.handle('chat:send', (e, payload) => startChatRun(payload));
ipcMain.handle('remote:info', () => remoteInfo());
ipcMain.handle('remote:setKeepAwake', (e, on) => {
  store.keepAwake = !!on;
  saveStore();
  updateSleepBlocker();
  return { ok: true };
});
// Only our own phone-app address is ever opened this way.
ipcMain.handle('shell:openExternal', (e, url) => {
  if (url === MOBILE_APP_URL) shell.openExternal(url);
});

ipcMain.on('chat:stop', (e, sessionId) => {
  stopChatRun(sessionId);
});

ipcMain.on('approval:respond', (e, { requestId, verdict }) => {
  respondApproval(requestId, verdict);
});

ipcMain.on('imagepick:respond', (e, { requestId, chosenUrl }) => {
  respondImagePick(requestId, chosenUrl);
});

ipcMain.handle('shell:openPath', (e, p) => shell.openPath(p));

// ─── Embedded terminal ──────────────────────────────────────────────────────
// Not a real pty (node-pty needs a native rebuild against Electron's ABI, and
// there's no Visual Studio toolchain available here to do that) - instead a
// plain child_process running the user's own shell, with its stdio piped over
// IPC into an xterm.js view. This still runs as the user: same PATH, same git
// credential helper, same gh/ssh auth already on disk, no separate login.
// The one real cost is no true pty - full-screen TUI programs (vim, htop, a
// nested REPL that redraws in place) won't render right, but that's not what
// this is for; ordinary commands (git, npm, gh) work fine piped.
const { spawn } = require('child_process');

let termProc = null;

function shellCommand() {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] };
  }
  const sh = process.env.SHELL || '/bin/bash';
  return { file: sh, args: ['-l'] };
}

ipcMain.handle('terminal:start', (e, cwd) => {
  if (termProc && !termProc.killed) return { ok: true, already: true };
  const { file, args } = shellCommand();
  const dir = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
  try {
    termProc = spawn(file, args, {
      cwd: dir,
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  const send = (chunk) => { if (win && !win.isDestroyed()) win.webContents.send('terminal:data', chunk.toString('utf8')); };
  termProc.stdout.on('data', send);
  termProc.stderr.on('data', send);
  termProc.on('exit', (code) => {
    if (win && !win.isDestroyed()) win.webContents.send('terminal:exit', { code });
    termProc = null;
  });
  return { ok: true, cwd: dir };
});

ipcMain.on('terminal:input', (e, data) => {
  if (termProc && termProc.stdin.writable) termProc.stdin.write(data);
});

ipcMain.on('terminal:kill', () => {
  if (termProc) { try { termProc.kill(); } catch {} termProc = null; }
});

// ─── Auto-update ────────────────────────────────────────────────────────────
// Checks the GitHub release feed (latest.yml / latest-mac.yml, published by the
// release workflow) at startup and every few hours.
//   · A normal update downloads quietly and installs the next time the app
//     quits; the UI shows a small "update ready" pill.
//   · A REQUIRED update blocks the app until it's installed. An update is
//     required when its major version is higher (1.x -> 2.0) or its release
//     notes contain "[required]" (edit the GitHub release to force one).
// Windows installs automatically. macOS won't auto-install into an unsigned
// app, so there the update is announced with a button that downloads the new
// .dmg instead.
const RELEASES_URL = 'https://github.com/AwaisSDev/Codeply-Craft/releases/latest/download';
const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
let updater = null;
let updateState = { status: 'idle', current: app.getVersion() };

function sendUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  // Test-mode trace (CRAFT_TEST_UPDATES=1 plus a file path) for checking the flow from source.
  if (process.env.CRAFT_TEST_UPDATES_LOG) {
    try { fs.appendFileSync(process.env.CRAFT_TEST_UPDATES_LOG, `${updateState.status} ${updateState.version || ''} ${updateState.percent ?? ''} ${updateState.required ? 'REQUIRED' : 'optional'}
`); } catch {}
  }
  if (win && !win.isDestroyed()) win.webContents.send('update:state', updateState);
}

function releaseNotesText(info) {
  const n = info && info.releaseNotes;
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map((x) => x.note || '').join('\n');
  return '';
}

function isRequiredUpdate(current, next, notes) {
  const major = (v) => parseInt(String(v || '0').replace(/^v/, '').split('.')[0], 10) || 0;
  return major(next) > major(current) || /\[required\]/i.test(notes || '');
}

function macDownloadUrl() {
  return `${RELEASES_URL}/Codeply-Craft-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
}

function setupAutoUpdates() {
  // Packaged builds only; CRAFT_TEST_UPDATES=1 exercises it from source.
  const testing = process.env.CRAFT_TEST_UPDATES === '1';
  if (!app.isPackaged && !testing) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    console.warn('[update] electron-updater unavailable:', e.message);
    return;
  }
  if (testing) {
    updater.forceDevUpdateConfig = true;
    updater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml');
    // Pretend to be an older build so the live release shows up as an update.
    if (process.env.CRAFT_TEST_UPDATES_VERSION) {
      try { updater.currentVersion = require(require.resolve('semver', { paths: [path.dirname(require.resolve('electron-updater'))] })).parse(process.env.CRAFT_TEST_UPDATES_VERSION); } catch {}
      updateState.current = process.env.CRAFT_TEST_UPDATES_VERSION;
    }
  }
  const canAutoInstall = process.platform !== 'darwin';
  updater.autoDownload = canAutoInstall;
  updater.autoInstallOnAppQuit = canAutoInstall;
  updater.allowPrerelease = false;
  updater.logger = null;

  updater.on('update-available', (info) => {
    const notes = releaseNotesText(info);
    sendUpdateState({
      status: canAutoInstall ? 'downloading' : 'available',
      version: info.version,
      required: isRequiredUpdate(updateState.current, info.version, notes),
      notes: notes.replace(/\[required\]/ig, '').replace(/<[^>]+>/g, '').trim().slice(0, 600),
      percent: 0,
      manual: !canAutoInstall,
      downloadUrl: canAutoInstall ? null : macDownloadUrl(),
    });
  });
  updater.on('update-not-available', () => sendUpdateState({ status: 'idle' }));
  updater.on('download-progress', (p) => sendUpdateState({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (info) => sendUpdateState({ status: 'ready', version: info.version, percent: 100 }));
  updater.on('error', (err) => {
    console.warn('[update] ', err && err.message);
    if (process.env.CRAFT_TEST_UPDATES_LOG) { try { fs.appendFileSync(process.env.CRAFT_TEST_UPDATES_LOG, `ERROR ${err && err.message}
`); } catch {} }
    // Only surfaces when an update was actually in flight; a failed check
    // (offline, GitHub hiccup) never blocks anyone.
    if (updateState.status === 'downloading') sendUpdateState({ status: 'error', error: 'The update could not be downloaded. Check your connection and try again.' });
  });

  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, testing ? 1000 : 8000);
  setInterval(check, UPDATE_CHECK_EVERY_MS);
}

ipcMain.handle('update:get', () => updateState);
ipcMain.handle('update:retry', () => { if (updater) updater.checkForUpdates().catch(() => {}); return { ok: true }; });
ipcMain.handle('update:install', () => {
  if (updateState.manual) {
    if (updateState.downloadUrl) shell.openExternal(updateState.downloadUrl);
    return { ok: true, manual: true };
  }
  if (!updater || updateState.status !== 'ready') return { ok: false };
  // Show "Installing update..." in the app, then close, install silently and
  // relaunch on the new version. No installer window.
  sendUpdateState({ status: 'installing' });
  isQuitting = true; // let the window really close instead of hiding to the tray
  setTimeout(() => updater.quitAndInstall(true, true), 1200);
  return { ok: true };
});

// ─── Lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  loadStore();
  updateSleepBlocker();
  startRemoteServer();
  createWindow();
  createTray();
  setupAutoUpdates();
  win.webContents.once('did-finish-load', () => {
    if (pendingAuthUrl) {
      const url = pendingAuthUrl;
      pendingAuthUrl = null;
      handleAuthCallback(url);
    }
  });
  // Covers both the mac dock-icon-click convention and the (now rare, since
  // closing hides rather than destroys) case of no window existing at all.
  app.on('activate', showWindow);
});

app.on('window-all-closed', () => {
  // Reached only if a window is destroyed some way other than the hide-on-
  // close handler above (a crash, devtools forcing it, an actual quit already
  // underway) - normal "close the window" no longer gets here at all, since
  // that now hides instead of destroying it. Terminal cleanup still belongs
  // here regardless of how we got here.
  if (termProc) { try { termProc.kill(); } catch {} termProc = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  for (const client of remoteEventClients) { try { client.end(); } catch {} }
  remoteEventClients.clear();
  if (remoteServer) remoteServer.close();
  if (tray) { tray.destroy(); tray = null; }
});
