// Voice mode self-test for a built app: `CRAFT_VOICE_SELFTEST=<report.json>`.
//
// A packaged build bundles things differently from `npm start` (the asar archive,
// unpacked native modules, a utility process), and a missing file there breaks
// voice for everyone. This loads every piece the way the real app does, writes a
// report, and exits 0 when everything that must work works. Things that need the
// internet and can be refused by a third party (voices, web search) are warnings.
const { app, BrowserWindow, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
// The engine sits next to the archive in a build, like main.js's CLI_DIR.
const CLI_DIR = app.isPackaged ? path.join(process.resourcesPath, 'codeply-cli') : path.join(ROOT, 'codeply-cli');
const OUT = process.env.CRAFT_VOICE_SELFTEST;
// Its own profile: a Craft that's already running keeps the real one locked.
app.setPath('userData', path.join(os.tmpdir(), `craft-voice-selftest-profile-${process.pid}`));
// Closing its test window must not quit before the report is written.
app.on('window-all-closed', () => {});
const results = [];
const step = async (name, fn, { warnOnly = false, timeoutMs = 60000 } = {}) => {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs))]);
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail == null ? '' : String(detail).slice(0, 300) });
  } catch (e) {
    results.push({ name, ok: false, warnOnly, ms: Date.now() - t0, detail: String((e && e.message) || e).slice(0, 300) });
  }
};

app.whenReady().then(async () => {
  await step('key hook (uiohook-napi) loads', () => {
    const m = require('uiohook-napi');
    if (!m.uIOhook || !m.UiohookKey || !m.UiohookKey.C) throw new Error('module loaded without its key table');
    return `C=${m.UiohookKey.C}`;
  });

  await step('voice modules load', () => {
    for (const f of ['voice-mode.js', 'voice/act.js', 'voice/tools.js', 'crew/voice.js']) require(path.join(ROOT, f));
    return 'voice-mode, act, tools, crew/voice';
  });

  await step('overlay page, KaTeX and its fonts', async () => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'voice', 'preload.js'), contextIsolation: true } });
    await w.loadFile(path.join(ROOT, 'voice', 'overlay.html'), { query: { display: '0', audio: '0' } });
    const r = await w.webContents.executeJavaScript(`({
      katex: typeof katex === 'object' && katex.renderToString('E = mc^2').includes('katex'),
      bridge: typeof window.voice === 'object',
      css: getComputedStyle(document.querySelector('.bubble')).position,
      knot: !!document.querySelector('.knot svg path'),
    })`);
    w.destroy();
    if (!r.katex) throw new Error('KaTeX did not load');
    if (!r.bridge) throw new Error('the preload bridge is missing');
    if (!r.knot) throw new Error('the buddy markup is missing');
    return `katex ok, bridge ok, bubble ${r.css}`;
  });

  await step('file commands in the user folder', async () => {
    const tools = require(path.join(ROOT, 'voice', 'tools.js'));
    const base = path.join(os.homedir(), `craft-voice-selftest-${process.pid}`);
    fs.mkdirSync(path.join(base, 'a'), { recursive: true });
    fs.writeFileSync(path.join(base, 'a', 'x.jpg'), 'x');
    const moved = await tools.run('MOVEFILE', `${base}\\a\\*|${base}\\b`.replace(/\\/g, path.sep), CLI_DIR);
    const removed = await tools.run('RMDIR', path.join(base, 'a'), CLI_DIR);
    const ok = fs.existsSync(path.join(base, 'b', 'x.jpg')) && !fs.existsSync(path.join(base, 'a'));
    fs.rmSync(base, { recursive: true, force: true });
    if (!ok) throw new Error(`${moved} / ${removed}`);
    return 'move and remove-empty-folder work';
  });

  if (process.platform === 'win32') {
    await step('click helper starts and reads the keyboard', async () => {
      const act = require(path.join(ROOT, 'voice', 'act.js'));
      act.warm();
      for (let i = 0; i < 60; i++) { const h = await act.held(); if (h) { act.dispose(); return `held() = ${JSON.stringify(h)}`; } await new Promise((r) => setTimeout(r, 500)); }
      throw new Error('the PowerShell helper never answered');
    }, { timeoutMs: 45000 });
  }

  if (process.platform === 'darwin') {
    // Moves the mouse to where it already is: runs osascript and the CoreGraphics
    // bridge every click goes through. (Without Accessibility the event is dropped, not an error.)
    await step('mouse helper (osascript + CoreGraphics) runs', async () => {
      const { screen } = require('electron');
      const act = require(path.join(ROOT, 'voice', 'act.js'));
      const p = screen.getCursorScreenPoint();
      await act.move(p.x, p.y);
      return `moved to ${p.x},${p.y}`;
    }, { timeoutMs: 20000 });
  }

  await step('speech to text in its own process (downloads Whisper the first time)', () => new Promise((resolve, reject) => {
    const cache = path.join(os.tmpdir(), 'craft-voice-selftest-models');
    const p = utilityProcess.fork(path.join(ROOT, 'voice', 'stt-process.js'), [cache], { serviceName: 'Craft voice selftest' });
    p.on('message', (m) => {
      if (!m) return;
      if (m.type === 'ready') p.postMessage({ type: 'transcribe', id: 't', pcm: new Float32Array(16000) });
      else if (m.type === 'result') { p.kill(); resolve(`model ready, transcribed 1s of silence in ${m.ms}ms`); }
      else if (m.type === 'error') { p.kill(); reject(new Error(m.error)); }
    });
    p.on('exit', (code) => reject(new Error(`speech process exited (${code})`)));
    p.postMessage({ type: 'load' });
  }), { timeoutMs: 300000 });

  await step('a voice (Edge, free)', async () => {
    const v = require(path.join(ROOT, 'crew', 'voice.js'));
    v.init({ cacheDir: path.join(os.tmpdir(), 'craft-voice-selftest-models') });
    const r = await v.speak('Hi.', { engine: 'edge', voice: 'en-US-AvaMultilingualNeural', offline: false });
    return `${r.mime}, ${r.data.length} bytes`;
  }, { warnOnly: true, timeoutMs: 30000 });

  // Offline and must pass: a missing engine file is a packaging bug, not a search outage.
  await step('engine web tools are in the build', () => {
    const web = require(path.join(CLI_DIR, 'lib', 'web-tools.js'));
    if (typeof web.webSearch !== 'function' || typeof web.fetchPage !== 'function') throw new Error('web-tools.js has no webSearch/fetchPage');
    return CLI_DIR;
  });

  await step('web search', async () => {
    const tools = require(path.join(ROOT, 'voice', 'tools.js'));
    const r = await tools.run('SEARCH', 'capital of Peru', CLI_DIR);
    if (/failed:/.test(r.split('\n')[0])) throw new Error(r.split('\n')[0]);
    return r.split('\n')[0];
  }, { warnOnly: true, timeoutMs: 30000 });

  const failed = results.filter((r) => !r.ok && !r.warnOnly);
  const report = { ok: failed.length === 0, platform: process.platform, arch: process.arch, packaged: app.isPackaged, electron: process.versions.electron, results };
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (OUT && OUT !== '1') { try { fs.writeFileSync(OUT, text); } catch (e) { console.error('could not write the report:', e.message); } }
  app.exit(failed.length ? 1 : 0);
});
