// Life Integrated Bots in the desktop app: the main-process side of the life
// context (engine: codeply-cli/lib/life.js, life-store.js, life-sources.js,
// life-triggers.js).
//
// While Craft runs (also from the tray), this keeps one picture of the user's
// day that every bot reads:
//   · Google Calendar and Gmail every 5 minutes (the same Google sign-in as
//     Connect Apps), Craft projects and their pushes every 10 minutes
//   · the window in front every 30 seconds (a small PowerShell helper on
//     Windows; private windows and password managers are never recorded)
//   · calls with bots (Crew and the phone) and calls the call helper heard,
//     with a one-call summary; what the user asks Orbit and the drop
// and every minute it looks for something worth telling the user (the
// trigger engine), then reaches them the way that fits: a desktop
// notification while they are at the PC, their phone otherwise, and always a
// note in the bot's Crew thread with Helpful / Not now / Stop these.
//
// Nothing runs until the user turns Life on in Crew (one switch, then a
// switch per source). The store is local; sensitive things (call
// transcripts) are sealed with a key Windows protects (safeStorage).
//
// main.js wires this in with init(deps); nothing here reaches into main.js.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

let deps = null;
let store = null;
let started = false;
const timers = [];
const status = { sources: {}, lastTick: 0, error: '' };

const lib = (name) => require(path.join(deps.cliDir, 'lib', name));
const LIFE = () => lib('life.js');
const SRC = () => lib('life-sources.js');
const TRIG = () => lib('life-triggers.js');
const BOTS = () => lib('bots.js');

const LIFE_DIR = path.join(os.homedir(), '.codeply', 'life');
const SETTINGS_FILE = path.join(LIFE_DIR, 'settings.json');
const KEY_FILE = path.join(LIFE_DIR, 'key.bin');

// ─── Settings ───────────────────────────────────────────────────────────────

const DEFAULTS = {
  on: false,
  // The mic and the words on screen are the most private: off until the user turns them on.
  sources: { calendar: true, gmail: true, calls: true, projects: true, activity: true, screen: false, heard: false, orbit: true, plans: true, botmail: true, slack: true, tasks: true, health: true },
  nudges: { on: true, perDay: 6, phone: true, quiet: { on: true, from: '22:00', to: '07:00' }, triggers: {}, botFor: {} },
  calls: { listen: 'ask', consentAck: false, whisperVoice: false, routeMic: false, botId: '' },
  autopilot: { paused: false },
};
let settings = JSON.parse(JSON.stringify(DEFAULTS));

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settings = {
      ...DEFAULTS, ...raw,
      sources: { ...DEFAULTS.sources, ...(raw.sources || {}) },
      nudges: { ...DEFAULTS.nudges, ...(raw.nudges || {}), quiet: { ...DEFAULTS.nudges.quiet, ...((raw.nudges && raw.nudges.quiet) || {}) } },
      calls: { ...DEFAULTS.calls, ...(raw.calls || {}) },
      autopilot: { ...DEFAULTS.autopilot, ...(raw.autopilot || {}) },
    };
  } catch {}
}
function saveSettings() {
  try {
    fs.mkdirSync(LIFE_DIR, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) { console.warn('[life] settings:', e.message); }
}
const sourceOn = (k) => settings.on && settings.sources[k] !== false;
const enabledSet = () => new Set(Object.keys(settings.sources).filter((k) => settings.sources[k] !== false));

// ─── The store and its key ──────────────────────────────────────────────────

/** A random 32-byte key, kept encrypted by Windows (safeStorage). null when the PC cannot protect it. */
function storeKey() {
  const { safeStorage } = deps;
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
  try {
    if (fs.existsSync(KEY_FILE)) return Buffer.from(safeStorage.decryptString(fs.readFileSync(KEY_FILE)), 'base64');
  } catch (e) { console.warn('[life] the store key could not be read; sensitive items stay sealed:', e.message); return null; }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(LIFE_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, safeStorage.encryptString(key.toString('base64')));
  return key;
}

// The store stays open while the app runs: the autopilot keeps its tasks,
// outbox and action log there even with Life off. The bots only see the
// life context while Life is on (attach in start, detach in stop).
function openStore() {
  if (store) return store;
  store = lib('life-store.js').openLifeStore({ key: storeKey(), modulePaths: deps.modulePaths });
  if (!store) { status.error = 'This PC has no SQLite driver, so the life context cannot be stored.'; return null; }
  return store;
}
function localTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } }

// ─── Pollers ────────────────────────────────────────────────────────────────

/** Run fn every ms (first after `first`), backing off on errors, with a status line per source. */
function every(name, ms, fn, first = 5000) {
  let failures = 0;
  let timer = null;
  const run = async () => {
    timer = null;
    if (!started) return;
    const st = status.sources[name] = status.sources[name] || {};
    try {
      st.running = true;
      const r = await fn();
      st.lastOk = Date.now(); st.error = ''; st.result = r || null;
      failures = 0;
    } catch (e) {
      failures++;
      st.error = String(e && e.message || e).slice(0, 300);
      if (failures <= 3) console.warn(`[life] ${name}:`, st.error);
    } finally { st.running = false; }
    if (started) timer = setTimeout(run, failures ? Math.min(30 * 60000, ms * 2 ** Math.min(failures, 4)) : ms);
  };
  timer = setTimeout(run, first);
  timers.push({ name, stop: () => clearTimeout(timer), poke: () => { if (timer) { clearTimeout(timer); timer = setTimeout(run, 500); } } });
}

const googleConnected = () => { const g = deps.configLib() && deps.configLib().getIntegration('gmail'); return !!(g && g.accessToken); };

async function pollCalendar() {
  if (!sourceOn('calendar') || !googleConnected()) return { skipped: true };
  const oauth = deps.oauthLib();
  const token = (force) => deps.gmailToken(force);
  const list = async (q) => {
    try { return await oauth.calendarListEvents(await token(false), q); }
    catch (e) { if (e.status !== 401) throw e; return oauth.calendarListEvents(await token(true), q); }
  };
  return SRC().syncCalendar({ store, list, life: LIFE() });
}

async function pollGmail() {
  if (!sourceOn('gmail') || !googleConnected()) return { skipped: true };
  const api = deps.gmailApi ? deps.gmailApi() : lib('mail-watch.js').gmailApi({ token: (force) => deps.gmailToken(force) });
  return SRC().syncGmail({ store, api });
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}
async function pollProjects() {
  if (!sourceOn('projects')) return { skipped: true };
  const projects = (deps.projects() || []).filter((p) => p && p.path && fs.existsSync(p.path));
  return SRC().syncProjects({ store, projects, git });
}

// ─── The window in front (Windows) ──────────────────────────────────────────
// One small PowerShell process for the life of the app: Node writes a line,
// it answers with {"app","title","idle"} for the foreground window. No
// screenshots, no keystrokes; just the process name and the window title.

const WIN_HELPER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class CraftFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
  public static uint Idle() { LII l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return ((uint)Environment.TickCount - l.dwTime) / 1000; }
}
"@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $h = [CraftFg]::GetForegroundWindow()
  $sb = New-Object Text.StringBuilder 512
  [void][CraftFg]::GetWindowText($h, $sb, 512)
  $procId = [uint32]0
  [void][CraftFg]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  $o = @{ app = $name; title = $sb.ToString(); idle = [CraftFg]::Idle() } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($o)
}
`;
let fg = null;
let fgWaiting = null;
function fgHelper() {
  if (fg) return fg;
  const file = path.join(deps.userDataDir, 'craft-life-fg.ps1');
  fs.writeFileSync(file, WIN_HELPER);
  fg = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, cwd: deps.userDataDir });
  let buf = '';
  fg.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line || !fgWaiting) continue;
      const w = fgWaiting; fgWaiting = null;
      try { w.resolve(JSON.parse(line)); } catch { w.resolve(null); }
    }
  });
  fg.on('exit', () => { fg = null; if (fgWaiting) { fgWaiting.resolve(null); fgWaiting = null; } });
  fg.stderr.on('data', () => {});
  return fg;
}
function foreground() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    if (fgWaiting) { resolve(null); return; }
    const t = setTimeout(() => { if (fgWaiting) { fgWaiting = null; resolve(null); } }, 8000);
    fgWaiting = { resolve: (v) => { clearTimeout(t); resolve(v); } };
    try { fgHelper().stdin.write('q\n'); } catch { clearTimeout(t); fgWaiting = null; resolve(null); }
  });
}

let idleSeconds = 0;
let lastFg = { s: null, at: 0 };
async function sampleActivity() {
  if (!sourceOn('activity')) return { skipped: true };
  const s = Date.now() - lastFg.at < 5000 ? lastFg.s : await foreground();
  if (!s) return { none: true };
  idleSeconds = Number(s.idle) || 0;
  store.setState('pc.idle', { seconds: idleSeconds, at: Date.now() });
  // Away from the keyboard for 5 minutes: nothing new is on screen, so nothing is recorded.
  if (idleSeconds > 300) { store.setState('activity.current', null); return { idle: idleSeconds }; }
  const r = SRC().activityTick({ store, sample: s });
  if (r.kind === 'call' && deps.onCallWindow) { try { deps.onCallWindow(store.getState('call.current')); } catch {} }
  return r;
}

// ─── The words on screen (life-screen.js: Windows' own OCR, on this PC) ─────
// Every 4 seconds a look at the window in front; its words are read the moment
// it changes (a tab looked at for a few seconds is still remembered), and every
// 2 minutes on the same one. Never a private window, a password manager, a
// call, or Craft itself.
let lastScreen = { sig: '', at: 0 };
let lastFrameAt = 0;

// The picture buffer: the last 12 different screens (one picture per window or
// tab, the newest look at it), in memory only and gone when Craft closes. A
// question about something seen a few minutes ago gets its picture at once,
// with no new screenshot. Only while "Read my screen" is on.
const FRAMES = 12;
const frames = []; // { title, at, jpeg }, oldest first
function keepFrame(label, img) {
  if (!img || img.isEmpty()) return;
  const { width } = img.getSize();
  const small = width > 1600 ? img.resize({ width: 1600, quality: 'good' }) : img;
  const i = frames.findIndex((f) => f.title === label);
  if (i >= 0) frames.splice(i, 1);
  frames.push({ title: label, at: Date.now(), jpeg: small.toJPEG(72) });
  while (frames.length > FRAMES) frames.shift();
}
const words = (t) => [...new Set(String(t || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
/** The buffer, newest first, as pictures the model can take: [{ title, at, url }]. */
function recentFrames() {
  return frames.slice().reverse().map((f) => ({ title: f.title, at: f.at, url: `data:image/jpeg;base64,${f.jpeg.toString('base64')}` }));
}
/** The buffered screen whose title best matches these words (newest wins a tie), or null. */
function findFrame(query) {
  const want = words(query);
  let best = null; let bestScore = 0;
  for (const f of recentFrames()) {
    const t = f.title.toLowerCase();
    const score = want.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}
const BROWSER_SUFFIX = / [-\u2013\u2014] (Google Chrome|Microsoft\u200b? Edge|Mozilla Firefox|Brave|Opera|Vivaldi)$/i;
async function sampleScreen() {
  if (!sourceOn('screen') || !deps.screenText) { frames.length = 0; return { skipped: true }; }
  const s = await foreground();
  if (!s) return { none: true };
  lastFg = { s, at: Date.now() };
  if (Number(s.idle) > 120) return { idle: true };
  const c = SRC().classifyWindow(s);
  if (c.kind === 'private') { store.setState('activity.screen', null); return { kind: 'private' }; }
  if (c.kind === 'none' || c.kind === 'call') return { kind: c.kind };
  if (/^(electron|codeply.*)$/i.test(String(s.app || ''))) return { kind: 'craft' };
  const app = SRC().appName(s.app);
  const title = String(s.title || '').replace(BROWSER_SUFFIX, '').trim();
  const sig = `${app}|${title}`;
  const now = Date.now();
  const label = `${app}${title ? `: ${title}` : ''}`.slice(0, 200);
  // Same window: a fresh picture every 10 s (a video plays, a page scrolls) and its words every 30 s.
  const same = sig === lastScreen.sig;
  if (same && now - lastScreen.at < 30000) {
    if (now - lastFrameAt < 10000 || !deps.screenCapture) return { same: true };
    lastFrameAt = now;
    keepFrame(label, await deps.screenCapture());
    return { frame: sig };
  }
  lastScreen = { sig, at: now };
  let text = '';
  if (deps.screenRead) {
    const r = await deps.screenRead({ title });
    keepFrame(label, r && r.img);
    lastFrameAt = now;
    text = String((r && r.text) || '').slice(0, 6000);
  } else text = String(await deps.screenText({ title }) || '').slice(0, 6000);
  if (text.replace(/\s+/g, '').length < 20) return { empty: true };
  store.setState('activity.screen', { app, title, text, at: now });
  // One item per window, updated as it changes, so the drop and the Ask box find what was on screen (kept 3 days).
  const id = `screen:${crypto.createHash('sha1').update(sig.toLowerCase()).digest('hex').slice(0, 16)}`;
  store.upsertItem({ id, source: 'screen', kind: 'screen', at: now, title: label, body: text, data: { app } });
  status.sources.screen = { ...(status.sources.screen || {}), lastOk: now, error: '' };
  return { read: sig };
}

/** What was on screen lately, newest first: [{ title, text, at }]. The drop sends the ones a question is about. */
function recentScreens(ms = 30 * 60000, limit = 12) {
  if (!store || !started || !sourceOn('screen')) return [];
  return store.items({ sources: ['screen'], from: Date.now() - ms, limit }).map((x) => ({ title: x.title, text: x.body || '', at: x.at }));
}
const atPc = () => idleSeconds < 120 && Date.now() - ((store && store.getState('pc.idle', {}) || {}).at || 0) < 2 * 60000;

// ─── Calls, Orbit, the drop (hooks from crew-main.js, bots-desktop.js, voice-mode.js, drop.js) ─

/** A finished call: a one-call summary (title, summary, people, plans, todo), then a sealed item. */
async function noteCall({ source = 'crew', botId, ms, turns, app, who }) {
  if (!started || !sourceOn('calls')) return null;
  const list = (Array.isArray(turns) ? turns : []).filter((t) => t && t.text);
  if (!list.length) return null;
  const bot = botId ? BOTS().getBot(botId) : null;
  const L = LIFE();
  let summary = null;
  try {
    const prompt = SRC().callSummaryPrompt({ turns: list, botName: bot ? bot.name : '', who, now: Date.now(), tz: localTz(), plansAsk: sourceOn('plans') ? L.plansAsk() : '' });
    const r = await lib('telemetry.js').withProduct('crew', () => deps.aiLib().chatJson([{ role: 'user', content: prompt }], { route: deps.currentRoute() }));
    if (r && r.success && r.json) summary = r.json;
  } catch (e) { console.warn('[life] call summary:', e.message); }
  const item = store.upsertItem(SRC().callItem({ source, botId, botName: bot ? bot.name : '', turns: list, ms, summary, app }));
  if (summary && Array.isArray(summary.plans) && sourceOn('plans')) L.notePlans(summary.plans, { source: 'call', botId });
  // What the user asked the assistant to handle after the call becomes a task for that bot (autopilot.js).
  const forBot = item && item.data && item.data.forBot || [];
  // Calls with a bot already did their work live; only calls the call helper heard hand work on.
  if (forBot.length && botId && deps.onTask && source === 'pc') for (const text of forBot) { try { deps.onTask({ botId, source: 'call', requester: 'user', text }); } catch {} }
  pushState('calls');
  return item;
}

function noteAsk(text, answer, via = 'orbit') {
  if (!started || !sourceOn('orbit')) return;
  const it = SRC().orbitItem({ text, answer, via });
  if (it) LIFE().note(it);
}

// ─── Nudges (the trigger engine, life-triggers.js) ──────────────────────────

let ticking = false;
async function tick() {
  if (!started || ticking) return;
  ticking = true;
  try {
    status.lastTick = Date.now();
    if (!settings.nudges.on) return;
    const T = TRIG();
    const team = BOTS().listBots();
    const snap = LIFE().snapshot({ allowed: enabledSet() });
    const due = T.due({ store, snap, settings: settings.nudges, now: Date.now(), atPc: atPc() });
    if (process.env.CODEPLY_DEBUG) console.log(`[life] tick: due ${JSON.stringify(due.map((c) => c.key))}`);
    if (!due.length) return;
    const picked = due.slice(0, 3).map((c) => ({ ...c, bot: T.chooseBot(c, team, settings.nudges) }));
    let msgs = null;
    // Messages sent as written (the morning message) need no judge call.
    if (picked.every((c) => c.verbatim)) msgs = picked.map((c) => ({ key: c.key, send: true, how: 'text', text: c.fallback }));
    if (!msgs) try {
      const prompt = T.judgePrompt(picked, snap);
      const r = await lib('telemetry.js').withProduct('crew', () => deps.aiLib().chatJson([{ role: 'user', content: prompt }], { route: deps.currentRoute() }));
      if (r && r.success && r.json) msgs = T.parseJudge(r.json, picked);
    } catch {}
    if (!msgs) msgs = picked.map((c) => ({ key: c.key, send: true, how: c.how || 'text', text: c.fallback }));
    for (const m of msgs) {
      const c = picked.find((x) => x.key === m.key);
      if (!c) continue;
      if (!m.send) { T.skip(store, c); continue; }
      await deliver(c, m);
    }
  } catch (e) {
    status.error = e.message;
    console.warn('[life] tick:', e.message);
  } finally { ticking = false; }
}

const shown = new Set(); // desktop notifications still on screen
/** One nudge: the bot's Crew thread always; a desktop notification at the PC, the phone otherwise. */
async function deliver(c, m) {
  const bot = c.bot;
  const text = String(m.text || c.fallback).slice(0, c.verbatim ? 3000 : 480);
  if (c.morning) { try { lib('morning.js').markSent(store); } catch {} }
  const how = m.how === 'call' && bot && bot.alwaysOn && bot.alwaysOn.reach === 'call' ? 'call' : 'text';
  const nudge = store.addNudge({ trigger: c.trigger, key: c.key, botId: bot ? bot.id : null, how, text });
  const msg = { kind: 'nudge', id: nudge.id, trigger: c.trigger, text, url: c.url || '', label: TRIG().TRIGGERS[c.trigger] ? TRIG().TRIGGERS[c.trigger].label : '' };
  if (bot && deps.crewThread) { try { deps.crewThread(bot.id, msg); } catch {} }
  const here = atPc();
  if (here && deps.Notification && deps.Notification.isSupported()) {
    const body = c.morning ? c.morning.summary : text;
    const n = new deps.Notification({ title: bot ? bot.name : 'Codeply', body: body.slice(0, 240), icon: deps.notifyIcon, silent: c.trigger === 'watched' });
    n.on('click', () => { if (bot) deps.openBot(bot.id); });
    // Hold on to it until it is gone: on Windows a toast whose object was collected can vanish unseen.
    shown.add(n);
    const drop = () => shown.delete(n);
    n.on('close', drop); n.on('click', drop);
    setTimeout(drop, 30 * 60000).unref?.();
    n.show();
  }
  if ((!here || how === 'call') && settings.nudges.phone !== false) {
    try {
      await deps.callFunction('reminders', { action: 'create', reminder: {
        text, due_at: new Date().toISOString(), kind: how === 'call' ? 'call' : 'remind', tz: localTz(),
        bot_id: bot ? bot.id : null, bot_name: bot ? bot.name : 'Codeply', bot_voice: (bot && bot.voice) || null,
        payload: { nudge: { id: nudge.id, trigger: c.trigger } },
      } });
    } catch (e) { if (!e.signedOut) console.warn('[life] phone:', e.message); }
  }
  store.audit({ kind: 'nudge', botId: bot ? bot.id : null, title: `${msg.label || c.trigger}: ${text.slice(0, 120)}`, verdict: 'auto', ok: true, result: here ? 'desktop' : 'phone' });
  pushState('nudges');
}

function feedback(id, verdict) {
  if (!store) return { error: 'Life is off.' };
  const v = ['helpful', 'later', 'stop'].includes(verdict) ? verdict : 'helpful';
  const n = store.nudgeFeedback(id, v);
  if (!n) return { error: 'That nudge is gone.' };
  if (v === 'stop') { settings.nudges.triggers = { ...settings.nudges.triggers, [n.trigger]: false }; saveSettings(); }
  if (v === 'later') TRIG().later(store, n);
  // The card in the bot's thread shows the answer from now on.
  if (n.botId && deps.crewThread) { try { deps.crewThread(n.botId, { kind: 'nudge', id: n.id, trigger: n.trigger, text: n.text, feedback: v }); } catch {} }
  pushState('nudges');
  return { ok: true, nudge: n };
}

// ─── The Life panel (Crew) ──────────────────────────────────────────────────

function panelState() {
  const L = LIFE();
  const counts = store ? store.sources() : {};
  const T = TRIG();
  return {
    on: settings.on, canSeal: !!(store && store.canSeal), error: status.error,
    sources: L.SOURCE_KEYS.map((k) => ({ key: k, ...L.SOURCES[k], on: settings.sources[k] !== false, count: (counts[k] || {}).count || 0, last: (status.sources[k] || {}).lastOk || (counts[k] || {}).last || 0, problem: (status.sources[k] || {}).error || '' })),
    google: googleConnected(),
    now: store && settings.on ? L.snapshot({ allowed: enabledSet() }) : null,
    nudges: { ...settings.nudges, list: store ? store.nudgesSince(Date.now() - 7 * 86400000, 30) : [], triggers: Object.entries(T.TRIGGERS).map(([k, t]) => ({ key: k, label: t.label, note: t.note, on: T.triggerOn(k, settings.nudges) })) },
    calls: settings.calls,
    autopilot: { ...settings.autopilot, ...(deps.autopilotState ? deps.autopilotState() : {}) },
    callNow: deps.callState ? deps.callState() : null,
    listen: deps.listenState ? deps.listenState() : null,
    screen: (() => { const sc = store && started && sourceOn('screen') ? store.getState('activity.screen') : null; return sc && Date.now() - sc.at < 5 * 60000 ? { app: sc.app, title: sc.title, at: sc.at } : null; })(),
    screenFrames: frames.length, // pictures in the buffer (memory only)
    heardToday: store && started ? store.items({ sources: ['heard'], from: new Date().setHours(0, 0, 0, 0), limit: 40 }).map((x) => ({ id: x.id, title: x.title, kind: x.kind, at: x.at })) : [],
    takeoverReady: deps.takeoverReady ? deps.takeoverReady() : undefined,
    platform: process.platform,
  };
}

let pushTimer = null;
function pushState() {
  if (!deps || !deps.crewEvent) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { try { deps.crewEvent({ type: 'life', state: panelState() }); } catch {} }, 400);
}

function setSettings(patch = {}) {
  const was = settings.on;
  if (typeof patch.on === 'boolean') settings.on = patch.on;
  if (patch.sources && typeof patch.sources === 'object') for (const [k, v] of Object.entries(patch.sources)) if (k in DEFAULTS.sources) settings.sources[k] = !!v;
  if (patch.nudges && typeof patch.nudges === 'object') {
    const n = patch.nudges;
    if (typeof n.on === 'boolean') settings.nudges.on = n.on;
    if (typeof n.phone === 'boolean') settings.nudges.phone = n.phone;
    if (Number.isFinite(Number(n.perDay))) settings.nudges.perDay = Math.max(0, Math.min(30, Math.round(Number(n.perDay))));
    if (n.quiet && typeof n.quiet === 'object') {
      const hh = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (typeof n.quiet.on === 'boolean') settings.nudges.quiet.on = n.quiet.on;
      if (hh.test(n.quiet.from)) settings.nudges.quiet.from = n.quiet.from;
      if (hh.test(n.quiet.to)) settings.nudges.quiet.to = n.quiet.to;
    }
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(n.briefAt || '')) settings.nudges.briefAt = n.briefAt;
    if (n.triggers && typeof n.triggers === 'object') for (const [k, v] of Object.entries(n.triggers)) if (TRIG().TRIGGERS[k]) settings.nudges.triggers[k] = !!v;
    if (n.botFor && typeof n.botFor === 'object') for (const [k, v] of Object.entries(n.botFor)) if (TRIG().TRIGGERS[k]) settings.nudges.botFor[k] = typeof v === 'string' ? v : '';
  }
  if (patch.calls && typeof patch.calls === 'object') {
    if (['ask', 'always', 'off'].includes(patch.calls.listen)) settings.calls.listen = patch.calls.listen;
    if (typeof patch.calls.consentAck === 'boolean') settings.calls.consentAck = patch.calls.consentAck;
    if (typeof patch.calls.whisperVoice === 'boolean') settings.calls.whisperVoice = patch.calls.whisperVoice;
    if (typeof patch.calls.routeMic === 'boolean') settings.calls.routeMic = patch.calls.routeMic;
    if (typeof patch.calls.botId === 'string') settings.calls.botId = patch.calls.botId.slice(0, 60);
  }
  if (patch.autopilot && typeof patch.autopilot.paused === 'boolean') settings.autopilot.paused = patch.autopilot.paused;
  // The mic only listens once the user said they tell people an assistant is listening.
  if (settings.sources.heard && !settings.calls.consentAck) settings.sources.heard = false;
  saveSettings();
  if (settings.on && !was) start();
  else if (!settings.on && was) stop();
  else if (settings.on) timers.forEach((t) => t.poke());
  if (deps.onListenChange) { try { deps.onListenChange(); } catch {} }
  return panelState();
}

function registerIpc(ipcMain) {
  const guard = (fn) => async (e, ...a) => { try { return await fn(...a); } catch (err) { console.warn('[life ipc]', err); return { error: err.message }; } };
  ipcMain.handle('crew:life:state', guard(async () => ({ ...panelState(), mail: deps.mailUsage ? await deps.mailUsage().catch(() => null) : null })));
  ipcMain.handle('crew:life:set', guard((patch) => setSettings(patch || {})));
  ipcMain.handle('crew:life:search', guard((q) => (store ? store.search(String(q || ''), { limit: 30 }).map((x) => ({ ...x, body: x.sensitive ? '' : String(x.body || '').slice(0, 300) })) : [])));
  ipcMain.handle('crew:life:items', guard((source) => (store ? store.items({ sources: [String(source)], limit: 40 }).map((x) => ({ ...x, body: '' })) : [])));
  ipcMain.handle('crew:life:forgetSource', guard((source) => { if (store) store.removeSource(String(source)); if (source === 'gmail' && store) { ['gmail.waiting', 'gmail.cursor', 'gmail.seen'].forEach((k) => store.deleteState(k)); } pushState(); return panelState(); }));
  ipcMain.handle('crew:life:forgetItem', guard((id) => { if (store) store.deleteItem(String(id)); pushState(); return { ok: true }; }));
  ipcMain.handle('crew:life:clear', guard(() => { if (store) store.clearAll(); pushState(); return panelState(); }));
  ipcMain.handle('crew:life:nudge', guard((id, verdict) => feedback(id, verdict)));
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

function start() {
  if (started || !settings.on) return;
  if (!openStore()) return;
  LIFE().attach(store, { tz: localTz(), enabled: enabledSet, onChange: (src) => pushState(src) });
  started = true;
  every('calendar', 5 * 60000, pollCalendar, 4000);
  every('gmail', 5 * 60000, pollGmail, 9000);
  every('projects', 10 * 60000, pollProjects, 15000);
  every('activity', 30000, sampleActivity, 6000);
  every('screen', 4000, sampleScreen, 7000);
  every('nudges', 60000, tick, 45000);
  every('housekeeping', 6 * 3600000, async () => store.prune(), 120000);
  pushState();
}
function stop() {
  started = false;
  while (timers.length) timers.pop().stop();
  try { if (fg) fg.kill(); } catch {}
  fg = null;
  try { if (deps.screenStop) deps.screenStop(); } catch {}
  frames.length = 0;
  try { LIFE().detach(); } catch {}
  pushState();
}

/** Something the user did that a source should see soon (Gmail connected, a project opened). */
function poke(name) { for (const t of timers) if (!name || t.name === name) t.poke(); }

function init(d) {
  deps = d;
  loadSettings();
  registerIpc(d.ipcMain);
  start();
}

module.exports = {
  init, start, stop, poke, noteCall, noteAsk, feedback,
  // the minute's look for something worth saying (the life simulation drives it, scripts/sim)
  tick,
  // for the call helper, bot mail and the autopilot
  getStore: () => store, ensureStore: () => openStore(), recentScreens, recentFrames, findFrame, isOn: () => started, status: () => status, setSettings, sourceOn, settings: () => settings, atPc, pushState, localTz,
};
