// Drag + Shift: drag any file anywhere, hold Shift, and a wheel of formats pops
// up under the mouse. Drop the file on one and a converted copy appears next to
// the original. All on this PC (see convert-wheel/convert.js).
//
// Electron can't see a drag in Explorer, so the same listen-only input hook
// Orbit uses (uiohook-napi) watches for "left button held, mouse moved, Shift
// down". Then a small see-through window that never takes focus is put under
// the mouse. It stays invisible until a real file drag enters it (a Shift drag
// that selects text or files shows nothing), then the wheel pops in. Letting go
// of Shift, moving off the wheel or letting go of the mouse puts it away.
const { BrowserWindow, screen, ipcMain, shell, app, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const convert = require('./convert-wheel/convert');

const SIZE = 360;        // the wheel window, a square around the mouse
const TOAST_W = 420;
const TOAST_H = 84;
const DRAG_PX = 6;       // how far the mouse moves with the button down before it counts as a drag

let host = null;         // functions from main.js (see init)
let wheel = null;
let toastWin = null;
let renderWin = null;
let hookOn = false;
let formats = {};        // input format -> what it can become
const S = { left: false, downX: 0, downY: 0, dragging: false, shift: false, shown: false, dismissed: false, dropping: false };
let hideTimer = null;

const enabled = () => host.getSetting('convertWheel') !== false;
const allPages = () => host.getSetting('convertPdfAllPages') !== false;

function log(...a) { if (process.env.CODEPLY_CONVERT_DEBUG) console.log('[convert]', ...a); }

// ─── The wheel window ───────────────────────────────────────────────────────

function createWheel() {
  wheel = new BrowserWindow({
    width: SIZE, height: SIZE, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'convert-wheel', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  wheel.setAlwaysOnTop(true, 'screen-saver');
  wheel.loadFile(path.join(__dirname, 'convert-wheel', 'wheel.html'));
  wheel.webContents.on('will-navigate', (e) => e.preventDefault()); // a drop never opens the file in here
  wheel.on('closed', () => { wheel = null; });
}

function showWheel() {
  if (!wheel || wheel.isDestroyed()) createWheel();
  clearTimeout(hideTimer);
  const p = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(p).bounds;
  const x = Math.round(Math.max(area.x, Math.min(p.x - SIZE / 2, area.x + area.width - SIZE)));
  const y = Math.round(Math.max(area.y, Math.min(p.y - SIZE / 2, area.y + area.height - SIZE)));
  wheel.setBounds({ x, y, width: SIZE, height: SIZE });
  S.shown = true;
  S.dropping = false;
  const go = () => {
    if (!S.shown || !wheel || wheel.isDestroyed()) return;
    wheel.webContents.send('cw:arm', { formats, cursor: { x: p.x - x, y: p.y - y } });
    wheel.showInactive();
  };
  if (wheel.webContents.isLoading()) wheel.webContents.once('did-finish-load', go); else go();
  log('wheel up at', p);
}

function hideWheel(delay = 0) {
  clearTimeout(hideTimer);
  const go = () => {
    S.shown = false;
    if (wheel && !wheel.isDestroyed()) { wheel.webContents.send('cw:disarm'); wheel.hide(); }
  };
  if (delay) hideTimer = setTimeout(go, delay); else go();
}

function maybeShow() {
  if (enabled() && S.left && S.dragging && S.shift && !S.shown && !S.dismissed) showWheel();
}

// ─── The input hook ─────────────────────────────────────────────────────────

function startHook() {
  if (hookOn) return true;
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) return false;
  let m;
  try { m = require('uiohook-napi'); } catch (e) { console.warn('[convert] input hook unavailable:', e.message); return false; }
  const K = m.UiohookKey;
  const isShift = (code) => code === K.Shift || code === K.ShiftRight;
  m.uIOhook.on('mousedown', (e) => {
    if (e.button !== 1) return;
    S.left = true; S.dragging = false; S.dismissed = false;
    S.downX = e.x; S.downY = e.y;
  });
  m.uIOhook.on('mousemove', (e) => {
    if (!S.left || S.dragging) return;
    if (Math.abs(e.x - S.downX) + Math.abs(e.y - S.downY) < DRAG_PX) return;
    S.dragging = true;
    log('drag started, shift', S.shift);
    // Load the wheel's page now, so it's ready by the time Shift goes down.
    if (enabled() && (!wheel || wheel.isDestroyed())) createWheel();
    maybeShow();
  });
  m.uIOhook.on('mouseup', (e) => {
    if (e.button !== 1) return;
    S.left = false; S.dragging = false;
    // The drop lands in the page a moment after the button comes up.
    if (S.shown) hideWheel(S.dropping ? 0 : 350);
  });
  m.uIOhook.on('keydown', (e) => {
    if (!isShift(e.keycode) || S.shift) return;
    S.shift = true; S.dismissed = false;
    log('shift down, dragging', S.dragging);
    maybeShow();
  });
  m.uIOhook.on('keyup', (e) => {
    if (!isShift(e.keycode)) return;
    S.shift = false;
    if (S.shown && !S.dropping) hideWheel();
  });
  try { m.uIOhook.start(); } catch (e) { console.warn('[convert] input hook failed to start:', e.message); return false; }
  hookOn = true;
  return true;
}

// ─── The hidden page that draws PDF pages and lays out DOCX files ───────────

let renderReady = null;
let renderIdle = null;
const jobs = new Map();
let jobId = 0;

function renderer() {
  clearTimeout(renderIdle);
  if (renderWin && !renderWin.isDestroyed()) return renderReady;
  renderWin = new BrowserWindow({
    show: false, width: 900, height: 1200, skipTaskbar: true, focusable: false,
    webPreferences: { preload: path.join(__dirname, 'convert-wheel', 'render-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  renderWin.webContents.on('will-navigate', (e) => e.preventDefault());
  renderWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  renderWin.on('closed', () => {
    renderWin = null;
    for (const j of jobs.values()) j.reject(new Error('the converter stopped'));
    jobs.clear();
  });
  renderReady = renderWin.loadFile(path.join(__dirname, 'convert-wheel', 'render.html'));
  return renderReady;
}

// Closed a minute after the last job, so it doesn't sit in memory.
function doneWithRenderer() {
  clearTimeout(renderIdle);
  renderIdle = setTimeout(() => { if (!jobs.size && renderWin && !renderWin.isDestroyed()) renderWin.destroy(); }, 60000);
}

function job(type, payload, onPage) {
  return renderer().then(() => new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject, onPage, chain: Promise.resolve() });
    renderWin.webContents.send('render:job', { id, type, ...payload });
  })).finally(doneWithRenderer);
}

const renderHost = {
  async renderPdf(bytes, { all }, onPage) {
    await job('pdf', { data: new Uint8Array(bytes), all, scale: 2 }, onPage);
  },
  async docxToPdf(bytes) {
    const page = await job('docx', { data: new Uint8Array(bytes) });
    const pdf = await renderWin.webContents.printToPDF({
      printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' },
      pageSize: page && page.width ? { width: page.width / 96, height: page.height / 96 } : 'A4',
    });
    return pdf;
  },
};

function onRenderMessage(e, msg) {
  const j = jobs.get(msg.id);
  if (!j) return;
  if (msg.page) {
    // Pages are saved one after another, in order, while the next one draws.
    j.chain = j.chain.then(() => j.onPage(Buffer.from(msg.page.png), msg.page.index, msg.page.total));
    j.chain.catch((err) => { jobs.delete(msg.id); j.reject(err); });
    return;
  }
  jobs.delete(msg.id);
  if (msg.error) j.reject(new Error(msg.error));
  else j.chain.then(() => j.resolve(msg.result || null), j.reject);
}

// ─── The toast ──────────────────────────────────────────────────────────────

let toastAnchor = null;
function toast(data) {
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = new BrowserWindow({
      width: TOAST_W, height: TOAST_H, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'convert-wheel', 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    toastWin.setAlwaysOnTop(true, 'screen-saver');
    toastWin.loadFile(path.join(__dirname, 'convert-wheel', 'toast.html'));
    toastWin.webContents.on('will-navigate', (e) => e.preventDefault());
    toastWin.on('closed', () => { toastWin = null; });
  }
  // Bottom middle of the screen the file was dropped on.
  const area = screen.getDisplayNearestPoint(toastAnchor || screen.getCursorScreenPoint()).workArea;
  toastWin.setBounds({ x: Math.round(area.x + (area.width - TOAST_W) / 2), y: area.y + area.height - TOAST_H - 12, width: TOAST_W, height: TOAST_H });
  const go = () => { if (toastWin && !toastWin.isDestroyed()) { toastWin.webContents.send('cw:toast', data); toastWin.showInactive(); } };
  if (toastWin.webContents.isLoading()) toastWin.webContents.once('did-finish-load', go); else go();
}

// ─── A drop ─────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function onDrop(files, to) {
  toastAnchor = screen.getCursorScreenPoint();
  const label = convert.LABEL[to] || to.toUpperCase();
  const list = files.filter(Boolean).slice(0, 50);
  if (!list.length) return;
  const name = (f) => (f.path ? path.basename(f.path) : f.name || 'file');
  toast({ state: 'working', title: list.length === 1 ? `Converting ${name(list[0])}` : `Converting ${list.length} files`, detail: `to ${label}` });
  const done = [];
  const failed = [];
  for (const f of list) {
    let src = f.path;
    let tmp = null;
    let outDir = null;
    try {
      if (!src) {
        // Dragged out of a web page: no file on disk yet. It goes to Downloads.
        const safe = path.basename(String(f.name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
        tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codeply-convert-'));
        src = path.join(tmp, safe);
        await fs.promises.writeFile(src, Buffer.from(f.data));
        outDir = app.getPath('downloads');
      }
      done.push(await convert.convert(src, to, { host: renderHost, outDir, pdfAllPages: allPages() }));
    } catch (e) {
      console.warn('[convert]', name(f), '->', to, 'failed:', e.message);
      failed.push({ name: name(f), error: e.message });
    } finally {
      if (tmp) fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!done.length) {
    toast({ state: 'error', title: list.length === 1 ? `Couldn't convert ${failed[0].name}` : `Couldn't convert ${list.length} files`, detail: cap(failed[0].error) });
    return;
  }
  const outputs = done.flatMap((r) => r.outputs);
  const reveal = done[0].reveal;
  let title;
  if (done.length === 1 && outputs.length === 1) title = `Saved ${path.basename(outputs[0])}`;
  else if (done.length === 1) title = `Saved ${plural(outputs.length, 'page', 'pages')} as ${label}`;
  else title = `Saved ${plural(done.length, 'file', 'files')} as ${label}`;
  const detail = failed.length ? `${plural(failed.length, 'file', 'files')} didn't convert` : `In ${path.basename(path.dirname(outputs[0])) || path.dirname(outputs[0])}`;
  toast({ state: 'done', title, detail, reveal });
}

const cap = (s) => { const t = String(s || 'Something went wrong'); return t.charAt(0).toUpperCase() + t.slice(1); };

// ─── Setup ──────────────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.on('cw:open', () => { S.dropping = false; log('wheel open'); });
  ipcMain.on('cw:leave', () => { log('left the wheel'); if (S.shown && !S.dropping) { S.dismissed = true; hideWheel(); } });
  ipcMain.on('cw:notFiles', () => { log('not a file drag'); if (S.shown) { S.dismissed = true; hideWheel(); } });
  ipcMain.on('cw:drop', (e, { to, files } = {}) => {
    S.dropping = true;
    hideWheel(220); // after the picked segment's little flash
    if (typeof to !== 'string' || !Array.isArray(files)) return;
    onDrop(files.map((f) => (f && typeof f.path === 'string' && f.path ? { path: f.path } : f && f.data ? { name: String(f.name || ''), data: f.data } : null)), to.toLowerCase())
      .catch((err) => toast({ state: 'error', title: "Couldn't convert that", detail: cap(err.message) }));
  });
  ipcMain.on('cw:reveal', (e, p) => { if (typeof p === 'string' && p && fs.existsSync(p)) shell.showItemInFolder(p); });
  ipcMain.on('cw:toastDone', () => { if (toastWin && !toastWin.isDestroyed()) toastWin.hide(); });
  ipcMain.on('render:reply', onRenderMessage);
}

async function refreshFormats() {
  formats = convert.formatTable({ word: await convert.hasWord() });
}

function setEnabled(on) {
  host.setSetting('convertWheel', !!on);
  if (on) startHook();
  else { hideWheel(); if (wheel && !wheel.isDestroyed()) wheel.destroy(); }
  if (host.onChange) host.onChange();
}
function setAllPages(on) {
  host.setSetting('convertPdfAllPages', !!on);
  if (host.onChange) host.onChange();
}

/** Tray menu entries, next to the drop's. */
function trayItems() {
  if (!hookOn) return [];
  return [
    { label: 'Convert files with drag + Shift', type: 'checkbox', checked: enabled(), click: (item) => setEnabled(item.checked) },
    ...(enabled() ? [{ label: 'Convert every page of a PDF', type: 'checkbox', checked: allPages(), click: (item) => setAllPages(item.checked) }] : []),
  ];
}

/** deps: getSetting, setSetting, onChange (settings changed: rebuild the tray menu). */
function init(deps) {
  host = deps;
  registerIpc();
  refreshFormats().catch(() => {});
  // The hook is shared with Orbit; starting it twice is harmless.
  hookOn = startHook();
  if (!hookOn) console.warn('[convert] drag + Shift is off: no input hook on this system');
}

function dispose() {
  for (const w of [wheel, toastWin, renderWin]) if (w && !w.isDestroyed()) w.destroy();
}

module.exports = { init, dispose, trayItems, setEnabled, isEnabled: () => enabled() && hookOn, _test: { showWheel, hideWheel, onDrop, toast, renderHost, S } };
