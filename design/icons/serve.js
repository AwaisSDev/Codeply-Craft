// Serves the Codeply icons preview and saves the exported files.
//   node design/icons/serve.js [port]
// Open http://localhost:5196/?save=1 and every icon is written to ./svg/<name>.svg and ./png/<name>.png.
// Local only (127.0.0.1). POST /save/svg/<name>.svg or /save/png/<name>.png; names are letters, digits and dashes.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 5196);
const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const save = url.pathname.match(/^\/save\/(svg|png)\/([a-z0-9-]+\.(?:svg|png))$/i);
  if (req.method === 'POST' && save) {
    const [, kind, name] = save;
    if (path.extname(name).slice(1) !== kind) { res.writeHead(400); res.end('bad name'); return; }
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 20e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const dir = path.join(ROOT, kind);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
      console.log('[icons] saved', `${kind}/${name}`, size, 'bytes');
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`[icons] http://localhost:${PORT}/`));
