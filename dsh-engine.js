// The DSH engine: Craft's second engine, switchable with Classic in the title bar.
//
// craft-dsh/ is a fork of DeepSeek Harness (MIT, see craft-dsh/LICENSE and
// THIRD_PARTY_NOTICES.md), rebranded as Craft. Picking DSH here:
//   - starts a loopback Haze bridge in this process (POST /haze, per-launch
//     secret). The engine's llm-haze adapter calls it, and it answers through
//     ai.chat() with route.auto, so sign-in, token refresh, the device id,
//     Haze routing state, limits and the direct fallback stay in Craft and no
//     account token ever reaches the engine
//   - starts `dsh --profile web` on 127.0.0.1 with its own home
//     (~/.codeply/dsh), waits for its "dsh web: <url>" ready line, and lays its
//     UI over the main area like Crew and Design
// Classic is codeply-cli, untouched. The DSH engine needs Node 24.9+ (Craft's
// Electron ships Node 20), so it runs on the system `node` or CODEPLY_DSH_NODE.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { BrowserView, shell } = require('electron');

const READY_TIMEOUT_MS = 90_000;
const MIN_NODE = [24, 9];

let host = null;          // { ipcMain, window, aiLib, ensureEngine, account, browser, cloud, models, userDataDir, isPackaged, resourcesPath }
let engine = 'classic';   // 'classic' | 'dsh'
let proc = null;          // the dsh child process
let url = null;           // authenticated Web UI url once ready
let starting = null;      // Promise of the start in flight
let lastError = null;
let logTail = '';
let bridge = null;        // { server, url, token }
let view = null;
let viewHost = null;

const prefsFile = () => path.join(host.userDataDir, 'dsh-engine.json');
const dshDir = () => (host.isPackaged ? path.join(host.resourcesPath, 'craft-dsh') : path.join(__dirname, 'craft-dsh'));
const dshHome = () => path.join(os.homedir(), '.codeply', 'dsh');

// The New app is retired: Craft is Classic's UI, and Classic's chats run on
// the DSH harness (dsh-chat.js). A saved "New" choice no longer applies.
function loadPrefs() {
  engine = 'classic';
}
function savePrefs() {
  try { fs.writeFileSync(prefsFile(), JSON.stringify({ engine }, null, 2)); } catch {}
}

/** Dev mode: CODEPLY_DSH_DEV=1, or a `.craft-dev` file in craft-dsh. Never in the installed app. */
function devMode() {
  if (host.isPackaged) return false;
  return process.env.CODEPLY_DSH_DEV === '1' || fs.existsSync(path.join(dshDir(), '.craft-dev'));
}

/** The Node that runs the engine: CODEPLY_DSH_NODE, else `node` on PATH, if it is new enough. */
async function findNode() {
  const bin = process.env.CODEPLY_DSH_NODE || 'node';
  let v = '';
  try {
    v = await new Promise((resolve, reject) => {
      execFile(bin, ['-v'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
    });
  } catch {
    return { error: `Codeply's engine needs Node ${MIN_NODE.join('.')} or newer, and no \`node\` was found. Install Node 24 or set CODEPLY_DSH_NODE.` };
  }
  const [maj, min] = v.replace(/^v/, '').split('.').map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
    return { error: `Codeply's engine needs Node ${MIN_NODE.join('.')} or newer; this PC has ${v}.` };
  }
  return { bin };
}

// ─── Haze bridge ───────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req, token) {
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function startBridge() {
  if (bridge) return Promise.resolve(bridge);
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const cloudRoute = /^\/cloud\/(start|status|apply|cancel)$/.exec(req.url || '');
    const modelsRoute = req.method === 'GET' && req.url === '/models';
    if (!modelsRoute && (req.method !== 'POST' || (req.url !== '/haze' && !cloudRoute))) return reply(404, { success: false, error: 'Not found.' });
    if (!authorized(req, token)) return reply(401, { success: false, error: 'Unauthorized.' });
    // Your own models for the engine's picker: names only, never a key.
    if (modelsRoute) {
      try {
        const state = await host.models.list();
        return reply(200, { models: (state.models || []).map((m) => ({ id: m.id, name: m.name || m.model, model: m.model, kind: m.kind })) });
      } catch (e) {
        return reply(200, { models: [] });
      }
    }
    // Craft Cloud for the new Craft's "Craft Cloud" model (cloud-desktop.js does the work).
    if (cloudRoute) {
      try {
        const body = JSON.parse(await readBody(req));
        const cloud = host.cloud();
        const cwd = String(body.cwd || '');
        const taskId = String(body.taskId || '');
        if (!cwd) return reply(400, { error: 'No project folder.' });
        const action = cloudRoute[1];
        const r = action === 'start' ? await cloud.startTask({ cwd, prompt: String(body.prompt || ''), sessionId: String(body.sessionId || '') })
          : action === 'status' ? await cloud.taskStatus({ cwd, taskId })
          : action === 'apply' ? await cloud.applyTask(cwd, taskId)
          : await cloud.cancelTask({ cwd, taskId });
        return reply(200, r || { error: 'No answer from the cloud.' });
      } catch (e) {
        return reply(500, { error: e && e.message ? e.message : String(e) });
      }
    }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const body = JSON.parse(await readBody(req));
      if (!host.aiLib()) await host.ensureEngine();
      const ai = host.aiLib();
      if (!ai) return reply(503, { success: false, unreachable: true, error: 'Codeply\'s engine is still loading.' });
      const h = body.haze || {};
      // One of your own models when the engine asks for it by id, else Haze 2.
      const ownId = typeof body.modelId === 'string' ? body.modelId : '';
      const own = ownId ? await host.models.get(ownId) : null;
      if (ownId && !own) return reply(200, { success: false, error: 'That model is no longer in Codeply. Pick another one.' });
      const r = await ai.chat(Array.isArray(body.messages) ? body.messages : [], {
        route: own ? { custom: own } : { auto: true },
        ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
        ...(Number.isFinite(body.maxTokens) ? { maxTokens: body.maxTokens } : {}),
        ...(Number.isFinite(body.temperature) ? { temperature: body.temperature } : {}),
        haze: {
          product: 'craft',
          surface: 'agent',
          chatId: `dsh:${String(body.chatId || 'none')}`,
          turnId: String(h.turnId || ''),
          step: Number(h.step) || 0,
          historyCount: Number(h.historyCount) || 0,
        },
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      reply(200, r && typeof r === 'object' ? r : { success: false, error: 'Haze 2 returned nothing.' });
    } catch (e) {
      if (!ac.signal.aborted) reply(500, { success: false, error: e && e.message ? e.message : String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      bridge = { server, token, url: `http://127.0.0.1:${server.address().port}/haze` };
      resolve(bridge);
    });
  });
}

// ─── The engine process ────────────────────────────────────────────────────
function status() {
  return { engine, running: !!url, starting: !!starting, url, error: lastError };
}

function start() {
  if (url) return Promise.resolve(status());
  if (starting) return starting;
  lastError = null;
  starting = (async () => {
    const dir = dshDir();
    const bin = path.join(dir, 'apps', 'cli', 'lib', 'bin.js');
    if (!fs.existsSync(bin)) throw new Error("Codeply's engine is not built yet. In craft-dsh: pnpm install, then pnpm run build.");
    const node = await findNode();
    if (node.error) throw new Error(node.error);
    const b = await startBridge();
    fs.mkdirSync(dshHome(), { recursive: true });
    logTail = '';
    const webArgs = ['--no-open', '--host', '127.0.0.1', '--port', '0'];
    // Dev mode (testing): the engine runs from source and the UI rebuilds only
    // the package you edit, then reloads itself, so no full build per change.
    // Needs one full build first; never in the installed app.
    const dev = devMode();
    // The engine runs from source, so add-on edits only need a restart. No UI
    // watchers: on an 8 GB PC they ran memory out and served half-written
    // bundles. An edited UI package is rebuilt on its own instead (see
    // CRAFT-FORK.md, "Testing without a full build"); the page reloads itself.
    if (dev) console.log('[dsh] dev mode: engine from source');
    const args = dev
      ? ['--import', 'tsx/esm', path.join('apps', 'cli', 'src', 'bin.ts'), '--profile', 'web', ...webArgs]
      : [bin, '--profile', 'web', ...webArgs];
    proc = spawn(node.bin, args, {
      cwd: dir,
      windowsHide: true,
      env: {
        ...process.env,
        DSH_HOME: dshHome(),
        // Classic's ~/.codeply/AGENTS.md and ~/.codeply/skills, so both engines read the same ones.
        DSH_AGENTS_HOME: path.join(os.homedir(), '.codeply'),
        CODEPLY_HAZE_BRIDGE_URL: b.url,
        CODEPLY_HAZE_BRIDGE_TOKEN: b.token,
        NO_COLOR: '1',
      },
    });
    const child = proc;
    return await new Promise((resolve, reject) => {
      // Dev mode compiles the engine from source on start, so it gets longer.
      const timer = setTimeout(() => reject(new Error("Codeply's engine took too long to start.")), dev ? READY_TIMEOUT_MS * 4 : READY_TIMEOUT_MS);
      const onData = (chunk) => {
        const text = chunk.toString();
        logTail = (logTail + text).slice(-4000);
        const m = /dsh web: (https?:\/\/\S+)/.exec(logTail);
        if (m && !url) {
          clearTimeout(timer);
          url = m[1];
          console.log(`[dsh] ready on ${new URL(url).host}`); // the url's token stays out of the log
          ensureView(); // load the page now, so showing it later is instant
          resolve(status());
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (proc === child) { proc = null; url = null; }
        const last = logTail.trim().split(/\r?\n/).slice(-3).join(' ');
        console.log(`[dsh] engine exited (${code})${last ? `: ${last}` : ''}`);
        reject(new Error(`Codeply's engine stopped (exit ${code}). ${last}`.trim()));
      });
    });
  })().catch((e) => {
    lastError = e.message;
    stop();
    throw e;
  }).finally(() => { starting = null; });
  return starting;
}

function stop() {
  const child = proc;
  proc = null;
  url = null;
  unembed();
  if (view) { try { view.webContents.close(); } catch {} view = null; }
  if (!child || child.exitCode !== null) return;
  console.log('[dsh] stopping the engine');
  // The engine spawns its own workers: end the whole tree.
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

// ─── The view over the main area ───────────────────────────────────────────
function ensureView() {
  if (!url) return;
  if (!view || view.webContents.isDestroyed()) {
    // backgroundThrottling off: as a view stacked on the window it can be taken
    // for hidden, and throttled frames and timers feel like lag.
    view = new BrowserView({ webPreferences: { partition: 'persist:craft-dsh', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname, 'dsh-preload.js') } });
    view.setBackgroundColor('#151515');
    // Only the engine's own pages load in the view; every other link opens in the browser.
    const own = (u) => { try { return new URL(u).origin === new URL(url).origin; } catch { return false; } };
    view.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
    view.webContents.on('will-navigate', (e, u) => { if (!own(u)) { e.preventDefault(); if (/^https?:\/\//i.test(u)) shell.openExternal(u); } });
    view.webContents.loadURL(url);
  }
}
function embed(win, bounds) {
  if (!url || !win || win.isDestroyed()) return false;
  ensureView();
  if (viewHost !== win) { if (viewHost && !viewHost.isDestroyed()) viewHost.removeBrowserView(view); win.addBrowserView(view); viewHost = win; }
  setBounds(bounds);
  return true;
}
function setBounds(b) {
  if (!view || !viewHost || !b) return;
  view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) });
}
function unembed() {
  if (view && viewHost && !viewHost.isDestroyed()) viewHost.removeBrowserView(view);
  viewHost = null;
}

function init(h) {
  host = h;
  loadPrefs();
  const { ipcMain } = h;
  ipcMain.handle('dsh:status', () => status());
  ipcMain.handle('dsh:setEngine', (e, which) => {
    engine = which === 'dsh' ? 'dsh' : 'classic';
    console.log(`[dsh] engine set to ${engine}`);
    savePrefs();
    if (engine === 'classic') stop();
    return status();
  });
  // Starts the engine if needed, then lays its UI over the given area.
  ipcMain.handle('dsh:embed', async (e, bounds) => {
    try {
      await start();
      const win = h.window();
      return { ...status(), shown: embed(win, bounds) };
    } catch (err) {
      return { ...status(), error: err.message };
    }
  });
  ipcMain.on('dsh:bounds', (e, bounds) => setBounds(bounds));
  ipcMain.handle('dsh:unembed', () => { unembed(); return status(); });
  // What the new Craft's page may ask of Craft (dsh-preload.js). Only that page:
  // any other sender is refused.
  const fromView = (e) => !!view && !view.webContents.isDestroyed() && e.sender === view.webContents;
  ipcMain.handle('dsh:host:account', async (e) => {
    if (!fromView(e)) return null;
    try {
      const user = (await h.account()) || null;
      if (!user) return { signedIn: false };
      const meta = user.user_metadata || {};
      return { signedIn: true, email: user.email || '', name: meta.full_name || meta.name || (user.email || '').split('@')[0], avatarUrl: meta.avatar_url || meta.picture || '' };
    } catch { return { signedIn: false }; }
  });
  ipcMain.handle('dsh:host:openBrowser', (e, url) => {
    if (!fromView(e)) return false;
    h.browser.open(/^https?:\/\//i.test(String(url || '')) ? url : '');
    return true;
  });
  ipcMain.handle('dsh:host:toggleBrowser', (e) => { if (!fromView(e)) return false; h.browser.toggle(); return true; });
  // Your own models from the page's Settings: list, add or edit (tested first), remove, find Ollama models.
  ipcMain.handle('dsh:host:models', async (e, action, arg) => {
    if (!fromView(e)) return { ok: false, error: 'Not allowed.' };
    try {
      if (action === 'list') return { ok: true, state: await h.models.list() };
      if (action === 'save') return await h.models.save(arg && typeof arg === 'object' ? arg : {});
      if (action === 'remove') return await h.models.remove(String(arg || ''));
      if (action === 'detectOllama') return await h.models.detectOllama(String(arg || ''));
      return { ok: false, error: 'Unknown action.' };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  // From Craft's own window: text and an image for the new Craft's composer.
  ipcMain.handle('dsh:insert', (e, payload) => {
    const win = h.window();
    if (!win || e.sender !== win.webContents || !view || view.webContents.isDestroyed()) return false;
    const text = typeof payload?.text === 'string' ? payload.text.slice(0, 4000) : '';
    const image = typeof payload?.image === 'string' && payload.image.startsWith('data:image/') ? payload.image : '';
    view.webContents.focus();
    view.webContents.send('dsh:host:insert', { text, image });
    return true;
  });
  // A restart puts the view back where it was, so the engine doesn't vanish from the window.
  ipcMain.handle('dsh:restart', async () => {
    const shownAt = viewHost && view ? view.getBounds() : null;
    stop();
    try { await start(); } catch {}
    if (shownAt) embed(h.window(), shownAt);
    return status();
  });
}

function dispose() {
  stop();
  if (bridge) { try { bridge.server.close(); } catch {} bridge = null; }
}

module.exports = { init, dispose, status };
