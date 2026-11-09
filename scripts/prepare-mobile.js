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
  ['phone-reminders.js', 'phone-reminders.js'],
  ['phone-life.js', 'phone-life.js'],
  ['phone-sw.js', 'phone-sw.js'],
  ['phone-calls.css', 'phone-calls.css'],
  ['phone-design.js', 'phone-design.js'],
  ['phone-design.css', 'phone-design.css'],
  ['phone-theme.css', 'phone-theme.css'], // the website's look
  ['phone-wisp.js', 'phone-wisp.js'],     // Wisp, the agent's face
  ['phone-app.js', 'phone-app.js'],       // the screens around the chat (Tasks, Settings, sign up...)
  ['phone-app.css', 'phone-app.css'],
  ['phone-work.js', 'phone-work.js'],     // Schedules, Calendar and Checks (no PC needed)
  ['phone-work.css', 'phone-work.css'],
  ['phone-specialists.js', 'phone-specialists.js'], // the team, made and run from the phone (works with the PC off)
  ['phone-specialists.css', 'phone-specialists.css'],
  ['phone-bots.js', 'phone-bots.js'],     // the bots, run from the phone while the PC is off
  ['phone-taste.js', 'phone-taste.js'],   // Codeply's taste skill for designs made on the phone
  ['wisp.js', 'wisp.js'],
  ['phone-stt-worker.js', 'phone-stt-worker.js'],
  ['bot-avatar.js', 'bot-avatar.js'],
  ['attachments.js', 'attachments.js'],
  ['link-chips.js', 'link-chips.js'],     // links in messages as chips (shared with Craft)
  ['web-search.js', 'web-search.js'],     // web search: Codeply's /api/search, then Exa and Wikipedia from the browser
  ['phone.manifest.json', 'manifest.json'],
  [path.join('vendor', 'phone', 'nacl-fast.min.js'), 'nacl-fast.min.js'],
  [path.join('vendor', 'phone', 'blake2b.js'), 'blake2b.js'],
  ['mobile.html', 'classic.html'],
  ['mobile.css', 'mobile.css'],
  ['mobile.js', 'mobile.js'],
  ['mobile-cloud.js', 'mobile-cloud.js'],
  ['mobile-cloud.css', 'mobile-cloud.css'],
  ['logo.png', 'logo.png'],
  ['apple-touch-icon.png', 'apple-touch-icon.png'], // the home-screen icon: the mascot alone, no tile
  ['phone-favicon.png', 'phone-favicon.png'],
  [path.join('brand', 'icons', 'wisp.svg'), 'favicon.svg'],   // the tab icon, sharp at any size
  [path.join('brand', 'icons', 'favicon.ico'), 'favicon.ico'], // for browsers that only ask for /favicon.ico
  ['notify-badge.png', 'notify-badge.png'], // Android's status-bar icon: only its shape is drawn
  [path.join('crew', 'assets', 'logo', 'codeply-icon-small-48.png'), 'crew-logo.png'],
  [path.join('vendor', 'supabase', 'supabase.js'), 'supabase.js'],
]) fs.copyFileSync(path.join(root, from), path.join(target, to));

// pdf.js (Mozilla, Apache 2.0) for reading attached PDFs in the browser
fs.mkdirSync(path.join(target, 'pdfjs'), { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'LICENSE']) fs.copyFileSync(path.join(root, 'vendor', 'pdfjs', f), path.join(target, 'pdfjs', f));

const mascots = path.join(root, 'assets', 'agents');
for (const f of fs.readdirSync(mascots).filter((f) => f.endsWith('.png'))) {
  fs.copyFileSync(path.join(mascots, f), path.join(target, 'agent-mascots', f));
}

// The logos on the phone's Connected apps screen.
fs.mkdirSync(path.join(target, 'apps'), { recursive: true });
for (const [from, to] of [['Gmail.webp', 'gmail.webp'], ['Slack.webp', 'slack.webp'], ['Github.webp', 'github.webp'], ['Vercel.png', 'vercel.png'], ['Supabase.jpg', 'supabase.jpg']]) fs.copyFileSync(path.join(root, from), path.join(target, 'apps', to));

// Codeply's taste skill for designs made on the phone (phone-taste.js): the art-direction library and the
// guides, from the same skill folder the PC's agent uses, so both follow the same rules.
{
  const skill = path.join(root, 'codeply-cli', 'skills', 'codeply-taste');
  const lib = (n) => JSON.parse(fs.readFileSync(path.join(skill, 'library', `${n}.json`), 'utf8'));
  const md = (n) => fs.readFileSync(path.join(skill, n), 'utf8');
  fs.writeFileSync(path.join(target, 'taste.json'), JSON.stringify({
    directions: lib('directions'), palettes: lib('palettes'), type: lib('type'),
    guides: { skill: md('SKILL.md'), tells: md('references/tells.md'), copy: md('references/copy.md'), colour: md('references/colour.md'), type: md('references/type.md'), layout: md('references/layout.md') },
  }));
}

// Static hosting config for Vercel: no build step, and never cache the app
// shell so a deploy reaches phones immediately.
fs.writeFileSync(path.join(target, 'vercel.json'), JSON.stringify({
  cleanUrls: true,
  headers: [
    { source: '/(index.html|phone.js|phone.css|phone-calls.js|phone-calls.css|phone-reminders.js|phone-life.js|phone-sw.js|phone-stt-worker.js|phone-theme.css|phone-wisp.js|phone-app.js|phone-app.css|wisp.js|bot-avatar.js|classic.html|classic|mobile.js|mobile.css|mobile-cloud.js|mobile-cloud.css|)', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'no-referrer' }] },
  ],
}, null, 2));

console.log(`Prepared ${path.relative(root, target)}/ (deploy it as a static site, e.g. mobile.codeply.app).`);
