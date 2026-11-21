// The top bar: a thin rounded line resting at the top center of the main
// screen, like the phone's home indicator, always there and never a word on it.
//
// It's one shape that changes. A task running makes it breathe. Orbit
// (voice-mode.js) tells it what it's doing: while you talk the line turns into
// a live waveform, it shimmers while Orbit thinks and waves calmly while it
// answers. ping() is a note (a reply drafted, the morning message sent, a task
// done): the line glows, grows into a small card with the message for a few
// seconds and shrinks back; clicking the card grows it on into the chat. A
// click on the line grows it into the chat too: when the shape lands, the
// drop's real window (drop.js, hanging from the top) shows at exactly that spot
// and the shape steps aside. When the chat closes (a click elsewhere, Escape)
// the shape comes back at the chat's size and shrinks into the line.
//
// It never takes focus, never shows in the taskbar, and is kept out of screen
// captures, so Orbit and the drop never see it in their screenshots. The page
// (island/) only talks through islandApi; see island/island.js for the messages.
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const drop = require('./drop');

// The window: as wide as the chat plus its shadow. At rest it's only tall
// enough for the line and a message card; just before the shape grows into the
// chat the page asks for more ('size'), and gives it back after. Empty it's
// see-through, and Windows lets clicks fall through see-through pixels.
const WIN_W = 400;
const REST_H = 100;
const MAX_H = 760;
const TOP = 8;         // the line's top edge (island.css): the chat starts exactly there, as the line (drop.css)
const isMac = process.platform === 'darwin';

let host = null;       // functions from main.js (see init)
let win = null;
let quitting = false;
let winH = REST_H;
const S = {
  voice: 'idle',       // Orbit: idle | listening | thinking | speaking | teaching
  runs: [],            // chats with a task running, oldest first
  attached: false,     // the drop is up under the bar
  under: false,        // an app in front covers the top of the screen: the line fades
  pings: new Map(),    // id -> onClick, for pings the page hasn't finished with
  waiting: [],         // pings sent before the page loaded
  seq: 0,
  open: null,          // what to open once the shape has grown into the chat
  closedAt: 0,         // when the drop last went away from under the bar
};

const hidden = () => !!(host && host.getSetting('islandHidden') === true);
const alive = () => !!(win && !win.isDestroyed());

function send(type, data) {
  if (!alive() || win.webContents.isLoading()) return false;
  win.webContents.send('island:to', { type, data });
  return true;
}

function stateView() {
  const newest = S.runs[S.runs.length - 1];
  const title = newest ? (host.titleOf && host.titleOf(newest)) || 'Working' : '';
  return { voice: S.voice, running: S.runs.length, title, attached: S.attached, covered: S.attached, chat: drop.size(), under: S.under };
}

// ─── An app over the top of the screen: the line fades away ──────────────────
// A window in front that reaches up to where the line sits (a maximized or
// fullscreen app) hides it; the spot still takes a click and the line comes
// back on hover, for Orbit and for pings. The desktop itself doesn't count.
const WATCH_MS = 1500;
let watchTimer = null;
let watching = false;
async function watchFront() {
  if (watching || !alive() || hidden() || !win.isVisible()) return;
  watching = true;
  try {
    const act = require('./voice/act');
    if (!act.supported()) return;
    const w = await act.frontWindow();
    const a = area();
    const cx = a.x + a.width / 2;
    const desktop = !w || (/^explorer$/i.test(w.app) && (!w.title || /^program manager$/i.test(w.title)));
    const mine = w && /^(electron|codeply)/i.test(w.app); // the drop or the main window: not "an app over it"
    const over = !desktop && !mine && w.bounds.y <= a.y + TOP && w.bounds.x <= cx && w.bounds.x + w.bounds.width >= cx && w.bounds.height > a.height / 2;
    if (over !== S.under) { S.under = over; render(); }
  } catch {} finally { watching = false; }
}
function startWatch() { if (!watchTimer) watchTimer = setInterval(watchFront, WATCH_MS); }
const render = () => send('state', stateView());

// ─── Where it sits: top center of the main screen's work area ───────────────
function area() { return screen.getPrimaryDisplay().workArea; }
const leftOf = (a) => Math.round(a.x + (a.width - WIN_W) / 2);

function place() {
  if (!alive()) return;
  const a = area();
  win.setBounds({ x: leftOf(a), y: a.y, width: WIN_W, height: winH });
  // The drop follows the bar it hangs from.
  if (drop.isUnderBar()) drop.showUnder(under(), { focus: false });
}

/** Where the drop goes when it opens from the bar: its top edge and its center (where the shape lands). */
function under() {
  const a = area();
  return { cx: Math.round(a.x + a.width / 2), y: a.y + TOP };
}

function create() {
  const a = area();
  winH = REST_H;
  win = new BrowserWindow({
    width: WIN_W, height: winH, x: leftOf(a), y: a.y,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, show: false,
    alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'island', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) {
    win.setVisibleOnAllWorkspaces(true);
    // Windows lets clicks fall through fully transparent pixels, so only the line
    // and the card catch them. A Mac doesn't: there the window ignores the mouse
    // until it's over one of them (the page says so through 'hover').
    win.setIgnoreMouseEvents(true, { forward: true });
  }
  // Never in a screenshot: Orbit's, the drop's or Life's.
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, 'island', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => {
    render();
    for (const p of S.waiting.splice(0)) send('ping', p);
    if (!hidden()) win.showInactive();
  });
  win.on('close', (e) => { if (!quitting) e.preventDefault(); });
  win.on('closed', () => { win = null; });
}

function apply() {
  if (hidden()) {
    if (alive()) win.hide();
    if (S.attached) drop.hide();
    return;
  }
  if (!alive()) { create(); return; } // shows itself once loaded
  place();
  if (!win.isVisible()) win.showInactive();
}

// ─── The chat the shape grows into ───────────────────────────────────────────
/** Open the drop under the bar, on one chat or as it was. */
function openChat(sessionId) {
  if (!sessionId) { drop.showUnder(under()); return; }
  drop.openChat(sessionId, hidden() ? null : under());
}

// The shape landed: show the drop there, or (a ping's click went somewhere
// else) shrink back if nothing came up.
function landed() {
  const fn = S.open || (() => openChat(null));
  S.open = null;
  try { fn(); } catch (err) { console.warn('[island] ping click:', err.message); }
  setTimeout(() => { if (!drop.isUnderBar()) send('blur', drop.size()); }, 900);
}

// ─── Exported: what other modules tell the bar ───────────────────────────────
/**
 * A note: { title, text, onClick }. The line glows and grows into a card with
 * `text` for about 3 seconds (title, default 'Codeply', only goes to the
 * aria-label). Clicking the card grows it into the chat and runs onClick
 * (default: open the drop). Pings queue and play one after the other. Safe
 * before init and never throws.
 */
function ping(arg) {
  try {
    if (!host || hidden()) return;
    const o = typeof arg === 'string' ? { text: arg } : arg || {};
    const one = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
    const text = one(o.text, 160);
    const title = one(o.title, 60) || 'Codeply';
    if (!text && !o.title) return;
    const id = `p${++S.seq}`;
    S.pings.set(id, typeof o.onClick === 'function' ? o.onClick : null);
    // Never an unbounded list of handlers: the oldest go first.
    while (S.pings.size > 100) S.pings.delete(S.pings.keys().next().value);
    const p = { id, title, text };
    if (!alive()) { S.waiting.push(p); apply(); return; }
    if (!send('ping', p)) S.waiting.push(p);
  } catch (e) {
    try { console.warn('[island] ping:', e.message); } catch {}
  }
}

/** From voice-mode.js: Orbit's state. */
function voiceState(state) {
  try {
    const v = ['listening', 'thinking', 'speaking', 'teaching'].includes(state) ? state : 'idle';
    if (v === S.voice) return;
    S.voice = v;
    render();
  } catch {}
}

/** From voice-mode.js: the mic's level (0..1) while Orbit listens, about 30 times a second. */
function voiceLevel(v) {
  if (S.voice !== 'listening' || hidden()) return;
  send('level', { v: Math.min(1, Math.max(0, Number(v) || 0)) });
}

/** From voice-mode.js: what Orbit heard and says, for the card under the line ({ heard | say | hint | clear }). */
// While Orbit's words show, the see-through window is redrawn now and then:
// Windows can leave a see-through window drawn half wrong after Alt+Tab
// shuffles the windows behind it, and the next full repaint puts it right.
let repaintTimer = null;
let repaintStop = null;
function repaintWhileWords(on) {
  clearInterval(repaintTimer); repaintTimer = null;
  clearTimeout(repaintStop); repaintStop = null;
  if (!on) return;
  repaintTimer = setInterval(() => { try { if (alive()) win.webContents.invalidate(); } catch {} }, 500);
  repaintStop = setTimeout(() => repaintWhileWords(false), 30000); // never left running if a clear goes missing
}

function voiceWords(w) {
  if (hidden() || !w || typeof w !== 'object') return;
  repaintWhileWords(!w.clear);
  send('words', {
    clear: !!w.clear, note: !!w.note,
    heard: typeof w.heard === 'string' ? w.heard.slice(0, 400) : undefined,
    say: typeof w.say === 'string' ? w.say.slice(0, 2000) : undefined,
    hint: typeof w.hint === 'string' ? w.hint.slice(0, 120) : undefined,
  });
}

/** From main.js: the chats with a run in flight (same list the drop gets). */
function runs(active) {
  try {
    const ids = Array.isArray(active) ? active.slice() : [];
    if (ids.join('\n') === S.runs.join('\n')) return;
    S.runs = ids;
    render();
  } catch {}
}

function setHidden(on) {
  if (!host) return;
  host.setSetting('islandHidden', !!on);
  apply();
}
const isHidden = () => hidden();

function init(h) {
  host = h;
  ipcMain.on('island:from', (e, m) => {
    if (!alive() || e.sender !== win.webContents || !m || typeof m !== 'object') return;
    const d = m.data || {};
    if (m.type === 'click') {
      // The chat is up: this closes it (the shape shrinks back on 'blur').
      if (drop.isUnderBar()) { drop.hide(); return; }
      // Just closed by this same click (it took the focus away first): leave it closed.
      if (Date.now() - S.closedAt < 300) { send('blur', drop.size()); return; }
      S.open = null;
    } else if (m.type === 'ping-click') {
      const fn = S.pings.get(d.id);
      S.pings.delete(d.id);
      S.open = fn || null;
    } else if (m.type === 'ping-done') S.pings.delete(d.id);
    // The chat opens as soon as the shape starts growing: it grows out of the line itself (drop.css).
    else if (m.type === 'morph') { if (d.to === 'chat' && d.phase === 'start') landed(); }
    else if (m.type === 'size') {
      // Grows down only: the top left corner stays, so nothing on screen moves.
      const hgt = Math.round(Math.max(40, Math.min(MAX_H, Number(d.height) || REST_H)));
      if (hgt === winH) return;
      winH = hgt;
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: WIN_W, height: winH });
    } else if (m.type === 'hover') { if (isMac) win.setIgnoreMouseEvents(!d.on, { forward: true }); }
  });
  drop.setVisibilityHandler((underBar) => {
    if (S.attached === underBar) return;
    S.attached = underBar;
    if (!underBar) S.closedAt = Date.now();
    render();
  });
  // The drop is about to go from under the bar: the shape comes back at its size and shrinks.
  drop.setClosingHandler((size) => send('blur', size));
  // The chat always opens here, under the bar (Alt+C, the tray, Orbit), never in a corner.
  drop.setUnderSpot(under);
  // The drop's height changed: the next grow lands on its real size.
  let sized = '';
  drop.setSizeHandler((size) => { const k = `${size.width}x${size.height}`; if (k !== sized) { sized = k; render(); } });
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => { if (alive() && !hidden()) place(); });
  if (host.activeRunIds) S.runs = host.activeRunIds();
  apply();
  setTimeout(startWatch, 8000); // after the Windows helper has warmed up (voice-mode.js)
  setTimeout(() => { try { if (!hidden()) drop.warm(); } catch {} }, 2500); // the chat's window ready before the first click
}

function dispose() {
  quitting = true;
  clearInterval(watchTimer);
  repaintWhileWords(false);
  try { if (alive()) win.destroy(); } catch {}
}

module.exports = { init, dispose, ping, voiceState, voiceLevel, voiceWords, runs, setHidden, isHidden, openChat };
