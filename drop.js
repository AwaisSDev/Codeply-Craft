// The drop: Craft's agent in a small chat in the corner of the screen.
//
// Alt+C anywhere opens it (and hides it again). It runs the same agent, on the
// same projects, models and account as the main window: a message goes through
// startChatRun like one typed in Craft or sent from the phone, and the chat
// shows up in Craft's sidebar too. The window is created on first use and only
// hidden after that, so a task keeps reporting while it's out of sight; when the
// agent needs an OK or an answer, the drop comes back on its own.
const { BrowserWindow, globalShortcut, screen, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const W = 416;         // window size (the card fills it; only its rounded corners are transparent)
const H = 616;
const GUTTER = 16;
const HOTKEYS = ['Alt+C', 'Alt+Shift+C']; // the second one if another app already holds Alt+C

let host = null;       // functions from main.js (see init)
let win = null;
let hotkey = null;
let shownSession = null; // the chat the drop is showing
let quitting = false;

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function cornerPosition() {
  const saved = host.getSetting('dropPos');
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // still on a screen that exists?
    const on = screen.getAllDisplays().some((d) => saved.x >= d.workArea.x - 40 && saved.y >= d.workArea.y - 40 &&
      saved.x + W <= d.workArea.x + d.workArea.width + 40 && saved.y + H <= d.workArea.y + d.workArea.height + 40);
    if (on) return saved;
  }
  return { x: area.x + area.width - W - GUTTER, y: area.y + area.height - H - GUTTER };
}

function create() {
  const pos = cornerPosition();
  win = new BrowserWindow({
    width: W, height: H, x: pos.x, y: pos.y,
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
  let saveTimer = null;
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      host.setSetting('dropPos', { x, y });
    }, 400);
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

function toggle() {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) hide();
  else show();
}

function registerHotkey() {
  for (const k of HOTKEYS) {
    try { if (globalShortcut.register(k, toggle)) { hotkey = k; return; } } catch {}
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

function stateView() {
  const store = host.store();
  const project = store.lastProject && fs.existsSync(store.lastProject) ? store.lastProject : null;
  return {
    hotkey,
    project: projectView(project),
    projects: (store.projects || []).filter((p) => fs.existsSync(p)).map(projectView),
    models: host.modelsState(),
    recent: store.sessions.slice(0, 40)
      .filter((s) => s.fromDrop)
      .slice(0, 4)
      .map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt })),
    running: host.activeRunIds(),
    current: shownSession,
  };
}

function init(h) {
  host = h;
  registerHotkey();

  ipcMain.handle('drop:state', async () => { await host.loadEngine(); return stateView(); });
  ipcMain.on('drop:hide', hide);
  ipcMain.on('drop:showing', (e, id) => { shownSession = id || null; });

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
    const r = await host.startChatRun({ sessionId: sessionId || null, cwd, mode, text, bypass: bypass === true, clientId: 'drop' });
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

module.exports = { init, event, runs, show, hide, toggle, dispose, hotkeyLabel: () => (hotkey && process.platform === 'darwin' ? hotkey.replace('Alt', 'Option') : hotkey) };

