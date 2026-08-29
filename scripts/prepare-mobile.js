const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'mobile-app');
fs.mkdirSync(target, { recursive: true });

for (const [from, to] of [
  ['mobile.html', 'index.html'],
  ['mobile.css', 'mobile.css'],
  ['mobile.js', 'mobile.js'],
  ['mobile.manifest.json', 'manifest.json'],
  ['logo.png', 'logo.png'],
]) fs.copyFileSync(path.join(root, from), path.join(target, to));

console.log('Prepared mobile-app for Capacitor.');
