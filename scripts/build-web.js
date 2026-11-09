// Builds the desktop web app (codeply.app/chat) into the website repo: the phone app (prepare-mobile.js)
// laid out for a big screen with desktop.css and desktop.js. It is served only by the website, never by
// mobile.codeply.app: the page is chat.html (the site rewrites /chat to it, like its other pages) and its
// files are in chat/.
//
//   node scripts/build-web.js [website folder]     (default: ../Codeply, next to this repo)
//
// Run it after changing the phone app or desktop.*, then commit the website's chat.html and chat/ folder.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const site = path.resolve(process.argv[2] || path.join(root, '..', 'Codeply'));
if (!fs.existsSync(path.join(site, 'vercel.json'))) throw new Error(`build-web: ${site} is not the website repo (no vercel.json).`);
const out = path.join(site, 'chat');

execFileSync(process.execPath, [path.join(__dirname, 'prepare-mobile.js')], { stdio: 'inherit' });
const built = path.join(root, 'mobile-app');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// Everything the app needs, without the phone's own page, manifest, Vercel config and the classic remote
const SKIP = new Set(['index.html', 'manifest.json', 'vercel.json', 'classic.html', 'mobile.js', 'mobile.css', 'mobile-cloud.js', 'mobile-cloud.css']);
for (const f of fs.readdirSync(built)) if (!SKIP.has(f)) fs.cpSync(path.join(built, f), path.join(out, f), { recursive: true });
for (const f of ['desktop.css', 'desktop.js']) fs.copyFileSync(path.join(root, f), path.join(out, f));

let html = fs.readFileSync(path.join(root, 'phone.html'), 'utf8');
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`build-web: phone.html no longer has ${JSON.stringify(from)}`);
  html = html.replace(from, to);
};
swap('<html lang="en">', '<html lang="en" class="desk">');
// /chat/ with or without the slash: every file resolves under /chat/
swap('<meta charset="utf-8">', '<meta charset="utf-8">\n  <base href="/chat/">');
swap('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no">', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
swap('<title>Codeply</title>', '<title>Codeply</title>\n  <meta name="description" content="Codeply in your browser: chat, search the web, and start work on your PC or in the cloud.">\n  <meta name="robots" content="noindex">');
swap('<link rel="stylesheet" href="phone-specialists.css">', '<link rel="stylesheet" href="phone-specialists.css">\n  <link rel="stylesheet" href="desktop.css">');
swap('<script src="phone-app.js"></script>', '<script src="phone-app.js"></script>\n  <script src="desktop.js"></script>');
fs.writeFileSync(path.join(site, 'chat.html'), `<!-- Built by codeply-craft scripts/build-web.js from phone.html: edit there, not here. -->\n${html}`);

// Installable as its own desktop app (Chrome and Edge: Install), opening on /chat/
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'phone.manifest.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ ...manifest, id: '/chat/', start_url: '/chat/', scope: '/chat/', display_override: ['window-controls-overlay', 'standalone'], icons: manifest.icons.map((i) => ({ ...i, src: '/chat/logo.png' })) }, null, 2));

console.log(`Built the desktop web app into ${path.relative(process.cwd(), out) || out}/ (commit it in the website repo).`);
