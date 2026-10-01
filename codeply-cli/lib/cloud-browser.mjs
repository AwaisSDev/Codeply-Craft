/**
 * A real browser for the cloud runner: headless Chrome (preinstalled on
 * GitHub's ubuntu runners), driven over the DevTools protocol with Node's own
 * WebSocket, so browser_check works in the cloud the way it does in the app:
 * console errors, failed requests, broken images, sideways scroll, and a
 * screenshot the model looks at and the chat shows.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const VIEWPORTS = { desktop: { width: 1280, height: 800, mobile: false }, tablet: { width: 768, height: 1024, mobile: true }, mobile: { width: 390, height: 844, mobile: true } };
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export function findChrome() {
  return CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function viewportFor(v) {
  const key = String(v || 'desktop').toLowerCase();
  if (VIEWPORTS[key]) return { name: key, ...VIEWPORTS[key] };
  const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(key);
  if (m) return { name: `${m[1]}x${m[2]}`, width: Number(m[1]), height: Number(m[2]), mobile: Number(m[1]) < 1024 };
  return { name: 'desktop', ...VIEWPORTS.desktop };
}

/** One DevTools connection: send(method, params) and on(event, fn). */
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    ws.onopen = () => resolve({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const msgId = ++id;
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      on: (event, fn) => handlers.set(event, [...(handlers.get(event) || []), fn]),
      close: () => { try { ws.close(); } catch {} },
    });
    ws.onerror = () => reject(new Error('Could not talk to Chrome.'));
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
      } else if (msg.method) for (const fn of handlers.get(msg.method) || []) fn(msg.params, msg.sessionId);
    };
  });
}

/**
 * makeCloudBrowser() returns a browser(url, { wait, viewport }) function for
 * the agent, or null when no Chrome is installed. Each check gets a fresh tab;
 * Chrome itself starts once and is closed by close().
 */
export function makeCloudBrowser({ chromePath = findChrome(), shotsDir = path.join(os.tmpdir(), 'craft-shots') } = {}) {
  if (!chromePath) return null;
  let started = null;
  let shot = 0;
  const start = () => {
    if (started) return started;
    started = (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-chrome-'));
      const proc = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
        '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
      const portFile = path.join(dir, 'DevToolsActivePort');
      for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
      if (!fs.existsSync(portFile)) { proc.kill(); throw new Error('Chrome did not start.'); }
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      const conn = await cdp(`ws://127.0.0.1:${port}${wsPath}`);
      return { proc, conn, dir };
    })();
    return started;
  };

  const browser = async (url, { wait = 1200, viewport } = {}) => {
    const { conn } = await start();
    const vp = viewportFor(viewport);
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => conn.send(m, p, sessionId);
    const consoleErrors = []; const consoleWarnings = []; const failedRequests = [];
    conn.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid !== sessionId) return;
      const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300);
      if (p.type === 'error') consoleErrors.push(text); else if (p.type === 'warning') consoleWarnings.push(text);
    });
    conn.on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) consoleErrors.push(String((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text).split('\n')[0].slice(0, 300)); });
    conn.on('Network.responseReceived', (p, sid) => { if (sid === sessionId && p.response.status >= 400) failedRequests.push(`HTTP ${p.response.status} - ${p.response.url}`); });
    conn.on('Network.loadingFailed', (p, sid) => { if (sid === sessionId && !p.canceled) failedRequests.push(`${p.errorText} - request ${p.requestId}`); });
    try {
      await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
      await s('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
      if (vp.mobile) await s('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
      const loaded = new Promise((r) => { conn.on('Page.loadEventFired', (p, sid) => { if (sid === sessionId) r(); }); setTimeout(r, 15000); });
      const nav = await s('Page.navigate', { url });
      if (nav.errorText) return { ok: false, error: nav.errorText };
      await loaded;
      await new Promise((r) => setTimeout(r, Math.min(8000, wait)));
      const { result } = await s('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const w = document.documentElement.scrollWidth, vw = window.innerWidth;
          const wide = w > vw + 1 ? [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > vw + 1).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')) : [];
          return { title: document.title, text: (document.body && document.body.innerText || '').slice(0, 3000),
            brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src).slice(0, 20),
            pageWidth: w, viewportWidth: vw, overflowX: w > vw + 1, wideElements: wide,
            hasViewportMeta: !!document.querySelector('meta[name="viewport"]') };
        })()`,
      });
      const shotData = await s('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(shotsDir, { recursive: true });
      const screenshotPath = path.join(shotsDir, `check-${++shot}.png`);
      fs.writeFileSync(screenshotPath, Buffer.from(shotData.data, 'base64'));
      return {
        ok: true, ...result.value, viewport: `${vp.name} ${vp.width}x${vp.height}`,
        consoleErrors, consoleWarnings, failedRequests,
        screenshotPath, screenshotDataUrl: `data:image/png;base64,${shotData.data}`,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      conn.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  };
  browser.close = async () => {
    if (!started) return;
    try { const { proc, conn } = await started; conn.close(); proc.kill(); } catch {}
  };
  return browser;
}
