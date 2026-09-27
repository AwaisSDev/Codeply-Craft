// Copies the Auto model keys and Connect Apps OAuth credentials into the GitHub repo's Actions
// secrets, so release builds can connect Vercel, Supabase, GitHub, Gmail and
// Slack. Reads .env and ~/.codeply/config.json on this machine; never prints
// a value. Needs the GitHub CLI signed in (gh auth login).
//
//   node scripts/set-release-secrets.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.CRAFT_REPO || 'AwaisSDev/Codeply-Craft';
const root = path.resolve(__dirname, '..');

let env = {};
try { env = require('dotenv').parse(fs.readFileSync(path.join(root, '.env'))); } catch {}
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codeply', 'config.json'), 'utf8')); } catch {}

// GitHub doesn't allow secret names starting with GITHUB_, hence OAUTH_GITHUB_*.
const SECRETS = {
  VERCEL_CLIENT_ID: env.VERCEL_CLIENT_ID || cfg.vercel?.clientId,
  VERCEL_CLIENT_SECRET: env.VERCEL_CLIENT_SECRET || cfg.vercel?.clientSecret,
  VERCEL_SLUG: env.VERCEL_SLUG || cfg.vercel?.slug,
  SUPABASE_CLIENT_ID: env.SUPABASE_CLIENT_ID || cfg.supabase?.clientId,
  SUPABASE_CLIENT_SECRET: env.SUPABASE_CLIENT_SECRET || cfg.supabase?.clientSecret,
  OAUTH_GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID || cfg.github?.clientId,
  OAUTH_GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET || cfg.github?.clientSecret,
  GMAIL_CLIENT_ID: env.GMAIL_CLIENT_ID || cfg.gmail?.clientId,
  GMAIL_CLIENT_SECRET: env.GMAIL_CLIENT_SECRET || cfg.gmail?.clientSecret,
  SLACK_CLIENT_ID: env.SLACK_CLIENT_ID || cfg.slack?.clientId,
  SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET || cfg.slack?.clientSecret,
  OLLAMA_API_KEY: env.OLLAMA_API_KEY || cfg.ollama?.apiKey,
  OLLAMA_API_KEY_FALLBACK: env.OLLAMA_API_KEY_FALLBACK || cfg.ollama?.apiKeyFallback,
};

let missing = 0;
for (const [name, value] of Object.entries(SECRETS)) {
  if (!value) { console.log(`skipped  ${name} (not found locally)`); missing++; continue; }
  execFileSync('gh', ['secret', 'set', name, '-R', REPO], { input: value, stdio: ['pipe', 'ignore', 'inherit'] });
  console.log(`set      ${name}`);
}
console.log(missing ? `\nDone, ${missing} skipped.` : '\nAll secrets set.');
