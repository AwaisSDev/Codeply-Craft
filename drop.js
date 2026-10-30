// The drop: Codeply's agent in a small chat that grows out of the top bar (island.js).
//
// Alt+C anywhere opens it (and hides it again). It runs the same agent, on the
// same projects, models and account as the main window: a message goes through
// startChatRun like one typed in Craft or sent from the phone, and the chat
// shows up in Craft's sidebar too. The window is created on first use and only
// hidden after that, so a task keeps reporting while it's out of sight; when the
// agent needs an OK or an answer, the drop comes back on its own.
const { app, BrowserWindow, globalShortcut, screen, ipcMain, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const lifeScreen = require('./life-screen');

// Empty, the drop is just its message bar; with a chat it grows upward into a
// panel. The page measures itself and asks for a height (drop:fit), and the
// window keeps its bottom edge where it is, so it grows up, never down.
// Opened from the top bar (island.js) it hangs under the bar instead: its top
// edge stays put and it grows down.
const W = 380;
const START_H = 104;   // until the page has measured itself: about one bar
const MAX_H = 500;   // the window never goes taller, menus included (they fit: about 390 at most)
const OLD_H = 616;     // the fixed height before, for positions saved back then
const GUTTER = 16;
const HOTKEYS = ['Alt+C', 'Alt+Shift+C']; // the second one if another app already holds Alt+C

let host = null;       // functions from main.js (see init)
let win = null;
let hotkey = null;
let shownSession = null; // the chat the drop is showing
let quitting = false;
let bottom = 0;          // the window's bottom edge, in screen coordinates
let height = START_H;
let mode = 'corner';     // 'corner': grows up from its spot (Alt+C, dropPos); 'top': hangs under the top bar, grows down
let top = 0;             // in 'top' mode, the window's top edge

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// Where the bar sits: { x, bottom }. Saved when it's dragged; the default is the
// bottom right corner of the screen the mouse is on.
function anchor() {
  const saved = host.getSetting('dropPos');
  if (saved && Number.isFinite(saved.x) && (Number.isFinite(saved.bottom) || Number.isFinite(saved.y))) {
    const b = Number.isFinite(saved.bottom) ? saved.bottom : saved.y + OLD_H;
    // still on a screen that exists? Then keep it fully inside that screen.
    const d = screen.getAllDisplays().find((s) => saved.x + W / 2 >= s.workArea.x && saved.x + W / 2 <= s.workArea.x + s.workArea.width &&
      b > s.workArea.y + START_H && b <= s.workArea.y + s.workArea.height + 40);
    if (d) {
      const a = d.workArea;
      return { x: Math.max(a.x, Math.min(saved.x, a.x + a.width - W)), bottom: Math.min(b, a.y + a.height) };
    }
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return { x: area.x + area.width - W - GUTTER, bottom: area.y + area.height - GUTTER };
}

/** The page asked for a height: grow or shrink upward from the bottom edge, never past the top of the screen (down from the top edge under the top bar). */
function fit(h) {
  if (!win || win.isDestroyed() || !Number.isFinite(h)) return;
  const [x] = win.getPosition();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  if (mode === 'top') {
    height = Math.round(Math.max(48, Math.min(h, MAX_H, area.y + area.height - top)));
    win.setBounds({ x: underX, y: top, width: W, height });
  } else {
    height = Math.round(Math.max(48, Math.min(h, MAX_H, bottom - area.y)));
    win.setBounds({ x, y: bottom - height, width: W, height });
  }
  if (onSize) { try { onSize(size()); } catch {} }
}

function create() {
  const pos = anchor();
  bottom = pos.bottom;
  win = new BrowserWindow({
    width: W, height, x: pos.x, y: bottom - height,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    backgroundColor: '#00000000',
    // Not throttled while hidden, so it answers the moment it's shown.
    webPreferences: { preload: path.join(__dirname, 'drop', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  // Kept out of screen captures, like the top bar: never in a screen recording,
  // and the screen's picture can be taken after it opens instead of before.
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, 'drop', 'index.html'));
  // Links in replies open in the browser, never inside the drop.
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) { e.preventDefault(); external(url); } });
  // Dragged somewhere else: that's the new bottom edge it grows up from.
  // (Under the top bar it's the new top edge, and the corner's saved spot stays.)
  let saveTimer = null;
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (mode === 'top') { top = b.y; return; }
    bottom = b.y + b.height;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => host.setSetting('dropPos', { x: b.x, bottom }), 400);
  });
  // Alt+F4 and the like only hide it: the chat, and a task still running, stay put.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); hide(); } });
  win.on('closed', () => { win = null; });
  win.on('show', tellVisible);
  win.on('hide', tellVisible);
  // Grown out of the top bar it's a quick look: a click anywhere else closes it
  // (and the bar shrinks back). Not while its own folder dialog has the focus,
  // and not for a blur in the first moment (the click that opened it settling).
  win.on('blur', () => {
    if (mode !== 'top' || asking || Date.now() - shownAt < 250 || !win || win.isDestroyed() || !win.isVisible()) return;
    hide();
  });
}
let asking = false; // the folder dialog is open
let shownAt = 0;

// The top bar (island.js): it steps aside while the drop is up where it grew
// into it, and shrinks back from the drop's size when the drop goes.
let onVisible = null;
let onClosing = null;
let onSize = null;
function setVisibilityHandler(fn) { onVisible = fn; }
function setClosingHandler(fn) { onClosing = fn; }
function setSizeHandler(fn) { onSize = fn; }
const isUnderBar = () => !!(win && !win.isDestroyed() && win.isVisible() && mode === 'top');
function tellVisible() { if (onVisible) { try { onVisible(isUnderBar()); } catch {} } }
/** The window's size now (the top bar grows into exactly this). */
const size = () => ({ width: W, height });

/** Back to its corner (the saved dropPos, or bottom right), growing up. */
function placeCorner() {
  const pos = anchor();
  mode = 'corner';
  bottom = pos.bottom;
  win.setBounds({ x: pos.x, y: bottom - height, width: W, height });
}

/** Under the top bar: `y` is its top edge (just below the bar's line), centered on `cx`, growing down. */
let underX = 0;
function placeUnder({ cx, y }) {
  mode = 'top';
  const a = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(y) }).workArea;
  top = Math.round(Math.max(a.y, y));
  height = Math.round(Math.max(48, Math.min(height, a.y + a.height - top)));
  underX = Math.round(Math.max(a.x, Math.min(cx - W / 2, a.x + a.width - W)));
  win.setBounds({ x: underX, y: top, width: W, height });
}

// `under` ({ cx, y }): hang under the top bar. Without it, the top bar's spot
// (island.js, setUnderSpot) when there is one: the chat in the corner is gone,
// so Alt+C, the tray and Orbit all open the chat under the bar. `corner` only
// without a top bar.
let underSpot = null;
function setUnderSpot(fn) { underSpot = fn; }
function show({ focus = true, under = null, corner = false } = {}) {
  if (!win || win.isDestroyed()) create();
  clearTimeout(hideTimer); hideTimer = null; // was on its way out: it stays
  if (!under && underSpot) { try { under = underSpot(); } catch {} }
  const was = mode;
  const opening = !!under && !win.isVisible();
  if (under) placeUnder(under);
  else if (corner && mode !== 'corner') placeCorner();
  if (mode !== was) tellVisible();
  const reveal = () => {
    // Freshly opened from the bar it grows out of the bar's line (drop.css).
    send('drop:anchor', mode === 'top' ? { mode, grow: opening } : mode);
    shownAt = Date.now();
    if (focus) { win.show(); win.focus(); send('drop:shown', { focus: true }); } else win.showInactive();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal); else reveal();
}

// Under the top bar the chat shrinks back up into the bar's line (drop:leave,
// drop.css), then the window hides.
const LEAVE_MS = 310; // body.top.leave in drop.css (300ms), so it ends as the line before the window goes
let hideTimer = null;
function hide() {
  if (!win || win.isDestroyed()) return;
  if (hideTimer) return; // already on its way
  if (mode === 'top' && win.isVisible() && !quitting) {
    send('drop:leave');
    const was = size();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (onClosing) { try { onClosing({ ...was, instant: true }); } catch {} }
      if (win && !win.isDestroyed()) win.hide();
    }, LEAVE_MS);
    return;
  }
  win.hide();
}

// What was on screen when the drop opened: one picture of the screen under the
// mouse, taken just before the drop shows, kept in memory only. It goes out
// with a message only when that message asks about the screen.
let shot = null; // { url, img, at, text: Promise<string> }
const ABOUT_SCREEN = /\b(screen|screenshot|seeing|looking at|look at (this|that|it)|(this|that) (page|window|error|tab|site|app|image|picture|chart|graph|code|message|email|video|post|tweet|reel|story|doc|document|file|bug|popup|price|number)|how (many|much)|what('?s| is) (this|that|here)|whats (this|that)|on here|what (do|can) (you|u) see|you see|u see|read this|explain this)\b/i;

// Screens from the last half hour (Life's "Read my screen" keeps them): the ones
// this message is about go along too, so "how many views did that video have"
// works after switching to another tab.
const STOP = new Set('the and for you your that this there their what was were how many much again with from have has had did does are its can could would should about just now then than one also into some any'.split(' '));
function earlierScreens(text) {
  let list = [];
  try { list = require('./life-desktop').recentScreens(); } catch {}
  if (!list.length) return { earlier: [], others: [] };
  const words = [...new Set(String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter((w) => !STOP.has(w));
  const earlier = list
    .map((x) => ({ ...x, score: words.reduce((n, w) => n + (x.title.toLowerCase().includes(w) ? 3 : 0) + (x.text.toLowerCase().includes(w) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, 2)
    .map(({ title, text: t, at }) => ({ title, text: t, at }));
  const taken = new Set(earlier.map((x) => x.title));
  const others = list.filter((x) => !taken.has(x.title)).slice(0, 8).map(({ title, at }) => ({ title, at }));
  return { earlier, others };
}
async function grabScreen() {
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const k = Math.min(1, 1600 / d.size.width);
    const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * k), height: Math.round(d.size.height * k) } });
    const src = list.find((s) => String(s.display_id) === String(d.id)) || list[0];
    // Its text is read straight away (the OCR built into Windows), so a message sent right after doesn't wait.
    shot = src && !src.thumbnail.isEmpty() ? { url: `data:image/jpeg;base64,${src.thumbnail.toJPEG(78).toString('base64')}`, img: src.thumbnail, at: Date.now() } : null;
    if (shot) shot.text = lifeScreen.ocrImage(shot.img).catch(() => '');
  } catch { shot = null; }
}

/**
 * A fresh picture of the screen under the mouse for look_at_screen, with the
 * drop see-through for that moment so it never covers what the person means.
 */
async function captureNow() {
  const visible = win && !win.isDestroyed() && win.isVisible();
  if (visible) { win.setOpacity(0); await new Promise((r) => setTimeout(r, 140)); }
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const k = Math.min(1, 1600 / d.size.width);
    const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * k), height: Math.round(d.size.height * k) } });
    const src = list.find((s) => String(s.display_id) === String(d.id)) || list[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return { url: `data:image/jpeg;base64,${src.thumbnail.toJPEG(78).toString('base64')}`, img: src.thumbnail };
  } finally {
    if (visible && win && !win.isDestroyed()) win.setOpacity(1);
  }
}

function toggle() {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) { hide(); return; }
  const visible = win && !win.isDestroyed() && win.isVisible();
  if (visible) { show(); return; }
  // It opens at once (under the top bar, see show); the screen's picture comes right after (the drop is kept out of captures).
  show({ corner: true });
  pictureSoon();
}

// The screen's picture once the drop has finished opening, so encoding it never stalls the open.
let pictureTimer = null;
function pictureSoon() {
  clearTimeout(pictureTimer);
  pictureTimer = setTimeout(() => { grabbing = null; prepare(true); }, 450);
}

/** Make the drop's window ahead of time (hidden), so the first open doesn't wait for it to load. */
function warm() { if (!win || win.isDestroyed()) create(); }

// The screen's picture for the chat, like Alt+C. The drop is kept out of
// captures, so it's taken once the drop has opened (pictureSoon) and never
// holds up the open. `open`: it's fine that the drop is up.
let grabbing = null;
function prepare(open) {
  if (!open && win && !win.isDestroyed() && win.isVisible()) return null;
  if (!grabbing) grabbing = Promise.race([grabScreen(), new Promise((r) => setTimeout(r, 500))]).finally(() => { setTimeout(() => { grabbing = null; }, 2000); });
  return grabbing;
}

/** From the top bar (island.js): open where its shape grew into the chat, growing down. */
// Never waits for anything: the chat opens on the click, growing out of the bar's line.
function showUnder(under, { focus = true } = {}) {
  const was = win && !win.isDestroyed() && win.isVisible();
  show({ under, focus });
  if (!was) pictureSoon();
}

/** Open one chat (a ping about it was clicked): under the top bar when `under` is given. */
function openChat(sessionId, under) {
  show(under ? { under } : {});
  shownSession = sessionId;
  const go = () => send('drop:open', sessionId);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go); else go();
}

// Voice mode (voice-mode.js) decides whether a key down is a tap (toggle) or a hold (talk).
let onPress = null;
function setPressHandler(fn) { onPress = fn; }

function registerHotkey() {
  const handler = () => (onPress ? onPress(toggle) : toggle());
  for (const k of HOTKEYS) {
    try { if (globalShortcut.register(k, handler)) { hotkey = k; return; } } catch {}
  }
  console.warn('[drop] no hotkey: Alt+C and Alt+Shift+C are both taken');
}

/** Everything the main process emits for a chat; main.js calls this from sendEvent(). */
function event(sessionId, ev) {
  if (!win || win.isDestroyed()) return;
  send('drop:event', { sessionId, ...ev });
  // The agent is waiting on the person: bring the drop back if it's this chat.
  if (sessionId === shownSession && ['approval_request', 'question_request', 'image_pick_request'].includes(ev.type) && !win.isVisible()) {
    show({ focus: false });
  }
}

function runs(active) { send('drop:runs', active); }

function projectView(p) {
  return p ? { path: p, name: path.basename(p) } : null;
}

// Files sent with a message: pictures (up to 5 MB) as data URLs, named for the
// model, and the rest (folders too) as their paths. Anything else is left out.
const MAX_FILES = 10;
const PICTURE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
function readFiles(list) {
  const pictures = []; const others = [];
  for (const p of (Array.isArray(list) ? list : []).slice(0, MAX_FILES)) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) { if (st.isDirectory()) others.push(p); continue; } // a folder: its path, for the agent to look in
    const type = PICTURE[path.extname(p).toLowerCase()];
    if (type && st.size <= 5 * 1024 * 1024) {
      try { pictures.push({ url: `data:${type};base64,${fs.readFileSync(p).toString('base64')}`, what: path.basename(p) }); continue; } catch {}
    }
    others.push(p);
  }
  return { pictures, others };
}

// Every chat (Craft's and the drop's), newest first, a page at a time.
const RECENT_PAGE = 15;
function recentPage(offset = 0, limit = RECENT_PAGE) {
  const all = host.store().sessions.filter((s) => !(host.isDesignSession && host.isDesignSession(s.id))).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return {
    items: all.slice(offset, offset + limit).map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt })),
    more: offset + limit < all.length,
  };
}

// "This computer": where a chat under the top bar works until a project folder
// is picked. A Codeply folder in the user's home (C:\Users\<name>\Codeply), made on first use.
function computerFolder() {
  const dir = path.join(app.getPath('home'), 'Codeply');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return null; }
  return { path: dir, name: 'This computer', computer: true };
}

function stateView() {
  const store = host.store();
  const project = store.lastProject && fs.existsSync(store.lastProject) ? store.lastProject : null;
  return {
    hotkey,
    computer: computerFolder(),
    project: projectView(project),
    projects: (store.projects || []).filter((p) => fs.existsSync(p)).map(projectView),
    models: host.modelsState(),
    recent: recentPage(),
    running: host.activeRunIds(),
    current: shownSession,
  };
}

function init(h) {
  host = h;
  registerHotkey();

  ipcMain.handle('drop:state', async () => { await host.loadEngine(); return stateView(); });
  ipcMain.on('drop:hide', hide);
  ipcMain.on('drop:fit', (e, h) => fit(Number(h)));
  ipcMain.on('drop:showing', (e, id) => { shownSession = id || null; });

  ipcMain.handle('drop:recent', (e, { offset } = {}) => recentPage(Math.max(0, Number(offset) || 0)));

  ipcMain.handle('drop:session', (e, id) => {
    const s = host.store().sessions.find((x) => x.id === id);
    if (!s) return null;
    shownSession = s.id;
    return { id: s.id, title: s.title, cwd: s.cwd, messages: s.messages.slice(-80), running: host.activeRunIds().includes(s.id) };
  });

  ipcMain.handle('drop:send', async (e, { sessionId, cwd, mode, text, newProject, bypass, files }) => {
    if (!cwd && newProject) {
      const made = host.newProjectFolder(newProject);
      if (made.error) return made;
      cwd = made.cwd;
    }
    // Files added with + or dropped on the chat: pictures go along as pictures,
    // everything else as its path for the agent to open with its tools.
    const { pictures: filePics, others: filePaths } = readFiles(files);
    if (filePaths.length) text = `${text}\n\nAttached files:\n${filePaths.map((p) => `- ${p}`).join('\n')}`;
    // The drop sits over whatever the person is looking at, so every message carries the screen's
    // text: the picture from when it opened if that's recent, else a fresh one.
    let now = shot && Date.now() - shot.at < 2 * 60000 ? shot : null;
    if (!now) { try { const c = await captureNow(); if (c) now = { ...c, at: Date.now(), text: lifeScreen.ocrImage(c.img).catch(() => '') }; } catch {} }
    const screenText = now ? await Promise.race([now.text, new Promise((r) => setTimeout(() => r(''), 4000))]) : '';
    // Asking about the screen ("what am I looking at", "what's this error"): the picture goes too.
    const { earlier, others } = earlierScreens(text);
    // Pictures: the screen now when the message asks about it, and the earlier screen it is
    // about straight from Life's picture buffer (no new screenshot), each named for the model.
    const pics = [];
    if (now && ABOUT_SCREEN.test(String(text || ''))) pics.push({ url: now.url, what: 'the screen right now' });
    if (earlier.length) {
      let frame = null;
      try { frame = require('./life-desktop').recentFrames().find((f) => f.title === earlier[0].title) || null; } catch {}
      if (frame) pics.push({ url: frame.url, what: `${frame.title}, ${Math.max(1, Math.round((Date.now() - frame.at) / 60000))} min ago` });
    }
    for (const f of filePics) pics.push(f);
    const images = pics.length ? pics.map((p) => p.url) : undefined;
    const screenRead = screenText || earlier.length ? { text: screenText, earlier, others, pictures: pics.map((p) => p.what) } : null;
    let r = await host.startChatRun({ sessionId: sessionId || null, cwd, mode, text, images, screen: screenRead, bypass: bypass === true, clientId: 'drop' });
    if (images && r && r.error && /images|text only/i.test(r.error)) { r = await host.startChatRun({ sessionId: sessionId || null, cwd, mode, text, screen: screenRead, bypass: bypass === true, clientId: 'drop' }); }
    else if (images && r && r.sessionId && pics.length > filePics.length) send('drop:event', { sessionId: r.sessionId, type: 'notice', level: 'info', text: 'Sent a picture of your screen with this.' });
    if (r && r.sessionId && host.onAsk) { try { host.onAsk(text); } catch {} } // the shared life context (life-desktop.js)
    if (r && r.sessionId) {
      shownSession = r.sessionId;
      const s = host.store().sessions.find((x) => x.id === r.sessionId);
      if (s && !s.fromDrop) { s.fromDrop = true; host.saveStore(); }
    }
    return { ...r, cwd, project: projectView(cwd) };
  });

  ipcMain.on('drop:stop', (e, id) => host.stopChatRun(id));
  ipcMain.on('drop:approve', (e, { requestId, verdict }) => host.respondApproval(requestId, verdict));
  ipcMain.on('drop:answer', (e, { requestId, answer }) => host.respondQuestion(requestId, answer));
  ipcMain.handle('drop:undo', (e, { sessionId, checkpointId, undo }) => host.setCheckpointUndone(sessionId, checkpointId, undo !== false));

  ipcMain.handle('drop:useProject', (e, p) => {
    if (!p || !fs.existsSync(p)) return null;
    host.rememberProject(p);
    return projectView(p);
  });
  // + in the chat under the bar: files to send with the next message.
  ipcMain.handle('drop:pickFiles', async () => {
    asking = true;
    if (win) win.setAlwaysOnTop(false);
    let r;
    try { r = await dialog.showOpenDialog(win, { title: 'Add files', properties: ['openFile', 'multiSelections'] }); }
    finally { asking = false; }
    if (win) { win.setAlwaysOnTop(true, 'floating'); win.focus(); }
    return r.canceled ? [] : r.filePaths.slice(0, MAX_FILES);
  });

  ipcMain.handle('drop:chooseProject', async () => {
    // The dialog would sit behind an always-on-top window.
    asking = true;
    if (win) win.setAlwaysOnTop(false);
    let r;
    try { r = await dialog.showOpenDialog(win, { title: 'Open a project folder', properties: ['openDirectory'] }); }
    finally { asking = false; }
    if (win) { win.setAlwaysOnTop(true, 'floating'); win.focus(); }
    if (r.canceled || !r.filePaths[0]) return null;
    host.rememberProject(r.filePaths[0]);
    return projectView(r.filePaths[0]);
  });

  ipcMain.handle('drop:selectModel', async (e, id) => {
    await host.loadEngine();
    return host.selectModel(id);
  });

  ipcMain.on('drop:openInCraft', (e, id) => {
    hide();
    host.openInCraft(id || null);
  });
}

function dispose() {
  quitting = true;
  try { if (hotkey) globalShortcut.unregister(hotkey); } catch {}
}

/** From voice mode: put text in the drop's box, and send it as a task when `run` is set. */
function voiceText(text, run) {
  show({ focus: !run });
  const go = () => send('drop:voiceText', { text, run: !!run });
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go); else go();
}

const isShowing = (sessionId) => !!(win && !win.isDestroyed() && win.isVisible() && shownSession && shownSession === sessionId);

module.exports = { init, event, runs, show, hide, toggle, captureNow, isShowing, dispose, setPressHandler, voiceText, showUnder, openChat, isUnderBar, setVisibilityHandler, setClosingHandler, setSizeHandler, setUnderSpot, prepare, warm, size, hotkeyLabel: () => (hotkey && process.platform === 'darwin' ? hotkey.replace('Alt', 'Option') : hotkey) };

