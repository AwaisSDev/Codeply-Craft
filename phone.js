// Craft on the phone: an AI chat app with a Code side, like the Claude app.
//
//  Chat  Plain chat through Codeply's ai-proxy (the same daily limit as Code).
//        No PC needed. Chats live in this phone's localStorage.
//  Code  Work on a project. With the PC online it runs there, through the
//        Supabase Realtime relay (same protocol as mobile.js). With the PC
//        off, a bottom sheet offers the cloud: a runner in the user's own
//        GitHub account (protocol from codeply-cli/lib/cloud.mjs), set up
//        right here or already set up from the PC.
'use strict';

const $ = (id) => document.getElementById(id);

// Public project URL + anon key: the same values the desktop app and CLI ship.
const SUPABASE_URL = 'https://zswkhfkfseclgadhvobg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpzd2toZmtmc2VjbGdhZGh2b2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzYyOTgsImV4cCI6MjA5NTgxMjI5OH0.EoTQdIGQQDrN1uEqQfya3VmrQMT68jkzPLphbLwNTWg';
const AI_PROXY_URL = `${SUPABASE_URL}/functions/v1/ai-proxy`;
// Models synced from Craft ("Use on my phone"): listed without their keys, and
// chatted with through byok-proxy, which holds the encrypted key. No PC needed.
const USER_MODELS_URL = `${SUPABASE_URL}/functions/v1/user-models`;
const BYOK_PROXY_URL = `${SUPABASE_URL}/functions/v1/byok-proxy`;

const CHAT_SYSTEM = 'You are Codeply, the assistant in the Codeply phone app. This is a normal chat: you cannot see, open or change any files, run code or browse here. Answer clearly and keep it readable on a phone screen; use short paragraphs, lists and fenced code blocks when they help. If someone wants changes made to one of their projects, tell them to switch to Code in the composer. When a GMAIL note appears in the conversation, it is the user’s own inbox read live just now: answer from it directly (who wrote, about what, what needs a reply) and never say you cannot see their email.';

// ─── Small helpers ──────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randHex = (n) => { const b = new Uint8Array(Math.ceil(n / 2)); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, n); };
const newId = () => Date.now().toString(36) + randHex(6);
function makeClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
}
function clip(text, maxLines = 40) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n... ${lines.length - maxLines} more lines` : lines.join('\n');
}
const bytesToB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64ToBytes = (b64) => Uint8Array.from(atob(String(b64).replace(/\s/g, '')), (c) => c.charCodeAt(0));
const textToB64 = (text) => bytesToB64(new TextEncoder().encode(String(text)));

const ICONS = {
  chev: '<svg class="chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1 .5 7.97V18Z"/></svg>',
  check: '<svg class="check-mark" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  system: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
};

// Just enough markdown for replies on a phone: fenced code, `code`, **bold**,
// *italic*, headings, lists, links. Escapes first, so text never injects markup.
function inlineMd(s) {
  return String(s).split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  }).join('');
}
function md(src) {
  const parts = String(src || '').replace(/\r\n/g, '\n').split(/^```/m);
  return parts.map((part, i) => {
    if (i % 2) {
      const nl = part.indexOf('\n');
      const body = nl >= 0 ? part.slice(nl + 1) : '';
      return `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
    }
    return mdBlocks(part.replace(/^[^\n]*\n?/, i === 0 ? '$&' : ''));
  }).join('');
}
// A markdown table (| a | b | rows), drawn as a real table that scrolls sideways on a narrow screen.
function mdTable(lines) {
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map(cells);
  if (!rows.length) return '';
  const [head, ...rest] = rows;
  return `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function mdBlocks(text) {
  const out = [];
  let para = []; let list = null; let table = null;
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.type}>${list.items.map((x) => `<li>${inlineMd(x)}</li>`).join('')}</${list.type}>`); list = null; };
  const flushTable = () => { if (table) out.push(mdTable(table)); table = null; };
  for (const line of text.split('\n')) {
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); (table || (table = [])).push(line); continue; }
    flushTable();
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length <= 2 ? 3 : 4}>${inlineMd(h[2])}</h${h[1].length <= 2 ? 3 : 4}>`); continue; }
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList(); flushTable();
  return out.join('');
}

// ─── Theme ──────────────────────────────────────────────────────────────────
const themeChoice = () => { const t = localStorage.getItem('craft-theme'); return t === 'dark' || t === 'light' ? t : 'system'; };
function applyTheme(choice) {
  if (choice === 'system') { localStorage.removeItem('craft-theme'); delete document.documentElement.dataset.theme; }
  else { localStorage.setItem('craft-theme', choice); document.documentElement.dataset.theme = choice; }
  syncTheme();
}
function syncTheme() {
  const c = themeChoice();
  const dark = c === 'dark' || (c === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  $('themeColorMeta').content = dark ? '#1f1f1e' : '#faf9f5';
  $('themeBtn').innerHTML = ICONS[c];
  $('themeBtn').title = c === 'system' ? 'Theme: match the phone' : `Theme: ${c}`;
}
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);

// ─── State ──────────────────────────────────────────────────────────────────
const KEY = {
  chats: 'craft-phone-chats', chat: (id) => `craft-phone-chat-${id}`, pc: 'craft-phone-pc', envs: 'craft-phone-envs',
  ui: 'craft-phone-ui', creds: 'craft-cloud-creds', client: 'craft-client-id', bypass: 'craft-bypass',
  synced: 'craft-phone-synced',
};
const clientId = localStorage.getItem(KEY.client) || makeClientId();
localStorage.setItem(KEY.client, clientId);

const state = {
  chats: load(KEY.chats, []),     // [{ id, title, kind: 'chat'|'code', cloud, project, pcSessionId, cloudSessionId, updatedAt, live }]
  bodies: new Map(),              // chat id -> { messages, pcItems, tasks }
  current: null,                  // chat id, or null for a new chat
  ui: { mode: 'chat', projectKey: null, codeMode: 'Build', chatModel: 'auto', ...load(KEY.ui, {}) },
  synced: load(KEY.synced, []),   // [{ id, clientId, name, model, baseUrl, key }] from user-models, keys masked
  bypass: localStorage.getItem(KEY.bypass) === '1',
  pc: load(KEY.pc, { device: '', projects: [], sessions: [], models: null }),
  envs: load(KEY.envs, {}),       // repo -> cloud environment set up from the phone
  creds: load(KEY.creds, null),   // { token, login, projects: [{ cwd, name, repo }], at, source }
  user: null,
  busy: new Set(),                // chat ids with a run or reply in flight
  chatAbort: null,
  approval: null,
  imagePick: null,
};
const saveUi = () => save(KEY.ui, { mode: state.ui.mode, projectKey: state.ui.projectKey, codeMode: state.ui.codeMode, chatModel: state.ui.chatModel });

/** The synced model Chat uses, or null for Auto. */
function chatModel() {
  return (state.ui.chatModel && state.ui.chatModel !== 'auto' && state.synced.find((m) => m.id === state.ui.chatModel)) || null;
}
/** Refreshes the synced models (metadata only). Quiet on failure: the cached list stays. */
let syncedLoading = null;
function loadSynced() {
  if (syncedLoading) return syncedLoading;
  syncedLoading = (async () => {
    try {
      const token = await accessToken();
      const res = await fetch(USER_MODELS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success || !Array.isArray(data.models)) return;
      state.synced = data.models.map((m) => ({ id: m.id, clientId: m.clientId, name: m.name, model: m.model, baseUrl: m.baseUrl, key: m.key }));
      save(KEY.synced, state.synced);
      if (state.ui.chatModel !== 'auto' && !chatModel()) { state.ui.chatModel = 'auto'; saveUi(); }
      renderComposer();
    } catch {} finally { syncedLoading = null; }
  })();
  return syncedLoading;
}
const isSyncedOnPhone = (pcModel) => !!pcModel && (pcModel.synced || state.synced.some((s) => s.clientId === pcModel.id));
const saveChats = () => save(KEY.chats, state.chats);
const chatMeta = (id) => state.chats.find((c) => c.id === id) || null;
function body(id) {
  if (!state.bodies.has(id)) state.bodies.set(id, { messages: [], pcItems: [], tasks: [], ...load(KEY.chat(id), {}) });
  return state.bodies.get(id);
}
function saveBody(id) {
  const b = body(id);
  if (save(KEY.chat(id), b)) return;
  // localStorage is full: drop the biggest step lists of finished cloud runs first.
  const slim = { ...b, tasks: (b.tasks || []).map((t, i, all) => (i < all.length - 2 && !isLive(t) ? { ...t, events: [] } : t)) };
  if (!save(KEY.chat(id), slim)) save(KEY.chat(id), { ...slim, pcItems: (b.pcItems || []).slice(-60) });
}
function touchChat(id, patch = {}) {
  const c = chatMeta(id);
  if (!c) return;
  Object.assign(c, patch, { updatedAt: Date.now() });
  saveChats();
  renderChatList();
  renderTitle();
}
function createChat(kind, extra = {}) {
  const chat = { id: newId(), title: '', kind, cloud: false, updatedAt: Date.now(), ...extra };
  state.chats.unshift(chat);
  state.bodies.set(chat.id, { messages: [], pcItems: [], tasks: [] });
  saveChats();
  return chat;
}
const titleFrom = (text) => {
  const sh = window.CodeplyAttach ? window.CodeplyAttach.split(text) : { text, files: [] };
  const t = String(sh.text || (sh.files[0] ? sh.files[0].name : '') || '').replace(/\s+/g, ' ').trim();
  return t.length > 46 ? `${t.slice(0, 45)}...` : t;
};

// ─── Projects and cloud environments ────────────────────────────────────────
const normCwd = (p) => String(p || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
function repoForCwd(cwd) {
  if (!cwd) return null;
  const n = normCwd(cwd);
  const fromPc = ((state.creds && state.creds.projects) || []).find((p) => p.cwd && normCwd(p.cwd) === n);
  if (fromPc) return fromPc.repo;
  const env = Object.values(state.envs).find((e) => e.cwd && normCwd(e.cwd) === n);
  return env ? env.repo : null;
}
/** Every project the phone knows: the PC's folders, and cloud environments (from the PC or set up here). */
function allProjects() {
  const out = [];
  const seenRepo = new Set();
  for (const cwd of state.pc.projects || []) {
    const repo = repoForCwd(cwd);
    if (repo) seenRepo.add(repo);
    out.push({ key: `cwd:${normCwd(cwd)}`, name: basename(cwd), cwd, repo });
  }
  for (const p of (state.creds && state.creds.projects) || []) {
    if (seenRepo.has(p.repo)) continue;
    seenRepo.add(p.repo);
    out.push({ key: `repo:${p.repo}`, name: p.name || p.repo.split('/')[1], cwd: p.cwd || null, repo: p.repo });
  }
  for (const e of Object.values(state.envs)) {
    if (seenRepo.has(e.repo)) continue;
    seenRepo.add(e.repo);
    out.push({ key: `repo:${e.repo}`, name: e.name || e.repo.split('/')[1], cwd: e.cwd || null, repo: e.repo });
  }
  return out;
}
const projectByKey = (key) => allProjects().find((p) => p.key === key) || null;
function currentProject() {
  const c = state.current && chatMeta(state.current);
  if (c && c.project) return { ...c.project, repo: c.project.repo || repoForCwd(c.project.cwd) };
  return projectByKey(state.ui.projectKey);
}
/** The cloud environment for a project, or null when it still needs setting up. */
function envFor(project) {
  if (!project) return null;
  const repo = project.repo || repoForCwd(project.cwd);
  if (!repo) return null;
  if (state.envs[repo]) return state.envs[repo];
  const fromPc = ((state.creds && state.creds.projects) || []).find((p) => p.repo === repo);
  if (fromPc) return { repo, name: fromPc.name, cwd: fromPc.cwd || null, base: null, fromPc: true };
  return null;
}

// ─── Supabase auth + relay to the PC (same protocol as mobile.js) ───────────
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'craft-phone-auth' },
});
async function currentSession() { const { data } = await sb.auth.getSession(); return (data && data.session) || null; }
async function accessToken() {
  const s = await currentSession();
  if (!s) throw new Error('You are signed out. Sign in again.');
  return s.access_token;
}

const RELAY_CHUNK = 60000;
const relay = { channel: null, pcId: null, pcs: [], pending: new Map(), parts: new Map(), connecting: null, noPc: false, retry: null };

function relaySend(event, obj) {
  if (!relay.channel) return;
  const str = JSON.stringify(obj);
  const id = newId();
  const n = Math.max(1, Math.ceil(str.length / RELAY_CHUNK));
  for (let i = 0; i < n; i++) relay.channel.send({ type: 'broadcast', event, payload: { id, i, n, d: str.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK) } });
}
function relayAssemble(payload) {
  if (!payload || typeof payload.d !== 'string') return null;
  if (payload.n === 1) { try { return JSON.parse(payload.d); } catch { return null; } }
  if (payload.n > 200) return null;
  for (const [k, e] of relay.parts) if (Date.now() - e.at > 60000) relay.parts.delete(k);
  let entry = relay.parts.get(payload.id);
  if (!entry) { entry = { n: payload.n, got: 0, chunks: [], at: Date.now() }; relay.parts.set(payload.id, entry); }
  if (entry.chunks[payload.i] === undefined) { entry.chunks[payload.i] = payload.d; entry.got++; }
  if (entry.got < entry.n) return null;
  relay.parts.delete(payload.id);
  try { return JSON.parse(entry.chunks.join('')); } catch { return null; }
}
function updatePcs() {
  const ps = relay.channel ? relay.channel.presenceState() : {};
  relay.pcs = Object.entries(ps).map(([key, metas]) => ({ deviceId: key, ...(metas[0] || {}) })).sort((a, b) => (b.since || 0) - (a.since || 0));
  const was = relay.pcId;
  if (!relay.pcs.some((p) => p.deviceId === relay.pcId)) relay.pcId = (relay.pcs[0] && relay.pcs[0].deviceId) || null;
  renderPcStatus();
  if (relay.pcId && relay.pcId !== was) onPcOnline();
}
async function openRelay() {
  if (relay.channel) return;
  const { data, error } = await sb.auth.getUser();
  if (error || !data || !data.user) throw new Error('signed out');
  state.user = data.user;
  renderAccount();
  const secret = data.user.user_metadata && data.user.user_metadata.craft_relay;
  if (!secret) { relay.noPc = true; return; } // never signed in on a PC: Code goes to the cloud
  const channel = sb.channel(`craft-${data.user.id}-${secret}`, { config: { broadcast: { self: false } } });
  channel.on('broadcast', { event: 'res' }, ({ payload }) => {
    const msg = relayAssemble(payload);
    if (!msg) return;
    const p = relay.pending.get(msg.id);
    if (!p) return;
    relay.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.status >= 200 && msg.status < 300) p.resolve(msg.body);
    else p.reject(Object.assign(new Error((msg.body && msg.body.error) || 'Your PC could not do that.'), { status: msg.status }));
  });
  channel.on('broadcast', { event: 'event' }, ({ payload }) => {
    const msg = relayAssemble(payload);
    if (!msg || (relay.pcId && msg.from && msg.from !== relay.pcId)) return;
    delete msg.from;
    try { receiveEvent(msg); } catch (e) { console.warn('[craft] event failed:', e); }
  });
  channel.on('presence', { event: 'sync' }, updatePcs);
  relay.channel = channel;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 12000);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(status)); }
    });
  });
}
async function closeRelay() {
  clearTimeout(relay.retry);
  for (const [, p] of relay.pending) { clearTimeout(p.timer); p.reject(new Error('Disconnected.')); }
  relay.pending.clear();
  if (relay.channel) { try { await sb.removeChannel(relay.channel); } catch {} }
  Object.assign(relay, { channel: null, pcId: null, pcs: [], connecting: null });
  renderPcStatus();
}
/** Connect in the background; the app never waits on it. Retries quietly. */
function startRelay() {
  if (relay.connecting || relay.channel) return relay.connecting;
  relay.connecting = openRelay().catch(async (e) => {
    if (relay.channel) { try { await sb.removeChannel(relay.channel); } catch {} relay.channel = null; }
    if (e.message !== 'signed out') { clearTimeout(relay.retry); relay.retry = setTimeout(startRelay, 15000); }
  }).finally(() => { relay.connecting = null; });
  return relay.connecting;
}
function waitForPc(ms) {
  if (relay.pcId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => { if (relay.pcId || Date.now() - started > ms) { clearInterval(tick); resolve(!!relay.pcId); } }, 150);
  });
}
async function relayRequest(method, path, reqBody, timeoutMs = 25000) {
  if (!relay.channel || !relay.pcId) throw new Error('Your PC is offline.');
  const id = newId();
  const token = await accessToken();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { relay.pending.delete(id); reject(Object.assign(new Error("Your PC didn't answer. Make sure it's on, awake and online."), { timeout: true })); }, timeoutMs);
    relay.pending.set(id, { resolve, reject, timer });
    relaySend('req', { id, to: relay.pcId, method, path, body: reqBody == null ? null : reqBody, accessToken: token });
  });
}

/** The PC showed up: load its projects, chats and models, and its GitHub login for the cloud. */
async function onPcOnline() {
  try {
    const data = await relayRequest('GET', '/api/bootstrap');
    state.pc = { device: data.device || '', projects: data.projects || [], lastProject: data.lastProject || null, sessions: data.sessions || [], models: data.models || null, at: Date.now() };
    save(KEY.pc, state.pc);
    for (const id of data.activeSessionIds || []) { const c = state.chats.find((x) => x.pcSessionId === id); if (c) state.busy.add(c.id); }
    if (!state.ui.projectKey && data.lastProject) { state.ui.projectKey = `cwd:${normCwd(data.lastProject)}`; saveUi(); }
    renderChatList();
    renderPcStatus();
  } catch (e) { console.warn('[craft] bootstrap failed:', e.message); }
  try {
    const c = await relayRequest('GET', '/api/cloud/credentials');
    if (c && c.token) { state.creds = { ...(state.creds || {}), token: c.token, projects: c.projects || [], at: Date.now(), source: 'pc', expired: false }; save(KEY.creds, state.creds); renderComposer(); }
  } catch {}
  const c = state.current && chatMeta(state.current);
  if (c && c.pcSessionId && !c.cloud) refreshPcSession(c).catch(() => {});
  loadSynced(); // the PC may just have synced a model
  window.dispatchEvent(new CustomEvent('craft:pc-online')); // phone-calls.js refreshes the bots
}
function renderPcStatus() {
  const el = $('pcStatus');
  el.classList.toggle('on', !!relay.pcId);
  const meta = relay.pcs.find((p) => p.deviceId === relay.pcId);
  el.querySelector('span').textContent = relay.pcId ? ((meta && meta.device) || state.pc.device || 'PC online') : 'PC offline';
  renderComposer();
}

// ─── Feed rendering ─────────────────────────────────────────────────────────
const feed = () => $('feed');
let streamEl = null; // the agent message being streamed from the PC
function showFeed(on) {
  $('empty').classList.toggle('hidden', on);
  $('feed').classList.toggle('hidden', !on);
}
function scrollToBottom() {
  const el = $('scroll');
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); });
}
const nearBottom = () => { const el = $('scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 160; };
function append(node) { showFeed(true); feed().append(node); return node; }
function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }

function addMsg(kind, text) {
  streamEl = null;
  if (kind === 'user' && window.CodeplyAttach) {
    const sh = window.CodeplyAttach.split(text);
    if (sh.files.length) {
      const row = el('div', 'msg-files');
      row.innerHTML = sh.files.map((f) => window.CodeplyAttach.chipHtml(f)).join('');
      append(row);
      if (!sh.text) return row;
    }
    text = sh.text;
  }
  const n = el('div', `msg ${kind}`);
  if (kind === 'user' || kind === 'error' || kind === 'note') n.textContent = text || '';
  else n.innerHTML = md(text);
  return append(n);
}
function addDelta(text) {
  if (!streamEl || !streamEl.isConnected) { streamEl = append(el('div', 'msg agent')); streamEl.dataset.raw = ''; }
  streamEl.dataset.raw += text || '';
  streamEl.innerHTML = md(streamEl.dataset.raw);
  return streamEl;
}

const TOOL_VERB = {
  todo: 'Updated task list', ask_user: 'Asked you', mcp: 'Used', read_file: 'Read', write_file: 'Wrote', edit_file: 'Edited', apply_patch: 'Edited',
  run: 'Ran', search: 'Searched', list_dir: 'Listed', browser_check: 'Checked', fetch_image: 'Downloaded', use_skill: 'Loaded skill',
  list_skills: 'Searched skills', view_images: 'Viewed', design_reference_search: 'Searched designs', gmail_send: 'Emailed',
  gmail_search: 'Searched Gmail', slack_post_message: 'Posted', vercel_deploy: 'Deployed', vercel_api: 'Vercel', supabase_api: 'Supabase',
  supabase_sql: 'Ran SQL', supabase_create_project: 'Created project', supabase_delete_project: 'Deleted project', github_create_repo: 'Pushed',
};

/** A tool row, tap to see what really ran. t: { name, label, ok, args, exitCode, added, removed } */
function toolHtml(t, extraBody = '') {
  const failed = t.ok === false || (typeof t.exitCode === 'number' && t.exitCode !== 0);
  const stats = [];
  if (typeof t.added === 'number' && ['edit_file', 'write_file', 'apply_patch'].includes(t.name)) stats.push(`<span class="add">+${t.added}</span>`);
  if (typeof t.removed === 'number' && ['edit_file', 'apply_patch'].includes(t.name)) stats.push(`<span class="del">-${t.removed}</span>`);
  if (typeof t.exitCode === 'number') stats.push(`<span class="${t.exitCode === 0 ? 'add' : 'del'}">exit ${t.exitCode}</span>`);
  const a = t.args || {};
  let b = '';
  if (t.name === 'run' && a.command) b = `<div class="step-body-label">Command</div><pre class="code">${esc(a.command)}</pre>`;
  else if (t.name === 'edit_file' && (a.search || a.replace)) {
    b = `<div class="step-body-label">${esc(a.path || '')}</div>`
      + `<pre class="code del">${esc(clip(a.search)).replace(/^/gm, '- ')}</pre>`
      + `<pre class="code add">${esc(clip(a.replace)).replace(/^/gm, '+ ')}</pre>`;
  } else if (t.name === 'write_file') b = `<div class="step-body-label">${esc(a.path || '')}${typeof t.added === 'number' ? ` (${t.added} lines)` : ''}</div>`;
  else if (t.name === 'apply_patch' && Array.isArray(a.files)) b = `<div class="step-body-label">${a.files.map((f) => esc(typeof f === 'string' ? f : f.path || f.file || '')).join('<br>')}</div>`;
  else if (t.name === 'supabase_sql' && a.query) b = `<div class="step-body-label">SQL</div><pre class="code">${esc(clip(a.query))}</pre>`;
  else if (Object.keys(a).length && !(t.name === 'browser_check' && extraBody)) b = `<pre class="code">${esc(clip(Object.entries(a).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'), 20))}</pre>`;
  b += extraBody;
  const label = t.label || a.path || a.command || a.pattern || a.url || '';
  return `<details class="step tool${failed ? ' failed' : ''}${b ? '' : ' no-body'}"${extraBody ? ' open' : ''}><summary>${ICONS.chev}`
    + `<span class="step-verb">${esc(TOOL_VERB[t.name] || t.name || 'Ran')}</span><span class="step-label">${esc(label)}</span>`
    + `${stats.length ? `<span class="step-stats">${stats.join('')}</span>` : ''}</summary><div class="step-body">${b}</div></details>`;
}
const thinkingHtml = (text, label = 'Thinking') => `<details class="step thinking"><summary>${ICONS.chev}<span>${esc(label)}</span></summary><div class="step-text">${esc(text)}</div></details>`;
function summaryHtml(d) {
  const files = d.files || []; const checks = d.checks || [];
  if (!files.length && !checks.length) return '';
  const line = (c) => {
    const passed = c.ok && (c.exitCode === undefined || c.exitCode === null || c.exitCode === 0);
    return `<div class="check ${passed ? 'pass' : 'fail'}">${passed ? '&#10003;' : '&#10007;'} ${esc(c.tool === 'browser_check' ? `Opened ${c.label}` : c.label)}${typeof c.exitCode === 'number' ? ` <span>exit ${c.exitCode}</span>` : ''}</div>`;
  };
  return `<div class="summary-card"><div class="summary-head">What actually happened</div>`
    + `${files.length ? `<div class="summary-files">${files.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}${checks.map(line).join('')}`
    + `${(d.unverified || []).length ? `<div class="check fail">Not verified: ${d.unverified.map(esc).join(', ')}</div>` : ''}</div>`;
}
function fileListHtml(list) {
  return `<ul class="file-list">${list.slice(0, 20).map((f) => `<li><code>${esc(f.file)}</code>${f.added != null ? `<span class="add">+${f.added}</span><span class="del">-${f.removed}</span>` : ''}</li>`).join('')}${list.length > 20 ? `<li><code>and ${list.length - 20} more</code></li>` : ''}</ul>`;
}
function pushedHtml(e) {
  const files = e.files || [];
  const n = files.length;
  const what = `${n} file${n === 1 ? '' : 's'}`;
  const m = e.merged;
  const head = m && m.ok
    ? `Pushed ${what} to <code>${esc(e.branch)}</code> and merged into <code>${esc(m.base)}</code>`
    : m ? `Pushed ${what}, kept on <code>${esc(e.branch)}</code>: ${esc(m.reason || 'not merged')}`
      : `Pushed ${what} to <code>${esc(e.branch)}</code>`;
  return `<div class="summary-card pushed"><div class="pushed-head">${head} <span class="add">+${e.added || 0}</span> <span class="del">-${e.removed || 0}</span></div>${fileListHtml(files)}</div>`;
}

// ─── Live rows from the PC (copied from mobile.js, made quieter) ────────────
function screenshotFromPc(img, path) {
  relayRequest('GET', `/api/screenshot-data?path=${encodeURIComponent(path)}`).then((r) => { if (r && r.dataUrl) img.src = r.dataUrl; else img.remove(); }).catch(() => img.remove());
}
function addTool(t) {
  streamEl = null;
  const wrap = el('div', null, toolHtml(t, t.screenshotPath ? '<img class="shot" alt="Screenshot of the page">' : ''));
  const node = wrap.firstElementChild;
  const img = node.querySelector('.shot');
  if (img) screenshotFromPc(img, t.screenshotPath);
  return append(node);
}
function addThinking(text, label) { streamEl = null; return append(el('div', null, thinkingHtml(text, label)).firstElementChild); }
function addSummary(d) { const h = summaryHtml(d); if (h) append(el('div', null, h).firstElementChild); }
function addRole(d) {
  const role = d.tagline === 'role' ? d.name : String(d.tagline || d.name || '').replace(/ Specialist$/i, '');
  append(el('div', 'msg note', `Working as <strong>${esc(role || 'General')}</strong>`));
}

const checkpointEls = new Map();
function renderCheckpoint(cp, chat) {
  if (!cp || !cp.id) return;
  let node = checkpointEls.get(cp.id);
  if (!node || !node.isConnected) { node = append(el('div', 'inline-row')); checkpointEls.set(cp.id, node); }
  const n = cp.total || (cp.files || []).length;
  node.classList.toggle('undone', !!cp.undone);
  node.innerHTML = `<span>${cp.undone ? 'Undid changes to' : 'Changed'} ${n} file${n === 1 ? '' : 's'}</span><button type="button">${cp.undone ? 'Redo' : 'Undo'}</button>`;
  node.querySelector('button').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = cp.undone ? 'Redoing...' : 'Undoing...';
    try {
      const r = await relayRequest('POST', '/api/checkpoint', { sessionId: chat.pcSessionId, checkpointId: cp.id, undo: !cp.undone });
      renderCheckpoint((r && r.checkpoint) || cp, chat);
    } catch (err) { addMsg('error', err.message); renderCheckpoint(cp, chat); }
  });
}
const questionEls = new Map();
function renderQuestion(q) {
  if (!q || !q.requestId) return;
  let node = questionEls.get(q.requestId);
  if (!node || !node.isConnected) { node = append(el('div', 'question')); questionEls.set(q.requestId, node); }
  node._q = { requestId: q.requestId, question: q.question, options: q.options || [] };
  const answered = q.answered || q.answer !== undefined;
  node.innerHTML = `<div class="q-text"></div>${answered
    ? `<div class="q-answer">${q.answer == null ? 'Skipped, Codeply decided' : `Answered: <b>${esc(q.answer)}</b>`}</div>`
    : `<div class="q-opts">${node._q.options.map((o, i) => `<button type="button" data-i="${i}">${esc(o)}</button>`).join('')}</div>
       <form><input type="text" placeholder="Or type an answer" maxlength="2000"><button type="submit">Send</button></form>
       <button class="q-skip" type="button">Let Codeply decide</button>`}`;
  node.querySelector('.q-text').textContent = q.question || '';
  if (answered) return;
  const send = async (answer) => {
    renderQuestion({ ...node._q, answer, answered: true });
    try { await relayRequest('POST', '/api/question', { requestId: q.requestId, answer }); } catch (err) { addMsg('error', err.message); }
  };
  node.querySelectorAll('.q-opts button').forEach((b) => b.addEventListener('click', () => send(node._q.options[Number(b.dataset.i)])));
  node.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); const v = e.currentTarget.querySelector('input').value.trim(); if (v) send(v); });
  node.querySelector('.q-skip').addEventListener('click', () => send(null));
}
const CLOUD_LABEL = { starting: 'Starting in the cloud', queued: 'Starting in the cloud', running: 'Working in the cloud', done: 'Finished in the cloud', failed: 'The cloud run failed', cancelled: 'Cancelled' };
function renderCloudTaskCard(task) {
  if (!task || !task.id) return;
  let node = feed().querySelector(`[data-cloud-card="${CSS.escape(String(task.id))}"]`);
  if (!node) { node = append(el('div', 'msg note')); node.dataset.cloudCard = task.id; }
  const files = task.files || (task.result && task.result.files) || [];
  node.textContent = `${CLOUD_LABEL[task.status] || task.status}${task.status === 'done' && files.length ? `, ${files.length} file${files.length === 1 ? '' : 's'} changed` : ''}${task.error ? `: ${task.error}` : ''}`;
}

/** One stored PC chat item, the way mobile.js renders a session. */
function renderPcItem(item, chat) {
  if (item.kind === 'user') addMsg('user', item.text);
  else if (item.kind === 'assistant') (item.interim ? addThinking(item.text) : addMsg('agent', item.text));
  else if (item.kind === 'tool') addTool(item);
  else if (item.kind === 'role_active' || item.kind === 'subagent_active') addRole(item);
  else if (item.kind === 'turn_summary') addSummary(item);
  else if (item.kind === 'checkpoint') renderCheckpoint(item, chat);
  else if (item.kind === 'question') renderQuestion({ ...item, answered: true });
  else if (item.kind === 'goal') addMsg('note', `Goal: ${item.goal || ''}${item.status ? ` (${item.status})` : ''}`);
  else if (item.kind === 'cloud_task') renderCloudTaskCard(item.task);
  else if (item.kind === 'notice') (item.level === 'info' ? addThinking(item.text, 'Note') : addMsg('error', item.text));
}

// ─── Cloud rows: the status doc's events, drawn like the chat ───────────────
const shotCache = new Map(); // repo|path -> Promise<objectURL|null>
function cloudEventHtml(e) {
  if (e.t === 'tool') return toolHtml({ ...e, label: e.summary || '' }, e.screenshot ? `<img class="shot" alt="Screenshot of the page" data-shot="${esc(e.screenshot)}">` : '');
  if (e.t === 'text' || e.t === 'reasoning') return thinkingHtml(e.text || '');
  if (e.t === 'notice') return e.level === 'error' || e.level === 'warn' ? `<div class="msg error">${esc(e.text)}</div>` : `<div class="msg note">${esc(e.text)}</div>`;
  if (e.t === 'summary') return summaryHtml(e);
  if (e.t === 'pushed') return pushedHtml(e);
  return '';
}
const isLive = (t) => t && ['starting', 'queued', 'running'].includes(t.status);
function taskHtml(t) {
  let h = `<div class="msg user">${esc(t.prompt)}</div>`;
  h += (t.events || []).map(cloudEventHtml).join('');
  if (t.answer) h += `<div class="msg agent">${md(t.answer)}</div>`;
  if (isLive(t)) h += '<div class="working"><span class="spinner"></span><span>Working...</span></div>';
  if (t.status === 'failed') h += `<div class="msg error">${esc(t.error || 'The cloud run failed.')}</div>`;
  if (t.status === 'cancelled') h += '<div class="msg note">Cancelled.</div>';
  if (t.status === 'done' && !t.answer && !(t.events || []).length) h += '<div class="msg note">Done.</div>';
  return h;
}

/** Full redraw of the current chat. Keeps open rows open and the scroll where it was. */
function renderFeed({ force = false } = {}) {
  const c = state.current && chatMeta(state.current);
  const f = feed();
  if (!c) { f.innerHTML = ''; streamEl = null; showFeed(false); renderTitle(); renderComposer(); return; }
  const b = body(c.id);
  const wasNear = nearBottom();
  const open = new Set([...f.querySelectorAll('details[open]')].map((d) => d.dataset.k));
  const hadRows = f.children.length;
  f.innerHTML = '';
  streamEl = null;
  checkpointEls.clear(); questionEls.clear();
  if (c.kind === 'chat') {
    for (const m of b.messages) addMsg(m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : 'agent', m.content);
    if (state.busy.has(c.id)) append(el('div', 'working', '<span class="spinner"></span><span>Thinking...</span>'));
  } else {
    for (const item of b.pcItems || []) renderPcItem(item, c);
    if (c.pcSessionId && !(b.pcItems || []).length && !relay.pcId && !(b.tasks || []).length) addMsg('note', 'This chat lives on your PC. It shows up here once the PC is online.');
    if ((b.tasks || []).length) f.insertAdjacentHTML('beforeend', b.tasks.map(taskHtml).join(''));
  }
  showFeed(f.children.length > 0);
  f.querySelectorAll('details').forEach((d, i) => { d.dataset.k = String(i); if (open.has(d.dataset.k)) d.open = true; });
  hydrateShots(c);
  if (force || wasNear || !hadRows) scrollToBottom();
  renderTitle();
  renderComposer();
}
function hydrateShots(c) {
  const env = c && envFor(c.project);
  feed().querySelectorAll('img[data-shot]').forEach((img) => {
    if (!env) return img.remove();
    const key = `${env.repo}|${img.dataset.shot}`;
    if (!shotCache.has(key)) shotCache.set(key, ghRawBlob(env.repo, img.dataset.shot).then((blob) => (blob ? URL.createObjectURL(blob) : null)).catch(() => { shotCache.delete(key); return null; }));
    shotCache.get(key).then((url) => { if (url) img.src = url; else img.alt = 'Screenshot not available'; });
  });
}
document.addEventListener('click', (e) => {
  const img = e.target.closest && e.target.closest('img.shot');
  if (img && img.src) { e.preventDefault(); const lb = $('lightbox'); lb.querySelector('img').src = img.src; lb.classList.remove('hidden'); }
});
$('lightbox').addEventListener('click', () => $('lightbox').classList.add('hidden'));

// ─── Events from the PC ─────────────────────────────────────────────────────
function receiveEvent(event) {
  if (event.type === 'session_sync') {
    const meta = event.session;
    if (meta) {
      const list = state.pc.sessions || [];
      const i = list.findIndex((s) => s.id === meta.id);
      if (i >= 0) list[i] = { ...list[i], ...meta }; else list.unshift(meta);
      state.pc.sessions = list;
      save(KEY.pc, state.pc);
    }
    // A brand-new chat only learns its id when the PC first syncs it.
    const waiting = state.chats.find((c) => c.awaitingPc && !c.pcSessionId);
    if (waiting && event.origin === clientId) { waiting.pcSessionId = event.sessionId; delete waiting.awaitingPc; saveChats(); }
    const c = state.chats.find((x) => x.pcSessionId === event.sessionId);
    if (c && meta && meta.title && c.title !== meta.title) c.title = meta.title;
    if (c && event.message && event.origin !== clientId && event.message.kind === 'user' && c.id === state.current) addMsg('user', event.message.text);
    renderChatList();
    renderTitle();
    return;
  }
  // The PC cut this chat back for an edit or retry: re-fetch it so the
  // replaced messages don't linger on the phone.
  if (event.type === 'session_rewound') {
    const c = state.chats.find((x) => x.pcSessionId === event.sessionId);
    if (c) refreshPcSession(c, false).then(() => { if (c.id === state.current) renderFeed(); }).catch(() => {});
    return;
  }
  if (event.type === 'session_deleted') {
    state.pc.sessions = (state.pc.sessions || []).filter((s) => s.id !== event.sessionId);
    save(KEY.pc, state.pc);
    renderChatList();
    return;
  }
  if (event.type === 'runs_status') {
    const active = new Set(event.active || []);
    for (const c of state.chats) {
      if (!c.pcSessionId || c.cloud) continue;
      if (active.has(c.pcSessionId)) state.busy.add(c.id);
      else if (state.busy.has(c.id) && !c.awaitingPc) state.busy.delete(c.id);
    }
    renderComposer();
    return;
  }
  const c = state.chats.find((x) => x.pcSessionId && x.pcSessionId === event.sessionId);
  if (!c || c.id !== state.current) {
    if (c && (event.type === 'run_finished' || event.type === 'aborted')) { state.busy.delete(c.id); refreshPcSession(c, false).catch(() => {}); }
    return;
  }
  const keep = nearBottom();
  if (event.type === 'role_active') addRole(event);
  else if (event.type === 'checkpoint' || event.type === 'checkpoint_update') renderCheckpoint(event.checkpoint, c);
  else if (event.type === 'turn_summary') addSummary(event);
  else if (event.type === 'mode_switch') { addThinking(event.mode === 'Build' ? 'Switched to Build mode. Implementing the plan.' : `Switched to ${event.mode} mode.`, 'Note'); }
  else if (event.type === 'goal_update') addMsg('note', `Goal: ${event.goal || ''} (${event.status})`);
  else if (event.type === 'cloud_task') renderCloudTaskCard(event.task);
  else if (event.type === 'notice') { if (!/^Summarized earlier steps/i.test(event.text || '')) (event.level === 'info' ? addThinking(event.text, 'Note') : addMsg('error', event.text)); }
  else if (event.type === 'text') (event.interim ? addThinking(event.text) : addDelta(event.text));
  else if (event.type === 'tool_end') {
    const m = event.meta || {};
    addTool({ name: event.name, label: event.summary || (event.args && (event.args.path || event.args.command)) || '', ok: event.ok, args: event.args, exitCode: m.exitCode, added: m.added, removed: m.removed, screenshotPath: m.screenshotPath });
  } else if (event.type === 'error') { if (!/^Stopped after \d+ steps/i.test(event.error || '')) addMsg('error', event.error); }
  else if (event.type === 'approval_request') showApproval(event);
  else if (event.type === 'question_request') renderQuestion(event);
  else if (event.type === 'question_resolved') { const q = questionEls.get(event.requestId); if (q) renderQuestion({ ...q._q, answer: event.answer, answered: true }); }
  else if (event.type === 'image_pick_request') showImagePick(event);
  else if (event.type === 'approval_resolved') { if (state.approval && state.approval.requestId === event.requestId) { state.approval = null; $('approvalSheet').classList.add('hidden'); } }
  else if (event.type === 'image_pick_resolved') { if (state.imagePick && state.imagePick.requestId === event.requestId) { state.imagePick = null; $('imageSheet').classList.add('hidden'); } }
  else if (event.type === 'run_finished' || event.type === 'aborted') {
    streamEl = null;
    if (state.approval) { state.approval = null; $('approvalSheet').classList.add('hidden'); }
    if (state.imagePick) { state.imagePick = null; $('imageSheet').classList.add('hidden'); }
    state.busy.delete(c.id);
    renderComposer();
    refreshPcSession(c, false).catch(() => {});
  }
  if (keep) scrollToBottom();
}

/** Fetch the PC's copy of a chat, cache it on the phone, redraw if it is open. */
async function refreshPcSession(c, redraw = true) {
  if (!c.pcSessionId || !relay.pcId) return;
  const s = await relayRequest('GET', `/api/session?id=${encodeURIComponent(c.pcSessionId)}`);
  const b = body(c.id);
  b.pcItems = (s.messages || []).map((m) => { const { images, ...rest } = m; return rest; });
  if (s.title) c.title = s.title;
  saveBody(c.id);
  touchChat(c.id, {});
  if (redraw && c.id === state.current && !state.busy.has(c.id)) renderFeed();
}

function showApproval(event) {
  state.approval = event;
  $('approvalTitle').textContent = event.title || 'Codeply needs your OK';
  $('approvalDetail').textContent = event.detail || `Allow Codeply to run ${String(event.tool || 'this action').replace(/_/g, ' ')}?`;
  $('approvalSheet').classList.remove('hidden');
}
async function answerApproval(verdict) {
  const p = state.approval;
  if (!p) return;
  state.approval = null;
  $('approvalSheet').classList.add('hidden');
  try { await relayRequest('POST', '/api/approval', { requestId: p.requestId, verdict }); } catch (err) { addMsg('error', err.message); }
}
function showImagePick(event) {
  state.imagePick = event;
  $('imageDetail').textContent = `For ${event.path || 'this file'}`;
  $('imagePickImg').src = event.url || '';
  $('imagePickImg').classList.toggle('hidden', !event.url);
  $('imageSheet').classList.remove('hidden');
}
async function answerImagePick(url) {
  const p = state.imagePick;
  if (!p) return;
  state.imagePick = null;
  $('imageSheet').classList.add('hidden');
  try { await relayRequest('POST', '/api/image-pick', { requestId: p.requestId, chosenUrl: url }); } catch (err) { addMsg('error', err.message); }
}

// ─── Chat mode: Codeply's ai-proxy ──────────────────────────────────────────
function localTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } }
async function chatSend(chat, text) {
  const b = body(chat.id);
  b.messages.push({ role: 'user', content: text, at: Date.now() });
  if (!chat.title) chat.title = titleFrom(text);
  saveBody(chat.id);
  touchChat(chat.id);
  state.busy.add(chat.id);
  renderFeed({ force: true });
  const controller = new AbortController();
  state.chatAbort = controller;
  let reply = null; let error = null;
  try {
    const token = await accessToken();
    const history = b.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-30).map((m) => ({ role: m.role, content: m.content }));
    // A synced model goes through byok-proxy (same reply shape as ai-proxy).
    const own = chatModel();
    const messages = [{ role: 'system', content: CHAT_SYSTEM + (window.CraftReminders ? window.CraftReminders.chatRules() : '') }, ...history];
    const res = await fetch(own ? BYOK_PROXY_URL : AI_PROXY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      // inbox: when the message is about email, the server reads Gmail (the link turned on for calls) first
      body: JSON.stringify(own ? { modelId: own.id, messages, opts: { inbox: true, tz: localTz() } } : { messages, opts: { inbox: true, tz: localTz() } }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      const choice = data.data && data.data.choices && data.data.choices[0];
      reply = (choice && choice.message && choice.message.content) || '';
      if (!reply) error = 'Codeply sent back an empty reply. Try again.';
    } else if (res.status === 401 && !data.error) error = 'Your sign-in expired. Sign out and sign in again.';
    else error = data.error || data.message || data.msg || `Codeply could not answer (${res.status}).`;
  } catch (e) {
    if (e.name === 'AbortError') error = null;
    else error = /fetch|network/i.test(e.message) ? "Can't reach Codeply. Check your internet connection." : e.message;
  } finally {
    state.chatAbort = null;
    state.busy.delete(chat.id);
  }
  // Reminders the reply asked for ([[REMIND: ...]] lines, phone-reminders.js): saved, and the lines hidden.
  if (reply && window.CraftReminders) {
    const R = window.CraftReminders;
    const { text, reminds } = R.extract(reply);
    if (reminds.length) {
      const notes = [];
      for (const t of reminds) {
        try { const r = await R.createFromTag(t, null); notes.push(`Reminder set: ${r.text}, ${R.whenLabel(r.due_at)}${r.kind === 'call' ? ' (a call)' : ''}.`); }
        catch (e) { notes.push(`Couldn't set a reminder: ${e.message}`); }
      }
      if (R.pushState() !== 'granted') notes.push('Open Calls to let Codeply send you notifications.');
      reply = `${text}\n\n${notes.map((n) => `- ${n}`).join('\n')}`.trim();
    }
  }
  if (reply) b.messages.push({ role: 'assistant', content: reply, at: Date.now() });
  else if (error) b.messages.push({ role: 'error', content: error, at: Date.now() });
  saveBody(chat.id);
  touchChat(chat.id);
  if (chat.id === state.current) renderFeed();
}

// ─── Code mode on the PC ────────────────────────────────────────────────────
async function pcSend(chat, text) {
  const project = chat.project;
  if (!chat.title) chat.title = titleFrom(text);
  if (!chat.pcSessionId) chat.awaitingPc = true;
  touchChat(chat.id);
  state.busy.add(chat.id);
  showFeed(true);
  addMsg('user', text);
  scrollToBottom();
  renderComposer();
  try {
    // The PC answers when the whole turn ends; events stream in meanwhile.
    const r = await relayRequest('POST', '/api/send', { sessionId: chat.pcSessionId || null, cwd: project.cwd, mode: state.ui.codeMode, bypass: state.bypass, text, clientId }, 6 * 3600 * 1000);
    if (r && r.error) throw new Error(r.error);
    if (r && r.sessionId) chat.pcSessionId = r.sessionId;
    if (r && r.title) chat.title = r.title;
    delete chat.awaitingPc;
    touchChat(chat.id);
    if (r && r.cloud) { state.busy.delete(chat.id); }
  } catch (e) {
    delete chat.awaitingPc;
    state.busy.delete(chat.id);
    saveChats();
    if (chat.id === state.current) addMsg('error', e.message);
    renderComposer();
    return;
  }
  state.busy.delete(chat.id);
  renderComposer();
  refreshPcSession(chat).catch(() => {});
}

// ─── GitHub (cloud) ─────────────────────────────────────────────────────────
const GH = 'https://api.github.com';
const ENGINE = 'codeply-cli@0.5';
const WORKFLOW_FILE = 'craft-cloud.yml';
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
const SESSIONS_BRANCH = 'craft-sessions';
const MIRROR_DESCRIPTION = 'Craft workspace mirror: a private backup that Craft cloud runs work in.';
const LIVE_FRESH_MS = 60000;
// Identical to CLOUD_WORKFLOW in codeply-cli/lib/cloud.mjs (the test checks).
const CLOUD_WORKFLOW = `# Written by Codeply Craft. Starts only from Craft (workflow_dispatch), which
# needs write access to this repo, so nobody else can spend its minutes.
name: craft-cloud
run-name: craft \${{ inputs.task_id }}

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What to do
        required: true
        type: string
      mode:
        description: Build, Plan or Ask
        required: false
        default: Build
        type: string
      task_id:
        required: true
        type: string
      session_id:
        required: false
        default: ''
        type: string

permissions:
  contents: write
  checks: write

concurrency:
  group: craft-\${{ inputs.session_id || inputs.task_id }}
  cancel-in-progress: false

jobs:
  craft:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run Craft
        run: npx -y --package="\${CRAFT_ENGINE:-${ENGINE}}" codeply cloud runner
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          CODEPLY_API_KEY: \${{ secrets.CODEPLY_API_KEY }}
          CODEPLY_MODEL_KIND: \${{ vars.CODEPLY_MODEL_KIND }}
          CODEPLY_MODEL: \${{ vars.CODEPLY_MODEL }}
          CODEPLY_BASE_URL: \${{ vars.CODEPLY_BASE_URL }}
          CRAFT_ENGINE: \${{ vars.CRAFT_ENGINE }}
          CRAFT_ENV: \${{ secrets.CRAFT_ENV }}
          CRAFT_MERGE: \${{ vars.CRAFT_MERGE }}
          CRAFT_BASE: \${{ github.ref_name }}
          CRAFT_PROMPT: \${{ inputs.prompt }}
          CRAFT_MODE: \${{ inputs.mode }}
          CRAFT_TASK_ID: \${{ inputs.task_id }}
          CRAFT_SESSION_ID: \${{ inputs.session_id }}
`;

async function gh(method, route, reqBody, { allow = [], accept, token } = {}) {
  const tok = token || (state.creds && state.creds.token);
  if (!tok) throw new Error('Connect GitHub first.');
  const res = await fetch(`${GH}${route}`, {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${tok}`, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(reqBody ? { 'Content-Type': 'application/json' } : {}) },
    body: reqBody ? JSON.stringify(reqBody) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok && !allow.includes(res.status)) {
    if (res.status === 401 && !token && state.creds) { state.creds.expired = true; save(KEY.creds, state.creds); }
    const e = new Error(res.status === 401 ? 'GitHub signed this phone out. Connect GitHub again.' : `GitHub: ${(json && json.message) || res.status}`);
    e.status = res.status;
    throw e;
  }
  return { status: res.status, json, text };
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
/** A JSON file on craft-sessions, or null. Always fresh (no-store). */
async function readSessionJson(repo, path) {
  const r = await gh('GET', `/repos/${repo}/contents/${encPath(path)}?ref=${SESSIONS_BRANCH}`, null, { allow: [404], accept: 'application/vnd.github.raw+json' });
  if (r.status !== 200) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}
async function ghRawBlob(repo, path) {
  const res = await fetch(`${GH}/repos/${repo}/contents/${encPath(path)}?ref=${SESSIONS_BRANCH}`, {
    cache: 'no-store', headers: { Authorization: `Bearer ${state.creds.token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  return res.ok ? res.blob() : null;
}
/** Create or replace a file (base64 content) on a branch, with retries for concurrent writes. */
async function putFile(repo, path, contentB64, message, branch) {
  for (let i = 0; i < 4; i++) {
    const cur = await gh('GET', `/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`, null, { allow: [404] });
    const sha = cur.status === 200 && cur.json && !Array.isArray(cur.json) ? cur.json.sha : undefined;
    const r = await gh('PUT', `/repos/${repo}/contents/${encPath(path)}`, { message, branch, content: contentB64, ...(sha ? { sha } : {}) }, { allow: [409, 422] });
    if (r.status < 300) return true;
    await sleep(300 + i * 400);
  }
  return false;
}

/** libsodium sealed box, exactly like sealSecret in cloud.mjs. */
function sealSecret(publicKeyB64, value) {
  const pk = b64ToBytes(publicKeyB64);
  const eph = nacl.box.keyPair();
  const nonceIn = new Uint8Array(eph.publicKey.length + pk.length);
  nonceIn.set(eph.publicKey); nonceIn.set(pk, eph.publicKey.length);
  const nonce = blakejs.blake2b(nonceIn, undefined, nacl.box.nonceLength);
  const boxed = nacl.box(new TextEncoder().encode(String(value)), nonce, pk, eph.secretKey);
  const out = new Uint8Array(eph.publicKey.length + boxed.length);
  out.set(eph.publicKey); out.set(boxed, eph.publicKey.length);
  return bytesToB64(out);
}
async function setVariable(repo, name, value) {
  const r = await gh('PATCH', `/repos/${repo}/actions/variables/${name}`, { name, value }, { allow: [404] });
  if (r.status === 404) await gh('POST', `/repos/${repo}/actions/variables`, { name, value });
}
const baseCache = new Map();
async function repoBase(env) {
  if (env.base) return env.base;
  if (baseCache.has(env.repo)) return baseCache.get(env.repo);
  const r = await gh('GET', `/repos/${env.repo}`);
  env.base = (r.json && r.json.default_branch) || 'main';
  baseCache.set(env.repo, env.base);
  if (state.envs[env.repo]) { state.envs[env.repo].base = env.base; save(KEY.envs, state.envs); }
  return env.base;
}
async function liveRunner(repo, sessionId) {
  const live = await readSessionJson(repo, `live/${sessionId}.json`).catch(() => null);
  if (!live || Date.now() - (live.at || 0) > LIVE_FRESH_MS) return null;
  if (!live.busy && (live.until || 0) < Date.now() + 8000) return null;
  return live;
}
async function dispatch(env, task) {
  const base = await repoBase(env);
  let last = null;
  // Right after the workflow file lands, GitHub can take a few seconds to know it.
  for (let i = 0; i < 10; i++) {
    try {
      await gh('POST', `/repos/${env.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref: base, inputs: { prompt: task.prompt, mode: task.mode, task_id: task.id, session_id: task.sessionId } });
      task.dispatchedAt = Date.now();
      return;
    } catch (e) {
      last = e;
      if (e.status !== 404 && e.status !== 422) break;
      await sleep(3000);
    }
  }
  throw last;
}

// ─── Starting a cloud task (Code chats and bot calls) ───────────────────────
const newCloudTask = (prompt, mode, sessionId) => ({ id: `${Date.now().toString(36)}${randHex(6)}`, prompt, mode: ['Build', 'Plan', 'Ask'].includes(mode) ? mode : 'Build', sessionId: sessionId || '', status: 'starting', startedAt: Date.now(), events: [] });
/** craft-sessions, created from the base branch when this repo never had a run. */
async function ensureSessionsBranch(env) {
  const ref = await gh('GET', `/repos/${env.repo}/git/ref/heads/${SESSIONS_BRANCH}`, null, { allow: [404] });
  if (ref.status === 200) return;
  const base = await repoBase(env);
  const head = await gh('GET', `/repos/${env.repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const sha = head.json && head.json.object && head.json.object.sha;
  if (sha) await gh('POST', `/repos/${env.repo}/git/refs`, { ref: `refs/heads/${SESSIONS_BRANCH}`, sha }, { allow: [422] });
}
/**
 * Hand a task to the cloud. A runner still up for its chat takes it at once
 * from the queue; otherwise a new runner is dispatched. A bot ({ name, prompt },
 * the prompt the PC built) is too big for a workflow input, so it goes to
 * requests/<id>.json on craft-sessions first (codeply-cli 0.5.1+ reads it).
 */
async function launchTask(env, task, { bot = null, kind = '' } = {}) {
  const extra = { ...(bot && bot.prompt ? { bot: { name: String(bot.name || 'Bot'), prompt: String(bot.prompt) } } : {}), ...(kind === 'task' ? { kind } : {}) };
  if (extra.bot) task.bot = { name: extra.bot.name };
  if (extra.kind) task.kind = 'task';
  const live = await liveRunner(env.repo, task.sessionId);
  if (live) {
    const ok = await putFile(env.repo, `queue/${task.sessionId}/${Date.now()}-${task.id}.json`, textToB64(JSON.stringify({ id: task.id, prompt: task.prompt, mode: task.mode, ...extra })), `Craft queue ${task.id}`, SESSIONS_BRANCH);
    if (!ok) throw new Error('Could not hand the message to the cloud. Try again.');
    Object.assign(task, { queued: true, enqueuedAt: Date.now() });
    return;
  }
  if (Object.keys(extra).length) {
    await ensureSessionsBranch(env).catch(() => {});
    const ok = await putFile(env.repo, `requests/${task.id}.json`, textToB64(JSON.stringify(extra)), `Craft request ${task.id}`, SESSIONS_BRANCH);
    if (!ok) throw new Error('Could not hand the bot to the cloud. Try again.');
  }
  await dispatch(env, task);
}
/** The cloud environment bots work in when the PC is off: the open project's, else the first one set up. Null when there is none, or GitHub is not connected. */
function cloudEnvForBots() {
  if (!state.creds || !state.creds.token || state.creds.expired) return null;
  const mine = envFor(currentProject());
  if (mine) return mine;
  for (const e of Object.values(state.envs)) if (e && e.repo) return e;
  for (const p of (state.creds && state.creds.projects) || []) { const e = envFor({ repo: p.repo }); if (e) return e; }
  return null;
}
/** A bot's job in the cloud (for calls): returns { env, task }; poll it with pollCloudTask(env, task). */
async function startCloudTask({ prompt, mode = 'Build', sessionId = '', bot = null, kind = 'task', env = null } = {}) {
  env = env || cloudEnvForBots();
  if (!env) throw new Error('Codeply Cloud is not set up yet.');
  const task = newCloudTask(String(prompt || '').trim(), mode, sessionId);
  if (!task.prompt) throw new Error('Write a task first.');
  await launchTask(env, task, { bot, kind });
  return { env, task };
}

// ─── Code mode in the cloud ─────────────────────────────────────────────────
async function cloudSend(chat, text) {
  const env = envFor(chat.project);
  if (!env) throw new Error('This project has no cloud environment yet.');
  if (!chat.cloudSessionId) chat.cloudSessionId = `p${Date.now().toString(36)}${randHex(6)}`;
  if (!chat.title) chat.title = titleFrom(text);
  chat.cloud = true;
  chat.live = true;
  const b = body(chat.id);
  const task = newCloudTask(text, state.ui.codeMode, chat.cloudSessionId);
  b.tasks.push(task);
  saveBody(chat.id);
  touchChat(chat.id);
  if (chat.id === state.current) renderFeed({ force: true });
  try {
    await launchTask(env, task);
  } catch (e) {
    Object.assign(task, { status: 'failed', error: e.message });
  }
  saveBody(chat.id);
  touchChat(chat.id, { live: chat.live });
  if (chat.id === state.current) renderFeed({ force: true });
  schedulePoll(3000);
}

/** Why a run died before Craft reported back (same rules as the PC). */
async function diagnose(repo, runId) {
  try {
    const jobs = ((await gh('GET', `/repos/${repo}/actions/runs/${runId}/jobs`)).json || {}).jobs || [];
    const job = jobs.find((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out') || jobs[0];
    if (!job) return null;
    if (job.conclusion === 'timed_out') return 'The run hit its 60-minute limit and was stopped.';
    const step = (job.steps || []).find((s) => s.conclusion === 'failure');
    let log = '';
    try { const r = await gh('GET', `/repos/${repo}/actions/jobs/${job.id}/logs`, null, { allow: [404, 410], accept: 'application/vnd.github+json' }); log = r.text || ''; } catch {}
    if (/No matching version found for codeply-cli|notarget[\s\S]{0,200}codeply-cli/i.test(log)) return "The cloud couldn't install the Codeply engine: that version isn't published yet.";
    if (/Resource not accessible by integration/i.test(log)) return 'The repo does not let the run save its work (Settings > Actions > General > Workflow permissions).';
    if (step) return step.name === 'Run Craft' ? 'Codeply stopped before it could report back.' : `The "${step.name}" step failed.`;
    return null;
  } catch { return null; }
}

/** One status check for one cloud task. Mutates the task. */
async function pollTask(env, t) {
  const doc = await readSessionJson(env.repo, `tasks/${t.id}.json`);
  if (doc) {
    t.events = Array.isArray(doc.events) ? doc.events : t.events || [];
    if (doc.runId) t.runId = doc.runId;
    t.queued = false;
    if (doc.status === 'done' || doc.status === 'failed') {
      Object.assign(t, { status: doc.status, answer: doc.answer || '', reply: doc.reply || '', files: doc.files || [], stats: doc.stats || [], merged: doc.merged || null, branch: doc.branch || null, error: doc.status === 'failed' ? (doc.error || 'The cloud run failed.') : null, finishedAt: Date.now() });
    } else t.status = 'running';
    return;
  }
  if (t.queued) {
    // Handed to a runner that went away before taking it: start a new one.
    if (Date.now() - (t.enqueuedAt || t.startedAt) > 30000 && !(await liveRunner(env.repo, t.sessionId))) {
      await dispatch(env, t);
      Object.assign(t, { queued: false, status: 'starting', redispatchedAt: Date.now() });
    }
    return;
  }
  let run = null;
  if (t.runId) run = (await gh('GET', `/repos/${env.repo}/actions/runs/${t.runId}`)).json;
  else {
    const list = (await gh('GET', `/repos/${env.repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=30`)).json || {};
    run = (list.workflow_runs || []).find((r) => r.display_title === `craft ${t.id}`) || null;
  }
  if (!run) {
    if (Date.now() - (t.dispatchedAt || t.startedAt) > 5 * 60 * 1000) Object.assign(t, { status: 'failed', error: "The cloud run never started. Check that Actions is enabled on the repo." });
    return;
  }
  t.runId = run.id;
  t.runUrl = run.html_url;
  if (run.status !== 'completed') { t.status = run.status === 'in_progress' ? 'running' : 'starting'; return; }
  // Ended with no status doc: an older engine (it reports in its check run), or it died early.
  try {
    const checks = (await gh('GET', `/repos/${env.repo}/commits/${run.head_sha}/check-runs?check_name=${encodeURIComponent(`craft ${t.id}`)}`)).json || {};
    const check = (checks.check_runs || [])[0];
    let data = {};
    try { data = JSON.parse((check && check.output && check.output.text) || '{}'); } catch {}
    if (check && check.status === 'completed' && data.mode) {
      Object.assign(t, { status: check.conclusion === 'success' ? 'done' : 'failed', events: Array.isArray(data.events) ? data.events : [], answer: data.answer || '', files: data.files || [], stats: data.stats || [], error: check.conclusion === 'success' ? null : (data.error || 'The cloud run failed.'), finishedAt: Date.now() });
      return;
    }
  } catch {}
  const why = run.conclusion === 'cancelled' ? null : await diagnose(env.repo, run.id);
  Object.assign(t, { status: run.conclusion === 'cancelled' ? 'cancelled' : 'failed', error: why || 'The cloud run ended before Codeply could report back.', finishedAt: Date.now() });
}

// One failed check (flaky phone network, a draw error) must never end the loop.
let pollTimer = null; let polling = false;
async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    for (const c of state.chats.filter((x) => x.live)) {
      const b = body(c.id);
      const env = envFor(c.project);
      let changed = false;
      for (const t of (b.tasks || []).filter(isLive)) {
        if (!env) { Object.assign(t, { status: 'failed', error: 'This chat lost its cloud environment.' }); changed = true; continue; }
        const before = JSON.stringify([t.status, (t.events || []).length, t.answer, t.queued, t.error]);
        try { await pollTask(env, t); } catch (e) { t.lastError = e.message; }
        if (JSON.stringify([t.status, (t.events || []).length, t.answer, t.queued, t.error]) !== before) changed = true;
      }
      if (!(b.tasks || []).some(isLive)) { c.live = false; saveChats(); }
      if (changed) { saveBody(c.id); touchChat(c.id, {}); if (c.id === state.current) renderFeed(); }
    }
  } catch (e) { console.warn('[craft] cloud check failed:', e && e.message); }
  finally { polling = false; }
}
function schedulePoll(ms = 3000) {
  clearTimeout(pollTimer);
  if (!state.chats.some((c) => c.live)) return;
  pollTimer = setTimeout(async () => { await pollAll(); schedulePoll(3000); }, ms);
}
// Phones pause background pages; catch up the moment it is looked at again.
const catchUp = () => { if (document.visibilityState === 'visible' && state.chats.some((c) => c.live)) pollAll().then(() => schedulePoll(3000)); };
document.addEventListener('visibilitychange', catchUp);
window.addEventListener('focus', catchUp);
window.addEventListener('pageshow', catchUp);

// ─── Sending ────────────────────────────────────────────────────────────────
let pendingSend = null; // { chatId, text } waiting on the offline sheet or cloud setup
async function onSubmit(e) {
  e.preventDefault();
  const c0 = state.current && chatMeta(state.current);
  if (c0 && state.busy.has(c0.id)) return stopCurrent(c0);
  const input = $('input');
  if (attFiles.some((f) => f.reading)) { attNote('Still reading a file. One moment.'); return; }
  const text = window.CodeplyAttach ? window.CodeplyAttach.compose(input.value.trim(), attFiles) : input.value.trim();
  if (!text) return;
  attFiles = []; renderAtt();
  if (state.ui.mode === 'chat') {
    const chat = c0 && c0.kind === 'chat' ? c0 : createChat('chat');
    openChat(chat.id, { keepMode: true });
    clearInput();
    return chatSend(chat, text);
  }
  // Code
  let chat = c0 && c0.kind === 'code' ? c0 : null;
  const project = chat ? currentProject() : projectByKey(state.ui.projectKey);
  if (!project) { openProjectPicker({ thenSend: text }); return; }
  if (!chat) {
    chat = createChat('code', { project: { key: project.key, name: project.name, cwd: project.cwd || null, repo: project.repo || null } });
    openChat(chat.id, { keepMode: true });
  }
  clearInput();
  // A cloud-only project (no folder on the PC) goes straight to the cloud.
  if (chat.cloud || !project.cwd) return runInCloud(chat, text);
  if (project.cwd && !relay.pcId && (relay.connecting || relay.channel)) await waitForPc(4000);
  if (project.cwd && relay.pcId) return pcSend(chat, text);
  pendingSend = { chatId: chat.id, text };
  $('offlineSheet').classList.remove('hidden');
}
function clearInput() { const i = $('input'); i.value = ''; i.style.height = 'auto'; }

// ─── Attached files (attachments.js): PDFs, text and code ───────────────────
let attFiles = []; // read files, or { name, reading: true } while one is read
let attNotes = []; // short messages (a file that couldn't be read), shown for a few seconds
function attNote(msg) {
  const n = { msg };
  attNotes.push(n); renderAtt();
  setTimeout(() => { attNotes = attNotes.filter((x) => x !== n); renderAtt(); }, 5000);
}
function renderAtt() {
  const row = $('attRow');
  row.innerHTML = '';
  row.classList.toggle('hidden', !attFiles.length && !attNotes.length);
  for (const n of attNotes) { const d = el('div', 'att-note'); d.textContent = n.msg; row.appendChild(d); }
  attFiles.forEach((f, i) => {
    const box = document.createElement('div');
    box.innerHTML = window.CodeplyAttach.chipHtml(f.reading ? { name: f.name, type: f.isPdf ? 'pdf' : 'text' } : f, { removable: !f.reading });
    const chip = box.firstElementChild;
    if (f.reading) { chip.classList.add('reading'); chip.querySelector('.att-meta').textContent = 'Reading…'; }
    const x = chip.querySelector('.att-x');
    if (x) x.addEventListener('click', () => { attFiles.splice(i, 1); renderAtt(); });
    row.appendChild(chip);
  });
}
async function addAttFiles(list) {
  for (const file of list) {
    const kind = window.CodeplyAttach.kindOf(file);
    if (kind === 'image') { attNote('Images work in Craft on your computer. Here: PDFs, text and code files.'); continue; }
    const slot = { name: file.name, reading: true, isPdf: kind === 'pdf' };
    attFiles.push(slot); renderAtt();
    const got = await window.CodeplyAttach.read(file, { pdfBase: 'pdfjs/' });
    const at = attFiles.indexOf(slot);
    if (got.error) { if (at >= 0) attFiles.splice(at, 1); renderAtt(); attNote(got.error); }
    else { if (at >= 0) attFiles[at] = got; renderAtt(); }
  }
}
if (window.CodeplyAttach) {
  const inp = $('attInput');
  inp.accept = window.CodeplyAttach.ACCEPT;
  inp.addEventListener('change', () => { const list = [...inp.files]; inp.value = ''; addAttFiles(list); });
}
function pickFiles() { if (window.CodeplyAttach) $('attInput').click(); }
async function runInCloud(chat, text) {
  if (!envFor(chat.project) || !state.creds || !state.creds.token || state.creds.expired) {
    pendingSend = { chatId: chat.id, text };
    openSetup({ chatId: chat.id });
    return;
  }
  try { await cloudSend(chat, text); } catch (e) { addMsg('error', e.message); }
}
async function stopCurrent(c) {
  if (c.kind === 'chat' && state.chatAbort) { state.chatAbort.abort(); return; }
  if (c.pcSessionId && relay.pcId && !c.cloud) {
    try { await relayRequest('POST', '/api/stop', { sessionId: c.pcSessionId }); } catch (e) { addMsg('error', e.message); }
  }
}
$('offlineYes').addEventListener('click', () => {
  $('offlineSheet').classList.add('hidden');
  const p = pendingSend; pendingSend = null;
  if (!p) return;
  const chat = chatMeta(p.chatId);
  if (chat) runInCloud(chat, p.text);
});
function offlineNotNow() {
  $('offlineSheet').classList.add('hidden');
  const p = pendingSend; pendingSend = null;
  if (!p) return;
  $('input').value = p.text; // keep the message so it can be sent later
  const chat = chatMeta(p.chatId);
  if (chat && !chat.title && !chat.pcSessionId && !body(chat.id).tasks.length) { deleteChat(chat.id, { silent: true }); newChat(); }
}
$('offlineNo').addEventListener('click', offlineNotNow);
$('offlineSheet').querySelector('.sheet-bg').addEventListener('click', offlineNotNow);

// ─── Cloud setup (GitHub login, repo, model, env vars) ──────────────────────
const setup = { chatId: null, repo: null, step: 'repos', repos: null, error: '', model: { kind: 'ollama', baseUrl: 'https://ollama.com', model: '', apiKey: '' }, envText: '', progress: [] };
function openSetup({ chatId = null, repo = null, step = null } = {}) {
  Object.assign(setup, { chatId, repo, step: step || (repo ? 'model' : 'repos'), error: '', progress: [], repos: null, filter: '' });
  if (repo && state.envs[repo] && state.envs[repo].model) setup.model = { ...setup.model, ...state.envs[repo].model, apiKey: '' };
  $('setup').classList.remove('hidden');
  renderSetup();
}
function closeSetup(done) {
  $('setup').classList.add('hidden');
  if (!done && pendingSend) { $('input').value = pendingSend.text; pendingSend = null; }
}
$('setupBack').addEventListener('click', () => closeSetup(false));

const TOKEN_LINK = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Codeply%20Cloud%20(phone)';
function renderSetup() {
  const root = $('setupBody');
  const chat = setup.chatId && chatMeta(setup.chatId);
  const projectName = chat && chat.project ? chat.project.name : '';
  if (!state.creds || !state.creds.token || state.creds.expired) {
    root.innerHTML = `<h2 class="serif">Connect GitHub</h2>
      <p>Cloud runs happen in your own GitHub account, so they keep going with your PC off.</p>
      <p>If you use Codeply on your PC, open it once while this phone is signed in and GitHub connects here on its own.</p>
      <p>Or <a href="${TOKEN_LINK}" target="_blank" rel="noopener">create a token</a> (repo and workflow come ticked) and paste it below. It stays on this phone.</p>
      <div class="field"><label for="ghToken">GitHub token</label><input id="ghToken" type="password" autocomplete="off" placeholder="ghp_... or github_pat_..."></div>
      <button class="btn btn-primary" id="ghTokenBtn" type="button">Connect</button>
      <p class="form-error ${setup.error ? '' : 'hidden'}" style="margin-top:12px">${esc(setup.error)}</p>`;
    root.querySelector('#ghTokenBtn').addEventListener('click', async (e) => {
      const v = root.querySelector('#ghToken').value.trim();
      if (!v) return root.querySelector('#ghToken').focus();
      e.target.disabled = true; e.target.textContent = 'Checking...';
      try {
        const me = await gh('GET', '/user', null, { token: v });
        state.creds = { token: v, login: me.json.login, projects: (state.creds && !state.creds.expired && state.creds.projects) || [], at: Date.now(), source: 'phone' };
        save(KEY.creds, state.creds);
        setup.error = '';
      } catch (err) { setup.error = err.status === 401 ? 'GitHub did not accept that token.' : err.message; }
      renderSetup();
    });
    return;
  }
  const who = `<div class="connected">${ICONS.cloud}<span>GitHub${state.creds.login ? ` as <b>${esc(state.creds.login)}</b>` : ' connected'}</span><button type="button" id="ghChange">Change</button></div>`;
  if (setup.step === 'repos') {
    root.innerHTML = `<h2 class="serif">Pick a repo</h2><p>${projectName ? `Where <b>${esc(projectName)}</b> runs in the cloud. ` : ''}Codeply works on a branch and merges it in when it is done.</p>${who}
      <div class="field"><input id="repoFilter" type="search" placeholder="Search repos" value="${esc(setup.filter || '')}"></div>
      <div id="repoList">${setup.repos ? '' : '<p><span class="spinner"></span></p>'}</div>
      <p class="form-error ${setup.error ? '' : 'hidden'}">${esc(setup.error)}</p>`;
    root.querySelector('#ghChange').addEventListener('click', () => { state.creds = { ...state.creds, expired: true }; renderSetup(); });
    root.querySelector('#repoFilter').addEventListener('input', (e) => { setup.filter = e.target.value; paintRepos(); });
    if (!setup.repos) {
      gh('GET', '/user/repos?affiliation=owner,collaborator&per_page=100').then((r) => {
        setup.repos = (r.json || []).filter((x) => x.permissions && x.permissions.push)
          .map((x) => ({ repo: x.full_name, base: x.default_branch || 'main', private: x.private, ready: x.description === MIRROR_DESCRIPTION, pushedAt: x.pushed_at || '' }))
          .sort((a, b) => (b.ready - a.ready) || String(b.pushedAt).localeCompare(String(a.pushedAt)));
        if (setup.step === 'repos') paintRepos();
      }).catch((err) => { setup.error = err.message; setup.repos = []; renderSetup(); });
    } else paintRepos();
    return;
  }
  if (setup.step === 'model') {
    const m = setup.model;
    root.innerHTML = `<h2 class="serif">Model and environment</h2><p>For <b>${esc(setup.repo)}</b>. The key goes into the repo's encrypted secrets, never anywhere else.</p>${who}
      <div class="field"><label>Model provider</label><div class="seg" id="kindSeg"><button type="button" data-kind="ollama">Ollama cloud</button><button type="button" data-kind="openai">OpenAI-compatible</button></div></div>
      <div class="field"><label for="mBase">Base URL</label><input id="mBase" type="url" autocapitalize="off" spellcheck="false" value="${esc(m.baseUrl)}" placeholder="${m.kind === 'ollama' ? 'https://ollama.com' : 'https://api.openai.com/v1'}"></div>
      <div class="field"><label for="mName">Model</label><input id="mName" type="text" autocapitalize="off" spellcheck="false" value="${esc(m.model)}" placeholder="${m.kind === 'ollama' ? 'gemma3:27b' : 'gpt-4.1-mini'}"></div>
      <div class="field"><label for="mKey">API key</label><input id="mKey" type="password" autocomplete="off" value="${esc(m.apiKey)}" placeholder="Your key for this provider"></div>
      <div class="field"><label for="envText">Environment variables (optional)</label><textarea id="envText" spellcheck="false" placeholder="KEY=value, one per line">${esc(setup.envText)}</textarea><small>For running and testing the app online. Saved as an encrypted secret and written to .env on the runner, never committed.</small></div>
      <button class="btn btn-primary" id="setupGo" type="button">Set up</button>
      <ul class="progress" id="setupProgress">${setup.progress.map((p) => `<li class="${p.done ? 'done' : ''}">${esc(p.text)}</li>`).join('')}</ul>
      <p class="form-error ${setup.error ? '' : 'hidden'}" style="margin-top:12px">${esc(setup.error)}</p>`;
    root.querySelector('#ghChange').addEventListener('click', () => { state.creds = { ...state.creds, expired: true }; renderSetup(); });
    const sync = () => { m.baseUrl = root.querySelector('#mBase').value.trim(); m.model = root.querySelector('#mName').value.trim(); m.apiKey = root.querySelector('#mKey').value.trim(); setup.envText = root.querySelector('#envText').value; };
    root.querySelectorAll('#kindSeg button').forEach((b) => {
      b.classList.toggle('on', b.dataset.kind === m.kind);
      b.addEventListener('click', () => {
        sync();
        if (b.dataset.kind === m.kind) return;
        m.kind = b.dataset.kind;
        if (m.kind === 'ollama' && !m.baseUrl) m.baseUrl = 'https://ollama.com';
        if (m.kind === 'openai' && m.baseUrl === 'https://ollama.com') m.baseUrl = '';
        renderSetup();
      });
    });
    root.querySelector('#setupGo').addEventListener('click', async (e) => { sync(); e.target.disabled = true; await runSetup(); });
  }
}
function paintRepos() {
  const list = $('repoList');
  if (!list || !setup.repos) return;
  const f = (setup.filter || '').toLowerCase();
  const known = new Set([...((state.creds && state.creds.projects) || []).map((p) => p.repo), ...Object.keys(state.envs)]);
  const rows = setup.repos.filter((r) => !f || r.repo.toLowerCase().includes(f)).slice(0, 60);
  list.innerHTML = rows.length
    ? `<div class="repo-list">${rows.map((r) => `<button type="button" class="repo-row" data-repo="${esc(r.repo)}"><span>${esc(r.repo)}</span>${r.ready || known.has(r.repo) ? '<span class="tag ready">Ready</span>' : r.private ? '<span class="tag">Private</span>' : ''}</button>`).join('')}</div>`
    : '<p>No repos you can push to match that.</p>';
  list.querySelectorAll('.repo-row').forEach((b) => b.addEventListener('click', () => {
    const r = setup.repos.find((x) => x.repo === b.dataset.repo);
    if (r.ready || known.has(r.repo)) return finishSetup({ repo: r.repo, base: r.base, ready: true });
    setup.repo = r.repo;
    setup.base = r.base;
    setup.step = 'model';
    renderSetup();
  }));
}
function modelConfig(m) {
  const kind = m.kind === 'ollama' ? 'ollama' : 'openai';
  const baseUrl = kind === 'ollama' ? String(m.baseUrl || 'https://ollama.com').replace(/\/+$/, '').replace(/\/(api|v1)$/i, '') : String(m.baseUrl || '').trim().replace(/\/+$/, '');
  if (!m.model) return { error: 'Enter the model name.' };
  if (!baseUrl) return { error: 'Enter the base URL.' };
  if (!/^https:\/\//i.test(baseUrl)) return { error: 'The base URL must start with https://.' };
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(baseUrl)) return { error: 'That address is on your own network, so the cloud cannot reach it. Use a cloud model.' };
  if (!m.apiKey) return { error: 'Enter the API key.' };
  return { kind, baseUrl, model: m.model, apiKey: m.apiKey };
}
async function runSetup() {
  setup.error = '';
  const cfg = modelConfig(setup.model);
  if (cfg.error) { setup.error = cfg.error; return renderSetup(); }
  const repo = setup.repo;
  const steps = setup.progress = [];
  const step = (text) => { steps.forEach((s) => { s.done = true; }); steps.push({ text }); renderSetup(); const b = $('setupGo'); if (b) b.disabled = true; };
  try {
    step('Adding the workflow');
    const base = setup.base || ((await gh('GET', `/repos/${repo}`)).json.default_branch) || 'main';
    const cur = await gh('GET', `/repos/${repo}/contents/${encPath(WORKFLOW_PATH)}?ref=${encodeURIComponent(base)}`, null, { allow: [404] });
    const want = textToB64(CLOUD_WORKFLOW);
    if (!(cur.status === 200 && String(cur.json.content || '').replace(/\s/g, '') === want)) {
      const r = await gh('PUT', `/repos/${repo}/contents/${encPath(WORKFLOW_PATH)}`, { message: 'Add Codeply Cloud workflow', branch: base, content: want, ...(cur.status === 200 && cur.json.sha ? { sha: cur.json.sha } : {}) });
      if (r.status >= 300) throw new Error('Could not add the workflow file. The token needs the workflow permission.');
    }
    step('Saving the model key');
    const pk = (await gh('GET', `/repos/${repo}/actions/secrets/public-key`)).json;
    await gh('PUT', `/repos/${repo}/actions/secrets/CODEPLY_API_KEY`, { encrypted_value: sealSecret(pk.key, cfg.apiKey), key_id: pk.key_id });
    const envText = String(setup.envText || '').trim();
    let envCount = 0;
    if (envText) {
      step('Saving the environment variables');
      await gh('PUT', `/repos/${repo}/actions/secrets/CRAFT_ENV`, { encrypted_value: sealSecret(pk.key, envText), key_id: pk.key_id });
      envCount = envText.split('\n').filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length;
    }
    step('Choosing the model');
    await setVariable(repo, 'CODEPLY_MODEL_KIND', cfg.kind);
    await setVariable(repo, 'CODEPLY_BASE_URL', cfg.baseUrl);
    await setVariable(repo, 'CODEPLY_MODEL', cfg.model);
    steps.forEach((s) => { s.done = true; });
    finishSetup({ repo, base, model: { kind: cfg.kind, baseUrl: cfg.baseUrl, model: cfg.model }, envCount });
  } catch (e) {
    setup.error = e.message;
    renderSetup();
  }
}
/** Remember the environment, tie it to the chat's project, and send what was waiting. */
function finishSetup({ repo, base, model = null, envCount = 0, ready = false }) {
  const chat = setup.chatId && chatMeta(setup.chatId);
  const prev = state.envs[repo] || {};
  const fromPc = ((state.creds && state.creds.projects) || []).find((p) => p.repo === repo);
  const cwd = (chat && chat.project && chat.project.cwd) || prev.cwd || (fromPc && fromPc.cwd) || null;
  state.envs[repo] = { ...prev, repo, base: base || prev.base || null, name: (chat && chat.project && chat.project.name) || prev.name || (fromPc && fromPc.name) || repo.split('/')[1], cwd, model: model || prev.model || null, envCount: envCount || prev.envCount || 0, ready: true, fromPc: ready && !model, at: Date.now() };
  save(KEY.envs, state.envs);
  if (chat) {
    chat.project = { ...(chat.project || {}), repo, name: (chat.project && chat.project.name) || state.envs[repo].name, key: (chat.project && chat.project.key) || `repo:${repo}` };
    saveChats();
  } else {
    state.ui.projectKey = cwd ? `cwd:${normCwd(cwd)}` : `repo:${repo}`;
    saveUi();
  }
  closeSetup(true);
  renderComposer();
  const p = pendingSend; pendingSend = null;
  const target = p && chatMeta(p.chatId);
  if (target) { openChat(target.id); cloudSend(target, p.text).catch((e) => addMsg('error', e.message)); }
}

// ─── Pickers (+, project, model, mode) ──────────────────────────────────────
function openPick(html, bind) {
  $('pickBody').innerHTML = html;
  $('pickSheet').classList.remove('hidden');
  if (bind) bind($('pickBody'));
}
const closePick = () => $('pickSheet').classList.add('hidden');
document.querySelectorAll('.sheet [data-close]').forEach((n) => n.addEventListener('click', () => n.closest('.sheet').classList.add('hidden')));

function openProjectPicker({ thenSend = null } = {}) {
  const list = allProjects();
  const cur = currentProject();
  const rows = list.map((p) => {
    const env = envFor(p);
    return `<button type="button" class="pick-row${cur && cur.key === p.key ? ' on' : ''}" data-key="${esc(p.key)}">${p.cwd ? ICONS.folder : ICONS.cloud}<span class="pick-main"><strong>${esc(p.name)}</strong><small>${p.cwd ? (env ? 'On your PC, cloud ready' : 'On your PC') : `Cloud, ${esc(p.repo)}`}</small></span>${ICONS.check}</button>`;
  }).join('');
  openPick(`<div class="sheet-title">Project</div>
    ${rows || '<p class="sheet-text">No projects yet. Open Codeply on your PC once, or set up a cloud environment.</p>'}
    <div class="pick-divider"></div>
    <button type="button" class="pick-row" data-act="setup">${ICONS.plus}<span class="pick-main"><strong>Set up a cloud environment</strong><small>A GitHub repo Codeply can work in with your PC off</small></span></button>`, (root) => {
    root.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => {
      closePick();
      const p = projectByKey(b.dataset.key);
      const c = state.current && chatMeta(state.current);
      if (c && c.kind === 'code' && body(c.id).pcItems.length + body(c.id).tasks.length && (!c.project || c.project.key !== p.key)) newChat();
      state.ui.projectKey = p.key;
      saveUi();
      const c2 = state.current && chatMeta(state.current);
      if (c2 && c2.kind === 'code') { c2.project = { key: p.key, name: p.name, cwd: p.cwd || null, repo: p.repo || null }; saveChats(); }
      renderComposer();
      if (thenSend) { $('input').value = thenSend; $('composer').requestSubmit(); }
    }));
    root.querySelector('[data-act="setup"]').addEventListener('click', () => { closePick(); openSetup({}); });
  });
}
function openPlus() {
  const code = state.ui.mode === 'code';
  const c = state.current && chatMeta(state.current);
  const cloudChat = c && c.cloud;
  const mode = (m, hint) => `<button type="button" class="pick-row${state.ui.codeMode === m ? ' on' : ''}" data-mode="${m}"><span class="pick-main"><strong>${m}</strong><small>${hint}</small></span>${ICONS.check}</button>`;
  const attachRow = `<button type="button" class="pick-row" data-act="attach"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg><span class="pick-main"><strong>Attach a file</strong><small>PDF, text or code</small></span></button><div class="pick-divider"></div>`;
  openPick(code
    ? `${attachRow}<div class="sheet-label">Mode</div>${mode('Build', 'Makes the changes')}${mode('Plan', 'Writes a plan before changing anything')}${mode('Ask', 'Answers questions, no edits')}
      ${cloudChat ? '' : `<div class="pick-divider"></div><div class="sheet-label">On your PC</div>
      <button type="button" class="pick-row${!state.bypass ? ' on' : ''}" data-bypass="0"><span class="pick-main"><strong>Ask first</strong><small>Approve edits and commands from here</small></span>${ICONS.check}</button>
      <button type="button" class="pick-row${state.bypass ? ' on' : ''}" data-bypass="1"><span class="pick-main"><strong>Full access</strong><small>Edits and commands run without asking</small></span>${ICONS.check}</button>`}
      <div class="pick-divider"></div>
      <button type="button" class="pick-row" data-act="project">${ICONS.folder}<span class="pick-main"><strong>Project</strong><small>${esc((currentProject() || {}).name || 'Choose one')}</small></span></button>
      <button type="button" class="pick-row" data-act="setup">${ICONS.cloud}<span class="pick-main"><strong>Cloud environment</strong><small>Repo, model and environment variables</small></span></button>`
    : `${attachRow}<div class="sheet-title">Chat</div><p class="sheet-text">A normal chat. To work on a project's files, switch to Code.</p>
      <button type="button" class="pick-row" data-act="code">${ICONS.folder}<span class="pick-main"><strong>Switch to Code</strong><small>Runs on your PC, or in the cloud when it is off</small></span></button>`, (root) => {
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.ui.codeMode = b.dataset.mode; saveUi(); closePick(); renderComposer(); }));
    root.querySelectorAll('[data-bypass]').forEach((b) => b.addEventListener('click', () => {
      const on = b.dataset.bypass === '1';
      if (on && !state.bypass && !confirm('Full access runs edits and commands on your PC without asking first. Turn it on?')) return;
      state.bypass = on; localStorage.setItem(KEY.bypass, on ? '1' : '0'); closePick();
    }));
    const act = (name, fn) => { const n = root.querySelector(`[data-act="${name}"]`); if (n) n.addEventListener('click', () => { closePick(); fn(); }); };
    act('project', () => openProjectPicker());
    act('setup', () => { const p = currentProject(); const env = envFor(p); openSetup({ chatId: c && c.kind === 'code' ? c.id : null, repo: env && !env.fromPc ? env.repo : null }); });
    act('code', () => setUiMode('code'));
    act('attach', () => pickFiles());
  });
}
/** A cloud environment set up on the PC: read its model name once from the repo's variables. */
const modelFetched = new Set();
function ensureEnvModel(env) {
  if (!env || (env.model && env.model.model) || modelFetched.has(env.repo) || !state.creds || !state.creds.token || state.creds.expired) return;
  modelFetched.add(env.repo);
  gh('GET', `/repos/${env.repo}/actions/variables/CODEPLY_MODEL`, null, { allow: [403, 404] }).then((r) => {
    if (r.status !== 200 || !r.json || !r.json.value) return;
    const e = state.envs[env.repo] || { repo: env.repo, name: env.name, cwd: env.cwd || null, base: env.base || null, ready: true, fromPc: true, at: Date.now() };
    e.model = { ...(e.model || {}), model: r.json.value };
    state.envs[env.repo] = e;
    save(KEY.envs, state.envs);
    renderComposer();
  }).catch(() => {});
}
function modelLabel() {
  if (state.ui.mode === 'chat') { const own = chatModel(); return own ? own.name : 'Auto'; }
  const c = state.current && chatMeta(state.current);
  const p = currentProject();
  const useCloud = (c && c.cloud) || (p && !p.cwd) || (p && !relay.pcId && envFor(p));
  if (useCloud) { const env = envFor(p); ensureEnvModel(env); return (env && env.model && env.model.model) || 'Cloud'; }
  const m = state.pc.models;
  if (!m) return 'Auto';
  const cur = (m.models || []).find((x) => x.id === m.selected);
  return cur ? cur.name : 'Auto';
}
function openModelPicker() {
  if (state.ui.mode === 'chat') {
    loadSynced();
    const cur = chatModel() ? chatModel().id : 'auto';
    const row = (id, name, hint, tag) => `<button type="button" class="pick-row${id === cur ? ' on' : ''}" data-id="${esc(id)}"><span class="pick-main"><strong>${esc(name)}${tag ? ` <span class="pick-tag">${esc(tag)}</span>` : ''}</strong><small>${esc(hint)}</small></span>${ICONS.check}</button>`;
    openPick(`<div class="sheet-title">Model</div>${row('auto', 'Auto', 'Picked for you by Codeply')}${state.synced.map((m) => row(m.id, m.name, `${m.model}, your API key ${m.key || ''}`.trim(), 'Synced')).join('')}
      <p class="pick-note">${state.synced.length ? 'Synced models use your own API key, stored encrypted in your Codeply account. They work with your PC off.' : 'Chat and Code share your Codeply daily limit. Turn on "Use on my phone" for a model in Codeply on your PC to use it here.'}</p>`, (root) => {
      root.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => {
        state.ui.chatModel = b.dataset.id; saveUi(); closePick(); renderComposer();
      }));
    });
    return;
  }
  const c = state.current && chatMeta(state.current);
  const p = currentProject();
  const env = envFor(p);
  if ((c && c.cloud) || (p && !p.cwd) || (p && !relay.pcId && env)) {
    openPick(`<div class="sheet-title">Cloud model</div>
      <button type="button" class="pick-row on"><span class="pick-main"><strong>${esc((env && env.model && env.model.model) || 'Set on your PC')}</strong><small>${esc((env && env.model && env.model.baseUrl) || (env ? env.repo : ''))}</small></span>${ICONS.check}</button>
      <button type="button" class="pick-row" data-act="change">${ICONS.cloud}<span class="pick-main"><strong>Change model</strong><small>Updates the repo's secret and variables</small></span></button>`, (root) => {
      root.querySelector('[data-act="change"]').addEventListener('click', () => { closePick(); if (env) openSetup({ chatId: c ? c.id : null, repo: env.repo, step: 'model' }); else openSetup({}); });
    });
    return;
  }
  const m = state.pc.models || { selected: 'auto', models: [] };
  const row = (id, name, hint) => `<button type="button" class="pick-row${id === m.selected ? ' on' : ''}" data-id="${esc(id)}"><span class="pick-main"><strong>${esc(name)}</strong><small>${esc(hint)}</small></span>${ICONS.check}</button>`;
  openPick(`<div class="sheet-title">Model on your PC</div>${row('auto', 'Auto', 'Picked for you, uses your Codeply limit')}${(m.models || []).map((x) => row(x.id, x.name, x.kind === 'ollama' ? 'Local, runs on your PC' : x.kind === 'chatgpt' ? 'Uses your ChatGPT plan, stays on your PC' : isSyncedOnPhone(x) ? 'Your API key, Synced: also works in Chat with the PC off' : 'Your API key, on your PC only')).join('')}
    <p class="pick-note">Add models in Codeply on your PC. A key leaves it only when "Use on my phone" is on, and is then stored encrypted in your account.</p>`, (root) => {
    root.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
      closePick();
      if (!relay.pcId) return;
      try { const r = await relayRequest('POST', '/api/models/select', { id: b.dataset.id }); if (r && Array.isArray(r.models)) { state.pc.models = r; save(KEY.pc, state.pc); } renderComposer(); }
      catch (e) { addMsg('error', e.message); }
    }));
  });
}

// ─── Shell: chats, sidebar, composer ────────────────────────────────────────
function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Morning, what are we making?';
  if (h >= 12 && h < 17) return "Afternoon, what's on your mind?";
  if (h >= 17 && h < 22) return 'Evening, how are things?';
  return 'Up late? What can I do?';
}
function renderTitle() {
  const c = state.current && chatMeta(state.current);
  $('topTitle').textContent = (c && c.title) || '';
  $('greeting').textContent = greeting();
  const sub = $('emptySub');
  sub.classList.toggle('hidden', state.ui.mode !== 'code');
  sub.textContent = 'Pick a project and say what to change.';
}
function renderComposer() {
  const code = state.ui.mode === 'code';
  document.querySelectorAll('#modeSwitch button').forEach((b) => b.classList.toggle('on', b.dataset.uiMode === state.ui.mode));
  $('ctxRow').classList.toggle('hidden', !code);
  $('input').placeholder = code ? 'Describe a change, or ask about the code' : 'Ask Codeply anything';
  const c = state.current && chatMeta(state.current);
  const p = currentProject();
  $('projectChipName').textContent = p ? p.name : 'Choose project';
  $('projectChip').querySelector('svg').outerHTML = (c && c.cloud) || (p && !p.cwd) ? ICONS.cloud : ICONS.folder;
  $('codeModeName').textContent = state.ui.codeMode;
  $('pcStatus').classList.toggle('hidden', !!(c && c.cloud) || !!(p && !p.cwd));
  $('modelName').textContent = modelLabel();
  const busy = !!(c && state.busy.has(c.id));
  $('sendIcon').classList.toggle('hidden', busy);
  $('stopIcon').classList.toggle('hidden', !busy);
  $('sendBtn').setAttribute('aria-label', busy ? 'Stop' : 'Send');
}
function setUiMode(mode) {
  if (mode === state.ui.mode) return;
  const c = state.current && chatMeta(state.current);
  state.ui.mode = mode;
  saveUi();
  if (c && c.kind !== mode) newChat();
  renderTitle();
  renderComposer();
}
function newChat() {
  state.current = null;
  feed().innerHTML = '';
  streamEl = null;
  showFeed(false);
  renderChatList();
  renderTitle();
  renderComposer();
}
function openChat(id, { keepMode = false } = {}) {
  const c = chatMeta(id);
  if (!c) return;
  state.current = id;
  if (!keepMode) {
    state.ui.mode = c.kind;
    if (c.project && c.project.key) state.ui.projectKey = c.project.key;
    saveUi();
  }
  renderFeed({ force: true });
  renderChatList();
  if (c.pcSessionId && !c.cloud && relay.pcId && !state.busy.has(c.id)) refreshPcSession(c).catch(() => {});
}
/** A PC chat the phone has not opened yet: link it to a local chat and open it. */
function openPcSession(meta) {
  let c = state.chats.find((x) => x.pcSessionId === meta.id);
  if (!c) c = createChat('code', { pcSessionId: meta.id, title: meta.title || 'Untitled', project: { key: `cwd:${normCwd(meta.cwd)}`, name: basename(meta.cwd), cwd: meta.cwd, repo: null }, updatedAt: meta.updatedAt || Date.now() });
  openChat(c.id);
}
function deleteChat(id, { silent = false } = {}) {
  state.chats = state.chats.filter((c) => c.id !== id);
  state.bodies.delete(id);
  try { localStorage.removeItem(KEY.chat(id)); } catch {}
  saveChats();
  if (state.current === id) state.current = null;
  if (!silent) { renderChatList(); renderFeed(); }
}

function renderChatList() {
  const list = $('chatList');
  const q = ($('searchInput').value || '').trim().toLowerCase();
  const linked = new Set(state.chats.map((c) => c.pcSessionId).filter(Boolean));
  const rows = [
    ...state.chats.filter((c) => c.title).map((c) => ({ type: 'local', id: c.id, title: c.title, kind: c.kind, cloud: c.cloud, at: c.updatedAt })),
    ...(state.pc.sessions || []).filter((s) => !linked.has(s.id)).map((s) => ({ type: 'pc', id: s.id, title: s.title || 'Untitled', kind: 'code', cloud: !!s.cloud, at: s.updatedAt || 0, meta: s })),
  ].filter((r) => !q || String(r.title).toLowerCase().includes(q)).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 200);
  list.innerHTML = rows.length ? '' : `<div class="chat-empty">${q ? 'No chats match.' : 'No chats yet.'}</div>`;
  for (const r of rows) {
    const b = el('button', `chat-row${r.type === 'local' && r.id === state.current ? ' active' : ''}`, `${r.kind === 'code' ? (r.cloud ? ICONS.cloud : ICONS.folder) : ''}<span></span>`);
    b.type = 'button';
    b.querySelector('span').textContent = r.title;
    b.dataset.kind = r.cloud ? 'cloud' : r.kind;
    b.addEventListener('click', () => { closeDrawer(); if (r.type === 'pc') openPcSession(r.meta); else openChat(r.id); });
    // A visible "..." for rename and delete (long press works too).
    const more = el('span', 'chat-more', ICONS.more);
    more.setAttribute('role', 'button');
    more.setAttribute('aria-label', 'Chat options');
    more.addEventListener('click', (e) => { e.stopPropagation(); chatMenu(r); });
    b.append(more);
    let pressTimer = null;
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); chatMenu(r); });
    b.addEventListener('touchstart', () => { pressTimer = setTimeout(() => chatMenu(r), 550); }, { passive: true });
    b.addEventListener('touchend', () => clearTimeout(pressTimer));
    b.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });
    list.append(b);
  }
}
/** Rename or delete a chat. A chat that lives on the PC is changed there too when the PC is reachable. */
function chatMenu(r) {
  const local = r.type === 'local' ? chatMeta(r.id) : null;
  const pcId = r.type === 'pc' ? r.id : (local && !local.cloud ? local.pcSessionId : null);
  const title = (local && local.title) || r.title || 'Chat';
  const onPc = !!(pcId && relay.pcId);
  openPick(`<div class="sheet-title">${esc(title)}</div>
    <button type="button" class="pick-row" data-act="rename"><span class="pick-main"><strong>Rename</strong></span></button>
    <button type="button" class="pick-row danger" data-act="delete"><span class="pick-main"><strong>Delete</strong>${pcId ? `<small>${onPc ? 'From this phone and your PC' : 'From this phone (your PC is offline, it keeps its copy)'}</small>` : ''}</span></button>`, (root) => {
    root.querySelector('[data-act="rename"]').addEventListener('click', async () => {
      closePick();
      const t = (prompt('Rename chat', title) || '').trim();
      if (!t) return;
      if (local) touchChat(local.id, { title: t });
      if (pcId) {
        const s = (state.pc.sessions || []).find((x) => x.id === pcId);
        if (s) s.title = t;
        if (onPc) relayRequest('POST', '/api/session/rename', { sessionId: pcId, title: t }).catch(() => {});
      }
      renderChatList();
    });
    root.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      closePick();
      if (!confirm(`Delete "${title}"?`)) return;
      if (local) deleteChat(local.id, { silent: true });
      if (pcId) {
        state.pc.sessions = (state.pc.sessions || []).filter((x) => x.id !== pcId);
        if (onPc) relayRequest('POST', '/api/session/delete', { sessionId: pcId }).catch(() => {});
      }
      renderChatList();
      renderFeed();
    });
  });
}
function renderAccount() {
  const email = (state.user && state.user.email) || '';
  $('accountEmail').textContent = email || 'Your account';
  $('accountInitial').textContent = (email[0] || 'C').toUpperCase();
}

function openDrawer() {
  renderChatList();
  $('drawerBackdrop').classList.remove('hidden');
  $('drawer').classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => { $('drawerBackdrop').classList.add('open'); $('drawer').classList.add('open'); }));
  $('drawer').setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  $('drawerBackdrop').classList.remove('open');
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { if (!$('drawer').classList.contains('open')) { $('drawerBackdrop').classList.add('hidden'); $('drawer').classList.add('hidden'); } }, 260);
}

// ─── Sign in (same flow as mobile.js) ───────────────────────────────────────
function friendlyAuthError(err, fallback) {
  const s = String((err && err.message) || err || '').toLowerCase();
  if (s.includes('invalid login') || s.includes('invalid credentials')) return 'Incorrect email or password.';
  if (s.includes('email not confirmed')) return 'Confirm your email first (check your inbox), then sign in.';
  if (s.includes('expired') || (s.includes('invalid') && (s.includes('otp') || s.includes('token')))) return 'That code is wrong or has expired. Request a new one.';
  if (s.includes('rate') || s.includes('too many') || s.includes('seconds')) return 'Too many attempts. Wait a minute and try again.';
  if (s.includes('signups not allowed') || s.includes('user not found')) return 'No account with that email. Create one in Codeply on your PC first.';
  if (s.includes('fetch') || s.includes('network')) return "Can't reach Codeply. Check your internet connection.";
  return (err && err.message) || fallback;
}
function signinStep(step, text) {
  $('loginForm').classList.toggle('hidden', step !== 'login');
  $('otpForm').classList.toggle('hidden', step !== 'otp');
  $('signinBusy').classList.toggle('hidden', step !== 'busy');
  if (step === 'busy') $('signinBusyText').textContent = text || 'Signing in...';
}
function showSignin() {
  $('app').classList.add('hidden');
  $('signin').classList.remove('hidden');
  signinStep('login');
}
async function enterApp() {
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
  const s = await currentSession();
  state.user = (s && s.user) || state.user;
  renderAccount();
  renderTitle();
  renderComposer();
  renderChatList();
  if (state.current) renderFeed({ force: true });
  startRelay();
  loadSynced();
  schedulePoll(500);
}
async function signOut() {
  closeDrawer();
  await closeRelay();
  try { await sb.auth.signOut(); } catch {}
  $('loginPassword').value = '';
  showSignin();
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.classList.add('hidden');
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) return;
  signinStep('busy', 'Signing in...');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    $('loginPassword').value = '';
    await enterApp();
  } catch (x) {
    signinStep('login');
    err.textContent = friendlyAuthError(x, 'Sign-in failed.');
    err.classList.remove('hidden');
  }
});
$('useCodeBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const err = $('loginError');
  if (!email) { err.textContent = 'Enter your email first.'; err.classList.remove('hidden'); return; }
  err.classList.add('hidden');
  signinStep('busy', 'Sending your code...');
  try {
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) throw error;
    $('otpSentTo').textContent = `We emailed a sign-in code to ${email}.`;
    $('loginOtp').value = '';
    signinStep('otp');
    $('loginOtp').focus();
  } catch (x) {
    signinStep('login');
    err.textContent = friendlyAuthError(x, 'Could not send a code.');
    err.classList.remove('hidden');
  }
});
$('otpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('otpError');
  err.classList.add('hidden');
  const email = $('loginEmail').value.trim();
  const token = $('loginOtp').value.replace(/\D+/g, '');
  if (token.length < 6) { err.textContent = 'Enter the full code from the email.'; err.classList.remove('hidden'); return; }
  signinStep('busy', 'Signing in...');
  try {
    const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
    await enterApp();
  } catch (x) {
    signinStep('otp');
    err.textContent = friendlyAuthError(x, 'Could not verify the code.');
    err.classList.remove('hidden');
  }
});
$('otpBackBtn').addEventListener('click', () => signinStep('login'));

// ─── Wiring ─────────────────────────────────────────────────────────────────
$('composer').addEventListener('submit', onSubmit);
$('input').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`; });
$('input').addEventListener('keydown', (e) => {
  // Enter sends on a desktop keyboard; phones keep Enter for new lines.
  if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $('composer').requestSubmit(); }
});
document.querySelectorAll('#modeSwitch button').forEach((b) => b.addEventListener('click', () => setUiMode(b.dataset.uiMode)));
$('plusBtn').addEventListener('click', openPlus);
$('projectChip').addEventListener('click', () => openProjectPicker());
$('codeModeChip').addEventListener('click', openPlus);
$('modelBtn').addEventListener('click', openModelPicker);
$('menuBtn').addEventListener('click', openDrawer);
$('drawerBackdrop').addEventListener('click', closeDrawer);
$('newChatTopBtn').addEventListener('click', newChat);
$('drawerNewChat').addEventListener('click', () => { closeDrawer(); state.ui.mode = 'chat'; saveUi(); newChat(); });
$('drawerCode').addEventListener('click', () => { closeDrawer(); state.ui.mode = 'code'; saveUi(); newChat(); });
$('searchInput').addEventListener('input', renderChatList);
$('themeBtn').addEventListener('click', () => { const order = ['system', 'light', 'dark']; applyTheme(order[(order.indexOf(themeChoice()) + 1) % 3]); });
$('signOutBtn').addEventListener('click', signOut);
$('approveBtn').addEventListener('click', () => answerApproval('once'));
$('rejectBtn').addEventListener('click', () => answerApproval('reject'));
$('imageYes').addEventListener('click', () => answerImagePick((state.imagePick && state.imagePick.url) || null));
$('imageNo').addEventListener('click', () => answerImagePick(null));
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if (!$('feed').classList.contains('hidden')) scrollToBottom(); });
setInterval(() => { if (!state.current) renderTitle(); }, 60000);

syncTheme();
currentSession().then((s) => { if (s) enterApp(); else showSignin(); }).catch(showSignin);

// For tests and debugging in the console.
// phone-calls.js (Calls with bots) builds on these too.
window.CraftPhone = { state, relay, sealSecret, CLOUD_WORKFLOW, md, pollAll, relayRequest, accessToken, esc, load, save, newId, openDrawer, closeDrawer, AI_PROXY_URL, SUPABASE_ANON_KEY,
  cloudEnvForBots, startCloudTask, pollCloudTask: pollTask };

// Reminders and "calls" from your bots arrive as Web Push: phone-sw.js shows
// them (phone-reminders.js asks for permission and subscribes).
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('phone-sw.js', { scope: './' }).catch((e) => console.debug('[phone] service worker:', e.message));
}
