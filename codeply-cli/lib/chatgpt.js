/**
 * Sign in with ChatGPT - lets someone run Craft on the models included in
 * their own ChatGPT plan instead of an API key.
 *
 * This is OpenAI's official open-source / local-app flow
 * (developers.openai.com/siwc/token-sharing-open-source): OAuth 2 with PKCE
 * in the system browser, a loopback redirect on 127.0.0.1, and dynamic client
 * registration - the first sign-in uses client_id "dynamic_agent_client" and
 * the callback hands back a client_id issued for this user + this install.
 * The resulting access token calls the public Responses API
 * (api.openai.com/v1/responses), billed to the user's plan. ai.js does the
 * calling; this file owns the tokens.
 *
 * Everything is stored in ~/.codeply/chatgpt.json (owner-only), never sent
 * anywhere but auth.openai.com and api.openai.com.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const MODELS_URL = `${RESOURCE}/models`;
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const APP_NAME = 'Codeply Craft';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const USAGE_URL = 'https://chatgpt.com/settings/usage';

const storePath = path.join(os.homedir(), '.codeply', 'chatgpt.json');

function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath, 'utf8')) || {}; } catch { return {}; }
}

/** Atomic, owner-only write - the file holds a refresh token. */
function writeStore(data) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  try { fs.chmodSync(storePath, 0o600); } catch {}
}

/**
 * The per-install host id OpenAI requires before the first sign-in. Opaque,
 * random, never derived from anything about the user, and kept for the life
 * of the install (sign-out keeps it, as the docs ask).
 */
function hostId() {
  const store = readStore();
  if (store.hostId) return store.hostId;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  writeStore({ ...store, hostId: id });
  return id;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = () => b64url(crypto.randomBytes(32));

function decodeJwt(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) throw new Error('Malformed token.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

let jwksCache = null;
async function signingKey(kid) {
  if (!jwksCache || !jwksCache.keys.some((k) => k.kid === kid)) {
    const disco = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
    jwksCache = await (await fetch(disco.jwks_uri)).json();
  }
  const jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error('ChatGPT sign-in returned a token signed with an unknown key.');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/** Signature, issuer, audience, nonce and expiry - all required by the docs before trusting the profile. */
async function verifyIdToken(idToken, { clientId, nonce }) {
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  const algs = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' };
  if (!algs[header.alg]) throw new Error(`Unsupported ID token algorithm ${header.alg}.`);
  const ok = crypto.verify(algs[header.alg], Buffer.from(signingInput), await signingKey(header.kid), signature);
  if (!ok) throw new Error('ChatGPT sign-in returned an ID token with a bad signature.');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== ISSUER) throw new Error('ChatGPT sign-in returned a token from the wrong issuer.');
  if (!aud.includes(clientId)) throw new Error('ChatGPT sign-in returned a token for a different app.');
  if (nonce && payload.nonce !== nonce) throw new Error('ChatGPT sign-in did not match this attempt. Try again.');
  if (payload.exp && payload.exp * 1000 < Date.now() - 60_000) throw new Error('ChatGPT sign-in returned an expired token.');
  return payload;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || `ChatGPT sign-in failed (HTTP ${res.status}).`);
    err.code = body.error;
    throw err;
  }
  return body;
}

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#1b1b1b;color:#ececec;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:360px"><h2 style="font-weight:600">${title}</h2><p style="color:#a8a8a8">${text}</p></div>`;

/** One-shot loopback server on a free port; resolves with the callback's query params. */
function listenForCallback(expectedState) {
  let finish;
  const result = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  result.catch(() => {}); // awaited by signIn; this only keeps an early reject from going unhandled
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const q = Object.fromEntries(url.searchParams);
    const failed = q.error || !q.code || q.state !== expectedState;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(failed
      ? PAGE('Sign-in did not finish', 'Go back to Codeply Craft and try again.')
      : PAGE('You are signed in', 'You can close this tab and go back to Codeply Craft.'));
    if (q.error) finish.reject(new Error(q.error_description || `ChatGPT sign-in was cancelled (${q.error}).`));
    else if (q.state !== expectedState) finish.reject(new Error('ChatGPT sign-in did not match this attempt. Try again.'));
    else if (!q.code) finish.reject(new Error('ChatGPT sign-in returned no authorization code.'));
    else finish.resolve(q);
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/callback`));
  });
  const timer = setTimeout(() => finish.reject(new Error('ChatGPT sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS);
  const close = () => { clearTimeout(timer); server.close(); };
  return { ready, result, close };
}

/**
 * Full sign-in: opens the browser, waits for the redirect, exchanges the code,
 * verifies the ID token and saves the profile. Reuses the client_id issued on
 * an earlier sign-in (the docs: never reuse dynamic_agent_client).
 */
async function signIn({ openBrowser }) {
  const store = readStore();
  const verifier = randomToken();
  const state = randomToken();
  const nonce = randomToken();
  const listener = listenForCallback(state);
  try {
    const redirectUri = await listener.ready;
    const params = new URLSearchParams({
      client_id: store.clientId || DYNAMIC_CLIENT,
      ext_agent_host_id: hostId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    });
    if (!store.clientId) params.set('agent_name_hint', APP_NAME);
    if (store.email) params.set('login_hint', store.email);
    await openBrowser(`${AUTHORIZE_URL}?${params}`);

    const callback = await listener.result;
    const clientId = callback.client_id || store.clientId;
    if (!clientId || clientId === DYNAMIC_CLIENT) throw new Error('ChatGPT sign-in did not register this app. Try again.');

    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE,
    });
    const claims = await verifyIdToken(tokens.id_token, { clientId, nonce });
    const scopes = String(tokens.scope || callback.scope || '').split(/\s+/).filter(Boolean);
    writeStore({
      ...readStore(),
      clientId,
      subject: claims.sub,
      email: claims.email || '',
      name: claims.name || '',
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      scopes,
    });
    return status();
  } finally {
    listener.close();
  }
}

/** Sign-out drops the tokens but keeps the host id and issued client_id for the next sign-in. */
function signOut() {
  const { hostId: h, clientId, email } = readStore();
  writeStore({ hostId: h, clientId, email });
  return status();
}

function status() {
  const s = readStore();
  const signedIn = !!(s.refreshToken || s.accessToken);
  return {
    signedIn,
    email: signedIn ? s.email || '' : '',
    name: signedIn ? s.name || '' : '',
    // Identity alone is not permission to use the plan - the docs make the
    // plan scope its own grant the user can turn down.
    sharing: signedIn && (s.scopes || []).includes(PLAN_SCOPE),
    usageUrl: USAGE_URL,
  };
}

const REFRESH_DEAD = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

let refreshing = null;
/** A valid access token, refreshed a minute before it expires. Throws a user-facing message when signed out. */
async function accessToken({ force = false } = {}) {
  const s = readStore();
  if (!s.refreshToken && !s.accessToken) throw new Error('Sign in with ChatGPT again from the model menu to use this model.');
  if (!force && s.accessToken && s.expiresAt > Date.now() + 60_000) return s.accessToken;
  if (!s.refreshToken) throw new Error('Your ChatGPT sign-in expired. Sign in again from the model menu.');
  refreshing = refreshing || (async () => {
    try {
      const tokens = await tokenRequest({
        grant_type: 'refresh_token',
        client_id: s.clientId,
        refresh_token: s.refreshToken,
        resource: RESOURCE,
      });
      writeStore({
        ...readStore(),
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || s.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
        ...(tokens.scope ? { scopes: String(tokens.scope).split(/\s+/).filter(Boolean) } : {}),
      });
      return tokens.access_token;
    } catch (e) {
      if (REFRESH_DEAD.has(e.code)) {
        signOut();
        throw new Error('Your ChatGPT sign-in expired. Sign in again from the model menu.');
      }
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

