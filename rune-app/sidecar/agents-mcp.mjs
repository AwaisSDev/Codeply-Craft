// The tools a background agent gets from Codeply (ext-agents.mjs starts one of these per agent,
// as an MCP server over stdio): the team channel it shares with the other agents of its group,
// and its own tab in Codeply's browser. Every call goes to ext-agents' local endpoint with this
// agent's key. No dependencies: JSON-RPC over newline-delimited stdin and stdout.
//
//   env CODEPLY_AGENTS_URL (http://127.0.0.1:<port>/act), CODEPLY_AGENTS_TOKEN, CODEPLY_AGENT_KEY,
//       CODEPLY_AGENT_TOOLS ("team", "browser" or "team,browser")
import http from 'node:http';

const URL_ = process.env.CODEPLY_AGENTS_URL || '';
const TOKEN = process.env.CODEPLY_AGENTS_TOKEN || '';
const KEY = process.env.CODEPLY_AGENT_KEY || '';
const WANT = new Set(String(process.env.CODEPLY_AGENT_TOOLS || 'team').split(',').map((s) => s.trim()).filter(Boolean));

const TEAM = [
  { name: 'team_read', description: 'Read the team channel: the goal, who does which part and how far each teammate is, and the messages since you last read. Read it before you start and every few steps.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Every message from the start, not only the new ones.' } } } },
  { name: 'team_post', description: 'Post a short message on the team channel every teammate reads: what you finished, the files you made, what you need from whom, a question. With "to", it goes straight to that teammate too, even while it works.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string', description: 'A teammate\'s name, for a direct message.' } }, required: ['text'] } },
];
const BROWSER = [
  { name: 'browser_open', description: 'Open a page in your own tab of Codeply\'s browser, which the user watches. Returns the page\'s text and its clickable things, numbered.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The address, like example.com or http://localhost:5173.' } }, required: ['url'] } },
  { name: 'browser_look', description: 'Look at your tab now: its address, title, visible text and clickable things (numbered).', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'Click something in your tab, by its number from your last look. Your cursor glides there first so the user sees it.',
    inputSchema: { type: 'object', properties: { element: { type: 'number' }, double: { type: 'boolean' } }, required: ['element'] } },
  { name: 'browser_type', description: 'Type text. With element, it goes into that field. clear replaces what is there; enter presses Enter after.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, element: { type: 'number' }, clear: { type: 'boolean' }, enter: { type: 'boolean' } }, required: ['text'] } },
  { name: 'browser_keys', description: 'Press a key on the focused element: Enter, Tab, Escape, ArrowDown, Backspace...', inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'browser_scroll', description: 'Scroll your tab: direction up or down, or dy in pixels.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, dy: { type: 'number' } } } },
  { name: 'browser_back', description: 'Go back one page in your tab.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_wait', description: 'Wait for the page (ms, default 1500), then look again.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
];
const TOOLS = [...(WANT.has('team') ? TEAM : []), ...(WANT.has('browser') ? BROWSER : [])];

function call(tool, args) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(URL_); } catch { resolve({ ok: false, text: 'Codeply is not reachable (no endpoint).' }); return; }
    const body = JSON.stringify({ key: KEY, tool, args: args || {} });
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 90000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-codeply-token': TOKEN } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, text: `Codeply answered ${res.statusCode}.` }); } });
    });
    req.on('error', (e) => resolve({ ok: false, text: `Codeply is not reachable: ${e.message}.` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: 'Codeply took too long to answer.' }); });
    req.end(body);
  });
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(m) {
  if (!m || typeof m !== 'object') return;
  const { id, method, params } = m;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codeply', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === (params && params.name));
    if (!tool) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool ${params && params.name}.` }], isError: true } }); return; }
    const r = await call(tool.name, (params && params.arguments) || {});
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String((r && r.text) || (r && r.ok ? 'Done.' : 'It did not work.')) }], isError: !(r && r.ok) } });
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
    let msg = null;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg && msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }); });
  }
});
process.stdin.on('end', () => process.exit(0));
