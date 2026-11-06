#!/usr/bin/env node
// codeply-browser: an MCP server (stdio) that gives a Claude Code agent
// Codeply's browser. Claude Code starts it (the desktop app writes the config,
// swarm-browser-desktop.js); every tool call goes to the desktop app's local
// endpoint with this agent's key, and comes back with what the page looks like.
// No dependencies: JSON-RPC over newline-delimited stdin and stdout.
'use strict';
const http = require('http');

const URL_ = process.env.CODEPLY_BROWSER_URL || '';
const TOKEN = process.env.CODEPLY_BROWSER_TOKEN || '';
const KEY = process.env.CODEPLY_BROWSER_KEY || '';

const TOOLS = [
  { name: 'browser_open', action: 'open', description: 'Open a page in Codeply\'s browser, which the user watches. Returns the page\'s clickable things (numbered) and a screenshot. In a swarm, the agents share one tab; new_tab gives you a tab of your own.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The address, like example.com or http://localhost:5173.' }, new_tab: { type: 'boolean', description: 'Open it in a tab of your own instead of the shared one.' } }, required: ['url'] } },
  { name: 'browser_look', action: 'look', description: 'Look at the page now: its clickable things (numbered, with x,y) and a screenshot.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_click', action: 'click', description: 'Click something on the page: an element number from your last look, or x,y in page pixels. Your cursor glides there first, so the user sees it. Returns the page\'s text and clickable things (no screenshot unless look is true).',
    inputSchema: { type: 'object', properties: { element: { type: 'number', description: 'Element number from the last look.' }, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right'] }, look: { type: 'boolean', description: 'Also return a screenshot.' } } } },
  { name: 'browser_type', action: 'type', description: 'Type text. With element, it clicks that field first. clear replaces what is there; enter presses Enter after.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, element: { type: 'number' }, clear: { type: 'boolean' }, enter: { type: 'boolean' } }, required: ['text'] } },
  { name: 'browser_keys', action: 'keys', description: 'Press a key or a combination, like Enter, Tab, Escape, ArrowDown or Ctrl+A.',
    inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'browser_scroll', action: 'scroll', description: 'Scroll the page (or the panel under x,y): direction up or down, or dy in pixels.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, dy: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } } } },
  { name: 'browser_back', action: 'back', description: 'Go back one page.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_wait', action: 'wait', description: 'Wait for the page (ms, default 1500), then look again.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
];

function call(action, args) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(URL_); } catch { resolve({ ok: false, text: 'Codeply\'s browser is not reachable (no endpoint).' }); return; }
    const body = JSON.stringify({ key: KEY, action, args: args || {} });
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-codeply-token': TOKEN }, timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, text: `Codeply's browser answered ${res.statusCode}.` }); } });
    });
    req.on('error', (e) => resolve({ ok: false, text: `Codeply's browser is not reachable: ${e.message}. Is Codeply open?` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: 'Codeply\'s browser took too long to answer.' }); });
    req.end(body);
  });
}

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }

async function handle(m) {
  if (!m || typeof m !== 'object') return;
  const { id, method, params } = m;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codeply-browser', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  } else if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === (params && params.name));
    if (!tool) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool ${params && params.name}.` }], isError: true } }); return; }
    const r = await call(tool.action, (params && params.arguments) || {});
    const content = [{ type: 'text', text: String((r && r.text) || (r && r.ok ? 'Done.' : 'It did not work.')) }];
    if (r && r.image) content.push({ type: 'image', data: r.image, mimeType: 'image/jpeg' });
    send({ jsonrpc: '2.0', id, result: { content, isError: !(r && r.ok) } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m = null;
    try { m = JSON.parse(line); } catch { continue; }
    handle(m).catch((e) => { if (m && m.id != null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }); });
  }
});
process.stdin.on('end', () => process.exit(0));
