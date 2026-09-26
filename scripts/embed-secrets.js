// Writes build-secrets.json (gitignored) with the app-wide OAuth app
// credentials for "Connect Apps", so an installed build can connect Vercel,
// Supabase, GitHub, Gmail and Slack. main.js loads it at startup.
//
// Values come from the environment (CI secrets) or, locally, from .env.
// Note: anything shipped inside a desktop app can be extracted from it. That
// is the accepted trade-off for OAuth "installed app" clients; never put a
// credential here that grants more than the OAuth app itself.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });

const KEYS = [
  'VERCEL_CLIENT_ID', 'VERCEL_CLIENT_SECRET', 'VERCEL_SLUG',
  'SUPABASE_CLIENT_ID', 'SUPABASE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET',
  'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET',
  'CRAFT_MOBILE_URL',
];

const out = {};
for (const k of KEYS) if (process.env[k]) out[k] = process.env[k];
fs.writeFileSync(path.join(root, 'build-secrets.json'), JSON.stringify(out, null, 2));

const missing = ['VERCEL_CLIENT_ID', 'VERCEL_CLIENT_SECRET', 'SUPABASE_CLIENT_ID', 'SUPABASE_CLIENT_SECRET'].filter((k) => !out[k]);
console.log(`build-secrets.json: ${Object.keys(out).length} value(s) embedded.`);
if (missing.length) console.warn(`WARNING: not set, so that "Connect Apps" option won't work in this build: ${missing.join(', ')}`);
