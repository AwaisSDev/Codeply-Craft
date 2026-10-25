// Builds Codeply Crew's iPhone web layer into crew-ios/www/, which Capacitor
// wraps into the native app (see .github/workflows/crew-ios.yml). The call
// engine, avatars and Supabase client are shared with the phone app, copied
// from the repo root so both apps stay on the same code.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = path.join(root, 'crew-ios');
const target = path.join(app, 'www');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

for (const [from, to] of [
  [path.join('crew-ios', 'index.html'), 'index.html'],
  [path.join('crew-ios', 'crew.css'), 'crew.css'],
  [path.join('crew-ios', 'crew-core.js'), 'crew-core.js'],
  [path.join('crew-ios', 'crew-app.js'), 'crew-app.js'],
  [path.join('crew-ios', 'crew-native.js'), 'crew-native.js'],
  ['phone-reminders.js', 'phone-reminders.js'],
  [path.join('crew-ios', 'assets', 'mark-256.png'), 'mark-256.png'],
  ['phone-calls.js', 'phone-calls.js'],
  ['phone-calls.css', 'phone-calls.css'],
  ['phone-stt-worker.js', 'phone-stt-worker.js'],
  ['bot-avatar.js', 'bot-avatar.js'],
  [path.join('vendor', 'supabase', 'supabase.js'), 'supabase.js'],
]) fs.copyFileSync(path.join(root, from), path.join(target, to));

// Safe areas: Android WebViews before Chromium 140 report them only through
// Capacitor's --safe-area-inset-* variables, so the copied CSS reads --sa-*
// (index.html sets each to the larger of the two).
for (const css of ['crew.css', 'phone-calls.css']) {
  const file = path.join(target, css);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/env\(safe-area-inset-(top|bottom|left|right)(?:,\s*0(?:px)?)?\)/g, 'var(--sa-$1)'));
}

console.log(`Codeply Crew web layer ready in ${path.relative(root, target)}`);
