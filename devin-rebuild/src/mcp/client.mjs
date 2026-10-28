/**
 * Minimal Model Context Protocol client: stdio, streamable HTTP and legacy
 * SSE transports, initialize handshake, tools/list and tools/call.
 */
import { spawn } from 'node:child_process';
import { sse } from '../providers/http.mjs';
import { expandServer } from './config.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'dvn', version: '0.1.0' };

class RpcBase {
  constructor(name) { this.name = name; this.nextId = 1; this.pending = new Map(); this.closed = false; }
  handleMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${this.name}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      // Server-to-client request (roots/list, ping...). Answer politely.
      const result = msg.method === 'roots/list' ? { roots: [] } : {};
      this.send({ jsonrpc: '2.0', id: msg.id, result }).catch(() => {});
    }
  }
  request(method, params, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error(`${this.name}: connection closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e) => { clearTimeout(timer); this.pending.delete(id); reject(e); });
    });
  }
  notify(method, params) { return this.send({ jsonrpc: '2.0', method, params }); }
  failAll(err) {
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
    this.pending.clear();
  }
}

class StdioTransport extends RpcBase {
  constructor(name, { command, args = [], env = {}, cwd }) {
    super(name);
    this.stderr = '';
    this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { this.handleMessage(JSON.parse(line)); } catch { /* not JSON-RPC; servers sometimes log to stdout */ }
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-4000); });
    this.child.on('error', (e) => this.failAll(new Error(`${name}: could not start '${command}': ${e.message}`)));
    this.child.on('close', (code) => this.failAll(new Error(`${name}: server exited (code ${code})${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`)));
  }
  async send(msg) {
    if (this.closed) throw new Error(`${this.name}: connection closed`);
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  close() { this.closed = true; try { this.child.kill(); } catch { /* gone */ } }
}

class HttpTransport extends RpcBase {
  constructor(name, { url, headers = {} }) { super(name); this.url = url; this.headers = headers; this.sessionId = null; }
  async send(msg) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}), ...this.headers },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 401) throw Object.assign(new Error(`${this.name}: unauthorized (401). This server needs OAuth or a header token.`), { status: 401 });
    if (!res.ok && res.status !== 202) throw Object.assign(new Error(`${this.name}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim()), { status: res.status });
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      for await (const { data } of sse(res)) { try { this.handleMessage(JSON.parse(data)); } catch { /* ignore */ } }
    } else if (type.includes('application/json')) {
      const body = await res.json();
      for (const m of Array.isArray(body) ? body : [body]) this.handleMessage(m);
    }
  }
  close() {
    this.closed = true;
    if (this.sessionId) fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId, ...this.headers } }).catch(() => {});
  }
}

class SseTransport extends RpcBase {
  constructor(name, { url, headers = {} }) {
    super(name);
    this.headers = headers;
    this.abort = new AbortController();
    this.ready = new Promise((resolve, reject) => {
      (async () => {
        const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: this.abort.signal });
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        for await (const { event, data } of sse(res)) {
          if (event === 'endpoint') { this.postUrl = new URL(data, url).href; resolve(); continue; }
          try { this.handleMessage(JSON.parse(data)); } catch { /* ignore */ }
        }
      })().catch((e) => { reject(e); this.failAll(e); });
    });
  }
  async send(msg) {
    await this.ready;
    const res = await fetch(this.postUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers }, body: JSON.stringify(msg) });
    if (!res.ok && res.status !== 202) throw new Error(`${this.name}: HTTP ${res.status}`);
  }
  close() { this.closed = true; this.abort.abort(); }
}

/** Connect, initialize and return { tools, call, close, serverInfo }. */
export async function connectMcp(name, server, { cwd, timeoutMs = 30_000 } = {}) {
  const cfg = expandServer(server);
  const transport = cfg.transport || cfg.type?.replace('streamable-http', 'http') || (cfg.url || cfg.serverUrl ? 'http' : 'stdio');
  const url = cfg.url || cfg.serverUrl;
  const t = transport === 'stdio' ? new StdioTransport(name, { command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd || cwd })
    : transport === 'sse' ? new SseTransport(name, { url, headers: cfg.headers })
      : new HttpTransport(name, { url, headers: cfg.headers });
  try {
    const init = await t.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: CLIENT_INFO }, timeoutMs);
    await t.notify('notifications/initialized', {});
    const tools = [];
    let cursor;
    do {
      const page = await t.request('tools/list', cursor ? { cursor } : {}, timeoutMs);
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
    return {
      name,
      serverInfo: init.serverInfo,
      instructions: init.instructions,
      tools,
      call: (tool, args, ms = 600_000) => t.request('tools/call', { name: tool, arguments: args ?? {} }, ms),
      request: (method, params, ms = 60_000) => t.request(method, params, ms),
      close: () => t.close(),
    };
  } catch (e) {
    t.close();
    // Streamable HTTP refused with a non-auth 4xx: try the legacy SSE transport on the same URL.
    if (transport === 'http' && !cfg.transport && (e.status === 404 || e.status === 405)) return connectMcp(name, { ...server, transport: 'sse' }, { cwd, timeoutMs });
    throw e;
  }
}

/** Flatten an MCP tools/call result into tool-result content. */
export function mcpResultContent(result) {
  const parts = [];
  for (const c of result?.content || []) {
    if (c.type === 'text') parts.push({ type: 'text', text: c.text });
    else if (c.type === 'image') parts.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } });
    else if (c.type === 'resource') parts.push({ type: 'text', text: c.resource?.text ?? `[resource ${c.resource?.uri}]` });
    else parts.push({ type: 'text', text: JSON.stringify(c) });
  }
  if (!parts.length && result?.structuredContent) parts.push({ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) });
  return { isError: !!result?.isError, content: parts.length ? parts : '(empty result)' };
}
