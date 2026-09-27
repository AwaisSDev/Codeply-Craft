const $ = (id) => document.getElementById(id);
const isHosted = location.protocol.startsWith('http') && location.port === '45671';

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost); this
// page is served over plain http://<lan-ip>:45671, which Chrome/Safari treat
// as insecure, so it must not be a hard dependency at module load time.
function makeClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const state = {
  token: isHosted ? localStorage.getItem('craft-token') : null, // bridge session, direct (same-network) mode only
  clientId: localStorage.getItem('craft-client-id') || makeClientId(),
  sessionId: null,
  sessions: [],
  mode: 'Build',
  running: false,
  approval: null,
  imagePick: null,
  account: null,
  activeAgentMessageEl: null,
  runningSessions: [], // chat ids with a run in flight on the PC, live via runs_status
  models: { selected: 'auto', models: [] }, // names only; keys stay on the PC
  bypass: localStorage.getItem('craft-bypass') === '1', // run without approval prompts
};

localStorage.setItem('craft-client-id', state.clientId);

// THEME - dark / light / system. 'system' is the default and is represented
// by the ABSENCE of data-theme (mobile.css's own prefers-color-scheme media
// query does all the work then, so it also live-updates for free if the OS
// theme changes mid-session, no listener needed). An explicit choice sets
// data-theme, which always wins over the OS signal - see the CSS at the top
// of mobile.css for both sides of this. The <head> inline script applies a
// stored explicit choice before first paint; this just keeps it in sync
// after that (the toggle itself, the theme-color meta, live OS changes
// while explicitly on 'system').
function getThemeChoice() {
  const t = localStorage.getItem('craft-theme');
  return t === 'dark' || t === 'light' ? t : 'system';
}

function applyTheme(choice) {
  if (choice === 'system') {
    localStorage.removeItem('craft-theme');
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem('craft-theme', choice);
    document.documentElement.dataset.theme = choice;
  }
  syncThemeColorMeta();
  syncThemeToggleUI();
}

function isEffectivelyDark() {
  const choice = getThemeChoice();
  if (choice === 'dark') return true;
  if (choice === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function syncThemeColorMeta() {
  const meta = document.getElementById('themeColorMeta');
  if (meta) meta.content = isEffectivelyDark() ? '#1d1d20' : '#ffffff';
}

function syncThemeToggleUI() {
  const active = getThemeChoice();
  document.querySelectorAll('.theme-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeChoice === active);
  });
}

// While explicitly on 'system', the OS can still flip mid-session (e.g. auto
// dark-mode-at-sunset) - the CSS media query repaints on its own, but the
// theme-color meta is JS-driven and needs its own nudge to follow along.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemeChoice() === 'system') syncThemeColorMeta();
  });
}

function endpoint(path) {
  return `${location.origin}${path}`;
}

/**
 * One call into the PC. Through the Realtime relay from anywhere, or straight
 * over HTTP when this page is served by the PC itself.
 */
async function request(path, options = {}, { retry = true } = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  if (!isHosted) return relayRequest(method, path, body);

  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(endpoint(path), { ...options, headers, signal: controller.signal });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? "Your PC didn't answer in time." : 'Could not reach your PC.');
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 401 && retry && (await reconnect())) return request(path, options, { retry: false });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not reach your PC.');
  return data;
}

/** Screenshots live on the PC; fetched on demand (relay or direct). */
async function loadScreenshot(img, screenshotPath) {
  try {
    if (isHosted) {
      img.src = endpoint(`/api/screenshot?path=${encodeURIComponent(screenshotPath)}&token=${encodeURIComponent(state.token || '')}`);
    } else {
      const r = await request(`/api/screenshot-data?path=${encodeURIComponent(screenshotPath)}`);
      if (r.dataUrl) img.src = r.dataUrl;
    }
  } catch { img.remove(); }
}

function basename(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || 'No desktop project';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
}

function setConnection(name, online = true) {
  const chip = $('deviceName');
  const dot = $('statusDot');
  if (chip) chip.textContent = online ? (name || state.deviceName || 'Your PC') : 'PC offline';
  if (dot) dot.style.background = online ? 'var(--green)' : 'var(--danger)';
  if (dot) dot.title = online ? 'Connected to your PC' : 'Your PC is offline';
}

function setRunning(running) {
  state.running = running;
  const sendIcon = $('sendIcon');
  const stopIcon = $('stopIcon');
  if (sendIcon) sendIcon.classList.toggle('hidden', running);
  if (stopIcon) stopIcon.classList.toggle('hidden', !running);
}

function showChat() {
  $('emptyState').classList.add('hidden');
  $('chatFeed').classList.remove('hidden');
}

// A plain synchronous `scrollTop = scrollHeight` right after appending can
// land short: on real phones the keyboard/visual-viewport resize, webfont
// swap, or the browser's own reflow can all still be pending, so the height
// we just read is stale. Re-applying it across a couple of animation frames
// (and again on the next visualViewport resize) keeps the feed pinned to the
// latest message instead of leaving it a message or two short.
function scrollToBottom() {
  const el = $('workArea');
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  });
}

// Just enough markdown to make agent replies readable on a phone screen -
// bold and line breaks. Escapes first so raw text can never inject markup.
function renderMarkdownLite(text) {
  return escapeHtml(text || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// Same two-layer ball+eyes mascot as the desktop app. Relative path: served by
// the PC in direct mode, bundled with the phone app everywhere else.
function mascotHtml(mascotFile, altText) {
  const delay = (-(Math.random() * 6)).toFixed(2) + 's';
  return `<span class="mascot">
    <img class="mascot-ball" src="agent-mascots/${encodeURIComponent(mascotFile)}" alt="${escapeHtml(altText)}">
    <img class="mascot-eyes" src="agent-mascots/eyes.png" alt="" style="animation-delay: ${delay}">
  </span>`;
}

// One agent; this marks the moment it switches role (Frontend, Backend, ...).
function addRoleBadge(data) {
  showChat();
  const roleName = data.tagline === 'role' ? data.name : String(data.tagline || data.name || '').replace(/ Specialist$/i, '');
  const el = document.createElement('div');
  el.className = 'subagent-badge';
  el.style.setProperty('--subagent-color', data.color || '');
  el.innerHTML = mascotHtml(data.mascot || 'general.png', roleName) +
    `<span class="subagent-badge-text">Working as <strong>${escapeHtml(roleName || 'General')}</strong></span>`;
  $('chatFeed').append(el);
  scrollToBottom();
}

// The factual record of what a turn changed, built from tool results.
function addTurnSummary(data) {
  const files = data.files || [];
  const checks = data.checks || [];
  if (!files.length && !checks.length) return;
  showChat();
  const el = document.createElement('div');
  el.className = 'turn-summary';
  const checkLine = (c) => {
    const passed = c.ok && (c.exitCode === undefined || c.exitCode === 0);
    return `<div class="ts-check ${passed ? 'pass' : 'fail'}">${passed ? '✓' : '✗'} <code>${escapeHtml(c.tool === 'browser_check' ? 'Opened ' + c.label : c.label)}</code>${typeof c.exitCode === 'number' ? ` <span>exit ${c.exitCode}</span>` : ''}</div>`;
  };
  el.innerHTML = `<div class="ts-head">What actually happened</div>
    ${files.length ? `<div class="ts-files">${files.map((f) => `<span>${escapeHtml(f)}</span>`).join('')}</div>` : ''}
    ${checks.map(checkLine).join('')}
    ${(data.unverified || []).length ? `<div class="ts-warn">Not verified: ${data.unverified.map(escapeHtml).join(', ')}</div>` : ''}`;
  $('chatFeed').append(el);
  scrollToBottom();
}

// One live card per /goal run.
let goalCardEl = null;
const GOAL_LABEL = { running: 'Working', verifying: 'Verifying', achieved: 'Achieved', blocked: 'Stuck', incomplete: 'Not finished', failed: 'Stopped', stopped: 'Stopped' };
function renderGoalCard(data) {
  showChat();
  if (!goalCardEl || goalCardEl.dataset.goal !== data.goal || !goalCardEl.isConnected) {
    goalCardEl = document.createElement('div');
    goalCardEl.className = 'goal-card';
    goalCardEl.dataset.goal = data.goal;
    goalCardEl.innerHTML = '<div class="goal-head"><span>Goal</span><span class="goal-pill"></span></div><div class="goal-text"></div><div class="goal-note"></div>';
    goalCardEl.querySelector('.goal-text').textContent = data.goal;
    $('chatFeed').append(goalCardEl);
  }
  goalCardEl.dataset.status = data.status;
  const live = ['running', 'verifying'].includes(data.status) && data.iteration;
  goalCardEl.querySelector('.goal-pill').textContent = live ? `${GOAL_LABEL[data.status]} · ${data.iteration}/${data.max}` : (GOAL_LABEL[data.status] || data.status);
  goalCardEl.querySelector('.goal-note').textContent = data.note || '';
  scrollToBottom();
}

// ─── Tool rows: tap to see what really ran ─────────────────────────────────
const TOOL_VERB = {
  read_file: 'Read', write_file: 'Wrote', edit_file: 'Edited', run: 'Ran', search: 'Searched', list_dir: 'Listed',
  browser_check: 'Checked', fetch_image: 'Downloaded', use_skill: 'Loaded skill', list_skills: 'Searched skills',
  view_images: 'Viewed', design_reference_search: 'Searched designs', gmail_send: 'Emailed', gmail_search: 'Searched Gmail',
  slack_post_message: 'Posted', vercel_deploy: 'Deployed', vercel_api: 'Vercel', supabase_api: 'Supabase',
  supabase_sql: 'Ran SQL', supabase_create_project: 'Created project', supabase_delete_project: 'Deleted project',
  github_create_repo: 'Pushed',
};

function clip(text, maxLines = 40) {
  const lines = String(text || '').split(/\r?\n/);
  const nl = String.fromCharCode(10);
  return lines.length > maxLines
    ? lines.slice(0, maxLines).join(nl) + nl + `… ${lines.length - maxLines} more lines`
    : lines.join(nl);
}

function addToolItem(t) {
  showChat();
  state.activeAgentMessageEl = null;
  const failed = t.ok === false || (typeof t.exitCode === 'number' && t.exitCode !== 0);
  const stats = [];
  if (typeof t.added === 'number' && (t.name === 'edit_file' || t.name === 'write_file')) stats.push(`<span class="stat-add">+${t.added}</span>`);
  if (typeof t.removed === 'number' && t.name === 'edit_file') stats.push(`<span class="stat-del">−${t.removed}</span>`);
  if (typeof t.exitCode === 'number') stats.push(`<span class="${t.exitCode === 0 ? 'stat-ok' : 'stat-del'}">exit ${t.exitCode}</span>`);

  // What goes inside when tapped.
  const a = t.args || {};
  let body = '';
  if (t.name === 'run' && a.command) body = `<div class="tool-body-label">Command</div><pre class="tool-code">${escapeHtml(a.command)}</pre>`;
  else if (t.name === 'edit_file' && (a.search || a.replace)) {
    body = `<div class="tool-body-label">${escapeHtml(a.path || '')}</div>` +
      `<pre class="tool-code diff-del">${escapeHtml(clip(a.search)).replace(/^/gm, '− ')}</pre>` +
      `<pre class="tool-code diff-add">${escapeHtml(clip(a.replace)).replace(/^/gm, '+ ')}</pre>`;
  } else if (t.name === 'write_file') body = `<div class="tool-body-label">${escapeHtml(a.path || '')}${typeof t.added === 'number' ? ` · ${t.added} lines` : ''}</div>`;
  else if (t.name === 'supabase_sql' && a.query) body = `<div class="tool-body-label">SQL</div><pre class="tool-code">${escapeHtml(clip(a.query))}</pre>`;
  else if (Object.keys(a).length) body = `<pre class="tool-code">${escapeHtml(clip(Object.entries(a).map(([k, v]) => `${k}: ${v}`).join(String.fromCharCode(10)), 20))}</pre>`;

  const el = document.createElement('details');
  el.className = `tool-item${failed ? ' failed' : ''}`;
  el.innerHTML = `<summary>
      <span class="tool-verb">${escapeHtml(TOOL_VERB[t.name] || t.name || 'Ran')}</span>
      <span class="tool-label">${escapeHtml(t.label || '')}</span>
      ${stats.length ? `<span class="tool-stats">${stats.join(' ')}</span>` : ''}
      <svg class="tool-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
    </summary><div class="tool-body">${body}</div>`;
  if (t.screenshotPath) {
    const img = document.createElement('img');
    img.className = 'tool-screenshot';
    img.alt = 'Screenshot Craft took of the page';
    img.addEventListener('click', () => window.open(img.src, '_blank'));
    el.querySelector('.tool-body').appendChild(img);
    loadScreenshot(img, t.screenshotPath);
    el.open = true; // a page check is most useful with its screenshot visible
  }
  if (!body && !t.screenshotPath) el.classList.add('no-body');
  $('chatFeed').append(el);
  scrollToBottom();
}

// Narration while the agent works folds into a tap-to-open "Thinking" row;
// only the final answer is a normal message.
function addThinking(text) {
  showChat();
  state.activeAgentMessageEl = null;
  const el = document.createElement('details');
  el.className = 'thinking-step';
  el.innerHTML = '<summary><span>Thinking</span><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg></summary><div class="thinking-text"></div>';
  el.querySelector('.thinking-text').innerHTML = renderMarkdownLite(text);
  $('chatFeed').append(el);
  scrollToBottom();
}

function addMessage(kind, text, label, screenshotPath) {
  showChat();
  const feed = $('chatFeed');

  if (kind === 'agent_delta') {
    if (!state.activeAgentMessageEl) {
      const el = document.createElement('article');
      el.className = 'message-bubble agent';
      el.dataset.raw = text || '';
      el.innerHTML = renderMarkdownLite(el.dataset.raw);
      feed.append(el);
      state.activeAgentMessageEl = el;
    } else {
      state.activeAgentMessageEl.dataset.raw += text || '';
      state.activeAgentMessageEl.innerHTML = renderMarkdownLite(state.activeAgentMessageEl.dataset.raw);
    }
    scrollToBottom();
    return state.activeAgentMessageEl;
  }

  // Finalize any streaming message before adding a new discrete message
  state.activeAgentMessageEl = null;

  const el = document.createElement('article');
  el.className = `message-bubble ${kind}`;

  if (kind === 'tool') {
    el.innerHTML = `<span class="tool-name">${escapeHtml(label || 'Executed')}</span>${text ? ` <span>${escapeHtml(text)}</span>` : ''}`;
    // A browser_check's screenshot, shown right in the chat - this phone
    // has no embedded browser of its own to preview the result in, so this
    // is the only way to actually see what got checked.
    if (screenshotPath) {
      const img = document.createElement('img');
      img.className = 'tool-screenshot';
      img.alt = label || 'Browser check screenshot';
      el.appendChild(img);
      loadScreenshot(img, screenshotPath);
    }
  } else if (kind === 'error') {
    el.textContent = text || '';
  } else {
    el.innerHTML = renderMarkdownLite(text);
  }

  feed.append(el);
  scrollToBottom();
  return el;
}

function clearChat() {
  $('chatFeed').innerHTML = '';
  state.activeAgentMessageEl = null;
}

function renderProjects(projects, selected) {
  const select = $('projectSelect');
  if (!select) return;
  select.innerHTML = '';
  for (const project of projects || []) {
    const option = document.createElement('option');
    option.value = project;
    option.textContent = basename(project);
    option.selected = project === selected;
    select.append(option);
  }
  if (!select.options.length) select.innerHTML = '<option value="">No desktop project</option>';

  const activeProjEl = $('activeProjectName');
  if (activeProjEl) activeProjEl.textContent = basename(select.value);
  const topbarNameEl = $('topbarFolderName');
  if (topbarNameEl) topbarNameEl.textContent = select.value ? basename(select.value) : 'Choose folder';
}

function renderAccount(account, device) {
  state.account = account;
  const email = account?.email || 'Your account';
  if ($('accountEmail')) $('accountEmail').textContent = email;
  if ($('accountMode')) $('accountMode').textContent = device ? `Connected to ${device}` : 'Connected to your PC';
  if ($('accountInitial')) $('accountInitial').textContent = email[0]?.toUpperCase() || 'C';
}

function renderSessions() {
  const list = $('sessionList');
  if (!list) return;
  list.innerHTML = '';
  
  const ordered = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  if ($('sessionCount')) $('sessionCount').textContent = ordered.length ? String(ordered.length) : '';

  for (const session of ordered) {
    // A <button> can't legally contain another <button> (the "..." menu
    // trigger), so this is a div acting as one - same trick as the topbar's
    // folder <select>. Its own click opens the chat; the nested button stops
    // that click from bubbling and opens the rename/delete sheet instead.
    const card = document.createElement('div');
    card.className = `session-card${session.id === state.sessionId ? ' active' : ''}`;
    card.title = session.title || 'Untitled task';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.innerHTML = `
      <span class="session-card-title">${escapeHtml(session.title || 'Untitled task')}</span>
      <button type="button" class="session-card-more" aria-label="Chat options">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
      </button>
    `;
    card.addEventListener('click', () => { openSession(session.id); closeSidebar(); });
    card.querySelector('.session-card-more').addEventListener('click', (e) => {
      e.stopPropagation();
      openSessionMenu(session);
    });
    list.append(card);
  }
}

function mergeSession(meta) {
  const found = state.sessions.findIndex((s) => s.id === meta.id);
  if (found >= 0) state.sessions[found] = { ...state.sessions[found], ...meta };
  else state.sessions.unshift(meta);
  renderSessions();
  syncChatTitle();
}

// Drives the title pill at the top of the chat tab - the phone's stand-in
// for a desktop sidebar's "which chat am I in" cue.
function syncChatTitle() {
  const el = $('chatTitlePill');
  if (!el) return;
  const current = state.sessionId && state.sessions.find((s) => s.id === state.sessionId);
  el.textContent = (current && current.title) || 'New chat';
}

function renderSession(session) {
  clearChat();
  goalCardEl = null;
  state.sessionId = session.id;
  mergeSession({
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    preview: session.messages?.at(-1)?.text || '',
  });

  if (session.messages && session.messages.length > 0) {
    showChat();
    for (const item of session.messages) {
      if (item.kind === 'user') addMessage('user', item.text);
      else if (item.kind === 'assistant') (item.interim ? addThinking(item.text) : addMessage('agent', item.text));
      else if (item.kind === 'tool') addToolItem(item);
      else if (item.kind === 'role_active' || item.kind === 'subagent_active') addRoleBadge(item);
      else if (item.kind === 'turn_summary') addTurnSummary(item);
      else if (item.kind === 'goal') renderGoalCard(item);
      else if (item.kind === 'notice') addMessage('error', item.text);
    }
    // Chat should always open scrolled to the newest message, not the top.
    scrollToBottom();
  } else {
    $('emptyState').classList.remove('hidden');
    $('chatFeed').classList.add('hidden');
  }
  renderSessions();

  // Re-sync the send/stop icon to what this chat is actually doing right now.
  setRunning(state.runningSessions.includes(session.id));
}

async function openSession(id) {
  const session = await request(`/api/session?id=${encodeURIComponent(id)}`);
  renderSession(session);
  showScreen('chat');
}

async function bootstrap({ preserveSession = true } = {}) {
  const data = await request('/api/bootstrap');
  state.deviceName = data.device;
  setConnection(data.device, true);
  renderAccount(data.account, data.device);
  renderProjects(data.projects, data.lastProject);
  state.sessions = data.sessions || [];
  state.runningSessions = data.activeSessionIds || [];
  renderSessions();
  if (data.models) renderModels(data.models);

  showScreen('chat');

  const active = data.activeSessionIds?.[0];
  const target = preserveSession && state.sessionId ? state.sessionId : active || data.sessions?.[0]?.id;
  if (target && target !== state.sessionId) {
    await openSession(target);
  } else if (state.sessionId) {
    const current = data.sessions?.find((s) => s.id === state.sessionId);
    if (current) renderSession(current);
  }
  // Nothing to show at all - renderSession()'s own resync (which covers
  // both branches above) never ran, so there's nothing running to reflect.
  if (!target && !state.sessionId) setRunning(false);
}

// On-screen keyboard opening/closing resizes the visual viewport (not the
// layout viewport), which can leave the last message sitting behind the
// keyboard even though scrollTop was already correct for the old viewport.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (!$('chatFeed') || $('chatFeed').classList.contains('hidden')) return;
    scrollToBottom();
  });
}

let eventSource = null;

function connectEvents() {
  if (eventSource) eventSource.close();
  if (!isHosted) return; // relay mode gets events over the Realtime channel
  eventSource = new EventSource(endpoint(`/api/events?token=${encodeURIComponent(state.token)}`));

  eventSource.addEventListener('agent', (e) => {
    try { receiveEvent(JSON.parse(e.data)); } catch {}
  });

  eventSource.onopen = () => setConnection(state.deviceName, true);
  // The PC may have restarted and forgotten this session: sign back in and
  // reopen the stream.
  eventSource.onerror = async () => {
    setConnection('', false);
    if (eventSource && eventSource.readyState === EventSource.CLOSED && (await reconnect())) connectEvents();
  };
}

function receiveEvent(event) {
  if (event.type === 'session_sync') {
    mergeSession(event.session);
    // A brand-new chat's session id is only known once /api/send resolves,
    // which doesn't happen until the whole agent turn finishes - but the
    // desktop starts streaming 'text'/'tool_end'/'approval_request' events
    // for that session immediately. Without adopting the id right here (this
    // sync fires first, before any of those), every one of those events gets
    // silently dropped by the `event.sessionId === state.sessionId` checks
    // below, so nothing appears live; the reply only shows up once the chat
    // is reopened and re-fetched from the server.
    if (!state.sessionId && event.origin === state.clientId) {
      state.sessionId = event.sessionId;
    }
    if (event.sessionId === state.sessionId && event.message && event.origin !== state.clientId) {
      if (event.message.kind === 'user') addMessage('user', event.message.text);
    }
    return;
  }

  if (event.type === 'session_deleted') {
    state.sessions = state.sessions.filter((s) => s.id !== event.sessionId);
    renderSessions();
    if (state.sessionId === event.sessionId) {
      state.sessionId = null;
      clearChat();
      $('chatFeed').classList.add('hidden');
      $('emptyState').classList.remove('hidden');
    }
    return;
  }

  // Which chats have a run in flight - keeps the send/stop icon honest.
  if (event.type === 'runs_status') {
    state.runningSessions = event.active || [];
    if (state.sessionId) {
      const isActive = state.runningSessions.includes(state.sessionId);
      if (isActive !== state.running) setRunning(isActive);
    }
    return;
  }

  if (event.sessionId !== state.sessionId) return;

  if (event.type === 'role_active') {
    addRoleBadge(event);
  } else if (event.type === 'turn_summary') {
    addTurnSummary(event);
  } else if (event.type === 'goal_update') {
    renderGoalCard(event);
  } else if (event.type === 'notice') {
    state.activeAgentMessageEl = null;
    addMessage('error', event.text);
  } else if (event.type === 'text') {
    if (event.interim) addThinking(event.text);
    else addMessage('agent_delta', event.text);
  } else if (event.type === 'tool_end') {
    state.activeAgentMessageEl = null;
    addToolItem({
      name: event.name, label: event.summary || event.args?.path || event.args?.command || '', ok: event.ok, args: event.args,
      exitCode: event.meta?.exitCode, added: event.meta?.added, removed: event.meta?.removed, screenshotPath: event.meta?.screenshotPath,
    });
  } else if (event.type === 'error') {
    state.activeAgentMessageEl = null;
    addMessage('error', event.error);
  } else if (event.type === 'approval_request') {
    showApproval(event);
  } else if (event.type === 'image_pick_request') {
    showImagePicker(event);
  } else if (event.type === 'approval_resolved') {
    // Answered from another device (e.g. the desktop app) - this client's
    // own tap already hides the sheet locally, so this only matters when
    // it's the request THIS device didn't answer.
    if (state.approval && state.approval.requestId === event.requestId) {
      state.approval = null;
      $('approvalSheet').classList.add('hidden');
    }
  } else if (event.type === 'image_pick_resolved') {
    if (state.imagePick && state.imagePick.requestId === event.requestId) {
      state.imagePick = null;
      $('imagePickSheet').classList.add('hidden');
    }
  } else if (event.type === 'run_finished' || event.type === 'aborted') {
    state.activeAgentMessageEl = null;
    // If a run ends (especially aborted/stopped) while an approval sheet is
    // still up, the server auto-rejects the pending approval on its side but
    // never tells this client to close the sheet - it was otherwise only
    // ever hidden by the user tapping Approve/Reject, so it would stay
    // stuck on screen for a request that's already dead.
    if (state.approval) {
      state.approval = null;
      $('approvalSheet').classList.add('hidden');
    }
    if (state.imagePick) {
      state.imagePick = null;
      $('imagePickSheet').classList.add('hidden');
    }
    setRunning(false, event.type === 'aborted' ? 'Run stopped' : 'Task completed on PC');
  }
}

function showApproval(event) {
  state.approval = event;
  $('approvalTitle').textContent = event.title || 'Craft Needs Approval';
  $('approvalDetail').textContent = event.detail || `Allow Craft to run ${String(event.tool || 'action').replace(/_/g, ' ')}?`;
  $('approvalSheet').classList.remove('hidden');
}

async function answerApproval(verdict) {
  if (!state.approval) return;
  const pending = state.approval;
  $('approvalSheet').classList.add('hidden');
  state.approval = null;
  try {
    await request('/api/approval', {
      method: 'POST',
      body: JSON.stringify({ requestId: pending.requestId, verdict }),
    });
  } catch (err) {
    addMessage('error', err.message);
  }
}

// SESSION MENU - the phone's version of desktop's 3-dot chat menu
// (openChatMenu/startRenameSession/deleteSessionById in app.js): rename or
// delete a chat from the "..." on its row in the sidebar.
let sessionMenuTarget = null;

function openSessionMenu(session) {
  sessionMenuTarget = session;
  $('sessionMenuSheet').classList.remove('hidden');
}

function closeSessionMenu() {
  sessionMenuTarget = null;
  $('sessionMenuSheet').classList.add('hidden');
}

async function renameSessionFlow() {
  const session = sessionMenuTarget;
  closeSessionMenu();
  if (!session) return;
  const next = (prompt('Rename chat', session.title || '') || '').trim();
  if (!next || next === session.title) return;
  session.title = next;
  renderSessions();
  try {
    await request('/api/session/rename', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id, title: next }),
    });
  } catch (err) {
    addMessage('error', err.message);
  }
}

async function deleteSessionFlow() {
  const session = sessionMenuTarget;
  closeSessionMenu();
  if (!session) return;
  if (!confirm(`Delete "${session.title || 'this chat'}"? This can't be undone.`)) return;
  state.sessions = state.sessions.filter((s) => s.id !== session.id);
  renderSessions();
  if (state.sessionId === session.id) {
    state.sessionId = null;
    clearChat();
    $('chatFeed').classList.add('hidden');
    $('emptyState').classList.remove('hidden');
  }
  try {
    await request('/api/session/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id }),
    });
  } catch (err) {
    addMessage('error', err.message);
  }
}

// IMAGE PICKER - the phone side of the fetch_image approval the desktop
// shows as a search-and-click card (see addImagePickerCard in app.js). Same
// /api/images/search + /api/image-pick the desktop's own IPC calls hit.
function showImagePicker(event) {
  state.imagePick = event;
  $('imagePickDetail').textContent = `for ${event.path || 'this file'}`;
  $('imgSearchInput').value = event.keywords || '';
  $('imagePickSheet').classList.remove('hidden');
  runImageSearch(event.keywords || '');
}

function renderImageGrid(results) {
  const grid = $('imgGrid');
  grid.innerHTML = '';
  const makeTile = (img, label) => {
    const btn = document.createElement('button');
    btn.className = 'img-tile';
    btn.innerHTML = `<img src="${escapeHtml(img.thumbnail)}" alt="${escapeHtml(img.title || '')}" loading="lazy">
      <span class="img-tile-credit">${escapeHtml(label || img.creator || img.source || '')}</span>`;
    btn.addEventListener('click', () => finishImagePick(img.full));
    return btn;
  };
  if (state.imagePick) {
    grid.appendChild(makeTile({ thumbnail: state.imagePick.url, full: state.imagePick.url }, "Codeply's pick"));
  }
  if (!results.length) {
    const msg = document.createElement('div');
    msg.className = 'img-grid-status';
    msg.textContent = 'No other results. Try different words.';
    grid.appendChild(msg);
    return;
  }
  for (const img of results) grid.appendChild(makeTile(img));
}

async function runImageSearch(query) {
  $('imgGrid').innerHTML = '<div class="img-grid-status">Searching…</div>';
  try {
    const r = await request(`/api/images/search?q=${encodeURIComponent(query)}`);
    if (!r.ok) throw new Error(r.error || 'unknown error');
    renderImageGrid(r.results || []);
  } catch (err) {
    $('imgGrid').innerHTML = `<div class="img-grid-status">Search failed: ${escapeHtml(err.message)}</div>`;
  }
}

async function finishImagePick(chosenUrl) {
  if (!state.imagePick) return;
  const pending = state.imagePick;
  $('imagePickSheet').classList.add('hidden');
  state.imagePick = null;
  try {
    await request('/api/image-pick', {
      method: 'POST',
      body: JSON.stringify({ requestId: pending.requestId, chosenUrl }),
    });
  } catch (err) {
    addMessage('error', err.message);
  }
}

// Only two real screens now - chat and the paired-PC status screen.
// Session history moved into the sidebar drawer instead of being a third
// screen of its own (see openSidebar/renderSessions).
function showScreen(screen) {
  $('chatPanel').classList.toggle('hidden', screen !== 'chat');
  const desktopPanel = $('desktopPanel');
  if (desktopPanel) desktopPanel.classList.toggle('hidden', screen !== 'desktop');
}

function openSidebar() {
  $('sidebarBackdrop').classList.remove('hidden');
  $('sidebarDrawer').classList.remove('hidden');
  // Two rAFs, not one: the element has to actually paint in its
  // pre-transition state (display:none just removed) before adding the
  // class that transitions it, or the browser can coalesce both changes
  // into one frame and the slide-in never plays.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('sidebarBackdrop').classList.add('open');
    $('sidebarDrawer').classList.add('open');
  }));
  $('sidebarDrawer').setAttribute('aria-hidden', 'false');
}

function closeSidebar() {
  $('sidebarBackdrop').classList.remove('open');
  $('sidebarDrawer').classList.remove('open');
  $('sidebarDrawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    if (!$('sidebarDrawer').classList.contains('open')) {
      $('sidebarBackdrop').classList.add('hidden');
      $('sidebarDrawer').classList.add('hidden');
    }
  }, 280); // matches the drawer's own transition duration
}

// ─── Account sign-in + reaching the PC ──────────────────────────────────────
// The phone signs in with the user's Codeply account, then talks to the PC
// through a Supabase Realtime channel. Both sides connect out to Supabase, so
// it works from any network (mobile data, another Wi-Fi) as long as the PC is
// on and signed in. The channel name includes a random secret kept in the
// account's own metadata, and the PC checks the phone's sign-in token on every
// request, so only this account's phones can drive it.
// When this page is served by the PC itself (http://<pc>:45671), it talks to
// the PC directly over the local network instead.
// Public project URL + anon key: the same values the desktop app and CLI ship.
const SUPABASE_URL = 'https://zswkhfkfseclgadhvobg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpzd2toZmtmc2VjbGdhZGh2b2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzYyOTgsImV4cCI6MjA5NTgxMjI5OH0.EoTQdIGQQDrN1uEqQfya3VmrQMT68jkzPLphbLwNTWg';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'craft-phone-auth' },
});

const RELAY_CHUNK = 60000;
const RELAY_TIMEOUT_MS = 25000;
const relay = {
  channel: null,
  pcId: null,          // the PC this phone is driving (presence key)
  pcs: [],             // [{ deviceId, device, since }] currently online
  pending: new Map(),  // request id -> { resolve, reject, timer }
  parts: new Map(),    // message id -> { n, got, chunks }
};

function friendlyAuthError(err, fallback) {
  const s = String(err?.message || err || '').toLowerCase();
  if (s.includes('invalid login') || s.includes('invalid credentials')) return 'Incorrect email or password.';
  if (s.includes('email not confirmed')) return 'Confirm your email first (check your inbox), then sign in.';
  if (s.includes('expired') || (s.includes('invalid') && (s.includes('otp') || s.includes('token')))) return 'That code is wrong or has expired. Request a new one.';
  if (s.includes('rate') || s.includes('too many') || s.includes('seconds')) return 'Too many attempts. Wait a minute and try again.';
  if (s.includes('signups not allowed') || s.includes('user not found')) return 'No account with that email. Create one in Codeply Craft on your PC first.';
  if (s.includes('fetch') || s.includes('network')) return "Can't reach Codeply. Check your internet connection.";
  return err?.message || fallback;
}

async function currentSession() {
  const { data } = await sb.auth.getSession();
  return data?.session || null;
}

async function accessToken() {
  const session = await currentSession();
  if (!session) throw new Error('You are signed out. Sign in again.');
  return session.access_token;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Realtime messages are size-limited, so anything big travels in chunks. */
function relaySend(event, obj) {
  if (!relay.channel) return;
  const str = JSON.stringify(obj);
  const id = newId();
  const n = Math.max(1, Math.ceil(str.length / RELAY_CHUNK));
  for (let i = 0; i < n; i++) {
    relay.channel.send({ type: 'broadcast', event, payload: { id, i, n, d: str.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK) } });
  }
}

function relayAssemble(payload) {
  if (!payload || typeof payload.d !== 'string') return null;
  if (payload.n === 1) { try { return JSON.parse(payload.d); } catch { return null; } }
  if (payload.n > 200) return null;
  for (const [key, e] of relay.parts) if (Date.now() - e.at > 60000) relay.parts.delete(key);
  let entry = relay.parts.get(payload.id);
  if (!entry) { entry = { n: payload.n, got: 0, chunks: [], at: Date.now() }; relay.parts.set(payload.id, entry); }
  if (entry.chunks[payload.i] === undefined) { entry.chunks[payload.i] = payload.d; entry.got++; }
  if (entry.got < entry.n) return null;
  relay.parts.delete(payload.id);
  try { return JSON.parse(entry.chunks.join('')); } catch { return null; }
}

function updatePcs() {
  const state_ = relay.channel ? relay.channel.presenceState() : {};
  relay.pcs = Object.entries(state_).map(([key, metas]) => ({ deviceId: key, ...(metas[0] || {}) }))
    .sort((a, b) => (b.since || 0) - (a.since || 0));
  const stillThere = relay.pcs.some((p) => p.deviceId === relay.pcId);
  if (!stillThere) relay.pcId = relay.pcs[0]?.deviceId || null;
  setConnection('', !!relay.pcId);
  onPcPresenceChange();
}

async function openRelay() {
  if (relay.channel) return;
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) throw new Error('You are signed out. Sign in again.');
  const secret = data.user.user_metadata?.craft_relay;
  if (!secret) throw Object.assign(new Error('Open Codeply Craft on your PC and sign in there once, then try again.'), { noPc: true });
  const channel = sb.channel(`craft-${data.user.id}-${secret}`, { config: { broadcast: { self: false } } });
  channel.on('broadcast', { event: 'res' }, ({ payload }) => {
    const msg = relayAssemble(payload);
    if (!msg) return;
    const p = relay.pending.get(msg.id);
    if (!p) return;
    relay.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.status >= 200 && msg.status < 300) p.resolve(msg.body);
    else p.reject(Object.assign(new Error(msg.body?.error || 'Your PC could not do that.'), { status: msg.status }));
  });
  channel.on('broadcast', { event: 'event' }, ({ payload }) => {
    const msg = relayAssemble(payload);
    if (!msg || (relay.pcId && msg.from && msg.from !== relay.pcId)) return;
    delete msg.from;
    receiveEvent(msg);
  });
  channel.on('presence', { event: 'sync' }, updatePcs);
  relay.channel = channel;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Couldn't connect to Codeply. Check your internet connection.")), 12000);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timer); reject(new Error("Couldn't connect to Codeply. Check your internet connection.")); }
    });
  });
}

async function closeRelay() {
  for (const [, p] of relay.pending) { clearTimeout(p.timer); p.reject(new Error('Disconnected.')); }
  relay.pending.clear();
  if (relay.channel) { try { await sb.removeChannel(relay.channel); } catch {} }
  relay.channel = null;
  relay.pcId = null;
  relay.pcs = [];
}

/** Waits (briefly) for the PC's presence to show up after joining. */
function waitForPc(ms = 5000) {
  if (relay.pcId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (relay.pcId || Date.now() - started > ms) { clearInterval(tick); resolve(!!relay.pcId); }
    }, 150);
  });
}

async function relayRequest(method, path, body) {
  if (!relay.channel) throw new Error('Not connected to your PC.');
  if (!relay.pcId) throw new Error('Your PC is offline. Open Codeply Craft on it and keep it on.');
  const id = newId();
  const token = await accessToken();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      relay.pending.delete(id);
      reject(new Error("Your PC didn't answer. Make sure it's on, awake and online."));
    }, RELAY_TIMEOUT_MS);
    relay.pending.set(id, { resolve, reject, timer });
    relaySend('req', { id, to: relay.pcId, method, path, body: body ?? null, accessToken: token });
  });
}

// Direct mode (page served by the PC): trade the sign-in token for a bridge session.
async function connectDirect() {
  const res = await fetch(`${location.origin}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: await accessToken() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Your PC refused the connection.');
  state.token = data.token;
  localStorage.setItem('craft-token', state.token);
}

/** The bridge forgets sessions when the PC restarts; quietly sign back in once. */
let reconnecting = null;
function reconnect() {
  if (!reconnecting) {
    reconnecting = connectDirect().then(() => true, () => false)
      .finally(() => setTimeout(() => { reconnecting = null; }, 0));
  }
  return reconnecting;
}

function showPairStep(step, text) {
  $('pairForm').classList.toggle('hidden', step !== 'login');
  $('otpForm').classList.toggle('hidden', step !== 'otp');
  $('pairSyncing').classList.toggle('hidden', step !== 'busy');
  $('findCard').classList.toggle('hidden', step !== 'find');
  if (step === 'busy') $('pairSyncingText').textContent = text || 'Connecting to your PC…';
}

function enterApp() {
  $('pairScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
}

function showFind(message) {
  $('appScreen').classList.add('hidden');
  $('pairScreen').classList.remove('hidden');
  showPairStep('find');
  $('findError').textContent = message || '';
  $('findError').classList.toggle('hidden', !message);
}

let appReady = false;

/** Signed in: reach the PC, load its state, open the app. */
async function connect() {
  $('pairScreen').classList.remove('hidden');
  $('appScreen').classList.add('hidden');
  showPairStep('busy', 'Connecting to your PC…');
  const session = await currentSession();
  $('findEmail').textContent = session?.user?.email || 'you';
  try {
    if (isHosted) {
      await connectDirect();
      enterApp();
      await bootstrap({ preserveSession: false });
      connectEvents();
    } else {
      await openRelay();
      if (!(await waitForPc())) { showFind(''); return false; }
      enterApp();
      await bootstrap({ preserveSession: false });
    }
    appReady = true;
    return true;
  } catch (err) {
    showFind(err.message);
    return false;
  }
}

/** PC came online while we were waiting, or went away while in the app. */
function onPcPresenceChange() {
  if (isHosted) return;
  if (relay.pcId && !appReady && !$('findCard').classList.contains('hidden')) {
    showPairStep('busy', 'Your PC is online. Connecting…');
    enterApp();
    bootstrap({ preserveSession: false }).then(() => { appReady = true; }).catch((err) => showFind(err.message));
  }
}

async function signOut() {
  try { if (isHosted && state.token) await request('/api/logout', { method: 'POST', body: '{}' }, { retry: false }); } catch {}
  if (eventSource) { eventSource.close(); eventSource = null; }
  await closeRelay();
  appReady = false;
  state.token = null;
  localStorage.removeItem('craft-token');
  try { await sb.auth.signOut(); } catch {}
  closeSidebar();
  $('loginPassword').value = '';
  $('appScreen').classList.add('hidden');
  $('pairScreen').classList.remove('hidden');
  showPairStep('login');
}

$('pairForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('pairError');
  error.classList.add('hidden');
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) return;
  $('loginBtn').disabled = true;
  showPairStep('busy', 'Signing in…');
  try {
    const { error: err } = await sb.auth.signInWithPassword({ email, password });
    if (err) throw err;
    $('loginPassword').value = '';
    await connect();
  } catch (err) {
    showPairStep('login');
    error.textContent = friendlyAuthError(err, 'Sign-in failed.');
    error.classList.remove('hidden');
  } finally {
    $('loginBtn').disabled = false;
  }
});

$('useCodeBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const error = $('pairError');
  if (!email) { error.textContent = 'Enter your email first.'; error.classList.remove('hidden'); return; }
  error.classList.add('hidden');
  showPairStep('busy', 'Sending your code…');
  try {
    const { error: err } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (err) throw err;
    $('otpSentTo').textContent = `We emailed a sign-in code to ${email}.`;
    $('loginOtp').value = '';
    showPairStep('otp');
    $('loginOtp').focus();
  } catch (err) {
    showPairStep('login');
    error.textContent = friendlyAuthError(err, 'Could not send a code.');
    error.classList.remove('hidden');
  }
});

$('otpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('otpError');
  error.classList.add('hidden');
  const email = $('loginEmail').value.trim();
  const token = $('loginOtp').value.replace(/\D+/g, '');
  if (token.length < 6) { error.textContent = 'Enter the full code from the email.'; error.classList.remove('hidden'); return; }
  showPairStep('busy', 'Signing in…');
  try {
    const { error: err } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (err) throw err;
    await connect();
  } catch (err) {
    showPairStep('otp');
    error.textContent = friendlyAuthError(err, 'Could not verify the code.');
    error.classList.remove('hidden');
  }
});

$('otpBackBtn').addEventListener('click', () => showPairStep('login'));
$('findRetryBtn').addEventListener('click', async () => { await closeRelay(); connect(); });
$('findSignOutBtn').addEventListener('click', signOut);

$('composerForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  if (state.running) {
    if (state.sessionId) {
      await request('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId }) });
    }
    return;
  }

  const input = $('taskInput');
  const text = input.value.trim();
  const cwd = $('projectSelect').value;

  if (!text) return;

  // Shown immediately, not after the request resolves: /api/send doesn't
  // respond until the whole agent turn (including any approval the user has
  // to answer) finishes, so waiting for it here - like this used to - meant
  // your own message stayed invisible for the entire run. The desktop client
  // already shows its own message optimistically before awaiting api.send();
  // this matches that.
  const sentSessionId = state.sessionId;
  state.activeAgentMessageEl = null;
  addMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  setRunning(true, 'Task sent to PC agent');

  try {
    const result = await request('/api/send', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: sentSessionId,
        cwd,
        mode: state.mode,
        bypass: state.bypass,
        text,
        clientId: state.clientId,
      }),
    });

    if (result.error) throw new Error(result.error);

    state.sessionId = result.sessionId;
    mergeSession({
      id: result.sessionId,
      title: result.title,
      cwd,
      updatedAt: Date.now(),
      preview: text,
    });
  } catch (err) {
    setRunning(false);
    addMessage('error', err.message);
  }
});

// Keep the chat's bottom padding equal to the floating composer's real height
// (it grows with the pills row and multi-line messages).
(function trackComposerHeight() {
  const composer = $('composerForm');
  const apply = () => {
    document.documentElement.style.setProperty('--composer-h', `${Math.ceil(composer.getBoundingClientRect().height)}px`);
  };
  apply();
  if (window.ResizeObserver) new ResizeObserver(apply).observe(composer);
  window.addEventListener('resize', apply);
})();

// ─── Model + permission pickers ─────────────────────────────────────────────
function renderModels(models) {
  if (models && Array.isArray(models.models)) state.models = models;
  const select = $('modelSelect');
  select.innerHTML = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.selected = value === state.models.selected;
    select.append(o);
  };
  add('auto', 'Auto (Gemma 4 31B)');
  for (const m of state.models.models) add(m.id, m.kind === 'ollama' && !/\(local\)/i.test(m.name) ? `${m.name} (local)` : m.name);
  const current = state.models.models.find((m) => m.id === state.models.selected);
  $('modelPillName').textContent = current ? current.name : 'Auto';
  $('modelPillDot').dataset.kind = current ? (current.kind === 'ollama' ? 'local' : 'custom') : 'auto';
}

$('modelSelect').addEventListener('change', async (e) => {
  const id = e.target.value;
  const previous = state.models.selected;
  try {
    renderModels(await request('/api/models/select', { method: 'POST', body: JSON.stringify({ id }) }));
  } catch (err) {
    state.models.selected = previous;
    renderModels();
    addMessage('error', err.message);
  }
});

function renderBypass() {
  $('bypassBtn').classList.toggle('danger', state.bypass);
  $('bypassBtn').setAttribute('aria-pressed', String(state.bypass));
  $('bypassLabel').textContent = state.bypass ? 'Bypass: no prompts' : 'Approve manually';
}

$('bypassBtn').addEventListener('click', () => {
  if (!state.bypass && !confirm('Bypass mode runs file edits, commands and deploys on your PC without asking you first. Turn it on?')) return;
  state.bypass = !state.bypass;
  localStorage.setItem('craft-bypass', state.bypass ? '1' : '0');
  renderBypass();
});
renderBypass();

$('taskInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});

$('approveBtn').addEventListener('click', () => answerApproval('once'));
$('rejectBtn').addEventListener('click', () => answerApproval('reject'));

$('sessionRenameBtn').addEventListener('click', renameSessionFlow);
$('sessionDeleteBtn').addEventListener('click', deleteSessionFlow);
$('sessionMenuBackdrop').addEventListener('click', closeSessionMenu);

$('imgSearchBtn').addEventListener('click', () => runImageSearch($('imgSearchInput').value.trim()));
$('imgSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runImageSearch($('imgSearchInput').value.trim()); }
});
$('imgPickSkipBtn').addEventListener('click', () => finishImagePick(state.imagePick?.url || null));
$('imgPickCancelBtn').addEventListener('click', () => finishImagePick(null));

$('refreshBtn').addEventListener('click', () => bootstrap().catch(() => setConnection('', false)));

// SIDEBAR DRAWER - opened from the topbar hamburger; closed by its X,
// tapping the backdrop, or by any nav item inside it once it's done its
// job (new chat, opening a session).
$('sidebarOpenBtn').addEventListener('click', openSidebar);
$('sidebarCloseBtn').addEventListener('click', closeSidebar);
$('sidebarBackdrop').addEventListener('click', closeSidebar);

$('sidebarNewChatBtn').addEventListener('click', () => {
  state.sessionId = null;
  clearChat();
  $('chatFeed').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  renderSessions();
  syncChatTitle();
  closeSidebar();
});


document.querySelectorAll('.theme-opt').forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
});
syncThemeColorMeta();
syncThemeToggleUI();

if ($('unpairBtn')) $('unpairBtn').addEventListener('click', signOut);

// Picking a folder updates the topbar pill immediately - renderProjects()
// only sets the initial text, this is what keeps it live after that.
$('projectSelect').addEventListener('change', () => {
  const name = $('projectSelect').value ? basename($('projectSelect').value) : 'Choose folder';
  $('topbarFolderName').textContent = name;
  const activeProjEl = $('activeProjectName');
  if (activeProjEl) activeProjEl.textContent = name;
});

document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    $('taskInput').value = button.dataset.prompt;
    $('taskInput').focus();
  });
});

// Startup: a remembered sign-in goes straight to connecting.
currentSession().then((session) => {
  if (session) connect();
  else showPairStep('login');
});
