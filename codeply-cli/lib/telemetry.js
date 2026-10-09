/**
 * Usage counts for Codeply's admin dashboard: which app was used (Craft, Crew
 * or the CLI), which model, Auto or the user's own key, tokens in and out, and
 * the app version. Never prompts, replies, files or anything typed.
 *
 * Events wait in memory and go out in small batches (about once a minute) to
 * Codeply's track function, only when the user is signed in to Codeply. Off
 * with CODEPLY_TELEMETRY=0, or "telemetry": false in ~/.codeply/config.json.
 *
 * Which app a call belongs to: the host sets a default (Craft's main process
 * says "craft"; the CLI is "cli" by default), and Crew runs its bots inside
 * withProduct('crew', ...), which follows the call through every await.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const defaults = { product: 'cli', version: '', platform: process.platform };
try { defaults.version = require('../package.json').version || ''; } catch {}
let queue = [];
let timer = null;
let sending = false;
const FLUSH_MS = 60_000;
const MAX_QUEUE = 500;

function enabled() {
  if (process.env.CODEPLY_TELEMETRY === '0') return false;
  try { return require('./config.js').getConfig().telemetry !== false; } catch { return true; }
}

/** The host says what it is: setDefaults({ product: 'craft', version: '1.1.14' }). */
function setDefaults(d) { Object.assign(defaults, d || {}); }

/** Run fn with every AI call inside it counted for this product. */
function withProduct(product, fn) { return als.run({ product }, fn); }

function currentProduct() { const s = als.getStore(); return (s && s.product) || defaults.product; }

function push(ev) {
  if (!enabled()) return;
  queue.push({ product: currentProduct(), version: defaults.version, platform: defaults.platform, at: new Date().toISOString(), ...ev });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= 40) flush();
  else if (!timer) { timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS); if (timer.unref) timer.unref(); }
}

/** One model call: { model, provider, tokens_in, tokens_out, ms }. */
function recordAi(ev) { push({ kind: 'ai', ...ev }); }

/** The app was opened (counts active users even on a day with no AI call), once an hour at most. */
const lastOpen = new Map();
function recordOpen(product) {
  const p = product || currentProduct();
  if (Date.now() - (lastOpen.get(p) || 0) < 3600_000) return;
  lastOpen.set(p, Date.now());
  push({ kind: 'open', product: p });
}

async function flush() {
  if (sending || !queue.length || !enabled()) return;
  sending = true;
  const batch = queue.slice(0, 100);
  try {
    const auth = require('./auth.js');
    const token = await auth.getAccessToken().catch(() => null);
    if (!token) { queue = []; return; } // signed out: nothing is kept or sent
    const res = await fetch(`${auth.SUPABASE_URL}/functions/v1/track`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok || res.status === 400) queue = queue.slice(batch.length); // sent (or unusable): drop them
  } catch {
    // Offline: they wait for the next flush.
  } finally {
    sending = false;
    if (queue.length && !timer) { timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS); if (timer.unref) timer.unref(); }
  }
}

/** Token counts from any provider's response shape, or an estimate from the text. */
function tokensOf(data, messages) {
  const u = (data && data.usage) || {};
  const tin = u.prompt_tokens ?? u.input_tokens ?? (data && data.prompt_eval_count);
  const tout = u.completion_tokens ?? u.output_tokens ?? (data && data.eval_count);
  if (tin != null || tout != null) return { tokens_in: Number(tin) || 0, tokens_out: Number(tout) || 0 };
  const chars = (arr) => arr.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
  const reply = data && data.choices && data.choices[0] && data.choices[0].message ? String(data.choices[0].message.content || '') : '';
  return { tokens_in: Math.round(chars(messages || []) / 4), tokens_out: Math.round(reply.length / 4) };
}

module.exports = { setDefaults, withProduct, currentProduct, recordAi, recordOpen, flush, tokensOf };
