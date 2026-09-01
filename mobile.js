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
  token: localStorage.getItem('craft-token'),
  baseUrl: localStorage.getItem('craft-host') || (isHosted ? location.origin : ''),
  clientId: localStorage.getItem('craft-client-id') || makeClientId(),
  sessionId: null,
  sessions: [],
  mode: 'Build',
  running: false,
  approval: null,
  imagePick: null,
  account: null,
  activeAgentMessageEl: null,
  subagents: [], // static specialist metadata (name/mascot/color) — from /api/bootstrap
  activeAgentSessions: [], // [{sessionId, subagentId, title}] — live via the agents_status SSE event
  currentParentId: null, // the open chat's parentSessionId, if dispatch_agent spawned it — drives backToMainBtn
};

localStorage.setItem('craft-client-id', state.clientId);

// THEME — dark / light / system. 'system' is the default and is represented
// by the ABSENCE of data-theme (mobile.css's own prefers-color-scheme media
// query does all the work then, so it also live-updates for free if the OS
// theme changes mid-session, no listener needed). An explicit choice sets
// data-theme, which always wins over the OS signal — see the CSS at the top
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
// dark-mode-at-sunset) — the CSS media query repaints on its own, but the
// theme-color meta is JS-driven and needs its own nudge to follow along.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemeChoice() === 'system') syncThemeColorMeta();
  });
}

function endpoint(path) {
  let base = (state.baseUrl || location.origin).trim();
  if (base && !/^https?:\/\//i.test(base)) {
    base = `http://${base}`;
  }
  return `${base.replace(/\/$/, '')}${path}`;
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(endpoint(path), { ...options, headers, signal: controller.signal });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Could not reach your Craft PC. Check the address and that both devices are on the same Wi-Fi.' : 'Could not contact your Craft PC.');
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not contact your Craft PC.');
  return data;
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
  if (chip) chip.textContent = 'Craft Agent';
  if (dot) dot.style.background = online ? 'var(--green)' : 'var(--danger)';
  if (dot) dot.title = online ? 'Connected to your PC' : 'Reconnecting...';
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

// Just enough markdown to make agent replies readable on a phone screen —
// bold and line breaks. Escapes first so raw text can never inject markup.
function renderMarkdownLite(text) {
  return escapeHtml(text || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// Same two-layer ball+eyes mascot as the desktop app (see mascotHtml() in
// app.js) — served from the same /agent-mascots/<file> route on this same
// phone server, so there's nothing phone-specific to keep in sync here.
function mascotHtml(mascotFile, altText) {
  const delay = (-(Math.random() * 6)).toFixed(2) + 's';
  return `<span class="mascot">
    <img class="mascot-ball" src="/agent-mascots/${encodeURIComponent(mascotFile)}" alt="${escapeHtml(altText)}">
    <img class="mascot-eyes" src="/agent-mascots/eyes.png" alt="" style="animation-delay: ${delay}">
  </span>`;
}

// The phone side of desktop's subagent badge — fired for every turn
// (auto-picked specialist, a manual pin, or plain General) over the same
// SSE stream the phone already listens to for everything else.
function addSubagentBadge(data) {
  showChat();
  const el = document.createElement('div');
  el.className = 'subagent-badge';
  el.style.setProperty('--subagent-color', data.color || '');
  el.innerHTML =
    mascotHtml(data.mascot, data.name) +
    `<span class="subagent-badge-text"><strong>${escapeHtml(data.name)}</strong> · ${escapeHtml(data.tagline)}</span>`;
  $('chatFeed').append(el);
  scrollToBottom();
}

// AGENT VIEW — what dispatch_agent is currently running on the PC, phone
// version of desktop's Agent View modal (see openAgentViewModal/
// renderAgentsList in app.js). state.activeAgentSessions is kept live by the
// agents_status SSE event (see receiveEvent below); state.subagents is the
// static per-specialist metadata (mascot/color/tagline) fetched once at
// bootstrap.
function renderAgentViewBadge() {
  const badge = $('agentViewNavBadge');
  if (!badge) return;
  const n = state.activeAgentSessions.length;
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
}

function renderAgentsList() {
  const list = $('agentViewList');
  if (!list) return;
  list.innerHTML = '';
  if (!state.activeAgentSessions.length) {
    list.innerHTML = '<div class="agent-view-empty">No agents running right now.</div>';
    return;
  }
  for (const a of state.activeAgentSessions) {
    const spec = state.subagents.find((s) => s.id === a.subagentId);
    const row = document.createElement('div');
    row.className = 'agent-view-row';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.innerHTML = `
      ${spec ? mascotHtml(spec.mascot, spec.name) : '<span class="mascot"></span>'}
      <div class="agent-view-row-text">
        <strong>${escapeHtml(spec ? spec.name : 'General purpose')}</strong>
        <span>${escapeHtml(a.title || 'Working…')}</span>
      </div>
      <button type="button" class="agent-view-stop" aria-label="Stop this agent">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
      </button>
    `;
    row.addEventListener('click', () => { closeAgentView(); openSession(a.sessionId); });
    row.querySelector('.agent-view-stop').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await request('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId: a.sessionId }) });
      } catch (err) {
        addMessage('error', err.message);
      }
    });
    list.append(row);
  }
}

function openAgentView() {
  renderAgentsList();
  $('agentViewSheet').classList.remove('hidden');
}

function closeAgentView() {
  $('agentViewSheet').classList.add('hidden');
}

function addMessage(kind, text, label, screenshotSrc) {
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
    // A browser_check's screenshot, shown right in the chat — this phone
    // has no embedded browser of its own to preview the result in, so this
    // is the only way to actually see what got checked.
    if (screenshotSrc) {
      const img = document.createElement('img');
      img.className = 'tool-screenshot';
      img.src = screenshotSrc;
      img.alt = label || 'Browser check screenshot';
      el.appendChild(img);
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

function renderAccount(account) {
  state.account = account;
  const email = account?.email || 'Local Craft Desktop';
  const initial = email[0]?.toUpperCase() || 'C';
  
  if ($('accountEmail')) $('accountEmail').textContent = email;
  if ($('accountMode')) $('accountMode').textContent = account?.signedIn ? 'Signed in on PC' : 'Local Wi-Fi paired';
  if ($('accountInitial')) $('accountInitial').textContent = initial;
}

function renderSessions() {
  const list = $('sessionList');
  if (!list) return;
  list.innerHTML = '';
  
  const ordered = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  if ($('sessionCount')) $('sessionCount').textContent = ordered.length ? String(ordered.length) : '';

  for (const session of ordered) {
    // A <button> can't legally contain another <button> (the "..." menu
    // trigger), so this is a div acting as one — same trick as the topbar's
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

// Drives the title pill at the top of the chat tab — the phone's stand-in
// for a desktop sidebar's "which chat am I in" cue.
function syncChatTitle() {
  const el = $('chatTitlePill');
  if (!el) return;
  const current = state.sessionId && state.sessions.find((s) => s.id === state.sessionId);
  el.textContent = (current && current.title) || 'New chat';
}

function renderSession(session) {
  clearChat();
  state.sessionId = session.id;
  state.currentParentId = session.parentSessionId || null;
  const backBtn = $('backToMainBtn');
  if (backBtn) backBtn.classList.toggle('hidden', !state.currentParentId);
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
      else if (item.kind === 'assistant') addMessage('agent', item.text);
      else if (item.kind === 'tool') {
        const screenshotSrc = item.screenshotPath
          ? endpoint(`/api/screenshot?path=${encodeURIComponent(item.screenshotPath)}&token=${encodeURIComponent(state.token)}`)
          : undefined;
        addMessage('tool', item.label, item.name, screenshotSrc);
      }
      else if (item.kind === 'subagent_active') addSubagentBadge(item);
    }
    // Chat should always open scrolled to the newest message, not the top.
    scrollToBottom();
  } else {
    $('emptyState').classList.remove('hidden');
    $('chatFeed').classList.add('hidden');
  }
  renderSessions();

  // Re-sync the send/stop icon to what THIS session is actually doing right
  // now, from the live agents_status snapshot — not a hardcoded "not
  // running". Opening a chat dispatch_agent is still actively working on
  // used to always show Send here, wrong, until its own run_finished event
  // happened to arrive while you were looking at it.
  setRunning(state.activeAgentSessions.some((a) => a.sessionId === session.id));
}

async function openSession(id) {
  const session = await request(`/api/session?id=${encodeURIComponent(id)}`);
  renderSession(session);
  showScreen('chat');
}

async function bootstrap({ preserveSession = true } = {}) {
  const data = await request('/api/bootstrap');
  setConnection(data.device, true);
  renderAccount(data.account);
  renderProjects(data.projects, data.lastProject);
  state.sessions = data.sessions || [];
  state.subagents = data.subagents || [];
  state.activeAgentSessions = data.activeAgents || [];
  renderSessions();
  renderAgentViewBadge();

  showScreen('chat');

  const active = data.activeSessionIds?.[0];
  const target = preserveSession && state.sessionId ? state.sessionId : active || data.sessions?.[0]?.id;
  if (target && target !== state.sessionId) {
    await openSession(target);
  } else if (state.sessionId) {
    const current = data.sessions?.find((s) => s.id === state.sessionId);
    if (current) renderSession(current);
  }
  // Nothing to show at all — renderSession()'s own resync (which covers
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
  eventSource = new EventSource(endpoint(`/api/events?token=${encodeURIComponent(state.token)}`));

  eventSource.addEventListener('agent', (e) => {
    try { receiveEvent(JSON.parse(e.data)); } catch {}
  });

  eventSource.onopen = () => setConnection($('deviceName')?.textContent || 'PC', true);
  eventSource.onerror = () => setConnection('', false);
}

function receiveEvent(event) {
  if (event.type === 'session_sync') {
    mergeSession(event.session);
    // A brand-new chat's session id is only known once /api/send resolves,
    // which doesn't happen until the whole agent turn finishes — but the
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
      // An ephemeral dispatch_agent session cleaning itself up after
      // reporting back — jump to whichever chat dispatched it instead of
      // dropping you at the empty state, same as the desktop app.
      if (event.parentSessionId) {
        openSession(event.parentSessionId);
      } else {
        state.currentParentId = null;
        $('backToMainBtn')?.classList.add('hidden');
        clearChat();
        $('chatFeed').classList.add('hidden');
        $('emptyState').classList.remove('hidden');
      }
    }
    return;
  }

  // Not scoped to one chat — the live snapshot behind both the sidebar
  // badge and the Agent View sheet's list, and also what keeps the send/stop
  // icon honest for whatever chat is open right now (see renderSession).
  if (event.type === 'agents_status') {
    state.activeAgentSessions = event.active || [];
    renderAgentViewBadge();
    if (!$('agentViewSheet').classList.contains('hidden')) renderAgentsList();
    if (state.sessionId) {
      const isActive = state.activeAgentSessions.some((a) => a.sessionId === state.sessionId);
      if (isActive !== state.running) setRunning(isActive);
    }
    return;
  }

  if (event.sessionId !== state.sessionId) return;

  if (event.type === 'subagent_active') {
    addSubagentBadge(event);
  } else if (event.type === 'text') {
    addMessage('agent_delta', event.text);
  } else if (event.type === 'tool_end') {
    state.activeAgentMessageEl = null;
    addMessage('tool', event.summary || event.args?.path || event.args?.command || '', event.name || 'Executed', event.meta?.screenshotDataUrl);
  } else if (event.type === 'error') {
    state.activeAgentMessageEl = null;
    addMessage('error', event.error);
  } else if (event.type === 'approval_request') {
    showApproval(event);
  } else if (event.type === 'image_pick_request') {
    showImagePicker(event);
  } else if (event.type === 'approval_resolved') {
    // Answered from another device (e.g. the desktop app) — this client's
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
  } else if (event.type === 'done' || event.type === 'run_finished' || event.type === 'aborted') {
    state.activeAgentMessageEl = null;
    // If a run ends (especially aborted/stopped) while an approval sheet is
    // still up, the server auto-rejects the pending approval on its side but
    // never tells this client to close the sheet — it was otherwise only
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

// SESSION MENU — the phone's version of desktop's 3-dot chat menu
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
    state.currentParentId = null;
    $('backToMainBtn')?.classList.add('hidden');
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

// IMAGE PICKER — the phone side of the fetch_image approval the desktop
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

// Only two real screens now — chat and the paired-PC status screen.
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

// Shared by the manual form submit AND the QR auto-sync path below — both
// end at the exact same /api/pair call, they just differ in where the code
// and address came from.
async function attemptPair(code, baseUrl) {
  state.baseUrl = (baseUrl || $('desktopUrl').value.trim()).replace(/\/$/, '');
  const data = await request('/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  state.token = data.token;
  localStorage.setItem('craft-token', state.token);
  localStorage.setItem('craft-host', state.baseUrl);

  $('pairScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  await bootstrap({ preserveSession: false });
  connectEvents();
}

// EVENT LISTENERS
$('pairForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('pairError');
  error.classList.add('hidden');
  try {
    await attemptPair($('pairCode').value.trim());
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});

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
  // to answer) finishes, so waiting for it here — like this used to — meant
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
        bypass: false,
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

// SIDEBAR DRAWER — opened from the topbar hamburger; closed by its X,
// tapping the backdrop, or by any nav item inside it once it's done its
// job (new chat, opening a session).
$('sidebarOpenBtn').addEventListener('click', openSidebar);
$('sidebarCloseBtn').addEventListener('click', closeSidebar);
$('sidebarBackdrop').addEventListener('click', closeSidebar);

$('sidebarNewChatBtn').addEventListener('click', () => {
  state.sessionId = null;
  state.currentParentId = null;
  $('backToMainBtn').classList.add('hidden');
  clearChat();
  $('chatFeed').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  renderSessions();
  syncChatTitle();
  closeSidebar();
});

$('sidebarAgentViewBtn').addEventListener('click', () => { closeSidebar(); openAgentView(); });
$('agentViewSheetBackdrop').addEventListener('click', closeAgentView);
$('backToMainBtn').addEventListener('click', () => {
  if (state.currentParentId) openSession(state.currentParentId);
});

document.querySelectorAll('.theme-opt').forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
});
syncThemeColorMeta();
syncThemeToggleUI();

if ($('unpairBtn')) {
  $('unpairBtn').addEventListener('click', () => {
    localStorage.removeItem('craft-token');
    state.token = null;
    $('pairScreen').classList.remove('hidden');
    $('appScreen').classList.add('hidden');
    closeSidebar();
  });
}

// Picking a folder updates the topbar pill immediately — renderProjects()
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

if (isHosted) {
  $('desktopUrl').value = location.origin;
}

// The QR in Craft's desktop "Use from phone" panel encodes this device's own
// address WITH the code already in it (?code=1234) — scanning it and opening
// the link is the entire pairing flow, no address or code ever gets typed.
// The manual form (baseUrl input + digits) stays underneath as the fallback
// for when a phone can't or won't scan.
const scannedCode = new URLSearchParams(location.search).get('code');

if (state.token && state.baseUrl) {
  $('pairScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  bootstrap({ preserveSession: false })
    .then(connectEvents)
    .catch(() => {
      localStorage.removeItem('craft-token');
      state.token = null;
      $('pairScreen').classList.remove('hidden');
      $('appScreen').classList.add('hidden');
    });
} else if (scannedCode) {
  $('pairCode').value = scannedCode;
  $('pairForm').classList.add('hidden');
  $('pairSyncing').classList.remove('hidden');
  attemptPair(scannedCode, location.origin).catch((err) => {
    $('pairSyncing').classList.add('hidden');
    $('pairForm').classList.remove('hidden');
    const error = $('pairError');
    error.textContent = err.message;
    error.classList.remove('hidden');
  });
}
