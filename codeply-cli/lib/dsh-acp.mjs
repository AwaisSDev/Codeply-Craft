/**
 * The DSH engine from the terminal.
 *
 * craft-dsh/ (Craft's fork of DeepSeek Harness) speaks ACP, the Agent Client
 * Protocol, over stdio when booted as `dsh --profile acp`. This module starts
 * that process, talks ACP to it, and turns what it reports into the same events
 * runAgent() yields, so the terminal UI renders either engine the same way.
 *
 * The model is Haze 2, reached the same way Craft's desktop engine reaches it
 * (see dsh-engine.js in the app root): a loopback bridge in this process
 * answers the engine's llm-haze adapter through ai.chat() with route.auto, so
 * sign-in, token refresh and Haze limits stay here and no account token ever
 * reaches the engine. The ACP profile ships with DeepSeek's own API as its
 * model, so a small patch overlay (written next to DSH_HOME, never into
 * craft-dsh/) switches it to Haze.
 *
 * Needs Node 24.9+ for the engine, like the desktop app does.
 */
import { spawn, execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN_NODE = [24, 9];
const START_TIMEOUT_MS = 90_000;

const dshHome = () => path.join(os.homedir(), '.codeply', 'dsh');

const HAZE_PATCH = `# Written by the Codeply CLI: the ACP profile answers through Haze 2.
- id: acp
  config:
    provider: haze
    model: haze-2
- id: system-prompt
  config:
    personaPrefix: >-
      You are Codeply, powered by the {{model}} model.
- insert:
    - id: llm-haze
      name: '@codeply/dsh-llm-haze'
    - id: codeply-design-tools
      name: '@codeply/dsh-design-tools'
    - id: codeply-shared-context
      name: '@codeply/dsh-shared-context'
`;

/** Where the engine lives and which Node runs it, or a readable reason it cannot start. */
export function findDsh() {
  const dir = process.env.CODEPLY_DSH_DIR || path.resolve(HERE, '..', '..', 'craft-dsh');
  const bin = path.join(dir, 'apps', 'cli', 'lib', 'bin.js');
  if (!fs.existsSync(bin)) {
    return { error: `The DSH engine is not built at ${dir}. In craft-dsh run: pnpm install, then pnpm run build. Or set CODEPLY_DSH_DIR.` };
  }
  const okVersion = (v) => {
    const [maj, min] = String(v).replace(/^v/, '').split('.').map(Number);
    return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  };
  let node = process.env.CODEPLY_DSH_NODE;
  if (!node && okVersion(process.version)) node = process.execPath;
  if (!node) node = 'node';
  if (node !== process.execPath) {
    let v = '';
    try { v = execFileSync(node, ['-v'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); } catch {}
    if (!okVersion(v)) {
      return { error: `The DSH engine needs Node ${MIN_NODE.join('.')} or newer${v ? `; found ${v}` : ''}. Install Node 24 or set CODEPLY_DSH_NODE.` };
    }
  }
  return { dir, bin, node };
}

// ─── Haze bridge (same contract as dsh-engine.js) ──────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startBridge() {
  const ai = require('./ai.js');
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const design = /^\/design\/(design_direction|design_lint)$/.exec(req.url || '');
    const shared = req.url === '/context' || /^\/brain\/(remember|recall|life_context)$/.test(req.url || '');
    if (req.method !== 'POST' || (req.url !== '/haze' && !design && !shared)) return reply(404, { success: false, error: 'Not found.' });
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${token}`);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return reply(401, { success: false, error: 'Unauthorized.' });
    // The shared context (brain, the user's day, what Codeply did lately), the same as the desktop app's chats get.
    if (shared) {
      try {
        const body = JSON.parse(await readBody(req));
        const sc = require('./shared-context.js');
        const o = { cwd: String(body.cwd || ''), chatId: String(body.chatId || ''), request: String(body.request || '') };
        if (req.url === '/context') return reply(200, { ok: true, text: sc.blockFor({ ...o, native: true }) });
        const r = await sc.runTool(req.url.slice('/brain/'.length), body.args && typeof body.args === 'object' ? body.args : {}, o);
        return reply(200, { ok: !!(r && r.ok), output: String((r && r.output) || '') });
      } catch (e) {
        return reply(200, { ok: false, output: `Codeply's shared context failed: ${e && e.message ? e.message : e}`, text: '' });
      }
    }
    // codeply-taste's tools: Classic's design-tools.mjs (no browser here, so design_lint scans without a render).
    if (design) {
      try {
        const body = JSON.parse(await readBody(req));
        const cwd = String(body.cwd || '');
        if (!cwd || !fs.existsSync(cwd)) return reply(200, { ok: false, output: `${design[1]}: no project folder.` });
        const tools = await import('./design-tools.mjs');
        const r = await tools[design[1]](body.args && typeof body.args === 'object' ? body.args : {}, { cwd });
        return reply(200, { ok: !!(r && r.ok), output: String((r && r.output) || '') });
      } catch (e) {
        return reply(200, { ok: false, output: `${design[1]} failed: ${e && e.message ? e.message : e}` });
      }
    }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const body = JSON.parse(await readBody(req));
      const h = body.haze || {};
      const r = await ai.chat(Array.isArray(body.messages) ? body.messages : [], {
        route: { auto: true },
        ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
        ...(Number.isFinite(body.maxTokens) ? { maxTokens: body.maxTokens } : {}),
        ...(Number.isFinite(body.temperature) ? { temperature: body.temperature } : {}),
        haze: {
          product: 'craft',
          surface: 'cli',
          chatId: `dsh-cli:${String(body.chatId || 'none')}`,
          turnId: String(h.turnId || ''),
          step: Number(h.step) || 0,
          historyCount: Number(h.historyCount) || 0,
        },
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      reply(200, r && typeof r === 'object' ? r : { success: false, error: 'Haze 2 returned nothing.' });
    } catch (e) {
      if (!ac.signal.aborted) reply(500, { success: false, error: e && e.message ? e.message : String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, token, url: `http://127.0.0.1:${server.address().port}/haze` });
    });
  });
}

// ─── ACP client ─────────────────────────────────────────────────────────────

const textOf = (blocks) => (Array.isArray(blocks) ? blocks : [blocks])
  .map((b) => (b && b.type === 'text' ? b.text : b && b.content && b.content.type === 'text' ? b.content.text : ''))
  .filter(Boolean)
  .join('\n');

export class DshEngine {
  /**
   * @param {object} o
   * @param {string} o.cwd - the project folder; the engine's file tools resolve paths from it.
   * @param {string} [o.patch] - the profile patch (default: Haze 2 for the terminal).
   * @param {string} [o.patchName] - its file name under DSH_HOME.
   * @param {{url: string, token: string}} [o.bridge] - a bridge the host already runs (Craft's), else one is started here.
   * @param {boolean} [o.defaultSession] - open one session on start (the terminal's); Craft opens one per chat instead.
   * @param {object} [o.env] - more environment for the engine.
   */
  constructor({ cwd, patch = HAZE_PATCH, patchName = 'codeply-cli-haze.patch.yml', bridge = null, defaultSession = true, env = {} }) {
    this.cwd = cwd;
    this.patch = patch;
    this.patchName = patchName;
    this.ownBridge = !bridge;
    this.bridge = bridge;
    this.defaultSession = defaultSession;
    this.extraEnv = env;
    this.proc = null;
    this.ready = false;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();   // request id → { resolve, reject }
    this.listeners = new Map(); // session id → { onUpdate, onPermission } of its running prompt
    this.open = new Set();      // sessions this engine process has open
    this.stderrTail = '';
    this.exited = null;
    this.starting = null;
    this.busy = 0;              // prompts in flight
  }

  /** Boot the engine (and the terminal's one session). Safe to call more than once. */
  start() {
    if (this.alive() && this.ready && (this.sessionId || !this.defaultSession)) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Whether the engine process is up. */
  alive() {
    return !!this.proc && this.exited === null;
  }

  /**
   * A session for one chat: the saved one when the engine still has it, else a new one.
   * @param {string} [resumeId]
   * @returns {Promise<string>} its id
   */
  async openSession(resumeId) {
    await this.start();
    if (resumeId && this.open.has(resumeId)) return resumeId;
    if (resumeId) {
      try {
        await this.request('session/resume', { sessionId: resumeId, cwd: this.cwd, mcpServers: [] });
        this.open.add(resumeId);
        return resumeId;
      } catch { /* gone, or another folder: start fresh */ }
    }
    const session = await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
    this.open.add(session.sessionId);
    return session.sessionId;
  }

  async _start() {
    const found = findDsh();
    if (found.error) throw new Error(found.error);
    if (!this.bridge) this.bridge = await startBridge();
    fs.mkdirSync(dshHome(), { recursive: true });
    const patchFile = path.join(dshHome(), this.patchName);
    fs.writeFileSync(patchFile, this.patch);
    this.exited = null;

    this.proc = spawn(found.node, [found.bin, '--profile', 'acp', '--patch', patchFile], {
      cwd: this.cwd, // the invoking directory is the engine's workspace root
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_HOME: dshHome(),
        // Classic's bundled skills (codeply-taste and the rest) for the harness too.
        DSH_BUNDLED_SKILL_DIR: path.resolve(HERE, '..', 'skills'),
        ...this.extraEnv,
        CODEPLY_HAZE_BRIDGE_URL: this.bridge.url,
        CODEPLY_HAZE_BRIDGE_TOKEN: this.bridge.token,
        NO_COLOR: '1',
      },
    });
    const child = this.proc;
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this._dispatch(msg);
      }
    });
    child.stderr.on('data', (c) => { this.stderrTail = (this.stderrTail + c.toString()).slice(-4000); });
    child.once('exit', (code) => {
      this.exited = code;
      this.ready = false;
      this.open.clear();
      this.sessionId = null;
      const why = new Error(`The DSH engine stopped (exit ${code}). ${this.lastLines()}`.trim());
      for (const p of this.pending.values()) p.reject(why);
      this.pending.clear();
    });
    child.once('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`The DSH engine took too long to start. ${this.lastLines()}`.trim())), START_TIMEOUT_MS));
    await Promise.race([
      this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      timeout,
    ]);
    this.ready = true;
    if (!this.defaultSession) return;
    const session = await Promise.race([this.request('session/new', { cwd: this.cwd, mcpServers: [] }), timeout]);
    this.sessionId = session.sessionId;
  }

  lastLines() {
    return this.stderrTail.trim().split(/\r?\n/).slice(-3).join(' ');
  }

  _send(msg) {
    if (!this.proc || this.exited !== null) throw new Error('The DSH engine is not running.');
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this._send({ id, method, params }); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params) {
    try { this._send({ method, params }); } catch {}
  }

  _dispatch(msg) {
    // A response to one of our requests.
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'ACP error'));
      else p.resolve(msg.result);
      return;
    }
    // A request from the engine: today only permission prompts.
    if (msg.id != null && msg.method) {
      const answer = (result) => { try { this._send({ id: msg.id, result }); } catch {} };
      const onPermission = this._listener(msg.params)?.onPermission;
      if (msg.method === 'session/request_permission' && onPermission) {
        Promise.resolve(onPermission(msg.params)).then(answer, () => answer({ outcome: { outcome: 'cancelled' } }));
      } else if (msg.method === 'session/request_permission') {
        answer({ outcome: { outcome: 'cancelled' } });
      } else {
        try { this._send({ id: msg.id, error: { code: -32601, message: `Unsupported: ${msg.method}` } }); } catch {}
      }
      return;
    }
    if (msg.method === 'session/update') {
      const onUpdate = this._listener(msg.params)?.onUpdate;
      if (onUpdate) onUpdate(msg.params && msg.params.update);
    }
  }

  /** The running prompt a message belongs to, by its session id (the only one when it names none). */
  _listener(params) {
    const sid = params && params.sessionId;
    if (sid && this.listeners.has(sid)) return this.listeners.get(sid);
    return this.listeners.size === 1 ? [...this.listeners.values()][0] : null;
  }

  /**
   * Send one prompt and yield runAgent-shaped events until the turn ends.
   * `approve(request)` resolves to 'once' | 'always' | 'reject', like the
   * Classic engine's approval bridge.
   */
  async *prompt(text, { approve, signal, sessionId } = {}) {
    await this.start();
    const sid = sessionId || this.sessionId;
    const queue = [];
    let wake = null;
    const emit = (e) => { queue.push(e); if (wake) { wake(); wake = null; } };
    const calls = new Map(); // toolCallId → { name, args }
    const startedAt = Date.now();
    let steps = 0;

    const onUpdate = (u) => {
      if (!u) return;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          const t = textOf(u.content);
          if (t.trim()) emit({ type: 'text', text: t });
          break;
        }
        case 'agent_thought_chunk': {
          const t = textOf(u.content);
          if (t.trim()) emit({ type: 'reasoning', text: t, ms: 0 });
          break;
        }
        case 'tool_call': {
          const args = u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : { input: u.rawInput };
          calls.set(u.toolCallId, { name: u.title || 'tool', args });
          steps++;
          emit({ type: 'tool_start', name: u.title || 'tool', args, engine: 'dsh' });
          break;
        }
        case 'tool_call_update': {
          if (u.status !== 'completed' && u.status !== 'failed') break;
          const call = calls.get(u.toolCallId) || { name: u.title || 'tool', args: {} };
          const out = textOf(u.content);
          emit({
            type: 'tool_end',
            engine: 'dsh',
            name: call.name,
            args: call.args,
            ok: u.status === 'completed',
            output: out,
            error: u.status === 'failed' ? out : undefined,
          });
          break;
        }
        default:
          break;
      }
    };

    const onPermission = async (params) => {
      const id = params && params.toolCall && params.toolCall.toolCallId;
      const call = calls.get(id) || { name: 'tool', args: {} };
      const verdict = approve
        ? await approve({ tool: `dsh:${call.name}`, title: `Allow ${call.name}`, detail: summarizeArgs(call.args), args: call.args, engine: 'dsh' })
        : 'reject';
      const opts = (params && params.options) || [];
      const pick = (kind) => (opts.find((o) => o.kind === kind) || {}).optionId;
      const optionId = verdict === 'reject' ? (pick('reject_once') || 'reject-once') : (pick('allow_once') || 'allow-once');
      return { outcome: { outcome: 'selected', optionId } };
    };

    this.listeners.set(sid, { onUpdate, onPermission });
    this.busy++;
    const onAbort = () => this.notify('session/cancel', { sessionId: sid });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    let finished = false;
    let failure = null;
    let stopReason = null;
    this.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] })
      .then((r) => { stopReason = r && r.stopReason; })
      .catch((e) => { failure = e; })
      .finally(() => { finished = true; if (wake) { wake(); wake = null; } });

    try {
      while (true) {
        if (queue.length) { yield queue.shift(); continue; }
        if (finished) break;
        await new Promise((r) => { wake = r; });
      }
      if (signal && signal.aborted) { yield { type: 'aborted' }; return; }
      if (failure) { yield { type: 'error', error: failure.message }; return; }
      if (stopReason === 'cancelled') { yield { type: 'aborted' }; return; }
      yield { type: 'done', steps, writtenFiles: [], secs: Math.round((Date.now() - startedAt) / 1000) };
    } finally {
      this.listeners.delete(sid);
      this.busy--;
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  close() {
    const child = this.proc;
    this.proc = null;
    this.ready = false;
    if (this.bridge && this.ownBridge) { try { this.bridge.server.close(); } catch {} this.bridge = null; }
    if (!child || child.exitCode !== null) return;
    // The engine spawns its own workers: end the whole tree.
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
  }
}

/** One readable line for a tool's arguments, for the approval prompt. */
export function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return String(args ?? '');
  const key = ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'url', 'query'].find((k) => typeof args[k] === 'string');
  if (key) return args[key];
  const s = JSON.stringify(args);
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}
