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

