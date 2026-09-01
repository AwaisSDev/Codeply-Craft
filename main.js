/**
 * Codeply Craft — Electron main process.
 *
 * The AI engine is NOT reimplemented here: it is the exact agent loop the
 * Codeply CLI ships (codeply-cli/lib/agent.mjs + ai.js + tools.mjs), bundled
 * into this app under ./codeply-cli (see the CLI_DIR resolution below — a
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
const { pathToFileURL } = require('url');
const { execSync } = require('child_process');
const QRCode = require('qrcode');
// Loads a local, gitignored .env for the OAuth app credentials below (see
// .env.example) — a no-op in a packaged build with no .env shipped alongside
// it, so this only ever affects a from-source dev run.
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── CLI engine location ────────────────────────────────────────────────────
// The engine is bundled INSIDE this app now (./codeply-cli), not loaded from
// a sibling checkout next to it — a packaged install has no such sibling, so
// that layout only ever worked from this repo's own source tree.
//
// codeply-cli is copied in via `extraResources` (see the build config), NOT
// packed into app.asar with the rest of this app's own code — on purpose,
// for two independent reasons that both point the same way:
//   1. electron-builder's asar packing runs its own dependency-pruning over
//      any node_modules it finds, keyed off THIS package's own dependency
//      tree. codeply-cli/node_modules is a separate package's dependencies,
//      unrelated to that tree, and got silently dropped when it was left
//      for that step to pick up — extraResources is a plain recursive copy,
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
let configLib = null;     // CJS: config.js
let applyLimitLib = null; // CJS: apply-limit.js — the same 100/day cap the CLI and desktop app share
let skillsLib = null;     // CJS: skills.js
let routerLib = null;     // CJS: model-router.js — task-based model routing
let aiLib = null;         // CJS: ai.js — used directly by Task Maker for its own planning call
let oauthLib = null;      // CJS: oauth-connectors.js — Gmail/Slack OAuth + real API calls
let subagentsLib = null;  // CJS: subagents.js — the 8 named specialist personas

async function loadEngine() {
  if (agentMod) return true;
  const agentPath = path.join(CLI_DIR, 'lib', 'agent.mjs');
  if (!fs.existsSync(agentPath)) return false;

  // Electron 29 bundles Node 20, which has no global WebSocket (that only
  // landed in Node 21+) — Supabase's client reaches for it during
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
  applyLimitLib = require(path.join(CLI_DIR, 'lib', 'apply-limit.js'));
  skillsLib = require(path.join(CLI_DIR, 'lib', 'skills.js'));
  routerLib = require(path.join(CLI_DIR, 'lib', 'model-router.js'));
  oauthLib = require(path.join(CLI_DIR, 'lib', 'oauth-connectors.js'));
  aiLib = require(path.join(CLI_DIR, 'lib', 'ai.js'));
  subagentsLib = require(path.join(CLI_DIR, 'lib', 'subagents.js'));
  agentMod = await import(pathToFileURL(agentPath).href);
  return true;
}

// ─── Session store ──────────────────────────────────────────────────────────
// One JSON file in userData. Each session keeps the renderer-facing message
// list (user / assistant / tool rows) — the model-facing history is rebuilt
// from the user+assistant rows on each send.

let storePath = null;
let store = { sessions: [], projects: [], lastProject: null };

function loadStore() {
  storePath = path.join(app.getPath('userData'), 'craft-store.json');
  try { store = { ...store, ...JSON.parse(fs.readFileSync(storePath, 'utf8')) }; } catch {}

  // Migration: a stored `autoRouting: false` is always stale. No current code
  // path writes it — it survives only from an older build that had an
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
  try { fs.writeFileSync(storePath, JSON.stringify(store), 'utf8'); } catch {}
}

// ─── Chat history — Supabase-backed (chat_sessions table), not local-only ──
// The local craft-store.json above stays as a same-device cache (so a chat
// mid-run doesn't hang on a network hiccup), but the DB is authoritative:
// loadSessionsFromDb() overwrites store.sessions on every login, so a
// different account signed into the same machine never sees a previous
// account's chats, and deleting the account (auth.users row) cascades to
// delete every chat_sessions row via its FK — nothing lingers locally once
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
 * points saveStore() already persists a session mutation locally — a few
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

// Fired once, right after a brand-new session's first turn finishes — swaps
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
    }], { maxTokens: 20 });
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
    subagentId: s.subagentId || null, parentSessionId: s.parentSessionId || null,
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
// every other way the app can end (OS shutdown, mac Cmd+Q, ...) — so the
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
  // Surface renderer problems in the terminal — a silent white/empty pane is
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
  // keeps serving the remote server) after you walk away from the desktop —
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
// redirect URI — that's the one already whitelisted in the Supabase
// project's auth settings, so a second/different scheme here would just
// fail at the provider. (If both apps are installed, whichever registered
// the protocol most recently wins the deep link — an accepted limitation of
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
  const cfg = configLib.getConfig();
  let user = null;
  try {
    const session = await authLib.getSession();
    if (session) user = { email: session.user.email };
  } catch {}

  let onboarding = null;
  if (user) onboarding = await getOnboardingProfile();

  // Chat history is sourced from Supabase, not the local cache file, every
  // time the app boots signed in — so a different account on this same
  // machine (or the same account after deleting and recreating it) never
  // sees a previous account's chats. Signed-out just clears the list.
  await loadSessionsFromDb(user ? await getLoggedInUserId() : null);

  return {
    engineOk: true,
    user,
    provider: cfg.provider,
    providerLabel: configLib.describeProviderShort(cfg),
    needsLogin: !user,
    needsOnboarding: !!user && !!onboarding && (!onboarding.referral_source || !onboarding.country),
    onboarding,
    usage: cfg.provider === 'codeply' ? await getUsage() : null,
    sessions: store.sessions.map(sessionMeta).sort((a, b) => b.updatedAt - a.updatedAt),
    projects: store.projects,
    lastProject: store.lastProject,
    lastProjectBranch: store.lastProject ? gitBranch(store.lastProject) : null,
  };
});

// ─── Auth (same Supabase project + ~/.codeply session as the CLI/desktop app,
// same account, same sign-in/sign-up/onboarding flow as the Codeply desktop
// app — see Codeply-App/main.js's auth:sign-in-email / auth:sign-up-email /
// auth:verify-otp / profile:get for the implementation this mirrors) ────────

/** Humanizes Supabase auth errors — same phrasing as the desktop app. */
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

/** Humanizes errors for the emailed 6-digit code step. */
function formatOtpError(raw) {
  let msg = typeof raw === 'string' ? raw : (raw?.message || raw?.msg || '');
  try { const p = JSON.parse(msg); msg = p.msg || p.message || msg; } catch {}
  const lower = String(msg).toLowerCase();
  if (lower.includes('expired')) return 'That code has expired. Request a fresh one.';
  if (lower.includes('rate') || lower.includes('too many') || lower.includes('seconds')) {
    return 'Please wait a moment before requesting another code.';
  }
  if (lower.includes('invalid') || lower.includes('token') || lower.includes('otp')) {
    return 'Incorrect code. Double-check the 6 digits and try again.';
  }
  return msg || 'Could not verify the code. Try again.';
}

async function getLoggedInUserId() {
  try {
    const session = await authLib.getSession();
    return session?.user?.id || null;
  } catch { return null; }
}

/** referral_source + country from the shared `profiles` row — same table, same columns, same gating-per-account the desktop app uses (see Codeply-App/supabase/referral_source.sql + country.sql). */
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
// a fresh 6-digit code. Not signed in until that code is verified.
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
  const code = String(token || '').replace(/\s+/g, '');
  if (!email || !code) return { ok: false, error: 'Enter the 6-digit code we emailed you.' };
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
  try { await authLib.getClient().auth.signOut(); } catch {}
  // Otherwise the next account signed in on this machine would see this
  // account's chats until the next full app:init (e.g. a restart).
  store.sessions = [];
  return { ok: true };
});

// Re-pulls chat history from Supabase for whoever is signed in right now —
// called after a fresh login/signup (afterVerified in app.js), since
// app:init only runs once at boot and won't otherwise notice an account
// switch mid-session.
ipcMain.handle('sessions:refresh', async () => {
  await loadSessionsFromDb(await getLoggedInUserId());
  return store.sessions.map(sessionMeta).sort((a, b) => b.updatedAt - a.updatedAt);
});

// ─── Usage (shared daily cap — same account, same 100/day bucket the CLI and
// desktop app already write to: one apply_history table, one RPC. Reusing
// apply-limit.js directly rather than re-querying Supabase here means all
// three surfaces are reading and enforcing off the literal same code path,
// not three separately-maintained copies of the same 100 number.) ──────────

async function getUsage() {
  try {
    const r = await applyLimitLib.checkApplyLimit();
    return { count: r.count || 0, limit: r.limit || 100, allowed: r.allowed !== false, tier: r.tier || 'free' };
  } catch {
    return { count: 0, limit: 100, allowed: true, tier: 'free' };
  }
}

ipcMain.handle('usage:get', () => getUsage());

// ─── Skills — the same 282-skill library the CLI's agent already searches
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

// ─── Auto routing ───────────────────────────────────────────────────────────
// This is the only mode — no picker, no other options. Auto means Ollama's
// Gemma 4 31B drives the whole turn (see model-router.js's WRITER), with a
// free Gemma 4 26B (OpenRouter) doing occasional design-planning help on the
// side. If a real BYOK provider is configured in ~/.codeply/config.json
// (same file `codeply provider <name> --key <key>` writes), Auto respects
// it instead — see model-router.js's effectiveWriter — but that's a config
// file edit, not something surfaced as an in-app picker.
function autoRoutingOn() {
  return store.autoRouting !== false; // default on for a fresh install
}

// ─── Gmail / Slack integrations (real OAuth via the system browser) ───────
// Desktop OAuth per RFC 8252: open the consent screen in the user's actual
// system browser (never an embedded webview — that's exactly what providers
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

// App-wide OAuth app credentials (one registration covers every user — they
// each still do their own one-time browser sign-in). client_id is public by
// design; client_secret can't truly be kept secret in a shipped desktop app
// either way, so this follows the same accepted tradeoff Google/Slack ship
// for "installed apps" rather than standing up a token-exchange proxy. That
// tradeoff is about a COMPILED binary, though — it does not extend to
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
// vercel.com/integrations/<slug>) — required to start the install flow; the
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
 * param from the one request that lands on `port` — or rejects on timeout /
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
    // exchange (see buildSlackAuthUrl's user_scope) — present whenever the
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
    configLib.saveIntegration('github', { accessToken: tokens.access_token, userName });
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

// ─── Browser check — the agent's own "open it and look" tool ───────────────
// This is what makes browser_check (agent.mjs/tools.mjs) real instead of
// theoretical: a genuine embedded Chromium view (a BrowserView docked into
// Craft's own window — no Puppeteer/Playwright, no separate OS window) that
// loads whatever page the agent just built or edited and reports back
// console errors, failed requests, broken images, and the visible text. The
// CLI has no such view to hand tools.mjs, which is exactly why ctx.browser
// is optional — this is the one thing only the desktop app can provide.

const PANEL_WIDTH_RATIO = 0.45;
const TITLEBAR_HEIGHT = 36;

let checkerView = null;
let checkerCollector = null; // { errors:[], warnings:[] } for whichever check is in flight
let panelVisible = false;

// The address bar / back / forward / refresh strip lives in Craft's own HTML
// (index.html's #browserChrome), not inside the BrowserView — a BrowserView
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
    // of what's actually on it — real signal from the checked page, not it.
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
  checkerView.setBounds({
    x: width - panelWidth, y: top,
    width: panelWidth, height: height - top,
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
// browser's address bar does — but a local file check still needs an exact
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
// can't cross-contaminate each other's console/network capture — the shared
// hidden window can only look at one page at a time anyway, same as a human
// only has one tab in front of them.
let browserCheckQueue = Promise.resolve();
function browserCheck(url, opts) {
  const run = browserCheckQueue.then(() => doBrowserCheck(url, opts));
  browserCheckQueue = run.catch(() => {});
  return run;
}

async function doBrowserCheck(url, { wait = 700 } = {}) {
  getCheckerView();
  showCheckerPanel(); // auto-opens the panel so the user can watch it work, without stealing focus off the chat
  if (win && !win.isDestroyed()) win.webContents.send('browserpanel:url', { url });
  const wc = checkerView.webContents;
  const failedRequests = [];

  wc.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (details.statusCode >= 400) {
      failedRequests.push(`HTTP ${details.statusCode} — ${details.url}`);
    }
  });
  wc.session.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
    if (details.error && details.error !== 'net::ERR_ABORTED') {
      failedRequests.push(`${details.error} — ${details.url}`);
    }
  });

  checkerCollector = { errors: [], warnings: [] };

  // Cache-busting: this view's own isolated partition (see getCheckerView
  // above), so clearing it has zero effect on the app's own session — but
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
    // bypassCache: true belt-and-suspenders on top of the clearCache() above —
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
      return {
        title: document.title || '',
        text: (document.body ? document.body.innerText : '').trim(),
        brokenImages: imgs,
      };
    })()`);
  } catch {}

  let screenshotPath = null;
  let screenshotDataUrl = null;
  try {
    const image = await wc.capturePage();
    const png = image.toPNG();
    const dir = path.join(app.getPath('userData'), 'browser-checks');
    fs.mkdirSync(dir, { recursive: true });
    screenshotPath = path.join(dir, `check-${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, png);
    // The same buffer, as a data: URL — this is what actually lets the model
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

// Drops a folder from the sidebar's Projects list ONLY — nothing on disk is
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

// ─── Subagents ──────────────────────────────────────────────────────────────
// The 8 named specialists (lib/subagents.js) a chat can be pinned to. Mascot
// art ships at assets/agents/<mascot> and is loaded straight off disk by the
// renderer (index.html is itself loaded via file://, so a plain relative
// <img src> works with no IPC round-trip needed for the image bytes).
ipcMain.handle('subagents:list', async () => {
  const ok = await loadEngine();
  return ok ? subagentsLib.listSubagentsMeta() : [];
});

ipcMain.handle('session:setSubagent', (e, { id, subagentId }) => {
  const session = store.sessions.find((s) => s.id === id);
  if (!session) return { ok: false };
  session.subagentId = subagentId || null;
  saveStore();
  sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
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
// `WWW-Authenticate: Bearer` header) — it used to work keyless, so this
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
      description: 'Codeply Craft desktop app — in-app image picker',
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
    // Cached credentials may have been revoked/expired server-side — register
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

const activeRuns = new Map();        // sessionId -> { signal }

// Dispatched specialists run unattended (bypass mode, see dispatchToSpecialist
// below) — there's no human approving each step to naturally pace them, so
// two of them working the same project at once could step on each other's
// file edits or git state. Only one dispatched specialist's actual turn runs
// at a time; a second dispatch waits its turn instead of racing the first.
// The main/coordinator chat itself is never gated by this — only sessions
// with a parentSessionId (i.e. spawned via dispatch_agent) queue here.
let specialistLockTail = Promise.resolve();
function runExclusive(fn) {
  const result = specialistLockTail.then(fn, fn);
  specialistLockTail = result.catch(() => {});
  return result;
}

// Keeps the machine from auto-sleeping mid-run — a long agent task (several
// minutes of tool calls) getting killed by Windows' own sleep timer would be
// a much worse failure than the small battery/idle cost of blocking it. This
// only blocks system SLEEP, not the display turning off, and only for as
// long as at least one run is actually active — the moment the last one
// finishes, sleep behaves completely normally again. It does NOT make the
// app reachable while the PC is actually off or fully asleep already — a
// local desktop process can't run without the machine being on; that would
// need the agent to execute somewhere else entirely (a server/cloud sandbox),
// which is a real architecture change, not a setting to flip here.
let sleepBlockerId = null;
function updateSleepBlocker() {
  if (activeRuns.size > 0) {
    if (sleepBlockerId === null || !powerSaveBlocker.isStarted(sleepBlockerId)) {
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

// A native OS notification when a run finishes — only while the window
// isn't the focused, frontmost thing (if you're actively watching it work,
// you already know it's done; the notification is for when you've tabbed
// away). Clicking it brings the window back and focuses it, nothing more —
// it doesn't need to jump to the specific chat since restoring the app
// already lands wherever that chat was left open.
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

// Matches the wording ai.js already returns when every configured provider/
// account has said no — rate limited, over quota, revoked, out of credit —
// rather than a one-off transient error. Those already come back as a real,
// clear error string; the gap reported was that going quiet with nothing but
// an easy-to-miss inline note reads the same as the app being stuck, since
// there's nothing that reaches you if you're not staring at the window.
const PROVIDER_EXHAUSTED_RE = /rate limit|too many requests|quota|insufficient|billing|payment required|exceed|out of credit|both ollama accounts were tried|daily .* (limit|cap)/i;

function notifyProviderExhausted(session, message) {
  if (!Notification.isSupported() || !win || win.isDestroyed() || win.isFocused()) return;
  const notification = new Notification({
    title: 'Codeply Craft — out of juice',
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

const pendingApprovals = new Map();  // requestId -> resolve(verdict)
const pendingImagePicks = new Map(); // requestId -> resolve(verdict)
let approvalCounter = 0;

// ─── Phone companion (local-network Dispatch + Remote Control) ────────────
// The phone never gets filesystem credentials or a direct shell. It talks to
// this small, pairing-protected HTTP bridge; agent work still runs inside this
// Electron process with the exact same approval gate as the desktop UI.
const REMOTE_PORT = 45671;
let remoteServer = null;
let remotePairCode = null;
const remoteTokens = new Map(); // token -> paired desktop identity
const remoteEventClients = new Set();

// A 4-digit code is only safe to type over the network because of the two
// things below it, not on its own — 10,000 possibilities is nothing against
// an unthrottled guesser on the same Wi-Fi, and a successful guess hands over
// the exact same remote control this app's own approval gate exists to
// protect. See the /api/pair handler for the lockout this backs, and
// PAIR_LOCKOUT_MS/PAIR_MAX_ATTEMPTS just below it for the actual numbers.
function makePairCode() { return String(crypto.randomInt(0, 10000)).padStart(4, '0'); }
function localAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}
// The QR encodes the pairing URL WITH the code already in it
// (?code=1234) — mobile.js reads that query param on load and submits
// pairing itself, so scanning is the entire flow: no address or code ever
// gets typed. Regenerated on every call (cheap) rather than cached, since
// it must always reflect the current code — including right after a
// lockout rotates it.
//
// PNG data URL, not inline SVG: the qrcode package's SVG output draws each
// row of modules as one STROKED path (horizontal segments joined end to
// end), and Chromium's SVG rasterizer doesn't always honor
// shape-rendering="crispEdges" on those stroke joins at the scale this
// renders at — the result was genuinely blurred, rounded-off modules
// instead of crisp squares, not just a cosmetic nitpick. A PNG has no join
// geometry to get wrong: every module is a real filled pixel block. Baked
// at 4x the display size (440 for a 110px box) so it also holds up on a
// HiDPI display, where the renderer would otherwise upscale a 1x source.
async function remoteInfo() {
  if (!remotePairCode) remotePairCode = makePairCode();
  const url = `http://${localAddress()}:${REMOTE_PORT}`;
  const qr = await QRCode.toDataURL(`${url}/?code=${remotePairCode}`, {
    // margin is in QR MODULES, not pixels — the spec's quiet zone is 4
    // modules on every side, and a phone camera actually relies on that
    // blank border to find the code at all. The previous margin: 1 was
    // below that floor, which is exactly the kind of thing that scans fine
    // up close in good light and unreliably everywhere else.
    margin: 4, width: 440, color: { dark: '#0a0a0d', light: '#ffffff' },
  });
  return { url, code: remotePairCode, port: REMOTE_PORT, qr };
}
function remoteAuthorized(req, url) {
  const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return remoteTokens.has(header || url.searchParams.get('token'));
}
async function remoteAccount() {
  const ok = await loadEngine();
  if (!ok) return { email: 'Local Craft', signedIn: false };
  try {
    const session = await authLib.getSession();
    if (session?.user) return { email: session.user.email, signedIn: true, id: session.user.id };
  } catch {}
  return { email: 'Local Craft', signedIn: false };
}
function remoteJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function broadcastRemote(sessionId, event) {
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
// Brute-force protection for the 4-digit code above. Not per-IP (this is a
// single desktop pairing gate, not a multi-tenant API) — a flat counter is
// enough: 5 wrong codes locks pairing out entirely for 30s AND rotates the
// code, so a guesser who was getting warm loses that progress too, not just
// the account whose 4-digit code they were trying.
const PAIR_MAX_ATTEMPTS = 5;
const PAIR_LOCKOUT_MS = 30_000;
let pairFailCount = 0;
let pairLockedUntil = 0;

function startRemoteServer() {
  if (remoteServer) return;
  remotePairCode = makePairCode();
  remoteServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(__dirname, 'mobile.html')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/mobile.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'mobile.css')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/mobile.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'mobile.js')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      return fs.createReadStream(path.join(__dirname, 'mobile.manifest.json')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/logo.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return fs.createReadStream(path.join(__dirname, 'logo.png')).pipe(res);
    }
    if (req.method === 'GET' && /^\/agent-mascots\/[a-z]+\.png$/.test(url.pathname)) {
      const file = path.basename(url.pathname);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(path.join(__dirname, 'assets', 'agents', file)).pipe(res);
    }
    try {
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        if (Date.now() < pairLockedUntil) {
          const waitSec = Math.ceil((pairLockedUntil - Date.now()) / 1000);
          return remoteJson(res, 429, { error: `Too many wrong codes. Try again in ${waitSec}s.` });
        }
        const body = await readRemoteBody(req);
        if (String(body.code || '').trim() !== remotePairCode) {
          pairFailCount++;
          if (pairFailCount >= PAIR_MAX_ATTEMPTS) {
            pairLockedUntil = Date.now() + PAIR_LOCKOUT_MS;
            pairFailCount = 0;
            // Rotates the code on lockout, not just after it expires — a
            // guesser who was closing in loses that progress too, and the
            // desktop's own pairing screen re-reads remoteInfo() so it shows
            // the new code next time it's asked, no restart needed.
            remotePairCode = makePairCode();
            return remoteJson(res, 429, { error: `Too many wrong codes. Locked for ${Math.round(PAIR_LOCKOUT_MS / 1000)}s.` });
          }
          return remoteJson(res, 401, { error: 'That pairing code is not valid.' });
        }
        pairFailCount = 0;
        const token = crypto.randomBytes(32).toString('base64url');
        const account = await remoteAccount();
        remoteTokens.set(token, account);
        return remoteJson(res, 200, { token, device: os.hostname(), account });
      }
      if (!remoteAuthorized(req, url)) return remoteJson(res, 401, { error: 'Pair this phone with Craft first.' });
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
        const engineOk = await loadEngine();
        return remoteJson(res, 200, {
          device: os.hostname(), projects: store.projects, lastProject: store.lastProject,
          sessions: store.sessions.map(sessionMeta), activeSessionIds: [...activeRuns.keys()], account: remoteTokens.get(token) || await remoteAccount(),
          subagents: engineOk ? subagentsLib.listSubagentsMeta() : [],
          activeAgents: activeAgentsList(),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const session = store.sessions.find((s) => s.id === url.searchParams.get('id'));
        return remoteJson(res, session ? 200 : 404, session || { error: 'Session not found.' });
      }
      // Serves a browser_check screenshot saved to disk (see the report
      // built in browserCheck() above) — the phone can't load a
      // file:///C:/... path itself the way the desktop app can, so a
      // reopened chat's past screenshots need an actual HTTP route. Scoped
      // strictly to the app's own browser-checks folder so a crafted path
      // can't walk out to an arbitrary file on the machine.
      if (req.method === 'GET' && url.pathname === '/api/screenshot') {
        const checksDir = path.join(app.getPath('userData'), 'browser-checks');
        const resolved = path.resolve(checksDir, path.basename(url.searchParams.get('path') || ''));
        if (!resolved.startsWith(checksDir) || !fs.existsSync(resolved)) {
          return remoteJson(res, 404, { error: 'Screenshot not found.' });
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return fs.createReadStream(resolved).pipe(res);
      }
      // Same searchImages() the desktop's own image-pick card calls via IPC
      // (images:search) — the phone gets the identical Openverse/Wikimedia
      // results, just over HTTP instead of IPC.
      if (req.method === 'GET' && url.pathname === '/api/images/search') {
        return remoteJson(res, 200, await searchImages(url.searchParams.get('q') || ''));
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        remoteEventClients.add(res);
        // Mobile carriers/Wi-Fi APs and Android's own network stack often
        // kill an idle SSE socket after ~30-60s with no traffic — a comment
        // ping keeps bytes flowing without the client mistaking it for a
        // real event, so the connection survives long silent stretches
        // between messages instead of dying and only reconnecting (dropping
        // whatever streamed while it was down) the next time the app polls.
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); remoteEventClients.delete(res); }
        }, 20000);
        req.on('close', () => { clearInterval(heartbeat); remoteEventClients.delete(res); });
        return;
      }
      const body = await readRemoteBody(req);
      if (req.method === 'POST' && url.pathname === '/api/send') return remoteJson(res, 200, await startChatRun(body));
      if (req.method === 'POST' && url.pathname === '/api/stop') { stopChatRun(body.sessionId); return remoteJson(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/approval') { respondApproval(body.requestId, body.verdict); return remoteJson(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/image-pick') { respondImagePick(body.requestId, body.chosenUrl); return remoteJson(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/session/rename') {
        const session = store.sessions.find((s) => s.id === body.sessionId);
        if (!session) return remoteJson(res, 404, { error: 'Session not found.' });
        const title = String(body.title || '').trim();
        if (!title) return remoteJson(res, 400, { error: 'Title cannot be empty.' });
        session.title = title;
        saveStore();
        renameSessionInDb(session.id, title);
        sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
        return remoteJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/session/delete') {
        store.sessions = store.sessions.filter((s) => s.id !== body.sessionId);
        saveStore();
        deleteSessionFromDb(body.sessionId);
        sendEvent(body.sessionId, { type: 'session_deleted', sessionId: body.sessionId });
        return remoteJson(res, 200, { ok: true });
      }
      return remoteJson(res, 404, { error: 'Not found.' });
    } catch (err) { return remoteJson(res, 400, { error: err.message || 'Request failed.' }); }
  });
  remoteServer.on('error', (err) => {
    console.error('Phone companion server failed to start:', err.message);
    remoteServer = null;
    if (err.code === 'EADDRINUSE' && win && !win.isDestroyed()) {
      win.webContents.send('remote:server-error', {
        message: `Port ${REMOTE_PORT} is already in use. Close any other running copy of Craft and reopen this dialog.`,
      });
    }
  });
  remoteServer.listen(REMOTE_PORT, '0.0.0.0');
}

function sendEvent(sessionId, event) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', { sessionId, ...event });
  broadcastRemote(sessionId, event);
}

const MAX_HISTORY_IMAGES = 4;

/**
 * Model-facing history: alternating prose turns, most recent first served.
 * Carries forward a bounded number of the most recent pasted images too —
 * without this, a follow-up like "what was in the image I sent?" has
 * nothing to answer from, since the model only ever saw that image on the
 * turn it was pasted. Only the last few images are re-included (not every
 * one ever pasted in the conversation), since each carried-forward image
 * re-uploads its full payload on every later model call for the rest of the
 * chat otherwise — unbounded, that cost only grows.
 */
function buildHistory(session) {
  const turns = [];
  for (const m of session.messages) {
    if (m.kind === 'user') {
      turns.push({ role: 'user', content: m.text, images: m.images || null });
    } else if (m.kind === 'assistant' && m.text) {
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') last.content += '\n\n' + m.text;
      else turns.push({ role: 'assistant', content: m.text });
    }
  }
  const kept = turns.slice(-20);

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

// ─── Task Maker ─────────────────────────────────────────────────────────────
// Fully automatic, not a toggle: a message that visibly bundles more than one
// distinct ask ("change this color and this font here, then on the next page
// change the padding to 5px") gets split into an ordered checklist and worked
// through one item at a time — its own step budget per item, its own fresh
// hallucination/skill checks — with history threaded forward so later tasks
// see what earlier ones actually did. A plain single-ask message never pays
// for any of this; see looksMultiPart() below for the (cheap, local) gate
// that decides whether it's even worth asking the model to split it.

const MAX_TASKS = 10;

// Classifying every single message would mean an extra model call on every
// send, most of which are a single ask ("fix this bug") with nothing to
// split. This is a local, free pre-filter: only bother asking the model to
// split a message when it already looks like it's carrying more than one
// instruction — an explicit connector word, or multiple imperative-looking
// clauses separated by punctuation/line breaks. A false negative here just
// means that message runs as a normal single turn (always correct, if not
// maximally granular); a false positive costs one extra classification call
// that comes back with a single task and falls through to the same normal
// single turn. Neither failure mode breaks anything.
const MULTI_PART_CONNECTORS = /\b(and then|then\s|also\s|next page|next[,:]|after that|once (that'?s )?done|additionally|as well as|first[, ].*then\b)/i;
function looksMultiPart(text) {
  if (text.length < 20) return false;
  if (MULTI_PART_CONNECTORS.test(text)) return true;
  const clauses = text.split(/\n+|;|(?<=[a-z0-9])\.\s+(?=[A-Z])|\d+[.)]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
  return clauses.length >= 2;
}

/**
 * One classification-only call (no tools, no file access) that turns the raw
 * request into a concrete ordered checklist, or hands back a single task
 * unchanged when the request turns out to really be just one thing (the
 * local pre-filter above is a cheap heuristic, not a guarantee — this is the
 * real decision). Mirrors routerLib.planTurn in spirit — pure "what should
 * happen" decided up front — but this one talks to the model because
 * splitting a request into concrete steps isn't something a keyword
 * heuristic can do reliably on its own.
 */
async function planTaskList(text, route) {
  const prompt = `A user sent this message to a coding agent. Decide whether it actually contains more than one distinct, separately actionable instruction (e.g. "change the button color to blue and make the heading font bigger, then on the settings page increase the padding to 5px" is 3 tasks; "fix the login bug" is 1 task — do not invent extra tasks that were not asked for).

If it's genuinely more than one, break it into an ordered checklist. Each task must be specific enough to act on by itself (name the file/element/change) AND have a concrete, checkable deliverable — a file written or changed, a feature that now works. Never emit a standalone task that is just reading, exploring, or "understanding" the code (e.g. "read index.html, app.js, and server.js to understand the structure") — that has no way to know when it's actually done, so the agent executing it just keeps re-reading indefinitely instead of finishing. Reading whatever files a task needs is something the agent already does automatically as the first step of THAT task; fold it in, never split it out on its own. If it's really just one task, return exactly one task that is the request itself, worded the same way. Use at most ${MAX_TASKS} tasks.

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
 * the renderer/session the same way the single-turn path always has. Used
 * both for a normal (non-Task-Maker) send and for each item in a Task Maker
 * checklist, so the two paths behave identically at the per-turn level —
 * Task Maker only adds the planning call and the sequencing around this.
 *
 * @returns {{status:'done'|'error'|'aborted', madeAnyEdit:boolean, replyText:string}}
 */
// session.subagentId is the user's own MANUAL choice from the picker chip:
// null ('Auto', the default) or 'general' both mean no specialist is pinned,
// and any other value pins one specialist for the whole chat. Only a manual
// pin ever lets a turn answer AS that specialist directly — an unpinned
// ('Auto') turn always runs as the coordinator (persona null) now, full
// stop, regardless of what the message is about. This used to also
// auto-detect a specialist per message from its own text (subagents.js's
// detectSpecialist) and color THAT SAME turn with it, which is exactly the
// bug this replaced: asking about a security review made the main chat
// itself become Warden and start editing files inline, instead of staying
// Codeply and dispatching Warden as an independent background session. The
// coordinator's own COORDINATOR_RULES (agent.mjs) is what decides who to
// dispatch to now, not a keyword match before the model even sees the text.
function effectiveSubagentId(session, text) {
  if (session.subagentId === 'general') return null;
  if (session.subagentId) return session.subagentId;
  return null;
}

// Shows and persists the mascot badge for whoever is about to answer — the
// top-level turn itself (subagentId from a manual pin, or Codeply the
// coordinator when nothing's pinned), or a NAMED nested delegation the model spawned mid-turn via the generic
// subagent tool ("have Warden review this"). Without the second case, a
// delegation to a named specialist changed how the reply was written but
// never showed a trace of it — the badge only ever appeared for whichever
// persona happened to be running the top-level turn (usually General),
// even when the actual work was done by Pixel underneath it.
function emitSubagentBadge(session, subagentId) {
  const specialist = subagentId && subagentsLib.getSubagent(subagentId);
  const badge = specialist
    ? { id: specialist.id, name: specialist.name, tagline: specialist.tagline, color: specialist.color, mascot: specialist.mascot }
    : { id: 'general', name: 'Codeply', tagline: 'General purpose', color: '', mascot: 'general.png' };
  sendEvent(session.id, { type: 'subagent_active', ...badge });
  // Persisted as a real message, not just a live event — otherwise the
  // badge only ever existed for the device that was open during the run
  // and vanished the moment the chat was reopened or the app restarted.
  session.messages.push({ kind: 'subagent_active', ...badge, at: Date.now() });
}

async function runOneTurn({ session, userMessage, images, history, mode, cwd, approve, signal, route, subagentId }) {
  let status = 'error';
  let madeAnyEdit = false;
  let replyText = '';
  // Fired once, right at the top of this turn (before the model even starts
  // replying) — whether subagentId came from a manual pin or from
  // detectSpecialist() in subagents.js, the point is the same: the user
  // should see WHO is answering, not just have the persona silently steer
  // the prompt with no visible trace. No match (or an explicit General/off
  // pick) still gets its own badge rather than showing nothing — every turn
  // has an answerer, even when that answerer is just Codeply itself.
  emitSubagentBadge(session, subagentId);
  try {
    const run = agentMod.runAgent({
      userMessage, history, mode: mode || 'Build', cwd, approve, browser: browserCheck, images, signal, route, subagentId,
      // Only the specific "a named specialist's nested run just started"
      // moment is used here — see emitSubagentBadge above. Every other
      // subagent progress event (generic delegations, step-by-step
      // updates) is intentionally left unsurfaced for now: streaming a
      // second live sub-transcript into this same chat is a bigger UI
      // question than just "show the badge," and not what was asked for.
      onSubagentEvent: (sub) => {
        if (sub.type === 'start' && sub.specialistId) emitSubagentBadge(session, sub.specialistId);
      },
      dispatchAgent: (subagentIdToDispatch, task) => dispatchToSpecialist(session, subagentIdToDispatch, task),
      stopAgent: (subagentIdToStop, index) => stopAgentByOrdinal(subagentIdToStop, index),
    });
    for await (const ev of run) {
      if (ev.type === 'text') {
        session.messages.push({ kind: 'assistant', text: ev.text, at: Date.now() });
        replyText += (replyText ? '\n\n' : '') + ev.text;
      } else if (ev.type === 'reasoning') {
        session.messages.push({ kind: 'reasoning', text: ev.text, ms: ev.ms, at: Date.now() });
      } else if (ev.type === 'tool_end') {
        const persistedArgs = ev.args && ev.name === 'write_file' ? { path: ev.args.path } : ev.args;
        session.messages.push({
          kind: 'tool', name: ev.name,
          label: ev.summary || ev.args?.path || ev.args?.command || ev.args?.pattern || '',
          ok: ev.ok, args: persistedArgs, at: Date.now(),
          screenshotPath: ev.meta?.screenshotPath || undefined,
        });
      }
      session.updatedAt = Date.now();
      // A chatViaProxy() trial-cap rejection (see codeply-cli/lib/ai.js) carries
      // this marker prefix through agent.mjs's error text unchanged — catch it
      // here so the renderer shows the locked-plan screen, not a generic toast.
      if (ev.type === 'error' && typeof ev.error === 'string' && ev.error.startsWith('TRIAL_LIMIT_REACHED: ')) {
        sendEvent(session.id, { type: 'trial_limit_reached', message: ev.error.slice('TRIAL_LIMIT_REACHED: '.length) });
      } else {
        if (ev.type === 'error' && typeof ev.error === 'string' && PROVIDER_EXHAUSTED_RE.test(ev.error)) {
          notifyProviderExhausted(session, ev.error);
        }
        sendEvent(session.id, ev);
      }
      sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
      if (ev.type === 'done') { status = 'done'; madeAnyEdit = !!ev.madeAnyEdit; break; }
      if (ev.type === 'error') { status = 'error'; break; }
      if (ev.type === 'aborted') { status = 'aborted'; break; }
    }
  } catch (err) {
    sendEvent(session.id, { type: 'error', error: err.message });
    session.messages.push({ kind: 'assistant', text: `Something went wrong: ${err.message}`, at: Date.now() });
    status = 'error';
  }
  return { status, madeAnyEdit, replyText };
}

/**
 * Entry point for every text-only Build-mode send. Decides for itself whether
 * this message needs splitting: the local looksMultiPart() pre-filter first
 * (skips the classification call entirely for an obvious single ask), then —
 * only if that looked promising — one real classification call that makes
 * the actual call, including "no, this is genuinely one task." Anything less
 * than 2 real tasks runs as a normal single turn with no checklist shown;
 * nothing about a plain single-ask message changes from before this existed.
 */
async function runTaskMaker({ session, originalMessage, history, mode, cwd, approve, signal, route, forceClassify = false }) {
  if (!forceClassify && !looksMultiPart(originalMessage)) {
    await runOneTurn({ session, userMessage: originalMessage, images: undefined, history, mode, cwd, approve, signal, route, subagentId: effectiveSubagentId(session, originalMessage) });
    return;
  }

  const plan = await planTaskList(originalMessage, route);
  if (!plan.ok || plan.tasks.length < 2) {
    if (!plan.ok) {
      sendEvent(session.id, { type: 'helper_note', label: 'Task Maker', why: `Could not check this for multiple tasks (${plan.error}). Continuing as a single run.`, failed: true });
    }
    await runOneTurn({ session, userMessage: originalMessage, images: undefined, history, mode, cwd, approve, signal, route, subagentId: effectiveSubagentId(session, originalMessage) });
    return;
  }

  const tasks = plan.tasks.map((t, i) => ({ id: i + 1, text: t, status: 'pending' }));
  const tasklistMsg = { kind: 'tasklist', tasks: tasks.map((t) => ({ ...t })), at: Date.now() };
  session.messages.push(tasklistMsg);
  session.updatedAt = Date.now();
  sendEvent(session.id, { type: 'tasklist', tasks: tasklistMsg.tasks });
  sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });

  let runHistory = history;
  let anyEdits = false;
  let anyFailed = false;

  for (const task of tasks) {
    if (signal.aborted) {
      task.status = 'skipped';
      tasklistMsg.tasks = tasks.map((t) => ({ ...t }));
      sendEvent(session.id, { type: 'task_end', id: task.id, status: 'skipped' });
      continue;
    }

    task.status = 'in_progress';
    tasklistMsg.tasks = tasks.map((t) => ({ ...t }));
    sendEvent(session.id, { type: 'task_start', id: task.id, text: task.text });
    sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });

    const priorSummary = tasks
      .filter((t) => t.id < task.id && t.status === 'done')
      .map((t) => `- ${t.text}`).join('\n');
    const taskMessage = `You are working through a checklist for this overall request: "${originalMessage}"\n\n` +
      (priorSummary ? `Already completed:\n${priorSummary}\n\n` : '') +
      `Do this task now:\n${task.text}`;

    const result = await runOneTurn({ session, userMessage: taskMessage, images: undefined, history: runHistory, mode, cwd, approve, signal, route, subagentId: effectiveSubagentId(session, task.text) });

    if (result.status === 'aborted') {
      task.status = 'skipped';
      tasklistMsg.tasks = tasks.map((t) => ({ ...t }));
      sendEvent(session.id, { type: 'task_end', id: task.id, status: 'skipped' });
      break;
    }

    if (result.status === 'done') {
      task.status = result.madeAnyEdit ? 'done' : 'done-no-changes';
      if (result.madeAnyEdit) anyEdits = true;
      // Thread this task's own turn into history so the NEXT task's runAgent
      // call sees what actually happened — not just the original request.
      runHistory = [...runHistory, { role: 'user', content: taskMessage }, { role: 'assistant', content: result.replyText || '(no reply text)' }];
    } else {
      task.status = 'failed';
      anyFailed = true;
    }

    tasklistMsg.tasks = tasks.map((t) => ({ ...t }));
    sendEvent(session.id, { type: 'task_end', id: task.id, status: task.status });
    session.updatedAt = Date.now();
    sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
  }

  // Final verification pass: force one more turn that browser_checks
  // everything touched across the whole checklist and fixes anything wrong,
  // instead of trusting that the last task's own turn happened to check
  // everything. Skipped if nothing was actually edited (nothing to verify)
  // or the run was stopped/aborted partway through.
  if (anyEdits && !signal.aborted) {
    const verifyMessage = 'All checklist tasks above are finished. Now verify the actual result: browser_check every page you touched or that could have been affected across all of the tasks above, look at the screenshot each check returns, and fix anything that is visibly wrong or reports an error — repeat until clean. Then give a short final summary of what was done overall.';
    await runOneTurn({ session, userMessage: verifyMessage, images: undefined, history: runHistory, mode, cwd, approve, signal, route, subagentId: effectiveSubagentId(session, originalMessage) });
  } else if (anyFailed) {
    session.messages.push({
      kind: 'assistant',
      text: `Finished the checklist with ${tasks.filter((t) => t.status === 'failed').length} task(s) that failed. See above for details.`,
      at: Date.now(),
    });
  }
}

// Cross-references activeRuns (which only has session ids) against
// store.sessions to get each active run's specialist and title — the one
// shared shape both the desktop dashboard and the phone's Agent View sheet
// render from (see broadcastAgentStatus below and /api/bootstrap's
// activeAgents field).
function activeAgentsList() {
  const active = [];
  for (const id of activeRuns.keys()) {
    const s = store.sessions.find((x) => x.id === id);
    if (s) active.push({ sessionId: s.id, subagentId: s.subagentId || null, title: s.title });
  }
  return active;
}

// Drives the Agent View dashboard — not scoped to one chat's event channel
// like sendEvent, since the dashboard isn't tied to any single session.
// Reaches both the desktop window (IPC) and any paired phone (SSE, same
// broadcastRemote every other cross-device event already goes through) —
// a phone open to a specialist's chat needs to know it finished exactly the
// same way the desktop's own Agent View tab does.
function broadcastAgentStatus() {
  const active = activeAgentsList();
  if (win && !win.isDestroyed()) win.webContents.send('agents:status', active);
  broadcastRemote(null, { type: 'agents_status', active });
}

/**
 * The fire-and-forget half of dispatch_agent (codeply-cli/lib/tools.mjs) —
 * threaded into the agent's ctx as ctx.dispatchAgent, same as ctx.approve/
 * ctx.browser are already host-provided capabilities (see agent.mjs's ctx
 * object). Starts a brand-new session pinned to the given specialist and
 * kicks off its own run via the exact same path a real user message takes
 * (startChatRun), then returns immediately — startChatRun already does its
 * real work in a detached IIFE it never awaits, so this doesn't either.
 *
 * Always bypass: nobody is watching this session to answer an approval card
 * — the user is in the main chat or a different specialist's view — so a
 * permission prompt here would just hang forever instead of ever being seen.
 */
async function dispatchToSpecialist(parentSession, subagentId, task) {
  const result = await startChatRun({
    sessionId: null,
    cwd: parentSession.cwd,
    mode: 'Build',
    bypass: true,
    text: task,
    subagentId,
    parentSessionId: parentSession.id,
  });
  if (result.error) throw new Error(result.error);
  return { sessionId: result.sessionId };
}

/**
 * The other half of the coordinator's control surface — "kill the pixel
 * agent" in plain chat, or the stop icon in Agent View, both end up here.
 * `index` is 1-based among that specialist's currently ACTIVE sessions,
 * oldest first (so "pixel agent 1" means the first one that started, not an
 * arbitrary id the user was never shown) — matches how Agent View lists them.
 */
function stopAgentByOrdinal(subagentId, index = 1) {
  const active = store.sessions
    .filter((s) => s.subagentId === subagentId && activeRuns.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  const target = active[index - 1];
  if (!target) return { ok: false, error: `No active session found for that specialist${index > 1 ? ` (#${index})` : ''}.` };
  stopChatRun(target.id);
  return { ok: true, title: target.title, sessionId: target.id };
}

/** First ~220 chars, cut at a word boundary — the parent chat gets a summary, not the dispatched specialist's full report (that stays in its own session). */
function truncateSummary(text, max = 220) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + '…';
}

async function startChatRun({ sessionId, cwd, mode, bypass, text, images, clientId = null, subagentId, parentSessionId = null }) {
  text = String(text || '').trim();
  images = Array.isArray(images) ? images : undefined;
  if (!text && !images?.length) return { error: 'Write a task before sending it.' };
  const ok = await loadEngine();
  if (!ok) return { error: 'Engine not available.' };
  if (!cwd || !fs.existsSync(cwd)) return { error: 'Pick a project folder first.' };

  let session = sessionId ? store.sessions.find((s) => s.id === sessionId) : null;
  if (!session) {
    session = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: text.length > 46 ? text.slice(0, 46) + '…' : text,
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      alwaysAllowed: [],
      subagentId: subagentId || null,
      parentSessionId: parentSessionId || null,
    };
    store.sessions.unshift(session);
  } else if (subagentId !== undefined) {
    // Sticks for the rest of the chat once set, same as cwd — but a client
    // that doesn't know about specialists (an older mobile build) omits the
    // field entirely rather than sending null, so it never accidentally
    // clears a specialist chosen from the desktop.
    session.subagentId = subagentId || null;
  }
  if (activeRuns.has(session.id)) return { error: 'A run is already in progress for this chat.' };

  rememberProject(cwd);
  const history = buildHistory(session);
  // images are kept on the session record purely so reopening this chat
  // later still shows what was pasted — buildHistory() above deliberately
  // never re-includes them in the MODEL-facing history for later turns
  // (that would re-upload the same base64 payload, growing, on every
  // subsequent message of the whole conversation).
  session.messages.push({ kind: 'user', text, images: images?.length ? images : undefined, at: Date.now() });
  session.updatedAt = Date.now();
  session.cwd = cwd;
  saveStore();
  syncSessionToDb(session);
  sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session), message: session.messages.at(-1), origin: clientId });

  // A real AbortController, not a plain {aborted:false} flag — fetch() (used
  // for every provider's HTTP call in ai.js) only actually cancels an
  // in-flight request when handed a genuine AbortSignal. The old plain-object
  // version let the loop notice a stop between steps, but did nothing about a
  // request already in flight, which is why Stop used to take up to ~20s: it
  // was just waiting for the current generation to finish on its own.
  const abortController = new AbortController();
  const signal = abortController.signal;

  // Which helpers (if any) this turn needs is decided once, here, from what
  // the user actually sent — pure classification, no I/O yet. The writer
  // routerLib picks (Ollama's Gemma 4 31B by default, or the user's own BYOK
  // provider/model when ~/.codeply/config.json names one — see
  // model-router.js's effectiveWriter) is what actually runs the turn either
  // way, images included; the design helper just decides whether one narrow
  // planning call runs before it. Only applies when the user hasn't pinned a
  // model — a pinned pick means stored config wins and `plan` stays null, so
  // ai.js's applyRoute is a no-op.
  // Returned with the handler's result rather than pushed as an agent event:
  // for a brand-new chat the renderer doesn't know this session's id yet (it
  // learns it from this very return value), so an event sent now would be
  // dropped by its `data.sessionId === state.currentSessionId` filter.
  const plan = autoRoutingOn() ? routerLib.planTurn(text, !!(images && images.length)) : null;
  // Scoped to this chat, not this run: "Always allow" persists across every
  // message sent in this session (loaded from and written back to the
  // session record itself), until the chat is deleted. fetch_image is
  // excluded — it never offers an "always allow" (the picker below has no
  // such button, on purpose: every image is a different pick, unlike "trust
  // every future write"), so a stale 'fetch_image' entry from an older
  // session (back when it still used a plain approval card) is dropped here
  // rather than silently continuing to skip the picker.
  if (!Array.isArray(session.alwaysAllowed)) session.alwaysAllowed = [];
  const hadStaleImageEntry = session.alwaysAllowed.includes('fetch_image');
  session.alwaysAllowed = session.alwaysAllowed.filter((t) => t !== 'fetch_image');
  if (hadStaleImageEntry) saveStore();
  const alwaysAllowed = new Set(session.alwaysAllowed);
  activeRuns.set(session.id, { signal, abortController });
  updateSleepBlocker();
  broadcastAgentStatus();

  const approve = async (req) => {
    if (signal.aborted) return 'reject';
    if (bypass || (req.tool !== 'fetch_image' && alwaysAllowed.has(req.tool))) {
      sendEvent(session.id, { type: 'approval_auto', tool: req.tool, title: req.title, bypass: !!bypass });
      return 'once';
    }

    // fetch_image gets a picker instead of a plain accept/reject card: the
    // user searches and clicks a real photo rather than trusting whatever
    // the model auto-picked. Unattended runs (bypass/always-allow, handled
    // above) skip straight past this and keep the model's own pick.
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
        pendingImagePicks.set(id, (chosenUrl) => {
          pendingImagePicks.delete(id);
          // Same reasoning as approval_resolved below: whichever device
          // (desktop or phone) didn't answer this needs to be told it's
          // done, or its picker sheet is left showing a request that
          // already went through with nothing left to ever dismiss it.
          sendEvent(session.id, { type: 'image_pick_resolved', requestId: id });
          resolve(chosenUrl ? { action: 'once', url: chosenUrl } : 'reject');
        });
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
      pendingApprovals.set(id, (verdict) => {
        pendingApprovals.delete(id);
        if (verdict === 'always') {
          alwaysAllowed.add(req.tool);
          session.alwaysAllowed = Array.from(alwaysAllowed);
          saveStore();
          syncSessionToDb(session);
        }
        // Whichever device answers this (phone or desktop), every OTHER
        // device showing the same approval card needs to be told it's
        // resolved — otherwise the one that didn't answer it is left
        // showing a request that already went through, with nothing left
        // to ever dismiss it.
        sendEvent(session.id, { type: 'approval_resolved', requestId: id, verdict });
        resolve(verdict === 'reject' ? 'reject' : verdict);
      });
    });
  };

  (async () => {
    try {
      // Helper calls happen here, not before the handler's early return above
      // — they're real network I/O (an extra helper call), and the renderer
      // shouldn't wait on them before it gets a session id back. Each note is
      // pushed as its own event so the chat shows "Codeply Design planned the
      // design" before the writer's own turn starts, like a tool row would.
      let turnMessage = text;
      let turnImages = images;
      let route = null;
      if (plan) {
        route = plan.writer;
        const prepared = await routerLib.runHelpers(plan, text, images);
        turnMessage = prepared.message;
        turnImages = prepared.images;
        for (const note of prepared.notes) {
          sendEvent(session.id, { type: 'helper_note', label: note.label, why: note.why, failed: !!note.failed });
        }
      }

      // Auto-detected, not opt-in: only text-only Build-mode sends are even
      // candidates (Plan/Ask are single coherent answers, not a to-do list;
      // an image belongs in one coherent turn the writer can look at, not
      // split across a to-do list). runTaskMaker() itself decides
      // whether the message actually needs splitting — most sends fall
      // straight through to the exact same single runOneTurn() as always.
      // looksMultiPart()'s local pre-filter is tuned for casual human phrasing
      // ("do this and then that") — a dispatch_agent task is a dense,
      // structured brief the COORDINATOR wrote, which routinely bundles
      // several concrete asks without ever using those connector words. Skip
      // the heuristic and always ask the model to classify for those, so a
      // genuinely multi-part specialist brief still gets a real checklist.
      const runTurn = (mode || 'Build') === 'Build' && !turnImages?.length
        ? () => runTaskMaker({ session, originalMessage: turnMessage, history, mode, cwd, approve, signal, route, forceClassify: !!session.parentSessionId })
        : () => runOneTurn({ session, userMessage: turnMessage, images: turnImages, history, mode, cwd, approve, signal, route, subagentId: effectiveSubagentId(session, turnMessage) });

      // Dispatched specialists (parentSessionId set) queue behind whichever
      // one is currently running — see runExclusive above. The main chat
      // never waits on this.
      if (session.parentSessionId) {
        await runExclusive(async () => { if (!signal.aborted) await runTurn(); });
      } else {
        await runTurn();
      }
    } catch (err) {
      sendEvent(session.id, { type: 'error', error: err.message });
      session.messages.push({ kind: 'assistant', text: `Something went wrong: ${err.message}`, at: Date.now() });
    } finally {
      activeRuns.delete(session.id);
      updateSleepBlocker();
      broadcastAgentStatus();
      saveStore();
      syncSessionToDb(session);
      sendEvent(session.id, { type: 'run_finished' });
      sendEvent(session.id, { type: 'session_sync', session: sessionMeta(session) });
      // This session was dispatched from another chat (dispatch_agent) — a
      // deliberately EPHEMERAL working session, not a permanent chat: once
      // it's done (finished or killed), it reports a summary back to the
      // parent that dispatched it and then deletes itself. The parent's
      // summary line is the only lasting trace — nothing to dig through in
      // Recents/Agent View afterward, since there's no session left to open.
      if (session.parentSessionId) {
        const parent = store.sessions.find((s) => s.id === session.parentSessionId);
        if (parent) {
          const lastReply = [...session.messages].reverse().find((m) => m.kind === 'assistant')?.text;
          const specialistName = subagentsLib.getSubagent(session.subagentId)?.name || 'A specialist';
          // signal.aborted distinguishes a real finish from a kill (the stop
          // button, or the coordinator's own stop_agent tool) — both land in
          // this same finally block, but they're not the same news for the
          // parent chat to report.
          const summary = signal.aborted
            ? `**${specialistName}** was stopped before finishing.`
            : lastReply
              ? `**${specialistName}** finished: ${truncateSummary(lastReply)}`
              : `**${specialistName}** finished its work.`;
          parent.messages.push({ kind: 'assistant', text: summary, at: Date.now() });
          parent.updatedAt = Date.now();
          saveStore();
          syncSessionToDb(parent);
          sendEvent(parent.id, { type: 'text', text: summary });
          sendEvent(parent.id, { type: 'session_sync', session: sessionMeta(parent) });
        }
        // Tell any renderer that might currently have this session open
        // (someone clicked into it from Agent View while it was still
        // running) before it's gone, then delete the record itself.
        sendEvent(session.id, { type: 'session_deleted', parentSessionId: session.parentSessionId });
        deleteSessionRecord(session.id);
      } else {
        notifyTaskComplete(session);
        if (session.messages.filter((m) => m.kind === 'user').length === 1) {
          generateSessionTitle(session);
        }
      }
      // Writes made during the run may have moved the shared daily counter.
      if (configLib.getConfig().provider === 'codeply') {
        getUsage().then((usage) => sendEvent(session.id, { type: 'usage_update', usage }));
      }
    }
  })();

  return {
    sessionId: session.id,
    title: session.title,
    // Writer is always known synchronously (planTurn does no I/O); which
    // helpers actually ran/succeeded arrives later as 'helper_note' events,
    // since that requires the real helper call to come back first.
    route: plan ? { label: plan.writer.label } : null,
  };
}

function stopChatRun(sessionId) {
  const run = activeRuns.get(sessionId);
  if (run) run.abortController.abort();
  // A pending approval (or image pick) blocks the loop from noticing the
  // abort until it resolves — reject/cancel both so it notices immediately.
  for (const [, resolve] of pendingApprovals) resolve('reject');
  for (const [, resolve] of pendingImagePicks) resolve(null);
}

function respondApproval(requestId, verdict) {
  const resolve = pendingApprovals.get(requestId);
  if (resolve) resolve(verdict);
}
function respondImagePick(requestId, chosenUrl) {
  const resolve = pendingImagePicks.get(requestId);
  if (resolve) resolve(chosenUrl || null);
}

ipcMain.handle('chat:send', (e, payload) => startChatRun(payload));
ipcMain.handle('remote:info', () => remoteInfo());

ipcMain.on('chat:stop', (e, sessionId) => {
  stopChatRun(sessionId);
});

ipcMain.on('approval:respond', (e, { requestId, verdict }) => {
  respondApproval(requestId, verdict);
});

ipcMain.on('imagepick:respond', (e, { requestId, chosenUrl }) => {
  const resolve = pendingImagePicks.get(requestId);
  if (resolve) resolve(chosenUrl || null);
});

ipcMain.handle('shell:openPath', (e, p) => shell.openPath(p));

// ─── Embedded terminal ──────────────────────────────────────────────────────
// Not a real pty (node-pty needs a native rebuild against Electron's ABI, and
// there's no Visual Studio toolchain available here to do that) — instead a
// plain child_process running the user's own shell, with its stdio piped over
// IPC into an xterm.js view. This still runs as the user: same PATH, same git
// credential helper, same gh/ssh auth already on disk, no separate login.
// The one real cost is no true pty — full-screen TUI programs (vim, htop, a
// nested REPL that redraws in place) won't render right, but that's not what
// this is for; ordinary commands (git, npm, gh) work fine piped.
const { spawn } = require('child_process');
const os = require('os');

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

// ─── Lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  loadStore();
  startRemoteServer();
  createWindow();
  createTray();
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
  // underway) — normal "close the window" no longer gets here at all, since
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
