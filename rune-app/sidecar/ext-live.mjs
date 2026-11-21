// Live Server and port sharing for the code view, as VS Code's Live Server and Ports panel do.
//
// Live Server serves the project folder on 127.0.0.1 (port 5500 or the next free one), puts a
// small script in every HTML page it sends, and tells those pages to reload when a file in the
// folder changes (a CSS change swaps the stylesheets without a reload).
//
// Sharing a port starts a tunnel to it: cloudflared ("quick tunnel", a trycloudflare.com address)
// when it's installed, else ssh to localhost.run (an lhr.life address). Neither: it says what to
// install.
//
//   POST /ext/live/start { file }     -> { live: { port, root }, url } | { error }
//   POST /ext/live/stop               -> { live: null }
//   POST /ext/live/status             -> { live, forwards, tools: { cloudflared, ssh } }
//   POST /ext/live/forward { port }   -> { forward: { port, state, url, message } }
//   POST /ext/live/unforward { port } -> { forward: { port, state: 'closed' } }
// Events: { type: 'live', live } and { type: 'port_forward', forward } as things change.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const FIRST_PORT = 5500;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf',
};
const EVENTS = '/__codeply_live';
// Put in every HTML page: reload on a change, or swap the stylesheets when only CSS changed.
const RELOAD = `<script>/* Codeply Live Server */(() => {
  if (window.__codeplyLive) return; window.__codeplyLive = true;
  const connect = () => {
    const es = new EventSource('${EVENTS}');
    es.onmessage = (m) => {
      if (m.data === 'css') {
        for (const l of document.querySelectorAll('link[rel="stylesheet"]')) { const u = new URL(l.href); u.searchParams.set('_live', Date.now()); l.href = u.href; }
      } else if (m.data === 'reload') location.reload();
    };
    es.onerror = () => { es.close(); setTimeout(connect, 1000); };
  };
  connect();
})();</script>`;
const SKIP = /(^|[\\/])(node_modules|\.git|\.next|\.cache|target)([\\/]|$)/;
const NO_TOOL = 'To share a port, install cloudflared (Windows: winget install --id Cloudflare.cloudflared, Mac: brew install cloudflared) or OpenSSH, then try again.';

let live = null; // { server, port, root, clients: Set<res>, stopWatch }
const forwards = new Map(); // port -> { proc, port, state, url, message }

const liveView = () => (live ? { port: live.port, root: live.root } : null);
const forwardView = (f) => ({ port: f.port, state: f.state, url: f.url || '', message: f.message || '' });

/** Whether `cmd` runs here (`cloudflared --version`, `ssh -V`). */
function runs(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { windowsHide: true, timeout: 6000, stdio: 'ignore' });
    return !r.error;
  } catch { return false; }
}
let toolsSeen = null;
function tools(fresh) {
  if (!toolsSeen || fresh) toolsSeen = { cloudflared: runs('cloudflared', ['--version']), ssh: runs('ssh', ['-V']) };
  return toolsSeen;
}

// ---------- Live Server ----------

function inject(html) {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? html + RELOAD : html.slice(0, at) + RELOAD + html.slice(at);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function serve(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === EVENTS) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': live\n\n');
    live.clients.add(res);
    req.on('close', () => live && live.clients.delete(res));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Only GET here.');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'text/plain', 'Bad address.'); }
  const root = live.root;
  const abs = path.resolve(root, `.${rel}`);
  if (abs !== root && !abs.startsWith(root + path.sep)) return send(res, 403, 'text/plain', 'Outside the project.');
  let st = null;
  try { st = fs.statSync(abs); } catch {}
  let file = abs;
  if (st && st.isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: `${url.pathname}/${url.search}` }); return res.end(); }
    const index = ['index.html', 'index.htm'].map((n) => path.join(abs, n)).find((p) => fs.existsSync(p));
    if (!index) {
      let names = [];
      try { names = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).map((d) => d.name + (d.isDirectory() ? '/' : '')).sort(); } catch {}
      const list = names.map((n) => `<li><a href="${encodeURI(n)}">${escapeHtml(n)}</a></li>`).join('');
      return send(res, 200, MIME['.html'], inject(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(rel)}</title><body style="font:15px system-ui;padding:24px"><h3>${escapeHtml(rel)}</h3><ul>${list}</ul></body>`));
    }
    file = index;
  } else if (!st) {
    return send(res, 404, MIME['.html'], inject(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:24px">${escapeHtml(rel)} isn't in the project.</body>`));
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  if (type.startsWith('text/html')) {
    fs.readFile(file, 'utf8', (e, text) => (e ? send(res, 500, 'text/plain', e.message) : send(res, 200, type, req.method === 'HEAD' ? '' : inject(text))));
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.end()).pipe(res);
}

/** Calls `changed(names)` (after a short pause) when files under `root` change. */
function watch(root, changed) {
  let pending = new Set();
  let timer = null;
  const fire = (name) => {
    if (!name || SKIP.test(name)) return;
    pending.add(String(name));
    clearTimeout(timer);
    timer = setTimeout(() => { const names = [...pending]; pending = new Set(); changed(names); }, 120);
  };
  try {
    const w = fs.watch(root, { recursive: true }, (_ev, name) => fire(name));
    w.on('error', () => {});
    return () => { clearTimeout(timer); w.close(); };
  } catch {
    // No recursive watching here (an older Node on Linux): look at the files' times each second.
    const seen = new Map();
    const scan = (first) => {
      const stack = [root];
      let n = 0;
      while (stack.length && n < 5000) {
        const dir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const d of entries) {
          const p = path.join(dir, d.name);
          if (SKIP.test(p)) continue;
          if (d.isDirectory()) { stack.push(p); continue; }
          n += 1;
          let t = 0;
          try { t = fs.statSync(p).mtimeMs; } catch {}
          if (!first && seen.get(p) !== t) fire(path.relative(root, p));
          seen.set(p, t);
        }
      }
    };
    scan(true);
    const iv = setInterval(() => scan(false), 1000);
    return () => { clearTimeout(timer); clearInterval(iv); };
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const fail = (e) => { server.off('listening', ok); reject(e); };
    const ok = () => { server.off('error', fail); resolve(port); };
    server.once('error', fail);
    server.once('listening', ok);
    server.listen(port, '127.0.0.1');
  });
}

async function startLive(ctx, root) {
  if (live && live.root === root) return live;
  stopLive(ctx);
  const state = { server: null, port: 0, root, clients: new Set(), stopWatch: null };
  const server = http.createServer((req, res) => { try { serve(req, res); } catch (e) { try { send(res, 500, 'text/plain', e.message); } catch {} } });
  let port = 0;
  for (let p = FIRST_PORT; p < FIRST_PORT + 100 && !port; p += 1) {
    try { port = await listen(server, p); } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
  }
  if (!port) throw new Error(`Ports ${FIRST_PORT} to ${FIRST_PORT + 99} are all taken.`);
  Object.assign(state, { server, port });
  live = state;
  state.stopWatch = watch(root, (names) => {
    const kind = names.every((n) => /\.css$/i.test(n)) ? 'css' : 'reload';
    for (const c of state.clients) { try { c.write(`data: ${kind}\n\n`); } catch {} }
  });
  ctx.emit(null, { type: 'live', live: liveView() });
  return state;
}

function stopLive(ctx) {
  if (!live) return;
  const s = live;
  live = null;
  try { s.stopWatch && s.stopWatch(); } catch {}
  for (const c of s.clients) { try { c.end(); } catch {} }
  try { s.server.close(); } catch {}
  ctx.emit(null, { type: 'live', live: null });
}

// ---------- sharing a port ----------

function forward(ctx, port) {
  const had = forwards.get(port);
  if (had && had.state !== 'error') return forwardView(had);
  const t = tools(!toolsSeen || (!toolsSeen.cloudflared && !toolsSeen.ssh));
  const f = { port, state: 'starting', url: '', message: '', proc: null };
  const update = (patch) => { Object.assign(f, patch); ctx.emit(null, { type: 'port_forward', forward: forwardView(f) }); };
  if (!t.cloudflared && !t.ssh) {
    f.state = 'error';
    f.message = NO_TOOL;
    forwards.set(port, f);
    return forwardView(f);
  }
  const [cmd, args, pattern] = t.cloudflared
    ? ['cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i]
    : ['ssh', ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:localhost:${port}`, 'nokey@localhost.run'], /https:\/\/[a-z0-9-]+\.lhr\.life/i];
  let proc;
  try {
    proc = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    f.state = 'error';
    f.message = `${cmd} didn't start: ${e.message}`;
    forwards.set(port, f);
    return forwardView(f);
  }
  f.proc = proc;
  forwards.set(port, f);
  let last = '';
  const read = (chunk) => {
    const text = chunk.toString('utf8');
    const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    if (line) last = line;
    const m = pattern.exec(text);
    if (m && f.state !== 'open') update({ state: 'open', url: m[0], message: cmd === 'ssh' ? 'Shared with localhost.run' : 'Shared with cloudflared' });
  };
  proc.stdout.on('data', read);
  proc.stderr.on('data', read);
  const timer = setTimeout(() => {
    if (f.state === 'starting') { update({ state: 'error', message: `No address from ${cmd} after 40 seconds.${last ? ` It said: ${last}` : ''}` }); try { proc.kill(); } catch {} }
  }, 40000);
  proc.on('error', (e) => { clearTimeout(timer); update({ state: 'error', message: `${cmd} didn't start: ${e.message}` }); });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (forwards.get(port) !== f) return;
    if (f.state === 'closing') { forwards.delete(port); return; }
    update({ state: 'error', message: `The tunnel stopped (${cmd} exited with ${code}).${last ? ` ${last}` : ''}` });
  });
  return forwardView(f);
}

function unforward(port) {
  const f = forwards.get(port);
  if (!f) return;
  f.state = 'closing';
  forwards.delete(port);
  try { f.proc && f.proc.kill(); } catch {}
}

process.on('exit', () => {
  for (const f of forwards.values()) { try { f.proc && f.proc.kill(); } catch {} }
});

export async function route(ctx, req, res, url, p, reply) {
  if (req.method !== 'POST' || !p.startsWith('/ext/live/')) return false;
  const b = await ctx.readJson(req).catch(() => ({}));
  try {
    switch (p) {
      case '/ext/live/start': {
        const root = path.resolve(ctx.DEFAULT_CWD);
        const s = await startLive(ctx, root);
        const file = String(b.file || '').replace(/\\/g, '/').replace(/^\/+/, '');
        reply(200, { live: liveView(), url: `http://127.0.0.1:${s.port}/${file.split('/').map(encodeURIComponent).join('/')}` });
        return true;
      }
      case '/ext/live/stop':
        stopLive(ctx);
        reply(200, { live: null });
        return true;
      case '/ext/live/status':
        reply(200, { live: liveView(), forwards: [...forwards.values()].map(forwardView), tools: tools(false) });
        return true;
      case '/ext/live/forward': {
        const port = Number(b.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) { reply(200, { error: 'Pick a port from 1 to 65535.' }); return true; }
        reply(200, { forward: forward(ctx, port), tools: toolsSeen });
        return true;
      }
      case '/ext/live/unforward': {
        const port = Number(b.port);
        unforward(port);
        reply(200, { forward: { port, state: 'closed' } });
        return true;
      }
      default:
        return false;
    }
  } catch (e) {
    reply(200, { error: e.message || String(e) });
    return true;
  }
}
