// The call helper: a bot on the user's calls, free, on this PC.
//
// When a call shows up in the window in front (Meet, Zoom, Teams, WhatsApp,
// Discord, a phone call through Phone Link; life-sources.js classifyWindow),
// a small window in the corner offers to listen (or listens straight away when
// the user chose Always and confirmed they tell people). Then:
//   · the call's sound (system audio, the other side) and the user's mic are
//     cut into utterances in that window and turned into text by Whisper in
//     its own process (voice/stt-process.js): no audio leaves the PC or is kept
//   · every 20 s of new talk, one model call (call-assist.js) adds cards with
//     what is relevant from the life context, and a whispered suggestion
//     (shown, and spoken into the user's headphones if they want)
//   · when the other side asks for the user and the user has gone quiet, or
//     the user presses Hand over, the bot offers to take the call. It speaks
//     in its own voice as the user's assistant, gives the user's excuse and
//     says goodbye; with VB-CABLE set as the call app's microphone the other
//     side hears it. Then it hangs up where the app has a key for it.
//   · at the end, the transcript (sealed) and a summary join the life context,
//     and what the user asked the assistant to handle becomes a task.
//
// main.js wires this in with init(deps); nothing here reaches into main.js.
const path = require('path');
const { BrowserWindow, screen, session, desktopCapturer, utilityProcess, ipcMain, app, globalShortcut } = require('electron');

let deps = null;
let win = null;
const S = { active: false, app: '', startedAt: 0, turns: [], cards: [], whisper: '', offered: false, dismissed: new Map(), lastAssist: 0, lastThem: 0, botId: null, takeover: null, endTimer: null, assisting: false };
const lib = (name) => require(path.join(deps.cliDir, 'lib', name));
const CA = () => lib('call-assist.js');
const BOTS = () => lib('bots.js');
const PARTITION = 'persist:craft-callhelp';
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// ─── Speech to text in its own process ──────────────────────────────────────

let stt = null;
const waiting = new Map();
function sttProc() {
  if (stt) return stt;
  const cache = deps.sttCacheDir || path.join(app.getPath('appData'), 'Codeply Crew', 'voice-models');
  stt = utilityProcess.fork(path.join(__dirname, 'voice', 'stt-process.js'), [cache], { serviceName: 'Codeply call helper' });
  stt.on('message', (m) => { if (!m || !m.id) return; const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } });
  stt.on('exit', () => { stt = null; for (const w of waiting.values()) w({ type: 'error', error: 'stopped' }); waiting.clear(); });
  return stt;
}
function transcribe(pcm) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const t = setTimeout(() => { waiting.delete(id); resolve(''); }, 60000);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m.type === 'result' ? m.text : ''); });
    sttProc().postMessage({ type: 'transcribe', id, pcm });
  });
}

// ─── The window ─────────────────────────────────────────────────────────────

function settings() { return deps.life.settings().calls; }
function userName() {
  try { const g = deps.configLib().getIntegration('gmail'); return String((g && g.name) || '').split(/\s+/)[0] || deps.userName() || ''; } catch { return deps.userName ? deps.userName() : ''; }
}
function helperBot() {
  const team = BOTS().listBots();
  const pick = settings().botId && team.find((b) => b.id === settings().botId);
  if (pick) return pick;
  return lib('life-triggers.js').chooseBot({ trigger: 'meeting' }, team, deps.life.settings().nudges) || null;
}

function view() {
  const bot = S.botId ? BOTS().getBot(S.botId) : helperBot();
  return {
    active: S.active, app: S.app, startedAt: S.startedAt, offered: S.offered && !S.active,
    turns: S.turns.slice(-30), cards: S.cards, whisper: S.whisper, takeover: S.takeover,
    bot: bot ? { id: bot.id, name: bot.name, avatar: bot.avatar } : null,
    consentAck: !!settings().consentAck, whisperVoice: !!settings().whisperVoice, routeMic: !!settings().routeMic,
    endKeys: !!CA().endCallKeys(S.app),
  };
}
function push() { if (win && !win.isDestroyed()) win.webContents.send('callhelp:state', view()); if (deps.life.pushState) deps.life.pushState('calls'); }

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  const area = screen.getPrimaryDisplay().workArea;
  const W = 380; const H = 560;
  const pos = deps.windowPos || { x: area.x + area.width - W - 16, y: area.y + area.height - H - 16 };
  win = new BrowserWindow({
    width: W, height: H, x: pos.x, y: pos.y,
    frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#0b0b0c', title: 'Call helper',
    // The bot speaks after a model call, long after the click: no gesture needed to play.
    webPreferences: { preload: path.join(__dirname, 'call-listen', 'preload.js'), contextIsolation: true, nodeIntegration: false, partition: PARTITION, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'call-listen', 'index.html'));
  win.on('closed', () => { win = null; });
  return win;
}

/** The helper window's own session: the mic, and system audio for getDisplayMedia (Windows loopback). */
function setupSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'));
  ses.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => cb(sources[0] ? { video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined } : {})).catch(() => cb({}));
  });
}

// ─── A call starts, goes, ends ──────────────────────────────────────────────

/** The life sampler saw a call window (life-desktop.js onCallWindow). */
function onCallWindow(call) {
  if (!deps || !call) return;
  const mode = settings().listen;
  if (mode === 'off') return;
  if (S.active) { S.lastSeen = Date.now(); return; }
  const key = `${call.app}:${call.since}`;
  if (S.dismissed.has(key)) return;
  S.app = call.app; S.lastSeen = Date.now();
  if (mode === 'always' && settings().consentAck) start(call.app);
  else if (!S.offered) { S.offered = true; ensureWindow().showInactive(); push(); setTimeout(push, 800); }
}

function start(appName) {
  if (S.active) return view();
  Object.assign(S, { active: true, app: appName || S.app || 'Call', startedAt: Date.now(), turns: [], cards: [], whisper: '', offered: false, lastAssist: 0, lastThem: 0, takeover: null, lastSeen: Date.now() });
  const bot = helperBot();
  S.botId = bot ? bot.id : null;
  try { sttProc().postMessage({ type: 'load' }); } catch {}
  ensureWindow().showInactive();
  if (win) win.webContents.send('callhelp:listen', true);
  clearInterval(S.endTimer);
  // The call is over when its window has been gone for 45 seconds.
  S.endTimer = setInterval(() => {
    const cur = deps.life.getStore() && deps.life.getStore().getState('call.current');
    if (cur && Date.now() - cur.seenAt < 45000) S.lastSeen = Math.max(S.lastSeen, cur.seenAt);
    if (Date.now() - S.lastSeen > 45000 && !S.takeover) stop('ended');
    else maybeAssist();
  }, 4000);
  push();
  return view();
}

async function stop(why = 'stopped') {
  if (!S.active) { S.offered = false; if (win && !win.isDestroyed()) win.hide(); return view(); }
  S.active = false;
  clearInterval(S.endTimer);
  if (win && !win.isDestroyed()) win.webContents.send('callhelp:listen', false);
  const turns = S.turns.map((t) => ({ who: t.who === 'me' ? 'user' : t.who === 'bot' ? 'bot' : 'them', text: t.text }));
  const ms = Date.now() - S.startedAt;
  if (turns.length) { try { await deps.life.noteCall({ source: 'pc', botId: S.botId, ms, turns, app: S.app }); } catch (e) { console.warn('[call helper] save:', e.message); } }
  S.dismissed.set(`${S.app}:${S.startedAt}`, Date.now());
  setTimeout(() => { if (!S.active && win && !win.isDestroyed()) win.hide(); }, why === 'ended' ? 4000 : 300);
  push();
  return view();
}

/** One utterance from the window: who said it (me / them) and its 16 kHz samples. */
async function chunk(who, pcm) {
  if (!S.active) return;
  const text = String(await transcribe(pcm) || '').trim();
  if (!text || /^(you|thank you|thanks for watching|bye)[.!?]*$/i.test(text)) return;
  const now = Date.now();
  if (who === 'me' && CA().isEcho(text, S.turns, now)) return;
  S.turns.push({ who: who === 'me' ? 'me' : 'them', text: text.slice(0, 1000), at: now });
  if (S.turns.length > 600) S.turns = S.turns.slice(-600);
  if (who !== 'me') S.lastThem = now;
  if (!S.takeover && CA().offerHandover(S.turns, { userName: userName(), now })) S.takeover = { stage: 'offer', why: 'They are asking for you.' };
  push();
}

async function maybeAssist() {
  if (!S.active || S.assisting || S.takeover && S.takeover.stage === 'speaking') return;
  if (!S.lastThem || S.lastThem <= S.lastAssist || Date.now() - S.lastAssist < 20000) return;
  S.assisting = true;
  try {
    const store = deps.life.getStore();
    const L = lib('life.js');
    const terms = CA().lookupTerms(S.turns, 6, userName());
    const hits = store ? terms.flatMap((t) => store.search(t, { limit: 3 })) : [];
    const bot = S.botId ? BOTS().getBot(S.botId) : null;
    const prompt = CA().assistPrompt({ turns: S.turns, nowBlock: L.available() ? L.nowBlock(L.snapshot({ allowed: L.allowedFor(bot) })) : '', hits, userName: userName(), botName: bot ? bot.name : '' });
    const r = await lib('telemetry.js').withProduct('crew', () => deps.aiLib().chatJson([{ role: 'user', content: prompt }], { route: deps.currentRoute() }));
    if (r && r.success && r.json) {
      const a = CA().parseAssist(r.json);
      if (a.cards.length) S.cards = [...a.cards, ...S.cards].slice(0, 8);
      if (a.whisper && a.whisper !== S.whisper) {
        S.whisper = a.whisper;
        if (settings().whisperVoice) speak(a.whisper, 'headphones');
      }
      push();
    }
  } catch (e) { console.warn('[call helper] assist:', e.message); } finally { S.lastAssist = Date.now(); S.assisting = false; }
}

// ─── Taking the call over ───────────────────────────────────────────────────

async function speak(text, where) {
  const bot = S.botId ? BOTS().getBot(S.botId) : null;
  try {
    const voice = deps.voiceLib();
    const r = await voice.speak(text, { engine: bot && bot.voice ? voice.engineOf(bot.voice) : 'edge', voice: (bot && bot.voice) || '', botId: bot ? bot.id : '', serverToken: deps.serverToken, offline: true });
    if (win && !win.isDestroyed()) win.webContents.send('callhelp:audio', { mime: r.mime, data: r.data, where, text });
  } catch (e) {
    if (win && !win.isDestroyed()) win.webContents.send('callhelp:audio', { error: e.message, where, text });
  }
}

async function takeover() {
  if (!S.active) return view();
  const bot = S.botId ? BOTS().getBot(S.botId) : helperBot();
  if (!bot) return { error: 'Make a bot in Crew first.' };
  S.takeover = { stage: 'speaking', text: '' };
  push();
  let say = '';
  try {
    const r = await lib('telemetry.js').withProduct('crew', () => deps.aiLib().chatJson([{ role: 'user', content: CA().takeoverPrompt({ bot, turns: S.turns, userName: userName(), callStyle: bot.callStyle }) }], { route: deps.currentRoute() }));
    say = r && r.success && r.json && typeof r.json.say === 'string' ? r.json.say : '';
  } catch {}
  // It must say who it is; if the model left that out, the plain version goes.
  if (!say || !new RegExp(`\\b${bot.name}\\b`, 'i').test(say) || !/assistant/i.test(say)) say = CA().fallbackTakeover({ bot, userName: userName(), callStyle: bot.callStyle });
  say = say.replace(/\s*\u2014\s*/g, ', ');
  S.takeover = { stage: 'speaking', text: say };
  S.turns.push({ who: 'bot', text: say, at: Date.now() });
  push();
  await speak(say, 'call');
  if (deps.audit) deps.audit({ kind: 'action', botId: bot.id, tool: 'call_takeover', title: `Took over a ${S.app} call`, detail: say, verdict: 'you asked', ok: true });
  return view();
}

/** After the bot spoke: hang up where the app has a key for it, else ask the user to. */
async function endCall() {
  const keys = CA().endCallKeys(S.app);
  let done = false;
  if (keys && deps.act && deps.act.supported && deps.act.supported()) {
    try { for (const k of keys) { await deps.act.keys(k); await new Promise((r) => setTimeout(r, 400)); } done = true; } catch (e) { console.warn('[call helper] hang up:', e.message); }
  }
  S.takeover = { stage: 'done', text: S.takeover ? S.takeover.text : '', hungUp: done };
  push();
  setTimeout(() => stop('ended'), 1500);
  return view();
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(`callhelp:${ch}`, async (e, ...a) => { try { return await fn(...a); } catch (err) { return { error: err.message }; } });
  h('state', () => view());
  h('start', () => {
    if (!settings().consentAck) return { error: 'First confirm you will tell the other person an assistant is listening.' };
    return start(S.app);
  });
  h('consent', (on) => { deps.life.setSettings({ calls: { consentAck: !!on } }); return view(); });
  h('stop', () => stop('stopped'));
  h('dismiss', () => { S.offered = false; S.dismissed.set(`${S.app}:${Date.now()}`, Date.now()); const cur = deps.life.getStore() && deps.life.getStore().getState('call.current'); if (cur) S.dismissed.set(`${cur.app}:${cur.since}`, Date.now()); if (win) win.hide(); return view(); });
  h('handover', () => { if (!S.active) return view(); S.takeover = { stage: 'offer', why: 'You asked.' }; push(); return view(); });
  h('takeover', () => takeover());
  h('notNow', () => { S.takeover = null; push(); return view(); });
  h('endCall', () => endCall());
  h('settings', (patch) => { const p = patch || {}; deps.life.setSettings({ calls: { ...(typeof p.whisperVoice === 'boolean' ? { whisperVoice: p.whisperVoice } : {}), ...(typeof p.routeMic === 'boolean' ? { routeMic: p.routeMic } : {}) } }); return view(); });
  // Crew's Life page: listen to a call the PC did not spot (a phone on speaker, an app it does not know).
  ipcMain.handle('crew:life:listenNow', async () => {
    if (!settings().consentAck) return { error: 'First confirm, on the Life page, that you tell people an assistant is listening.' };
    start(S.app || 'Call');
    return deps.life.setSettings({});
  });
  ipcMain.on('callhelp:chunk', (e, { who, pcm }) => { chunk(who, pcm).catch(() => {}); });
  ipcMain.on('callhelp:close', () => { if (win) win.hide(); });
}

function init(d) {
  deps = d;
  setupSession();
  registerIpc();
  // Hand over from anywhere: Alt+Shift+H.
  try { globalShortcut.register('Alt+Shift+H', () => { if (S.active) { S.takeover = { stage: 'offer', why: 'You asked.' }; ensureWindow().showInactive(); push(); } }); } catch {}
}

function stopAll() { if (S.active) stop('stopped'); S.takeover = null; }
const state = () => ({ active: S.active, app: S.app, startedAt: S.startedAt });
/** A bot can speak into the call when VB-CABLE is installed (the window checks its audio devices). */
let cable = undefined;
ipcMain.on('callhelp:devices', (e, d) => { cable = !!(d && d.cable); });

module.exports = { init, onCallWindow, start, stop, chunk, takeover, endCall, stopAll, state, takeoverReady: () => cable, view };
