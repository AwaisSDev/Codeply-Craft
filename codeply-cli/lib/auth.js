/**
 * Codeply CLI - auth
 *
 * Passwordless (email + 6-digit code) sign-in against the SAME Supabase
 * project the desktop app uses - same account, same ai-proxy access, same
 * daily request/apply caps either way. The session is cached in
 * ~/.codeply/auth.json, mirroring the desktop app's own file-based session
 * storage (there's no OS keychain dependency to add for a CLI).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://zswkhfkfseclgadhvobg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpzd2toZmtmc2VjbGdhZGh2b2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzYyOTgsImV4cCI6MjA5NTgxMjI5OH0.EoTQdIGQQDrN1uEqQfya3VmrQMT68jkzPLphbLwNTWg';

const configDir = path.join(os.homedir(), '.codeply');
const sessionPath = path.join(configDir, 'auth.json');

function ensureConfigDir() {
  fs.mkdirSync(configDir, { recursive: true });
}

// File-based storage adapter for Supabase session persistence (Node has no
// localStorage) - same pattern the desktop app uses in main.js.
const fileStorage = {
  getItem(key) {
    try { const d = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); return d[key] || null; }
    catch { return null; }
  },
  setItem(key, value) {
    ensureConfigDir();
    let d = {};
    try { d = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { }
    d[key] = value;
    try { fs.writeFileSync(sessionPath, JSON.stringify(d)); } catch { }
  },
  removeItem(key) {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { }
    delete d[key];
    try { fs.writeFileSync(sessionPath, JSON.stringify(d)); } catch { }
  },
};

let client = null;
function getClient() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: fileStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        // PKCE, not the (default) implicit flow - inert for this CLI's own
        // email/password/OTP sign-in, but required by any client using
        // signInWithOAuth + exchangeCodeForSession (e.g. the desktop app's
        // and Codeply Craft's "Continue with Google" - the OAuth redirect
        // carries an exchangeable code only under PKCE).
        flowType: 'pkce',
      },
    });
  }
  return client;
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
}

/** Interactive email + 6-digit-code sign-in. Prints its own progress/errors. */
async function login() {
  const supabase = getClient();
  const email = await prompt('Email: ');
  if (!email) { console.error('No email entered.'); return false; }

  const { error: otpErr } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (otpErr) {
    console.error(`Could not send a code: ${otpErr.message}`);
    console.error('(No account with that email? Sign up in the Codeply desktop app first.)');
    return false;
  }

  console.log(`Code sent to ${email}.`);
  const code = await prompt('6-digit code: ');
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code.replace(/\s+/g, ''), type: 'email' });
  if (error || !data?.session) {
    console.error(`Sign-in failed: ${error?.message || 'invalid code'}`);
    return false;
  }

  console.log(`Signed in as ${data.session.user.email}.`);
  return true;
}

async function logout() {
  const supabase = getClient();
  try { await supabase.auth.signOut(); } catch { }
  console.log('Signed out.');
}

/** Returns the current session, refreshing it if the client already has one. */
async function getSession() {
  const supabase = getClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session || null;
}

async function getAccessToken() {
  const session = await getSession();
  return session?.access_token || null;
}

module.exports = { SUPABASE_URL, SUPABASE_ANON_KEY, getClient, login, logout, getSession, getAccessToken };
