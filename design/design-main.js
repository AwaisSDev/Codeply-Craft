// The Design tab: Codeply Design inside Craft's window, laid over the main area
// like the Crew tab. A design is a folder in Documents/Codeply Designs with an
// index.html (the design) and a design.json (its title and kind); its chat is an
// ordinary Craft session run in Design mode in that folder (codeply-cli: the
// agent only designs, writes only there, and never runs commands or deploys).
// Design chats stay out of Craft's sidebar, the Drop and the phone's chat list.
//
// "Build it in Craft" copies the design into a new project and starts a Build
// chat that makes it work.
const { BrowserView, BrowserWindow, ipcMain, dialog, shell, app, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// The canvas shows a design in a sandboxed frame, and a sandboxed frame may not read file://
// pictures. So each design is served as codeply-design://<id>/..., from its own folder only.
// (Registered here, at startup: it has to happen before the app is ready.)
const SCHEME = 'codeply-design';
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let host = null;        // functions from main.js (see init)
let view = null;
let viewHost = null;
let watching = null;    // { id, watcher, timer } for the design on screen

// The size each kind of design is drawn at (design_lint uses the same).
const SIZE = {
  website: { w: 1440, h: 900 }, app: { w: 1440, h: 1000 }, slides: { w: 1280, h: 720 }, doc: { w: 816, h: 1056 },
  poster: { w: 1080, h: 1350 }, social: { w: 1080, h: 1080 }, logo: { w: 1200, h: 800 },
};
const KINDS = Object.keys(SIZE);

const base = () => path.join(app.getPath('documents'), 'Codeply Designs');
const records = () => { const s = host.store(); if (!Array.isArray(s.designs)) s.designs = []; return s.designs; };
const byId = (id) => records().find((d) => d.id === id) || null;
const send = (channel, data) => { if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, data); };

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** What the page shows for one design: its record plus what the agent wrote in design.json. */
function view_(d) {
  const j = readJson(path.join(d.dir, 'design.json')) || {};
  const file = path.join(d.dir, 'index.html');
  const kind = KINDS.includes(j.kind) ? j.kind : (KINDS.includes(d.kind) ? d.kind : 'website');
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch {}
  let thumb = 0; try { thumb = fs.statSync(path.join(d.dir, THUMB)).mtimeMs; } catch {}
  return {
    id: d.id, title: String(j.title || d.title || 'Untitled design').slice(0, 120), kind, summary: String(j.summary || '').slice(0, 300),
    sessionId: d.sessionId || null, dir: d.dir, file, url: pathToFileURL(file).href, previewUrl: `${SCHEME}://${d.id}/index.html`, thumbUrl: thumb ? `${SCHEME}://${d.id}/${THUMB}?v=${Math.round(thumb)}` : null, ready: mtime > 0, updatedAt: Math.max(d.updatedAt || 0, mtime),
    size: SIZE[kind], running: !!d.sessionId && host.activeRunIds().includes(d.sessionId),
  };
}

function list() {
  const all = records().filter((d) => fs.existsSync(d.dir)).map(view_).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const v of all) if (v.ready && (!v.thumbUrl || thumbStale(v))) thumbSoon(byId(v.id));
  return all;
}

function slugOf(text) {
  return String(text || 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 40) || 'design';
}

function newFolder(text) {
  const root = base();
  fs.mkdirSync(root, { recursive: true });
  const slug = slugOf(text);
  let dir = path.join(root, slug);
  for (let i = 2; fs.existsSync(dir) && i < 200; i++) dir = path.join(root, `${slug}-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function sendMessage(d, text, images) {
  const r = await host.startChatRun({ sessionId: d.sessionId || null, cwd: d.dir, mode: 'Design', design: d.id, text, images: Array.isArray(images) && images.length ? images.slice(0, 4) : undefined, clientId: 'design' });
  if (r && r.sessionId && d.sessionId !== r.sessionId) { d.sessionId = r.sessionId; }
  d.updatedAt = Date.now();
  host.saveStore();
  return r;
}

// ─── Watching the design on screen, so the canvas reloads as the agent writes ──
function watch(id) {
  if (watching && watching.id === id) return;
  unwatch();
  const d = byId(id);
  if (!d || !fs.existsSync(d.dir)) return;
  try {
    const w = fs.watch(d.dir, { recursive: true }, (ev, name) => {
      if (name && /^\.taste-skill|^\./.test(String(name).replace(/\\/g, '/'))) return;
      clearTimeout(watching && watching.timer);
      if (watching) watching.timer = setTimeout(() => send('design:changed', { id, design: view_(d) }), 350);
    });
    watching = { id, watcher: w, timer: null };
  } catch {}
}
function unwatch() {
  if (!watching) return;
  clearTimeout(watching.timer);
  try { watching.watcher.close(); } catch {}
  watching = null;
}

// ─── Export: a picture or a PDF of the design ────────────────────────────────
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// A design loaded off-screen at an exact size. A window can't be taller than the
// screen, so the size is the page's own viewport, set through the DevTools
// protocol; that also lets a capture run past the viewport (a whole page).
async function withPage(url, { width, height, mobile = false }, fn) {
  const win = new BrowserWindow({
    show: false, width: Math.min(width, 1280), height: 800, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, partition: 'codeply-design-render', contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const dbg = win.webContents.debugger;
  const consoleErrors = [];
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3 && consoleErrors.length < 5) consoleErrors.push(message); });
  const js = (src) => win.webContents.executeJavaScript(src);
  try {
    // The override needs a page in place first (sent to an empty window, it crashes Electron 29).
    await win.loadURL('about:blank');
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (mobile) await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
    await win.loadURL(url);
    await js('document.fonts.ready.then(() => true)').catch(() => {});
    await wait(1300); // let the entrance choreography finish
    const pageHeight = async () => Math.max(height, await js('document.documentElement.scrollHeight').catch(() => height));
    // format 'jpeg' for the agent to look at, 'png' for an export; full = the whole page in one picture
    const shot = async ({ full = false, format = 'jpeg', scale = 1 } = {}) => {
      const total = full ? Math.min(await pageHeight(), height * 12, 16000) : height;
      // A clip (in page coordinates) is what scales a capture: the whole page, or the screen in view.
      const y = full ? 0 : await js('window.scrollY').catch(() => 0);
      const clipped = full || scale !== 1;
      const r = await dbg.sendCommand('Page.captureScreenshot', {
        format, ...(format === 'jpeg' ? { quality: 76 } : {}), captureBeyondViewport: clipped,
        ...(clipped ? { clip: { x: 0, y, width, height: total, scale } } : {}),
      });
      return r && r.data ? r.data : null;
    };
    const scrollTo = async (y) => { await js(`window.scrollTo({ top: ${y}, behavior: 'instant' })`).catch(() => {}); await wait(y ? 650 : 250); };
    return await fn({ js, shot, scrollTo, pageHeight, consoleErrors });
  } finally {
    try { dbg.detach(); } catch {}
    if (!win.isDestroyed()) win.close();
  }
}

/**
 * design_lint's render (codeply-cli/lib/design-tools.mjs, through main.js's
 * browserCheck.render): measured with the taste skill's probe, photographed
 * screen by screen (scrolling, so reveal-on-scroll content shows).
 */
async function renderForLint(url, { width = 1440, height = 900, probe = null, frame = null, screens = 1 } = {}) {
  try {
    return await withPage(url, { width, height, mobile: width < 700 }, async (p) => {
      const run = (src) => (src ? p.js(`(${src})()`).catch((e) => ({ error: e.message })) : null);
      const scale = width > 1000 ? 1000 / width : 1;
      const metrics = await run(probe);
      const images = [await p.shot({ full: false, scale })];
      const frames = [await run(frame)];
      const more = Math.min(Math.max(0, screens - 1), Math.ceil((await p.pageHeight()) / height) - 1);
      for (let i = 1; i <= more; i++) {
        await p.scrollTo(i * height);
        images.push(await p.shot({ full: false }));
        frames.push(await run(frame));
      }
      return { ok: true, metrics, frames, images: images.filter(Boolean).map((b) => 'data:image/jpeg;base64,' + b), consoleErrors: p.consoleErrors };
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Thumbnails for the sidebar and the start screen ───────────────────────────
// The first screen of the design, 480 wide, in .thumb.jpg (a dot file: never copied
// into a project or synced). Made after every finished run, and for any design without one.
const THUMB = '.thumb.jpg';
const thumbQueue = [];
let thumbBusy = false;
function thumbStale(v) {
  try { return fs.statSync(path.join(v.dir, THUMB)).mtimeMs + 2000 < fs.statSync(v.file).mtimeMs; } catch { return true; }
}
function thumbSoon(d, ms = 0) {
  if (!d || thumbQueue.includes(d.id)) return;
  setTimeout(() => { if (!thumbQueue.includes(d.id)) thumbQueue.push(d.id); nextThumb(); }, ms);
}
async function nextThumb() {
  if (thumbBusy || !thumbQueue.length) return;
  thumbBusy = true;
  const d = byId(thumbQueue.shift());
  try {
    const v = d && view_(d);
    if (v && v.ready) {
      const { w, h } = v.size;
      const data = await withPage(v.url, { width: w, height: h }, (p) => p.shot({ full: false, scale: 480 / w }));
      if (data) { fs.writeFileSync(path.join(d.dir, THUMB), Buffer.from(data, 'base64')); send('design:synced', {}); }
    }
  } catch (e) { console.warn('[design] thumbnail:', e.message); }
  thumbBusy = false;
  nextThumb();
}

async function renderPng(d, v) {
  const { w, h } = v.size;
  return withPage(v.url, { width: w, height: h }, async (p) => {
    // Walk the page once so anything that reveals on scroll is showing, then take it whole.
    const total = await p.pageHeight();
    for (let y = h; y < Math.min(total, h * 12); y += h) await p.scrollTo(y);
    await p.scrollTo(0);
    const data = await p.shot({ full: true, format: 'png' });
    return data ? Buffer.from(data, 'base64') : null;
  });
}

async function renderPdf(d, v) {
  const { w, h } = v.size;
  const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { partition: 'codeply-design-export' } });
  try {
    await win.loadFile(v.file);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => {});
    await wait(1000);
    // A page per slide or per document page, at their own size.
    if (v.kind === 'slides') await win.webContents.insertCSS('@page { size: 1280px 720px; margin: 0 } html, body { margin: 0 !important; background: none !important } .slide { break-after: page; margin: 0 !important; box-shadow: none !important; border-radius: 0 !important }');
    else if (v.kind === 'doc') await win.webContents.insertCSS('@page { margin: 0 } html, body { margin: 0 !important; background: none !important } .page { break-after: page; margin: 0 auto !important; box-shadow: none !important }');
    else await win.webContents.insertCSS(`@page { size: ${w}px ${h}px; margin: 0 }`);
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally { if (!win.isDestroyed()) win.close(); }
}

async function exportDesign(id, format) {
  const d = byId(id);
  if (!d) return { error: 'That design is gone.' };
  const v = view_(d);
  if (!v.ready) return { error: 'There is nothing to export yet.' };
  const ext = format === 'pdf' ? 'pdf' : 'png';
  const parent = viewHost && !viewHost.isDestroyed() ? viewHost : undefined;
  const pick = await dialog.showSaveDialog(parent, {
    title: `Export ${v.title}`, defaultPath: path.join(app.getPath('downloads'), `${slugOf(v.title)}.${ext}`),
    filters: [ext === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'PNG image', extensions: ['png'] }],
  });
  if (pick.canceled || !pick.filePath) return { canceled: true };
  const data = ext === 'pdf' ? await renderPdf(d, v) : await renderPng(d, v);
  if (!data) return { error: 'The design did not render.' };
  fs.writeFileSync(pick.filePath, data);
  shell.showItemInFolder(pick.filePath);
  return { ok: true, path: pick.filePath };
}

// ─── Build it in Craft: a new project with the design in it, and a Build chat ──
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue; // .taste-skill and other working files
    const a = path.join(from, e.name); const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

async function buildInCraft(id) {
  const d = byId(id);
  if (!d) return { error: 'That design is gone.' };
  const v = view_(d);
  if (!v.ready) return { error: 'Make the design first.' };
  const made = host.newProjectFolder(v.title);
  if (made.error) return made;
  copyDir(d.dir, path.join(made.cwd, 'design'));
  const what = v.kind === 'app' ? 'app' : 'website';
  const text = [
    `Build this design as a working ${what}: "${v.title}".${v.summary ? ` ${v.summary}` : ''}`,
    '',
    'The design is in design/index.html, with its pictures in design/assets/. Open it first and match it exactly: layout, type, colours, spacing, copy and pictures.',
    'Keep everything it shows. Make the parts that are only drawn really work (navigation, forms, buttons, tabs, states), and add whatever working needs.',
    what === 'website'
      ? 'Keep it a static site (HTML, CSS and a little JavaScript) unless something in it needs a server; say if it does.'
      : 'Pick a sensible stack for a real app, say which and why, and build the screens in the design first.',
  ].join('\n');
  const r = await host.startChatRun({ cwd: made.cwd, mode: 'Build', text, clientId: 'design' });
  if (!r || r.error) return r || { error: 'Craft could not start that.' };
  host.toCraft();
  host.openInCraft(r.sessionId);
  return { ok: true, sessionId: r.sessionId, cwd: made.cwd };
}

// ─── Sync: designs follow you to the phone (supabase/designs.sql) ─────────────
// A row in public.designs (title, kind, the chat in short, a version) and the
// files in the private "designs" bucket under <user id>/<design id>/. This PC
// pushes after every finished run and pulls newer designs (the phone's) when
// the tab opens. Until that SQL has been run, sync stays quietly off.
const BUCKET = 'designs';
// Set when the table or bucket is missing (the SQL not run yet, or the API still loading it): try again later.
let syncOffUntil = 0;
const pauseSync = () => { syncOffUntil = Date.now() + 5 * 60000; };
let lastPull = 0;
const CONTENT_TYPE = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
const missingTable = (msg) => /does not exist|could not find the table|schema cache|bucket not found/i.test(String(msg || ''));

async function account() {
  if (Date.now() < syncOffUntil || !host.supabase) return null;
  const c = host.supabase();
  const uid = c ? await host.userId() : null;
  return c && uid ? { c, uid } : null;
}

function localFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...localFiles(dir, r)); else out.push(r);
  }
  return out;
}

/** The chat in short, for the other device: what was asked and what came back. */
function shortChat(d) {
  const s = d.sessionId ? host.store().sessions.find((x) => x.id === d.sessionId) : null;
  if (!s) return Array.isArray(d.chat) ? d.chat : [];
  return s.messages.filter((m) => (m.kind === 'user' || m.kind === 'assistant') && m.text)
    .map((m) => ({ role: m.kind === 'user' ? 'user' : 'assistant', text: String(m.text).slice(0, 4000), at: m.at || 0 })).slice(-40);
}

const pushTimers = new Map();
function pushSoon(d, ms = 1500) {
  clearTimeout(pushTimers.get(d.id));
  pushTimers.set(d.id, setTimeout(() => { pushTimers.delete(d.id); push(d).catch((e) => console.warn('[design sync] push:', e.message)); }, ms));
}

async function push(d) {
  const a = await account();
  if (!a || !fs.existsSync(path.join(d.dir, 'index.html'))) return;
  const v = view_(d);
  const since = d.syncedAt || 0;
  for (const rel of localFiles(d.dir)) {
    const abs = path.join(d.dir, rel);
    const st = fs.statSync(abs);
    if (st.size > 10 * 1024 * 1024 || (rel !== 'index.html' && st.mtimeMs <= since)) continue;
    const { error } = await a.c.storage.from(BUCKET).upload(`${a.uid}/${d.id}/${rel}`, fs.readFileSync(abs), {
      upsert: true, contentType: CONTENT_TYPE[path.extname(rel).toLowerCase()] || 'application/octet-stream',
    });
    if (error) { if (missingTable(error.message)) { pauseSync(); return; } console.warn('[design sync] upload', rel, error.message); }
  }
  const version = (d.version || 0) + 1;
  const { error } = await a.c.from('designs').upsert({
    id: d.id, user_id: a.uid, title: v.title, kind: v.kind, summary: v.summary, chat: shortChat(d),
    origin: d.origin || 'pc', version, deleted: false, updated_at: new Date().toISOString(),
  });
  if (error) { if (missingTable(error.message)) pauseSync(); else console.warn('[design sync] row', error.message); return; }
  d.version = version; d.syncedAt = Date.now();
  host.saveStore();
}

async function remoteFiles(a, prefix) {
  const out = [];
  const { data, error } = await a.c.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) return out;
  for (const e of data || []) {
    if (!e.id) out.push(...await remoteFiles(a, `${prefix}/${e.name}`)); // a folder
    else out.push(`${prefix}/${e.name}`);
  }
  return out;
}

async function download(a, d) {
  const prefix = `${a.uid}/${d.id}`;
  for (const p of await remoteFiles(a, prefix)) {
    const rel = p.slice(prefix.length + 1);
    const abs = path.resolve(d.dir, rel);
    if (!abs.startsWith(path.resolve(d.dir) + path.sep)) continue; // never outside the design's folder
    const { data, error } = await a.c.storage.from(BUCKET).download(p);
    if (error || !data) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(await data.arrayBuffer()));
  }
}

/** Newer designs from the other device. Returns true when anything here changed. */
async function pull(force = false) {
  if (!force && Date.now() - lastPull < 20000) return false;
  lastPull = Date.now();
  const a = await account();
  if (!a) return false;
  const { data, error } = await a.c.from('designs').select('id, title, kind, summary, chat, origin, version, deleted, updated_at').order('updated_at', { ascending: false }).limit(300);
  if (error) { if (missingTable(error.message)) pauseSync(); return false; }
  let changed = false;
  for (const row of data || []) {
    let d = byId(row.id);
    if (row.deleted) {
      if (d) {
        try { if (fs.existsSync(d.dir)) await shell.trashItem(d.dir); } catch {}
        host.store().designs = records().filter((x) => x.id !== d.id);
        changed = true;
      }
      continue;
    }
    if (d && (d.version || 0) >= row.version) continue;
    if (d && d.sessionId && host.activeRunIds().includes(d.sessionId)) continue; // being designed here right now
    if (!d) {
      d = { id: row.id, dir: newFolder(row.title), title: row.title, kind: row.kind, origin: row.origin, createdAt: Date.parse(row.updated_at) || Date.now(), sessionId: null };
      records().unshift(d);
    }
    await download(a, d);
    Object.assign(d, { version: row.version, chat: row.chat || [], updatedAt: Date.parse(row.updated_at) || Date.now(), syncedAt: Date.now() });
    changed = true;
  }
  if (changed) host.saveStore();
  return changed;
}

async function removeRemote(d) {
  const a = await account();
  if (!a) return;
  await a.c.from('designs').update({ deleted: true, updated_at: new Date().toISOString() }).eq('id', d.id);
  const files = await remoteFiles(a, `${a.uid}/${d.id}`);
  if (files.length) await a.c.storage.from(BUCKET).remove(files);
}

// ─── The tab ─────────────────────────────────────────────────────────────────
function embed(win, bounds) {
  if (!view || view.webContents.isDestroyed()) {
    view = new BrowserView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    view.setBackgroundColor('#151515');
    view.webContents.loadFile(path.join(__dirname, 'index.html'));
    view.webContents.on('console-message', (e, level, message, line, src) => { if (level >= 2) console.log(`[design] ${message} (${src}:${line})`); });
    // Links in a design open in the browser, never inside Craft.
    view.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  }
  if (viewHost !== win) { if (viewHost && !viewHost.isDestroyed()) viewHost.removeBrowserView(view); win.addBrowserView(view); viewHost = win; }
  setBounds(bounds);
  send('design:shown', {});
}
function setBounds(b) {
  if (!view || !viewHost || !b) return;
  view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) });
}
function unembed() {
  if (view && viewHost && !viewHost.isDestroyed()) viewHost.removeBrowserView(view);
  viewHost = null;
  unwatch();
}

/** Every event of a design chat (main.js routes them here instead of Craft's chat). */
function event(sessionId, ev) {
  // A new design's first events come before its session id is saved: the session knows its design.
  const s = host.store().sessions.find((x) => x.id === sessionId);
  const d = (s && s.design ? byId(s.design) : null) || records().find((x) => x.sessionId === sessionId);
  if (d && !d.sessionId) d.sessionId = sessionId;
  if (d && (ev.type === 'run_finished' || ev.type === 'tool_end')) d.updatedAt = Date.now();
  if (d && ev.type === 'run_finished') { pushSoon(d); thumbSoon(d, 600); }
  send('design:event', { sessionId, designId: d ? d.id : null, ...ev });
}
function runs(active) { send('design:runs', active); }

function init(h) {
  host = h;

  protocol.handle(SCHEME, (req) => {
    const u = new URL(req.url);
    const d = byId(u.hostname);
    if (!d) return new Response('Not found', { status: 404 });
    const root = path.resolve(d.dir);
    const abs = path.resolve(root, decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html');
    if (!abs.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(abs).href);
  });

  ipcMain.handle('design:list', () => {
    // Newer designs from the phone come down in the background; the page reloads its list when they land.
    pull().then((changed) => { if (changed) send('design:synced', {}); }).catch(() => {});
    return { designs: list(), kinds: KINDS };
  });
  ipcMain.handle('design:create', (e, { text, kind, images } = {}) => createDesign(text, kind, 'pc', images));
  ipcMain.handle('design:send', (e, { id, text, images } = {}) => sendTo(id, text, images));
  ipcMain.handle('design:open', (e, id) => {
    const d = byId(id);
    if (!d) return null;
    watch(id);
    const s = d.sessionId ? host.store().sessions.find((x) => x.id === d.sessionId) : null;
    // A design made on the phone has no chat here yet: show the synced one.
    const messages = s ? s.messages.slice(-120) : (d.chat || []).map((m) => ({ kind: m.role === 'user' ? 'user' : 'assistant', text: m.text }));
    return { design: view_(d), messages, running: !!s && host.activeRunIds().includes(s.id) };
  });
  ipcMain.on('design:close', () => unwatch());
  ipcMain.on('design:stop', (e, id) => { const d = byId(id); if (d && d.sessionId) host.stopChatRun(d.sessionId); });
  ipcMain.on('design:approve', (e, { requestId, verdict }) => host.respondApproval(requestId, verdict));
  ipcMain.on('design:answer', (e, { requestId, answer }) => host.respondQuestion(requestId, answer));
  ipcMain.handle('design:rename', (e, { id, title } = {}) => {
    const d = byId(id);
    title = String(title || '').trim().slice(0, 120);
    if (!d || !title) return null;
    const file = path.join(d.dir, 'design.json');
    const j = readJson(file) || {};
    j.title = title; d.title = title;
    try { fs.writeFileSync(file, JSON.stringify(j, null, 2)); } catch {}
    host.saveStore();
    pushSoon(d, 300);
    return view_(d);
  });
  ipcMain.handle('design:delete', async (e, id) => {
    const d = byId(id);
    if (!d) return { ok: true };
    if (d.sessionId) host.stopChatRun(d.sessionId);
    if (watching && watching.id === id) unwatch();
    // To the Recycle Bin / Trash, so a slip can be undone there.
    try { if (fs.existsSync(d.dir)) await shell.trashItem(d.dir); } catch (err) { return { error: `Could not move it to the trash: ${err.message}` }; }
    host.store().designs = records().filter((x) => x.id !== id);
    if (d.sessionId) host.deleteSession(d.sessionId);
    host.saveStore();
    removeRemote(d).catch((err) => console.warn('[design sync] delete:', err.message));
    return { ok: true };
  });
  ipcMain.on('design:reveal', (e, id) => { const d = byId(id); if (d) shell.showItemInFolder(path.join(d.dir, 'index.html')); });
  // In the default browser (the file's own app), as the real page.
  ipcMain.on('design:openFile', (e, id) => { const d = byId(id); if (d && fs.existsSync(path.join(d.dir, 'index.html'))) shell.openPath(path.join(d.dir, 'index.html')); });
  ipcMain.on('design:openFolder', () => { fs.mkdirSync(base(), { recursive: true }); shell.openPath(base()); });
  ipcMain.handle('design:export', (e, { id, format } = {}) => exportDesign(id, format).catch((err) => ({ error: err.message })));
  ipcMain.handle('design:build', (e, id) => buildInCraft(id).catch((err) => ({ error: err.message })));
  ipcMain.on('design:toCraft', () => host.toCraft());
  ipcMain.on('design:toCrew', () => host.toCrew());
}

// ─── Actions the page and the phone (main.js /api/design/*) both use ──────────
async function createDesign(text, kind, origin = 'pc', images) {
  text = String(text || '').trim();
  if (!text) return { error: 'Say what to design.' };
  const k = KINDS.includes(kind) ? kind : null;
  const d = { id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), dir: newFolder(text), title: text.slice(0, 60), kind: k || 'website', origin, createdAt: Date.now(), updatedAt: Date.now(), sessionId: null };
  records().unshift(d);
  host.saveStore();
  const r = await sendMessage(d, k ? `Make a ${k === 'doc' ? 'document' : k === 'social' ? 'social post' : k} design: ${text}` : text, images);
  return { ...r, design: view_(d) };
}
async function sendTo(id, text, images) {
  if (!byId(id)) await pull(true); // made on the phone a moment ago
  const d = byId(id);
  if (!d) return { error: 'That design is gone.' };
  text = String(text || '').trim();
  if (!text) return { error: 'Write a message first.' };
  const r = await sendMessage(d, text, images);
  return { ...r, design: view_(d) };
}
/** For the phone while this PC works on a design: is it running, what is it doing, what was said. */
function designState(id) {
  const d = byId(id);
  if (!d) return null;
  const v = view_(d);
  const s = d.sessionId ? host.store().sessions.find((x) => x.id === d.sessionId) : null;
  const tools = s ? s.messages.filter((m) => m.kind === 'tool').slice(-1) : [];
  return { id: d.id, title: v.title, kind: v.kind, summary: v.summary, running: v.running, version: d.version || 0, lastStep: tools[0] ? tools[0].name : null, chat: shortChat(d) };
}
/** The design for the phone to show, with its pictures inlined (works before sync is set up). */
function inlineHtml(id) {
  const d = byId(id);
  if (!d) return null;
  const file = path.join(d.dir, 'index.html');
  if (!fs.existsSync(file)) return { html: '', version: d.version || 0 };
  let budget = 3 * 1024 * 1024;
  const root = path.resolve(d.dir) + path.sep;
  const html = fs.readFileSync(file, 'utf8').replace(/(["'(])((?:\.\/)?assets\/[^"')?#\s]+)/g, (m, q, rel) => {
    const abs = path.resolve(d.dir, rel);
    if (!abs.startsWith(root) || !fs.existsSync(abs)) return m;
    const buf = fs.readFileSync(abs);
    if (buf.length > budget) return m;
    budget -= buf.length;
    return `${q}data:${CONTENT_TYPE[path.extname(abs).toLowerCase()] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
  });
  return { html, version: d.version || 0, title: view_(d).title, kind: view_(d).kind };
}
/** Build it in Craft from the phone. A design made on the phone arrives with its HTML when sync isn't set up. */
async function buildFromPhone(id, from = {}) {
  if (!byId(id)) await pull(true);
  if (!byId(id) && from.html) {
    const d = { id, dir: newFolder(from.title || 'design'), title: String(from.title || 'Untitled design').slice(0, 120), kind: KINDS.includes(from.kind) ? from.kind : 'website', origin: 'phone', createdAt: Date.now(), updatedAt: Date.now(), sessionId: null };
    fs.writeFileSync(path.join(d.dir, 'index.html'), String(from.html));
    fs.writeFileSync(path.join(d.dir, 'design.json'), JSON.stringify({ title: d.title, kind: d.kind, summary: '' }, null, 2));
    records().unshift(d);
    host.saveStore();
  }
  return buildInCraft(id);
}
function stopDesign(id) { const d = byId(id); if (d && d.sessionId) host.stopChatRun(d.sessionId); }

/** The session ids of every design chat (main.js keeps them out of Craft's lists). */
function sessionIds() { return new Set(records().map((d) => d.sessionId).filter(Boolean)); }

module.exports = { init, embed, setBounds, unembed, event, runs, sessionIds, KINDS, createDesign, sendTo, designState, buildFromPhone, stopDesign, pull, exportDesign, renderForLint, inlineHtml };
