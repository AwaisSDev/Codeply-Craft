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

