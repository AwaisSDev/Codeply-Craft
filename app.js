/* ============ Codeply Craft — renderer ============ */

// NOTE: the preload bridge is window.craft — exposed via contextBridge it is a
// non-configurable global, so a top-level `const craft` here is a SyntaxError.
// Hence the different local name.
const api = window.craft || null;

const $ = (id) => document.getElementById(id);

// Identifies this window as the sender of a message, mirroring mobile.js's
// clientId — lets the 'session_sync' handler below tell "a message I just
// sent" apart from "a message another paired device (phone) just sent",
// without which it would either double up this window's own messages or
// never render the phone's.
function makeClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const desktopClientId = localStorage.getItem('craft-desktop-client-id') || makeClientId();
localStorage.setItem('craft-desktop-client-id', desktopClientId);

const state = {
  user: null,
  providerLabel: '',
  sessions: [],
  projects: [],
  project: null,
  branch: null,
  mode: 'Build',
  bypass: false,
  currentSessionId: null,
  running: false,
  pendingEmail: '',
};

// ─── Window controls ────────────────────────────────────────────────────────
$('winMin').addEventListener('click', () => api && api.minimize());
$('winMax').addEventListener('click', () => api && api.maximize());
$('winClose').addEventListener('click', () => api ? api.close() : window.close());
// The expand button lives in the titlebar, OUTSIDE the sidebar itself — it
// has to, since the whole point is reaching it after the sidebar (and the
// collapse button living inside it) has slid off-screen.
function setSidebarCollapsed(collapsed) {
  $('sidebar').classList.toggle('collapsed', collapsed);
  $('sidebarExpandBtn').classList.toggle('hidden', !collapsed);
}
$('sidebarToggle').addEventListener('click', () => setSidebarCollapsed(true));
$('sidebarExpandBtn').addEventListener('click', () => setSidebarCollapsed(false));

// ─── View switching ─────────────────────────────────────────────────────────
const VIEWS = ['viewLogin', 'viewReferral', 'viewCountry', 'viewPlans', 'viewLocked', 'viewHome', 'viewChat', 'viewEngineError'];

// Home and chat are gated behind sign-in — nothing usable happens until the
// account flow completes, no matter how a view swap was triggered (New chat,
// a suggestion card, reopening a session, ...). One choke point here instead
// of a check sprinkled at every call site.
function showView(name) {
  if ((name === 'viewHome' || name === 'viewChat') && !state.user) name = 'viewLogin';
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== name);
}

// ─── Tiny markdown renderer (safe: everything escaped first) ────────────────
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdToHtml(text) {
  const src = esc(text);
  const parts = src.split(/```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // fenced code block; first line may be a language tag
      const nl = parts[i].indexOf('\n');
      const lang = nl > -1 ? parts[i].slice(0, nl).trim() : '';
      const code = nl > -1 ? parts[i].slice(nl + 1) : parts[i];
      html += `<div class="code-card"><div class="code-card-head"><span>${lang || 'code'}</span></div><pre><code>${code}</code></pre></div>`;
    } else {
      html += inlineMd(parts[i]);
    }
  }
  return html;
}

function inlineMd(src) {
  const lines = src.split('\n');
  let out = '';
  let inList = false;
  let para = [];
  const flush = () => {
    if (para.length) {
      out += `<p>${para.join('<br>')}</p>`;
      para = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m = line.match(/^\s*[-*•]\s+(.*)/);
    if (m) {
      flush();
      if (!inList) { out += '<ul>'; inList = true; }
      out += `<li>${spans(m[1])}</li>`;
      continue;
    }
    if (inList) { out += '</ul>'; inList = false; }
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { flush(); out += `<p class="md-h">${spans(h[2])}</p>`; continue; }
    para.push(spans(line));
  }
  if (inList) out += '</ul>';
  flush();
  return out;
}

// Models occasionally slip into LaTeX-style math tokens in plain prose
// (e.g. "Homepage $\rightarrow$ Login") even though this is a plain-text
// chat, not a math renderer. Swap the common ones for their Unicode glyph
// so they read normally instead of showing the raw markup.
const LATEX_TOKEN = /\$?\\(rightarrow|Rightarrow|leftrightarrow|Leftrightarrow|leftarrow|Leftarrow|to|times|cdot|approx|neq|leq|geq|pm|infty)\$?/g;
const LATEX_MAP = {
  rightarrow: '→', to: '→', Rightarrow: '⇒',
  leftarrow: '←', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔',
  times: '×', cdot: '·', approx: '≈', neq: '≠', leq: '≤', geq: '≥', pm: '±', infty: '∞',
};

function spans(s) {
  return s
    .replace(LATEX_TOKEN, (_, name) => LATEX_MAP[name] || '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// ─── Chat rendering ─────────────────────────────────────────────────────────
const chatColumn = $('chatColumn');
const chatScroll = $('chatScroll');

const TOOL_DISPLAY = {
  list_dir: 'Listed', read_file: 'Read', write_file: 'Wrote', edit_file: 'Edited',
  search: 'Searched', run: 'Ran', use_skill: 'Loaded skill', list_skills: 'Searched skills',
  fetch_image: 'Downloaded', browser_check: 'Checked',
  gmail_send: 'Emailed', gmail_search: 'Searched Gmail', slack_post_message: 'Posted',
  design_reference_search: 'Searched design library',
};

// Human-readable tool names for approval UI — never show the raw
// underscored identifier (write_file, fetch_image, ...) to the user.
const TOOL_NAME = {
  list_dir: 'list directory', read_file: 'read file', write_file: 'write file',
  edit_file: 'edit file', search: 'search', run: 'run command',
  use_skill: 'use skill', list_skills: 'list skills', fetch_image: 'download image',
  browser_check: 'check in browser',
  gmail_send: 'send email', gmail_search: 'search Gmail', slack_post_message: 'post to Slack',
  design_reference_search: 'search design library',
};
const toolName = (name) => TOOL_NAME[name] || name.replace(/_/g, ' ');

const TOOL_ICON = {
  read: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/></svg>',
  write: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  run: '<svg viewBox="0 0 24 24"><path d="M4 17l6-5-6-5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>',
  skill: '<svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.6L20 10.8l-5.8 2.2L12 19l-2.2-6L4 10.8l5.8-2.2Z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 15l5-4 4 3 4-4 5 5"/></svg>',
  browser: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/></svg>',
  slack: '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="14" rx="3"/><rect x="9" y="8" width="14" height="6" rx="3" transform="rotate(90 16 11)"/></svg>',
  library: '<svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="7" y1="6" x2="17" y2="6"/><line x1="7" y1="17" x2="17" y2="17"/></svg>',
};

function toolIcon(name) {
  if (name === 'run') return TOOL_ICON.run;
  if (name === 'search' || name === 'list_dir') return TOOL_ICON.search;
  if (name === 'write_file' || name === 'edit_file') return TOOL_ICON.write;
  if (name === 'use_skill' || name === 'list_skills') return TOOL_ICON.skill;
  if (name === 'fetch_image') return TOOL_ICON.image;
  if (name === 'browser_check') return TOOL_ICON.browser;
  if (name === 'gmail_send' || name === 'gmail_search') return TOOL_ICON.mail;
  if (name === 'slack_post_message') return TOOL_ICON.slack;
  if (name === 'design_reference_search') return TOOL_ICON.library;
  return TOOL_ICON.read;
}

function scrollToBottom() {
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function nearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
}

// Guards against the exact same user message rendering twice in a row — seen
// with the composer's send button/Enter handler double-firing under a slow
// backend response (a rate-limited free-tier model taking noticeably longer
// gives more real wall-clock time for a stray double dispatch to land before
// state.running has actually flipped). There's no legitimate case for the
// identical text to appear twice back-to-back with nothing in between, so
// this is a safe idempotency check rather than a real "did the user mean to
// resend this" judgment call.
let lastUserMessage = null; // { text, imageCount, at }

function addUserMessage(text, images) {
  const imageCount = images ? images.length : 0;
  if (lastUserMessage && lastUserMessage.text === text && lastUserMessage.imageCount === imageCount
    && Date.now() - lastUserMessage.at < 4000) {
    return;
  }
  lastUserMessage = { text, imageCount, at: Date.now() };

  const msg = document.createElement('div');
  msg.className = 'msg user';
  if (images && images.length) {
    const row = document.createElement('div');
    row.className = 'bubble-images';
    for (const src of images) {
      const img = document.createElement('img');
      img.src = src;
      img.addEventListener('click', () => openImageLightbox(src));
      row.appendChild(img);
    }
    msg.appendChild(row);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  msg.appendChild(bubble);
  chatColumn.appendChild(msg);
  scrollToBottom();
}

function openImageLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  overlay.innerHTML = `<img src="${src}" alt="">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// Live responses type out word by word; replayed history (reopening an old
// chat) renders instantly — animating text you've already read is just a
// delay, not a nice touch.
//
// Only one typewriter runs at a time, strictly in the order messages arrived.
// A turn can yield several separate 'text' events (prose alongside an action
// block, then more prose next step, then a final wrap-up) — without this
// queue, a fast step landing before the previous bubble finished animating
// started a SECOND interval concurrently: two bubbles visibly typing at once,
// which reads as the reply repeating itself even when the underlying text
// isn't actually a duplicate. The message div itself is still created and
// appended to chatColumn immediately (not deferred into the queue) so DOM
// order stays correct relative to tool rows that land in between; only the
// animation start is deferred.
const activeTypewriters = new Set();
const typewriterQueue = [];
let typewriterRunning = false;

function stopAllTypewriters() {
  for (const t of activeTypewriters) clearInterval(t);
  activeTypewriters.clear();
  typewriterQueue.length = 0;
  typewriterRunning = false;
}

const TYPE_CURSOR = '<span class="type-cursor"></span>';
// Appending the cursor as a trailing sibling puts it after the last block
// element's closing tag (</p>, </li>, ...), which starts a new line —
// exactly the stray floating "|" this was producing whenever a paragraph
// break got revealed before the next paragraph's first word arrived.
// Splicing it in just before that closing tag keeps it inline, at the
// actual end of the visible text.
const withTypeCursor = (html) => (html ? html.replace(/(<\/[a-z0-9]+>)\s*$/i, TYPE_CURSOR + '$1') : TYPE_CURSOR);

function runTypewriterQueue() {
  if (typewriterRunning || typewriterQueue.length === 0) return;
  typewriterRunning = true;
  const { msg, text } = typewriterQueue.shift();

  const words = text.split(/(\s+)/); // keeps whitespace tokens so spacing survives the join
  const total = words.filter((w) => w.trim()).length;
  // Speeds up for long replies so a 500-word answer doesn't take forever —
  // targets roughly a 4-second animation no matter the length, floor 50 wds/s.
  const wordsPerTick = Math.max(1, Math.ceil(total / 200));
  let i = 0;
  msg.innerHTML = TYPE_CURSOR;

  const timer = setInterval(() => {
    i = Math.min(words.length, i + wordsPerTick);
    msg.innerHTML = withTypeCursor(mdToHtml(words.slice(0, i).join('')));
    if (nearBottom()) scrollToBottom();
    if (i >= words.length) {
      clearInterval(timer);
      activeTypewriters.delete(timer);
      msg.innerHTML = mdToHtml(text); // exact final render, cursor removed
      if (nearBottom()) scrollToBottom();
      typewriterRunning = false;
      runTypewriterQueue();
    }
  }, 20);
  activeTypewriters.add(timer);
}

function addAssistantMessage(text, { animate = true } = {}) {
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  chatColumn.appendChild(msg);

  if (!animate) {
    msg.innerHTML = mdToHtml(text);
    if (nearBottom()) scrollToBottom();
    return;
  }

  typewriterQueue.push({ msg, text });
  runTypewriterQueue();
}

// The raw arguments a real tool call ran with — path, command, search/replace,
// pattern, whatever that tool takes — formatted close to the actual
// <codeply:name>...</codeply:name> block the model wrote, so clicking a tool
// row shows what really happened instead of leaving it as an opaque one-line
// summary.
function formatToolDetail(name, args) {
  if (!args || !Object.keys(args).length) return '(no arguments)';
  if (name === 'run') return args.command || '(no arguments)';
  const lines = Object.entries(args).map(([k, v]) => `<${k}>\n${v}\n</${k}>`);
  return lines.join('\n\n');
}

// A single fallback chain for "what's the one-line summary of this call's
// arguments" — path/command/pattern/name covered the original file+shell
// tools; to/channel cover the two new integrations, whose defining argument
// isn't any of those.
function toolArgsLabel(args) {
  return args?.path || args?.command || args?.pattern || args?.name
    || (args?.to ? `to ${args.to}` : '')
    || (args?.channel ? `#${String(args.channel).replace(/^#/, '')}` : '')
    || args?.query || '';
}

function addToolRow({ name, label, ok, running: isRunning, auto, bypass, args }) {
  const row = document.createElement('div');
  row.className = 'tool-row' + (isRunning ? ' running' : '') + (ok === false ? ' failed' : '');
  const verb = TOOL_DISPLAY[name] || name;
  const badge = auto ? `<span class="tool-badge">${bypass ? 'bypass' : 'auto approved'}</span>` : '';
  const hasDetail = !isRunning && args && Object.keys(args).length > 0;
  row.innerHTML =
    `<div class="tool-row-head">${toolIcon(name)}<span class="tool-verb">${isRunning ? verb.replace(/ed$|^Ran$/, (m) => m === 'Ran' ? 'Running' : 'ing').replace('Listeding', 'Listing') : verb}</span>` +
    `<span class="tool-label">${esc(label || '')}</span>${badge}${hasDetail ? '<svg class="tool-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' : ''}</div>`;
  if (isRunning) row.querySelector('.tool-row-head').innerHTML += '<span class="spinner"></span>';

  if (hasDetail) {
    const detail = document.createElement('pre');
    detail.className = 'tool-detail hidden';
    detail.textContent = formatToolDetail(name, args);
    row.appendChild(detail);
    row.classList.add('expandable');
    row.querySelector('.tool-row-head').addEventListener('click', () => {
      detail.classList.toggle('hidden');
      row.classList.toggle('expanded');
    });
  }

  chatColumn.appendChild(row);
  if (nearBottom()) scrollToBottom();
  return row;
}

// Task Maker checklist — one live block per run, updated in place as
// task_start/task_end events arrive rather than re-rendered from scratch,
// so it reads as a real progress list instead of flickering.
let activeTaskList = null; // { rows: Map<id, rowEl> }
let currentTasks = []; // plain data mirror of the active/last checklist, for the Tasks panel + sidebar badge

function buildTaskListEl(tasks) {
  const wrap = document.createElement('div');
  wrap.className = 'tasklist';
  const head = document.createElement('div');
  head.className = 'tasklist-head';
  head.textContent = `Task Maker: ${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  wrap.appendChild(head);

  const rows = new Map();
  for (const t of tasks) {
    const row = document.createElement('div');
    row.className = 'tasklist-row';
    row.dataset.status = t.status;
    const dot = document.createElement('span');
    dot.className = 'tasklist-status';
    dot.setAttribute('data-status', t.status);
    const label = document.createElement('span');
    label.className = 'tasklist-text';
    label.textContent = t.text;
    row.appendChild(dot);
    row.appendChild(label);
    wrap.appendChild(row);
    rows.set(t.id, row);
  }
  return { wrap, rows };
}

function addTaskList(tasks) {
  const { wrap, rows } = buildTaskListEl(tasks);
  chatColumn.appendChild(wrap);
  if (nearBottom()) scrollToBottom();
  activeTaskList = { rows };
  currentTasks = tasks.map((t) => ({ ...t }));
  refreshTasksUI();
}

function updateTaskStatus(id, status) {
  const task = currentTasks.find((t) => t.id === id);
  if (task) task.status = status;
  refreshTasksUI();
  if (!activeTaskList) return;
  const row = activeTaskList.rows.get(id);
  if (!row) return;
  row.dataset.status = status;
  row.classList.toggle('active', status === 'in_progress');
  const dot = row.querySelector('.tasklist-status');
  if (dot) dot.setAttribute('data-status', status);
}

// ─── Tasks panel (sidebar "Tasks" button) ──────────────────────────────────
// Mirrors whatever checklist Task Maker is currently running (or last ran)
// in this chat so it's visible without scrolling back through the transcript.
const PENDING_TASK_STATUSES = new Set(['pending', 'in_progress']);

function refreshTasksUI() {
  const left = currentTasks.filter((t) => PENDING_TASK_STATUSES.has(t.status)).length;
  const badge = $('tasksBadge');
  if (badge) {
    badge.textContent = String(left);
    badge.classList.toggle('hidden', left === 0);
  }
  const backdrop = $('tasksBackdrop');
  if (backdrop && !backdrop.classList.contains('hidden')) renderTasksPanel();
}

function renderTasksPanel() {
  const body = $('tasksModalBody');
  const sub = $('tasksSub');
  body.innerHTML = '';
  if (currentTasks.length === 0) {
    sub.textContent = 'Nothing to show yet. This chat has not needed Task Maker.';
    const empty = document.createElement('div');
    empty.className = 'tasks-modal-empty';
    empty.textContent = 'Send a multi-part request and Task Maker will break it into steps here.';
    body.appendChild(empty);
    return;
  }
  const left = currentTasks.filter((t) => PENDING_TASK_STATUSES.has(t.status)).length;
  const done = currentTasks.filter((t) => t.status === 'done' || t.status === 'done-no-changes').length;
  sub.textContent = `${left} left, ${done} done, ${currentTasks.length} total in this chat.`;
  const { wrap } = buildTaskListEl(currentTasks);
  body.appendChild(wrap);
}

function openTasksModal() {
  renderTasksPanel();
  $('tasksBackdrop').classList.remove('hidden');
}

function closeTasksModal() {
  $('tasksBackdrop').classList.add('hidden');
}

$('tasksBtn').addEventListener('click', openTasksModal);
$('tasksCloseBtn').addEventListener('click', closeTasksModal);
$('tasksBackdrop').addEventListener('click', (e) => { if (e.target === $('tasksBackdrop')) closeTasksModal(); });

function addNote(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'chat-note ' + kind;
  el.textContent = text;
  chatColumn.appendChild(el);
  if (nearBottom()) scrollToBottom();
}

// ─── Side panel (real data: what this chat touched) ─────────────────────────
const spOutputs = $('spOutputs');
const spSources = $('spSources');
const panelSeen = { outputs: new Set(), sources: new Set() };

function resetSidePanel(cwd) {
  spOutputs.innerHTML = '<div class="sp-empty">Files the agent writes will show here</div>';
  spSources.innerHTML = '<div class="sp-empty">Files the agent reads will show here</div>';
  panelSeen.outputs.clear();
  panelSeen.sources.clear();
  const name = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : 'No project';
  $('spProject').querySelector('span').textContent = name;
  $('spProject').title = cwd || '';
}

function panelAdd(kind, label) {
  if (!label || panelSeen[kind].size >= 12 || panelSeen[kind].has(label)) return;
  panelSeen[kind].add(label);
  const holder = kind === 'outputs' ? spOutputs : spSources;
  const empty = holder.querySelector('.sp-empty');
  if (empty) empty.remove();
  const row = document.createElement('button');
  row.className = 'sp-row';
  row.innerHTML = `<svg class="sp-ico" viewBox="0 0 24 24"><path d="M9 18l-5-6 5-6"/><path d="M15 6l5 6-5 6"/></svg><span>${esc(label)}</span>`;
  holder.appendChild(row);
}

function panelTrack(name, label) {
  if (name === 'write_file' || name === 'edit_file' || name === 'fetch_image') panelAdd('outputs', label);
  else if (name === 'read_file') panelAdd('sources', label);
}

// ─── Connect Apps (Gmail / Slack) ───────────────────────────────────────────
// Lives in its own modal off the account menu, not the chat side panel — the
// side panel only exists inside an open chat, so anyone landing on the home
// screen (no chat open yet) had no way to find it at all. The account menu
// at the bottom of the sidebar is present in every state, logged-in or not.
function renderIntegrationRow(rowId, { connected, label }) {
  const row = $(rowId);
  row.classList.toggle('connected', connected);
  row.querySelector('[data-role="badge"]').textContent = connected ? 'Connected' : 'Not connected';
  const statusEl = row.querySelector('[data-role="status"]');
  statusEl.textContent = label || '';
  statusEl.classList.toggle('hidden', !connected || !label);
  const btn = row.querySelector('[data-role="action"]');
  btn.textContent = connected ? 'Disconnect' : 'Connect';
  btn.classList.toggle('danger', connected);
}

async function refreshIntegrations() {
  if (!api) return;
  const s = await api.integrationsStatus();
  renderIntegrationRow('caGmail', { connected: !!s.gmail?.connected, label: s.gmail?.email });
  renderIntegrationRow('caSlack', { connected: !!s.slack?.connected, label: s.slack?.teamName });
}

function wireIntegrationRow(rowId, connectFn, providerLabel) {
  $(rowId).querySelector('[data-role="action"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const row = $(rowId);
    if (row.classList.contains('connected')) {
      await api.disconnectIntegration(rowId === 'caGmail' ? 'gmail' : 'slack');
      refreshIntegrations();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    const r = await connectFn();
    btn.disabled = false;
    if (!r.ok) addNote(`${providerLabel} connect failed: ${r.error}`, 'error');
    refreshIntegrations();
  });
}

wireIntegrationRow('caGmail', () => api.connectGmail(), 'Gmail');
wireIntegrationRow('caSlack', () => api.connectSlack(), 'Slack');

function openConnectApps() {
  closeAccountMenu();
  refreshIntegrations();
  $('connectAppsBackdrop').classList.remove('hidden');
}
function closeConnectApps() {
  $('connectAppsBackdrop').classList.add('hidden');
}
$('connectAppsCloseBtn').addEventListener('click', closeConnectApps);
$('connectAppsBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeConnectApps();
});

// ─── Account menu (bottom of the sidebar) ───────────────────────────────────
let accountMenuEl = null;

function closeAccountMenu() {
  if (accountMenuEl) { accountMenuEl.remove(); accountMenuEl = null; }
}

function openAccountMenu() {
  closeAccountMenu();
  if (!state.user) return;
  const menu = document.createElement('div');
  menu.className = 'account-menu';
  menu.innerHTML = `
    <div class="account-menu-header">
      <div class="avatar">${esc(state.user.email.slice(0, 2).toUpperCase())}</div>
      <div class="account-menu-email">${esc(state.user.email)}</div>
    </div>
    <div class="account-menu-divider"></div>
    <button class="account-menu-item" data-action="connect">
      <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
      Connect Apps
    </button>
    <button class="account-menu-item" data-action="upgrade">
      <svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
      Upgrade plan
    </button>
    <button class="account-menu-item" data-action="logout">
      <svg viewBox="0 0 24 24"><path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="M16 17l5-5-5-5"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      Sign out
    </button>
  `;
  document.body.appendChild(menu);
  const rect = $('sbUserBtn').getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  menu.style.left = rect.left + 'px';
  menu.style.width = rect.width + 'px';

  menu.querySelector('[data-action="connect"]').addEventListener('click', openConnectApps);
  menu.querySelector('[data-action="upgrade"]').addEventListener('click', () => {
    closeAccountMenu();
    showPlansPage();
  });
  menu.querySelector('[data-action="logout"]').addEventListener('click', async () => {
    closeAccountMenu();
    await api.logout();
    state.user = null;
    renderUser();
    showView('viewLogin');
  });
  accountMenuEl = menu;
}

$('sbUserBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (accountMenuEl) closeAccountMenu();
  else openAccountMenu();
});
document.addEventListener('click', (e) => {
  if (accountMenuEl && !accountMenuEl.contains(e.target) && e.target !== $('sbUserBtn') && !$('sbUserBtn').contains(e.target)) closeAccountMenu();
});

$('togglePanelBtn').addEventListener('click', () => $('sidePanel').classList.toggle('hidden'));

// ─── Embedded browser panel (docked BrowserView the agent's browser_check drives) ─
document.querySelectorAll('.browser-toggle-btn').forEach((btn) =>
  btn.addEventListener('click', () => api && api.toggleBrowserPanel())
);
$('bcBack').addEventListener('click', () => api && api.browserPanelBack());
$('bcForward').addEventListener('click', () => api && api.browserPanelForward());
$('bcClose').addEventListener('click', () => api && api.toggleBrowserPanel());

// The reload icon itself spins while a reload is in flight — the click is
// otherwise silent (no loading indicator anywhere else in the chrome bar),
// so without this a slow page reload just looks like the button did nothing.
// Cleared on the next 'browserpanel:url' navigation event, not a fixed
// timeout, so it keeps spinning for exactly as long as the reload actually
// takes instead of guessing.
const bcReloadBtn = $('bcReload');
bcReloadBtn.addEventListener('click', () => {
  if (!api) return;
  bcReloadBtn.classList.add('spinning');
  api.browserPanelReload();
});

// A real address bar: type a URL, press Enter, it navigates — not just a
// read-only label showing whatever the agent's browser_check last opened.
const bcUrlInput = $('bcUrl');
let lastBrowserPanelUrl = '';
bcUrlInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const value = bcUrlInput.value.trim();
  if (value && api) api.browserPanelNavigate(value);
  bcUrlInput.blur();
});
// Editing the address bar shouldn't fight with the live URL updating out from
// under the user mid-type — only resynced on blur (abandoning the edit) or
// on an actual navigation event, never while it has focus.
bcUrlInput.addEventListener('blur', () => { bcUrlInput.value = lastBrowserPanelUrl; });

if (api) {
  api.onBrowserPanelState((data) => {
    document.querySelectorAll('.browser-toggle-btn').forEach((btn) => btn.classList.toggle('active', data.visible));
    document.documentElement.style.setProperty('--browser-panel-width', data.width + 'px');
    document.querySelector('.app').classList.toggle('browser-panel-open', data.visible);
    $('browserChrome').classList.toggle('hidden', !data.visible);
    $('bcBack').disabled = !data.canGoBack;
    $('bcForward').disabled = !data.canGoForward;
  });
  api.onBrowserPanelUrl((data) => {
    lastBrowserPanelUrl = data.url;
    bcReloadBtn.classList.remove('spinning');
    if (document.activeElement !== bcUrlInput) {
      bcUrlInput.value = data.url;
      bcUrlInput.title = data.url;
    }
  });
}
$('spProject').addEventListener('click', () => state.project && api.openPath(state.project));

// ─── Embedded terminal (real child process running the user's own shell) ────
let term = null;
let termFit = null;
let termStarted = false;

function ensureTerminal() {
  if (term) return;
  term = new Terminal({
    convertEol: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
    theme: { background: '#101012', foreground: '#e4e4e7', cursor: '#e4e4e7' },
    cursorBlink: true,
  });
  termFit = new FitAddon.FitAddon();
  term.loadAddon(termFit);
  term.open($('terminalBody'));
  // No real pty backs this (see main.js) — the child's stdin is a plain pipe,
  // so there's no line discipline on the other end to turn a raw backspace
  // byte into "erase the previous character". Line editing has to happen
  // here instead: buffer keystrokes locally, echo them ourselves, and only
  // flush a complete line to the process when Enter is pressed.
  let inputBuffer = '';
  term.onData((data) => {
    // A whole chunk starting with ESC is a control sequence (arrow keys,
    // home/end, etc.) — there's no cursor-within-line editing to apply it
    // to here, so drop it rather than let its raw bytes corrupt the buffer.
    if (data.length > 1 && data.charCodeAt(0) === 27) return;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') {
        term.write('\r\n');
        if (api) api.terminalInput(inputBuffer + '\n');
        inputBuffer = '';
      } else if (code === 127 || code === 8) { // Backspace (DEL or BS)
        if (inputBuffer.length) {
          inputBuffer = inputBuffer.slice(0, -1);
          term.write('\b \b');
        }
      } else if (code === 3) { // Ctrl+C
        term.write('^C\r\n');
        inputBuffer = '';
        if (api) api.terminalInput('\x03');
      } else if (code === 27) {
        // lone ESC with no following bytes yet — ignore
      } else if (code >= 32 || ch === '\t') {
        inputBuffer += ch;
        term.write(ch);
      }
    }
  });
  termFit.fit();
  window.addEventListener('resize', () => { if (!$('terminalPanel').classList.contains('hidden')) termFit.fit(); });

  if (api) {
    api.onTerminalData((data) => term.write(data));
    api.onTerminalExit(() => term.write('\r\n[process exited]\r\n'));
  }
}

async function openTerminal() {
  ensureTerminal();
  $('terminalPanel').classList.remove('hidden');
  document.querySelector('.app').classList.add('terminal-open');
  $('terminalToggleBtn').classList.add('active');
  requestAnimationFrame(() => termFit.fit());
  if (!termStarted && api) {
    termStarted = true;
    await api.terminalStart(state.project || null);
  }
}

function closeTerminal() {
  $('terminalPanel').classList.add('hidden');
  document.querySelector('.app').classList.remove('terminal-open');
  $('terminalToggleBtn').classList.remove('active');
}

$('terminalToggleBtn').addEventListener('click', () => {
  if ($('terminalPanel').classList.contains('hidden')) openTerminal();
  else closeTerminal();
});
$('termCloseBtn').addEventListener('click', closeTerminal);
$('termClearBtn').addEventListener('click', () => term && term.clear());

// ─── Sidebar lists ──────────────────────────────────────────────────────────
function renderProjects() {
  const holder = $('projectsList');
  holder.innerHTML = '';
  $('projectsSection').classList.toggle('hidden', state.projects.length === 0);
  for (const p of state.projects) {
    const name = p.split(/[\\/]/).filter(Boolean).pop();

    // Same row shape as a chat in Recents — the folder button fills the row
    // and a 3-dot button sits at its right edge, revealed on hover — so both
    // sidebar lists behave the same way instead of Projects being the one
    // list with no way to manage its own entries.
    const row = document.createElement('div');
    row.className = 'sb-project-row';

    const btn = document.createElement('button');
    btn.className = 'sb-project' + (p === state.project ? ' selected' : '');
    btn.title = p;
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg><span class="sb-project-name">${esc(name)}</span>`;
    btn.addEventListener('click', async () => {
      const r = await api.useProject(p);
      if (r) setProject(r.path, r.branch);
      showView('viewHome');
    });

    const menuBtn = document.createElement('button');
    menuBtn.className = 'sb-chat-menu-btn';
    menuBtn.title = 'More';
    menuBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openProjectMenu(p, menuBtn);
    });

    row.appendChild(btn);
    row.appendChild(menuBtn);
    holder.appendChild(row);
  }
}

function renderRecents() {
  const holder = $('recentsList');
  holder.innerHTML = '';
  $('recentsSection').classList.toggle('hidden', state.sessions.length === 0);
  for (const s of state.sessions) {
    const row = document.createElement('div');
    row.className = 'sb-chat-row';
    row.dataset.id = s.id;

    const btn = document.createElement('button');
    btn.className = 'sb-chat' + (s.id === state.currentSessionId ? ' selected' : '');
    btn.textContent = s.title;
    btn.title = s.title;
    btn.addEventListener('click', () => openSession(s.id));

    const menuBtn = document.createElement('button');
    menuBtn.className = 'sb-chat-menu-btn';
    menuBtn.title = 'More';
    menuBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openChatMenu(s, menuBtn);
    });

    row.appendChild(btn);
    row.appendChild(menuBtn);
    holder.appendChild(row);
  }
}

// ─── Per-chat context menu (3-dot: rename, delete) ───────────────────────────
let chatCtxMenuEl = null;
let chatCtxAnchorBtn = null;

function closeChatMenu() {
  if (chatCtxMenuEl) { chatCtxMenuEl.remove(); chatCtxMenuEl = null; }
  if (chatCtxAnchorBtn) { chatCtxAnchorBtn.classList.remove('active'); chatCtxAnchorBtn = null; }
}
document.addEventListener('click', (e) => {
  if (chatCtxMenuEl && !chatCtxMenuEl.contains(e.target)) closeChatMenu();
});

function openChatMenu(session, anchorBtn) {
  closeChatMenu();
  anchorBtn.classList.add('active');
  chatCtxAnchorBtn = anchorBtn;
  const menu = document.createElement('div');
  menu.className = 'chat-ctx-menu';
  menu.innerHTML = `
    <button data-action="rename"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>Rename</button>
    <button data-action="delete" class="danger"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg>Delete</button>`;
  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8) + 'px';

  menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
    closeChatMenu();
    startRenameSession(session);
  });
  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    closeChatMenu();
    deleteSessionById(session.id);
  });
  chatCtxMenuEl = menu;
}

function startRenameSession(session) {
  const row = document.querySelector(`.sb-chat-row[data-id="${session.id}"]`);
  if (!row) return;
  const btn = row.querySelector('.sb-chat');
  const input = document.createElement('input');
  input.className = 'sb-chat-rename-input';
  input.value = session.title;
  btn.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const newTitle = input.value.trim();
    if (save && newTitle && newTitle !== session.title) {
      session.title = newTitle;
      await api.renameSession(session.id, newTitle);
      if (session.id === state.currentSessionId) $('chatTitle').textContent = newTitle;
    }
    renderRecents();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteSessionById(id) {
  await api.deleteSession(id);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.currentSessionId === id) {
    state.currentSessionId = null;
    showView('viewHome');
  }
  renderRecents();
}

// ─── Per-project context menu (3-dot: reveal, remove) ────────────────────────
// Shares closeChatMenu()'s state and its document-level outside-click handler
// on purpose: only one of these menus should ever be open at a time, and
// opening a project's menu should dismiss a chat's, and vice versa.
function openProjectMenu(projectPath, anchorBtn) {
  closeChatMenu();
  anchorBtn.classList.add('active');
  chatCtxAnchorBtn = anchorBtn;
  const menu = document.createElement('div');
  menu.className = 'chat-ctx-menu';
  menu.innerHTML = `
    <button data-action="reveal"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Show in Explorer</button>
    <button data-action="remove" class="danger"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg>Remove from list</button>`;
  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8) + 'px';

  menu.querySelector('[data-action="reveal"]').addEventListener('click', () => {
    closeChatMenu();
    api.openPath(projectPath);
  });
  menu.querySelector('[data-action="remove"]').addEventListener('click', () => {
    closeChatMenu();
    removeProjectByPath(projectPath);
  });
  chatCtxMenuEl = menu;
}

/**
 * Forgets a folder — it leaves the sidebar, nothing on disk changes, and
 * opening it again re-adds it. No confirmation for exactly that reason: the
 * label says "Remove from list", and the undo is picking the folder again.
 *
 * Removing the folder that's currently in use also clears the selection and
 * returns Home, rather than leaving the header pointing at a project that is
 * no longer in the list. A run already in flight keeps the cwd it started
 * with — that was resolved when the turn began.
 */
async function removeProjectByPath(p) {
  await api.removeProject(p);
  state.projects = state.projects.filter((x) => x !== p);
  if (state.project === p) {
    setProject(null, null); // re-renders the list itself
    showView('viewHome');
  } else {
    renderProjects();
  }
}


// ─── Project selection ──────────────────────────────────────────────────────
function setProject(p, branch) {
  state.project = p;
  state.branch = branch || null;
  const name = p ? p.split(/[\\/]/).filter(Boolean).pop() : 'Choose folder';
  $('homeProjectName').textContent = name;
  document.querySelectorAll('[data-role="project-name"]').forEach((el) => (el.textContent = name));
  document.querySelectorAll('[data-role="branch-chip"]').forEach((el) => el.classList.toggle('hidden', !branch));
  document.querySelectorAll('[data-role="branch-name"]').forEach((el) => (el.textContent = branch || ''));
  renderProjects();
}

async function chooseProject() {
  const r = await api.chooseProject();
  if (r) {
    setProject(r.path, r.branch);
    if (!state.projects.includes(r.path)) state.projects.unshift(r.path);
    renderProjects();
  }
}

$('openProjectBtn').addEventListener('click', chooseProject);
$('homeProjectName').addEventListener('click', chooseProject);
document.querySelectorAll('[data-role="project-chip"]').forEach((el) => el.addEventListener('click', chooseProject));

// ─── Mode + bypass toggles (synced across both composers) ───────────────────
const MODES = ['Build', 'Plan', 'Ask'];

function syncMode() {
  document.querySelectorAll('[data-role="mode-name"]').forEach((el) => (el.textContent = state.mode));
}
document.querySelectorAll('[data-role="mode-chip"]').forEach((el) =>
  el.addEventListener('click', () => {
    state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
    syncMode();
  })
);

function syncBypass() {
  document.querySelectorAll('[data-role="bypass"]').forEach((el) => el.classList.toggle('on', state.bypass));
  document.querySelectorAll('[data-role="bypass-label"]').forEach((el) =>
    (el.textContent = state.bypass ? 'Bypass mode' : 'Approve manually'));
}
document.querySelectorAll('[data-role="bypass"]').forEach((el) =>
  el.addEventListener('click', () => {
    state.bypass = !state.bypass;
    syncBypass();
  })
);

// ─── Model picker ───────────────────────────────────────────────────────────
// A real dropdown (name + description + checkmark on the active one),
// opened above the trigger since it sits at the bottom of the window.
// Switching writes straight into ~/.codeply/config.json (shared with the
// CLI), so a pick made here is active there too, immediately.
let modelPresets = [];
let activeModelId = null;
let modelMenuEl = null;
let modelUserTier = 'free';
const TIER_RANK = { free: 0, plus: 1, pro: 2, max: 3 };

// Auto never names the model it actually routed to — it's the free-trial
// default, and which model is behind it is deliberately not part of the
// product surface. The bottom bar just reads "Auto".
function syncModelLabel() {
  const active = modelPresets.find((p) => p.id === activeModelId);
  const label = active ? active.label : 'Auto';
  document.querySelectorAll('[data-role="model-name"]').forEach((el) => (el.textContent = label));
}

function renderPlanBadge(tier) {
  const el = $('userPlanBadge');
  if (!el) return;
  const label = TIER_BADGE_LABEL[tier];
  el.textContent = label || '';
  el.classList.toggle('hidden', !label);
}

async function refreshModels() {
  if (!api) return;
  const r = await api.listModels();
  modelPresets = r.presets || [];
  activeModelId = r.active;
  modelUserTier = r.userTier || 'free';
  syncModelLabel();
  renderPlanBadge(modelUserTier);
}

function closeModelMenu() {
  if (modelMenuEl) { modelMenuEl.remove(); modelMenuEl = null; }
}
document.addEventListener('click', (e) => {
  if (modelMenuEl && !modelMenuEl.contains(e.target) && !e.target.closest('[data-role="model-picker"]')) closeModelMenu();
});

async function pickModel(id) {
  if (id === 'auto') {
    closeModelMenu();
    if (id !== activeModelId) {
      activeModelId = id;
      syncModelLabel();
      const r = await api.selectModel(id);
      if (r.ok) { activeModelId = r.active; state.providerLabel = r.providerLabel; }
      syncModelLabel();
    }
    return;
  }

  // The server tells us whether this account isn't eligible for this model
  // yet (send to the plan picker) or is eligible. Eligible ones select for
  // real in the UI (checkmark, bottom-bar label) — none of them are wired to
  // a real backend yet, so sendMessage() is where the "too many people are
  // using this" note actually shows, the same moment a live capacity limit
  // would surface it, not at pick-time.
  const r = await api.selectModel(id);
  if (r.locked) {
    closeModelMenu();
    showPlansPage();
    return;
  }
  closeModelMenu();
  activeModelId = id;
  syncModelLabel();
}

const TIER_BADGE_LABEL = { plus: 'Plus', pro: 'Pro', max: 'Max' };

function openModelMenu(anchorBtn) {
  closeModelMenu();
  const menu = document.createElement('div');
  menu.className = 'model-menu';
  menu.innerHTML =
    '<div class="model-menu-title">Models</div>' +
    modelPresets.map((p) => {
      const locked = p.tier && p.tier !== 'free' && TIER_RANK[modelUserTier] < TIER_RANK[p.tier];
      // Only the models this account isn't eligible for get a badge — once
      // you're on a plan that includes it, it should look like any other
      // available model, not still be tagged with the plan name.
      const badge = locked ? `<span class="model-menu-item-badge locked">${TIER_BADGE_LABEL[p.tier]}</span>` : '';
      return `
      <button class="model-menu-item" data-id="${esc(p.id)}">
        <div class="model-menu-item-row">
          <span class="model-menu-item-name">${esc(p.label)}</span>
          ${badge}
          ${p.id === activeModelId ? '<svg class="model-check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' : ''}
        </div>
      </button>`;
    }).join('');
  document.body.appendChild(menu);

  const rect = anchorBtn.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  menu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';

  menu.querySelectorAll('.model-menu-item').forEach((item) =>
    item.addEventListener('click', () => pickModel(item.dataset.id))
  );
  modelMenuEl = menu;
}

document.querySelectorAll('[data-role="model-picker"]').forEach((btn) =>
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (modelMenuEl) { closeModelMenu(); return; }
    // Re-pulled every open, not just at boot — a checkout completed earlier
    // in this same session should unlock models immediately, not only after
    // an app restart.
    await refreshModels();
    if (modelPresets.length) openModelMenu(btn);
  })
);

// ─── Sending / running ──────────────────────────────────────────────────────
let runningToolRow = null;

function setRunning(on) {
  state.running = on;
  document.querySelectorAll('[data-role="send"]').forEach((btn) => {
    btn.querySelector('.ic-send').classList.toggle('hidden', on);
    btn.querySelector('.ic-stop').classList.toggle('hidden', !on);
    btn.title = on ? 'Stop' : 'Send';
  });
}

// ─── Thinking indicator ─────────────────────────────────────────────────────
// Shown while the model is generating its next step: right after a message
// is sent, and again after each tool result while the agent decides what to
// do next. Hidden the moment anything visible lands (prose, a tool starting,
// an approval prompt) or the run ends.
let thinkingEl = null;
let thinkingTimer = null;
let thinkingStart = 0;

function showThinking() {
  if (thinkingEl) return;
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-row';
  thinkingEl.innerHTML = '<span class="spark">✦</span><span class="thinking-label">Thinking</span><span class="thinking-time">0s</span>';
  chatColumn.appendChild(thinkingEl);
  thinkingStart = Date.now();
  thinkingTimer = setInterval(() => {
    if (!thinkingEl) return;
    thinkingEl.querySelector('.thinking-time').textContent = Math.floor((Date.now() - thinkingStart) / 1000) + 's';
  }, 1000);
  if (nearBottom()) scrollToBottom();
}

function hideThinking() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

// A reasoning-capable model (Laguna, gpt-oss) hands back its chain-of-thought
// separately from its actual reply. The ephemeral "Thinking Xs" spinner above
// vanishes the instant something real arrives — useful while waiting, useless
// once the wait is over. This replaces that spinner with a permanent,
// collapsed "Thought for Xs" row in its place, so a long step (rate limits,
// several retries, a genuinely hard step) is explainable after the fact
// instead of just disappearing into "well, that took a while."
function addReasoningRow(text, ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const row = document.createElement('div');
  row.className = 'reasoning-row expandable';
  row.innerHTML =
    '<div class="reasoning-row-head">' +
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
    `<span class="reasoning-label">Thought for ${seconds}s</span>` +
    '<svg class="tool-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' +
    '</div>';
  const detail = document.createElement('pre');
  detail.className = 'reasoning-detail hidden';
  detail.textContent = text;
  row.appendChild(detail);
  row.querySelector('.reasoning-row-head').addEventListener('click', () => {
    detail.classList.toggle('hidden');
    row.classList.toggle('expanded');
  });
  if (thinkingEl) { thinkingEl.replaceWith(row); thinkingEl = null; if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; } }
  else chatColumn.appendChild(row);
  if (nearBottom()) scrollToBottom();
}

async function sendMessage(text, fromHome, images) {
  if (!api) return;
  if (!state.user) { showView('viewLogin'); return; }
  if (!state.project) { await chooseProject(); if (!state.project) return; }

  if (fromHome || !state.currentSessionId) {
    hideThinking();
    stopAllTypewriters();
    chatColumn.innerHTML = '';
    resetSidePanel(state.project);
    state.currentSessionId = null;
    $('chatTitle').textContent = text.length > 46 ? text.slice(0, 46) + '…' : text;
    showView('viewChat');
  }

  addUserMessage(text, images);

  // A named model (Claude Sonnet 5, etc.) is a real, selectable pin in the
  // picker, but none of them are wired to a real backend yet — the busy
  // note shows here, at send-time, instead of blocking the pick itself.
  const activePreset = modelPresets.find((p) => p.id === activeModelId);
  if (activePreset && !activePreset.auto) {
    addNote(`Too many people are using ${activePreset.label} right now. Please try again in a bit, or try Auto for uninterrupted use.`, 'error');
    return;
  }

  setRunning(true);
  showThinking();

  const r = await api.send({
    sessionId: state.currentSessionId,
    cwd: state.project,
    mode: state.mode,
    bypass: state.bypass,
    text,
    images,
    clientId: desktopClientId,
  });

  if (r.error) {
    setRunning(false);
    hideThinking();
    addNote(r.error, 'error');
    return;
  }
  if (!state.currentSessionId) {
    state.currentSessionId = r.sessionId;
    state.sessions.unshift({ id: r.sessionId, title: r.title, cwd: state.project, updatedAt: Date.now() });
    renderRecents();
  }
}

// Downscales/re-encodes a pasted image before it ever leaves the renderer —
// clipboard screenshots can be several MB and multi-thousand px; a vision
// model doesn't need more than ~1568px on the long edge, and shipping the
// original size would bloat both the IPC payload and the stored session
// history for no real gain.
const PASTE_IMAGE_MAX_DIM = 1568;
async function downscaleImageBlob(blob) {
  const rawDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = rawDataUrl;
  });
  let { width, height } = img;
  if (width > PASTE_IMAGE_MAX_DIM || height > PASTE_IMAGE_MAX_DIM) {
    const scale = PASTE_IMAGE_MAX_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

document.querySelectorAll('.composer').forEach((composer) => {
  const input = composer.querySelector('.composer-input');
  const sendBtn = composer.querySelector('[data-role="send"]');
  const fromHome = composer.dataset.composer === 'home';
  const previewsEl = composer.querySelector('[data-role="image-previews"]');
  composer.pendingImages = [];

  function renderImagePreviews() {
    previewsEl.innerHTML = '';
    previewsEl.classList.toggle('hidden', composer.pendingImages.length === 0);
    composer.pendingImages.forEach((src, i) => {
      const chip = document.createElement('div');
      chip.className = 'composer-image-preview';
      chip.innerHTML = `<img src="${src}" alt=""><button class="remove-img-btn" title="Remove image"><svg viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>`;
      chip.querySelector('.remove-img-btn').addEventListener('click', () => {
        composer.pendingImages.splice(i, 1);
        renderImagePreviews();
      });
      previewsEl.appendChild(chip);
    });
  }

  input.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/'));
    if (!items.length) return; // no image on the clipboard — let normal text paste happen
    e.preventDefault();
    for (const item of items) {
      const blob = item.getAsFile();
      if (!blob) continue;
      try { composer.pendingImages.push(await downscaleImageBlob(blob)); } catch {}
    }
    renderImagePreviews();
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  });

  // A second layer on top of the addUserMessage dedupe above: blocks a
  // same-composer double-dispatch (key-repeat, a fast double-click before the
  // button visually updates) synchronously, at the moment of the click itself
  // — before state.running has had any chance to propagate — rather than
  // relying solely on catching the resulting duplicate after the fact.
  let dispatching = false;
  const submit = () => {
    if (dispatching) return;
    if (state.running) { api.stop(state.currentSessionId); return; }
    const text = input.value.trim();
    const images = composer.pendingImages;
    if (!text && !images.length) return;
    dispatching = true;
    setTimeout(() => { dispatching = false; }, 0);
    input.value = '';
    input.style.height = 'auto';
    composer.pendingImages = [];
    renderImagePreviews();
    sendMessage(text || 'Image attached.', fromHome, images.length ? images : undefined);
  };

  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // The slash-command menu (wired up further below, same input) owns
      // Enter while it's open — picking a command, not sending "/" as text.
      if (composer.slashMenuOpen && composer.slashMenuOpen()) return;
      e.preventDefault();
      submit();
    }
  });
});

document.querySelectorAll('.suggestion-card').forEach((card) =>
  card.addEventListener('click', () => {
    const input = document.querySelector('[data-composer="home"] .composer-input');
    input.value = card.dataset.suggest;
    input.focus();
  })
);

// ─── Approval cards ─────────────────────────────────────────────────────────
function addApprovalCard(ev) {
  const card = document.createElement('div');
  card.className = 'approval-card' + (ev.danger ? ' danger' : '');
  card.dataset.requestId = ev.requestId;
  let diffHtml = '';
  if (ev.diff) {
    diffHtml = `<div class="approval-diff"><pre class="diff-del">${esc(ev.diff.search)}</pre><pre class="diff-add">${esc(ev.diff.replace)}</pre></div>`;
  }
  card.innerHTML = `
    <div class="approval-head">
      <svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5Z"/></svg>
      <span class="approval-title">${esc(ev.title)}</span>
      ${ev.danger ? '<span class="approval-danger">outside project / risky</span>' : ''}
    </div>
    ${ev.detail ? `<div class="approval-detail">${esc(ev.detail)}</div>` : ''}
    ${diffHtml}
    <div class="approval-actions">
      <button class="appr-btn accept" data-v="once">Accept</button>
      <button class="appr-btn" data-v="always">Always allow ${esc(toolName(ev.tool))} in this chat</button>
      <button class="appr-btn reject" data-v="reject">Reject</button>
    </div>`;
  card.querySelectorAll('.appr-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      api.respondApproval(ev.requestId, btn.dataset.v);
      const verdictText = btn.dataset.v === 'reject' ? 'Rejected' : btn.dataset.v === 'always' ? `Accepted, always allowing ${toolName(ev.tool)} for the rest of this chat` : 'Accepted';
      card.outerHTML = `<div class="chat-note ${btn.dataset.v === 'reject' ? 'error' : 'ok'}">${esc(ev.title)}: ${verdictText}</div>`;
    })
  );
  chatColumn.appendChild(card);
  scrollToBottom();
}

// ─── Image picker ───────────────────────────────────────────────────────────
// Fires whenever the agent wants to fetch_image and isn't running unattended
// (bypass / always-allow already skip straight past this in main.js). Shows
// what it would have auto-picked plus a live search the user can refine, and
// clicking a photo swaps it in for the download.
function addImagePickerCard(ev) {
  const card = document.createElement('div');
  card.className = 'image-picker-card';
  card.innerHTML = `
    <div class="approval-head">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 15l5-4 4 3 4-4 5 5"/></svg>
      <span class="approval-title">Choose an image</span>
      ${ev.danger ? '<span class="approval-danger">outside project / risky</span>' : ''}
    </div>
    <div class="approval-detail">for ${esc(ev.path || 'this file')}</div>
    <div class="img-search-row">
      <input class="img-search-input" type="text" value="${esc(ev.keywords || '')}" placeholder="Search photos…">
      <button class="img-search-btn">Search</button>
    </div>
    <div class="img-grid"><div class="img-grid-status">Searching…</div></div>
    <div class="approval-actions">
      <button class="appr-btn" data-v="skip">Skip, use Codeply's pick</button>
      <button class="appr-btn reject" data-v="cancel">Cancel, no image</button>
    </div>`;

  const grid = card.querySelector('.img-grid');
  const input = card.querySelector('.img-search-input');
  const searchBtn = card.querySelector('.img-search-btn');

  const finish = (chosenUrl, note) => {
    api.respondImagePick(ev.requestId, chosenUrl);
    card.outerHTML = `<div class="chat-note ${chosenUrl ? 'ok' : 'error'}">${esc(note)}</div>`;
  };

  function renderTile(img, label) {
    const tile = document.createElement('button');
    tile.className = 'img-tile';
    tile.innerHTML = `
      <img src="${esc(img.thumbnail)}" alt="${esc(img.title || '')}" loading="lazy">
      <span class="img-tile-credit">${esc(label || img.creator || img.source || '')}</span>`;
    tile.addEventListener('click', () => finish(img.full, `Picked an image for ${ev.path || 'this file'}`));
    return tile;
  }

  function renderGrid(results) {
    grid.innerHTML = '';
    grid.appendChild(renderTile({ thumbnail: ev.url, full: ev.url, title: 'Suggested' }, "Codeply's pick"));
    if (!results.length) {
      const msg = document.createElement('div');
      msg.className = 'img-grid-status';
      msg.textContent = 'No other results. Try different words.';
      grid.appendChild(msg);
      return;
    }
    for (const img of results) grid.appendChild(renderTile(img));
  }

  async function runSearch(query) {
    grid.innerHTML = '<div class="img-grid-status">Searching…</div>';
    const r = await api.searchImages(query);
    if (!r.ok) {
      grid.innerHTML = `<div class="img-grid-status">Search failed: ${esc(r.error || 'unknown error')}</div>`;
      return;
    }
    renderGrid(r.results);
  }

  searchBtn.addEventListener('click', () => runSearch(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(input.value.trim()); }
  });

  card.querySelectorAll('.appr-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.dataset.v === 'skip') finish(ev.url, `Used Codeply's pick for ${ev.path || 'this file'}`);
      else finish(null, `Skipped the image for ${ev.path || 'this file'}`);
    })
  );

  chatColumn.appendChild(card);
  scrollToBottom();
  runSearch(ev.keywords || '');
}

// ─── Agent event stream ─────────────────────────────────────────────────────
if (api) api.onAgentEvent((data) => {
  const mine = data.sessionId === state.currentSessionId;
  const meta = state.sessions.find((s) => s.id === data.sessionId);
  if (meta) meta.updatedAt = Date.now();

  // Fired for every send, from this window or a paired phone — previously
  // only reached mobile clients over SSE, so a message sent from the phone
  // never showed up here until you reopened the chat. This window's own
  // sends already render optimistically (see sendMessage above), so only
  // react when the message came from elsewhere.
  if (data.type === 'session_sync') {
    if (mine && data.message?.kind === 'user' && data.origin && data.origin !== desktopClientId) {
      addUserMessage(data.message.text, data.message.images);
    }
    return;
  }

  if (!mine) return;

  switch (data.type) {
    case 'helper_note':
      // A helper call finishing before the writer's own turn starts —
      // "◈ Codeply Design planned the design" — shown the same way a tool row
      // is, so it's clear something happened without pretending the writer
      // wrote it. Thinking stays visible after this: the writer's own turn is
      // still to come.
      addNote(`◈ ${data.label} ${data.why}`, data.failed ? 'error' : '');
      break;
    case 'reasoning':
      addReasoningRow(data.text, data.ms);
      break;
    case 'text':
      hideThinking();
      addAssistantMessage(data.text);
      break;
    case 'tool_start':
      hideThinking();
      runningToolRow = addToolRow({
        name: data.name,
        label: toolArgsLabel(data.args),
        running: true,
      });
      break;
    case 'tool_end': {
      if (runningToolRow) { runningToolRow.remove(); runningToolRow = null; }
      addToolRow({ name: data.name, label: data.summary || toolArgsLabel(data.args), ok: data.ok, args: data.args });
      panelTrack(data.name, data.args?.path || data.summary);
      // The agent calls the model again to decide the next step.
      showThinking();
      break;
    }
    case 'tasklist':
      hideThinking();
      addTaskList(data.tasks);
      break;
    case 'task_start':
      updateTaskStatus(data.id, 'in_progress');
      break;
    case 'task_end':
      updateTaskStatus(data.id, data.status);
      break;
    case 'approval_request':
      hideThinking();
      addApprovalCard(data);
      break;
    case 'image_pick_request':
      hideThinking();
      addImagePickerCard(data);
      break;
    case 'approval_resolved': {
      // The request was answered from another device (e.g. the phone) —
      // this window's own click handler already retires its own card
      // locally, so this only ever fires for a card THIS window didn't
      // answer, which otherwise had nothing to ever remove it.
      const card = chatColumn.querySelector(`.approval-card[data-request-id="${data.requestId}"]`);
      if (card) {
        const verdictText = data.verdict === 'reject' ? 'Rejected' : data.verdict === 'always' ? 'Accepted, always allowed' : 'Accepted';
        card.outerHTML = `<div class="chat-note ${data.verdict === 'reject' ? 'error' : 'ok'}">${verdictText} on another device</div>`;
      }
      break;
    }
    case 'approval_auto':
      addNote(`${data.title}: ${data.bypass ? 'bypass mode, ran without asking' : 'auto approved'}`, 'ok');
      break;
    case 'error':
      hideThinking();
      addNote(data.error, 'error');
      break;
    case 'trial_limit_reached':
      hideThinking();
      setRunning(false);
      showLockedPage(data.message);
      break;
    case 'aborted':
      hideThinking();
      addNote('Stopped.', '');
      break;
    case 'run_finished':
      hideThinking();
      if (runningToolRow) { runningToolRow.remove(); runningToolRow = null; }
      activeTaskList = null;
      setRunning(false);
      renderRecents();
      break;
    case 'usage_update':
      renderUsage(data.usage);
      break;
  }
});

// ─── Open an existing session ───────────────────────────────────────────────
async function openSession(id) {
  if (!state.user) { showView('viewLogin'); return; }
  const s = await api.getSession(id);
  if (!s) return;
  state.currentSessionId = id;
  if (s.cwd) {
    const r = await api.useProject(s.cwd);
    if (r) setProject(r.path, r.branch);
  }
  $('chatTitle').textContent = s.title;
  hideThinking();
  stopAllTypewriters();
  chatColumn.innerHTML = '';
  resetSidePanel(s.cwd);
  currentTasks = [];
  for (const m of s.messages) {
    if (m.kind === 'user') addUserMessage(m.text, m.images);
    else if (m.kind === 'assistant') addAssistantMessage(m.text, { animate: false });
    else if (m.kind === 'reasoning') addReasoningRow(m.text, m.ms);
    else if (m.kind === 'tool') {
      addToolRow({ name: m.name, label: m.label, ok: m.ok, args: m.args });
      panelTrack(m.name, m.label);
    } else if (m.kind === 'tasklist') {
      addTaskList(m.tasks);
    }
  }
  activeTaskList = null; // reopening a past chat is read-only history, not a live run — no further task_start/task_end will arrive for it
  refreshTasksUI();
  renderRecents();
  showView('viewChat');
  scrollToBottom();
}

$('deleteChatBtn').addEventListener('click', () => {
  if (state.currentSessionId) deleteSessionById(state.currentSessionId);
});

$('newChatBtn').addEventListener('click', () => {
  state.currentSessionId = null;
  activeTaskList = null;
  currentTasks = [];
  refreshTasksUI();
  showView('viewHome');
  document.querySelector('[data-composer="home"] .composer-input').focus();
});

// ─── Chat scroll button ─────────────────────────────────────────────────────
const scrollDownBtn = $('scrollDown');
chatScroll.addEventListener('scroll', () => scrollDownBtn.classList.toggle('hidden', nearBottom()));
scrollDownBtn.addEventListener('click', () => chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: 'smooth' }));

// ─── Login (sign in / sign up / OTP) ────────────────────────────────────────
// Mirrors the Codeply desktop app's flow exactly: email+password validates
// first, then a 6-digit emailed code finishes it — same Supabase project,
// same account, so a login here is a login everywhere.
state.pendingMode = 'login'; // 'login' | 'signup' — which OTP verification type to use

function showLoginError(msg) {
  const el = $('loginError');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

document.querySelectorAll('.auth-tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('stepSignin').classList.toggle('hidden', tab.dataset.tab !== 'signin');
    $('stepSignup').classList.toggle('hidden', tab.dataset.tab !== 'signup');
    $('stepOtp').classList.add('hidden');
    showLoginError('');
  })
);

// Plans screen is shown once per account per device (localStorage, not a DB
// column — no schema change needed for this). Returning users who already
// completed onboarding on this machine go straight to viewHome on login.
function plansSeenKey(email) { return `codeply_seen_plans_${email}`; }
function maybeShowPlansThenHome(email) {
  if (localStorage.getItem(plansSeenKey(email))) return showView('viewHome');
  localStorage.setItem(plansSeenKey(email), '1');
  showPlansPage();
}

async function afterVerified(email, onboarding) {
  state.user = { email };
  renderUser();
  await refreshUsage();
  // Chat history is per-account in Supabase, not this device — pull this
  // account's own history now rather than leaving whatever a previous
  // account's session left in state (app:init only runs once at boot).
  state.sessions = await api.refreshSessions();
  renderRecents();
  await refreshModels(); // also updates the plan badge next to the account name
  if (onboarding && !onboarding.referral_source) return showReferralPage();
  if (onboarding && !onboarding.country) return showCountryPage();
  maybeShowPlansThenHome(email);
}

// Google sign-in: opens the system browser, then the OS hands the resulting
// codeply:// deep link back to main.js, which pushes the outcome here —
// same afterVerified() finish line as email OTP.
const googleBtnHTML = $('googleBtn').innerHTML;
$('googleBtn').addEventListener('click', async () => {
  showLoginError('');
  $('googleBtn').disabled = true;
  const r = await api.signInGoogle();
  if (!r.ok) {
    $('googleBtn').disabled = false;
    return showLoginError(r.error);
  }
  $('googleBtn').innerHTML = 'Continue in your browser…';
});
if (api) api.onAuthCallback((data) => {
  $('googleBtn').disabled = false;
  $('googleBtn').innerHTML = googleBtnHTML;
  if (!data.ok) return showLoginError(data.error);
  showLoginError('');
  afterVerified(data.email, data.onboarding);
});

function showOtpStep(email, mode) {
  state.pendingEmail = email;
  state.pendingMode = mode;
  $('stepSignin').classList.add('hidden');
  $('stepSignup').classList.add('hidden');
  $('stepOtp').classList.remove('hidden');
  $('otpSentTo').textContent = `We emailed a 6-digit code to ${email}.`;
  $('otpCode').value = '';
  $('otpCode').focus();
}

$('signinBtn').addEventListener('click', async () => {
  const email = $('signinEmail').value.trim();
  const password = $('signinPassword').value;
  if (!email || !password) return showLoginError('Enter your email and password.');
  $('signinBtn').disabled = true;
  showLoginError('');
  const r = await api.signInEmail(email, password);
  $('signinBtn').disabled = false;
  if (!r.ok) return showLoginError(r.error);
  showOtpStep(email, 'login');
});

$('signupBtn').addEventListener('click', async () => {
  const name = $('signupName').value.trim();
  const email = $('signupEmail').value.trim();
  const password = $('signupPassword').value;
  if (!email || !password) return showLoginError('Enter your email and password.');
  if (password.length < 6) return showLoginError('Password must be at least 6 characters.');
  $('signupBtn').disabled = true;
  showLoginError('');
  const r = await api.signUpEmail(email, password, name);
  $('signupBtn').disabled = false;
  if (!r.ok) return showLoginError(r.error);
  showOtpStep(email, r.mode);
});

$('verifyOtpBtn').addEventListener('click', async () => {
  const code = $('otpCode').value.trim();
  if (code.length < 6) return showLoginError('Enter the 6-digit code from your email.');
  $('verifyOtpBtn').disabled = true;
  showLoginError('');
  const r = await api.verifyOtp(state.pendingEmail, code, state.pendingMode);
  $('verifyOtpBtn').disabled = false;
  if (!r.ok) return showLoginError(r.error);
  afterVerified(r.email, r.onboarding);
});

$('resendOtpBtn').addEventListener('click', async () => {
  showLoginError('');
  const r = await api.resendOtp(state.pendingEmail, state.pendingMode);
  showLoginError(r.ok ? '' : r.error);
});

$('backFromOtpBtn').addEventListener('click', () => {
  $('stepOtp').classList.add('hidden');
  $(state.pendingMode === 'signup' ? 'stepSignup' : 'stepSignin').classList.remove('hidden');
  showLoginError('');
});

$('signinEmail').addEventListener('keydown', (e) => e.key === 'Enter' && $('signinBtn').click());
$('signinPassword').addEventListener('keydown', (e) => e.key === 'Enter' && $('signinBtn').click());
$('signupPassword').addEventListener('keydown', (e) => e.key === 'Enter' && $('signupBtn').click());
$('otpCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('verifyOtpBtn').click());

// Sign out itself now lives in the account menu (see openAccountMenu above) —
// this button used to carry it directly; the menu's logout item replaced it.

function renderUser() {
  const name = state.user ? state.user.email : 'Not signed in';
  $('userName').textContent = name;
  $('userName').title = name;
  $('userAvatar').textContent = state.user ? state.user.email.slice(0, 2).toUpperCase() : '·';
}

// ─── Onboarding survey: referral source + country ───────────────────────────
// Same `profiles` row and same gating (checked per-account, not just locally)
// as the desktop app — a second account on this machine still gets asked.
let referralSelected = null;

function showReferralPage() {
  referralSelected = null;
  document.querySelectorAll('.referral-opt').forEach((b) => b.classList.remove('selected'));
  $('referralOtherWrap').classList.add('hidden');
  $('referralOtherInput').value = '';
  $('referralContinueBtn').disabled = true;
  showView('viewReferral');
}

document.querySelectorAll('#referralOptions .referral-opt').forEach((btn) =>
  btn.addEventListener('click', () => {
    referralSelected = btn.dataset.value;
    document.querySelectorAll('.referral-opt').forEach((b) => b.classList.toggle('selected', b === btn));
    $('referralOtherWrap').classList.toggle('hidden', referralSelected !== 'Other');
    if (referralSelected === 'Other') $('referralOtherInput').focus();
    $('referralContinueBtn').disabled = referralSelected === 'Other' ? !$('referralOtherInput').value.trim() : false;
  })
);
$('referralOtherInput').addEventListener('input', () => {
  if (referralSelected === 'Other') $('referralContinueBtn').disabled = !$('referralOtherInput').value.trim();
});

$('referralContinueBtn').addEventListener('click', async () => {
  const value = referralSelected === 'Other' ? $('referralOtherInput').value.trim() : referralSelected;
  if (!value) return;
  $('referralContinueBtn').disabled = true;
  await api.saveOnboarding(value, null);
  const profile = await api.getProfile();
  if (!profile?.country) showCountryPage();
  else maybeShowPlansThenHome(state.user?.email);
});

const COUNTRIES = [
  'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria',
  'Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia',
  'Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia',
  'Cameroon','Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo (Congo-Brazzaville)',
  'Costa Rica','Croatia','Cuba','Cyprus','Czechia','Denmark','Djibouti','Dominica','Dominican Republic','DR Congo',
  'Ecuador','Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland',
  'France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau',
  'Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy',
  'Ivory Coast','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo','Kuwait','Kyrgyzstan','Laos',
  'Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg','Madagascar','Malawi',
  'Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius','Mexico','Micronesia','Moldova',
  'Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nauru','Nepal','Netherlands',
  'New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway','Oman','Pakistan','Palau',
  'Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Qatar','Romania',
  'Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Samoa','San Marino',
  'Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia',
  'Slovenia','Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan',
  'Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo',
  'Tonga','Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates',
  'United Kingdom','United States','Uruguay','Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen',
  'Zambia','Zimbabwe',
];
(function populateCountrySelect() {
  const select = $('countrySelect');
  for (const c of COUNTRIES) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  }
})();

function showCountryPage() {
  $('countrySelect').value = '';
  $('countryContinueBtn').disabled = true;
  showView('viewCountry');
}

$('countrySelect').addEventListener('change', () => {
  $('countryContinueBtn').disabled = !$('countrySelect').value;
});

$('countryContinueBtn').addEventListener('click', async () => {
  const value = $('countrySelect').value;
  if (!value) return;
  $('countryContinueBtn').disabled = true;
  await api.saveOnboarding(null, value);
  maybeShowPlansThenHome(state.user?.email);
});

// ─── Plan picker / locked screen ─────────────────────────────────────────────
// Card copy follows the paywalls skill's playbook (~/.agents/skills/paywalls):
// benefit checklist over a bare feature dump, a "Most popular" badge on the
// plan we actually want chosen, and price-per-day framing so $50/mo doesn't
// read as a wall of a number.
// Only the paid tiers get a card — the free trial is the single "Continue
// with free trial" button below the cards instead (see showPlansPage), and
// deliberately makes no model promise there since which models the trial
// gets is an implementation detail, not a sales point.
const PLAN_ORDER = ['plus', 'pro', 'max'];
const PLAN_PRICE = { free: 0, plus: 20, pro: 50, max: 100 };
const PLAN_TAGLINE = {
  free: 'Try it out',
  plus: 'For everyday use',
  pro: 'For daily heavy use',
  max: 'Every model, highest limits',
};
const MOST_POPULAR_TIER = 'pro';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
// One glyph per tier instead of a generic stick figure — bolt (Plus, quick/
// everyday), star (Pro, the popular pick), crown (Max, top tier).
const PLAN_ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>',
  pro: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6.1 6.6.7-4.9 4.5 1.4 6.6L12 17l-5.9 3.4 1.4-6.6-4.9-4.5 6.6-.7Z"/></svg>',
  max: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4.5 3L12 4l4.5 7L21 8l-2 10H5Z"/></svg>',
};

function planCardHTML(id, tier, currentTier, tiers) {
  const isCurrent = id === currentTier;
  const isPopular = id === MOST_POPULAR_TIER && !isCurrent;
  const price = PLAN_PRICE[id];
  const priceLabel = price === 0 ? 'Free' : `$${price}<span>/mo</span>`;
  const btnLabel = isCurrent ? 'Current plan' : `Get ${tier.label} plan`;
  const btnAttrs = isCurrent ? 'disabled' : `data-checkout-tier="${id}"`;
  const btnNote = isCurrent ? '' : '<div class="plan-card-btn-note">No commitment · Cancel anytime</div>';
  // Each tier above the base one reads as "everything in the tier below,
  // plus the new thing" instead of repeating the full model list every
  // time — the new addition is the actual reason to upgrade, so it should
  // be the second line, not buried in a re-stated list. Names the one new
  // model each tier unlocks (verified real names, see subscription.js) —
  // one name at a time, not the full comma-dump list.
  const prevId = PLAN_ORDER[PLAN_ORDER.indexOf(id) - 1];
  const prevTier = prevId ? tiers[prevId] : null;
  const newModels = prevTier ? tier.models.filter((m) => !prevTier.models.includes(m)) : tier.models;
  const usageLine = { plus: 'Solid daily usage', pro: 'Higher daily usage', max: 'Highest daily usage' }[id];
  const benefits = prevTier
    ? [
        `Everything in ${prevTier.label}`,
        ...(newModels.length ? [`${newModels.join(' + ')} unlocked`] : []),
        usageLine,
      ]
    : [
        newModels.join(' + '),
        'Great for everyday tasks',
        usageLine,
      ];
  return `
    <div class="plan-card${isCurrent ? ' current' : ''}${isPopular ? ' popular' : ''}">
      ${isCurrent ? '<span class="plan-card-badge">Current plan</span>' : ''}
      ${isPopular ? '<span class="plan-card-badge popular">Most popular</span>' : ''}
      <div class="plan-card-icon plan-card-icon-${id}">${PLAN_ICON[id] || ''}</div>
      <div class="plan-card-name">${tier.label}</div>
      <div class="plan-card-tagline">${PLAN_TAGLINE[id] || ''}</div>
      <div class="plan-card-price">${priceLabel}</div>
      <button class="plan-card-btn${isPopular ? ' popular' : ''}" ${btnAttrs}>${btnLabel}</button>
      ${btnNote}
      <div class="plan-card-divider"></div>
      <div class="plan-card-benefits-head">What you get:</div>
      <ul class="plan-card-benefits">
        ${benefits.map((b) => `<li>${CHECK_SVG}<span>${b}</span></li>`).join('')}
      </ul>
    </div>`;
}

async function renderPlanCards(containerId) {
  const [tiers, sub] = await Promise.all([api.getTiers(), api.getSubscription()]);
  const currentTier = sub?.tier || 'free';
  const container = $(containerId);
  container.innerHTML = PLAN_ORDER
    .filter((id) => tiers[id])
    .map((id) => planCardHTML(id, tiers[id], currentTier, tiers))
    .join('');
  container.querySelectorAll('[data-checkout-tier]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tier = btn.dataset.checkoutTier;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Opening…';
      const r = await api.openCheckout(tier);
      btn.disabled = false;
      btn.textContent = r?.ok ? label : (r?.error || 'Something went wrong');
    });
  });
  return currentTier;
}

async function showPlansPage() {
  showView('viewPlans');
  await renderPlanCards('plansCards');
}

$('plansContinueBtn').addEventListener('click', () => showView(state.currentSessionId ? 'viewChat' : 'viewHome'));

async function showLockedPage(message) {
  if (message) $('lockedMessage').textContent = message;
  showView('viewLocked');
  await renderPlanCards('lockedCards');
}

$('lockedBackBtn').addEventListener('click', () => showView(state.currentSessionId ? 'viewChat' : 'viewHome'));

// ─── Usage (shared 100/day apply cap — CLI, desktop app, and this app all
// write to and read the same Supabase bucket) ────────────────────────────────
function renderUsage(usage) {
  $('usageCard').classList.toggle('hidden', !usage);
  if (!usage) return;
  const pct = Math.min(100, (usage.count / usage.limit) * 100);
  $('usageCount').textContent = `${usage.count} / ${usage.limit}`;
  $('usageFill').style.width = pct + '%';
  $('usageFill').style.background = pct >= 100 ? '#e5624d' : pct >= 80 ? '#e2c26a' : 'var(--accent-purple)';
}
async function refreshUsage() {
  if (!api || state.provider !== 'codeply') return;
  renderUsage(await api.getUsage());
}

// ─── Skills browser (/skills) ────────────────────────────────────────────────
let allSkills = [];
let skillsTargetInput = null; // which composer input to insert the pick into

async function openSkillsModal(inputEl) {
  skillsTargetInput = inputEl;
  $('skillsBackdrop').classList.remove('hidden');
  $('skillsSearch').value = '';
  $('skillsSearch').focus();
  if (!allSkills.length) allSkills = await api.listSkills();
  renderSkillsList(allSkills);
}
function closeSkillsModal() {
  $('skillsBackdrop').classList.add('hidden');
}

// ─── Phone companion pairing ───────────────────────────────────────────────
// The desktop is the trust anchor: the LAN address and one-time pairing code
// are deliberately revealed here rather than embedded in a shareable link.
async function openRemoteModal() {
  $('remoteBackdrop').classList.remove('hidden');
  $('remoteUrl').textContent = 'Starting local connection…';
  $('remoteCode').textContent = '••••••••••';
  $('remoteQr').innerHTML = '<div class="remote-qr-loading">Generating…</div>';
  const info = await api.remoteInfo();
  $('remoteUrl').textContent = info.url;
  $('remoteCode').textContent = info.code;
  // The SVG is markup Craft generated itself (see remoteInfo() in main.js),
  // never anything from the network, so this innerHTML assignment isn't
  // rendering untrusted content.
  if (info.qr) $('remoteQr').innerHTML = info.qr;
}
function closeRemoteModal() { $('remoteBackdrop').classList.add('hidden'); }
api.onRemoteServerError((data) => {
  if (!$('remoteBackdrop').classList.contains('hidden')) {
    $('remoteUrl').textContent = data.message || 'The phone companion server failed to start.';
    $('remoteCode').textContent = '';
    $('remoteQr').innerHTML = '';
  }
});
$('remoteControlBtn').addEventListener('click', openRemoteModal);
$('remoteCloseBtn').addEventListener('click', closeRemoteModal);
$('remoteBackdrop').addEventListener('click', (e) => { if (e.target === $('remoteBackdrop')) closeRemoteModal(); });
$('skillsCloseBtn').addEventListener('click', closeSkillsModal);
$('skillsBackdrop').addEventListener('click', (e) => { if (e.target === $('skillsBackdrop')) closeSkillsModal(); });

function renderSkillsList(list) {
  const holder = $('skillsGroups');
  holder.innerHTML = '';
  if (!list.length) {
    holder.innerHTML = '<div class="skills-empty">No skills match that search.</div>';
    return;
  }
  const daily = list.filter((s) => s.daily);
  const rest = list.filter((s) => !s.daily);
  const group = (title, skills) => {
    if (!skills.length) return;
    const h = document.createElement('div');
    h.className = 'skills-group-title';
    h.textContent = title;
    holder.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'skills-grid';
    for (const s of skills) {
      const card = document.createElement('button');
      card.className = 'skill-card';
      card.innerHTML = `<div class="skill-card-name">${esc(s.name)}</div><div class="skill-card-desc">${esc(s.description)}</div>`;
      card.addEventListener('click', () => pickSkill(s));
      grid.appendChild(card);
    }
    holder.appendChild(grid);
  };
  group(`Featured (${daily.length})`, daily);
  group(`All skills (${rest.length})`, rest);
}

function pickSkill(skill) {
  closeSkillsModal();
  const input = skillsTargetInput || document.querySelector('[data-composer="home"] .composer-input');
  input.value = `Use the "${skill.name}" skill to `;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

$('skillsSearch').addEventListener('input', () => {
  const q = $('skillsSearch').value.trim().toLowerCase();
  if (!q) return renderSkillsList(allSkills);
  renderSkillsList(allSkills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
});

// ─── Slash commands ("/" in the composer) ────────────────────────────────────
const SLASH_COMMANDS = [
  { name: '/skills', aliases: ['/skill-list', '/skill'], desc: 'Browse and search the skill library', run: (input) => openSkillsModal(input) },
];

document.querySelectorAll('.composer').forEach((composer) => {
  const input = composer.querySelector('.composer-input');
  let menu = null;
  let activeIndex = 0;

  // Read by the send/submit handler (registered earlier, on the same input)
  // so Enter doesn't both pick a slash command AND send "/" as a message.
  composer.slashMenuOpen = () => !!menu;

  function matches() {
    const v = input.value.toLowerCase();
    if (!v.startsWith('/')) return [];
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(v) || c.aliases.some((a) => a.startsWith(v)));
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  function openMenu(list) {
    closeMenu();
    activeIndex = 0;
    menu = document.createElement('div');
    menu.className = 'slash-menu';
    list.forEach((cmd, i) => {
      const item = document.createElement('button');
      item.className = 'slash-item' + (i === 0 ? ' active' : '');
      item.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.6L20 10.8l-5.8 2.2L12 19l-2.2-6L4 10.8l5.8-2.2Z"/></svg><strong>${esc(cmd.name)}</strong><span class="slash-desc">${esc(cmd.desc)}</span>`;
      item.addEventListener('click', () => { closeMenu(); input.value = ''; cmd.run(input); });
      menu.appendChild(item);
    });
    composer.style.position = 'relative';
    composer.appendChild(menu);
  }

  input.addEventListener('input', () => {
    const list = matches();
    if (list.length) openMenu(list); else closeMenu();
  });

  input.addEventListener('keydown', (e) => {
    if (!menu) return;
    const items = [...menu.querySelectorAll('.slash-item')];
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = (activeIndex + 1) % items.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = (activeIndex - 1 + items.length) % items.length; }
    else if (e.key === 'Enter') { e.preventDefault(); items[activeIndex].click(); return; }
    else if (e.key === 'Escape') { closeMenu(); return; }
    else return;
    items.forEach((it, i) => it.classList.toggle('active', i === activeIndex));
  });

  input.addEventListener('blur', () => setTimeout(closeMenu, 150));
});

// ─── Boot ───────────────────────────────────────────────────────────────────
(async function boot() {
  if (!api){
    $('engineErrorText').textContent = 'Codeply Craft must run inside Electron: npm install && npm start';
    showView('viewEngineError');
    return;
  }
  const init = await api.init();
  if (!init.engineOk) {
    $('engineErrorText').textContent = init.engineError;
    showView('viewEngineError');
    return;
  }
  state.user = init.user;
  state.provider = init.provider;
  state.providerLabel = init.providerLabel;
  state.sessions = init.sessions;
  state.projects = init.projects;
  renderUser();
  renderUsage(init.usage);
  renderRecents();
  renderProjects();
  syncMode();
  syncBypass();
  refreshModels();
  if (init.lastProject) setProject(init.lastProject, init.lastProjectBranch);
  else setProject(null, null);

  if (init.needsLogin) { showView('viewLogin'); return; }
  if (init.needsOnboarding) {
    if (!init.onboarding?.referral_source) { showReferralPage(); return; }
    if (!init.onboarding?.country) { showCountryPage(); return; }
  }
  showView('viewHome');
})();
