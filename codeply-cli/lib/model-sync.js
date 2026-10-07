/**
 * Codeply - "Use on my phone": syncs a model the user added (with their own
 * API key) to their Codeply account, so the phone app can use it while this
 * PC is off.
 *
 * The key goes to the `user-models` edge function once, over TLS with the
 * user's sign-in token. The function seals it (envelope encryption, see
 * Codeply-App/supabase/functions/_shared/model-keys.ts) and never sends it
 * back: listing returns only "****abcd". The phone then chats through the
 * `byok-proxy` function, which decrypts it there for each request.
 *
 * Not synced, by design:
 *   chatgpt  the ChatGPT sign-in stays on this PC (chatgpt.js).
 *   ollama   Ollama runs on this PC (or a host only it can reach).
 *   no key / plain http / a private address: the cloud cannot use those.
 *
 * Pure logic with an injectable fetch and token source, so it is tested
 * against a fake server in scripts/engine-test.mjs.
 */

const DEFAULT_URL = 'https://zswkhfkfseclgadhvobg.supabase.co/functions/v1/user-models';

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[.*\])$/i;

/** Why a model cannot be used on the phone without this PC, or null when it can. */
function phoneBlocker(m) {
  if (!m) return 'Unknown model.';
  if (m.kind === 'chatgpt') return 'ChatGPT plan models stay on this PC: your ChatGPT sign-in is never uploaded. The phone can still use them while this PC is on.';
  if (m.kind === 'ollama') return 'Ollama runs on this PC, so the phone uses it through this PC while it is on.';
  if (!m.apiKey) return 'Only models with an API key can be used on the phone without this PC.';
  let u;
  try { u = new URL(m.baseUrl); } catch { return 'The base URL is not a valid address.'; }
  if (u.protocol !== 'https:') return 'The phone can only use https addresses. This one keeps working through this PC.';
  if (u.username || u.password) return 'Remove the user name or password from the base URL first.';
  if (u.port && u.port !== '443') return 'The phone can only use the standard https port. This one keeps working through this PC.';
  const host = u.hostname.replace(/\.$/, '');
  if (PRIVATE_HOST.test(host) || (!host.includes('.') && !host.includes(':'))) {
    return 'That address is on your own network, so it only works through this PC.';
  }
  return null;
}

/** What the phone toggle should show for a model, given who is signed in now. */
function phoneStatus(m, userId) {
  const blocker = phoneBlocker(m);
  if (blocker) return { eligible: false, on: false, synced: false, reason: blocker };
  const on = m.phone === true;
  const synced = on && !!m.phoneSyncedAt && !m.phoneError && !!userId && m.phoneUser === userId;
  return { eligible: true, on, synced, reason: on && m.phoneError ? m.phoneError : '' };
}

/**
 * opts.getAccessToken: async () => token or null (signed out)
 * opts.fetch: fetch implementation (defaults to the global one)
 * opts.url / opts.anonKey: the function endpoint and the project's public anon key
 */
function createModelSync({ getAccessToken, fetch: fetchImpl = globalThis.fetch, url = DEFAULT_URL, anonKey = '', timeoutMs = 20000 } = {}) {
  async function call(action, payload) {
    let token = null;
    try { token = await getAccessToken(); } catch {}
    if (!token) return { ok: false, signedOut: true, error: 'Sign in to Codeply to use this model on your phone.' };
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(anonKey ? { apikey: anonKey } : {}), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, offline: true, error: e && e.name === 'TimeoutError' ? 'Codeply took too long to answer.' : "Can't reach Codeply. Check your internet connection." };
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) return { ok: true, ...data };
    return {
      ok: false,
      status: res.status,
      retry: !!data.retry,
      needsKey: /send the api key/i.test(data.error || ''),
      error: data.error || `Codeply could not save it (${res.status}).`,
    };
  }

  /** Metadata of every synced model, keys masked. */
  async function list() {
    return call('list', {});
  }

  /**
   * Sends a model. withKey also sends its API key (first sync, a new key, a
   * new address); otherwise only the name and model id are updated. When the
   * server turns out not to have the key (removed elsewhere), it retries once
   * with the key, and once more on a save conflict.
   */
  async function push(m, { withKey = false } = {}) {
    const blocker = phoneBlocker(m);
    if (blocker) return { ok: false, blocked: true, error: blocker };
    const send = (k) => call('upsert', {
      model: { clientId: m.id, name: m.name, kind: 'openai', baseUrl: m.baseUrl, model: m.model, ...(k ? { apiKey: m.apiKey } : {}) },
    });
    let r = await send(withKey);
    if (!r.ok && r.needsKey && !withKey) r = await send(true);
    if (!r.ok && r.retry) r = await send(withKey || r.needsKey);
    return r;
  }

  async function remove(clientId) {
    return call('delete', { clientId });
  }

  return { list, push, remove };
}

module.exports = { phoneBlocker, phoneStatus, createModelSync, DEFAULT_URL };
