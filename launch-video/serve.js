// Static server for the launch video: the Codeply website (for its 3.0 app mockups, CSS, icons and
// assets) at /, and the composition at /comp/. Usage: node serve.js [port]
const http = require('http'), fs = require('fs'), path = require('path');
const SITE = path.resolve(__dirname, '../../Codeply');
const COMP = path.resolve(__dirname, 'comp');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const port = +process.argv[2] || 8830;
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  const file = p.startsWith('/comp/') ? path.join(COMP, p.slice(6)) : path.join(SITE, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(port, () => console.log('serving on', port));
