/* ============ Codeply Craft - renderer ============ */

// NOTE: the preload bridge is window.craft - exposed via contextBridge it is a
// non-configurable global, so a top-level `const craft` here is a SyntaxError.
// Hence the different local name.
const api = window.craft || null;

const $ = (id) => document.getElementById(id);

// ─── Dialogs (one modal component for every popup) ──────────────────────────
// Every .modal-backdrop goes through here, so they all behave the same way:
// Esc closes the top one, Tab stays inside it, focus goes back to whatever
// opened it, and closing plays a short exit (styles.css .is-closing, off
// under prefers-reduced-motion) before .hidden goes back on. Dialogs that
// bots-ui.js and cloud-ui.js toggle with .hidden themselves are picked up by
// the observer below, so they get the focus handling too.
const CraftModal = (() => {
  const stack = []; // { el, onClose, returnTo }
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const elOf = (x) => (typeof x === 'string' ? $(x) : x);
  const entryOf = (el) => stack.find((e) => e.el === el);
  const visible = (el) => el && !el.classList.contains('hidden') && el.isConnected;

  function focusInside(el) {
    const panel = el.firstElementChild || el;
    const target = panel.querySelector('[autofocus]') || panel.querySelector('input:not([type="checkbox"]):not([disabled]), textarea:not([disabled])') ||
      panel.querySelector('.modal-footer .btn-primary') || panel;
    // No field to type in: focus the dialog itself, so Tab starts inside it
    // without a ring landing on the close button.
    if (target === panel && !panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }

  function track(el, onClose) {
    let e = entryOf(el);
    if (!e) {
      const active = document.activeElement;
      e = { el, onClose: null, returnTo: active && active !== document.body ? active : null };
      stack.push(e);
      requestAnimationFrame(() => { if (!el.contains(document.activeElement)) focusInside(el); });
    }
    if (onClose) e.onClose = onClose;
    return e;
  }

  function untrack(el) {
    const i = stack.findIndex((e) => e.el === el);
    if (i < 0) return;
    const [e] = stack.splice(i, 1);
    if (e.returnTo && e.returnTo.isConnected && (!document.activeElement || document.activeElement === document.body || el.contains(document.activeElement))) {
      e.returnTo.focus({ preventScroll: true });
    }
  }

  /** Shows a dialog. onClose is what Esc and the backdrop run (defaults to close). */
  function open(x, { onClose } = {}) {
    const el = elOf(x);
    if (!el) return;
    el.classList.remove('is-closing');
    el.classList.remove('hidden');
    track(el, onClose).own = true;
  }

  /** Hides a dialog with its exit animation. */
  function close(x) {
    const el = elOf(x);
    if (!el || el.classList.contains('hidden')) return Promise.resolve();
    untrack(el);
    if (reduced()) { el.classList.add('hidden'); return Promise.resolve(); }
    el.classList.add('is-closing');
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        // Reopened while it was still fading out: leave it open.
        if (el.classList.contains('is-closing')) { el.classList.remove('is-closing'); el.classList.add('hidden'); }
        resolve();
      };
      el.addEventListener('animationend', (ev) => { if (ev.target === el) finish(); }, { once: true });
      setTimeout(finish, 220);
    });
  }

  const isOpen = (x) => visible(elOf(x));
  const dismiss = (e) => (e.onClose ? e.onClose() : close(e.el));

  document.addEventListener('keydown', (ev) => {
    const top = [...stack].reverse().find((e) => visible(e.el));
    if (!top) return;
    if (ev.key === 'Escape') {
      // bots-ui.js / cloud-ui.js handle Esc for their own dialogs.
      if (!top.onClose && !top.own) return;
      ev.preventDefault();
      ev.stopPropagation();
      dismiss(top);
    } else if (ev.key === 'Tab') {
      const items = [...top.el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) { ev.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!top.el.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
      else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  }, true);

  // Dialogs shown or hidden by other scripts (bots, cloud) still get focus
  // moved in and handed back.
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target;
      if (!el.classList || !el.classList.contains('modal-backdrop')) continue;
      if (visible(el) && !el.classList.contains('is-closing')) track(el);
      else if (el.classList.contains('hidden')) untrack(el);
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

  /**
   * A small confirm dialog. Resolves { ok, checked } (checked is the
   * optional checkbox), or ok: false when cancelled.
   */
  function confirmDialog({ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, checkbox = null, alertOnly = false }) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'modal-backdrop hidden';
      el.innerHTML = `
        <div class="modal modal-sm" role="${alertOnly ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="cmTitle" aria-describedby="cmBody">
          <div class="modal-header"><div><div class="modal-title" id="cmTitle"></div><div class="modal-desc" id="cmBody"></div></div></div>
          ${checkbox ? '<div class="modal-body"><label class="modal-check"><input type="checkbox"><span><span data-role="label"></span><small data-role="note"></small></span></label></div>' : ''}
          <div class="modal-footer">
            ${alertOnly ? '' : '<button class="btn btn-secondary" data-act="cancel"></button>'}
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok"></button>
          </div>
        </div>`;
      el.querySelector('#cmTitle').textContent = title;
      el.querySelector('#cmBody').textContent = body;
      el.querySelector('#cmTitle').removeAttribute('id');
      el.querySelector('#cmBody').removeAttribute('id');
      const okBtn = el.querySelector('[data-act="ok"]');
      okBtn.textContent = confirmLabel;
      const cancelBtn = el.querySelector('[data-act="cancel"]');
      if (cancelBtn) cancelBtn.textContent = cancelLabel;
      const box = el.querySelector('.modal-check input');
      if (checkbox) {
        box.checked = checkbox.checked !== false;
        el.querySelector('[data-role="label"]').textContent = checkbox.label;
        el.querySelector('[data-role="note"]').textContent = checkbox.note || '';
      }
      document.body.appendChild(el);
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        close(el).then(() => el.remove());
        resolve({ ok, checked: box ? box.checked : false });
      };
      el.addEventListener('click', (ev) => { if (ev.target === el) finish(alertOnly); });
      okBtn.addEventListener('click', () => finish(true));
      if (cancelBtn) cancelBtn.addEventListener('click', () => finish(false));
      open(el, { onClose: () => finish(alertOnly) });
      // A destructive choice never sits on Enter by default.
      requestAnimationFrame(() => ((danger && cancelBtn) || okBtn).focus({ preventScroll: true }));
    });
  }

  const alertDialog = ({ title, body = '', confirmLabel = 'OK' }) => confirmDialog({ title, body, confirmLabel, alertOnly: true });

  return { open, close, isOpen, confirm: confirmDialog, alert: alertDialog };
})();
window.CraftModal = CraftModal;

// Identifies this window as the sender of a message, mirroring mobile.js's
// clientId - lets the 'session_sync' handler below tell "a message I just
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

// THEME - dark / light / system, mirroring mobile.js exactly (down to the
// storage key's meaning, though not its name - this is a separate window
// with its own localStorage, so there's no actual sharing between the two).
// 'system' is the absence of data-theme: styles.css's own
// prefers-color-scheme media query does the work then, live-updating for
// free if the OS theme changes mid-session. An explicit choice always wins
// over that - see styles.css's :root for both sides of it. The inline
// script in index.html's <head> applies a stored explicit choice before
// first paint, so this only has to keep things in sync after that.
function getThemeChoice() {
  const t = localStorage.getItem('craft-desktop-theme');
  return t === 'dark' || t === 'light' ? t : 'system';
}
function applyTheme(choice) {
  if (choice === 'system') {
    localStorage.removeItem('craft-desktop-theme');
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem('craft-desktop-theme', choice);
    document.documentElement.dataset.theme = choice;
  }
  syncThemeToggleUI();
}
function syncThemeToggleUI() {
  const active = getThemeChoice();
  document.querySelectorAll('.theme-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeChoice === active);
  });
}

// Chats whose run was stopped here: the screen settles at once, and what the
// engine still reports for that run is dropped until it says the run ended.
const stoppedRuns = new Set();

const state = {
  user: null,
  chatgpt: { signedIn: false }, // Sign in with ChatGPT: { signedIn, email, sharing }
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
  models: { selected: 'auto', models: [] }, // "Auto" + the user's own models (keys never reach the renderer)
  runningSessions: [], // chat ids with a run in flight - pushed live via runs:status
};

// ─── Window controls ────────────────────────────────────────────────────────
$('winMin').addEventListener('click', () => api && api.minimize());
$('winMax').addEventListener('click', () => api && api.maximize());
$('winClose').addEventListener('click', () => api ? api.close() : window.close());

// Swap the maximize button between "maximize" (single square) and "restore"
// (overlapping squares) so it always reflects the window's real state,
// matching native Windows title bar conventions - instead of a static icon
// that's wrong half the time (the window launches maximized already).
function setMaxIcon(maximized) {
  const btn = $('winMax');
  btn.title = maximized ? 'Restore' : 'Maximize';
  btn.innerHTML = maximized
    ? '<svg viewBox="0 0 12 12"><rect x="2" y="3.5" width="6.5" height="6.5" rx="1"/><path d="M4 3.5V2.5h5.5V8H8.5"/></svg>'
    : '<svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg>';
}
if (api) {
  api.getWinState().then((s) => setMaxIcon(!!s.maximized));
  api.onWinState((s) => setMaxIcon(!!s.maximized));
}
// The expand button lives in the titlebar, OUTSIDE the sidebar itself - it
// has to, since the whole point is reaching it after the sidebar (and the
// collapse button living inside it) has slid off-screen.
function setSidebarCollapsed(collapsed) {
  const hadFocus = $('sidebar').contains(document.activeElement);
  $('sidebar').classList.toggle('collapsed', collapsed);
  $('sidebar').inert = collapsed; // off-screen rows stay out of the Tab order
  if (collapsed && hadFocus) $('sidebarExpandBtn').focus();
}
const toggleSidebar = () => setSidebarCollapsed(!$('sidebar').classList.contains('collapsed'));
$('sidebarToggle').addEventListener('click', () => setSidebarCollapsed(true));
$('sidebarExpandBtn').addEventListener('click', toggleSidebar);

// ─── Back / forward between home and chats (the title bar arrows) ───────────
const nav = { stack: [], at: -1, moving: false };
function navRecord(place) {
  if (nav.moving) return;
  if (nav.stack[nav.at] === place) return;
  nav.stack = nav.stack.slice(0, nav.at + 1);
  nav.stack.push(place);
  if (nav.stack.length > 100) nav.stack.shift();
  nav.at = nav.stack.length - 1;
  navPaint();
}
function navPaint() {
  $('navBack').disabled = nav.at <= 0;
  $('navForward').disabled = nav.at >= nav.stack.length - 1;
}
async function navGo(step) {
  const to = nav.at + step;
  if (to < 0 || to >= nav.stack.length) return;
  nav.at = to; nav.moving = true;
  try {
    const place = nav.stack[to];
    if (place === 'home') $('newChatBtn').click();
    else await openSession(place.slice(2));
  } finally { nav.moving = false; navPaint(); }
}
$('navBack').addEventListener('click', () => navGo(-1));
$('navForward').addEventListener('click', () => navGo(1));

// ─── File / Edit / View / Help (the title bar menus) ────────────────────────
let tbPop = null;
let tbSub = null; // File / Edit / View / Help, opened from the ≡ menu
function closeTbSub() { if (tbSub) { tbSub.remove(); tbSub = null; } document.querySelectorAll('.tb-pop .menu-item.open').forEach((b) => b.classList.remove('open')); }
function closeTbMenu() {
  closeTbSub();
  if (tbPop) { tbPop.remove(); tbPop = null; }
  document.querySelectorAll('.tb-menu.open').forEach((b) => b.classList.remove('open'));
}
const ZOOM_KEY = 'codeply.zoom';
function setZoom(z) {
  z = Math.min(1.6, Math.max(0.7, Math.round(z * 10) / 10));
  document.documentElement.style.zoom = z === 1 ? '' : String(z);
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch {}
}
try { const z = Number(localStorage.getItem(ZOOM_KEY)); if (z && z !== 1) setZoom(z); } catch {}
const currentZoom = () => Number(document.documentElement.style.zoom) || 1;
const editCmd = (cmd) => () => document.execCommand(cmd);
function tbMenuItems(name) {
  const signedIn = !!state.user;
  if (name === 'file') return [
    ['New chat', 'Ctrl+N', () => $('newChatBtn').click(), !signedIn],
    ['Open folder…', 'Ctrl+O', () => $('openProjectBtn').click(), !signedIn],
    null,
    ['Connect apps', '', () => openConnectApps(), !signedIn],
    ['Use from your phone', '', () => openRemoteModal(), !signedIn],
    null,
    ['Close window', 'Alt+F4', () => api && api.close()],
  ];
  if (name === 'edit') return [
    ['Undo', 'Ctrl+Z', editCmd('undo')], ['Redo', 'Ctrl+Y', editCmd('redo')], null,
    ['Cut', 'Ctrl+X', editCmd('cut')], ['Copy', 'Ctrl+C', editCmd('copy')], ['Paste', 'Ctrl+V', editCmd('paste')], null,
    ['Select all', 'Ctrl+A', editCmd('selectAll')],
  ];
  if (name === 'view') return [
    ['Toggle sidebar', 'Ctrl+B', toggleSidebar],
    ['Toggle browser panel', '', () => document.querySelector('.browser-toggle-btn')?.click()],
    null,
    ['Zoom in', 'Ctrl+=', () => setZoom(currentZoom() + 0.1)],
    ['Zoom out', 'Ctrl+-', () => setZoom(currentZoom() - 0.1)],
    ['Actual size', 'Ctrl+0', () => setZoom(1)],
  ];
  return [
    ['Codeply website', '', () => api && api.openExternal('https://codeply.app')],
    ['Report a problem', '', () => api && api.openExternal('https://github.com/AwaisSDev/Codeply-Craft/issues')],
  ];
}
const TB_SUBS = [['file', 'File'], ['edit', 'Edit'], ['view', 'View'], ['help', 'Help']];
function openTbSub(row, name) {
  if (row.classList.contains('open')) return;
  closeTbSub();
  const sub = tbMenuPop(tbMenuItems(name));
  sub.classList.add('tb-sub');
  document.body.appendChild(sub);
  const r = row.getBoundingClientRect();
  sub.style.left = (r.right + 4) + 'px';
  sub.style.top = (r.top - 6) + 'px';
  row.classList.add('open');
  tbSub = sub;
}
function tbMenuPop(items) {
  const pop = document.createElement('div');
  pop.className = 'menu tb-pop';
  for (const it of items) {
    if (!it) { pop.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' })); continue; }
    const [label, keys, run, off] = it;
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.disabled = !!off;
    b.innerHTML = `<span>${esc(label)}</span>${keys ? `<kbd>${esc(keys)}</kbd>` : ''}`;
    // keep focus in the text box, so Cut / Copy / Paste act on it
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { closeTbMenu(); run(); });
    b.addEventListener('mouseenter', () => { if (tbSub && !tbSub.contains(b)) closeTbSub(); });
    pop.appendChild(b);
  }
  return pop;
}
function openTbMenu(btn) {
  const same = btn.classList.contains('open');
  closeTbMenu();
  if (same) return;
  let pop;
  if (btn.dataset.menu === 'all') {
    // The ≡ menu: four rows, each opening its own menu to the side.
    pop = document.createElement('div');
    pop.className = 'menu tb-pop tb-root';
    for (const [name, label] of TB_SUBS) {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.innerHTML = `<span>${esc(label)}</span><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('mouseenter', () => openTbSub(b, name));
      b.addEventListener('click', (e) => { e.stopPropagation(); openTbSub(b, name); });
      pop.appendChild(b);
    }
  } else pop = tbMenuPop(tbMenuItems(btn.dataset.menu));
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = r.left + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  btn.classList.add('open');
  tbPop = pop;
}
document.querySelectorAll('.tb-menu').forEach((b) => {
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { e.stopPropagation(); openTbMenu(b); });
  // moving across the bar while a menu is open switches menus, like a native menu bar
  b.addEventListener('mouseenter', () => { if (tbPop && !b.classList.contains('open')) openTbMenu(b); });
});
document.addEventListener('click', (e) => { if (tbPop && !tbPop.contains(e.target) && !(tbSub && tbSub.contains(e.target))) closeTbMenu(); });
window.addEventListener('blur', closeTbMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tbPop) { closeTbMenu(); return; }
  if (e.altKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); navGo(e.key === 'ArrowLeft' ? -1 : 1); return; }
  if (!e.ctrlKey || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (k === 'n' && state.user) { e.preventDefault(); $('newChatBtn').click(); }
  else if (k === 'o' && state.user) { e.preventDefault(); $('openProjectBtn').click(); }
  else if (k === 'k' && state.user) { e.preventDefault(); sbOpenSearch(); }
  else if (k === '=' || k === '+') { e.preventDefault(); setZoom(currentZoom() + 0.1); }
  else if (k === '-') { e.preventDefault(); setZoom(currentZoom() - 0.1); }
  else if (k === '0') { e.preventDefault(); setZoom(1); }
});

// ─── View switching ─────────────────────────────────────────────────────────
const VIEWS = ['viewLogin', 'viewReferral', 'viewCountry', 'viewHome', 'viewChat', 'viewEngineError'];

// Home and chat are gated behind sign-in - nothing usable happens until the
// account flow completes, no matter how a view swap was triggered (New chat,
// a suggestion card, reopening a session, ...). One choke point here instead
// of a check sprinkled at every call site.
function showView(name) {
  if ((name === 'viewHome' || name === 'viewChat') && !state.user) name = 'viewLogin';
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== name);
  if (name === 'viewHome') navRecord('home');
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

// ─── Background commands ────────────────────────────────────────────────────
// Commands the agent started with run background=true (dev servers, watchers).
// A quiet strip behind the composer says how many run and opens the
// Background tasks panel on the right (Running, then Finished), like
// Claude's: each row has its time and a stop square, and opens to its
// latest output.
const jobsBar = $('jobsBar');
let jobsList = [];
let jobsTimer = null;
let jobsFinishedOpen = false;
const jobsOpenRows = new Set(); // ids whose output is showing

/** "6s", "5m 56s", "1h 4m". */
function jobElapsed(j) {
  const s = Math.max(0, Math.round(((j.endedAt || Date.now()) - (j.startedAt || Date.now())) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function renderJobs() {
  if (!jobsBar) return;
  const running = jobsList.filter((j) => j.running);
  // The strip is about this run; earlier runs' tasks wait in the column (header button).
  const current = jobsList.filter((j) => !j.past);
  jobsBar.classList.toggle('hidden', !current.length);
  const title = running.length
    ? `${running.length} command${running.length === 1 ? '' : 's'} running in the background`
    : `${current.length} background command${current.length === 1 ? '' : 's'} finished`;
  jobsBar.innerHTML =
    `<div class="jobs-head-row"><button class="jobs-head" type="button" title="Show background tasks"><span class="jobs-title">${esc(title)}</span><svg class="tool-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></div>`;
  jobsBar.querySelector('.jobs-head').addEventListener('click', () => openBgTasks());
  renderBgTasks();
}

const BGT_CHEV = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
function bgTaskRow(j) {
  const open = jobsOpenRows.has(j.id);
  // How it ended: done, failed (its exit code), stopped by you, or interrupted
  // (it was running when Craft closed); kept across restarts by main.js.
  const status = j.status || (j.running ? 'running' : j.code ? 'failed' : 'done');
  const word = status === 'failed' ? `exit ${esc(String(j.code))}` : status;
  const end = j.running
    ? `<span class="bgt-time">${jobElapsed(j)}</span><button class="bgt-stop" type="button" data-stop="${esc(j.id)}" title="Stop" aria-label="Stop ${esc(j.command)}"></button>`
    : `<span class="bgt-time">${jobElapsed(j)}</span><span class="bgt-exit bgt-${status}">${word}</span>`;
  return `<div class="bgt-row"><button class="bgt-main" type="button" data-toggle="${esc(j.id)}" aria-expanded="${open}" title="${esc(j.command)}"><span class="bgt-name">${esc(j.command)}</span></button>${end}</div>` +
    `<pre class="bgt-out${open ? '' : ' hidden'}" data-out="${esc(j.id)}"></pre>`;
}

/** The Background tasks panel's list, kept current while it is open. */
function renderBgTasks() {
  const body = $('bgTasksBody');
  if (!body || $('bgTasksPanel').classList.contains('hidden')) { clearInterval(jobsTimer); jobsTimer = null; return; }
  const running = jobsList.filter((j) => j.running);
  const finished = jobsList.filter((j) => !j.running).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  body.innerHTML = (!jobsList.length ? '<div class="bgt-empty">Nothing running in the background.</div>' : '') +
    (running.length ? `<div class="bgt-label">Running ${running.length}</div>${running.map(bgTaskRow).join('')}` : '') +
    (finished.length ? `<button class="bgt-label${jobsFinishedOpen ? ' open' : ''}" type="button" data-fold="1" aria-expanded="${jobsFinishedOpen}">Finished ${finished.length} ${BGT_CHEV}</button>` +
      (jobsFinishedOpen ? finished.map(bgTaskRow).join('') : '') : '');
  $('bgTasksClearBtn').disabled = !finished.length;
  clearInterval(jobsTimer);
  jobsTimer = running.length ? setInterval(() => { tickBgTasks(); fillJobOutputs(); }, 1000) : null;
  fillJobOutputs();
}

/** Only the times move each second; the rows stay put so clicks and scroll aren't lost. */
function tickBgTasks() {
  const body = $('bgTasksBody');
  if (!body) return;
  body.querySelectorAll('.bgt-row').forEach((row) => {
    const id = row.querySelector('[data-toggle]')?.dataset.toggle;
    const j = jobsList.find((x) => x.id === id);
    const t = row.querySelector('.bgt-time');
    if (j && t && j.running) t.textContent = jobElapsed(j);
  });
}

if ($('bgTasksBody')) {
  $('bgTasksBody').addEventListener('click', (e) => {
    const stop = e.target.closest('[data-stop]');
    if (stop) { stop.disabled = true; window.craft.jobsStop(stop.dataset.stop); return; }
    if (e.target.closest('[data-fold]')) { jobsFinishedOpen = !jobsFinishedOpen; renderBgTasks(); return; }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle;
      if (jobsOpenRows.has(id)) jobsOpenRows.delete(id); else jobsOpenRows.add(id);
      renderBgTasks();
    }
  });
  $('bgTasksClearBtn').addEventListener('click', async () => { jobsList = await window.craft.jobsClear(); renderJobs(); });
  $('bgTasksCloseBtn').addEventListener('click', () => closeBgTasks());
}

async function fillJobOutputs() {
  const panel = $('bgTasksBody');
  if (!panel) return;
  for (const pre of panel.querySelectorAll('[data-out]:not(.hidden)')) {
    const text = String(await window.craft.jobsOutput(pre.dataset.out)).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd().slice(-4000);
    if (pre.textContent === text) continue;
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = text;
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
}

if (window.craft && window.craft.jobsList) {
  window.craft.jobsList().then((list) => { jobsList = list || []; renderJobs(); }).catch(() => {});
  window.craft.onJobsChanged((list) => { jobsList = list || []; renderJobs(); });
}

// ─── Chat rendering ─────────────────────────────────────────────────────────
const chatColumn = $('chatColumn');
const chatScroll = $('chatScroll');

const TOOL_DISPLAY = {
  todo: 'Updated task list', ask_user: 'Asked you', mcp: 'Used',
  list_dir: 'Listed', read_file: 'Read', write_file: 'Wrote', edit_file: 'Edited',
  search: 'Searched', image_search: 'Searched images for', web_search: 'Searched the web for', run: 'Ran', job: 'Checked background job', use_skill: 'Loaded skill', list_skills: 'Searched skills',
  fetch_image: 'Downloaded', browser_check: 'Checked',
  gmail_send: 'Emailed', gmail_search: 'Searched Gmail', slack_post_message: 'Posted',
  vercel_deploy: 'Deployed', supabase_create_project: 'Provisioned', supabase_delete_project: 'Deleted', github_create_repo: 'Pushed',
  supabase_api: 'Supabase', supabase_sql: 'Ran SQL', vercel_api: 'Vercel',
  publish_check: 'Checked for publishing', publish_connect: 'Connect', supabase_setup: 'Set up database', supabase_schema: 'Applied schema', publish_deploy: 'Published', publish_github: 'Pushed to GitHub',
  design_reference_search: 'Searched design library', view_images: 'Viewed', look_at_screen: 'Looked at your screen',
};

// Human-readable tool names for approval UI - never show the raw
// underscored identifier (write_file, fetch_image, ...) to the user.
const TOOL_NAME = {
  todo: 'update task list', ask_user: 'ask you', mcp: 'MCP tools',
  list_dir: 'list directory', read_file: 'read file', write_file: 'write file',
  edit_file: 'edit file', search: 'search', run: 'run command',
  use_skill: 'use skill', list_skills: 'list skills', fetch_image: 'download image',
  browser_check: 'check in browser',
  gmail_send: 'send email', gmail_search: 'search Gmail', slack_post_message: 'post to Slack',
  vercel_deploy: 'deploy to Vercel', supabase_create_project: 'create Supabase project',
  supabase_delete_project: 'delete Supabase project',
  github_create_repo: 'create GitHub repo',
  supabase_api: 'change Supabase', supabase_sql: 'run SQL on Supabase', vercel_api: 'change Vercel',
  supabase_setup: 'set up the Supabase database', supabase_schema: 'run SQL on Supabase', publish_deploy: 'publish to Vercel', publish_github: 'push to GitHub and link Vercel',
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
  vercel: '<svg viewBox="0 0 24 24"><path d="M12 3l9 16H3Z"/></svg>',
  database: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  github: '<svg viewBox="0 0 24 24"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55 0-.27-.01-1.16-.02-2.11-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.34.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.07.78 2.15 0 1.55-.01 2.8-.01 3.18 0 .3.2.66.79.55A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg>',
  agent: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
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
  if (name === 'vercel_deploy') return TOOL_ICON.vercel;
  if (name === 'supabase_create_project' || name === 'supabase_delete_project' || name === 'supabase_api' || name === 'supabase_sql') return TOOL_ICON.database;
  if (name === 'vercel_api') return TOOL_ICON.vercel;
  if (name === 'github_create_repo') return TOOL_ICON.github;
  if (name === 'view_images') return TOOL_ICON.image;
  if (name === 'design_reference_search') return TOOL_ICON.library;
  return TOOL_ICON.read;
}

function scrollToBottom() {
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function nearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
}

// Guards against the exact same user message rendering twice in a row - seen
// with the composer's send button/Enter handler double-firing under a slow
// backend response (a rate-limited free-tier model taking noticeably longer
// gives more real wall-clock time for a stray double dispatch to land before
// state.running has actually flipped). There's no legitimate case for the
// identical text to appear twice back-to-back with nothing in between, so
// this is a safe idempotency check rather than a real "did the user mean to
// resend this" judgment call.
let lastUserMessage = null; // { text, imageCount, at }

function addUserMessage(text, images) {
  closeActivity();
  activityRole = null;
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
  // Attached files (attachments.js) show as chips; the bubble holds only what was typed.
  const shown = window.CodeplyAttach ? window.CodeplyAttach.split(text) : { text, files: [] };
  if (shown.files.length) {
    const row = document.createElement('div');
    row.className = 'bubble-files';
    row.innerHTML = shown.files.map((f) => window.CodeplyAttach.chipHtml(f)).join('');
    msg.appendChild(row);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = shown.text;
  if (shown.text || !shown.files.length) msg.appendChild(bubble);
  msg.userText = text;
  msg.userImages = images && images.length ? images : undefined;

  // Hover actions, like Claude and ChatGPT: Copy, and Edit, which turns this
  // bubble into an editor and reruns the chat from here (see editUserMessage).
  const actions = document.createElement('div');
  actions.className = 'msg-hover-actions';
  actions.innerHTML =
    `<button class="icon-btn icon-btn-xs" data-action="copy" title="Copy" aria-label="Copy message">${ICON_COPY}</button>
    <button class="icon-btn icon-btn-xs" data-action="edit" title="Edit" aria-label="Edit message">${ICON_EDIT}</button>`;
  actions.querySelector('[data-action="copy"]').addEventListener('click', (e) => copyWithFeedback(text, e.currentTarget));
  actions.querySelector('[data-action="edit"]').addEventListener('click', () => editUserMessage(msg));
  msg.appendChild(actions);

  chatColumn.appendChild(msg);
  scrollToBottom();
}

const ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_RETRY = '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';

async function copyWithFeedback(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { showToast('Could not copy.', 'error'); return; }
  const old = btn.innerHTML;
  btn.innerHTML = ICON_CHECK;
  btn.classList.add('done');
  setTimeout(() => { btn.innerHTML = old; btn.classList.remove('done'); }, 1200);
}

// ─── Edit and retry a sent message ──────────────────────────────────────────
// Editing a message (or retrying the last one) rewinds the chat to just
// before it and runs it again in place: the message and everything after it
// are dropped, here and in the saved history (main.js editAndRerun), and the
// new version takes its spot. Nothing is appended as a fresh copy at the
// bottom. If the later turns changed files, those files can be put back to
// how they were before the message first ran (on by default).

/** Files changed by the turns after this message that are still applied. */
function filesChangedAfter(msgEl) {
  const files = new Set();
  for (let n = msgEl.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.cpData && !n.cpData.undone) for (const f of n.cpData.files || []) files.add(f.file);
    if (n.cpData && n.cpData.total > (n.cpData.files || []).length && !n.cpData.undone) files.add('+' + n.cpData.id); // more than were listed
  }
  return files.size;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function editUserMessage(msg) {
  const open = chatColumn.querySelector('.msg.user.editing');
  if (open && open !== msg && open.cancelEdit) open.cancelEdit();
  if (msg.classList.contains('editing')) return;
  msg.classList.add('editing');
  const bubble = msg.querySelector('.bubble');
  bubble.hidden = true;

  const changed = filesChangedAfter(msg);
  const editor = document.createElement('div');
  editor.className = 'bubble-editor';
  editor.innerHTML = `
    <textarea rows="1" aria-label="Edit message" spellcheck="true"></textarea>
    <div class="bubble-editor-foot">
      ${changed ? `<label class="bubble-editor-restore" title="Puts the files the later replies changed back the way they were before this message ran"><input type="checkbox" checked><span>Restore ${plural(changed, 'file')} to before this message</span></label>` : '<span class="bubble-editor-note">Replies after this message are replaced.</span>'}
      <button class="btn btn-ghost btn-sm" data-act="cancel" type="button">Cancel</button>
      <button class="btn btn-primary btn-sm" data-act="send" type="button">Send</button>
    </div>`;
  bubble.after(editor);
  const ta = editor.querySelector('textarea');
  ta.value = msg.userText;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px'; };
  ta.addEventListener('input', () => {
    grow();
    editor.querySelector('[data-act="send"]').disabled = !ta.value.trim();
  });

  const cancel = () => {
    editor.remove();
    bubble.hidden = false;
    msg.classList.remove('editing');
    msg.cancelEdit = null;
  };
  const send = () => {
    const text = ta.value.trim();
    if (!text) return;
    const restore = !!editor.querySelector('.bubble-editor-restore input')?.checked;
    cancel();
    rerunFrom(msg, text, restore);
  };
  msg.cancelEdit = cancel;
  editor.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
  editor.querySelector('[data-act="send"]').addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
  });
  requestAnimationFrame(() => {
    grow();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

/** Retry: run the latest message again, replacing the latest reply. */
async function retryLastMessage() {
  const users = chatColumn.querySelectorAll('.msg.user');
  const msg = users[users.length - 1];
  if (!msg || state.running) return;
  const changed = filesChangedAfter(msg);
  let restore = false;
  if (changed) {
    const r = await CraftModal.confirm({
      title: 'Retry this message?',
      body: 'Codeply runs it again and replaces the last reply.',
      confirmLabel: 'Retry',
      checkbox: { label: `Restore ${plural(changed, 'file')} first`, note: 'Puts the files the last reply changed back the way they were before it ran.', checked: true },
    });
    if (!r.ok) return;
    restore = r.checked;
  }
  rerunFrom(msg, msg.userText, restore);
}

async function rerunFrom(msg, text, restoreFiles) {
  if (!api || !state.currentSessionId || !msg.isConnected) return;
  const sessionId = state.currentSessionId;
  const users = [...chatColumn.querySelectorAll('.msg.user')];
  const userIndex = users.indexOf(msg);
  const expectText = msg.userText;
  const images = msg.userImages;

  // Drop this message and everything after it, then show the new version in
  // the same spot. A run still going is stopped by main.js first.
  hideThinking();
  stopRevealQueue();
  runningToolRow = null;
  while (msg.nextSibling) msg.nextSibling.remove();
  msg.remove();
  activeTaskList = null;
  if (activeGoalCard && !activeGoalCard.el.isConnected) activeGoalCard = null;
  if (!chatColumn.querySelector('.tasklist')) { currentTasks = []; refreshTasksUI(); }
  lastUserMessage = null;
  addUserMessage(text, images);
  setRunning(true);
  showThinking();

  const r = await api.editMessage({
    sessionId, userIndex, expectText, text, images, restoreFiles,
    cwd: state.project, mode: state.mode, bypass: state.bypass, clientId: desktopClientId,
    botId: window.CraftBots ? window.CraftBots.selectedId() : undefined,
  });
  if (r && r.restored) {
    const n = r.restored.files;
    if (r.restored.failed && r.restored.failed.length) showToast(`Restored ${plural(n, 'file')}. ${plural(r.restored.failed.length, 'file')} could not be restored.`, 'error');
    else if (n) showToast(`Restored ${plural(n, 'file')}`);
  }
  if (!r || r.error) {
    // Show the chat as it is really saved, then say what went wrong.
    if (state.currentSessionId === sessionId) {
      await openSession(sessionId);
      addNote((r && r.error) || 'Could not run that again.', 'error');
    }
    setRunning(state.runningSessions.includes(sessionId));
  }
}

// Copy and Retry under the latest reply, kept up to date as runs finish.
function updateReplyActions() {
  chatColumn.querySelectorAll('.reply-actions').forEach((el) => el.remove());
  if (state.running || !state.currentSessionId) return;
  const users = chatColumn.querySelectorAll('.msg.user');
  const last = users[users.length - 1];
  if (!last) return;
  let reply = null;
  for (let n = last.nextElementSibling; n; n = n.nextElementSibling) if (n.matches('.msg.assistant')) reply = n;
  const row = document.createElement('div');
  row.className = 'reply-actions';
  row.innerHTML = `<div class="msg-hover-actions">
    ${reply ? `<button class="icon-btn icon-btn-xs" data-action="copy" title="Copy" aria-label="Copy reply">${ICON_COPY}</button>` : ''}
    <button class="icon-btn icon-btn-xs" data-action="retry" title="Retry" aria-label="Retry">${ICON_RETRY}</button></div>`;
  if (reply) row.querySelector('[data-action="copy"]').addEventListener('click', (e) => copyWithFeedback(reply.rawText || reply.innerText, e.currentTarget));
  row.querySelector('[data-action="retry"]').addEventListener('click', retryLastMessage);
  chatColumn.appendChild(row);
}

function openImageLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  overlay.innerHTML = `<img src="${src}" alt="">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// Live responses type out word by word; replayed history (reopening an old
// chat) renders instantly - animating text you've already read is just a
// delay, not a nice touch.
//
// Replies render immediately, full text at once - no typewriter effect.
// ─── Reveal queue ───────────────────────────────────────────────────────────
// A tool row (or the next reply) that's ready to render while the PRIOR
// reply is still typing out doesn't jump ahead of it - it's created and
// appended to the DOM immediately (so tool_start's "running" placeholder
// and tool_end's swap-in still work exactly as before, in the right DOM
// order), but stays visually hidden (.reveal-pending) until its turn comes
// up in this queue, right after whatever was typing above it finishes.
const revealQueue = [];
let revealQueueBusy = false;
let activeTypewriterTimer = null;
// Set around history replay (reopening a past chat) - every message and
// tool row should appear at once there, not re-play its live-arrival
// animation/ordering every time the chat is opened.
let revealInstant = false;

function enqueueReveal(job) {
  if (revealInstant) { job(() => {}); return; }
  revealQueue.push(job);
  if (!revealQueueBusy) drainRevealQueue();
}
function drainRevealQueue() {
  if (revealQueue.length === 0) { revealQueueBusy = false; return; }
  revealQueueBusy = true;
  revealQueue.shift()(drainRevealQueue);
}
function stopRevealQueue() {
  if (activeTypewriterTimer) { clearInterval(activeTypewriterTimer); activeTypewriterTimer = null; }
  revealQueue.length = 0;
  revealQueueBusy = false;
}

// Reveals a reply a few words at a time - fast (well under half a second
// total regardless of length) so it still reads as "arriving" rather than
// just appearing, without the several-second crawl a true per-word
// typewriter would take on a long reply.
function runFastTypewriter(msg, text, done) {
  const words = text.split(/(\s+)/); // keeps whitespace tokens so spacing survives the join
  const total = words.filter((w) => w.trim()).length;
  const wordsPerTick = Math.max(1, Math.ceil(total / 16));
  let i = 0;
  activeTypewriterTimer = setInterval(() => {
    i = Math.min(words.length, i + wordsPerTick);
    msg.innerHTML = mdToHtml(words.slice(0, i).join(''));
    if (nearBottom()) scrollToBottom();
    if (i >= words.length) {
      clearInterval(activeTypewriterTimer);
      activeTypewriterTimer = null;
      done();
    }
  }, 14);
}

// ─── Activity group ─────────────────────────────────────────────────────────
// Everything the agent does between your message and its reply (tool rows,
// "Thought for", narration, role switches, info notes) folds into one quiet
// line, Claude Code style: "Read 3 files, ran 2 commands, used 4 tools >".
// Click it to see every step. A reply, a card that needs you, an error or the
// end of the run closes the group; the next step starts a new one.
let activityEl = null;
let activityRole = null;   // { mascot, name } of the role working this turn, shown on each work line

const ACTIVITY_KIND = {
  read_file: ['read', 'file', 'files'], list_dir: ['listed', 'folder', 'folders'],
  write_file: ['wrote', 'file', 'files'], edit_file: ['edited', 'file', 'files'],
  run: ['ran', 'command', 'commands'], job: ['checked', 'background job', 'background jobs'], search: ['searched', 'time', 'times'],
  browser_check: ['checked', 'page', 'pages'], fetch_image: ['downloaded', 'image', 'images'],
  image_search: ['searched images for', 'query', 'queries'], web_search: ['searched the web for', 'query', 'queries'],
  view_images: ['looked at', 'image', 'images'],
  look_at_screen: ['looked at your screen', 'time', 'times'],
};

function activityHead(el) { return el.querySelector('.activity-summary'); }

// Puts the working agent's mascot where the plain dot sits on a work line.
function setActivityAgent(el) {
  if (!el || !activityRole) return;
  const icon = el.querySelector('.activity-icon');
  if (icon.dataset.mascot === activityRole.mascot) return;
  icon.dataset.mascot = activityRole.mascot;
  icon.innerHTML = mascotHtml(activityRole.mascot, 'mascot-xs', activityRole.name);
  el.classList.add('has-agent');
  el.querySelector('.activity-head').title = 'Worked as ' + activityRole.name;
}

// The last part of a path, "4 image(s)" as "4 images", and "." as "the project".
function tidyActivityLabel(label) {
  const name = String(label || '').split(/[\\/]/).filter(Boolean).pop() || '';
  if (!name || name === '.') return 'the project';
  return name.replace(/^(\d+) (\w+)\(s\)$/, (m, n, w) => n + ' ' + w + (n === '1' ? '' : 's'));
}

function updateActivitySummary(el) {
  if (!el) return;
  const rows = [...el.querySelectorAll('.activity-body > .tool-row:not(.running)')];
  const counts = new Map();
  const first = new Map();
  let other = 0;
  for (const r of rows) {
    const k = ACTIVITY_KIND[r.dataset.tool];
    if (!k) { other++; continue; }
    counts.set(r.dataset.tool, (counts.get(r.dataset.tool) || 0) + 1);
    if (!first.has(r.dataset.tool)) first.set(r.dataset.tool, r.dataset.label || '');
  }
  const parts = [];
  for (const [tool, n] of counts) {
    const [verb, one, many] = ACTIVITY_KIND[tool];
    const name = tidyActivityLabel(first.get(tool));
    parts.push(n === 1 && name && name.length <= 32 && tool !== 'run' && tool !== 'search' ? `${verb} ${name}` : `${verb} ${n === 1 ? (/^[aeiou]/.test(one) ? 'an ' : 'a ') + one : n + ' ' + many}`);
  }
  if (other) parts.push(`used ${other === 1 ? 'a tool' : other + ' tools'}`);
  let text = parts.join(', ');
  const running = el.classList.contains('running');
  const live = el.querySelector('.activity-body > .tool-row.running');
  if (running && live) {
    const v = live.querySelector('.tool-verb')?.textContent || 'Working';
    const l = live.dataset.label ? ' ' + tidyActivityLabel(live.dataset.label) : '';
    text = v + l;
  } else if (!text) {
    text = running ? 'Working' : 'Thought it through';
  }
  activityHead(el).textContent = text.charAt(0).toUpperCase() + text.slice(1);
}

function activityBody() {
  if (!activityEl || !activityEl.isConnected) {
    activityEl = document.createElement('div');
    activityEl.className = 'activity running';
    activityEl.innerHTML =
      '<button class="activity-head" type="button" aria-expanded="false">' +
      '<span class="activity-icon" aria-hidden="true"></span>' +
      '<span class="activity-summary">Working</span>' +
      '<svg class="tool-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>' +
      '<div class="activity-body"></div>';
    const el = activityEl;
    el.querySelector('.activity-head').addEventListener('click', () => {
      const open = el.classList.toggle('open');
      el.querySelector('.activity-head').setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    setActivityAgent(activityEl);
    if (thinkingEl && thinkingEl.isConnected) chatColumn.insertBefore(activityEl, thinkingEl);
    else chatColumn.appendChild(activityEl);
    hideThinking();
  }
  return activityEl.querySelector('.activity-body');
}

function closeActivity() {
  if (!activityEl) return;
  const el = activityEl;
  activityEl = null;
  el.classList.remove('running');
  // Nothing to open (no steps, no thinking; the role badge alone is hidden in the card): no card.
  if (!el.querySelector('.activity-body > :not(.role-badge)')) { el.remove(); return; }
  updateActivitySummary(el);
}

// Engine messages that are bookkeeping, not news: never shown.
function isQuietNotice(text) {
  return /^Summarized earlier steps/i.test(text || '') || /^Stopped after \d+ steps/i.test(text || '');
}

function addAssistantMessage(text) {
  closeActivity();
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  msg.rawText = text;
  chatColumn.appendChild(msg);
  if (revealInstant) { msg.innerHTML = mdToHtml(text); return; }
  enqueueReveal((next) => runFastTypewriter(msg, text, next));
}

// The raw arguments a real tool call ran with - path, command, search/replace,
// pattern, whatever that tool takes - formatted close to the actual
// <codeply:name>...</codeply:name> block the model wrote, so clicking a tool
// row shows what really happened instead of leaving it as an opaque one-line
// summary.
function formatToolDetail(name, args) {
  if (!args || !Object.keys(args).length) return '(no arguments)';
  if (name === 'run') return args.command || '(no arguments)';
  const lines = Object.entries(args).map(([k, v]) => `<${k}>\n${v}\n</${k}>`);
  return lines.join('\n\n');
}

// An opened command row: the command and the end of what it printed, like a
// terminal. A background command's output keeps growing, so it can refresh.
function commandDetail({ command, output, exitCode, background, jobId }) {
  const box = document.createElement('div');
  box.className = 'tool-term hidden';
  const status = background ? `Background job${jobId ? ` ${jobId}` : ''}`
    : typeof exitCode === 'number' ? `<span class="${exitCode ? 'bad' : 'ok'}">Exit ${exitCode}</span>` : '';
  box.innerHTML = `<div class="tool-term-head"><span>Shell</span><span class="grow"></span>${status}</div><div class="tool-term-cmd"></div><pre class="tool-term-out"></pre>`;
  box.querySelector('.tool-term-cmd').textContent = command;
  const out = box.querySelector('.tool-term-out');
  const show = (text) => {
    const t = String(text || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd(); // no colour codes
    out.textContent = t || (output === undefined ? 'Output was not kept for this command.' : 'No output.');
    out.classList.toggle('empty', !t);
  };
  show(output);
  if (background && jobId && window.craft.jobsOutput) {
    box.addEventListener('toggle-open', async () => { show((await window.craft.jobsOutput(jobId)).slice(-4000) || output); });
  }
  return box;
}

// A single fallback chain for "what's the one-line summary of this call's
// arguments" - path/command/pattern/name covered the original file+shell
// tools; to/channel cover the two new integrations, whose defining argument
// isn't any of those.
function toolArgsLabel(args) {
  return args?.path || args?.command || args?.pattern || args?.name
    || (args?.to ? `to ${args.to}` : '')
    || (args?.channel ? `#${String(args.channel).replace(/^#/, '')}` : '')
    || args?.query || '';
}

function addToolRow({ name, label, ok, running: isRunning, auto, bypass, args, screenshotSrc, delegation, error, output, exitCode, background, jobId }) {
  // A bot asking a teammate gets its own row (bots-ui.js): "Asked Vera: ...".
  if (name === 'ask_bot' && window.CraftBots) return window.CraftBots.delegationRow({ label, ok, running: isRunning, args, delegation });
  const row = document.createElement('div');
  row.className = 'tool-row' + (isRunning ? ' running' : '') + (ok === false ? ' failed' : '');
  row.dataset.tool = name;
  row.dataset.label = label || '';
  const bg = name === 'run' && (background || /^(1|true|yes)$/i.test(String(args?.background || '')));
  const verb = bg ? 'Started in background' : (TOOL_DISPLAY[name] || name);
  const badge = auto ? `<span class="tool-badge">${bypass ? 'bypass' : 'auto approved'}</span>` : '';
  const hasDetail = !isRunning && args && Object.keys(args).length > 0;
  row.innerHTML =
    `<div class="tool-row-head">${toolIcon(name)}<span class="tool-verb">${isRunning ? verb.replace(/ed$|^Ran$/, (m) => m === 'Ran' ? 'Running' : 'ing').replace('Listeding', 'Listing') : verb}</span>` +
    `<span class="tool-label">${esc(label || '')}</span>${badge}${hasDetail ? '<svg class="tool-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' : ''}</div>`;
  if (isRunning) row.querySelector('.tool-row-head').innerHTML += '<span class="spinner"></span>';

  if (hasDetail) {
    const detail = (name === 'run' && args.command) || name === 'job'
      ? commandDetail({ command: args.command || (args.id ? `job ${args.id}` : 'jobs'), output, exitCode, background: bg, jobId })
      : document.createElement('pre');
    if (detail.tagName === 'PRE') {
      detail.className = 'tool-detail hidden';
      detail.textContent = formatToolDetail(name, args);
    }
    row.appendChild(detail);
    row.classList.add('expandable');
    row.querySelector('.tool-row-head').addEventListener('click', () => {
      detail.classList.toggle('hidden');
      row.classList.toggle('expanded');
      if (!detail.classList.contains('hidden')) detail.dispatchEvent(new Event('toggle-open'));
    });
  }

  // Why it failed, in the tool's own words: the model's retelling of an
  // error is often vaguer ("Bad Request") than what the tool actually said.
  if (ok === false && error) {
    const err = document.createElement('div');
    err.className = 'tool-error';
    err.textContent = error;
    row.appendChild(err);
  }

  // A browser_check's screenshot, shown right in the chat instead of only
  // fed to the model - the whole point of asking "what did it actually
  // check" is being able to look at it yourself, not just trust the text.
  if (screenshotSrc) {
    const img = document.createElement('img');
    img.className = 'tool-screenshot';
    img.src = screenshotSrc;
    img.alt = label || 'Browser check screenshot';
    img.addEventListener('click', () => openImageLightbox(screenshotSrc));
    row.appendChild(img);
  }

  row.classList.add('reveal-pending');
  const body = activityBody();
  body.appendChild(row);
  updateActivitySummary(activityEl);
  enqueueReveal((next) => {
    row.classList.remove('reveal-pending');
    if (nearBottom()) scrollToBottom();
    next();
  });
  return row;
}

// Task Maker checklist - one live block per run, updated in place as
// task_start/task_end events arrive rather than re-rendered from scratch,
// so it reads as a real progress list instead of flickering.
let activeTaskList = null; // { rows: Map<id, rowEl> }
let currentTasks = []; // plain data mirror of the active/last checklist, for the Tasks panel + sidebar badge

const ROLE_LABEL = { frontend: 'Frontend', backend: 'Backend', database: 'Database', devops: 'DevOps', security: 'Security', testing: 'Testing', docs: 'Docs' };

function buildTaskListEl(tasks) {
  const wrap = document.createElement('div');
  wrap.className = 'tasklist';
  const head = document.createElement('div');
  head.className = 'tasklist-head';
  head.textContent = `Plan · ${tasks.length} task${tasks.length === 1 ? '' : 's'}, one at a time`;
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
    if (t.role) {
      const role = document.createElement('span');
      role.className = 'tasklist-role';
      role.textContent = ROLE_LABEL[t.role] || t.role;
      row.appendChild(role);
    }
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
  CraftModal.open('tasksBackdrop', { onClose: closeTasksModal });
}

function closeTasksModal() {
  CraftModal.close('tasksBackdrop');
}

$('tasksBtn').addEventListener('click', openTasksModal);
// ─── Crew tab ───────────────────────────────────────────────────────────────
// Crew opens inside this window, over the main area, instead of in a window of
// its own. The sidebar button then reads "Craft" and switches back.
// Design (design/) works the same way: its page laid over the main area.
let crewMode = false;
let designMode = false;
// Crew and Design take the whole window under the title bar (their own sidebars have the switch back).
function crewArea() {
  const top = Math.round(document.querySelector('.titlebar').getBoundingClientRect().bottom);
  return { x: 0, y: top, width: window.innerWidth, height: window.innerHeight - top };
}
function paintCrewBtn() {
  const cur = designMode ? 'design' : crewMode ? 'crew' : 'craft';
  document.querySelectorAll('.app-switch-btn').forEach((b) => {
    const on = b.dataset.app === cur;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
}
function setCrewMode(on) {
  if (!api || !api.crewEmbed || crewMode === on) return;
  if (on && designMode) setDesignMode(false);
  crewMode = on;
  document.body.classList.toggle('crew-mode', on);
  paintCrewBtn();
  if (on) api.crewEmbed(crewArea()); else api.crewUnembed();
}
function setDesignMode(on) {
  if (!api || !api.designEmbed || designMode === on) return;
  if (on && crewMode) setCrewMode(false);
  designMode = on;
  document.body.classList.toggle('design-mode', on);
  paintCrewBtn();
  if (on) api.designEmbed(crewArea()); else api.designUnembed();
}
function setAppView(name) {
  if (name === 'crew') { setDshShown(false); setCrewMode(true); }
  else if (name === 'design') { setDshShown(false); setDesignMode(true); }
  else { setCrewMode(false); setDesignMode(false); setDshShown(engine === 'dsh'); }
}
// ─── Engine switch: Classic (codeply-cli) or DSH (craft-dsh, see dsh-engine.js) ───
// DSH is laid over the main area like Crew and Design, only while Craft itself is showing.
let engine = 'classic';
let dshShown = false;
let dshSeq = 0;
let dshBrowserWidth = 0; // Codeply's browser panel on the right, 0 while closed
// The new Craft's view: under the title bar, leaving room for Craft's browser when it's open.
function dshArea() {
  const a = crewArea();
  return { ...a, width: Math.max(360, a.width - dshBrowserWidth) };
}
function paintEngineBtn() {
  document.querySelectorAll('.engine-btn').forEach((b) => {
    const on = b.dataset.engine === engine;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
}
function dshOverlay(state, text) {
  const el = $('dshOverlay');
  if (!el) return;
  el.hidden = state === 'off';
  // While it starts the area stays plain (no message); only a failure says something.
  el.classList.toggle('quiet', state === 'starting');
  $('dshOverlayTitle').textContent = state === 'error' ? "Codeply couldn't start" : 'Starting Codeply';
  $('dshOverlayText').textContent = text || 'This takes a few seconds the first time.';
  $('dshRetry').hidden = state !== 'error';
  $('dshBackClassic').hidden = state !== 'error';
}
async function setDshShown(on) {
  if (!api || !api.dshEmbed || dshShown === on) return;
  dshShown = on;
  document.body.classList.toggle('dsh-mode', on);
  const seq = ++dshSeq;
  if (!on) { dshOverlay('off'); api.dshUnembed(); return; }
  dshOverlay('starting');
  const r = await api.dshEmbed(dshArea());
  if (seq !== dshSeq) return; // switched away while it was starting
  if (r && r.shown) dshOverlay('off');
  else dshOverlay('error', (r && r.error) || 'Something went wrong.');
}
async function setEngine(which) {
  if (!api || !api.dshSetEngine || engine === which) return;
  engine = which;
  paintEngineBtn();
  await api.dshSetEngine(which);
  if (which === 'dsh') setAppView('craft');
  else setDshShown(false);
}
document.querySelectorAll('.engine-btn').forEach((b) => b.addEventListener('click', () => setEngine(b.dataset.engine)));
if ($('dshRetry')) $('dshRetry').addEventListener('click', () => { dshShown = false; setDshShown(true); });
if ($('dshBackClassic')) $('dshBackClassic').addEventListener('click', () => setEngine('classic'));
if (api && api.dshStatus) {
  api.dshStatus().then((s) => {
    if (!s || s.engine !== 'dsh') return;
    engine = 'dsh';
    paintEngineBtn();
    if (!crewMode && !designMode) setDshShown(true);
  }).catch(() => {});
}
window.CraftCrew = { show: () => setAppView('crew'), hide: () => setAppView('craft'), isOpen: () => crewMode };
window.CraftDesign = { show: () => setAppView('design'), hide: () => setAppView('craft'), isOpen: () => designMode };
document.querySelectorAll('.app-switch-btn').forEach((b) => b.addEventListener('click', () => setAppView(b.dataset.app)));
if (api && api.onCrewShow) api.onCrewShow(() => setAppView('crew'));
if (api && api.onCrewHide) api.onCrewHide(() => setAppView('craft'));
if (api && api.onDesignShow) api.onDesignShow(() => setAppView('design'));
if (api && api.onDesignHide) api.onDesignHide(() => setAppView('craft'));
if (api && api.onOpenConnect) api.onOpenConnect(() => openConnectApps());
window.addEventListener('resize', () => { if (crewMode) api.crewBounds(crewArea()); if (designMode) api.designBounds(crewArea()); if (dshShown) api.dshBounds(dshArea()); });
$('tasksCloseBtn').addEventListener('click', closeTasksModal);
$('tasksBackdrop').addEventListener('click', (e) => { if (e.target === $('tasksBackdrop')) closeTasksModal(); });

// Haze 2's 5-hour limit on the lighter models: when it comes back, and a way to keep going now.
function addLimitCard(text) {
  closeActivity();
  const at = /resets at ([^,.]+)/i.exec(text || '');
  const where = /limit for now (on this (?:computer|network))/i.exec(text || '');
  const el = document.createElement('div');
  el.className = 'limit-card';
  el.innerHTML = '<div class="limit-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></div>' +
    '<div class="limit-text"><b></b><span></span></div><button class="limit-btn" type="button">Choose a model</button>';
  el.querySelector('b').textContent = `You've hit Haze 2's limit for now${where ? ` ${where[1]}` : ''}`;
  el.querySelector('span').textContent = at ? `It resets at ${at[1].trim()}. Your own model works in the meantime.` : String(text || '');
  // The click must not reach the page's "click outside closes the menu" handler, or the menu shuts at once.
  // The visible chip (the home screen has its own, hidden here), so the menu opens beside it.
  el.querySelector('.limit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const chip = [...document.querySelectorAll('[data-role="model-chip"]')].find((c) => c.offsetParent !== null);
    if (chip) chip.click();
  });
  chatColumn.appendChild(el);
  if (nearBottom()) scrollToBottom();
}

function addNote(text, kind = '') {
  if (isQuietNotice(text)) return;
  const el = document.createElement('div');
  el.className = 'chat-note ' + kind;
  el.textContent = text;
  // A plain note always joins the steps; a warning or limit note joins the
  // group that is open (live and reopened chats group the same way); an error
  // or a stop ends it.
  const open = activityEl && activityEl.isConnected;
  if (!kind || (open && kind !== 'error' && kind !== 'stopped')) { activityBody().appendChild(el); updateActivitySummary(activityEl); }
  else { closeActivity(); chatColumn.appendChild(el); }
  if (nearBottom()) scrollToBottom();
}

// Every mascot on screen is two stacked, independently-animated layers -
// the ball (assets/agents/<id>.png) and a shared eyes overlay
// (assets/agents/eyes.png) - not one flat pre-drawn image. That's what
// makes a real blink/look-around animation possible at all: the eyes move
// on their own transform, the ball breathes on its own, and nothing about
// either layer is baked together. A small random negative animation-delay
// desyncs each instance so a grid of them doesn't blink in unison.
function mascotHtml(mascotFile, sizeClass, altText) {
  // A negative delay starts the animation already partway through its
  // cycle - the simplest way to desync instances so a grid of 7 mascots
  // doesn't blink and look around in unison.
  const delay = (-(Math.random() * 6)).toFixed(2) + 's';
  return `<span class="mascot ${sizeClass}">
    <img class="mascot-ball" src="assets/agents/${esc(mascotFile)}" alt="${esc(altText)}">
    <img class="mascot-eyes" src="assets/agents/eyes.png" alt="" style="animation-delay: ${delay}">
  </span>`;
}

// ─── Role badge ─────────────────────────────────────────────────────────────
// There's one agent; this marks the moment it switches role (Frontend,
// Backend, Testing, ...) - shown only when the role actually changes.
function addRoleBadge(data) {
  const el = document.createElement('div');
  el.className = 'role-badge';
  el.style.setProperty('--role-color', data.color || '');
  // Older chats stored the multi-agent era's badge ({name: 'Pixel', tagline: 'Frontend & UI Specialist'}).
  const roleName = data.tagline === 'role' ? data.name : String(data.tagline || data.name || '').replace(/ Specialist$/i, '');
  el.innerHTML = mascotHtml(data.mascot || 'general.png', 'mascot-xs', roleName) +
    `<span class="role-badge-text">Working as <strong>${esc(roleName || 'General')}</strong></span>`;
  activityRole = { mascot: data.mascot || 'general.png', name: roleName || 'General' };
  activityBody().appendChild(el);
  setActivityAgent(activityEl);
  updateActivitySummary(activityEl);
  if (nearBottom()) scrollToBottom();
}

// ─── What actually changed ──────────────────────────────────────────────────
// Built from the tool results, not the model's prose: the files really
// written and the checks really run (with exit codes). If the model's
// summary and this line ever disagree, this line is the truth. It reads like
// the activity line above it: one quiet sentence that opens into the list.
const QL_CHEV = '<svg class="tool-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
const qlCount = (n, one) => `${n === 1 ? (/^[aeiou]/.test(one) ? 'an' : 'a') : n} ${n === 1 ? one : one + 's'}`;
const qlBase = (p) => String(p).split(/[\\/]/).pop();

/** A quiet line that opens and closes its list, like the activity line. */
function wireQuietLine(el) {
  el.addEventListener('click', (e) => {
    const head = e.target.closest('.ql-head');
    if (!head || head.parentElement !== el || e.target.closest('.ql-action')) return;
    const open = !el.classList.contains('open');
    el.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
  });
  el.addEventListener('keydown', (e) => {
    const head = e.target.closest('.ql-head');
    if (head && e.target === head && head.tagName !== 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); head.click(); }
  });
}

function addTurnSummary(data) {
  // Not shown: the checks and changed files are already rows in the turn's
  // step group above, like Claude's. Kept on the chat for the phone and Cloud.
  if (!window.CRAFT_SHOW_TURN_SUMMARY) return;
  closeActivity();
  const files = data.files || [];
  const checks = data.checks || [];
  const unverified = data.unverified || [];
  if (!files.length && !checks.length) return;
  const card = document.createElement('div');
  card.className = 'turn-summary quiet-line';
  const isPass = (c) => c.ok && (c.exitCode === undefined || c.exitCode === 0);
  const failedN = checks.filter((c) => !isPass(c)).length;
  const checkRow = (c) => {
    const passed = isPass(c);
    const label = c.tool === 'browser_check' ? `Opened ${c.label}` : c.label;
    const exit = !passed && typeof c.exitCode === 'number' ? `<span class="ql-exit">exit ${c.exitCode}</span>` : '';
    return `<div class="ql-row ${passed ? 'pass' : 'fail'}">
      <span class="ql-ic">${passed ? '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'}</span>
      <span class="ql-label" title="${esc(label || '')}">${esc(label || '')}</span>${exit}</div>`;
  };
  // "Ran 5 checks, all passed" / "Ran 5 checks, 1 failed" / "Changed app.js, not checked by a run"
  const n = checks.length;
  const verdict = !n ? '' : failedN ? `<span class="ql-bad">${failedN === n && n > 1 ? 'all failed' : `${failedN} failed`}</span>` : (n === 1 ? 'it passed' : 'all passed');
  const text = n ? `Ran ${qlCount(n, 'check')}, ${verdict}`
    : `Changed ${files.length === 1 ? esc(qlBase(files[0])) : qlCount(files.length, 'file')}, not checked by a run`;
  card.classList.toggle('has-fail', failedN > 0);
  card.innerHTML = `
    <button class="ql-head" type="button" aria-expanded="false">
      <span class="ql-dot ${failedN ? 'bad' : n ? 'good' : ''}"></span><span class="ql-text">${text}</span>${QL_CHEV}
    </button>
    <div class="ql-body">
      ${checks.map(checkRow).join('')}
      ${files.length ? `<div class="ql-row files"><span class="ql-ic"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg></span><span class="ql-label">${files.map((f) => esc(qlBase(f))).join(', ')}</span></div>` : ''}
    </div>
    ${unverified.length ? `<div class="ql-warn"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>Not checked by a passing run: ${unverified.map((f) => esc(qlBase(f))).join(', ')}</div>` : ''}`;
  wireQuietLine(card);
  card.classList.add('reveal-pending');
  chatColumn.appendChild(card);
  enqueueReveal((next) => {
    card.classList.remove('reveal-pending');
    if (nearBottom()) scrollToBottom();
    next();
  });
}

// ─── Undo / redo a message's changes ───────────────────────────────────────
// One quiet line per message that changed files, with Undo at its end. Undo
// puts those files back to how they were before the message ran; the same
// button then offers Redo.
const checkpointEls = new Map(); // checkpoint id -> row element

const CP_STATUS = { A: 'added', M: 'changed', D: 'deleted' };
const CP_VERB = { A: 'Added', M: 'Edited', D: 'Deleted' };

function renderCheckpoint(cp) {
  let row = checkpointEls.get(cp.id);
  if (!row || !row.isConnected) {
    row = document.createElement('div');
    row.className = 'checkpoint quiet-line';
    checkpointEls.set(cp.id, row);
    chatColumn.appendChild(row);
    wireQuietLine(row);
  }
  const n = cp.total || cp.files.length;
  const list = cp.files.slice(0, 40).map((f) => {
    const parts = String(f.file).split(/[\\/]/);
    const name = parts.pop();
    const dir = parts.length ? parts.join('/') + '/' : '';
    return `<div class="ql-row"><span class="ql-status cp-${esc(f.status)}" title="${esc(CP_STATUS[f.status] || f.status)}">${esc(f.status)}</span>` +
      `<span class="ql-label" title="${esc(f.file)}"><span class="ql-dir">${esc(dir)}</span>${esc(name)}</span></div>`;
  }).join('');
  // "Edited craft.html" for one file, "Changed 3 files" for more.
  const one = n === 1 && cp.files[0];
  const what = one ? `${CP_VERB[one.status] || 'Changed'} ${esc(qlBase(one.file))}` : `Changed ${n} files`;
  const open = row.classList.contains('open');
  row.cpData = cp;
  row.classList.toggle('undone', !!cp.undone);
  row.innerHTML = `
    <div class="ql-head" role="button" tabindex="0" aria-expanded="${open}">
      <span class="ql-dot"></span><span class="ql-text">${cp.undone ? `Undone: ${what.charAt(0).toLowerCase() + what.slice(1)}` : what}</span>${QL_CHEV}
      <button class="cp-action ql-action" type="button">${cp.undone
        ? '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>Redo'
        : '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>Undo'}</button>
    </div>
    <div class="ql-body">${list}${n > 40 ? `<div class="ql-row more">and ${n - 40} more</div>` : ''}</div>`;
  row.querySelector('.cp-action').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!api || !state.currentSessionId) return;
    btn.disabled = true;
    btn.textContent = cp.undone ? 'Redoing...' : 'Undoing...';
    const r = await api.setCheckpoint(state.currentSessionId, cp.id, !cp.undone);
    if (r && r.error) {
      addNote(r.error, 'warn');
      renderCheckpoint(cp);
    } else if (r && r.checkpoint) {
      renderCheckpoint(r.checkpoint);
    }
  });
}

// ─── /goal progress card ────────────────────────────────────────────────────
// One live card per goal, updated in place as the loop works and verifies.
let activeGoalCard = null; // { goal, el }

const GOAL_STATUS_LABEL = {
  running: 'Working', verifying: 'Verifying', achieved: 'Achieved',
  blocked: 'Stuck', incomplete: 'Not finished', failed: 'Stopped', stopped: 'Stopped',
};

function renderGoalCard(data) {
  closeActivity();
  if (!activeGoalCard || activeGoalCard.goal !== data.goal || !activeGoalCard.el.isConnected) {
    const el = document.createElement('div');
    el.className = 'goal-card';
    el.innerHTML = `
      <div class="goal-head">
        <span class="goal-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/></svg></span>
        <span class="goal-kicker">Goal</span>
        <span class="goal-pill" data-role="pill"></span>
      </div>
      <div class="goal-text"></div>
      <div class="goal-track"><div class="goal-bar" data-role="bar"></div></div>
      <div class="goal-note" data-role="note"></div>`;
    el.querySelector('.goal-text').textContent = data.goal;
    chatColumn.appendChild(el);
    activeGoalCard = { goal: data.goal, el };
  }
  const { el } = activeGoalCard;
  const status = data.status || 'running';
  el.dataset.status = status;
  const iter = data.iteration || 0;
  const max = data.max || 8;
  const pill = el.querySelector('[data-role="pill"]');
  pill.textContent = ['running', 'verifying'].includes(status) && iter
    ? `${GOAL_STATUS_LABEL[status]} · round ${iter} of ${max}`
    : GOAL_STATUS_LABEL[status] || status;
  const pct = status === 'achieved' ? 100 : Math.min(95, Math.round(((iter - (status === 'running' ? 1 : 0.5)) / max) * 100));
  el.querySelector('[data-role="bar"]').style.width = Math.max(4, pct) + '%';
  el.querySelector('[data-role="note"]').textContent = data.note || '';
  if (nearBottom()) scrollToBottom();
}

// ─── Run status (which chats have a run in flight) ─────────────────────────
if (api) api.onRunsStatus((ids) => {
  sbRunsChanged(ids); // sets state.runningSessions and repaints the sidebar dots
  // Keeps the composer's send/stop icon accurate for the open chat even if
  // its own run_finished event was missed while looking at another chat.
  if (state.currentSessionId) {
    const isActive = state.runningSessions.includes(state.currentSessionId);
    if (isActive !== state.running) setRunning(isActive);
  }
});

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
// Lives in its own modal off the account menu, not the chat side panel - the
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
  btn.classList.toggle('btn-primary', !connected);
  btn.classList.toggle('btn-secondary', connected);
  btn.classList.toggle('btn-danger-hover', connected);
}

async function refreshIntegrations() {
  if (!api) return;
  const s = await api.integrationsStatus();
  renderIntegrationRow('caGmail', { connected: !!s.gmail?.connected, label: s.gmail?.email });
  renderIntegrationRow('caSlack', { connected: !!s.slack?.connected, label: s.slack?.teamName });
  renderIntegrationRow('caVercel', { connected: !!s.vercel?.connected, label: s.vercel?.userName });
  renderIntegrationRow('caSupabase', { connected: !!s.supabase?.connected, label: s.supabase?.email });
  renderIntegrationRow('caGithub', { connected: !!s.github?.connected, label: s.github?.userName });
}

function wireIntegrationRow(rowId, integrationName, connectFn, providerLabel) {
  $(rowId).querySelector('[data-role="action"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const row = $(rowId);
    if (row.classList.contains('connected')) {
      await api.disconnectIntegration(integrationName);
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

wireIntegrationRow('caGmail', 'gmail', () => api.connectGmail(), 'Gmail');
wireIntegrationRow('caSlack', 'slack', () => api.connectSlack(), 'Slack');
wireIntegrationRow('caVercel', 'vercel', () => api.connectVercel(), 'Vercel');
wireIntegrationRow('caSupabase', 'supabase', () => api.connectSupabase(), 'Supabase');
wireIntegrationRow('caGithub', 'github', () => api.connectGithub(), 'GitHub');

function openConnectApps() {
  closeAccountMenu();
  refreshIntegrations();
  CraftModal.open('connectAppsBackdrop', { onClose: closeConnectApps });
}
function closeConnectApps() {
  CraftModal.close('connectAppsBackdrop');
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
  menu.className = 'menu account-menu';
  menu.innerHTML = `
    <div class="account-menu-header">
      <div class="avatar">${esc(state.user.email.slice(0, 2).toUpperCase())}</div>
      <div class="account-menu-email">${esc(state.user.email)}</div>
    </div>
    <div class="menu-sep"></div>
    <button class="menu-item" data-action="usage">
      <svg viewBox="0 0 24 24"><path d="M4.6 18.5a9 9 0 1 1 14.8 0"/><path d="M12 14.2l4.2-4.6"/><circle cx="12" cy="14.6" r="1.5"/><path d="M7.3 10.2l.9.6M12 6.4v1M16.7 10.2l-.9.6"/></svg>
      Usage
    </button>
    <button class="menu-item" data-action="connect">
      <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
      Connect Apps
    </button>
    <div class="menu-sep"></div>
    <div class="account-menu-theme-row">
      <span>Theme</span>
      <div class="theme-toggle segmented segmented-sm" id="themeToggle" role="group" aria-label="Theme">
        <button type="button" class="theme-opt segmented-item" data-theme-choice="system" title="Match system">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </button>
        <button type="button" class="theme-opt segmented-item" data-theme-choice="light" title="Light">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>
        </button>
        <button type="button" class="theme-opt segmented-item" data-theme-choice="dark" title="Dark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5a8.5 8.5 0 1 1-9-11 6.8 6.8 0 0 0 9 11Z"/></svg>
        </button>
      </div>
    </div>
    <div class="menu-sep"></div>
    <button class="menu-item" data-action="logout">
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
  menu.querySelector('[data-action="usage"]').addEventListener('click', () => { closeAccountMenu(); window.CraftUsage && window.CraftUsage.open({ name: $('userName').textContent, email: state.user.email }); });
  menu.querySelector('[data-action="logout"]').addEventListener('click', async () => {
    closeAccountMenu();
    await api.logout();
    state.user = null;
    renderUser();
    showView('viewLogin');
  });
  menu.querySelectorAll('.theme-opt').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
  });
  syncThemeToggleUI();
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
// Esc closes whichever small menu is open (each menu's own handler is a no-op when it is closed).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (accountMenuEl) { closeAccountMenu(); $('sbUserBtn').focus(); }
  if (chatCtxMenuEl) { const a = chatCtxAnchorBtn; closeChatMenu(); if (a) a.focus(); }
});

$('togglePanelBtn').addEventListener('click', () => $('sidePanel').classList.toggle('hidden'));

// ─── Embedded browser panel (docked BrowserViews the agent's browser_check drives) ─
// Tabs, back / forward / reload, the point-at tool, the address bar and a ...
// menu, laid out like Codex's browser. The pages themselves are native views
// main.js docks under this chrome, so anything that has to draw over a page
// (the menu, the edge being dragged) first swaps the page for a still of it.
const bc = { visible: false, tabs: [], activeTabId: null, zoom: 100, viewport: 'desktop', frozen: false, menu: null };
document.querySelectorAll('.browser-toggle-btn').forEach((btn) =>
  btn.addEventListener('click', () => api && api.toggleBrowserPanel())
);
$('bcBack').addEventListener('click', () => api && api.browserPanelBack());
$('bcForward').addEventListener('click', () => api && api.browserPanelForward());
$('bcClose').addEventListener('click', () => api && api.toggleBrowserPanel());
$('bcNewTab').addEventListener('click', () => api && api.browserPanelNewTab());
$('bcExternal').addEventListener('click', () => api && api.browserPanelExternal());

const bcReloadBtn = $('bcReload');
bcReloadBtn.addEventListener('click', () => api && api.browserPanelReload());

// A real address bar: type a URL (or words to search), press Enter, it goes there.
const bcUrlInput = $('bcUrl');
let lastBrowserPanelUrl = '';
bcUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { bcUrlInput.value = lastBrowserPanelUrl; bcUrlInput.blur(); return; }
  if (e.key !== 'Enter') return;
  const value = bcUrlInput.value.trim();
  if (value && api) api.browserPanelNavigate(value);
  bcUrlInput.blur();
});
bcUrlInput.addEventListener('focus', () => bcUrlInput.select());
// Editing the address bar shouldn't fight the live URL updating under the
// user mid-type - only resynced on blur or on an actual navigation.
bcUrlInput.addEventListener('blur', () => { bcUrlInput.value = lastBrowserPanelUrl; });

/** Where the chrome ends, in window pixels, so main.js docks the page right under it. */
function reportBrowserLayout() {
  if (!api || !api.browserPanelLayout || !bc.visible) return;
  const rect = $('browserChrome').getBoundingClientRect();
  // With the app zoomed, rects may come back in unzoomed px; scale them to the window.
  const k = window.innerWidth / (document.documentElement.getBoundingClientRect().width || window.innerWidth);
  api.browserPanelLayout({ top: Math.round(rect.bottom * k) });
}
window.addEventListener('resize', () => requestAnimationFrame(reportBrowserLayout));

const BC_GLOBE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>';
function renderBrowserTabs() {
  const host = $('bcTabs');
  host.innerHTML = bc.tabs.map((t) => {
    const on = t.id === bc.activeTabId;
    const icon = t.loading ? '<span class="bc-tab-spin"></span>'
      : t.kind === 'agent' ? '<span class="bc-tab-agent" title="Codeply checks pages here"></span>'
      : t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : BC_GLOBE;
    const title = t.title || (t.url ? t.url.replace(/^https?:\/\//, '') : 'New tab');
    return `<div class="bc-tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-id="${t.id}" title="${esc(title)}">
      <span class="bc-tab-ic">${icon}</span><span class="bc-tab-title">${esc(title)}</span>
      ${t.kind === 'agent' ? '' : `<button class="bc-tab-x" type="button" data-close="${t.id}" aria-label="Close ${esc(title)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`}
    </div>`;
  }).join('');
}
$('bcTabs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-close]');
  if (x) { e.stopPropagation(); api.browserPanelCloseTab(Number(x.dataset.close)); return; }
  const tab = e.target.closest('.bc-tab');
  if (tab) api.browserPanelSelectTab(Number(tab.dataset.id));
});
$('bcTabs').addEventListener('auxclick', (e) => { const tab = e.target.closest('.bc-tab'); if (e.button === 1 && tab) api.browserPanelCloseTab(Number(tab.dataset.id)); });
$('bcTabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const i = bc.tabs.findIndex((t) => t.id === bc.activeTabId);
  const next = bc.tabs[i + (e.key === 'ArrowRight' ? 1 : -1)];
  if (next) { e.preventDefault(); api.browserPanelSelectTab(next.id); }
});

// The browser panel is a native view drawn over this window, so a dialog,
// menu or popover reaching into its area would sit under the page. While one
// does, the page steps aside (main.js, browserpanel:cover).
let bcPanelWidth = 0;
let bcCovered = false;
const BC_OVERLAYS = '.modal-backdrop, [class*="backdrop"], .menu, .sheet, [role="dialog"], [role="menu"], [role="listbox"], .term-dock.expanded';
function syncBrowserCover() {
  let covered = false;
  if (bcPanelWidth > 0) {
    // Where the page is: left of the tasks column, under the chrome, above the terminal.
    const right = window.innerWidth - (typeof dockTasksW === 'number' ? dockTasksW : 0);
    const left = right - bcPanelWidth;
    const term = document.getElementById('terminalPanel');
    const bottom = term && term.classList.contains('under-browser') ? term.getBoundingClientRect().top : window.innerHeight;
    for (const el of document.querySelectorAll(BC_OVERLAYS)) {
      if (el.classList.contains('hidden') || el.closest('.hidden')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= left || r.left >= right || r.top >= bottom) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      covered = true;
      break;
    }
  }
  if (covered === bcCovered || !api || !api.browserPanelCover) return;
  bcCovered = covered;
  api.browserPanelCover(covered);
}
let bcCoverFrame = 0;
new MutationObserver(() => {
  if (bcCoverFrame || !bcPanelWidth) return;
  bcCoverFrame = requestAnimationFrame(() => { bcCoverFrame = 0; syncBrowserCover(); });
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
window.addEventListener('resize', () => syncBrowserCover());

if (api) {
  api.onBrowserPanelState((data) => {
    bcPanelWidth = data.visible ? Number(data.width) || 0 : 0;
    syncBrowserCover();
    requestAnimationFrame(() => layoutDock());
    const opened = data.visible && !bc.visible;
    bc.visible = data.visible;
    bc.tabs = data.tabs || [];
    bc.activeTabId = data.activeTabId;
    bc.zoom = data.zoom || 100;
    document.querySelectorAll('.browser-toggle-btn').forEach((btn) => btn.classList.toggle('active', data.visible));
    if (!dragState) document.documentElement.style.setProperty('--browser-panel-width', data.width + 'px');
    document.querySelector('.app').classList.toggle('browser-panel-open', data.visible);
    $('browserChrome').classList.toggle('hidden', !data.visible);
    $('bcResize').classList.toggle('hidden', !data.visible);
    $('bcBack').disabled = !data.canGoBack;
    $('bcForward').disabled = !data.canGoForward;
    const active = bc.tabs.find((t) => t.id === bc.activeTabId);
    bcReloadBtn.classList.toggle('spinning', !!(active && active.loading));
    renderBrowserTabs();
    const zoomEl = document.querySelector('.bc-menu [data-zoom-label]');
    if (zoomEl) zoomEl.textContent = bc.zoom + '%';
    if (!data.visible) { closeBrowserFind(); closeBrowserMenu(); }
    if (opened || data.visible) requestAnimationFrame(reportBrowserLayout);
    // The new Craft's view makes room for the browser, which docks on the right.
    dshBrowserWidth = data.visible ? (Number(data.width) || 0) + 6 : 0;
    if (dshShown) api.dshBounds(dshArea());
  });
  api.onBrowserPanelUrl((data) => {
    lastBrowserPanelUrl = data.url;
    if (document.activeElement !== bcUrlInput) {
      bcUrlInput.value = data.url;
      bcUrlInput.title = data.url;
    }
  });
  if (api.onBrowserPanelFocusUrl) api.onBrowserPanelFocusUrl(() => { bcUrlInput.value = ''; bcUrlInput.focus(); });
  if (api.onBrowserPanelViewport) api.onBrowserPanelViewport((d) => { bc.viewport = d.name; });
}
$('spProject').addEventListener('click', () => state.project && api.openPath(state.project));

// ── Swapping the live page for a still, so HTML can draw over it ──
async function freezeBrowser(on) {
  if (!api || !api.browserPanelDrag || !bc.visible || bc.frozen === on) return;
  bc.frozen = on;
  const ghost = $('bcGhost');
  if (on) {
    const r = await api.browserPanelDrag(true);
    ghost.style.backgroundImage = r && r.image ? `url("${r.image}")` : 'none';
    ghost.style.top = $('browserChrome').getBoundingClientRect().bottom + 'px';
    ghost.classList.remove('hidden');
  } else {
    ghost.classList.add('hidden');
    ghost.style.backgroundImage = 'none';
    await api.browserPanelDrag(false);
  }
}

// ── The ... menu ──
function closeBrowserMenu() {
  if (!bc.menu) return;
  bc.menu.remove();
  bc.menu = null;
  $('bcMenuBtn').classList.remove('active');
  $('bcMenuBtn').setAttribute('aria-expanded', 'false');
  freezeBrowser(false);
}
const BC_SIZES = [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Phone']];
async function openBrowserMenu() {
  if (bc.menu) { closeBrowserMenu(); return; }
  await freezeBrowser(true);
  const m = document.createElement('div');
  m.className = 'menu bc-menu';
  m.setAttribute('role', 'menu');
  const item = (act, label, keys = '') => `<button class="menu-item" role="menuitem" data-act="${act}"><span>${label}</span>${keys ? `<kbd>${keys}</kbd>` : ''}</button>`;
  m.innerHTML = item('find', 'Find in page', 'Ctrl+F') + item('print', 'Print')
    + `<div class="bc-menu-row"><span>Zoom</span><span class="bc-zoom"><button class="bc-btn" data-act="zoom-out" aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button><span data-zoom-label>${bc.zoom}%</span><button class="bc-btn" data-act="zoom-in" aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button><button class="bc-btn" data-act="zoom-reset" aria-label="Actual size" title="Actual size"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button></span></div>`
    + `<div class="bc-menu-row"><span>Device</span><span class="bc-devices">${BC_SIZES.map(([k, l]) => `<button class="${bc.viewport === k ? 'on' : ''}" data-act="size:${k}">${l}</button>`).join('')}</span></div>`
    + item('shot', 'Take a screenshot')
    + '<div class="menu-sep"></div>'
    + item('external', 'Open in your browser') + item('downloads', 'Downloads') + item('clear', 'Clear browsing data')
    + '<div class="menu-sep"></div>'
    + item('close', 'Close the browser');
  document.body.appendChild(m);
  const r = $('bcMenuBtn').getBoundingClientRect();
  m.style.top = (r.bottom + 6) + 'px';
  m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  bc.menu = m;
  $('bcMenuBtn').classList.add('active');
  $('bcMenuBtn').setAttribute('aria-expanded', 'true');
  const first = m.querySelector('.menu-item');
  if (first) first.focus();
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'zoom-in') return api.browserPanelZoom(1);
    if (act === 'zoom-out') return api.browserPanelZoom(-1);
    if (act === 'zoom-reset') return api.browserPanelZoom(0);
    if (act.startsWith('size:')) {
      bc.viewport = act.slice(5);
      m.querySelectorAll('.bc-devices button').forEach((x) => x.classList.toggle('on', x === b));
      api.browserPanelViewport(bc.viewport);
      return;
    }
    closeBrowserMenu();
    if (act === 'find') openBrowserFind();
    else if (act === 'print') api.browserPanelPrint();
    else if (act === 'shot') {
      const res = await api.browserPanelScreenshot();
      showToast(res && res.ok ? 'Screenshot copied, and saved to Downloads.' : (res && res.error) || 'Could not take a screenshot.', res && res.ok ? undefined : 'error');
    } else if (act === 'external') api.browserPanelExternal();
    else if (act === 'downloads') api.browserPanelDownloads();
    else if (act === 'clear') {
      if (!confirm('Clear cookies, sign-ins and saved data in Codeply\'s browser?')) return;
      const res = await api.browserPanelClearData();
      if (res && res.ok) showToast('Browsing data cleared.');
    } else if (act === 'close') api.toggleBrowserPanel();
  });
  m.addEventListener('keydown', (e) => {
    const items = [...m.querySelectorAll('.menu-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  });
}
$('bcMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); openBrowserMenu(); });
document.addEventListener('click', (e) => { if (bc.menu && !bc.menu.contains(e.target)) closeBrowserMenu(); });

// ── Find in page ──
const bcFindInput = $('bcFindInput');
function openBrowserFind() {
  $('bcFind').classList.remove('hidden');
  bcFindInput.focus();
  bcFindInput.select();
  requestAnimationFrame(reportBrowserLayout);
}
function closeBrowserFind() {
  if ($('bcFind').classList.contains('hidden')) return;
  $('bcFind').classList.add('hidden');
  $('bcFindCount').textContent = '';
  if (api && api.browserPanelFindStop) api.browserPanelFindStop();
  requestAnimationFrame(reportBrowserLayout);
}
const findStep = (forward) => api.browserPanelFind({ text: bcFindInput.value, forward, next: true });
bcFindInput.addEventListener('input', () => { if (!bcFindInput.value) $('bcFindCount').textContent = ''; api.browserPanelFind({ text: bcFindInput.value }); });
bcFindInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(!e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); closeBrowserFind(); }
});
$('bcFindNext').addEventListener('click', () => findStep(true));
$('bcFindPrev').addEventListener('click', () => findStep(false));
$('bcFindClose').addEventListener('click', closeBrowserFind);
if (api && api.onBrowserPanelFound) api.onBrowserPanelFound((d) => { $('bcFindCount').textContent = d.total ? `${d.active} of ${d.total}` : 'No matches'; });

// ── Point at an item: the next click on the page picks it, and it lands in the chat box ──
async function pickBrowserItem() {
  if (!api || !api.browserPanelPick || !bc.visible) return;
  const btn = $('bcPick');
  if (btn.classList.contains('active')) return;
  btn.classList.add('active');
  showToast('Click anything on the page. Esc cancels.');
  const r = await api.browserPanelPick();
  btn.classList.remove('active');
  if (!r || r.cancelled) return;
  if (r.error) { showToast(r.error, 'error'); return; }
  let host = '';
  try { host = r.url.startsWith('file:') ? decodeURIComponent(r.url.split(/[\\/]/).pop()) : new URL(r.url).host; } catch {}
  const words = r.text ? ` "${r.text.replace(/\s+/g, ' ').slice(0, 120)}"` : '';
  const about = `About this ${r.tag}${words} on ${host || 'the page'} (${r.selector}): `;
  // The new Craft is showing: the pick goes into its composer, not the hidden Classic one.
  if (dshShown && api.dshInsert) { api.dshInsert({ text: about, image: r.image || '' }); return; }
  const composer = [...document.querySelectorAll('.composer')].find((c) => c.offsetParent) || document.querySelector('.chat-composer .composer');
  if (!composer) return;
  if (r.image && composer.addImage) composer.addImage(r.image);
  const input = composer.querySelector('.composer-input');
  input.value = `${about}${input.value}`;
  input.dispatchEvent(new Event('input'));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
$('bcPick').addEventListener('click', pickBrowserItem);

// ── The panel's edge: drag it to resize ──
let dragState = null;
const bcResize = $('bcResize');
function setPanelRatio(ratio, live) {
  const r = Math.min(0.75, Math.max(0.25, ratio));
  document.documentElement.style.setProperty('--browser-panel-width', Math.round(r * window.innerWidth) + 'px');
  if (live) api.browserPanelResize(r);
  return r;
}
bcResize.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0 || !bc.visible) return;
  e.preventDefault();
  bcResize.setPointerCapture(e.pointerId);
  dragState = { raf: 0, ratio: null };
  document.body.classList.add('bc-dragging');
  await freezeBrowser(true);
});
bcResize.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  dragState.ratio = (window.innerWidth - dockTasksW - e.clientX) / window.innerWidth;
  if (dragState.raf) return;
  dragState.raf = requestAnimationFrame(() => {
    if (!dragState) return;
    dragState.raf = 0;
    setPanelRatio(dragState.ratio, true);
  });
});
const endDrag = async () => {
  if (!dragState) return;
  const ratio = dragState.ratio;
  dragState = null;
  document.body.classList.remove('bc-dragging');
  if (ratio != null) api.browserPanelResize(Math.min(0.75, Math.max(0.25, ratio)));
  await freezeBrowser(false);
};
bcResize.addEventListener('pointerup', endDrag);
bcResize.addEventListener('pointercancel', endDrag);
bcResize.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--browser-panel-width')) / window.innerWidth || 0.45;
  api.browserPanelResize(setPanelRatio(cur + (e.key === 'ArrowLeft' ? 0.02 : -0.02), false));
});

// Shortcuts while the browser is open.
document.addEventListener('keydown', (e) => {
  if (!bc.visible) return;
  if (e.key === 'Escape' && bc.menu) { closeBrowserMenu(); $('bcMenuBtn').focus(); return; }
  if (!e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 't' && !e.shiftKey) { e.preventDefault(); api.browserPanelNewTab(); }
  else if (k === 'f' && !e.shiftKey && !e.target.closest('.composer')) { e.preventDefault(); openBrowserFind(); }
  else if (e.shiftKey && (k === '.' || k === '>')) { e.preventDefault(); pickBrowserItem(); }
});

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
    theme: { background: getComputedStyle(document.body).getPropertyValue('--sidebar-bg').trim() || '#101012', foreground: '#e4e4e7', cursor: '#e4e4e7' },
    cursorBlink: true,
  });
  termFit = new FitAddon.FitAddon();
  term.loadAddon(termFit);
  term.open($('terminalBody'));
  // No real pty backs this (see main.js) - the child's stdin is a plain pipe,
  // so there's no line discipline on the other end to turn a raw backspace
  // byte into "erase the previous character". Line editing has to happen
  // here instead: buffer keystrokes locally, echo them ourselves, and only
  // flush a complete line to the process when Enter is pressed.
  let inputBuffer = '';
  term.onData((data) => {
    // A whole chunk starting with ESC is a control sequence (arrow keys,
    // home/end, etc.) - there's no cursor-within-line editing to apply it
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
        // lone ESC with no following bytes yet - ignore
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
  $('terminalToggleBtn').classList.add('active');
  layoutDock();
  if (!termStarted && api) {
    termStarted = true;
    const r = await api.terminalStart(state.project || null);
    // The shell reads a pipe, so it prints its prompt only after a line: send one, so it opens ready.
    if (r && r.ok && !r.already) api.terminalInput('\n');
  }
}

function closeTerminal() {
  $('terminalPanel').classList.add('hidden');
  $('terminalPanel').classList.remove('expanded');
  $('terminalToggleBtn').classList.remove('active');
  layoutDock();
}

function openBgTasks() {
  $('bgTasksPanel').classList.remove('hidden');
  $('bgTasksToggleBtn')?.classList.add('active');
  layoutDock();
  renderBgTasks();
}

function closeBgTasks() {
  $('bgTasksPanel').classList.add('hidden');
  $('bgTasksToggleBtn')?.classList.remove('active');
  $('bgTasksPanel').classList.remove('expanded');
  layoutDock();
  renderBgTasks();
}

// ─── Docks ───────────────────────────────────────────────────────────────────
// Laid out like Claude's. Background tasks is its own column on the far
// right. The terminal shares the browser's column: under the page when the
// browser is open (its top edge drags), the whole column when it is closed.
// Sizes follow the window, and the chat keeps at least CHAT_MIN wide.
// main.js is told the insets, so Craft's page shrinks to fit instead of
// drawing over the terminal; Expand gives the terminal the whole column, with
// the page stepping aside under it.
const CHAT_MIN = 420;
let dockTasksW = 0;   // the tasks column's width, 0 while closed
let termHeightPx = 0; // the terminal's height under the browser, once dragged
const clampPx = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function layoutDock() {
  const term = $('terminalPanel');
  const tasks = $('bgTasksPanel');
  if (!term || !tasks) return;
  const app = document.querySelector('.app');
  const root = document.documentElement.style;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const sidebarW = document.querySelector('.sidebar')?.getBoundingClientRect().width || 0;
  const termOpen = !term.classList.contains('hidden');
  const tasksOpen = !tasks.classList.contains('hidden');
  const browserOpen = !!(bc && bc.visible);
  const termExpanded = termOpen && term.classList.contains('expanded');
  const tasksExpanded = tasksOpen && tasks.classList.contains('expanded');
  // The tasks column: about a fifth of the window, wider when expanded.
  dockTasksW = !tasksOpen ? 0 : Math.round(tasksExpanded ? clampPx(W * 0.32, 320, 560) : clampPx(W * 0.2, 240, 340));
  // The browser/terminal column, never squeezing the chat under CHAT_MIN.
  const room = Math.max(280, W - sidebarW - dockTasksW - CHAT_MIN);
  // With the browser open the column is the browser's own width (its edge drags it live).
  const termW = Math.round(Math.min(clampPx(W * 0.32, 340, 620), room));
  const column = browserOpen ? 'var(--browser-panel-width)' : termOpen ? termW + 'px' : '0px';
  const termH = !termOpen ? 0 : (!browserOpen || termExpanded) ? H - 42 : Math.round(clampPx(termHeightPx || H * 0.38, 140, H - 42 - 220));
  root.setProperty('--tasks-width', dockTasksW + 'px');
  root.setProperty('--term-width', browserOpen ? 'var(--browser-panel-width)' : termW + 'px');
  root.setProperty('--term-top', (H - termH) + 'px');
  term.classList.toggle('under-browser', termOpen && browserOpen && !termExpanded);
  app.style.marginRight = `calc(${column} + ${dockTasksW}px)`;
  app.classList.toggle('dock-tasks-open', tasksOpen);
  // Craft's browser: its chrome left of the tasks column; main.js fits the page above the terminal.
  const chrome = $('browserChrome');
  if (chrome) chrome.style.right = dockTasksW + 'px';
  const edge = $('bcResize');
  if (edge) edge.style.right = `calc(var(--browser-panel-width) + ${dockTasksW - 3}px)`;
  const ghost = $('bcGhost');
  if (ghost) { ghost.style.right = dockTasksW + 'px'; ghost.style.bottom = (browserOpen && termOpen && !termExpanded ? termH : 0) + 'px'; }
  // The chat keeps CHAT_MIN: the browser gets narrower while the tasks column needs the room.
  if (api && api.browserPanelInsets) api.browserPanelInsets({ right: dockTasksW, bottom: browserOpen && termOpen && !termExpanded ? termH : 0, maxWidth: Math.round(room) });
  if (browserOpen) requestAnimationFrame(() => { reportBrowserLayout(); syncBrowserCover(); });
  document.querySelectorAll('[data-dock-expand]').forEach((b) => {
    const on = $(b.dataset.dockExpand).classList.contains('expanded');
    b.classList.toggle('active', on);
    b.title = on ? 'Collapse' : 'Expand';
  });
  if (term && termFit && termOpen) requestAnimationFrame(() => { try { termFit.fit(); } catch {} });
}
document.querySelectorAll('[data-dock-expand]').forEach((b) => b.addEventListener('click', () => {
  const panel = $(b.dataset.dockExpand);
  panel.classList.toggle('expanded');
  layoutDock();
}));
window.addEventListener('resize', () => layoutDock());
// Drag the terminal's top edge to give it more or less of the column.
(() => {
  const panel = $('terminalPanel');
  if (!panel) return;
  const grip = document.createElement('div');
  grip.className = 'term-resize';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'horizontal');
  grip.setAttribute('aria-label', 'Resize the terminal');
  panel.prepend(grip);
  let dragging = false;
  grip.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; dragging = true; grip.setPointerCapture(e.pointerId); e.preventDefault(); });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    termHeightPx = window.innerHeight - e.clientY;
    layoutDock();
  });
  const end = () => { dragging = false; };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
})();

$('terminalToggleBtn').addEventListener('click', () => {
  if ($('terminalPanel').classList.contains('hidden')) openTerminal();
  else closeTerminal();
});
$('termCloseBtn').addEventListener('click', closeTerminal);
$('bgTasksToggleBtn').addEventListener('click', () => {
  if ($('bgTasksPanel').classList.contains('hidden')) openBgTasks();
  else closeBgTasks();
});
$('termClearBtn').addEventListener('click', () => term && term.clear());

// ─── Sidebar lists ──────────────────────────────────────────────────────────
// The same pattern as Crew: a few actions, then one folding section per
// project and a "No project" section for chats without a folder. Sections
// follow the remembered project list's order, then any other folder a chat
// ran in. Each shows five chats and grows five at a time; Search (Ctrl+K)
// filters every row. Running and unread marks are repainted in place, so a
// live run never rebuilds the list under the mouse.
const SB_STEP = 5;
const SB_FOLDED_KEY = 'craft.sb.folded';
const SB_UNREAD_KEY = 'craft.sb.unread';
function sbLoadSet(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
}
function sbSaveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch {}
}
const sb = {
  folded: sbLoadSet(SB_FOLDED_KEY), // section keys folded away
  unread: sbLoadSet(SB_UNREAD_KEY), // chats that finished or arrived while another one was open
  shown: new Map(),                 // section key -> how many chats show
  paths: new Map(),                 // section key -> project folder (null for "No project")
  query: '',
  renaming: false,                  // a rename field is open; the list waits for it to close
};
const SB_ICON = {
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  caret: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-7 9z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
  // A project's folder: closed while its chats are folded away, open otherwise.
  folder: '<svg class="sb-ic-folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  folderOpen: '<svg class="sb-ic-folder-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 17.5V7.5a2 2 0 0 1 2-2h3.6l2 2.2h6.4a2 2 0 0 1 2 2v1.3"/><path d="M3.5 17.5l2.3-6a1.6 1.6 0 0 1 1.5-1h13.2a1 1 0 0 1 .9 1.4l-2.4 5.9a1.6 1.6 0 0 1-1.5 1H5a1.5 1.5 0 0 1-1.5-1.3z"/></svg>',
  chats: '<svg class="sb-ic-chats" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a7.5 7.5 0 0 1-11.2 6.5L4 19.5l1-4.4A7.5 7.5 0 1 1 20 12z"/></svg>',
};
const sbAttr = (s) => esc(String(s == null ? '' : s)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Windows paths: one folder however its slashes or letter case were written.
const sbPathKey = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const sbFolderName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

function sbSections() {
  const byKey = new Map();
  const add = (p) => {
    const key = 'p:' + sbPathKey(p);
    if (!byKey.has(key)) byKey.set(key, { key, path: p, name: sbFolderName(p), chats: [] });
    return byKey.get(key);
  };
  for (const p of state.projects) add(p);
  const loose = [];
  for (const s of state.sessions) (s.cwd ? add(s.cwd).chats : loose).push(s);
  const list = [...byKey.values()];
  if (loose.length) list.push({ key: 'none', path: null, name: 'No project', chats: loose });
  return list;
}

function sbMarkHtml(id) {
  if ((state.runningSessions || []).includes(id)) return '<span class="sb-mark busy" role="img" aria-label="Running" title="Running"></span>';
  if (sb.unread.has(id)) return '<span class="sb-mark unread" role="img" aria-label="Unread" title="Unread"></span>';
  return '';
}

function sbChatHtml(s) {
  const title = s.title || 'New chat';
  const cur = s.id === state.currentSessionId;
  return `<div class="sb-chat-row" data-id="${sbAttr(s.id)}">`
    + `<button class="sb-chat" type="button" data-key="c:${sbAttr(s.id)}" title="${sbAttr(title)}"${cur ? ' aria-current="true"' : ''}><span class="sb-chat-label">${esc(title)}</span>${sbMarkHtml(s.id)}</button>`
    + `<button class="sb-chat-menu-btn" type="button" data-act="chat-menu" data-key="m:${sbAttr(s.id)}" title="More" aria-label="More for ${sbAttr(title)}">${SB_ICON.more}</button>`
    + '</div>';
}

function sbSectionHtml(sec, chats, n) {
  const q = sb.query;
  const closed = !q && sb.folded.has(sec.key);
  // Keep the open chat in view: the list grows until it shows.
  let limit = sb.shown.get(sec.key) || SB_STEP;
  const at = chats.findIndex((s) => s.id === state.currentSessionId);
  if (at >= limit) limit = Math.ceil((at + 1) / SB_STEP) * SB_STEP;
  const rows = q ? chats : chats.slice(0, limit);
  const left = chats.length - rows.length;
  const isCurrent = sec.path && state.project && sbPathKey(sec.path) === sbPathKey(state.project);
  const addLabel = sec.path ? `New chat in ${sec.name}` : 'New chat without a project';
  const k = sbAttr(sec.key);
  return `<section class="sb-sec${closed ? ' closed' : ''}${isCurrent ? ' current' : ''}" data-sec="${k}">`
    + '<div class="sb-sec-head">'
    + `<button class="sb-sec-toggle" type="button" data-key="t:${k}" aria-expanded="${!closed}" aria-controls="sbSec${n}"${sec.path ? ` title="${sbAttr(sec.path)}"` : ''}>${sec.path ? SB_ICON.folder + SB_ICON.folderOpen : SB_ICON.chats}<span>${esc(sec.name)}</span>${SB_ICON.caret}</button>`
    + `<button class="sb-sec-tool" type="button" data-act="add" data-key="a:${k}" title="${sbAttr(addLabel)}" aria-label="${sbAttr(addLabel)}">${SB_ICON.plus}</button>`
    + (sec.path ? `<button class="sb-sec-tool" type="button" data-act="project-menu" data-key="p:${k}" title="More" aria-label="More for ${sbAttr(sec.name)}">${SB_ICON.more}</button>` : '')
    + '</div>'
    + `<div class="sb-sec-body" id="sbSec${n}"${closed ? ' inert' : ''}><div>`
    + (rows.length ? rows.map(sbChatHtml).join('') : '<div class="sb-empty">No chats yet</div>')
    + (left > 0 && !q ? `<button class="sb-more" type="button" data-act="more" data-key="x:${k}">${SB_ICON.chev}Show ${Math.min(SB_STEP, left)} more</button>` : '')
    + '</div></div></section>';
}

function renderSidebar() {
  if (sb.renaming) return;
  const holder = $('sbSections');
  const active = document.activeElement;
  const focusKey = active && holder.contains(active) ? active.dataset.key : null;
  // Forget unread marks for chats that are gone.
  if (state.sessions.length) {
    const ids = new Set(state.sessions.map((s) => s.id));
    for (const id of sb.unread) if (!ids.has(id)) sb.unread.delete(id);
  }
  const q = sb.query;
  sb.paths.clear();
  let html = '';
  let n = 0;
  for (const sec of sbSections()) {
    sb.paths.set(sec.key, sec.path);
    const nameHit = !!q && !!sec.path && sec.name.toLowerCase().includes(q);
    const chats = !q || nameHit ? sec.chats : sec.chats.filter((s) => (s.title || '').toLowerCase().includes(q));
    if (q && !chats.length && !nameHit) continue;
    html += sbSectionHtml(sec, chats, n++);
  }
  if (q && !n) html = `<div class="sb-no-hits">No chats match "${esc($('sbSearchInput').value.trim())}"</div>`;
  holder.innerHTML = html;
  if (focusKey) {
    const el = holder.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (el) el.focus();
  }
}
// Every caller of the two old lists now repaints the one sidebar.
const renderProjects = () => renderSidebar();
const renderRecents = () => renderSidebar();

/** Running and unread dots, swapped in place on the rows already drawn. */
function sbPaintMarks() {
  document.querySelectorAll('#sbSections .sb-chat-row').forEach((row) => {
    const btn = row.querySelector('.sb-chat');
    if (!btn) return;
    const old = btn.querySelector('.sb-mark');
    const html = sbMarkHtml(row.dataset.id);
    if (old && html && old.outerHTML === html) return; // keep the pulse running
    if (old) old.remove();
    if (html) btn.insertAdjacentHTML('beforeend', html);
  });
}

/** A new running list: a chat whose run ended while another was open turns unread. */
function sbRunsChanged(ids) {
  const now = Array.isArray(ids) ? ids : [];
  for (const id of state.runningSessions || []) {
    if (!now.includes(id) && id !== state.currentSessionId) sb.unread.add(id);
  }
  state.runningSessions = now;
  sbSaveSet(SB_UNREAD_KEY, sb.unread);
  sbPaintMarks();
}
function sbMarkUnread(id, on) {
  if (!id || on === sb.unread.has(id)) return;
  if (on) sb.unread.add(id); else sb.unread.delete(id);
  sbSaveSet(SB_UNREAD_KEY, sb.unread);
  sbPaintMarks();
}

function sbToggleSection(secEl) {
  const key = secEl.dataset.sec;
  const closed = !secEl.classList.contains('closed');
  if (closed) sb.folded.add(key); else sb.folded.delete(key);
  sbSaveSet(SB_FOLDED_KEY, sb.folded);
  secEl.classList.toggle('closed', closed);
  secEl.querySelector('.sb-sec-toggle').setAttribute('aria-expanded', String(!closed));
  secEl.querySelector('.sb-sec-body').inert = closed;
}

/** The + on a section: a new chat in that project, or in no folder at all. */
async function sbNewChatIn(projectPath) {
  if (projectPath) {
    const r = await api.useProject(projectPath);
    if (r) setProject(r.path, r.branch);
  } else {
    setProject(null, null);
  }
  $('newChatBtn').click();
}

$('sbSections').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const secEl = btn.closest('.sb-sec');
  const key = secEl ? secEl.dataset.sec : null;
  const act = btn.dataset.act;
  if (btn.classList.contains('sb-chat')) {
    openSession(btn.closest('.sb-chat-row').dataset.id);
  } else if (act === 'chat-menu') {
    e.stopPropagation(); // the document click handler would close it straight away
    const s = state.sessions.find((x) => x.id === btn.closest('.sb-chat-row').dataset.id);
    if (s) openChatMenu(s, btn);
  } else if (btn.classList.contains('sb-sec-toggle')) {
    sbToggleSection(secEl);
  } else if (act === 'add') {
    sbNewChatIn(sb.paths.get(key));
  } else if (act === 'project-menu') {
    e.stopPropagation();
    openProjectMenu(sb.paths.get(key), btn);
  } else if (act === 'more') {
    const before = secEl.querySelectorAll('.sb-chat-row').length;
    sb.shown.set(key, before + SB_STEP);
    renderSidebar();
    // The button may be gone now; carry focus to the first chat that just appeared.
    const sec = $('sbSections').querySelector(`.sb-sec[data-sec="${CSS.escape(key)}"]`);
    const first = sec && sec.querySelectorAll('.sb-chat')[before];
    if (first && !sec.querySelector('.sb-more')) first.focus();
  }
});
// Right-click a chat or a project title for the same menu its ... button opens.
$('sbSections').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.sb-chat-row');
  const head = e.target.closest('.sb-sec-head');
  const menuBtn = row ? row.querySelector('.sb-chat-menu-btn') : head ? head.querySelector('[data-act="project-menu"]') : null;
  if (!menuBtn || e.target.closest('input')) return;
  e.preventDefault();
  e.stopPropagation();
  menuBtn.click();
});

// ─── Sidebar search (the Search row or Ctrl+K; Escape closes it) ────────────
function sbOpenSearch() {
  if ($('sidebar').classList.contains('collapsed')) setSidebarCollapsed(false);
  $('sbSearch').hidden = false;
  $('sbSearchBtn').setAttribute('aria-expanded', 'true');
  $('sbScroll').scrollTop = 0;
  $('sbSearchInput').focus();
  $('sbSearchInput').select();
}
function sbCloseSearch(refocus) {
  $('sbSearch').hidden = true;
  $('sbSearchBtn').setAttribute('aria-expanded', 'false');
  $('sbSearchInput').value = '';
  if (sb.query) { sb.query = ''; renderSidebar(); }
  if (refocus) $('sbSearchBtn').focus();
}
$('sbSearchBtn').addEventListener('click', () => ($('sbSearch').hidden ? sbOpenSearch() : sbCloseSearch(false)));
$('sbSearchInput').addEventListener('input', (e) => {
  sb.query = e.target.value.trim().toLowerCase();
  renderSidebar();
});
$('sbSearchInput').addEventListener('keydown', (e) => {
  const first = $('sbSections').querySelector('.sb-chat');
  if (e.key === 'Enter' && first) { e.preventDefault(); first.click(); }
  else if (e.key === 'ArrowDown' && first) { e.preventDefault(); first.focus(); }
});
$('sidebar').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('sbSearch').hidden || chatCtxMenuEl) return;
  if (e.target.classList.contains('sb-chat-rename-input')) return;
  e.preventDefault();
  sbCloseSearch(true);
});

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
  menu.className = 'menu chat-ctx-menu';
  menu.innerHTML = `
    <button class="menu-item" data-action="rename"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>Rename</button>
    <button class="menu-item" data-action="md"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>Save as Markdown</button>
    <button class="menu-item" data-action="html"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>Save as web page</button>
    <button class="menu-item" data-action="gist"><svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>Share as secret gist</button>
    <button class="menu-item danger" data-action="delete"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg>Delete</button>`;
  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8) + 'px';

  menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
    closeChatMenu();
    startRenameSession(session);
  });
  for (const kind of ['md', 'html', 'gist']) {
    menu.querySelector(`[data-action="${kind}"]`).addEventListener('click', () => {
      closeChatMenu();
      shareSessionAs(session, kind);
    });
  }
  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    closeChatMenu();
    confirmDeleteSession(session);
  });
  chatCtxMenuEl = menu;
}

async function shareSessionAs(session, kind) {
  if (kind === 'gist') showToast('Creating a secret gist...');
  const r = await api.shareSession(session.id, kind);
  if (r.canceled) return;
  if (!r.ok) { showToast(r.error || 'Could not share that chat.', 'error'); return; }
  if (kind === 'gist') {
    try { await navigator.clipboard.writeText(r.url); } catch {}
    showToast('Secret gist created. Link copied.');
  } else {
    showToast('Saved.');
  }
}

function startRenameSession(session) {
  const row = document.querySelector(`.sb-chat-row[data-id="${session.id}"]`);
  if (!row) return;
  const btn = row.querySelector('.sb-chat');
  const input = document.createElement('input');
  input.className = 'sb-chat-rename-input';
  input.setAttribute('aria-label', 'Chat name');
  input.value = session.title;
  btn.replaceWith(input);
  sb.renaming = true; // the list holds still until the name is saved
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
    sb.renaming = false;
    const refocus = document.activeElement === input || document.activeElement === document.body;
    renderRecents();
    const again = refocus && $('sbSections').querySelector(`[data-key="c:${CSS.escape(session.id)}"]`);
    if (again) again.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function confirmDeleteSession(session) {
  const r = await CraftModal.confirm({
    title: 'Delete chat?',
    body: `"${session.title || 'This chat'}" is deleted on this PC and your phone. Files in the project are not touched.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (r.ok) deleteSessionById(session.id);
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
  menu.className = 'menu chat-ctx-menu';
  menu.innerHTML = `
    <button class="menu-item" data-action="reveal"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Show in Explorer</button>
    <button class="menu-item danger" data-action="remove"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg>Remove from list</button>`;
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
 * Forgets a folder - it leaves the sidebar, nothing on disk changes, and
 * opening it again re-adds it. No confirmation for exactly that reason: the
 * label says "Remove from list", and the undo is picking the folder again.
 *
 * Removing the folder that's currently in use also clears the selection and
 * returns Home, rather than leaving the header pointing at a project that is
 * no longer in the list. A run already in flight keeps the cwd it started
 * with - that was resolved when the turn began.
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
    (el.textContent = state.bypass ? 'Full access' : 'Approve manually'));
}
document.querySelectorAll('[data-role="bypass"]').forEach((el) =>
  el.addEventListener('click', () => {
    state.bypass = !state.bypass;
    syncBypass();
  })
);

// ─── Models ─────────────────────────────────────────────────────────────────
// "Auto" is Codeply's router (Sonnet 5.5 for code, Haiku 5.5 for chat). Everything else is a model the user added
// - an OpenAI-compatible API or a local Ollama model. The main process keeps
// the keys; this side only ever sees a masked preview.
const MODEL_PRESETS = [
  { label: 'OpenAI', name: 'GPT-4o mini', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Claude', name: 'Claude Sonnet', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5' },
  { label: 'Gemini', name: 'Gemini Flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.7-flash' },
  { label: 'OpenRouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  { label: 'Groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  { label: 'DeepSeek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
];

const SPARK_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7Z"/></svg>';
const CHIP_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1.5v3M15 1.5v3M9 19.5v3M15 19.5v3M1.5 9h3M1.5 15h3M19.5 9h3M19.5 15h3"/></svg>';
// OpenAI's own Blossom mark, unmodified, from openai.com/brand (assets/brand/).
// styles.css swaps the white and black files with the theme; OpenAI's rules
// forbid recoloring it, so it's never tinted with currentColor.
const CHATGPT_SVG = '<span class="chatgpt-mark" role="img" aria-label="ChatGPT"></span>';
const LLAMA_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8 20h8M12 16v4"/><path d="M7.5 9.5l2 1.5-2 1.5M12 12.5h4"/></svg>';

function selectedModel() {
  if (state.models.selected === 'auto') return null;
  return state.models.models.find((m) => m.id === state.models.selected) || null;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}

function applyModelsState(models) {
  if (models && Array.isArray(models.models)) state.models = models;
  // ChatGPT plan sign-in was removed from the menu: anyone still on one of its models goes back to Auto
  const sel = state.models.models.find((x) => x.id === state.models.selected);
  if (sel && sel.kind === 'chatgpt' && api && !applyModelsState.movedOff) {
    applyModelsState.movedOff = true;
    api.selectModel('auto').then((r) => { if (r && r.ok) applyModelsState(r.state); }).catch(() => {});
  }
  const m = selectedModel();
  const label = m ? m.name : 'Haze 2';
  const kind = m ? (m.kind === 'ollama' ? 'local' : m.kind === 'chatgpt' ? 'chatgpt' : 'custom') : 'auto';
  document.querySelectorAll('[data-role="model-name"]').forEach((el) => {
    el.textContent = label;
    // OpenAI asks for "Using ChatGPT plan" next to the model picker while a plan model is in use.
    el.toggleAttribute('data-plan', kind === 'chatgpt');
  });
  document.querySelectorAll('[data-role="model-chip"]').forEach((el) => {
    el.dataset.kind = kind;
    el.title = !m ? 'Haze 2: the routing brain, run by Codeply'
      : kind === 'chatgpt' ? `${m.name} - using your ChatGPT plan`
      : `${m.name} - ${m.model} on ${hostOf(m.baseUrl)}`;
  });
}

/** "Synced" (usable on the phone with this PC off) or why syncing failed. */
function phoneBadge(m) {
  const p = m.phone;
  if (!p || !p.on) return '';
  if (p.synced) return '<span class="model-item-badge">Synced</span>';
  return p.reason ? '<span class="model-item-badge warn">Not synced</span>' : '<span class="model-item-badge">Syncing</span>';
}

let modelMenuEl = null;
function closeModelMenu() {
  if (modelMenuEl) { modelMenuEl.remove(); modelMenuEl = null; }
}
document.addEventListener('click', (e) => {
  if (modelMenuEl && !modelMenuEl.contains(e.target) && !e.target.closest('[data-role="model-chip"]')) closeModelMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelMenu(); });

async function pickModel(id) {
  closeModelMenu();
  if (id === state.models.selected) return;
  const r = await api.selectModel(id);
  if (!r.ok) { showToast(r.error || 'Could not switch model.', 'error'); return; }
  applyModelsState(r.state);
  const m = selectedModel();
  showToast(m ? `Using ${m.name}` : 'Using Haze 2');
}

function openModelMenu(anchorBtn) {
  closeModelMenu();
  const menu = document.createElement('div');
  menu.className = 'menu model-menu';
  const sel = state.models.selected;
  const check = '<svg class="model-item-check" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
  const custom = state.models.models.filter((m) => m.kind !== 'chatgpt');
  const LOCK = '<svg class="model-item-lock" viewBox="0 0 16 16" aria-hidden="true"><path class="lock-shackle" d="M5.25 7.25V5.5a2.75 2.75 0 0 1 5.5 0v1.75"/><path class="lock-body" fill-rule="evenodd" d="M4.6 7h6.8A1.6 1.6 0 0 1 13 8.6v4.3a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 12.9V8.6A1.6 1.6 0 0 1 4.6 7Zm3.4 2.2a1 1 0 0 0-.55 1.84v.96a.55.55 0 0 0 1.1 0v-.96A1 1 0 0 0 8 9.2Z"/></svg>';
  const autoModels = [['Sonnet 5.5', 'Code and hard tasks'], ['Haiku 5.5', 'Quick answers'], ['Non-disclosed models', 'Casual chat']].map(([name, why]) => `
    <div class="model-item locked" aria-disabled="true" title="Haze 2 picks these for you">
      <span class="model-item-icon custom">${CHIP_SVG}</span>
      <span class="model-item-text"><strong>${name}</strong><span>${why}</span></span>
      ${LOCK}
    </div>`).join('');
  menu.innerHTML = `
    <div class="model-menu-title">Select model</div>
    <button class="model-item${sel === 'auto' ? ' active' : ''}" data-id="auto">
      <span class="model-item-icon auto">${SPARK_SVG}</span>
      <span class="model-item-text"><strong>Haze 2</strong><span>The routing brain</span></span>
      ${sel === 'auto' ? check : ''}
    </button>
    ${autoModels}
    ${custom.length ? '<div class="model-menu-label">Your models</div>' : ''}
    ${custom.map((m) => `
      <div class="model-item-row">
        <button class="model-item${sel === m.id ? ' active' : ''}" data-id="${esc(m.id)}">
          <span class="model-item-icon ${m.kind === 'ollama' ? 'local' : 'custom'}">${m.kind === 'ollama' ? LLAMA_SVG : CHIP_SVG}</span>
          <span class="model-item-text"><strong>${esc(m.name)}${phoneBadge(m)}</strong><span>${esc(m.model)} · ${esc(m.kind === 'ollama' ? 'on this computer' : hostOf(m.baseUrl))}</span></span>
          ${sel === m.id ? check : ''}
        </button>
        ${m.phone && m.phone.eligible ? `<button class="model-item-tool icon-btn icon-btn-xs${m.phone.on ? ' on' : ''}" data-phone="${esc(m.id)}" title="${esc(m.phone.on ? (m.phone.synced ? 'On your phone. Click to stop syncing it' : m.phone.reason || 'Syncing to your phone') : 'Sync to phone: use it there even when this PC is off')}"><svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/></svg></button>` : ''}
        <button class="model-item-tool icon-btn icon-btn-xs" data-edit="${esc(m.id)}" title="Edit"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button class="model-item-tool icon-btn icon-btn-xs danger" data-delete="${esc(m.id)}" title="Remove"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/></svg></button>
      </div>`).join('')}
    <div class="model-menu-divider"></div>
    <button class="model-menu-action" data-action="add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add a model</button>
    <button class="model-menu-ollama" data-action="ollama">Connect Ollama</button>`;
  document.body.appendChild(menu);

  const rect = anchorBtn.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  menu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';

  menu.querySelectorAll('.model-item[data-id]').forEach((btn) => btn.addEventListener('click', () => pickModel(btn.dataset.id)));
  menu.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const m = state.models.models.find((x) => x.id === btn.dataset.edit);
    closeModelMenu();
    if (m) openModelsModal({ tab: m.kind === 'ollama' ? 'ollama' : 'custom', edit: m });
  }));
  menu.querySelectorAll('[data-phone]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const m = state.models.models.find((x) => x.id === btn.dataset.phone);
    if (!m) return;
    const on = !(m.phone && m.phone.on);
    if (!on && !(await CraftModal.confirm({ title: 'Stop syncing to your phone?', body: `The key for "${m.name}" is removed from your Codeply account. It stays on this computer.`, confirmLabel: 'Stop syncing' })).ok) return;
    btn.disabled = true;
    const r = await api.setModelPhone(m.id, on);
    if (r.state) applyModelsState(r.state);
    if (!r.ok) showToast(r.error || 'Could not sync it.', 'error');
    else showToast(on ? `${m.name} is on your phone now` : `${m.name} is no longer on your phone`);
    if (modelMenuEl) openModelMenu(anchorBtn);
  }));
  menu.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const m = state.models.models.find((x) => x.id === btn.dataset.delete);
    if (!m) return;
    closeModelMenu();
    if (!(await CraftModal.confirm({ title: `Remove ${m.name}?`, body: `Its API key is deleted from this computer${m.synced ? ' and from your phone' : ''} too.`, confirmLabel: 'Remove', danger: true })).ok) return;
    const r = await api.deleteModel(m.id);
    if (r.ok) { applyModelsState(r.state); showToast(`Removed ${m.name}`); }
  }));
  menu.querySelector('[data-action="add"]').addEventListener('click', () => { closeModelMenu(); openModelsModal({ tab: 'custom' }); });
  menu.querySelector('[data-action="ollama"]').addEventListener('click', () => { closeModelMenu(); openOllamaConnect(); });
  menu.querySelector('[data-action="chatgpt-signin"]')?.addEventListener('click', () => { closeModelMenu(); signInWithChatGPT(); });
  menu.querySelector('[data-action="chatgpt-usage"]')?.addEventListener('click', () => { closeModelMenu(); api.openExternal(CHATGPT_USAGE_URL); });
  menu.querySelector('[data-action="chatgpt-signout"]')?.addEventListener('click', async () => {
    closeModelMenu();
    if (!(await CraftModal.confirm({ title: 'Disconnect ChatGPT?', body: 'Codeply stops using your ChatGPT plan until you sign in again.', confirmLabel: 'Disconnect', danger: true })).ok) return;
    const r = await api.chatgptSignOut();
    if (!r.ok) { showToast(r.error || 'Could not disconnect.', 'error'); return; }
    state.chatgpt = r.status;
    applyModelsState(r.state);
    showToast('ChatGPT disconnected');
  });
  modelMenuEl = menu;
}

// ─── Sign in with ChatGPT ───────────────────────────────────────────────────
// Opens OpenAI's sign-in in the browser; the plan's models then join the
// model menu. main.js / chatgpt.js do the OAuth and keep the tokens.
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
let chatgptSigningIn = false;

async function signInWithChatGPT() {
  if (chatgptSigningIn) return;
  chatgptSigningIn = true;
  showToast('Finish signing in to ChatGPT in your browser…');
  try {
    const r = await api.chatgptSignIn();
    if (!r.ok) { showToast(r.error || 'ChatGPT sign-in failed.', 'error'); return; }
    state.chatgpt = r.status;
    applyModelsState(r.state);
    if (r.warning) { await CraftModal.alert({ title: 'ChatGPT', body: r.warning }); return; }
    // The first model the plan offers becomes the pick, so the sign-in does something visible.
    const first = state.models.models.find((m) => m.kind === 'chatgpt');
    if (first) await pickModel(first.id);
    // The disclosure OpenAI asks apps to show after the first sign-in.
    await CraftModal.alert({ title: 'Using your ChatGPT plan', body: 'Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings (chatgpt.com/settings/usage).' });
  } finally {
    chatgptSigningIn = false;
  }
}

document.querySelectorAll('[data-role="model-chip"]').forEach((btn) =>
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modelMenuEl) { closeModelMenu(); return; }
    openModelMenu(btn);
  })
);

// ─── Models modal (add / edit a model, connect Ollama) ─────────────────────
let editingModelId = null;

let modelsOllamaOnly = false;
function setModelsTab(tab) {
  document.querySelectorAll('.models-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
    t.classList.toggle('hidden', modelsOllamaOnly && t.dataset.tab === 'custom');
    if (t.dataset.tab === 'ocloud') t.textContent = modelsOllamaOnly ? 'Online' : 'Ollama online';
    if (t.dataset.tab === 'ollama') t.textContent = modelsOllamaOnly ? 'Local' : 'Ollama local';
  });
  $('modelsPaneCustom').classList.toggle('hidden', tab !== 'custom');
  $('modelsPaneOllama').classList.toggle('hidden', tab !== 'ollama');
  $('modelsPaneOllamaCloud').classList.toggle('hidden', tab !== 'ocloud');
  if (tab === 'ollama') detectOllamaModels();
  if (tab === 'ocloud') openOllamaCloud();
}

// ─── Ollama Cloud: the person's own account (main.js ollamaCloud:*) ─────────
// Through the Ollama app on this PC (no key: it signs in to ollama.com itself)
// or with a pasted API key. Either way, then pick from Ollama's live cloud list.
let ocWay = null; // { via: 'app' } or { via: 'key', key }
let ocPoll = null;
// The app names a cloud model "<name>-cloud" when it has a size tag, else "<name>:cloud"
const ocLocalName = (name) => (name.includes(':') ? `${name}-cloud` : `${name}:cloud`);

function openOllamaConnect() {
  // the full Connect Ollama page (ollama-connect.js); the small window is the fallback
  if (window.OllamaConnect) { window.OllamaConnect.open(); return; }
  openModelsModal({ tab: 'ocloud', ollamaOnly: true });
  const hasKeyModel = state.models.models.some((m) => /ollama\.com/.test(m.baseUrl || ''));
  if (!ocWay && !hasKeyModel) api.ollamaCloudOpenKeys();
  setTimeout(() => $('ocKey').focus(), 60);
}

async function openOllamaCloud() {
  clearInterval(ocPoll);
  if (ocWay) { listOllamaCloud(); return; }
  $('ocList').innerHTML = '';
  const body = $('ocAppBody');
  $('ocApp').classList.add('hidden');
  const r = await api.ollamaCloudLocal();
  if (!r.running) return;
  $('ocApp').classList.remove('hidden');
  if (r.signedIn) { ocWay = { via: 'app' }; body.innerHTML = '<div class="ollama-status ok">Connected through the Ollama app.</div>'; listOllamaCloud(); return; }
  body.innerHTML = `<div class="ollama-status${r.error ? ' error' : ''}">${esc(r.error || 'Ollama is running here. Sign it in to ollama.com once and its online models work with no key.')}</div>
    ${r.error ? '' : '<button class="btn btn-secondary btn-sm" id="ocSignin">Sign in to Ollama</button>'}`;
  const btn = $('ocSignin');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Waiting for you in the browser…';
    const s = await api.ollamaCloudSignin(r.signinUrl || '');
    if (!s.ok) { btn.disabled = false; btn.textContent = 'Sign in to Ollama'; body.insertAdjacentHTML('beforeend', `<div class="ollama-status error">${esc(s.error)}</div>`); return; }
    // check every few seconds until the app is signed in (up to 3 minutes)
    const until = Date.now() + 3 * 60_000;
    ocPoll = setInterval(async () => {
      if (Date.now() > until) { clearInterval(ocPoll); btn.disabled = false; btn.textContent = 'Try again'; return; }
      const again = await api.ollamaCloudLocal();
      if (again.signedIn) { clearInterval(ocPoll); ocWay = { via: 'app' }; body.innerHTML = '<div class="ollama-status ok">Connected through the Ollama app.</div>'; listOllamaCloud(); }
    }, 4000);
  });
}

async function connectOllamaKey() {
  const key = $('ocKey').value.trim();
  const st = $('ocKeyStatus');
  st.classList.remove('hidden', 'error', 'ok');
  st.innerHTML = '<span class="spinner"></span>Checking the key…';
  $('ocKeyBtn').disabled = true;
  const r = await api.ollamaCloudCheckKey(key);
  $('ocKeyBtn').disabled = false;
  if (!r.ok) { st.classList.add('error'); st.textContent = r.error; return; }
  ocWay = { via: 'key', key };
  st.classList.add('ok');
  st.textContent = 'Connected with your key.';
  listOllamaCloud();
}

async function listOllamaCloud() {
  const list = $('ocList');
  list.innerHTML = '<div class="ollama-status"><span class="spinner"></span>Loading Ollama\'s cloud models…</div>';
  const r = await api.ollamaCloudModels();
  if (!r.ok) { list.innerHTML = `<div class="ollama-status error">${esc(r.error)}</div>`; return; }
  const viaApp = ocWay && ocWay.via === 'app';
  const saved = new Set(state.models.models.map((m) => m.model));
  list.innerHTML = `<div class="oc-list-head">Pick a model to add</div>` + r.models.map((m) => {
    const id = viaApp ? ocLocalName(m.name) : m.name;
    return `<div class="ollama-row">
      <span class="model-item-icon local">${LLAMA_SVG}</span>
      <div class="ollama-row-text"><strong>${esc(m.name)}</strong><span>Ollama Cloud${viaApp ? ' · through the app' : ' · your key'}</span></div>
      <button class="btn btn-secondary btn-sm" data-oc="${esc(id)}" data-name="${esc(m.name)}">${saved.has(id) ? 'Use' : 'Add'}</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-oc]').forEach((b) => b.addEventListener('click', () => addOllamaCloudModel(b.dataset.oc, b.dataset.name, b)));
}

async function addOllamaCloudModel(model, name, btn) {
  const viaApp = ocWay && ocWay.via === 'app';
  const existing = state.models.models.find((m) => m.model === model && (viaApp ? m.kind === 'ollama' : /ollama\.com/.test(m.baseUrl || '')));
  if (existing) { await pickModel(existing.id); closeModelsModal(); return; }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Testing…';
  const r = await api.saveModel(viaApp
    ? { kind: 'ollama', name: `${name} (Ollama Cloud)`, baseUrl: 'http://localhost:11434', model, apiKey: '' }
    : { kind: 'openai', name: `${name} (Ollama Cloud)`, baseUrl: 'https://ollama.com/v1', model, apiKey: ocWay.key });
  if (!r.ok) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    const st = document.createElement('div');
    st.className = 'ollama-status error';
    st.textContent = r.error;
    btn.closest('.ollama-row').after(st);
    return;
  }
  applyModelsState(r.state);
  closeModelsModal();
}

$('ocKeyBtn').addEventListener('click', connectOllamaKey);
$('ocKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connectOllamaKey(); } });
$('ocGetKey').addEventListener('click', () => api.ollamaCloudOpenKeys());

function showModelsError(msg, { canSkip = false } = {}) {
  $('mError').textContent = msg || '';
  $('mError').classList.toggle('hidden', !msg);
  $('mSaveAnyway').classList.toggle('hidden', !canSkip);
}

function openModelsModal({ tab = 'custom', edit = null, ollamaOnly = false } = {}) {
  modelsOllamaOnly = ollamaOnly;
  $('modelsPaneOllamaCloud').classList.toggle('only', ollamaOnly); // the header already says it
  editingModelId = edit && edit.kind !== 'ollama' ? edit.id : null;
  $('modelsTitle').textContent = ollamaOnly ? 'Connect Ollama' : editingModelId ? 'Edit model' : 'Add a model';
  $('modelsDesc').textContent = ollamaOnly
    ? 'Big open models on your own Ollama account: online with a key, or on this computer.'
    : 'Use your own model instead of Haze 2. Any OpenAI-compatible API works, or Ollama online or on this computer.';
  $('mName').value = editingModelId ? edit.name : '';
  $('mBaseUrl').value = editingModelId ? edit.baseUrl : '';
  $('mModel').value = editingModelId ? edit.model : '';
  $('mKey').value = '';
  $('mKey').placeholder = editingModelId && edit.hasKey ? `Saved (${edit.keyPreview}) - leave blank to keep it` : 'sk-…  (leave blank if the server needs no key)';
  // Use on my phone: on by default for a new model, the saved choice when editing.
  $('mPhone').checked = editingModelId ? !!(edit.phone && edit.phone.on) : true;
  syncPhoneHint();
  if (edit && edit.kind === 'ollama') $('oHost').value = edit.baseUrl;
  showModelsError('');
  $('mSave').disabled = false;
  $('mSave').textContent = editingModelId ? 'Test & update' : 'Test & save';
  $('modelsPresets').classList.toggle('hidden', !!editingModelId);
  setModelsTab(tab);
  CraftModal.open('modelsBackdrop', { onClose: closeModelsModal });
  if (tab === 'custom') setTimeout(() => (editingModelId ? $('mKey') : $('mBaseUrl')).focus(), 30);
}

function closeModelsModal() { CraftModal.close('modelsBackdrop'); }

$('modelsPresets').innerHTML = '<span class="models-presets-label">Quick fill</span>' +
  MODEL_PRESETS.map((p, i) => `<button class="preset-chip" data-i="${i}">${esc(p.label)}</button>`).join('');
$('modelsPresets').querySelectorAll('.preset-chip').forEach((btn) => btn.addEventListener('click', () => {
  const p = MODEL_PRESETS[Number(btn.dataset.i)];
  $('mName').value = p.name;
  $('mBaseUrl').value = p.baseUrl;
  $('mModel').value = p.model;
  $('mKey').focus();
}));

async function saveCustomModel(skipTest) {
  const name = $('mName').value.trim();
  const baseUrl = $('mBaseUrl').value.trim();
  const model = $('mModel').value.trim();
  const key = $('mKey').value.trim();
  if (!baseUrl || !model) return showModelsError('Enter a base URL and a model ID.');
  showModelsError('');
  const btn = $('mSave');
  btn.disabled = true;
  btn.textContent = skipTest ? 'Saving…' : 'Testing…';
  const r = await api.saveModel({
    id: editingModelId || undefined, kind: 'openai', name, baseUrl, model,
    // Blank while editing = keep the saved key.
    apiKey: editingModelId && !key ? undefined : key,
    skipTest: !!skipTest,
    phone: $('mPhone').checked,
  });
  btn.disabled = false;
  btn.textContent = editingModelId ? 'Test & update' : 'Test & save';
  if (!r.ok) return showModelsError(r.testFailed ? `The test request failed: ${r.error}` : r.error, { canSkip: !!r.testFailed });
  applyModelsState(r.state);
  closeModelsModal();
  showToast(`${r.model.name} is ready - now using it`);
}

// A phone switched the model: keep this window's chip in sync.
if (api && api.onModelsChanged) api.onModelsChanged((m) => applyModelsState(m));

/** Explains what the phone switch does, and why a model cannot be synced (no key, http, private address). */
function syncPhoneHint() {
  const edit = editingModelId && state.models.models.find((m) => m.id === editingModelId);
  const base = $('mBaseUrl').value.trim();
  const hasKey = !!$('mKey').value.trim() || !!(edit && edit.hasKey);
  let why = '';
  if (!hasKey) why = 'Needs an API key. Without one the model only works through this PC.';
  else if (base && !/^https:\/\//i.test(base)) why = 'Needs an https address. This one only works through this PC.';
  else if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[)/i.test(base)) why = 'This address is on your own network, so it only works through this PC.';
  const on = $('mPhone').checked;
  $('mPhone').disabled = !!why;
  $('mPhoneHint').textContent = why || (on ? 'Works on your phone even when this PC is off.' : 'Your phone can use it only while this PC is on.');
  $('mPrivacy').textContent = on && !why
    ? "Your API key is saved on this computer and sent once to your Codeply account, where it is stored encrypted for your phone. It is never shown again, and is only used to call the base URL above."
    : 'Your API key is saved only on this computer and is never sent to Codeply. It is used for exactly one thing: calling the base URL above.';
}
['mBaseUrl', 'mKey'].forEach((id) => $(id).addEventListener('input', syncPhoneHint));
$('mPhone').addEventListener('change', syncPhoneHint);

$('mSave').addEventListener('click', () => saveCustomModel(false));
$('mSaveAnyway').addEventListener('click', () => saveCustomModel(true));
['mName', 'mBaseUrl', 'mModel', 'mKey'].forEach((id) => $(id).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveCustomModel(false); }
}));

function formatBytes(n) {
  if (!n) return '';
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

async function detectOllamaModels() {
  const list = $('oList');
  list.innerHTML = '<div class="ollama-status"><span class="spinner"></span>Looking for Ollama…</div>';
  const r = await api.detectOllama($('oHost').value.trim());
  if (!r.ok) {
    list.innerHTML = `<div class="ollama-status error">${esc(r.error || 'Could not reach Ollama.')}</div>`;
    return;
  }
  if (!r.models.length) {
    list.innerHTML = '<div class="ollama-status">Ollama is running but has no models yet. Run <code>ollama pull qwen2.5-coder</code>, then click Find models again.</div>';
    return;
  }
  const added = new Set(state.models.models.filter((m) => m.kind === 'ollama').map((m) => m.model));
  list.innerHTML = r.models.map((m) => `
    <div class="ollama-row">
      <span class="model-item-icon local">${LLAMA_SVG}</span>
      <div class="ollama-row-text"><strong>${esc(m.name)}</strong><span>${esc([m.params, m.family, formatBytes(m.size)].filter(Boolean).join(' · '))}</span></div>
      <button class="btn btn-secondary btn-sm" data-model="${esc(m.name)}">${added.has(m.name) ? 'Use' : 'Add'}</button>
    </div>`).join('');
  list.querySelectorAll('[data-model]').forEach((btn) => btn.addEventListener('click', () => addOllamaModel(btn.dataset.model, r.host, btn)));
}

async function addOllamaModel(model, host, btn) {
  const existing = state.models.models.find((m) => m.kind === 'ollama' && m.model === model && m.baseUrl === host);
  if (existing) {
    await pickModel(existing.id);
    closeModelsModal();
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Loading…';
  const status = document.createElement('div');
  status.className = 'ollama-status';
  status.textContent = 'Loading the model for a quick test - the first load can take a minute.';
  btn.closest('.ollama-row').after(status);
  const r = await api.saveModel({ kind: 'ollama', name: `${model} (local)`, baseUrl: host, model, apiKey: '' });
  if (!r.ok) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    status.className = 'ollama-status error';
    status.textContent = r.error;
    return;
  }
  applyModelsState(r.state);
  closeModelsModal();
  showToast(`${model} is ready - running locally`);
}

$('oDetect').addEventListener('click', detectOllamaModels);
$('oHost').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); detectOllamaModels(); } });
document.querySelectorAll('.models-tab').forEach((t) => t.addEventListener('click', () => setModelsTab(t.dataset.tab)));
$('modelsCloseBtn').addEventListener('click', closeModelsModal);
$('modelsBackdrop').addEventListener('click', (e) => { if (e.target === $('modelsBackdrop')) closeModelsModal(); });

// ─── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(text, kind = '') {
  if (kind !== 'error') return; // only errors pop up
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ─── Sending / running ──────────────────────────────────────────────────────
let runningToolRow = null;

const COMPOSER_HINT = 'Ask Codeply anything, or type / for commands';
const COMPOSER_BUSY_HINT = 'Enter to queue a message, it sends when this finishes';

/** Stop: the chat looks stopped right away, without waiting for the engine. */
function stopRunNow(sessionId) {
  if (!api || !sessionId) return;
  api.stop(sessionId);
  if (stoppedRuns.has(sessionId)) return;
  stoppedRuns.add(sessionId);
  // If the engine never confirms, stop dropping this chat's events after a while.
  setTimeout(() => { if (stoppedRuns.delete(sessionId) && sessionId === state.currentSessionId && !state.running) setRunning(false); }, 15000);
  if (sessionId !== state.currentSessionId) return;
  hideThinking();
  if (runningToolRow) { runningToolRow.remove(); runningToolRow = null; }
  closeActivity();
  addNote('Stopped.', 'stopped');
  setRunning(false);
}

function setRunning(on) {
  state.running = on;
  document.querySelectorAll('[data-role="send"]').forEach((btn) => {
    btn.querySelector('.ic-send').classList.toggle('hidden', on);
    btn.querySelector('.ic-stop').classList.toggle('hidden', !on);
    btn.title = on ? 'Stop' : 'Send';
  });
  document.querySelectorAll('.chat-composer .composer-input').forEach((el) => { el.placeholder = on ? COMPOSER_BUSY_HINT : COMPOSER_HINT; });
  // A message queued during the run goes out once this chat is free again
  // (after Stop, once the engine says the stopped run has really ended).
  if (!on && !stoppedRuns.has(state.currentSessionId)) {
    document.querySelectorAll('.composer').forEach((c) => {
      const q = c.queued;
      if (!q || q.sessionId !== state.currentSessionId) return;
      c.queued = null;
      if (c.renderQueued) c.renderQueued();
      setTimeout(() => { if (!state.running) sendMessage(q.text, false, q.images); }, 250);
    });
  }
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
  if (activityEl && activityEl.isConnected) { activityEl.classList.add('running'); updateActivitySummary(activityEl); return; }
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
// vanishes the instant something real arrives - useful while waiting, useless
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
  hideThinking();
  activityBody().appendChild(row);
  updateActivitySummary(activityEl);
  if (nearBottom()) scrollToBottom();
}

// Narration the agent writes while it works ("I'll read the file first...")
// folds into a collapsed "Thinking" row between the tool rows; only the final
// answer is shown as a normal message.
function addThinkingRow(text) {
  const row = document.createElement('div');
  row.className = 'reasoning-row thinking-step expandable';
  row.innerHTML =
    '<div class="reasoning-row-head">' +
    '<svg viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/></svg>' +
    '<span class="reasoning-label"></span>' +
    '<svg class="tool-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' +
    '</div>';
  // The row reads as what the agent said it was doing (its first line), like
  // the steps around it; the whole note opens below.
  const gist = String(text || '').replace(/[`*_#>\[\]]/g, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  row.querySelector('.reasoning-label').textContent = gist || 'Thinking';
  row.querySelector('.reasoning-label').title = gist;
  const detail = document.createElement('div');
  detail.className = 'reasoning-detail thinking-detail hidden';
  detail.innerHTML = mdToHtml(text);
  row.appendChild(detail);
  row.querySelector('.reasoning-row-head').addEventListener('click', () => {
    detail.classList.toggle('hidden');
    row.classList.toggle('expanded');
  });
  row.classList.add('reveal-pending');
  activityBody().appendChild(row);
  updateActivitySummary(activityEl);
  enqueueReveal((next) => {
    row.classList.remove('reveal-pending');
    if (nearBottom()) scrollToBottom();
    next();
  });
}

// newProjectName() lives in new-project-name.js (the Alt+C drop uses it too).

async function sendMessage(text, fromHome, images) {
  if (!api) return;
  if (!state.user) { showView('viewLogin'); return; }
  if (!state.project) {
    const name = api.newProject ? newProjectName(text) : null;
    if (name) {
      const r = await api.newProject(name);
      if (r && r.path) { setProject(r.path, r.branch); if (!state.projects.includes(r.path)) state.projects.unshift(r.path); renderProjects(); }
    }
    if (!state.project) { await chooseProject(); if (!state.project) return; }
  }

  if (fromHome || !state.currentSessionId) {
    hideThinking();
    stopRevealQueue();
    chatColumn.innerHTML = '';
    resetSidePanel(state.project);
    state.currentSessionId = null;
    const sh = window.CodeplyAttach ? window.CodeplyAttach.split(text) : { text, files: [] };
    const titleText = sh.text || (sh.files[0] ? sh.files[0].name : text);
    $('chatTitle').textContent = titleText.length > 46 ? titleText.slice(0, 46) + '…' : titleText;
    showView('viewChat');
  }

  addUserMessage(text, images);
  if (window.CraftCloud && window.CraftCloud.beforeSend) window.CraftCloud.beforeSend(); // pull check, never blocks

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
    botId: window.CraftBots ? window.CraftBots.selectedId() : undefined, // who answers (bots-ui.js)
  });

  if (r.error) {
    setRunning(false);
    hideThinking();
    addNote(r.error, 'error');
    return;
  }
  if (!state.currentSessionId) {
    state.currentSessionId = r.sessionId;
    navRecord('s:' + r.sessionId);
    state.sessions.unshift({ id: r.sessionId, title: r.title, cwd: state.project, updatedAt: Date.now() });
    renderRecents();
  }
}

// Downscales/re-encodes a pasted image before it ever leaves the renderer -
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
  composer.pendingFiles = []; // read files (attachments.js), or { name, reading: true } while a PDF is read

  // The browser's point-at tool drops a picture of the picked item in here.
  composer.addImage = (src) => { composer.pendingImages.push(src); renderImagePreviews(); };
  function renderImagePreviews() {
    previewsEl.innerHTML = '';
    previewsEl.classList.toggle('hidden', composer.pendingImages.length === 0 && composer.pendingFiles.length === 0);
    composer.pendingFiles.forEach((f, i) => {
      const box = document.createElement('div');
      box.innerHTML = window.CodeplyAttach.chipHtml(f.reading ? { name: f.name, kind: 'text', type: f.isPdf ? 'pdf' : 'text', reading: true } : f, { removable: !f.reading });
      const chip = box.firstElementChild;
      if (f.reading) { chip.classList.add('reading'); chip.querySelector('.att-meta').textContent = 'Reading…'; }
      const x = chip.querySelector('.att-x');
      if (x) x.addEventListener('click', () => { composer.pendingFiles.splice(i, 1); renderImagePreviews(); });
      previewsEl.appendChild(chip);
    });
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

  // Files from the paperclip, a paste or a drop: images as before, PDFs and text files read here.
  async function addFiles(list) {
    for (const file of list) {
      const kind = window.CodeplyAttach ? window.CodeplyAttach.kindOf(file) : (file.type.startsWith('image/') ? 'image' : null);
      if (kind === 'image') {
        try { composer.pendingImages.push(await downscaleImageBlob(file)); } catch {}
        renderImagePreviews();
        continue;
      }
      if (!window.CodeplyAttach) continue;
      const slot = { name: file.name, reading: true, isPdf: kind === 'pdf' };
      composer.pendingFiles.push(slot);
      renderImagePreviews();
      const got = await window.CodeplyAttach.read(file, { pdfBase: 'vendor/pdfjs/' });
      const at = composer.pendingFiles.indexOf(slot);
      if (got.error) { if (at >= 0) composer.pendingFiles.splice(at, 1); showToast(got.error, 'error'); }
      else if (at >= 0) composer.pendingFiles[at] = got;
      renderImagePreviews();
    }
  }
  const attachInput = composer.querySelector('[data-role="attach-input"]');
  if (attachInput && window.CodeplyAttach) attachInput.accept = 'image/*,' + window.CodeplyAttach.ACCEPT;
  const attachBtn = composer.querySelector('[data-role="attach"]');
  if (attachBtn && attachInput) {
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => { const list = [...attachInput.files]; attachInput.value = ''; addFiles(list); input.focus(); });
  }
  // The chat box is one slim row: + and send inside it, the mode and model
  // controls in a quiet row under it.
  if (!fromHome && attachBtn) {
    composer.classList.add('composer-slim');
    attachBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    composer.insertBefore(attachBtn, input);
    input.after(sendBtn);
  }
  composer.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); composer.classList.add('drop-on'); } });
  composer.addEventListener('dragleave', (e) => { if (!composer.contains(e.relatedTarget)) composer.classList.remove('drop-on'); });
  composer.addEventListener('drop', (e) => {
    composer.classList.remove('drop-on');
    const list = [...(e.dataTransfer?.files || [])];
    if (!list.length) return;
    e.preventDefault();
    addFiles(list);
  });

  input.addEventListener('paste', async (e) => {
    const list = [...(e.clipboardData?.files || [])];
    if (!list.length) return; // no file on the clipboard - let normal text paste happen
    e.preventDefault();
    addFiles(list);
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  });

  // A message typed while a run is going waits above the box and goes out
  // when the run ends (setRunning). The x puts it back in the box.
  const queuedEl = document.createElement('div');
  queuedEl.className = 'composer-queued hidden';
  composer.insertBefore(queuedEl, previewsEl);
  composer.queued = null;
  composer.renderQueued = () => {
    const q = composer.queued;
    queuedEl.classList.toggle('hidden', !q);
    if (!q) { queuedEl.innerHTML = ''; return; }
    const shown = window.CodeplyAttach ? window.CodeplyAttach.split(q.text).text || q.text : q.text;
    queuedEl.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span class="cq-label">Queued</span><span class="cq-text"></span><button type="button" class="cq-now" title="Stop the current run and send this now">Send now</button><button type="button" class="cq-x" title="Take it back" aria-label="Take the queued message back"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    queuedEl.querySelector('.cq-text').textContent = shown;
    // Send now: stop this run; the queued message goes out as soon as it has ended.
    queuedEl.querySelector('.cq-now').addEventListener('click', () => {
      const queued = composer.queued;
      if (!queued) return;
      if (state.running && queued.sessionId === state.currentSessionId) { stopRunNow(queued.sessionId); return; }
      composer.queued = null;
      composer.renderQueued();
      if (!state.running) sendMessage(queued.text, false, queued.images);
    });
    queuedEl.querySelector('.cq-x').addEventListener('click', () => {
      const back = composer.queued;
      composer.queued = null;
      composer.renderQueued();
      if (back && !input.value.trim()) { input.value = back.text; input.dispatchEvent(new Event('input')); }
      input.focus();
    });
  };

  // A second layer on top of the addUserMessage dedupe above: blocks a
  // same-composer double-dispatch (key-repeat, a fast double-click before the
  // button visually updates) synchronously, at the moment of the click itself
  // - before state.running has had any chance to propagate - rather than
  // relying solely on catching the resulting duplicate after the fact.
  let dispatching = false;
  const submit = (viaButton) => {
    if (dispatching) return;
    // While a run goes, the button stops it; Enter queues what was typed.
    if (state.running && (viaButton === true || fromHome)) { stopRunNow(state.currentSessionId); return; }
    if (state.running) {
      const typed = input.value.trim();
      if (!typed || composer.pendingFiles.some((f) => f.reading)) return;
      const prev = composer.queued;
      const text = window.CodeplyAttach ? window.CodeplyAttach.compose(typed, composer.pendingFiles) : typed;
      composer.queued = { text: prev && prev.sessionId === state.currentSessionId ? `${prev.text}

${text}` : text, images: composer.pendingImages.length ? composer.pendingImages : (prev && prev.images), sessionId: state.currentSessionId };
      input.value = '';
      input.style.height = 'auto';
      composer.pendingImages = [];
      composer.pendingFiles = [];
      renderImagePreviews();
      composer.renderQueued();
      return;
    }
    const typed = input.value.trim();
    const images = composer.pendingImages;
    if (composer.pendingFiles.some((f) => f.reading)) { showToast('Still reading a file. One moment.'); return; }
    const files = composer.pendingFiles;
    if (!typed && !images.length && !files.length) return;
    const text = window.CodeplyAttach ? window.CodeplyAttach.compose(typed, files) : typed;
    dispatching = true;
    setTimeout(() => { dispatching = false; }, 0);
    input.value = '';
    input.style.height = 'auto';
    composer.pendingImages = [];
    composer.pendingFiles = [];
    renderImagePreviews();
    sendMessage(text || 'Image attached.', fromHome, images.length ? images : undefined);
  };

  sendBtn.addEventListener('click', () => submit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // The slash-command menu (wired up further below, same input) owns
      // Enter while it's open - picking a command, not sending "/" as text.
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
// The card sits under the run's step group without closing it, so the steps
// after it join the same group, as they do when the chat is reopened.
function addApprovalCard(ev) {
  if (ev.draft) return addEmailApprovalCard(ev);
  const card = document.createElement('div');
  card.className = 'approval-card' + (ev.danger ? ' danger' : '');
  card.dataset.requestId = ev.requestId;
  let diffHtml = '';
  if (ev.diff) {
    diffHtml = `<div class="approval-diff"><pre class="diff-del">${esc(ev.diff.search)}</pre><pre class="diff-add">${esc(ev.diff.replace)}</pre></div>`;
  }
  // Shell commands are allowed by name ("npm test", "git checkout"), never
  // wholesale. No names (a subshell, a redirect, a risky command) = no offer.
  const scope = Array.isArray(ev.alwaysScope) ? ev.alwaysScope : null;
  const alwaysWhat = scope ? scope.map((p) => `"${p}"`).join(' and ') : toolName(ev.tool);
  const alwaysLabel = scope && !scope.length ? '' : scope
    ? `Always allow ${alwaysWhat} commands in this chat`
    : `Always allow ${toolName(ev.tool)} in this chat`;
  card.innerHTML = `
    <div class="approval-head">
      <svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5Z"/></svg>
      <span class="approval-title">${esc(ev.title)}</span>
      ${ev.danger ? '<span class="approval-danger">outside project / risky</span>' : ''}
    </div>
    ${ev.detail ? `<div class="approval-detail">${esc(ev.detail)}</div>` : ''}
    ${diffHtml}
    <div class="approval-actions">
      <button class="btn btn-primary btn-sm appr-btn" data-v="once">Accept</button>
      ${alwaysLabel ? `<button class="btn btn-secondary btn-sm appr-btn" data-v="always">${esc(alwaysLabel)}</button>` : ''}
      <button class="btn btn-ghost btn-sm btn-danger-hover appr-btn" data-v="reject">Reject</button>
    </div>`;
  card.querySelectorAll('.appr-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      api.respondApproval(ev.requestId, btn.dataset.v);
      const verdictText = btn.dataset.v === 'reject' ? 'Rejected' : btn.dataset.v === 'always' ? `Accepted, always allowing ${alwaysWhat} for the rest of this chat` : 'Accepted';
      card.outerHTML = `<div class="chat-note ${btn.dataset.v === 'reject' ? 'error' : 'ok'}">${esc(ev.title)}: ${verdictText}</div>`;
    })
  );
  chatColumn.appendChild(card);
  scrollToBottom();
}

// An email the agent wants to send or save as a draft: To, Subject and Body
// are editable right on the card, and what the user leaves there is what
// goes out (the edits ride back with the verdict).
function addEmailApprovalCard(ev) {
  const d = ev.draft || {};
  const draftOnly = !!ev.draftOnly;
  const card = document.createElement('div');
  card.className = 'approval-card email-approval';
  card.dataset.requestId = ev.requestId;
  card.innerHTML = `
    <div class="approval-head">
      <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
      <span class="approval-title">${esc(ev.title)}</span>
    </div>
    <label class="email-field"><span>To</span><input data-f="to" type="text" spellcheck="false"></label>
    <label class="email-field"><span>Subject</span><input data-f="subject" type="text"></label>
    <textarea class="email-body" data-f="body" rows="6"></textarea>
    <div class="approval-actions">
      <button class="btn btn-primary btn-sm appr-btn" data-v="once">${draftOnly ? 'Save draft' : 'Send'}</button>
      ${draftOnly ? '' : '<button class="btn btn-secondary btn-sm appr-btn" data-v="draft">Save as draft</button>'}
      <button class="btn btn-ghost btn-sm btn-danger-hover appr-btn" data-v="reject">Don't send</button>
    </div>`;
  // Set as properties, never parsed as markup.
  card.querySelector('[data-f="to"]').value = String(d.to || '');
  card.querySelector('[data-f="subject"]').value = String(d.subject || '');
  card.querySelector('[data-f="body"]').value = String(d.body || '');
  const body = card.querySelector('.email-body');
  const grow = () => { body.style.height = 'auto'; body.style.height = `${Math.min(body.scrollHeight + 2, 360)}px`; };
  body.addEventListener('input', grow);
  card.querySelectorAll('.appr-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      const v = btn.dataset.v;
      const edits = {};
      card.querySelectorAll('[data-f]').forEach((f) => { edits[f.dataset.f] = f.value; });
      api.respondApproval(ev.requestId, v === 'reject' ? 'reject' : { verdict: v, edits });
      const text = v === 'reject' ? 'Not sent' : v === 'draft' || draftOnly ? 'Saving as a draft' : `Sending to ${edits.to || 'nobody'}`;
      card.outerHTML = `<div class="chat-note ${v === 'reject' ? 'error' : 'ok'}">${esc(edits.subject || ev.title)}: ${esc(text)}</div>`;
    })
  );
  chatColumn.appendChild(card);
  requestAnimationFrame(grow);
  scrollToBottom();
}

// ─── Questions from the agent (ask_user) ───────────────────────────────────
// One tap on an option, or a typed answer. Answered from the phone, the card
// here flips to the answer too (question_resolved).
function renderQuestionCard(q, existing) {
  if (!existing) closeActivity();
  const card = existing || document.createElement('div');
  card.className = 'question-card';
  card.dataset.requestId = q.requestId;
  card.dataset.q = JSON.stringify({ requestId: q.requestId, question: q.question, options: q.options || [] });
  const answered = q.answered || q.answer !== undefined;
  if (answered) {
    card.innerHTML = `
      <div class="q-head"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/></svg><span class="q-text"></span></div>
      <div class="q-answer">${q.answer == null ? '<em>Dismissed, the agent decided on its own</em>' : `Answered: <b>${esc(q.answer)}</b>`}</div>`;
    card.querySelector('.q-text').textContent = q.question;
    if (!existing) chatColumn.appendChild(card);
    return;
  }
  card.innerHTML = `
    <div class="q-head"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/></svg><span class="q-text"></span></div>
    <div class="q-options">${(q.options || []).map((o, i) => `<button class="btn btn-secondary btn-sm q-opt${i === 0 ? ' first' : ''}" type="button" data-i="${i}">${esc(o)}</button>`).join('')}</div>
    <form class="q-custom"><input class="input input-sm" type="text" placeholder="${(q.options || []).length ? 'Or type your own answer' : 'Type your answer'}" maxlength="2000"><button class="btn btn-secondary btn-sm" type="submit">Send</button></form>
    <button class="btn btn-ghost btn-sm q-skip" type="button">Let the agent decide</button>`;
  card.querySelector('.q-text').textContent = q.question;
  const send = (answer) => {
    if (!api) return;
    api.respondQuestion(q.requestId, answer);
    renderQuestionCard({ ...q, answer, answered: true }, card);
  };
  card.querySelectorAll('.q-opt').forEach((b) => b.addEventListener('click', () => send(q.options[Number(b.dataset.i)])));
  card.querySelector('.q-custom').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.currentTarget.querySelector('input').value.trim();
    if (v) send(v);
  });
  card.querySelector('.q-skip').addEventListener('click', () => send(null));
  if (q.connect && window.CraftPublish) window.CraftPublish.decorateQuestion(card, q, send); // publish: one-click connect
  if (!existing) chatColumn.appendChild(card);
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
  card.dataset.requestId = ev.requestId;
  card.innerHTML = `
    <div class="approval-head">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 15l5-4 4 3 4-4 5 5"/></svg>
      <span class="approval-title">Choose an image</span>
      ${ev.danger ? '<span class="approval-danger">outside project / risky</span>' : ''}
    </div>
    <div class="approval-detail">for ${esc(ev.path || 'this file')}</div>
    <div class="img-search-row">
      <input class="input img-search-input" type="text" value="${esc(ev.keywords || '')}" placeholder="Search photos…">
      <button class="btn btn-secondary btn-lg img-search-btn">Search</button>
    </div>
    <div class="img-grid"><div class="img-grid-status">Searching…</div></div>
    <div class="approval-actions">
      <button class="btn btn-secondary btn-sm appr-btn" data-v="skip">Skip, use Codeply's pick</button>
      <button class="btn btn-ghost btn-sm btn-danger-hover appr-btn" data-v="cancel">Cancel, no image</button>
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

let pendingAutoApproval = null; // set by approval_auto, consumed by the next tool row

// ─── Agent event stream ─────────────────────────────────────────────────────
// "Open in Craft" from the Alt+C drop.
if (api && api.onOpenSessionFromDrop) api.onOpenSessionFromDrop((id) => { if (state.user) openSession(id); });

if (api) api.onAgentEvent((data) => {
  if (stoppedRuns.has(data.sessionId) && data.type !== 'session_sync') {
    if (data.type !== 'run_finished') return;
    stoppedRuns.delete(data.sessionId);
    if (data.sessionId === state.currentSessionId) setRunning(false);
    renderRecents();
    return;
  }
  const mine = data.sessionId === state.currentSessionId;
  const meta = state.sessions.find((s) => s.id === data.sessionId);
  if (meta) meta.updatedAt = Date.now();

  // Fired for every send, from this window or a paired phone - previously
  // only reached mobile clients over SSE, so a message sent from the phone
  // never showed up here until you reopened the chat. This window's own
  // sends already render optimistically (see sendMessage above), so only
  // react when the message came from elsewhere.
  if (data.type === 'session_sync') {
    // A chat this window hasn't seen yet (e.g. started from the phone): add it.
    if (!meta && data.session && data.session.id) {
      state.sessions.unshift({ ...data.session });
      if (data.origin && data.origin !== desktopClientId) sb.unread.add(data.session.id);
      renderRecents();
    }
    // A brand-new chat's first events (role badge, goal card) arrive before
    // api.send() returns its id; adopt it here so they aren't dropped.
    if (!state.currentSessionId && data.origin === desktopClientId && data.message?.kind === 'user') {
      state.currentSessionId = data.sessionId;
      navRecord('s:' + data.sessionId);
    }
    if (mine && data.message?.kind === 'user' && data.origin && data.origin !== desktopClientId) {
      addUserMessage(data.message.text, data.message.images);
    }
    // Covers the AI-generated retitle that lands shortly after a brand-new
    // chat's first reply, and a rename/delete made from a paired phone -
    // neither originates in this window, so the sidebar needs to be told.
    if (meta && data.session?.title && data.session.title !== meta.title) {
      meta.title = data.session.title;
      renderRecents();
      if (mine) $('chatTitle').textContent = meta.title;
    }
    return;
  }

  // A delete made from a paired phone - mirrors deleteSessionById() below,
  // minus the api.deleteSession() call (already done on the other end).
  // The chat was rewound for an edit or retry somewhere else (this window
  // already redrew its own): reload it so dropped messages disappear.
  if (data.type === 'session_rewound') {
    if (mine && data.origin !== desktopClientId) openSession(data.sessionId);
    return;
  }

  if (data.type === 'session_deleted') {
    state.sessions = state.sessions.filter((s) => s.id !== data.sessionId);
    if (state.currentSessionId === data.sessionId) {
      state.currentSessionId = null;
      showView('viewHome');
    }
    renderRecents();
    return;
  }

  if (!mine) return;

  switch (data.type) {
    case 'role_active':
      addRoleBadge(data);
      break;
    case 'turn_summary':
      addTurnSummary(data);
      break;
    case 'mode_switch':
      state.mode = data.mode;
      syncMode();
      addNote(data.mode === 'Build' ? 'Switched to Build mode. Implementing the plan.' : `Switched to ${data.mode} mode.`, '');
      break;
    case 'checkpoint':
    case 'checkpoint_update':
      renderCheckpoint(data.checkpoint);
      break;
    case 'goal_update':
      renderGoalCard(data);
      break;
    case 'cloud_task':
      if (window.CraftCloud) window.CraftCloud.render(data.task);
      break;
    case 'handoff':
      if (window.CraftHandoff) window.CraftHandoff.render(data);
      break;
    case 'notice':
      addNote(data.text, data.level === 'warn' ? 'warn' : data.level === 'error' ? 'error' : data.level === 'limit' ? 'limit' : '');
      break;
    case 'verifying':
      // The check itself shows up as its own row; just keep the spinner going.
      showThinking();
      break;
    case 'verification_start':
      addNote('All tasks attempted - now verifying each one against the real project.', 'verify');
      break;
    case 'helper_note':
      // A helper call finishing before the writer's own turn starts -
      // "◈ Codeply Design planned the design" - shown the same way a tool row
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
      if (data.interim) addThinkingRow(data.text);
      else addAssistantMessage(data.text);
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
      addToolRow({ name: data.name, label: data.summary || toolArgsLabel(data.args), ok: data.ok, args: data.args, screenshotSrc: data.meta?.screenshotDataUrl, auto: !!pendingAutoApproval, bypass: pendingAutoApproval?.bypass, delegation: data.meta?.delegation, error: data.error, output: data.meta?.output, exitCode: data.meta?.exitCode, background: data.meta?.background, jobId: data.meta?.jobId });
      if (data.meta?.publish && window.CraftPublish) window.CraftPublish.render(data.meta.publish);
      pendingAutoApproval = null;
      updateActivitySummary(activityEl);
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
    case 'question_request':
      hideThinking();
      renderQuestionCard(data);
      break;
    case 'question_resolved': {
      const card = chatColumn.querySelector(`.question-card[data-request-id="${data.requestId}"]`);
      if (card) renderQuestionCard({ ...JSON.parse(card.dataset.q || '{}'), answer: data.answer, answered: true }, card);
      break;
    }
    case 'approval_resolved': {
      // The request was answered from another device (e.g. the phone) -
      // this window's own click handler already retires its own card
      // locally, so this only ever fires for a card THIS window didn't
      // answer, which otherwise had nothing to ever remove it.
      const card = chatColumn.querySelector(`.approval-card[data-request-id="${data.requestId}"]`);
      if (card) {
        const verdictText = data.verdict === 'reject' ? 'Rejected' : data.verdict === 'always' ? 'Accepted, always allowed' : data.verdict === 'draft' ? 'Saved as a draft' : 'Accepted';
        card.outerHTML = `<div class="chat-note ${data.verdict === 'reject' ? 'error' : 'ok'}">${verdictText} on another device</div>`;
      }
      break;
    }
    case 'approval_auto':
      // No separate line: the tool row that follows gets a small tag instead.
      pendingAutoApproval = { bypass: !!data.bypass };
      break;
    case 'image_pick_resolved': {
      // Same reasoning as approval_resolved above, for the picker card
      // specifically - picked from the phone while this window still has
      // it open.
      const card = chatColumn.querySelector(`.image-picker-card[data-request-id="${data.requestId}"]`);
      if (card) card.outerHTML = '<div class="chat-note ok">Picked an image on another device</div>';
      break;
    }
    case 'error':
      hideThinking();
      if (data.limited) addLimitCard(data.error);
      else if (isQuietNotice(data.error)) { /* bookkeeping, not news: the step group carries on */ }
      else addNote(data.error, 'error');
      break;
    case 'aborted':
      hideThinking();
      closeActivity();
      addNote('Stopped.', 'stopped');
      break;
    case 'run_finished':
      hideThinking();
      if (runningToolRow) { runningToolRow.remove(); runningToolRow = null; }
      closeActivity();
      activeTaskList = null;
      setRunning(false);
      renderRecents();
      updateReplyActions();
      break;
  }
});

// ─── Open an existing session ───────────────────────────────────────────────
async function openSession(id) {
  if (!state.user) { showView('viewLogin'); return; }
  const s = await api.getSession(id);
  if (!s) return;
  state.currentSessionId = id;
  navRecord('s:' + id);
  sbMarkUnread(id, false);
  if (window.CraftHandoff) window.CraftHandoff.show(id);
  if (s.cwd) {
    const r = await api.useProject(s.cwd);
    if (r) setProject(r.path, r.branch);
  }
  $('chatTitle').textContent = s.title;
  hideThinking();
  stopRevealQueue();
  chatColumn.innerHTML = '';
  activityEl = null;
  activityRole = null;
  resetSidePanel(s.cwd);
  currentTasks = [];
  activeGoalCard = null;
  revealInstant = true;
  for (const m of s.messages) {
    if (m.kind === 'user') addUserMessage(m.text, m.images);
    else if (m.kind === 'assistant') (m.interim ? addThinkingRow(m.text) : addAssistantMessage(m.text));
    else if (m.kind === 'reasoning') addReasoningRow(m.text, m.ms);
    else if (m.kind === 'tool') {
      // Desktop can load a local file:// path directly, no server round trip.
      const screenshotSrc = m.screenshotPath ? 'file:///' + m.screenshotPath.replace(/\\/g, '/') : undefined;
      addToolRow({ name: m.name, label: m.label, ok: m.ok, args: m.args, screenshotSrc, delegation: m.delegation, output: m.output, exitCode: m.exitCode, background: m.background });
      panelTrack(m.name, m.label);
    } else if (m.kind === 'tasklist') {
      addTaskList(m.tasks);
    } else if (m.kind === 'role_active' || m.kind === 'subagent_active') {
      addRoleBadge(m);
    } else if (m.kind === 'turn_summary') {
      addTurnSummary(m);
    } else if (m.kind === 'checkpoint') {
      renderCheckpoint(m);
    } else if (m.kind === 'question') {
      renderQuestionCard({ ...m, answered: true });
    } else if (m.kind === 'publish' && window.CraftPublish) {
      window.CraftPublish.render(m);
    } else if (m.kind === 'notice') {
      if (m.level === 'limited') addLimitCard(m.text);
      else addNote(m.text, m.level === 'warn' ? 'warn' : m.level === 'error' ? 'error' : m.level === 'limit' ? 'limit' : '');
    } else if (m.kind === 'goal') {
      renderGoalCard(m);
    } else if (m.kind === 'cloud_task' && window.CraftCloud) {
      window.CraftCloud.render(m.task);
    } else if (m.kind === 'bot_active' && window.CraftBots) {
      window.CraftBots.renderBadge(m.bot, true);
    }
  }
  closeActivity();
  revealInstant = false;
  activeTaskList = null; // reopening a past chat is read-only history, not a live run - no further task_start/task_end will arrive for it
  refreshTasksUI();
  renderRecents();
  showView('viewChat');
  scrollToBottom();

  // Re-sync the send/stop icon to what THIS session is actually doing right
  // now. state.running otherwise stays stuck at whatever the previously-open
  // chat was doing - its own run_finished/error event is ignored while you're
  // not looking at it (see the `if (!mine) return` in the event handler
  // below), so navigating away from a still-running chat and back to it, or
  // over to an idle one, used to leave the composer showing Stop forever.
  // runs:status (state.runningSessions) is a live backend snapshot, so it's
  // always right even when a run_finished event got missed.
  setRunning(state.runningSessions.includes(id));
  updateReplyActions();
}

$('deleteChatBtn').addEventListener('click', () => {
  const s = state.sessions.find((x) => x.id === state.currentSessionId);
  if (s) confirmDeleteSession(s);
});

$('newChatBtn').addEventListener('click', () => {
  state.currentSessionId = null;
  renderSidebar(); // no chat is open now
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
// first, then an emailed code finishes it - same Supabase project,
// same account, so a login here is a login everywhere.
state.pendingMode = 'login'; // 'login' | 'signup' - which OTP verification type to use

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

async function afterVerified(email, onboarding) {
  state.user = { email };
  renderUser();
  // Chat history is per-account in Supabase, not this device - pull this
  // account's own history now rather than leaving whatever a previous
  // account's session left in state (app:init only runs once at boot).
  state.sessions = await api.refreshSessions();
  renderRecents();
  if (onboarding && !onboarding.referral_source) return showReferralPage();
  if (onboarding && !onboarding.country) return showCountryPage();
  showView('viewHome');
}

// Google sign-in: opens the system browser, then the OS hands the resulting
// codeply:// deep link back to main.js, which pushes the outcome here -
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
  $('otpSentTo').textContent = `We emailed a sign-in code to ${email}.`;
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
  const code = $('otpCode').value.replace(/\D+/g, '');
  if (code.length < 6) return showLoginError('Enter the full code from your email.');
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

// Sign out itself now lives in the account menu (see openAccountMenu above) -
// this button used to carry it directly; the menu's logout item replaced it.

function renderUser() {
  const name = state.user ? state.user.email : 'Not signed in';
  $('userName').textContent = name;
  $('userName').title = name;
  $('userAvatar').textContent = state.user ? state.user.email.slice(0, 2).toUpperCase() : '·';
}

// ─── Onboarding survey: referral source + country ───────────────────────────
// Same `profiles` row and same gating (checked per-account, not just locally)
// as the desktop app - a second account on this machine still gets asked.
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
  else showView('viewHome');
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
  showView('viewHome');
});

// ─── Skills browser (/skills) ────────────────────────────────────────────────
let allSkills = [];
let skillsTargetInput = null; // which composer input to insert the pick into

async function openSkillsModal(inputEl) {
  skillsTargetInput = inputEl;
  CraftModal.open('skillsBackdrop', { onClose: closeSkillsModal });
  $('skillsSearch').value = '';
  $('skillsSearch').focus();
  if (!allSkills.length) allSkills = await api.listSkills();
  renderSkillsList(allSkills);
}
function closeSkillsModal() {
  CraftModal.close('skillsBackdrop');
}

// ─── Codeply Away (phone) ────────────────────────────────────────────────────────
// The phone signs in with the same account and finds this PC on its own -
// this panel just explains that and shows whether it's ready.
function setRemoteStatus(text, kind) {
  const el = $('remoteStatus');
  el.textContent = text || '';
  el.dataset.kind = kind || '';
  el.classList.toggle('hidden', !text);
}

async function openRemoteModal() {
  CraftModal.open('remoteBackdrop', { onClose: closeRemoteModal });
  $('remoteUrl').textContent = '…';
  setRemoteStatus('Checking…', '');
  const info = await api.remoteInfo();
  $('remoteUrl').textContent = info.mobileUrl.replace(/^https?:\/\//, '');
  $('remoteUrl').dataset.href = info.mobileUrl;
  $('remoteEmail').textContent = info.email || 'your account';
  $('keepAwakeToggle').checked = !!info.keepAwake;
  if (!info.signedIn) setRemoteStatus('Sign in on this PC first. Your phone connects to the account signed in here.', 'warn');
  else if (info.relay) setRemoteStatus('Online. Your phone can reach this PC from anywhere.', 'ok');
  else setRemoteStatus('Connecting to Codeply… (needs an internet connection)', '');
  // The relay can take a moment to come up the first time.
  if (info.signedIn && !info.relay) setTimeout(() => { if (CraftModal.isOpen('remoteBackdrop')) openRemoteModal(); }, 2500);
}
$('remoteUrl').addEventListener('click', (e) => {
  e.preventDefault();
  if ($('remoteUrl').dataset.href) api.openExternal($('remoteUrl').dataset.href);
});
$('keepAwakeToggle').addEventListener('change', (e) => api.setKeepAwake(e.target.checked));
function closeRemoteModal() { CraftModal.close('remoteBackdrop'); }
api.onRemoteServerError((data) => {
  if (!$('remoteBackdrop').classList.contains('hidden')) {
    setRemoteStatus(data.message || 'The phone connection failed to start.', 'error');
  }
});
// Codeply Away lives in the File menu now (the sidebar row was removed).
if ($('remoteControlBtn')) $('remoteControlBtn').addEventListener('click', openRemoteModal);
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

// ─── Plugins (/plugins) ──────────────────────────────────────────────────────
let pluginPending = null; // { token, summary, update }

function pluginError(msg) {
  $('pluginError').textContent = msg || '';
  $('pluginError').classList.toggle('hidden', !msg);
}

function pluginSummaryHtml(s) {
  const adds = [];
  if (s.commands) adds.push(`${s.commands} command${s.commands === 1 ? '' : 's'} (/${esc(s.name)}:...)`);
  if (s.skills) adds.push(`${s.skills} skill${s.skills === 1 ? '' : 's'}`);
  if (s.instructions) adds.push('rules for the agent');
  if (s.mcpServers.length) adds.push(`${s.mcpServers.length === 1 ? 'MCP server' : 'MCP servers'} ${s.mcpServers.map((m) => esc(m.name)).join(', ')}`);
  const mcp = s.mcpServers.length
    ? `<div class="plugin-warn">Starts programs on this computer (MCP servers):${s.mcpServers.map((m) => `<code>${esc(m.name)}: ${esc(m.runs || m.url)}</code>`).join('')}</div>`
    : '';
  return `<div class="plugin-name">${esc(s.name)} <span>${esc(s.version || '')}</span></div>
    <div class="plugin-desc">${esc(s.description || '')}${s.author ? ` <span class="plugin-by">by ${esc(s.author)}</span>` : ''}</div>
    <div class="plugin-adds">Adds: ${adds.join(', ') || 'nothing'}</div>${mcp}`;
}

async function renderPlugins() {
  const body = $('pluginsBody');
  body.innerHTML = '';
  if (pluginPending) {
    const p = pluginPending;
    const card = document.createElement('div');
    card.className = 'plugin-card plugin-confirm';
    card.innerHTML = `${pluginSummaryHtml(p.summary)}
      <div class="plugin-actions">
        ${!p.update && state.project ? '<label class="plugin-scope"><input type="checkbox" id="pluginProjectOnly"> Only for this project</label>' : ''}
        <button class="btn btn-secondary btn-sm" id="pluginCancel">Cancel</button>
        <button class="btn btn-primary btn-sm" id="pluginConfirm">${p.update ? 'Update' : 'Install'} ${esc(p.summary.name)}</button>
      </div>`;
    body.appendChild(card);
    $('pluginCancel').addEventListener('click', async () => { await api.cancelPlugin(p.token); pluginPending = null; renderPlugins(); });
    $('pluginConfirm').addEventListener('click', async () => {
      const project = !!($('pluginProjectOnly') && $('pluginProjectOnly').checked);
      $('pluginConfirm').disabled = true;
      const r = await api.finishPlugin(p.token, project ? 'project' : 'user', state.project || null);
      pluginPending = null;
      pluginError(r.ok ? '' : r.error);
      if (r.ok) $('pluginSource').value = '';
      renderPlugins();
    });
    return;
  }
  const list = await api.listPlugins(state.project || null);
  if (!list.length) {
    body.innerHTML = '<div class="skills-empty">No plugins installed yet.</div>';
    return;
  }
  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'plugin-card' + (p.enabled ? '' : ' plugin-off');
    card.innerHTML = `${pluginSummaryHtml(p)}
      <div class="plugin-actions">
        <span class="plugin-scope-tag">${p.scope === 'project' ? 'This project' : 'Every project'}</span>
        <button class="btn btn-secondary btn-sm" data-a="toggle">${p.enabled ? 'Turn off' : 'Turn on'}</button>
        ${p.source && p.sourceKind !== 'local' ? '<button class="btn btn-secondary btn-sm" data-a="update">Update</button>' : ''}
        <button class="btn btn-ghost btn-sm btn-danger-hover" data-a="remove">Remove</button>
      </div>`;
    card.querySelector('[data-a="toggle"]').addEventListener('click', async () => { await api.togglePlugin(p.name, !p.enabled, state.project || null); renderPlugins(); });
    card.querySelector('[data-a="remove"]').addEventListener('click', async () => {
      if (!(await CraftModal.confirm({ title: `Remove ${p.name}?`, body: 'Its commands, skills and MCP servers stop loading. You can install it again later.', confirmLabel: 'Remove', danger: true })).ok) return;
      await api.removePlugin(p.name, state.project || null);
      renderPlugins();
    });
    const upd = card.querySelector('[data-a="update"]');
    if (upd) upd.addEventListener('click', async () => {
      upd.disabled = true; upd.textContent = 'Checking...';
      pluginError('');
      const r = await api.prepareUpdatePlugin(p.name, state.project || null);
      if (!r.ok) { pluginError(r.error); return renderPlugins(); }
      pluginPending = { token: r.token, summary: r.summary, update: true };
      renderPlugins();
    });
    body.appendChild(card);
  }
}

async function openPluginsModal() {
  pluginPending = null;
  pluginError('');
  CraftModal.open('pluginsBackdrop', { onClose: closePluginsModal });
  $('pluginSource').focus();
  renderPlugins();
}
function closePluginsModal() {
  if (pluginPending) api.cancelPlugin(pluginPending.token);
  pluginPending = null;
  CraftModal.close('pluginsBackdrop');
}
async function fetchPlugin() {
  const source = $('pluginSource').value.trim();
  if (!source) return;
  pluginError('');
  $('pluginFetchBtn').disabled = true; $('pluginFetchBtn').textContent = 'Fetching...';
  const r = await api.preparePlugin(source);
  $('pluginFetchBtn').disabled = false; $('pluginFetchBtn').textContent = 'Install';
  if (!r.ok) return pluginError(r.error);
  pluginPending = { token: r.token, summary: r.summary, update: false };
  renderPlugins();
}
$('pluginFetchBtn').addEventListener('click', fetchPlugin);
$('pluginSource').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchPlugin(); });
$('pluginsCloseBtn').addEventListener('click', closePluginsModal);
$('pluginsBackdrop').addEventListener('click', (e) => { if (e.target === $('pluginsBackdrop')) closePluginsModal(); });

// ─── Slash commands ("/" in the composer) ────────────────────────────────────
const SLASH_COMMANDS = [
  {
    name: '/goal', aliases: ['/g'], desc: 'Keep working until the goal is fully done and verified',
    run: (input) => { input.value = '/goal '; input.focus(); input.dispatchEvent(new Event('input')); },
  },
  { name: '/skills', aliases: ['/skill-list', '/skill'], desc: 'Browse and search the skill library', run: (input) => openSkillsModal(input) },
  { name: '/plugins', aliases: ['/plugin'], desc: 'Install and manage plugins (commands, skills, MCP servers)', run: () => openPluginsModal() },
];

document.querySelectorAll('.composer').forEach((composer) => {
  const input = composer.querySelector('.composer-input');
  let menu = null;
  let activeIndex = 0;

  // Read by the send/submit handler (registered earlier, on the same input)
  // so Enter doesn't both pick a slash command AND send "/" as a message.
  composer.slashMenuOpen = () => !!menu;

  // The project's own commands (.codeply/commands/*.md), fetched when "/" is
  // typed so a newly added file shows up without a restart.
  let customCommands = [];
  let customAt = 0;
  async function refreshCustom() {
    if (!api || !api.listCommands || Date.now() - customAt < 3000) return;
    customAt = Date.now();
    try {
      customCommands = (await api.listCommands(state.project || null)).map((c) => ({
        name: `/${c.name}`, aliases: [], desc: c.description + (c.mode ? ` (${c.mode})` : ''),
        run: (inp) => { inp.value = `/${c.name} `; inp.focus(); inp.dispatchEvent(new Event('input')); },
      }));
    } catch { customCommands = []; }
    if (input.value.startsWith('/')) input.dispatchEvent(new Event('input'));
  }

  function matches() {
    const v = input.value.toLowerCase();
    if (!v.startsWith('/') || /\s/.test(v)) return [];
    if (v === '/') refreshCustom();
    return [...SLASH_COMMANDS, ...customCommands].filter((c) => c.name.startsWith(v) || c.aliases.some((a) => a.startsWith(v)));
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  function openMenu(list) {
    closeMenu();
    activeIndex = 0;
    menu = document.createElement('div');
    menu.className = 'menu slash-menu';
    list.forEach((cmd, i) => {
      const item = document.createElement('button');
      item.className = 'menu-item slash-item' + (i === 0 ? ' active' : '');
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

// ─── Refresh chats ──────────────────────────────────────────────────────────
// Chats started or continued from the phone show up by themselves: the list
// refreshes when the window gets focus and every 20 seconds. The open chat is
// reloaded only when it changed elsewhere and isn't running here.
let refreshingChats = false;
async function refreshChats() {
  if (refreshingChats || !api || !state.user) return;
  refreshingChats = true;
  try {
    const before = state.sessions.find((s) => s.id === state.currentSessionId);
    const r = await api.listSessions();
    state.sessions = r.sessions;
    renderRecents();
    sbRunsChanged(r.running || []);
    const after = state.sessions.find((s) => s.id === state.currentSessionId);
    const runningHere = (state.runningSessions || []).includes(state.currentSessionId);
    if (before && after && after.updatedAt !== before.updatedAt && !runningHere) await openSession(state.currentSessionId);
  } catch {} finally { refreshingChats = false; }
}
window.addEventListener('focus', () => { refreshChats(); });
setInterval(() => { if (document.visibilityState === 'visible') refreshChats(); }, 20000);

// ─── Auto-update ────────────────────────────────────────────────────────────
// Normal updates download in the background and install on the next restart;
// a small pill says so. A required update covers the app until it's installed.
function renderUpdate(u) {
  if (!u) return;
  const pill = $('updatePill');
  const gate = $('updateGate');
  const active = ['downloading', 'ready', 'available', 'error'].includes(u.status);

  gate.classList.toggle('installing', u.status === 'installing');
  if (u.status === 'installing') {
    gate.classList.remove('hidden');
    pill.classList.add('hidden');
    $('updateGateTitle').textContent = 'Installing update';
    $('updateGateText').textContent = `Codeply is closing to install ${u.version || 'the update'}. A small installer window shows the progress, and Codeply reopens by itself when it is done, usually in 2 to 5 minutes. You do not need to open it.`;
    $('updateGateNotes').classList.add('hidden');
    $('updateGateTrack').classList.remove('hidden');
    $('updateGateTrack').classList.add('indeterminate');
    $('updateGateStatus').textContent = 'Closing and installing…';
    $('updateGateBtn').classList.add('hidden');
    return;
  }
  $('updateGateTitle').textContent = 'Update required';
  $('updateGateTrack').classList.remove('indeterminate');

  // "Update now" was clicked: a page that stays up through the download and says
  // plainly that Craft will close, install and reopen by itself.
  if (u.queued && (u.status === 'downloading' || u.status === 'ready')) {
    gate.classList.remove('hidden');
    gate.classList.add('installing');
    pill.classList.add('hidden');
    $('updateGateTitle').textContent = `Updating to ${u.version}`;
    $('updateGateText').textContent = 'Codeply downloads the update, closes, installs it and reopens by itself. It takes a few minutes. You do not need to open it again.';
    $('updateGateNotes').classList.add('hidden');
    $('updateGateTrack').classList.remove('hidden');
    $('updateGateBar').style.width = Math.max(3, u.status === 'ready' ? 100 : (u.percent || 0)) + '%';
    $('updateGateStatus').textContent = u.status === 'ready' ? 'Downloaded. Closing to install…' : `Downloading… ${u.percent || 0}%`;
    $('updateGateBtn').classList.add('hidden');
    return;
  }

  if (u.required && active) {
    gate.classList.remove('hidden');
    pill.classList.add('hidden');
    $('updateGateText').textContent = `Version ${u.version} is required to keep using Codeply. You're on ${u.current}.`;
    $('updateGateNotes').textContent = u.notes || '';
    $('updateGateNotes').classList.toggle('hidden', !u.notes);
    const showBar = u.status === 'downloading';
    $('updateGateTrack').classList.toggle('hidden', !showBar);
    $('updateGateBar').style.width = Math.max(3, u.percent || 0) + '%';
    const btn = $('updateGateBtn');
    if (u.status === 'ready') {
      $('updateGateStatus').textContent = 'Downloaded. Restart to finish updating.';
      btn.textContent = 'Restart and update';
      btn.classList.remove('hidden');
    } else if (u.status === 'available' && u.manual) {
      $('updateGateStatus').textContent = 'Download the new version, then open it to replace this one.';
      btn.textContent = 'Download update';
      btn.classList.remove('hidden');
    } else if (u.status === 'error') {
      $('updateGateStatus').textContent = u.error || 'The download failed.';
      btn.textContent = 'Try again';
      btn.classList.remove('hidden');
    } else {
      $('updateGateStatus').textContent = `Downloading… ${u.percent || 0}%`;
      btn.classList.add('hidden');
    }
    return;
  }

  gate.classList.add('hidden');
  // Optional update: shows as soon as a new version is found. "Update now"
  // installs right away, or the moment the background download finishes.
  const downloading = u.status === 'downloading' && !!u.version;
  const showPill = downloading || u.status === 'ready' || (u.status === 'available' && u.manual);
  pill.classList.toggle('hidden', !showPill);
  const waiting = !!(downloading && u.queued); // clicked "Update now" while it downloads
  pill.classList.toggle('busy', waiting);
  $('updatePillCta').classList.toggle('hidden', waiting);
  if (waiting) {
    $('updatePillText').textContent = `Updating · ${u.percent || 0}%`;
    pill.title = 'Downloading the update. Codeply restarts on the new version when it is done.';
  } else if (showPill) {
    $('updatePillText').textContent = `Version ${u.version} available`;
    $('updatePillCta').textContent = u.manual ? 'Download' : 'Update now';
    pill.title = u.manual ? 'Download the new version'
      : downloading ? `Downloading in the background (${u.percent || 0}%). Click to update as soon as it is ready.`
      : 'Restart now to update';
  }
}

let lastUpdate = null;
if (api && api.onUpdateState) {
  api.onUpdateState((u) => { lastUpdate = u; renderUpdate(u); });
  api.getUpdateState().then((u) => { lastUpdate = u; renderUpdate(u); });
}
$('updatePill').addEventListener('click', () => {
  if (!$('updatePill').classList.contains('busy')) api.installUpdate();
});
$('updateGateBtn').addEventListener('click', () => {
  if (lastUpdate && lastUpdate.status === 'error') api.retryUpdate();
  else api.installUpdate();
});

// ─── Boot ───────────────────────────────────────────────────────────────────
(async function boot() {
  if (!api){
    $('engineErrorText').textContent = 'Codeply must run inside Electron: npm install && npm start';
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
  state.sessions = init.sessions;
  state.projects = init.projects;
  renderUser();
  renderRecents();
  renderProjects();
  syncMode();
  syncBypass();
  applyModelsState(init.models);
  state.chatgpt = init.chatgpt || { signedIn: false };
  // Refresh the plan's model list in the background (models:changed repaints the picker).
  if (state.chatgpt.sharing) api.chatgptStatus({ refresh: true }).then((st) => { state.chatgpt = st; });
  if (init.lastProject) setProject(init.lastProject, init.lastProjectBranch);
  else setProject(null, null);

  if (init.needsLogin) { showView('viewLogin'); return; }
  if (init.needsOnboarding) {
    if (!init.onboarding?.referral_source) { showReferralPage(); return; }
    if (!init.onboarding?.country) { showCountryPage(); return; }
  }
  showView('viewHome');
})();

// ─── Research Mode panel (local Ollama / Ollama Cloud) ─────────────────────
// The API key is never read back in full: the saved one shows as a masked
// placeholder, and typing a new one replaces it.
(function researchModePanel() {
  if (!api || !api.researchGet || !$('rmPanel')) return;
  let rm = { enabled: false, mode: 'cloud', model: '', context: '', hasKey: false, keyPreview: '' };

  let statusOk = null;
  const RM_ICON = '<svg viewBox="0 0 24 24"><path d="M9 3h6"/><path d="M10 3.5v5.2l-5.1 8.7A2.4 2.4 0 0 0 7 21h10a2.4 2.4 0 0 0 2.1-3.6L14 8.7V3.5"/><path d="M6.9 14h10.2"/></svg>';

  // The chip lives in each composer, right after Cloud. Click turns it on or off;
  // the dots (or a right click) open the settings popover above it.
  document.querySelectorAll('.composer-bottom-left').forEach((row) => {
    const b = document.createElement('button');
    b.className = 'approve-toggle rm-chip';
    b.type = 'button';
    b.innerHTML = RM_ICON + '<span>Research</span><i class="rm-chip-dot"></i>';
    b.addEventListener('click', async () => {
      await save({ enabled: !rm.enabled });
      if (rm.enabled) {
        await refreshStatus();
        if (!statusOk) openPop(b);
      } else closePop();
    });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); openPop(b); });
    const more = document.createElement('button');
    more.className = 'cloud-chip-more rm-chip-more hidden';
    more.type = 'button';
    more.title = 'Research settings';
    more.setAttribute('aria-label', 'Research settings');
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
    more.addEventListener('click', () => ($('rmPanel').classList.contains('hidden') ? openPop(b) : closePop()));
    row.appendChild(b);
    row.appendChild(more);
  });

  function openPop(anchor) {
    const pop = $('rmPanel');
    pop.classList.remove('hidden');
    refreshStatus();
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
    pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  }
  function closePop() { $('rmPanel').classList.add('hidden'); }
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#rmPanel, .rm-chip, .rm-chip-more')) closePop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });

  function paintChips() {
    document.querySelectorAll('.rm-chip').forEach((b) => {
      b.classList.toggle('on', rm.enabled);
      b.classList.toggle('bad', rm.enabled && statusOk === false);
      b.title = !rm.enabled ? 'Research Mode: send your research context with every message, on the model you picked'
        : statusOk === false ? $('rmStatusText').textContent : 'Research Mode on: your research context goes with every message. Click to turn off.';
    });
    document.querySelectorAll('.rm-chip-more').forEach((b) => b.classList.toggle('hidden', !rm.enabled));
  }

  function setStatus(ok, text) {
    $('rmDot').className = 'rm-dot ' + (ok ? 'ok' : 'bad');
    $('rmStatusText').textContent = text;
    statusOk = ok;
    paintChips();
  }

  function paint() {
    paintChips();
    $('rmToggle').checked = rm.enabled;
    $('rmBody').classList.toggle('hidden', !rm.enabled);
    $('rmMode').value = rm.mode;
    $('rmKeyField').classList.add('hidden'); // the selected model answers; no separate key
    $('rmKey').placeholder = rm.hasKey ? rm.keyPreview : 'Not needed: Codeply runs it for you';
    if (document.activeElement !== $('rmContext')) $('rmContext').value = rm.context;
  }

  // Research Mode runs on whatever model is selected in the model menu.
  async function refreshStatus() {
    const m = typeof selectedModel === 'function' ? selectedModel() : null;
    setStatus(true, 'Using ' + (m ? m.name : 'Haze 2') + '. Change it in the model menu.');
  }

  async function save(patch) {
    const r = await api.researchSave(patch);
    if (r.ok) rm = r.settings;
    paint();
  }

  $('rmToggle').addEventListener('change', async () => {
    await save({ enabled: $('rmToggle').checked });
    if (rm.enabled) refreshStatus();
  });
  $('rmMode').addEventListener('change', async () => { await save({ mode: $('rmMode').value, model: '' }); refreshStatus(); });
  $('rmKey').addEventListener('change', async () => {
    const v = $('rmKey').value.trim();
    $('rmKey').value = '';
    if (v) { await save({ apiKey: v }); refreshStatus(); }
  });
  $('rmContext').addEventListener('change', () => save({ context: $('rmContext').value }));
  $('rmRefresh').addEventListener('click', refreshStatus);
  $('rmTest').addEventListener('click', async () => {
    const out = $('rmOut');
    out.className = 'rm-out';
    out.textContent = '';
    const r = await api.researchTest();
    if (!r.ok) { out.className = 'rm-out error'; out.textContent = r.error; }
  });
  api.onResearchToken((t) => { const out = $('rmOut'); out.classList.remove('hidden'); out.textContent += t; });

  api.researchGet().then((r) => { if (r && r.ok) { rm = r.settings; paint(); refreshStatus(); } });
})();
