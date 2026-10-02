// Builds the phone web app into mobile-app/: a plain static site. Deploy that
// folder anywhere static (it's meant for https://mobile.codeply.app on Vercel)
// and Capacitor wraps the same folder for the Android app. It needs no server
// of its own: the phone reaches the PC through Supabase Realtime.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'mobile-app');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, 'agent-mascots'), { recursive: true });

// The Craft phone app (phone.*) is the default page; the classic remote
// control (mobile.*) stays reachable at /classic.
for (const [from, to] of [
  ['phone.html', 'index.html'],
  ['phone.css', 'phone.css'],
  ['phone.js', 'phone.js'],
  ['phone-calls.js', 'phone-calls.js'],
  ['phone-calls.css', 'phone-calls.css'],
  ['phone-stt-worker.js', 'phone-stt-worker.js'],
  ['bot-avatar.js', 'bot-avatar.js'],
  ['phone.manifest.json', 'manifest.json'],
  [path.join('vendor', 'phone', 'nacl-fast.min.js'), 'nacl-fast.min.js'],
  [path.join('vendor', 'phone', 'blake2b.js'), 'blake2b.js'],
  ['mobile.html', 'classic.html'],
  ['mobile.css', 'mobile.css'],
  ['mobile.js', 'mobile.js'],
  ['mobile-cloud.js', 'mobile-cloud.js'],
  ['mobile-cloud.css', 'mobile-cloud.css'],
  ['logo.png', 'logo.png'],
  ['phone-favicon.png', 'phone-favicon.png'],
  [path.join('vendor', 'supabase', 'supabase.js'), 'supabase.js'],
]) fs.copyFileSync(path.join(root, from), path.join(target, to));

const mascots = path.join(root, 'assets', 'agents');
for (const f of fs.readdirSync(mascots).filter((f) => f.endsWith('.png'))) {
  fs.copyFileSync(path.join(mascots, f), path.join(target, 'agent-mascots', f));
}

// Static hosting config for Vercel: no build step, and never cache the app
// shell so a deploy reaches phones immediately.
fs.writeFileSync(path.join(target, 'vercel.json'), JSON.stringify({
  cleanUrls: true,
  headers: [
    { source: '/(index.html|phone.js|phone.css|phone-calls.js|phone-calls.css|phone-stt-worker.js|bot-avatar.js|classic.html|classic|mobile.js|mobile.css|mobile-cloud.js|mobile-cloud.css|)', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'no-referrer' }] },
  ],
}, null, 2));

console.log(`Prepared ${path.relative(root, target)}/ (deploy it as a static site, e.g. mobile.codeply.app).`);
