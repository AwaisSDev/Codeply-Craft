// Codeply on the desktop web (codeply.app/chat): the phone app (phone.js and friends) with what a desktop
// browser adds. The layout lives in desktop.css; here:
//   - the sidebar stays open on a wide window, and collapses with its button or Ctrl+B
//   - keyboard shortcuts (Ctrl+/ lists them), typing anywhere goes to the message box
//   - files dropped on the window or pasted into the box are attached
//   - the tab title follows the open chat
//   - clicking outside a dialog (Settings, Tasks...) closes it
(function () {
  const P = window.CraftPhone;
  if (!P) return;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  root.classList.add('desk');
  const wide = () => window.matchMedia('(min-width: 900px)').matches;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = mac ? '⌘' : 'Ctrl';
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  // ─── Sidebar ──────────────────────────────────────────────────────────────
  const SIDE_ICON = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/></svg>';
  if (store.get('craft-desk-side') === 'closed') root.classList.add('side-closed');
  function setSide(open) {
    root.classList.toggle('side-closed', !open);
    store.set('craft-desk-side', open ? 'open' : 'closed');
    syncAria();
    if (open) P.renderChatList();
  }
  function syncAria() {
    if (!wide()) return;
    const want = root.classList.contains('side-closed') ? 'true' : 'false';
    // only on a change: the observer below watches this attribute, so an unchanged write would loop forever
    if ($('drawer').getAttribute('aria-hidden') !== want) $('drawer').setAttribute('aria-hidden', want);
  }
  const sideBtn = document.createElement('button');
  sideBtn.type = 'button';
  sideBtn.className = 'circle-btn desk-side-btn';
  sideBtn.setAttribute('aria-label', 'Close sidebar');
  sideBtn.title = `Close sidebar (${MOD}+B)`;
  sideBtn.innerHTML = SIDE_ICON;
  sideBtn.addEventListener('click', () => setSide(false));
  $('drawer').querySelector('.drawer-head').append(sideBtn);
  // The round menu button opens the sidebar again (on a narrow window it is the phone's drawer)
  $('menuBtn').addEventListener('click', (e) => {
    if (!wide()) return;
    e.stopImmediatePropagation();
    setSide(true);
  }, true);
  $('menuBtn').title = `Open sidebar (${MOD}+B)`;
  // phone.js closes the drawer when a chat is picked; on a wide window it stays, so keep it readable
  new MutationObserver(syncAria).observe($('drawer'), { attributes: true, attributeFilter: ['aria-hidden'] });
  window.addEventListener('resize', syncAria);
  syncAria();
  // Shortcut hints in the sidebar
  const newItem = $('drawerNewChat');
  if (newItem) newItem.insertAdjacentHTML('beforeend', `<kbd>${mac ? '⌘⇧O' : 'Ctrl+Shift+O'}</kbd>`);

  // ─── The box ──────────────────────────────────────────────────────────────
  const input = $('input');
  input.placeholder = 'Ask anything, or drop a file here';
  const focusBox = () => { if (!$('app').classList.contains('hidden')) input.focus({ preventScroll: true }); };
  setTimeout(focusBox, 300);

  // ─── Tab title: the open chat ─────────────────────────────────────────────
  let lastTitle = '';
  function syncTitle() {
    const st = P.state;
    const c = st && st.current && P.chatMeta(st.current);
    const t = c && c.title ? `${c.title} · Codeply` : 'Codeply';
    if (t !== lastTitle) { lastTitle = t; document.title = t; }
  }
  new MutationObserver(syncTitle).observe($('chatList'), { childList: true, subtree: true });
  new MutationObserver(syncTitle).observe($('feed'), { childList: true });

  // ─── Files: drop on the window, or paste into the box ─────────────────────
  const drop = document.createElement('div');
  drop.className = 'desk-drop';
  drop.innerHTML = '<div><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>Drop to attach<small>Images, PDFs, documents and code</small></div>';
  document.body.append(drop);
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const canAttach = () => !$('app').classList.contains('hidden') && P.addAttFiles && window.CodeplyAttach;
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !canAttach()) return; e.preventDefault(); dragDepth++; drop.classList.add('on'); });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e) || !canAttach()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('on'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; drop.classList.remove('on');
    if (!canAttach()) return;
    const files = [...e.dataTransfer.files];
    if (files.length) { P.addAttFiles(files); focusBox(); }
  });
  input.addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (!files.length || !canAttach()) return;
    e.preventDefault();
    P.addAttFiles(files);
  });

  // ─── Dialogs: a click outside closes them ─────────────────────────────────
  document.addEventListener('mousedown', (e) => {
    if (!wide()) return;
    const open = [...document.querySelectorAll('section.panel:not(.hidden)')].pop();
    if (!open || open.contains(e.target)) return;
    if (e.target.closest('#popLayer, .sheet, .call, .lightbox, .onboard, .desk-keys')) return;
    const close = open.querySelector('[data-close-panel], .top .icon-btn[id$="Back"]');
    if (close) { e.preventDefault(); close.click(); }
  });

  // ─── Keyboard ─────────────────────────────────────────────────────────────
  const SHORTCUTS = [
    ['New chat', [MOD, '⇧', 'O']],
    ['Search chats', [MOD, 'K']],
    ['Open or close the sidebar', [MOD, 'B']],
    ['Focus the message box', ['/']],
    ['Stop the reply', ['Esc']],
    ['Copy the last reply', [MOD, '⇧', 'C']],
    ['Settings', [MOD, ',']],
    ['Send', ['Enter']],
    ['New line', ['Shift', 'Enter']],
    ['These shortcuts', [MOD, '/']],
  ];
  function showKeys() {
    if (document.querySelector('.desk-keys')) return;
    const box = document.createElement('div');
    box.className = 'desk-keys';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Keyboard shortcuts');
    box.innerHTML = `<div><h2>Keyboard shortcuts</h2><dl>${SHORTCUTS.map(([what, keys]) => `<dt>${what}</dt><dd>${keys.map((k) => `<kbd>${k}</kbd>`).join('')}</dd>`).join('')}</dl></div>`;
    box.addEventListener('mousedown', (e) => { if (e.target === box) box.remove(); });
    document.body.append(box);
  }
  const overlayOpen = () => !!document.querySelector('.desk-keys, #popLayer:not(.hidden), section.panel:not(.hidden), .sheet:not(.hidden), .call:not(.hidden), .lightbox:not(.hidden), .onboard:not(.hidden)');
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function lastReply() {
    const all = document.querySelectorAll('#feed .msg.agent');
    return all.length ? all[all.length - 1].innerText.trim() : '';
  }
  document.addEventListener('keydown', (e) => {
    if ($('app').classList.contains('hidden')) return; // signed out
    const mod = mac ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      const keys = document.querySelector('.desk-keys');
      if (keys) { keys.remove(); return; }
      if (overlayOpen()) {
        const open = [...document.querySelectorAll('section.panel:not(.hidden)')].pop();
        const close = open && open.querySelector('[data-close-panel], .top .icon-btn[id$="Back"]');
        if (close && $('popLayer').classList.contains('hidden')) close.click();
        return;
      }
      // a reply is coming: Esc stops it (the send button is the stop button then)
      if (!$('stopIcon').classList.contains('hidden')) { e.preventDefault(); $('sendBtn').click(); }
      return;
    }
    if (mod && e.shiftKey && k === 'o') { e.preventDefault(); $('newChatTopBtn').click(); setTimeout(focusBox, 50); return; }
    if (mod && !e.shiftKey && k === 'k') {
      e.preventDefault();
      if (wide()) setSide(true); else P.openDrawer();
      if ($('drawerSearch').classList.contains('hidden')) $('searchToggle').click();
      setTimeout(() => $('searchInput').focus(), 30);
      return;
    }
    if (mod && !e.shiftKey && k === 'b' && wide()) { e.preventDefault(); setSide(root.classList.contains('side-closed')); return; }
    if (mod && (k === '/' || e.code === 'Slash')) { e.preventDefault(); showKeys(); return; }
    if (mod && k === ',') { e.preventDefault(); $('settingsBtn').click(); return; }
    if (mod && e.shiftKey && k === 'c') {
      const text = lastReply();
      if (text && navigator.clipboard) { e.preventDefault(); navigator.clipboard.writeText(text).then(() => toast('Copied the last reply'), () => {}); }
      return;
    }
    // Typing anywhere goes to the box (like ChatGPT); "/" focuses it
    if (!mod && !e.altKey && !typing(e.target) && !overlayOpen()) {
      if (e.key === '/' ) { e.preventDefault(); focusBox(); return; }
      if (e.key.length === 1 && !e.metaKey) focusBox();
    }
  });

  let toastEl = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99;padding:9px 14px;border-radius:12px;background:var(--text);color:var(--bg);font-size:13.5px;font-weight:500;box-shadow:var(--shadow);transition:opacity .2s;pointer-events:none';
      document.body.append(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { toastEl.style.opacity = '0'; }, 1600);
  }
})();
