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
  account: null,
  activeAgentMessageEl: null,
};

localStorage.setItem('craft-client-id', state.clientId);

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
  if (chip) chip.textContent = online ? (name ? `${name} online` : 'PC online') : 'Reconnecting...';
  if (dot) dot.style.background = online ? 'var(--green)' : 'var(--danger)';
  const hostEl = $('desktopHost');
  if (hostEl) hostEl.textContent = state.baseUrl || (online ? 'Local PC' : 'Disconnected');
}

function setRunning(running, detail) {
  state.running = running;
  const stopBtn = $('stopBtn');
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
  
  const pulse = $('presencePulse');
  if (pulse) pulse.style.background = running ? 'var(--violet-light)' : 'var(--green)';

  if (running) {
    $('runTitle').textContent = 'Craft is executing';
    $('runDetail').textContent = detail || 'Live from your desktop agent';
    $('chatBadge').classList.remove('hidden');
  } else {
    $('chatBadge').classList.add('hidden');
    if (state.sessionId) {
      $('runTitle').textContent = 'Ready on Desktop';
      $('runDetail').textContent = detail || 'Standing by for instructions';
    }
  }
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

function addMessage(kind, text, label) {
  showChat();
  const feed = $('chatFeed');

  if (kind === 'agent_delta') {
    if (!state.activeAgentMessageEl) {
      const el = document.createElement('article');
      el.className = 'message-bubble agent';
      el.textContent = text || '';
      feed.append(el);
      state.activeAgentMessageEl = el;
    } else {
      state.activeAgentMessageEl.textContent += text || '';
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
  } else {
    el.textContent = text || '';
  }

  feed.append(el);
  scrollToBottom();
  return el;
}

function clearChat() {
  $('chatFeed').innerHTML = '';
  state.activeAgentMessageEl = null;
}

function relativeTime(time) {
  const age = Math.max(0, Date.now() - Number(time || 0));
  if (age < 60000) return 'just now';
  if (age < 3600000) return `${Math.floor(age / 60000)}m ago`;
  if (age < 86400000) return `${Math.floor(age / 3600000)}h ago`;
  return `${Math.floor(age / 86400000)}d ago`;
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
}

function renderAccount(account) {
  state.account = account;
  const email = account?.email || 'Local Craft Desktop';
  const initial = email[0]?.toUpperCase() || 'C';
  
  if ($('accountEmail')) $('accountEmail').textContent = email;
  if ($('accountMode')) $('accountMode').textContent = account?.signedIn ? 'Signed in on PC' : 'Local Wi-Fi paired';
  if ($('accountInitial')) $('accountInitial').textContent = initial;
  if ($('avatarChar')) $('avatarChar').textContent = initial;
}

function renderSessions() {
  const list = $('sessionList');
  if (!list) return;
  list.innerHTML = '';
  
  const ordered = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  if ($('sessionCount')) $('sessionCount').textContent = ordered.length;

  for (const session of ordered) {
    const card = document.createElement('button');
    card.className = `session-card${session.id === state.sessionId ? ' active' : ''}`;
    card.innerHTML = `
      <div class="session-card-top">
        <strong>${escapeHtml(session.title || 'Untitled task')}</strong>
        <time>${relativeTime(session.updatedAt)}</time>
      </div>
      <p>${escapeHtml(session.preview || basename(session.cwd))}</p>
    `;
    card.addEventListener('click', () => openSession(session.id));
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
      else if (item.kind === 'tool') addMessage('tool', item.label, item.name);
    }
    // Chat should always open scrolled to the newest message, not the top.
    scrollToBottom();
  } else {
    $('emptyState').classList.remove('hidden');
    $('chatFeed').classList.add('hidden');
  }
  renderSessions();
}

async function openSession(id) {
  const session = await request(`/api/session?id=${encodeURIComponent(id)}`);
  renderSession(session);
  switchTab('chat');
  setRunning(false, 'Session loaded from desktop');
}

async function bootstrap({ preserveSession = true } = {}) {
  const data = await request('/api/bootstrap');
  setConnection(data.device, true);
  renderAccount(data.account);
  renderProjects(data.projects, data.lastProject);
  state.sessions = data.sessions || [];
  renderSessions();

  switchTab('chat');

  const active = data.activeSessionIds?.[0];
  const target = preserveSession && state.sessionId ? state.sessionId : active || data.sessions?.[0]?.id;
  if (target && target !== state.sessionId) {
    await openSession(target);
  } else if (state.sessionId) {
    const current = data.sessions?.find((s) => s.id === state.sessionId);
    if (current) renderSession(current);
  }
  setRunning(Boolean(active && active === state.sessionId));
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

  if (event.sessionId !== state.sessionId) return;

  if (event.type === 'text') {
    addMessage('agent_delta', event.text);
  } else if (event.type === 'tool_end') {
    state.activeAgentMessageEl = null;
    addMessage('tool', event.summary || event.args?.path || event.args?.command || '', event.name || 'Executed');
  } else if (event.type === 'error') {
    state.activeAgentMessageEl = null;
    addMessage('error', event.error);
  } else if (event.type === 'approval_request') {
    showApproval(event);
  } else if (event.type === 'approval_resolved') {
    // Answered from another device (e.g. the desktop app) — this client's
    // own tap already hides the sheet locally, so this only matters when
    // it's the request THIS device didn't answer.
    if (state.approval && state.approval.requestId === event.requestId) {
      state.approval = null;
      $('approvalSheet').classList.add('hidden');
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

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  $('chatPanel').classList.toggle('hidden', tab !== 'chat');
  $('sessionsPanel').classList.toggle('hidden', tab !== 'sessions');
  const desktopPanel = $('desktopPanel');
  if (desktopPanel) desktopPanel.classList.toggle('hidden', tab !== 'desktop');
  // The chat tab is the one screen styled light (see mobile.css) — everything
  // around it (topbar, nav, this class's own scroll container/composer
  // backdrop) stays dark, so only it needs to know which mode it's in.
  document.body.classList.toggle('chat-active', tab === 'chat');
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
  const input = $('taskInput');
  const text = input.value.trim();
  const cwd = $('projectSelect').value;

  if (!text || state.running) return;

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

$('stopBtn').addEventListener('click', async () => {
  if (state.sessionId) {
    await request('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId }) });
  }
});

$('approveBtn').addEventListener('click', () => answerApproval('once'));
$('rejectBtn').addEventListener('click', () => answerApproval('reject'));

$('refreshBtn').addEventListener('click', () => bootstrap().catch(() => setConnection('', false)));

$('accountBtn').addEventListener('click', () => $('accountStrip').classList.toggle('open'));

if ($('unpairBtn')) {
  $('unpairBtn').addEventListener('click', () => {
    localStorage.removeItem('craft-token');
    state.token = null;
    $('pairScreen').classList.remove('hidden');
    $('appScreen').classList.add('hidden');
    $('accountStrip').classList.remove('open');
  });
}

$('homeBtn').addEventListener('click', () => {
  state.sessionId = null;
  clearChat();
  $('chatFeed').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  renderSessions();
  syncChatTitle();
  switchTab('chat');
});

$('chatSidebarBtn').addEventListener('click', () => switchTab('sessions'));

$('modeBtn').addEventListener('click', () => {
  const modes = ['Build', 'Plan', 'Ask'];
  state.mode = modes[(modes.indexOf(state.mode) + 1) % modes.length];
  $('modeText').textContent = state.mode;
  if ($('activeModeName')) $('activeModeName').textContent = state.mode;
});

document.querySelectorAll('[data-tab]').forEach((button) => {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
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
