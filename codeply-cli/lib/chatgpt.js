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

