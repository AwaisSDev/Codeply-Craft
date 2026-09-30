/**
 * A small Model Context Protocol client: enough to connect to MCP servers,
 * list their tools and call them. No SDK dependency; MCP is JSON-RPC 2.0
 * over either a child process's stdio (one JSON message per line) or HTTP
 * ("streamable HTTP": POST a request, get JSON or an SSE stream back).
 *
 * Servers are configured in the same shape Claude Desktop / Cursor use, so an
 * existing config can be pasted in:
 *
 *   ~/.codeply/mcp.json            (every project)
 *   <project>/.codeply/mcp.json    (this project; same name wins)
 *
 *   { "mcpServers": {
 *       "github":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
 *       "docs":    { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } },
 *       "old":     { "command": "...", "disabled": true } } }
 *
 * Connections are kept for the life of the process and reused across turns.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const plugins = require('./plugins.js');

const PROTOCOL_VERSION = '2025-06-18';
const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 120000;
const CLIENT_INFO = { name: 'codeply', version: '1.0' };

function readConfig(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j.mcpServers || j.servers || {};
  } catch { return {}; }
}

/** Merged server config for a project: project entries override global ones. */
function loadServers(cwd) {
  const merged = { ...plugins.mcpServers(cwd), ...readConfig(path.join(os.homedir(), '.codeply', 'mcp.json')) };
  if (cwd) Object.assign(merged, readConfig(path.join(cwd, '.codeply', 'mcp.json')));
  return Object.fromEntries(Object.entries(merged).filter(([, s]) => s && !s.disabled && (s.command || s.url)));
}

// ─── Transports ─────────────────────────────────────────────────────────────

class StdioConnection {
  constructor(name, spec, cwd) {
    this.name = name;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    // npx/npm/uvx are .cmd shims on Windows and only start through a shell.
    // A full path to a program (which may contain spaces) is started
    // directly. Through the shell, arguments are quoted here, since Node
    // just joins them with spaces.
    const cmd = String(spec.command);
    const args = (spec.args || []).map(String);
    const viaShell = process.platform === 'win32' && !/[\\/]/.test(cmd) && !/\.exe$/i.test(cmd);
    const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    this.proc = spawn(viaShell ? [cmd, ...args].map(quote).join(' ') : cmd, viaShell ? [] : args, {
      cwd: spec.cwd || cwd || process.cwd(),
      env: { ...process.env, ...(spec.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: viaShell,
    });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // servers sometimes log to stdout
        this.onMessage(msg);
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-4000); });
    this.proc.on('error', (e) => this.failAll(`could not start: ${e.message}`));
    this.proc.on('exit', (code) => { this.closed = true; this.failAll(`exited (code ${code})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`); });
  }

  onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      // A request from the server (sampling, roots...): we offer none of those.
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by this client' } });
    }
  }

  write(obj) {
    if (!this.closed) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error(`${this.name} is not running`));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }

  failAll(why) {
    for (const [, p] of this.pending) p.reject(new Error(`${this.name} ${why}`));
    this.pending.clear();
  }

  close() { try { this.proc.kill(); } catch {} }
}

class HttpConnection {
  constructor(name, spec) {
    this.name = name;
    this.url = spec.url;
    this.headers = spec.headers || {};
    this.sessionId = null;
    this.nextId = 1;
  }

  async post(body, timeoutMs) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return res;
  }

  async request(method, params, timeoutMs) {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}${res.status === 401 ? ' (needs authorization - add a token under "headers")' : ''}`);
    const type = res.headers.get('content-type') || '';
    let msg = null;
    if (type.includes('text/event-stream')) {
      // Read events until the one answering our id.
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === id) { msg = m; break; } } catch {}
      }
    } else {
      msg = await res.json().catch(() => null);
    }
    if (!msg) throw new Error(`${method}: no response`);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }

  async notify(method, params) {
    try { await this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, 10000); } catch {}
  }

  close() {}
}

// ─── Servers ────────────────────────────────────────────────────────────────

const servers = new Map(); // key -> { name, conn, tools, error, specKey }

function specKey(spec) { return JSON.stringify(spec); }

async function connect(name, spec, cwd) {
  const conn = spec.url ? new HttpConnection(name, spec) : new StdioConnection(name, spec, cwd);
  try {
    const init = await conn.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, CONNECT_TIMEOUT_MS);
    await conn.notify('notifications/initialized');
    const tools = [];
    let cursor;
    do {
      const page = await conn.request('tools/list', cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS);
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return { name, conn, tools, instructions: init?.instructions || '', error: null };
  } catch (e) {
    conn.close();
    return { name, conn: null, tools: [], instructions: '', error: e.message };
  }
}

/**
 * Connect to every configured server for this project (reusing live
 * connections) and return what they offer. Never throws.
 * @returns {Promise<Array<{name, tools, error, instructions}>>}
 */
async function listServers(cwd) {
  const wanted = loadServers(cwd);
  const out = [];
  await Promise.all(Object.entries(wanted).map(async ([name, spec]) => {
    const key = `${cwd}::${name}`;
    let s = servers.get(key);
    const stale = s && (s.specKey !== specKey(spec) || (s.conn && s.conn.closed) || s.error);
    if (!s || stale) {
      if (s?.conn) s.conn.close();
      s = { ...(await connect(name, spec, cwd)), specKey: specKey(spec) };
      servers.set(key, s);
    }
    out.push({ name, tools: s.tools, error: s.error, instructions: s.instructions });
  }));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Tool results as plain text for the model, images kept aside as data URLs. */
function flattenResult(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = [];
  const images = [];
  for (const p of parts) {
    if (p.type === 'text') text.push(p.text);
    else if (p.type === 'image' && p.data) images.push(`data:${p.mimeType || 'image/png'};base64,${p.data}`);
    else if (p.type === 'resource') text.push(p.resource?.text || `[resource ${p.resource?.uri || ''}]`);
    else text.push(`[${p.type} content]`);
  }
  if (!parts.length && result?.structuredContent) text.push(JSON.stringify(result.structuredContent, null, 1));
  return { text: text.join('\n') || '(empty result)', images, isError: !!result?.isError };
}

async function callTool(cwd, serverName, toolName, args) {
  const s = servers.get(`${cwd}::${serverName}`);
  if (!s || !s.conn) throw new Error(`MCP server "${serverName}" is not connected${s?.error ? ` (${s.error})` : ''}.`);
  const result = await s.conn.request('tools/call', { name: toolName, arguments: args || {} }, CALL_TIMEOUT_MS);
  return flattenResult(result);
}

function findTool(cwd, serverName, toolName) {
  const s = servers.get(`${cwd}::${serverName}`);
  return s ? s.tools.find((t) => t.name === toolName) || null : null;
}

function closeAll() {
  for (const [, s] of servers) if (s.conn) s.conn.close();
  servers.clear();
}
process.on('exit', closeAll);

module.exports = { listServers, callTool, findTool, loadServers, closeAll, flattenResult };
