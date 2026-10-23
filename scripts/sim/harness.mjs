// Life simulation: a person's busy days, played through the real Codeply code.
//
// What runs for real: Crew's main process (crew/crew-main.js, with a stand-in
// for Electron), the agent loop and its tools (agent.mjs, tools.mjs), the bots,
// the shared brain and its desktop host (brain.js, brain-desktop.js), the
// autopilot that works handed-on tasks (autopilot.js), the life store and
// life context, and the Gmail watcher's scoring (mail-watch.js).
//
// What is pretend: the world. Google Calendar, Gmail and web search answer
// from an in-memory world, so nothing real is ever booked or sent. The clock
// is simulated (Date is replaced), so a week passes in minutes.
//
// The model is NOT scripted. Every call Codeply makes to a model (chat turns,
// tool use, memory learning, reflection, mail drafts) goes to:
//   - a bridge (--bridge <dir>): each request is written to a file and the
//     answer is read back. A real AI agent answers them, as the model would,
//     without seeing the persona's checks. See model-bridge.mjs.
//   - or a real model: SIM_BASE_URL, SIM_API_KEY, SIM_MODEL (any
//     OpenAI-compatible endpoint).
//
// Only the checks are written down in advance, and they check outcomes (what
// the brain kept, what was booked, sent or refused), not the model's wording.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import Module, { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'codeply-cli');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 200) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// ─── The simulated clock ────────────────────────────────────────────────────

const RealDate = Date;
let offset = 0;
class SimDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = SimDate;

/** Local wall-clock time on day `d` (0 = the persona's first day), in the persona's TZ. */
function localTime(base, d, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new RealDate(base.y, base.m - 1, base.d + d, h, m, 0).getTime();
}
function setClock(t) { const want = t - RealDate.now(); if (want > offset) offset = want; }
const DAYNAME = (t) => new RealDate(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// ─── The model: a bridge to an AI agent, or a real endpoint ─────────────────

function modelServer({ bridgeDir, real, log }) {
  const pending = new Map(); // hash -> promise of the answer text
  let n = 0;
  let toolRefWritten = false;
  let lastSystem = { hash: '', n: 0 };
  const stats = { calls: 0, waiting: 0 };

  function renderSystem(sys) {
    // The tool reference is the same 30 KB every time: written once to tools.md.
    const start = sys.indexOf('OUTPUT FORMAT\n\nYou have no function-calling');
    let body = sys;
    if (start >= 0) {
      const endMark = sys.indexOf('\nCONNECTED SERVICES', start);
      const end = endMark > start ? endMark : sys.indexOf('\nPROJECT CONTEXT', start);
      if (end > start) {
        if (!toolRefWritten) { fs.writeFileSync(path.join(bridgeDir, 'tools.md'), sys.slice(start, end)); toolRefWritten = true; }
        body = `${sys.slice(0, start)}[TOOL REFERENCE: exactly the text in tools.md, which you have read]\n${sys.slice(end)}`;
      }
    }
    return body;
  }

  function render(body, id) {
    const msgs = body.messages || [];
    const json = !!(body.response_format || (msgs.length === 1 && msgs[0].role === 'user'));
    const lines = [];
    if (msgs[0] && msgs[0].role === 'system') {
      const sys = String(msgs[0].content || '');
      const h = crypto.createHash('sha1').update(sys).digest('hex');
      if (h === lastSystem.hash) lines.push(`## System prompt\n(unchanged from request ${lastSystem.n})`);
      else lines.push(`## System prompt\n${renderSystem(sys)}`);
      lastSystem = { hash: h, n: id };
    }
    lines.push('## Messages');
    for (const m of msgs) {
      if (m.role === 'system') continue;
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      lines.push(`### ${m.role}\n${c}`);
    }
    const head = json
      ? `# Request ${id}: a JSON call. Reply with ONLY the JSON object it asks for.`
      : `# Request ${id}: a chat/agent turn. Reply exactly as the assistant would: plain text, with <codeply:...> action blocks when it acts.`;
    return { json, text: `${head}\n\n${lines.join('\n\n')}\n` };
  }

  async function answer(body) {
    const key = crypto.createHash('sha1').update(JSON.stringify(body.messages || [])).digest('hex');
    if (pending.has(key)) return pending.get(key); // a client retry of the same request
    const p = (async () => {
      const id = ++n;
      stats.calls++; stats.waiting++;
      try {
        if (real) {
          const res = await fetch(`${real.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${real.apiKey}` },
            body: JSON.stringify({ model: real.model, messages: body.messages, temperature: 0.4 }),
          });
          const j = await res.json();
          const text = j.choices?.[0]?.message?.content || '';
          log({ kind: 'model', id, request: render(body, id).text.slice(0, 4000), answer: text });
          return text;
        }
        const r = render(body, id);
        const f = path.join(bridgeDir, `req-${String(id).padStart(4, '0')}.md`);
        fs.writeFileSync(`${f}.tmp`, r.text); fs.renameSync(`${f}.tmp`, f);
        const resFile = path.join(bridgeDir, `res-${String(id).padStart(4, '0')}.txt`);
        while (!fs.existsSync(resFile)) await sleep(250);
        await sleep(50);
        const text = fs.readFileSync(resFile, 'utf8').replace(/\s+$/, '');
        log({ kind: 'model', id, json: r.json, answer: text });
        return text;
      } finally { stats.waiting--; }
    })();
    pending.set(key, p);
    return p;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      if (!/chat\/completions/.test(req.url)) { res.writeHead(404); return res.end('{}'); }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const ping = setInterval(() => { try { res.write(': waiting for the model\n\n'); } catch {} }, 10000);
        const text = await answer(body);
        clearInterval(ping);
        for (const piece of text.match(/[\s\S]{1,200}/g) || ['']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const text = await answer(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }], usage: {} }));
    });
  });
  server.keepAliveTimeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return { server, stats };
}

// ─── The pretend world: Google Calendar, Gmail, the web ─────────────────────

function makeWorld(persona, life) {
  const w = { calendar: [], sent: [], drafts: [], inbox: [], posts: [], phone: [] };
  let seq = 0;
  const mirror = (ev) => {
    if (!life.store) return;
    const at = Date.parse(ev.start.dateTime || ev.start.date);
    const end = Date.parse(ev.end.dateTime || ev.end.date);
    life.store.upsertItem({ id: `calendar:${ev.id}`, source: 'calendar', kind: 'event', at, end, title: ev.summary, place: ev.location || '', people: (ev.attendees || []).map((a) => a.email), data: { allDay: !!ev.start.date } });
  };
  w.addEvent = (ev, by = 'world') => {
    const e = { id: `ev${++seq}`, status: 'confirmed', ...ev, by };
    w.calendar.push(e); mirror(e);
    return e;
  };
  // Moved or renamed by a bot (calendar_update): the life store follows, as the real sync would.
  w.patchEvent = (id, patch) => {
    const e = w.calendar.find((x) => x.id === id);
    if (!e) return null;
    Object.assign(e, patch, { changedBy: 'codeply' });
    mirror(e);
    return e;
  };
  w.cancelEvent = (id) => {
    const i = w.calendar.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [e] = w.calendar.splice(i, 1);
    w.cancelled = [...(w.cancelled || []), { ...e, cancelledAt: Date.now() }];
    if (life.store) life.store.deleteItem(`calendar:${id}`);
    return e;
  };
  w.useStore = (s) => { life.store = s; };
  w.eventsBetween = (a, b) => w.calendar.filter((e) => { const s = Date.parse(e.start.dateTime || e.start.date); return s >= a && s < b; });
  return w;
}

function installGoogle(world, oauth, webTools, persona) {
  oauth.refreshGmailToken = async () => ({ access_token: 'sim-token', expires_in: 360000 });
  oauth.calendarListEvents = async (tok, { timeMin, timeMax, maxResults = 20 }) => {
    const a = timeMin ? Date.parse(timeMin) : 0; const b = timeMax ? Date.parse(timeMax) : Infinity;
    return world.eventsBetween(a, b).sort((x, y) => Date.parse(x.start.dateTime || x.start.date) - Date.parse(y.start.dateTime || y.start.date)).slice(0, maxResults);
  };
  oauth.calendarInsertEvent = async (tok, ev) => { const e = world.addEvent(ev, 'codeply'); return { id: e.id, htmlLink: '' }; };
  oauth.calendarPatchEvent = async (tok, id, patch) => {
    const e = world.patchEvent(id, patch);
    if (!e) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { id: e.id, summary: e.summary, htmlLink: '' };
  };
  oauth.calendarDeleteEvent = async (tok, id) => {
    if (!world.cancelEvent(id)) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { ok: true };
  };
  // cc stays on the sent record, so a check can see who was copied.
  oauth.gmailSend = async (tok, m) => { world.sent.push({ ...m, cc: m.cc || '', at: Date.now() }); return { id: `sent${world.sent.length}` }; };
  oauth.gmailGetMessage = async (tok, id) => {
    const m = world.inbox.find((x) => x.id === id);
    if (!m) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { id: m.id, threadId: `t${m.id}`, from: m.from, to: persona.email, cc: m.cc || '', date: new Date(m.at).toUTCString(), subject: m.subject, body: m.body };
  };
  oauth.gmailCreateDraft = async (tok, d) => { world.drafts.push({ ...d, at: Date.now() }); return { id: `d${world.drafts.length}`, message: { id: `dm${world.drafts.length}`, threadId: d.threadId || '' } }; };
  oauth.gmailSearch = async (tok, q) => {
    const words = String(q || '').toLowerCase().split(/\s+/).filter((x) => x && !x.includes(':'));
    return world.inbox.filter((m) => !words.length || words.some((x) => `${m.subject} ${m.from} ${m.body}`.toLowerCase().includes(x)))
      .slice(-10).reverse().map((m) => ({ id: m.id, subject: m.subject, from: m.from, date: new Date(m.at).toUTCString(), snippet: short(m.body, 180) }));
  };
  oauth.slackPostMessage = async (tok, channel, text) => { world.posts.push({ channel, text, at: Date.now() }); return { ok: true, ts: String(Date.now()) }; };
  webTools.webSearch = async (query) => ({ ok: true, text: (persona.web && persona.web(query)) || `Search results for "${query}":\n1. (no useful results in this simulation)` });
  webTools.fetchPage = async (url) => ({ ok: true, text: (persona.pages && persona.pages[url]) || `Page ${url}: (not available in this simulation)` });
}

// ─── Fake Gmail for the watcher (mail-watch.js talks HTTP to it) ────────────

function gmailServer(world, persona) {
  const g = { historyId: 100, history: [], messages: {}, sent: new Set((persona.knownSenders || []).map((x) => x.toLowerCase())) };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname.replace(/^\/gmail\/v1\/users\/me/, '');
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (p === '/profile') return send(200, { emailAddress: persona.email, historyId: String(g.historyId) });
      if (p === '/history') { const start = Number(u.searchParams.get('startHistoryId')); return send(200, { history: g.history.filter((h) => Number(h.id) > start), historyId: String(g.historyId) }); }
      if (p === '/messages') {
        const q = u.searchParams.get('q') || '';
        const to = (q.match(/in:sent to:(\S+)/) || [])[1];
        if (to) return send(200, g.sent.has(to.toLowerCase()) ? { messages: [{ id: 'sent1' }] } : {});
        return send(200, { messages: Object.keys(g.messages).map((id) => ({ id })) });
      }
      const mm = p.match(/^\/messages\/([^/]+)$/);
      if (mm) return g.messages[mm[1]] ? send(200, g.messages[mm[1]]) : send(404, { error: { message: 'gone' } });
      if (p === '/drafts' && req.method === 'POST') { const b = JSON.parse(raw); world.drafts.push({ raw: b.message.raw, threadId: b.message.threadId, at: Date.now() }); return send(200, { id: `d${world.drafts.length}`, message: { id: `dm${world.drafts.length}`, threadId: b.message.threadId } }); }
      send(404, { error: { message: 'no route' } });
    });
  });
  g.deliver = (m) => {
    const id = `m${Object.keys(g.messages).length + 1}`;
    const headers = { From: m.from, To: persona.email, Subject: m.subject, 'Message-ID': `<${id}@sim>`, Date: new Date().toUTCString(), ...(m.headers || {}) };
    g.messages[id] = { id, threadId: `t${id}`, internalDate: String(Date.now()), labelIds: m.labels || ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'], snippet: short(m.body, 200),
      payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: Buffer.from(m.body).toString('base64url') } } };
    g.history.push({ id: String(++g.historyId), messagesAdded: [{ message: { id, labelIds: g.messages[id].labelIds } }] });
    world.inbox.push({ id, from: m.from, subject: m.subject, body: m.body, at: Date.now() });
    return id;
  };
  return { server, g };
}

// ─── Boot the real app around a persona ─────────────────────────────────────

export async function runPersona(persona, { out, bridgeDir, real }) {
  fs.mkdirSync(out, { recursive: true });
  const home = process.env.HOME;
  const transcript = [];
  const log = (e) => { transcript.push({ at: Date.now(), ...e }); fs.appendFileSync(path.join(out, 'events.jsonl'), `${JSON.stringify({ at: Date.now(), ...e })}\n`); };
  const base = persona.start;
  setClock(localTime(base, 0, '06:00'));

  // A stand-in for Electron: just enough for crew-main.js.
  const handlers = new Map(); const listeners = new Map();
  const crewEvents = [];
  const waiters = new Set();
  let approvalPolicy = () => 'once';
  const onSend = (ch, p) => {
    if (ch !== 'crew:event' || !p) return;
    crewEvents.push({ at: Date.now(), ...p });
    if (p.type === 'approval') {
      const verdict = approvalPolicy(p);
      log({ kind: 'approval', bot: p.botId, tool: p.tool, title: p.title, detail: short(p.detail, 600), verdict });
      setTimeout(() => listeners.get('crew:approval:respond')({}, { requestId: p.requestId, verdict }), 30);
    }
    if (['notice', 'error'].includes(p.type)) log({ kind: p.type, bot: p.botId, text: p.text });
    for (const w of [...waiters]) w(p);
  };
  class Win {
    constructor() { this.webContents = { send: onSend, isDestroyed: () => false, session: { setPermissionRequestHandler() {} }, on() {} }; }
    once() {} on() {} setMenu() {} loadFile() {} show() {} focus() {} restore() {} minimize() {} maximize() {} setBounds() {}
    isDestroyed() { return false; } isMinimized() { return false; } isMaximized() { return false; }
  }
  const electron = {
    app: { getPath: () => path.join(home, 'appdata'), on() {}, whenReady: () => Promise.resolve() },
    BrowserWindow: Win, BrowserView: Win,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn), removeHandler() {} },
    shell: { openExternal() {}, openPath: async () => '' },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(String(t), 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8') },
  };
  const voicePath = path.join(ROOT, 'crew', 'voice.js');
  const voiceStub = { init() {}, prepare: async () => ({}), transcribe: async () => '', speak: async () => null, voiceList: () => [], engineOf: () => 'none', deepgramCheck: async () => ({}) };
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return electron;
    try { if (Module._resolveFilename(req, parent, isMain) === voicePath) return voiceStub; } catch {}
    return origLoad.apply(this, arguments);
  };

  const lib = (n) => require(path.join(CLI, 'lib', n));
  const config = lib('config.js');
  const oauth = lib('oauth-connectors.js');
  const webTools = lib('web-tools.js');
  const telemetry = lib('telemetry.js');
  const B = lib('bots.js');
  const BR = lib('brain.js');
  const L = lib('life.js');
  const MW = lib('mail-watch.js');
  const ai = lib('ai.js');

  // The model behind everything.
  const model = modelServer({ bridgeDir, real, log });
  await new Promise((r) => model.server.listen(0, '127.0.0.1', r));
  const saved = config.saveModel({ name: 'Simulated model', kind: 'openai', baseUrl: `http://127.0.0.1:${model.server.address().port}/v1`, model: real ? real.model : 'bridge', apiKey: 'sim' });
  config.selectModel(saved.model ? saved.model.id : saved.id);
  const route = { custom: config.getSelectedModel() };
  // Google is "connected" (the world answers instead of Google).
  config.saveIntegration('gmail', { accessToken: 'sim-token', refreshToken: 'sim', clientId: 'x', clientSecret: 'y', expiresAt: Date.now() + 10 * 365 * 86400000, email: persona.email, scope: Object.values(oauth.GOOGLE_SCOPE).join(' ') + ' https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' });

  // Life, the real always-on engine (life-desktop.js): one store every bot
  // reads, the calendar and Gmail synced from the world, and the minute's
  // look for something worth telling the user (driven by "tick" steps).
  const tz = process.env.TZ;
  fs.mkdirSync(path.join(home, '.codeply', 'life'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codeply', 'life', 'settings.json'), JSON.stringify({
    on: true,
    sources: { calendar: true, gmail: true, calls: true, projects: true, activity: true, screen: false, heard: false, orbit: true, plans: true, botmail: true, slack: true, tasks: true, health: true },
    nudges: { on: true, perDay: 8, phone: true, quiet: { on: false, from: '23:00', to: '06:00' }, triggers: { brief: !!persona.brief }, botFor: {} },
  }));
  const lifeDesktop = require(path.join(ROOT, 'life-desktop.js'));
  const store0 = lib('life-store.js').openLifeStore({ file: path.join(home, '.codeply', 'life', 'life.db') });
  const world = makeWorld(persona, { store: store0 });
  installGoogle(world, oauth, webTools, persona);
  for (const ev of persona.calendar || []) {
    const s = localTime(base, ev.day, ev.at); const e = s + (ev.minutes || 60) * 60000;
    world.addEvent({ summary: ev.title, location: ev.place || '', start: { dateTime: new RealDate(s).toISOString() }, end: { dateTime: new RealDate(e).toISOString() }, attendees: (ev.with || []).map((x) => ({ email: x })) });
  }

  // Crew (the real main process), the brain host and the autopilot.
  const crewMod = require(path.join(ROOT, 'crew', 'crew-main.js'));
  crewMod.open(CLI);
  await handlers.get('crew:app:init')({});
  const agentMod = await import(pathToFileURL(path.join(CLI, 'lib', 'agent.mjs')).href);
  let gapiRef = null;
  const nudgeLog = (botId, msg) => { if (msg && msg.kind === 'nudge' && !msg.feedback) log({ kind: 'nudge', bot: (B.getBot(botId) || {}).name, trigger: msg.trigger, text: msg.text }); };
  lifeDesktop.init({
    ipcMain: electron.ipcMain, cliDir: CLI, safeStorage: electron.safeStorage, Notification: undefined, notifyIcon: '',
    userDataDir: path.join(home, 'appdata'), modulePaths: [ROOT, CLI],
    configLib: () => config, oauthLib: () => oauth, aiLib: () => ai, currentRoute: () => route,
    gmailToken: async () => 'sim-token', gmailApi: () => gapiRef, callFunction: (n, b) => callFunction(n, b),
    projects: () => [], crewThread: (botId, msg) => { nudgeLog(botId, msg); crewMod.addNote(CLI, botId, msg); }, crewEvent: (ev) => crewMod.pushEvent(ev), openBot() {},
    onTask: (t) => autopilot.intake(t), autopilotState: () => autopilot.state(),
    screenText: async () => null, screenRead: async () => null, screenCapture: async () => null, screenStop() {}, listenState: () => ({}), onListenChange() {}, callState: () => ({}), takeoverReady: () => false,
  });
  const store = lifeDesktop.getStore();
  world.useStore(store); store0.close();
  const brainDesktop = require(path.join(ROOT, 'brain-desktop.js'));
  const autopilot = require(path.join(ROOT, 'autopilot.js'));
  let outboxPolicy = () => 'wait';
  const callFunction = async (name, body) => {
    const r = body && body.reminder;
    if (r) {
      world.phone.push({ text: r.text, kind: r.kind, bot: r.bot_name, at: Date.now() });
      log({ kind: 'phone', bot: r.bot_name, text: r.text });
      const ob = r.payload && r.payload.autopilot && r.payload.autopilot.outbox;
      if (ob) {
        const o = store.getOutbox(ob);
        const action = outboxPolicy(o || { id: ob, title: r.text });
        log({ kind: 'outbox', id: ob, title: o && o.title, detail: o && short(o.detail, 400), decision: action });
        if (action === 'now' || action === 'cancel') setTimeout(() => handlers.get('crew:life:outbox')({}, ob, action), 100);
      }
    }
    return { success: true };
  };
  brainDesktop.init({
    ipcMain: electron.ipcMain, cliDir: CLI, modulePaths: [ROOT, CLI], aiLib: () => ai,
    intake: (t) => autopilot.intake(t),
    crewThread: (botId, msg) => crewMod.addNote(CLI, botId, msg),
    crewEvent: (ev) => crewMod.pushEvent(ev),
  });
  autopilot.init({
    ipcMain: electron.ipcMain, cliDir: CLI, ensureEngine: async () => true, Notification: undefined, notifyIcon: '',
    configLib: () => config, oauthLib: () => oauth, aiLib: () => ai, currentRoute: () => route,
    callFunction, localTz: () => tz,
    life: lifeDesktop,
    crewThread: (botId, msg) => crewMod.addNote(CLI, botId, msg), openBot() {},
    agentMod: () => agentMod, botsMail: null, projects: () => [], workspace: () => crewMod.workspace(CLI),
    stopCrew() {}, stopCalls() {},
    handOffFor: (o) => brainDesktop.handOffFor(o),
    onTaskEnd: (task, status, report) => { log({ kind: 'task_end', bot: task.botId, status, report: short(report, 600) }); brainDesktop.taskEnded(task, status, report); },
  });

  // The Gmail watcher, as bots-watch.js runs it.
  const gm = gmailServer(world, persona);
  await new Promise((r) => gm.server.listen(0, '127.0.0.1', r));
  const gapi = MW.gmailApi({ token: async () => 'sim-token', base: `http://127.0.0.1:${gm.server.address().port}/gmail/v1/users/me` });
  gapiRef = gapi;
  const notify = async (ev) => {
    log({ kind: 'mail_event', bot: ev.botName, from: ev.fromName, subject: ev.subject, level: ev.level, drafted: !!ev.draftId, summary: ev.summary });
    crewMod.addMail(CLI, ev.botId, { ...ev, text: MW.eventLine(ev) });
    const h = await brainDesktop.onImportantEmail(ev);
    if (h) log({ kind: 'handoff_from_email', ok: h.ok, output: h.output });
  };
  const pollMail = () => telemetry.withProduct('crew', () => MW.watchOnce({ bots: B.listBots(), api: gapi, chat: (m) => ai.chatJson(m, { route }), rawEmail: oauth.rawEmail, notify }));

  // ─── What a step can do ───────────────────────────────────────────────────

  const botByName = (name) => B.listBots().find((b) => b.name.toLowerCase() === String(name).toLowerCase());
  const thread = (name) => { const b = botByName(name); return b ? (JSON.parse(fs.readFileSync(path.join(home, 'appdata', 'Codeply Crew', 'crew-store.json'), 'utf8')).threads[b.id] || { messages: [] }).messages : []; };
  const modelCalls = () => transcript.filter((e) => e.kind === 'model');

  async function settle(label) {
    // Quiet: no model call waiting, no task queued or running, for 3 seconds.
    let quiet = 0;
    const t0 = RealDate.now();
    while (quiet < 3000) {
      await sleep(500);
      const busy = model.stats.waiting > 0 || store.tasksByStatus('queued', 1).length || store.tasksByStatus('running', 1).length || store.tasksByStatus('verifying', 1).length;
      quiet = busy ? 0 : quiet + 500;
      if (RealDate.now() - t0 > 45 * 60000) { log({ kind: 'warn', text: `${label}: still busy after 45 minutes` }); break; }
    }
  }

  async function crewSay(botName, text) {
    const bot = botByName(botName);
    if (!bot) throw new Error(`no bot ${botName}`);
    const startN = crewEvents.length;
    const done = new Promise((resolve) => { const w = (p) => { if (p.botId === bot.id && p.type === 'done') { waiters.delete(w); resolve(); } }; waiters.add(w); });
    const r = await handlers.get('crew:chat:send')({}, { botId: bot.id, text });
    if (r && r.error) { log({ kind: 'error', text: r.error }); return; }
    await done;
    const evs = crewEvents.slice(startN).filter((e) => e.botId === bot.id);
    for (const e of evs) {
      if (e.type === 'text') log({ kind: 'reply', bot: bot.name, text: e.text });
      if (e.type === 'tool') log({ kind: 'tool', bot: bot.name, name: e.name, label: e.label, ok: e.ok, error: e.error });
    }
    await settle(`${botName}: ${short(text, 40)}`);
  }

  const craftDirs = new Map();
  async function craftSay(folder, text) {
    const cwd = path.join(home, 'code', folder);
    fs.mkdirSync(cwd, { recursive: true });
    const hist = craftDirs.get(folder) || [];
    let reply = '';
    await telemetry.withProduct('craft', async () => {
      const run = agentMod.runAgent({ userMessage: text, history: hist, mode: 'Build', cwd, approve: async () => 'once', signal: new AbortController().signal, route, maxSteps: 16, haze: { product: 'craft', chatId: `sim-${folder}` } });
      for await (const ev of run) {
        if (ev.type === 'text' && !ev.interim) { reply += (reply ? '\n\n' : '') + ev.text; log({ kind: 'reply', bot: `Craft (${folder})`, text: ev.text }); }
        if (ev.type === 'tool_end') log({ kind: 'tool', bot: `Craft (${folder})`, name: ev.name, label: short(ev.summary || (ev.args && (ev.args.path || ev.args.text)) || '', 140), ok: ev.ok });
        if (ev.type === 'error') log({ kind: 'error', text: ev.error });
        if (ev.type === 'done') break;
      }
      brainDesktop.learnFromCraft({ userText: text, replyText: reply, cwd, route, withBot: false });
    });
    craftDirs.set(folder, [...hist, { role: 'user', content: text }, { role: 'assistant', content: reply || '(no reply)' }].slice(-8));
    await settle(`Craft: ${short(text, 40)}`);
  }

  async function email(m) {
    gm.g.deliver(m);
    log({ kind: 'email_in', from: m.from, subject: m.subject, body: short(m.body, 300) });
    await pollMail();
    await settle(`email ${m.subject}`);
  }

  // Health samples (persona.health: [{ day, at, kind, value, minutes, title, sleepHours }]), sent as their time comes.
  const healthSent = new Set();
  function healthDue(t) {
    const due = (persona.health || []).filter((x) => !healthSent.has(x) && localTime(base, x.day, x.at || '20:00') <= t);
    if (!due.length) return [];
    const samples = due.map((x) => {
      const at = localTime(base, x.day, x.at || '20:00');
      if (x.kind === 'workout') return { kind: 'workout', title: x.title, at, end: at + (x.minutes || 30) * 60000 };
      if (x.kind === 'sleep') return { kind: 'sleep', at: at - x.sleepHours * 3600000, end: at };
      return { kind: x.kind, at, value: x.value, title: x.title };
    });
    L.noteHealth(samples, { tz });
    log({ kind: 'health', count: samples.length });
    return due;
  }

  // The minute's look for something worth saying (calendar and Gmail synced first, as the pollers do).
  async function tick(stamp) {
    lifeDesktop.poke('calendar'); lifeDesktop.poke('gmail');
    await sleep(1500);
    await pollMail();
    await lifeDesktop.tick();
    await settle(`tick ${stamp}`);
  }

  const brainIpc = (ch, ...a) => handlers.get(`crew:brain:${ch}`)({}, ...a);
  const H = {
    persona, world, store, B, BR, L, log, transcript, crewEvents, modelCalls, thread, botByName, brainIpc,
    mem: (re, f = {}) => BR.list({ limit: 1000, ...f }).filter((m) => re.test(`${m.slot} ${m.value} ${m.text}`)),
    memAll: () => BR.list({ limit: 1000, includeExpired: true }),
    handoffs: () => BR.recentHandoffs(100),
    nudges: (since = 0) => transcript.filter((e) => e.kind === 'nudge' && e.at >= since),
    phone: (since = 0) => transcript.filter((e) => e.kind === 'phone' && e.at >= since),
    tasks: () => store.recentTasks(100),
    /** The last agent request a bot got (its system prompt and turn), as text. */
    lastPromptFor: (who) => {
      const calls = transcript.filter((e) => e.kind === 'prompt' && e.who === who);
      return calls.length ? calls[calls.length - 1].text : '';
    },
    replies: (who, since = 0) => transcript.filter((e) => e.kind === 'reply' && e.bot === who && e.at >= since).map((e) => e.text).join('\n'),
    now: () => Date.now(),
  };

  // Every agent prompt is kept (by bot), so checks can see what the model was given.
  const origAnswerLog = log;
  model.server.on('request', (req) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        const sys = body.messages && body.messages[0] && body.messages[0].role === 'system' ? String(body.messages[0].content) : '';
        if (!sys) return;
        const who = (/You are ([^,]+), (?:the orchestrator|a specialist bot)/.exec(sys) || [])[1] || 'Craft';
        // The message carrying this turn's context (the brain block, the screen).
        const txt = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        const turn = [...body.messages].reverse().find((m) => m.role === 'user' && txt(m).includes('<turn-context>'));
        transcript.push({ at: Date.now(), kind: 'prompt', who, text: `${sys}\n\n${turn ? txt(turn) : ''}` });
      } catch {}
    });
  });
  void origAnswerLog;

  // ─── Run the days ─────────────────────────────────────────────────────────

  for (const bot of persona.bots) {
    const r = await handlers.get('crew:bots:create')({}, bot);
    if (r && r.error) throw new Error(r.error);
  }
  await pollMail(); // the watcher starts its cursor
  approvalPolicy = persona.approve || (() => 'once');
  outboxPolicy = persona.outbox || (() => 'wait');

  const results = [];
  for (const step of persona.steps) {
    const t = localTime(base, step.day || 0, step.at || '09:00');
    setClock(t);
    const stamp = DAYNAME(Date.now());
    const since = Date.now();
    const label = step.tick && !step.crew ? (step.label || 'Time passes: the bots look for something worth saying') : step.crew ? `${step.crew}: "${step.say}"` : step.craft ? `Craft in ${step.craft}: "${step.say}"` : step.email ? `Email from ${step.email.from}: "${step.email.subject}"` : step.label || 'step';
    log({ kind: 'step', when: stamp, label });
    console.log(`\n[${persona.key}] ${stamp}  ${short(label, 140)}`);
    // Health data from the phone or watch, up to now.
    for (const smp of healthDue(Date.now())) healthSent.add(smp);
    try {
      if (step.tick) await tick(stamp);
      if (step.crew) await crewSay(step.crew, step.say);
      else if (step.craft) await craftSay(step.craft, step.say);
      else if (step.email) await email(step.email);
      if (step.do) await step.do(H);
    } catch (e) { log({ kind: 'error', text: `step failed: ${e.stack || e.message}` }); console.log(`  step failed: ${e.message}`); }
    for (const [name, fn, level = 'must'] of step.expect || []) {
      let ok = false; let detail = '';
      try { const r = await fn(H, since); ok = r === true || (r && r.ok === true); detail = r && r.detail ? r.detail : ''; } catch (e) { detail = e.message; }
      results.push({ when: stamp, step: label, name, ok, level, detail });
      log({ kind: 'check', name, ok, level, detail });
      console.log(`  ${ok ? 'ok  ' : level === 'must' ? 'FAIL' : 'note'}  ${name}${!ok && detail ? ` (${short(detail, 200)})` : ''}`);
    }
  }

  // ─── The report ───────────────────────────────────────────────────────────
  writeReport(persona, { out, transcript, results, H });
  model.server.close(); gm.server.close();
  return results;
}

function writeReport(persona, { out, transcript, results, H }) {
  const lines = [`# ${persona.name}: ${persona.role}`, '', persona.about || '', ''];
  const must = results.filter((r) => r.level === 'must');
  lines.push(`**Checks:** ${must.filter((r) => r.ok).length} of ${must.length} passed${results.some((r) => r.level !== 'must') ? `; ${results.filter((r) => r.level !== 'must' && r.ok).length} of ${results.filter((r) => r.level !== 'must').length} behaviour notes held` : ''}.`, '');
  let cur = null;
  for (const e of transcript) {
    if (e.kind === 'step') { lines.push('', `## ${e.when}: ${e.label}`, ''); cur = e; continue; }
    if (!cur) continue;
    if (e.kind === 'reply') lines.push(`> **${e.bot}:** ${String(e.text).replace(/\n/g, '\n> ')}`, '');
    else if (e.kind === 'tool') lines.push(`- tool \`${e.name}\` ${e.ok ? 'ok' : 'failed'}: ${short(e.label, 160)}${e.error ? ` (${short(e.error, 120)})` : ''}`);
    else if (e.kind === 'approval') lines.push(`- approval asked: ${e.title} -> **${e.verdict}**`);
    else if (e.kind === 'outbox') lines.push(`- outbox: ${short(e.title, 160)} -> **${e.decision}**`);
    else if (e.kind === 'phone') lines.push(`- phone notification from ${e.bot}: ${short(e.text, 200)}`);
    else if (e.kind === 'nudge') lines.push(`- **${e.bot} reached out (${e.trigger}):** ${short(e.text, 300)}`);
    else if (e.kind === 'notice') lines.push(`- notice: ${short(e.text, 200)}`);
    else if (e.kind === 'task_end') lines.push(`- task finished (${e.status}): ${short(e.report, 300)}`);
    else if (e.kind === 'mail_event') lines.push(`- mail watcher: ${e.bot} flagged "${e.subject}" from ${e.from} (${e.level}${e.drafted ? ', drafted a reply' : ''})`);
    else if (e.kind === 'handoff_from_email') lines.push(`- handed on from the email: ${short(e.output, 200)}`);
    else if (e.kind === 'email_in') lines.push(`- email arrived: "${e.subject}" from ${e.from}`);
    else if (e.kind === 'error') lines.push(`- ERROR: ${short(e.text, 400)}`);
    else if (e.kind === 'check') lines.push(`- ${e.ok ? '✅' : e.level === 'must' ? '❌' : '⚠️'} ${e.name}${!e.ok && e.detail ? ` (${short(e.detail, 300)})` : ''}`);
  }
  lines.push('', '## What the brain knows at the end', '');
  for (const m of H.memAll()) lines.push(`- [${m.kind}${m.project ? ` / ${m.project}` : ''}] ${m.text} (${m.locked ? 'set by user' : m.status}${m.review ? ', needs a look' : ''}${m.challenger ? `, heard instead: "${short(m.challenger.text, 80)}"` : ''}${m.history.length ? `, was: "${short(m.history[m.history.length - 1].text, 80)}"` : ''})`);
  lines.push('', '## Ignored or changed (the brain\'s log)', '');
  for (const c of H.BR.changes({ limit: 200 }).reverse()) lines.push(`- ${c.action}: ${short(c.text, 200)}${c.source ? ` (${c.source})` : ''}`);
  lines.push('', '## Handoffs', '');
  for (const h of H.handoffs().reverse()) lines.push(`- ${h.fromName} -> ${h.toName || 'nobody'} (${h.status}): ${short(h.intent, 200)}${h.result ? ` | result: ${short(h.result, 200)}` : ''}`);
  lines.push('', '## The world at the end', '', `- calendar: ${H.world.calendar.map((e) => `${e.summary} @ ${new Date(Date.parse(e.start.dateTime || e.start.date)).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}${e.by === 'codeply' ? ' (added by Codeply)' : ''}`).join('; ') || 'empty'}`,
    `- email sent: ${H.world.sent.map((m) => `to ${m.to}: ${m.subject}`).join('; ') || 'none'}`, `- drafts: ${H.world.drafts.length}`, `- posts: ${H.world.posts.length}`, `- phone notifications: ${H.world.phone.length}`);
  fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n'));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
}
