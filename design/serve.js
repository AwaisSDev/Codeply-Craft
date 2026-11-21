// Static server for the design previews (icons, desktop app).
//   node design/serve.js [port]      then open http://localhost:5197/desktop/
// Local only (127.0.0.1), read only.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 5197);
const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // The real app's icon pack, so previews use the exact icons Codeply ships (read only, one file).
  if (url.pathname === '/app/icons.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
    fs.createReadStream(path.join(ROOT, '..', 'icons.js')).pipe(res);
    return;
  }
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) { res.writeHead(301, { location: `/${rel}/` }); res.end(); return; }
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`[design] http://localhost:${PORT}/desktop/`));
