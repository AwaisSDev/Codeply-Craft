// The drop: Craft's agent in a small chat in the corner of the screen.
//
// Alt+C anywhere opens it (and hides it again). It runs the same agent, on the
// same projects, models and account as the main window: a message goes through
// startChatRun like one typed in Craft or sent from the phone, and the chat
// shows up in Craft's sidebar too. The window is created on first use and only
// hidden after that, so a task keeps reporting while it's out of sight; when the
// agent needs an OK or an answer, the drop comes back on its own.
const { BrowserWindow, globalShortcut, screen, ipcMain, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Empty, the drop is just its message bar; with a chat it grows upward into a
// panel. The page measures itself and asks for a height (drop:fit), and the
// window keeps its bottom edge where it is, so it grows up, never down.
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

/** The page asked for a height: grow or shrink upward from the bottom edge, never past the top of the screen. */
function fit(h) {
  if (!win || win.isDestroyed() || !Number.isFinite(h)) return;
  const [x] = win.getPosition();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  height = Math.round(Math.max(48, Math.min(h, MAX_H, bottom - area.y)));
  win.setBounds({ x, y: bottom - height, width: W, height });
}

function create() {
  const pos = anchor();
  bottom = pos.bottom;
  win = new BrowserWindow({
    width: W, height, x: pos.x, y: bottom - height,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'drop', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'drop', 'index.html'));
  // Links in replies open in the browser, never inside the drop.
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) { e.preventDefault(); external(url); } });
  // Dragged somewhere else: that's the new bottom edge it grows up from.
  let saveTimer = null;
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    bottom = b.y + b.height;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => host.setSetting('dropPos', { x: b.x, bottom }), 400);
  });
  // Alt+F4 and the like only hide it: the chat, and a task still running, stay put.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); hide(); } });
  win.on('closed', () => { win = null; });
}

function show({ focus = true } = {}) {
  if (!win || win.isDestroyed()) create();
  const reveal = () => {
    if (focus) { win.show(); win.focus(); send('drop:shown', { focus: true }); } else win.showInactive();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal); else reveal();
}

function hide() { if (win && !win.isDestroyed()) win.hide(); }

// What was on screen when the drop opened: one picture of the screen under the
// mouse, taken just before the drop shows, kept in memory only. It goes out
// with a message only when that message asks about the screen.
let shot = null; // { url, at }
const ABOUT_SCREEN = /\b(screen|screenshot|seeing|looking at|look at (this|that|it)|this (page|window|error|tab|site|app|image|picture|chart|graph|code|message|email|video|doc|document|file|bug|popup)|what('?s| is) (this|that|here)|whats (this|that)|on here|what (do|can) (you|u) see|you see|u see|read this|explain this)\b/i;
async function grabScreen() {
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const k = Math.min(1, 1600 / d.size.width);
    const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * k), height: Math.round(d.size.height * k) } });
    const src = list.find((s) => String(s.display_id) === String(d.id)) || list[0];
    shot = src && !src.thumbnail.isEmpty() ? { url: `data:image/jpeg;base64,${src.thumbnail.toJPEG(78).toString('base64')}`, at: Date.now() } : null;
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
  // The picture first, so the drop isn't in it; never more than half a second's wait.
  const visible = win && !win.isDestroyed() && win.isVisible();
  if (visible) { show(); return; }
  Promise.race([grabScreen(), new Promise((r) => setTimeout(r, 500))]).finally(() => show());
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

// Every chat (Craft's and the drop's), newest first, a page at a time.
const RECENT_PAGE = 15;
function recentPage(offset = 0, limit = RECENT_PAGE) {
  const all = host.store().sessions.filter((s) => !(host.isDesignSession && host.isDesignSession(s.id))).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return {
    items: all.slice(offset, offset + limit).map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt })),
    more: offset + limit < all.length,
  };
}

function stateView() {
  const store = host.store();
  const project = store.lastProject && fs.existsSync(store.lastProject) ? store.lastProject : null;
  return {
    hotkey,
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

  ipcMain.handle('drop:send', async (e, { sessionId, cwd, mode, text, newProject, bypass }) => {
    if (!cwd && newProject) {
      const made = host.newProjectFolder(newProject);
      if (made.error) return made;
      cwd = made.cwd;
    }
    // Asking about the screen ("what am I looking at", "what's this error"): the picture goes with it.
    const images = shot && Date.now() - shot.at < 15 * 60000 && ABOUT_SCREEN.test(String(text || '')) ? [shot.url] : undefined;
    let r = await host.startChatRun({ sessionId: sessionId || null, cwd, mode, text, images, bypass: bypass === true, clientId: 'drop' });
    if (images && r && r.error && /images|text only/i.test(r.error)) { r = await host.startChatRun({ sessionId: sessionId || null, cwd, mode, text, bypass: bypass === true, clientId: 'drop' }); }
    else if (images && r && r.sessionId) send('drop:event', { sessionId: r.sessionId, type: 'notice', level: 'info', text: 'Sent a picture of your screen with this.' });
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
  ipcMain.handle('drop:chooseProject', async () => {
    // The dialog would sit behind an always-on-top window.
    if (win) win.setAlwaysOnTop(false);
    const r = await dialog.showOpenDialog(win, { title: 'Open a project folder', properties: ['openDirectory'] });
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

module.exports = { init, event, runs, show, hide, toggle, captureNow, dispose, setPressHandler, voiceText, hotkeyLabel: () => (hotkey && process.platform === 'darwin' ? hotkey.replace('Alt', 'Option') : hotkey) };

