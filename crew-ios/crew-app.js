// Codeply Crew on iPhone: only your agents. Chats with each one, voice calls
// (phone-calls.js), what each agent knows (its context page), and sharing a
// screenshot, a photo or your PC's screen with it.
//
// A message goes to the PC as a text turn (/api/bots/voice with mode 'text'),
// so the agent answers with its real tools; the app shows what it is doing
// and asks here when it needs your OK. With the PC off, the agent still
// answers through Codeply's ai-proxy, without tools.
'use strict';

(() => {
  const K = window.CrewCore;
  const CALLS = () => window.CraftCalls;
  const A = () => window.CraftAvatar || null;
  const { esc, load, save, newId } = K;
  const $ = (id) => document.getElementById(id);

  const ICON = {
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><path d="M5.5 4h3.2l1.8 4.5-2.2 1.4a11 11 0 0 0 5.8 5.8l1.4-2.2 4.5 1.8v3.2a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 4 5.6 1.5 1.5 0 0 1 5.5 4Z"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 2.5-2 4.5 3.5"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.5" r="3.5"/></svg>',
    screen: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5Z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  };

  // ─── Threads (one per agent, on this phone) ─────────────────────────────────
  const MAX_MSGS = 200;
  const threadKey = (id) => `crew-thread-${id}`;
  const threads = new Map(); // botId -> [{ id, who: 'user'|'bot', text, images, at, error }]
  const thread = (id) => { if (!threads.has(id)) threads.set(id, load(threadKey(id), [])); return threads.get(id); };
  function saveThread(id) {
    let list = thread(id).filter((m) => !m.pending).slice(-MAX_MSGS);
    while (!save(threadKey(id), list) && list.length > 10) list = list.slice(Math.floor(list.length / 3));
  }
  const lastMsg = (id) => { const t = thread(id).filter((m) => !m.pending); return t[t.length - 1] || null; };
  const working = new Map(); // botId -> { ctl, step, approval, jobId }

  // ─── Small helpers ──────────────────────────────────────────────────────────
  const bots = () => (CALLS() ? CALLS().cache.bots : []);
  const botById = (id) => bots().find((b) => b.id === id) || null;
  const pcOnline = () => !!K.relay.pcId;
  function avatar(bot, size, opts) {
    try { if (A()) return A().renderAvatar(bot.avatar || {}, size, { still: true, ...(opts || {}) }); } catch {}
    return `<span class="av-fallback" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc(String(bot.name || '?').trim()[0] || '?').toUpperCase()}</span>`;
  }
  function when(at) {
    if (!at) return '';
    const d = new Date(at); const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  const dur = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const preview = (t) => String(t || '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  // Just enough markdown for agent replies: code, bold, italic, lists, links. Escapes first.
  function inline(s) {
    return String(s).split(/(`[^`\n]+`)/).map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>'))).join('');
  }
  function md(src) {
    return String(src || '').replace(/\r\n/g, '\n').split(/^```/m).map((part, i) => {
      if (i % 2) { const nl = part.indexOf('\n'); return `<pre><code>${esc((nl >= 0 ? part.slice(nl + 1) : '').replace(/\n$/, ''))}</code></pre>`; }
      const out = []; let para = []; let list = null;
      const flushP = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
      const flushL = () => { if (list) out.push(`<${list.t}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.t}>`); list = null; };
      for (const line of part.split('\n')) {
        const ul = /^\s*[-*+]\s+(.*)$/.exec(line); const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (!line.trim()) { flushP(); flushL(); continue; }
        if (ul || ol) { flushP(); const t = ul ? 'ul' : 'ol'; if (!list || list.t !== t) { flushL(); list = { t, items: [] }; } list.items.push((ul || ol)[1]); continue; }
        flushL(); para.push(line.replace(/^\s*#{1,6}\s+/, ''));
      }
      flushP(); flushL();
      return out.join('');
    }).join('');
  }

  // ─── Tabs ───────────────────────────────────────────────────────────────────
  let tab = 'Chats';
  function showTab(name) {
    tab = name;
    for (const b of document.querySelectorAll('#tabbar button')) b.classList.toggle('on', b.dataset.tab === name);
    for (const v of ['Chats', 'Calls', 'You']) $(`view${v}`).classList.toggle('hidden', v !== name);
    render();
  }
  $('tabbar').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
  function render() {
    if (tab === 'Chats') renderChats();
    else if (tab === 'Calls') renderCalls();
    else renderYou();
  }

  function pcChip() {
    const on = pcOnline();
    const text = on ? `${K.pcName()} is online` : K.relay.noPc ? 'Sign in to Codeply on your PC' : K.relay.channel ? 'Your PC is offline' : 'Connecting...';
    return `<span class="pc-chip${on ? ' on' : ''}"><i></i>${esc(text)}</span>`;
  }

  // ─── Chats ──────────────────────────────────────────────────────────────────
  let query = '';
  function renderChats() {
    const root = $('viewChats');
    const list = bots().slice().sort((a, b) => ((lastMsg(b.id) || {}).at || 0) - ((lastMsg(a.id) || {}).at || 0));
    const q = query.toLowerCase();
    const shown = q ? list.filter((b) => `${b.name} ${b.specialty || ''}`.toLowerCase().includes(q)) : list;
    let html = `<header class="big-head"><div class="head-row"><h1>Crew</h1>
      <button class="round-btn" id="newAgentBtn" aria-label="New agent">${ICON.plus}</button></div>${pcChip()}</header>`;
    if (list.length > 4) html += `<label class="search">${ICON.search}<input id="chatSearch" placeholder="Search" value="${esc(query)}"></label>`;
    if (!list.length) {
      const tpl = (CALLS() && CALLS().cache.templates) || [];
      html += `<div class="empty"><img src="mark-256.png" alt=""><h2>No agents yet</h2><p>${pcOnline()
        ? 'Build one, or add a starter agent below. They live on your PC and work with its tools.'
        : 'Turn on your PC with Codeply signed in and your agents show up here. You can also build one now.'}</p>
        <button class="btn btn-brand" data-act="new">New agent</button></div>`;
      if (pcOnline() && tpl.length) {
        html += '<div class="label">Starter agents</div><div class="list">';
        for (const t of tpl) html += `<div class="row">${avatar(t, 44)}<span class="row-main"><strong>${esc(t.name)}</strong><small>${esc(t.specialty || '')}</small></span><button class="pill" data-tpl="${esc(t.key)}">Add</button></div>`;
        html += '</div>';
      }
    } else {
      html += '<div class="list chats">';
      for (const b of shown) {
        const m = lastMsg(b.id);
        const w = working.get(b.id);
        const sub = w ? `<span class="typing">${esc(w.approval ? 'Needs your OK' : w.step || 'Typing...')}</span>`
          : m ? `${m.who === 'user' ? 'You: ' : ''}${esc(preview(m.text) || (m.images && m.images.length ? 'Shared an image' : ''))}`
          : esc(b.pending ? 'On this phone until your PC is online' : b.specialty || 'Say hi');
        html += `<button class="row" data-open="${esc(b.id)}">${avatar(b, 52)}
          <span class="row-main"><span class="row-top"><strong>${esc(b.name)}</strong><time>${esc(m ? when(m.at) : '')}</time></span><small>${sub}</small></span></button>`;
      }
      html += '</div>';
    }
    root.innerHTML = html;
    const s = $('chatSearch');
    if (s) s.addEventListener('input', () => { query = s.value; const pos = s.selectionStart; renderChats(); const n = $('chatSearch'); n.focus(); n.setSelectionRange(pos, pos); });
  }
  $('viewChats').addEventListener('click', (e) => {
    const t = e.target.closest('[data-open],[data-tpl],[data-act],#newAgentBtn');
    if (!t) return;
    if (t.dataset.open) openThread(t.dataset.open);
    else if (t.dataset.tpl) addTemplate(t);
    else if (CALLS()) CALLS().openBuilder();
  });
  async function addTemplate(btn) {
    btn.disabled = true; btn.textContent = 'Adding...';
    try {
      const r = await K.relayRequest('POST', '/api/bots/template', { key: btn.dataset.tpl });
      if (r && Array.isArray(r.bots)) { CALLS().cache.bots = r.bots; CALLS().cache.at = Date.now(); save('craft-phone-bots', CALLS().cache); }
    } catch (e) { toast(e.message); }
    render();
  }

  // ─── Calls ──────────────────────────────────────────────────────────────────
  function renderCalls() {
    const list = CALLS() ? CALLS().calls() : [];
    let html = `<header class="big-head"><div class="head-row"><h1>Calls</h1></div>${pcChip()}</header>`;
    if (bots().length) {
      html += '<div class="label">Call an agent</div><div class="dial">';
      for (const b of bots()) html += `<button data-call="${esc(b.id)}">${avatar(b, 58)}<span>${esc(b.name)}</span></button>`;
      html += '</div>';
    }
    html += '<div class="label">Recent</div>';
    if (!list.length) html += '<p class="none">No calls yet. Tap an agent above to call it.</p>';
    else {
      html += '<div class="list">';
      for (const c of list) {
        const missed = c.status !== 'done';
        html += `<details class="call-item${missed ? ' missed' : ''}"><summary class="row">${avatar({ name: c.name, avatar: c.avatar }, 40, { flat: true })}
          <span class="row-main"><strong>${esc(c.name)}</strong><small>${missed ? 'Cancelled' : `Voice call · ${dur(c.ms)}`}</small></span>
          <time>${esc(when(c.at))}</time><button class="icon-btn" data-call="${esc(c.botId)}" aria-label="Call back">${ICON.phone}</button></summary>
          <div class="transcript">${c.turns.length ? c.turns.map((t) => `<p class="${t.who}"><b>${t.who === 'bot' ? esc(c.name) : 'You'}</b>${esc(t.text)}</p>`).join('') : '<p class="none">Nothing was said.</p>'}</div></details>`;
      }
      html += '</div>';
    }
    html += '<p class="foot">Calls run on this phone. What you say becomes text here, and each agent answers in its own voice, with its tools when your PC is on.</p>';
    $('viewCalls').innerHTML = html;
  }
  function call(botId) {
    const b = botById(botId);
    if (!b) { toast('That agent is not on your PC any more.'); return; }
    CALLS().startCall(b);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-call]');
    if (!t || t.closest('#call')) return;
    e.preventDefault(); e.stopPropagation();
    call(t.dataset.call);
  });

  // ─── You ────────────────────────────────────────────────────────────────────
  function renderYou() {
    const u = K.relay.user;
    const theme = load('crew-theme', 'system');
    $('viewYou').innerHTML = `<header class="big-head"><div class="head-row"><h1>You</h1></div></header>
      <div class="card">
        <div class="row"><span class="row-main"><strong>${esc((u && u.email) || 'Signed in')}</strong><small>Codeply account</small></span></div>
        <div class="row"><span class="row-main"><strong>${esc(pcOnline() ? K.pcName() : 'No PC online')}</strong><small>${pcOnline() ? 'Your agents run here, with their tools' : 'Open Codeply on your PC to use tools'}</small></span>${pcChip()}</div>
      </div>
      <div class="label">Appearance</div>
      <div class="seg" id="themeSeg">${['system', 'light', 'dark'].map((t) => `<button data-theme="${t}" class="${theme === t ? 'on' : ''}">${t[0].toUpperCase()}${t.slice(1)}</button>`).join('')}</div>
      <div class="label">About</div>
      <div class="card"><div class="row"><span class="row-main"><strong>Codeply Crew</strong><small>Version 0.1.0. Chats, calls and context for your Codeply agents.</small></span></div></div>
      <button class="btn btn-danger wide" id="signOutBtn">Sign out</button>`;
  }
  $('viewYou').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-theme],#signOutBtn');
    if (!t) return;
    if (t.id === 'signOutBtn') { await K.closeRelay(); try { await K.sb.auth.signOut(); } catch {} showSignin(); return; }
    const v = t.dataset.theme;
    try { if (v === 'system') localStorage.removeItem('crew-theme'); else localStorage.setItem('crew-theme', JSON.stringify(v)); } catch {}
    if (v === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
    renderYou();
  });

  // ─── A chat with one agent ──────────────────────────────────────────────────
  let openId = null;
  let attached = []; // [{ full, thumb }] waiting to be sent
  function openThread(id) {
    openId = id;
    attached = [];
    $('thread').classList.remove('hidden');
    $('thread').classList.add('in');
    paintThread(true);
  }
  function closeThread() { openId = null; $('thread').classList.add('hidden'); renderChats(); }

  function paintThread(first) {
    const bot = botById(openId);
    const root = $('thread');
    if (!bot) { closeThread(); return; }
    const w = working.get(bot.id);
    const status = w ? (w.approval ? 'Needs your OK' : w.step || 'Typing...') : pcOnline() ? 'With its tools on your PC' : 'PC offline, answers without tools';
    if (first || !root.querySelector('.msgs')) {
      root.innerHTML = `<header class="bar">
          <button class="icon-btn" data-t="back" aria-label="Back">${ICON.back}</button>
          <button class="bar-who" data-t="profile">${avatar(bot, 34)}<span><strong>${esc(bot.name)}</strong><small id="tStatus"></small></span></button>
          <button class="icon-btn" data-call="${esc(bot.id)}" aria-label="Call ${esc(bot.name)}">${ICON.phone}</button>
          <button class="icon-btn" data-t="profile" aria-label="Context">${ICON.info}</button>
        </header>
        <div class="msgs" id="msgs"></div>
        <div class="tray hidden" id="tray"></div>
        <form class="composer" id="composer">
          <button type="button" class="icon-btn add" data-t="share" aria-label="Share">${ICON.plus}</button>
          <textarea id="msgInput" rows="1" placeholder="Message ${esc(bot.name)}"></textarea>
          <button type="submit" class="send" id="sendBtn" aria-label="Send">${ICON.send}</button>
        </form>`;
      const input = $('msgInput');
      input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; syncSend(); });
      $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    }
    $('tStatus').textContent = status;
    $('tStatus').classList.toggle('busy', !!w);
    paintMsgs();
    paintTray();
    syncSend();
  }
  function syncSend() {
    const input = $('msgInput');
    if (!input) return;
    const w = openId && working.get(openId);
    $('sendBtn').disabled = !!w || (!input.value.trim() && !attached.length);
  }
  function paintMsgs() {
    const box = $('msgs');
    if (!box) return;
    const bot = botById(openId);
    const list = thread(openId);
    let html = '';
    if (!list.length) html += `<div class="hello">${avatar(bot, 88)}<h2>${esc(bot.name)}</h2><p>${esc(bot.specialty || 'Your agent')}</p>
      <div class="hello-actions"><button class="pill" data-say="What can you do for me?">What can you do?</button><button class="pill" data-t="share">Share my screen</button></div></div>`;
    let prevDay = '';
    for (const m of list) {
      const day = new Date(m.at).toDateString();
      if (day !== prevDay) { html += `<div class="day">${esc(when(m.at).includes(':') ? 'Today' : when(m.at))}</div>`; prevDay = day; }
      const imgs = (m.images || []).map((src) => `<img src="${esc(src)}" alt="">`).join('');
      html += `<div class="msg ${m.who}${m.error ? ' err' : ''}">${imgs ? `<div class="imgs">${imgs}</div>` : ''}${m.text ? `<div class="bubble">${m.who === 'bot' && !m.error ? md(m.text) : esc(m.text).replace(/\n/g, '<br>')}</div>` : ''}</div>`;
    }
    const w = working.get(openId);
    if (w) {
      if (w.approval) {
        const a = w.approval;
        html += `<div class="approve"><strong>${esc(a.title || 'Allow this?')}</strong>${a.detail ? `<p>${esc(a.detail)}</p>` : ''}
          ${a.draft ? `<div class="draft"><small>To ${esc(a.draft.to)}</small><b>${esc(a.draft.subject)}</b><p>${esc(a.draft.body).slice(0, 1200)}</p></div>` : ''}
          <div class="approve-row"><button class="btn btn-quiet" data-v="reject">Don't allow</button>
          ${a.draftOnly ? '<button class="btn btn-brand" data-v="draft">Save draft</button>' : `<button class="btn btn-brand" data-v="once">${a.danger ? 'Allow anyway' : 'Allow'}</button>`}</div></div>`;
      } else html += `<div class="msg bot"><div class="bubble dots"><i></i><i></i><i></i>${w.step ? `<span>${esc(w.step)}</span>` : ''}</div></div>`;
    }
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = html;
    if (stick || w) box.scrollTop = box.scrollHeight;
  }
  function paintTray() {
    const tray = $('tray');
    if (!tray) return;
    tray.classList.toggle('hidden', !attached.length);
    tray.innerHTML = attached.map((a, i) => `<span class="thumb"><img src="${esc(a.thumb)}" alt=""><button type="button" data-rm="${i}" aria-label="Remove">${ICON.x}</button></span>`).join('');
  }
  $('thread').addEventListener('click', (e) => {
    const t = e.target.closest('[data-t],[data-v],[data-rm],[data-say]');
    if (!t) return;
    if (t.dataset.t === 'back') closeThread();
    else if (t.dataset.t === 'profile') openProfile(openId);
    else if (t.dataset.t === 'share') openShare();
    else if (t.dataset.v) answer(t.dataset.v, t);
    else if (t.dataset.rm) { attached.splice(Number(t.dataset.rm), 1); paintTray(); syncSend(); }
    else if (t.dataset.say) { $('msgInput').value = t.dataset.say; send(); }
  });

  // ─── Share: a screenshot, a photo, or the PC's screen ───────────────────────
  function openShare() {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `<div class="sheet-bg" data-s="close"></div><div class="sheet-card"><div class="sheet-handle"></div>
      <h2 class="sheet-title">Share with ${esc((botById(openId) || {}).name || 'your agent')}</h2>
      <p class="sheet-text">It sees what you share with your next message.</p>
      <div class="share-list">
        <button data-s="shot">${ICON.image}<span><strong>Screenshot or photo</strong><small>Show it something on your phone. Take a screenshot first, then pick it here.</small></span></button>
        <button data-s="camera">${ICON.camera}<span><strong>Camera</strong><small>Point it at a screen, a page, anything.</small></span></button>
        <button data-s="pc" ${pcOnline() ? '' : 'disabled'}>${ICON.screen}<span><strong>Your PC's screen</strong><small>${pcOnline() ? 'It looks at your PC screen right now.' : 'Your PC is offline.'}</small></span></button>
      </div></div>`;
    document.body.appendChild(sheet);
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      sheet.remove();
      if (b.dataset.s === 'shot') $('pickImage').click();
      else if (b.dataset.s === 'camera') $('takePhoto').click();
      else if (b.dataset.s === 'pc') { $('msgInput').value = 'Look at my PC screen and tell me what you see.'; send(); }
    });
  }
  /** An image file as a JPEG data URL no bigger than `max` px on its longest side. */
  function shrink(file, max, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * s); cv.height = Math.round(img.naturalHeight * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened.')); };
      img.src = url;
    });
  }
  for (const id of ['pickImage', 'takePhoto']) {
    $(id).addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file || attached.length >= 4) return;
      try { attached.push({ full: await shrink(file, 1600, 0.82), thumb: await shrink(file, 420, 0.7) }); }
      catch (x) { toast(x.message); }
      paintTray(); syncSend();
    });
  }

  // ─── Sending ────────────────────────────────────────────────────────────────
  const TEXT_RULES_OFFLINE = `PHONE MESSAGES
The user is texting you from Codeply Crew on their phone.
- Reply like a good text message: short and easy to read on a phone. Light markdown is fine; no headings, no long dash.
- Right now you cannot use your tools (email, files, the web), because the user's PC is offline. If they ask for that kind of work, say so in one sentence and offer to do it once their PC is on.`;

  async function send() {
    const bot = botById(openId);
    const input = $('msgInput');
    const text = input.value.trim();
    if (!bot || working.get(bot.id) || (!text && !attached.length)) return;
    const shared = attached; attached = [];
    input.value = ''; input.style.height = 'auto';
    const list = thread(bot.id);
    list.push({ id: newId(), who: 'user', text, images: shared.map((a) => a.thumb), at: Date.now() });
    saveThread(bot.id);
    const ctl = new AbortController();
    const w = { ctl, step: '', approval: null, jobId: null };
    working.set(bot.id, w);
    refresh(bot.id);
    const turns = list.filter((m) => !m.error).slice(-16).map((m) => ({ who: m.who, text: m.text || (m.images && m.images.length ? '(shared an image)' : '') }));
    const images = shared.map((a) => a.full);
    let reply = '';
    let error = '';
    try {
      reply = pcOnline() ? await askOnPc(bot, turns, images, w).catch((e) => {
        if (e.timeout || /offline|didn't answer/i.test(e.message)) return askOffline(bot, turns, images, ctl.signal);
        throw e;
      }) : await askOffline(bot, turns, images, ctl.signal);
      // "Remind me at 5" / "call me later": the reply's reminder lines become reminders (phone-reminders.js).
      const R = window.CraftReminders;
      if (R && reply) {
        const { text: clean, reminds } = R.extract(reply);
        reply = clean;
        for (const t of reminds) R.createFromTag(t, bot).then(() => window.CrewNative && window.CrewNative.sync()).catch((e) => toast(e.message));
      }
    } catch (e) { error = e.message || 'Something went wrong.'; }
    working.delete(bot.id);
    list.push(error ? { id: newId(), who: 'bot', text: error, error: true, at: Date.now() } : { id: newId(), who: 'bot', text: reply || '(no reply)', at: Date.now() });
    saveThread(bot.id);
    refresh(bot.id);
  }
  function refresh(botId) {
    if (openId === botId) paintThread();
    if (tab === 'Chats') renderChats();
  }
  /** An agent texted you on its own (crew-native.js, from a reminder): it lands in its chat once. */
  function receive(botId, text, { id, at } = {}) {
    if (!botId || !text) return;
    const list = thread(botId);
    if (id && list.some((m) => m.id === id)) return;
    list.push({ id: id || newId(), who: 'bot', text, at: at || Date.now() });
    list.sort((a, b) => a.at - b.at);
    saveThread(botId);
    refresh(botId);
  }

  // The turn runs on the PC as the agent's real run: a job we poll, which
  // reports its steps and stops for approvals.
  async function askOnPc(bot, turns, images, w) {
    let r = await K.relayRequest('POST', '/api/bots/voice', { botId: bot.id, turns, mode: 'text', images }, 40000);
    w.jobId = r.jobId;
    for (;;) {
      if (r.status === 'done') return r.text || '';
      if (r.status === 'cancelled') throw new Error('Stopped.');
      if (r.status === 'error' || (r.error && !r.jobId)) throw new Error(r.error || 'Your PC could not answer.');
      const step = r.step || '';
      const ask = r.approval || null;
      if (step !== w.step || (ask && (!w.approval || w.approval.requestId !== ask.requestId)) || (!ask && w.approval)) {
        w.step = step; w.approval = ask;
        refresh(bot.id);
      }
      if (ask) {
        const verdict = await new Promise((resolve) => { w.answer = resolve; });
        w.approval = null; w.answer = null;
        refresh(bot.id);
        await K.relayRequest('POST', '/api/bots/voice/answer', { jobId: r.jobId, requestId: ask.requestId, verdict });
      }
      r = await K.relayRequest('POST', '/api/bots/voice/poll', { jobId: r.jobId, version: r.version }, 20000);
    }
  }
  function answer(verdict, btn) {
    const w = working.get(openId);
    if (!w || !w.answer) return;
    for (const b of btn.parentElement.querySelectorAll('button')) b.disabled = true;
    w.answer(verdict);
  }

  async function askOffline(bot, turns, images, signal) {
    const base = bot.prompt || `You are ${bot.name}, one of the user's agents in Codeply.${bot.specialty ? ` Your job: ${bot.specialty}.` : ''}${bot.instructions ? `\n${bot.instructions}` : ''}`;
    const R = window.CraftReminders;
    const messages = [{ role: 'system', content: `${base}\n\n${TEXT_RULES_OFFLINE}${R ? R.chatRules() : ''}` },
      ...turns.map((t) => ({ role: t.who === 'bot' ? 'assistant' : 'user', content: String(t.text || '').slice(0, 4000) }))];
    const last = messages[messages.length - 1];
    if (images.length && last.role === 'user') last.content = [{ type: 'text', text: last.content || 'Look at this.' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
    const token = await K.accessToken();
    const res = await fetch(K.AI_PROXY_URL, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, apikey: K.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...K.deviceHeader() },
      body: JSON.stringify({ messages, opts: { maxTokens: 700, temperature: 0.7 }, meta: { source: 'crew-ios' } }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      const choice = data.data && data.data.choices && data.data.choices[0];
      return String((choice && choice.message && choice.message.content) || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }
    if (res.status === 401 && !data.error) throw new Error('Your sign-in expired. Sign in again.');
    throw new Error(data.error || data.message || `Codeply could not answer (${res.status}).`);
  }

  // ─── Context: what an agent is and knows ────────────────────────────────────
  function openProfile(id) {
    const bot = botById(id);
    if (!bot) return;
    const root = $('profile');
    const facts = Array.isArray(bot.memory) ? bot.memory : [];
    const sources = Array.isArray(bot.sources) ? bot.sources : bot.sources ? Object.keys(bot.sources).filter((k) => bot.sources[k]) : [];
    const callList = (CALLS() ? CALLS().calls() : []).filter((c) => c.botId === id).slice(0, 5);
    root.innerHTML = `<header class="bar"><button class="icon-btn" data-p="back" aria-label="Back">${ICON.back}</button><span class="bar-title">Context</span><span class="icon-btn"></span></header>
      <div class="prof">
        <div class="prof-top">${avatar(bot, 110, { still: false })}<h1>${esc(bot.name)}</h1><p>${esc(bot.specialty || (bot.role === 'orchestrator' ? 'Leads your crew' : 'Specialist'))}</p></div>
        <div class="prof-actions">
          <button data-p="chat">${ICON.chat}<span>Message</span></button>
          <button data-call="${esc(bot.id)}">${ICON.phone}<span>Call</span></button>
          <button data-p="share">${ICON.screen}<span>Share</span></button>
        </div>
        <div class="label">What it knows about you</div>
        <div class="card facts">${facts.length ? facts.map((f) => `<p>${esc(f)}</p>`).join('') : '<p class="none">Nothing yet. It learns from your chats and calls.</p>'}</div>
        ${bot.instructions ? `<div class="label">How it works</div><div class="card"><p class="pre">${esc(bot.instructions)}</p></div>` : ''}
        ${sources.length ? `<div class="label">What it can reach</div><div class="chips">${sources.map((s) => `<span>${esc(typeof s === 'string' ? s : s.name || s.key || '')}</span>`).join('')}</div>` : ''}
        ${bot.tone ? `<div class="label">Tone</div><div class="card"><p>${esc(bot.tone)}</p></div>` : ''}
        ${callList.length ? `<div class="label">Recent calls</div><div class="card">${callList.map((c) => `<div class="row"><span class="row-main"><strong>${c.status === 'done' ? `Voice call · ${dur(c.ms)}` : 'Cancelled'}</strong><small>${esc(when(c.at))}</small></span></div>`).join('')}</div>` : ''}
        <button class="btn btn-quiet wide" data-p="clear">Clear this chat</button>
        <p class="foot">Its memory and tools live on your PC. Edit the agent in Codeply on your PC.</p>
      </div>`;
    root.classList.remove('hidden');
    root.dataset.bot = id;
  }
  $('profile').addEventListener('click', (e) => {
    const t = e.target.closest('[data-p]');
    if (!t) return;
    const id = $('profile').dataset.bot;
    const close = () => $('profile').classList.add('hidden');
    if (t.dataset.p === 'back') close();
    else if (t.dataset.p === 'chat') { close(); if (openId !== id) openThread(id); }
    else if (t.dataset.p === 'share') { close(); if (openId !== id) openThread(id); openShare(); }
    else if (t.dataset.p === 'clear' && confirm('Clear this chat on this phone?')) { threads.set(id, []); saveThread(id); close(); if (openId === id) paintThread(true); renderChats(); }
  });

  // ─── Sign in ────────────────────────────────────────────────────────────────
  function authError(err, fallback) {
    const s = String((err && err.message) || err || '').toLowerCase();
    if (s.includes('invalid login') || s.includes('invalid credentials')) return 'Incorrect email or password.';
    if (s.includes('email not confirmed')) return 'Confirm your email first (check your inbox), then sign in.';
    if (s.includes('expired') || (s.includes('invalid') && (s.includes('otp') || s.includes('token')))) return 'That code is wrong or has expired. Request a new one.';
    if (s.includes('rate') || s.includes('too many') || s.includes('seconds')) return 'Too many attempts. Wait a minute and try again.';
    if (s.includes('signups not allowed') || s.includes('user not found')) return 'No account with that email. Create one in Codeply on your PC first.';
    if (s.includes('fetch') || s.includes('network')) return "Can't reach Codeply. Check your internet connection.";
    return (err && err.message) || fallback;
  }
  function step(name, text) {
    $('loginForm').classList.toggle('hidden', name !== 'login');
    $('otpForm').classList.toggle('hidden', name !== 'otp');
    $('signinBusy').classList.toggle('hidden', name !== 'busy');
    if (name === 'busy') $('signinBusyText').textContent = text || 'Signing in...';
  }
  function showErr(id, text) { const el = $(id); el.textContent = text; el.classList.toggle('hidden', !text); }
  function showSignin() {
    for (const id of ['app', 'thread', 'profile']) $(id).classList.add('hidden');
    $('signin').classList.remove('hidden');
    step('login');
  }
  async function enterApp() {
    $('signin').classList.add('hidden');
    $('app').classList.remove('hidden');
    const s = await K.currentSession();
    K.relay.user = (s && s.user) || K.relay.user;
    showTab('Chats');
    K.startRelay();
    if (window.CrewNative) window.CrewNative.start(); // agents' calls and texts as notifications
  }
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr('loginError', '');
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    if (!email || !password) { showErr('loginError', password ? 'Enter your email.' : 'Enter your password, or get a code by email.'); return; }
    step('busy', 'Signing in...');
    try {
      const { error } = await K.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      $('loginPassword').value = '';
      await enterApp();
    } catch (x) { step('login'); showErr('loginError', authError(x, 'Sign-in failed.')); }
  });
  $('useCodeBtn').addEventListener('click', async () => {
    const email = $('loginEmail').value.trim();
    if (!email) { showErr('loginError', 'Enter your email first.'); return; }
    showErr('loginError', '');
    step('busy', 'Sending your code...');
    try {
      const { error } = await K.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error) throw error;
      $('otpSentTo').textContent = `We emailed a sign-in code to ${email}.`;
      $('loginOtp').value = '';
      step('otp');
      $('loginOtp').focus();
    } catch (x) { step('login'); showErr('loginError', authError(x, 'Could not send a code.')); }
  });
  $('otpForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr('otpError', '');
    const token = $('loginOtp').value.replace(/\D+/g, '');
    if (token.length < 6) { showErr('otpError', 'Enter the full code from the email.'); return; }
    step('busy', 'Signing in...');
    try {
      const { error } = await K.sb.auth.verifyOtp({ email: $('loginEmail').value.trim(), token, type: 'email' });
      if (error) throw error;
      await enterApp();
    } catch (x) { step('otp'); showErr('otpError', authError(x, 'Could not verify the code.')); }
  });
  $('otpBackBtn').addEventListener('click', () => step('login'));

  // ─── Wiring ─────────────────────────────────────────────────────────────────
  // The bot list belongs to phone-calls.js: it refreshes when the PC comes
  // online, so watch its cache and redraw when it changes.
  let seenAt = -1;
  setInterval(() => {
    const c = CALLS() && CALLS().cache;
    if (!c || c.at === seenAt) return;
    seenAt = c.at;
    render();
    if (openId) paintThread();
  }, 700);
  window.addEventListener('crew:pc', () => { render(); if (openId) paintThread(); });
  // A call ended: the Calls tab and the agent's context show it.
  new MutationObserver(() => { if ($('call').classList.contains('hidden')) { if (tab === 'Calls') renderCalls(); } }).observe($('call'), { attributes: true, attributeFilter: ['class'] });
  // The bot builder (phone-calls.js) calls them bots; here they are agents.
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.nb-sheet .sheet-title, .nb-sheet .btn-primary, .nb-toast span')) {
      if (/\bbot\b/i.test(el.textContent)) el.textContent = el.textContent.replace(/\bbot\b/g, 'agent').replace(/\bBot\b/g, 'Agent');
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  window.CrewApp = { receive, openThread: (id) => { if (botById(id)) { $('profile').classList.add('hidden'); openThread(id); } } };

  (async () => {
    const s = await K.currentSession().catch(() => null);
    if (s) enterApp(); else showSignin();
  })();
  K.sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') showSignin(); });
})();
