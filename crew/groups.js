// Group chats: you and two or more bots in one room. The bots you @mention
// answer (or the ones whose job fits), one at a time, and a bot can @mention a
// teammate to hand over, so they talk to each other. The turn-taking happens in
// main.js (groups:send); this file is the sidebar section, the room and the
// "new group" sheet. Uses crew.js helpers through window.CrewUI.
(() => {
  const api = window.crew;
  const A = window.CraftAvatar;
  const UI = window.CrewUI;
  const S = window.CrewState;
  const { esc, md, ICON } = UI;
  const $ = (sel, root = document) => root.querySelector(sel);

  const busy = new Set(); // group ids that are talking
  let live = null; // { groupId, botId, el, body, thinking }
  let messages = [];

  const group = (id) => S.groups.find((g) => g.id === id) || null;
  const members = (g) => (g ? g.members.map((id) => UI.bot(id)).filter(Boolean) : []);
  const nameList = (list) => (list.length <= 1 ? (list[0] || '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

  /** Up to three member faces, overlapped. */
  function stack(g, size) {
    const list = members(g).slice(0, 3);
    const small = Math.round(size * 0.62);
    return `<span class="gstack" style="--gs:${size}px;--gsm:${small}px">${list.map((b, i) => `<span class="gstack-av" style="--i:${i}">${A.renderAvatar(b.avatar, small, { still: true })}</span>`).join('')}</span>`;
  }

  // ─── Sidebar ────────────────────────────────────────────────────────────
  function renderSide() {
    const wrap = $('#groupSide');
    if (!wrap) return;
    const show = S.groups.length || S.catalog.bots.length >= 2;
    wrap.classList.toggle('hidden', !show);
    const list = $('#groupList');
    const sorted = [...S.groups].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    list.innerHTML = sorted.length ? sorted.map((g) => `<button class="bot-item group-item${S.currentGroup === g.id ? ' on' : ''}" data-gid="${esc(g.id)}">
        <span class="av${busy.has(g.id) ? ' busy' : ''}">${stack(g, 32)}</span>
        <span class="bot-item-text"><div class="bot-item-name">${esc(g.name)}</div><div class="bot-item-sub">${esc(g.last || nameList(members(g).map((b) => b.name)))}</div></span>
      </button>`).join('') : '<div class="side-empty">Put two or more bots in one chat.</div>';
    list.querySelectorAll('[data-gid]').forEach((el) => el.addEventListener('click', () => open(el.dataset.gid)));
  }
  $('#newGroupBtn').addEventListener('click', () => create());

  // ─── New group / edit group ─────────────────────────────────────────────
  function create(existing) {
    const all = S.catalog.bots;
    if (!existing && all.length < 2) { UI.toast('Make at least two bots first.', 'error'); return; }
    const picked = new Set(existing ? existing.members : all.slice(0, Math.min(3, all.length)).map((b) => b.id));
    const ui = { name: existing ? existing.name : '', error: '' };
    const paint = () => {
      const m = UI.modal(`
        <div class="modal-head"><div class="modal-title">${existing ? 'Group settings' : 'New group chat'}</div><button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button></div>
        <div class="modal-body">
          <p class="dim" style="margin:0 0 14px">Everyone in the group sees the whole chat. @mention a bot to pick who answers; they can hand work to each other the same way. Only one bot works at a time.</p>
          <div class="field"><div class="field-label">Name</div><input class="input" id="gName" maxlength="40" value="${esc(ui.name)}" placeholder="${esc(nameList(all.filter((b) => picked.has(b.id)).map((b) => b.name)).slice(0, 40) || 'Launch team')}"></div>
          <div class="field"><div class="field-label">Who's in it <span class="dim">${picked.size} picked</span></div>
            <div class="gpick">${all.map((b) => `<button class="gpick-item${picked.has(b.id) ? ' on' : ''}" data-bid="${esc(b.id)}">${A.renderAvatar(b.avatar, 44, { still: true })}<b>${esc(b.name)}</b><span>${esc(b.specialty || '')}</span><i class="gpick-check">${ICON.ok}</i></button>`).join('')}</div></div>
        </div>
        <div class="modal-foot">
          ${existing ? `<button class="btn danger" data-act="delete">Delete group</button>` : ''}
          <span class="grow err-text">${esc(ui.error)}</span>
          <button class="btn" data-act="close">Cancel</button>
          <button class="btn primary" data-act="save">${existing ? 'Save' : 'Create group'}</button>
        </div>`, true);
      m.classList.add('wide');
      m.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', UI.closeModal));
      $('#gName', m).addEventListener('input', (e) => { ui.name = e.target.value; });
      m.querySelectorAll('[data-bid]').forEach((el) => el.addEventListener('click', () => {
        if (picked.has(el.dataset.bid)) picked.delete(el.dataset.bid); else picked.add(el.dataset.bid);
        ui.error = ''; paint();
      }));
      const del = $('[data-act="delete"]', m);
      if (del) del.addEventListener('click', async () => {
        if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = 'Click again to delete'; return; }
        const r = await api.groupsRemove(existing.id);
        if (r.error) { UI.toast(r.error, 'error'); return; }
        S.groups = r.groups;
        UI.closeModal(); UI.toast(`Deleted ${existing.name}.`);
        UI.goHome();
      });
      $('[data-act="save"]', m).addEventListener('click', async () => {
        if (picked.size < 2) { ui.error = 'Pick at least two bots.'; paint(); return; }
        const data = { name: ui.name, members: all.filter((b) => picked.has(b.id)).map((b) => b.id) };
        const r = existing ? await api.groupsUpdate(existing.id, data) : await api.groupsCreate(data);
        if (r.error) { ui.error = r.error; paint(); return; }
        S.groups = r.groups;
        UI.closeModal();
        if (!existing) UI.toast(`${r.group.name} is ready. Say hi.`);
        open(r.group.id);
      });
    };
    paint();
  }

  // ─── The room ───────────────────────────────────────────────────────────
  async function open(id) {
    const g = group(id);
    if (!g) { UI.goHome(); return; }
    S.currentGroup = id;
    S.current = null;
    try { localStorage.setItem('crew.last', `g:${id}`); } catch {}
    const r = await api.groupMessages(id);
    if (S.currentGroup !== id) return;
    messages = Array.isArray(r) ? r : [];
    UI.renderSide();
    render();
  }

  function chips(g) {
    const list = members(g);
    const out = ['Hi everyone, introduce yourselves in one line each', 'Plan a small weekend project together'];
    if (list[0]) out.push(`@${list[0].name} what would you need from the others?`);
    return out;
  }

  function composer(g) {
    const isBusy = busy.has(g.id);
    return `<div class="composer-wrap"><div class="mention-pop hidden" id="mentionPop"></div><div class="composer">
      <textarea id="input" rows="1" placeholder="Message ${esc(g.name)}, @ to pick who answers"></textarea>
      <div class="composer-row">
        <button class="model-chip" id="modelBtn">${esc(UI.modelName())}${ICON.chev}</button>
        <span class="grow"></span>
        <button class="send${isBusy ? ' stop' : ''}" id="sendBtn" aria-label="${isBusy ? 'Stop' : 'Send'}">${isBusy ? ICON.stop : ICON.up}</button>
      </div></div></div>`;
  }

  function render() {
    const g = group(S.currentGroup);
    if (!g) { UI.goHome(); return; }
    const list = members(g);
    const isBusy = busy.has(g.id);
    const empty = !messages.length && !isBusy;
    const view = $('#view');
    view.innerHTML = `
      <div class="thread-head">
        <button class="th-who" id="whoBtn">${stack(g, 34)}<span style="min-width:0;text-align:left"><div class="th-name">${esc(g.name)}</div><div class="th-sub">${esc(nameList(list.map((b) => b.name)))}</div></span></button>
        <span class="th-spacer"></span>
        <button class="icon-btn" id="moreBtn" aria-label="More">${ICON.more}</button>
      </div>
      ${empty ? `<div class="empty">
          ${stack(g, 96)}
          <div class="empty-name">${esc(g.name)}</div>
          <p class="empty-sub">${esc(nameList(list.map((b) => b.name)))} can all see this chat and talk to each other.</p>
          ${composer(g)}
          <div class="chips">${chips(g).map((s) => `<button class="chip">${esc(s)}</button>`).join('')}</div>
        </div>`
        : `<div class="scroller" id="scroller"><div class="msgs" id="msgs"></div></div>${composer(g)}`}`;
    $('#whoBtn').addEventListener('click', () => create(g));
    $('#moreBtn').addEventListener('click', (e) => UI.openMenu(e.currentTarget, [
      { label: 'Group settings', icon: ICON.edit, run: () => create(group(S.currentGroup)) },
      ...list.map((b) => ({ label: `Chat with ${b.name} alone`, run: () => UI.openBot(b.id) })),
      '-',
      { label: 'Clear this chat', icon: ICON.trash, danger: true, run: clear },
    ], 'right'));
    view.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { $('#input').value = c.textContent; send(); }));
    wireComposer(g);
    if (!empty) {
      const box = $('#msgs');
      renderStored(box, messages);
      if (isBusy && live && live.groupId === g.id) liveBlock(live.botId);
      const sc = $('#scroller');
      sc.addEventListener('scroll', () => $('.thread-head').classList.toggle('scrolled', sc.scrollTop > 4));
      UI.scrollDown(true);
    }
    $('#input').focus();
  }

  async function clear() {
    const g = group(S.currentGroup);
    if (!g) return;
    const r = await api.groupClear(g.id);
    if (r.error) { UI.toast(r.error, 'error'); return; }
    messages = []; g.last = '';
    UI.renderSide(); render();
  }

  function renderStored(box, list) {
    box.innerHTML = '';
    let body = null; let who = null;
    for (const m of list) {
      if (m.kind === 'user') { UI.appendUser(box, m.text); body = null; who = null; continue; }
      const b = UI.bot(m.botId);
      if (!body || who !== m.botId) { body = blockFor(box, b, false); who = m.botId; }
      if (m.kind === 'assistant') UI.addToBody(body, `<div class="m-text">${md(highlight(m.text))}</div>`);
      else if (m.kind === 'tool') UI.addToBody(body, UI.stepHtml(m));
      else if (m.kind === 'error') UI.addToBody(body, `<div class="note err">${esc(m.text)}</div>`);
    }
  }

  function blockFor(box, b, working) {
    const fallback = { name: 'Crew', avatar: { shape: 'round', eyes: 'ovals', color: '#8e8e93' } };
    return UI.botBlock(box, b || fallback, working).querySelector('.m-bot-body');
  }

  /** @Name in a message gets a quiet highlight (markdown keeps the span text). */
  function highlight(text) {
    const g = group(S.currentGroup);
    let out = String(text || '');
    for (const b of members(g)) out = out.replace(new RegExp(`@${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), `**@${b.name}**`);
    return out;
  }

  // The block for the bot whose turn it is right now.
  function liveBlock(botId) {
    const box = $('#msgs');
    if (!box || !live || S.currentGroup !== live.groupId) return null;
    if (live.botId !== botId || !live.el || !box.contains(live.el)) {
      const b = UI.bot(botId);
      const body = blockFor(box, b, true);
      const th = document.createElement('div');
      th.className = 'thinking';
      th.innerHTML = `<span class="shimmer">${esc(b ? `${b.name} is typing` : 'Thinking')}</span><span class="detail"></span>`;
      body.appendChild(th);
      Object.assign(live, { botId, el: body.parentElement, body, thinking: th });
    }
    return live.body;
  }

  function finishLive() {
    if (!live || !live.el) return;
    if (live.thinking) live.thinking.remove();
    const el = live.el;
    A.setAvatarState(el.querySelector('.av'), 'done');
    setTimeout(() => A.setAvatarState(el.querySelector('.av'), 'idle'), 1400);
    if (!live.body.querySelector('.m-text, .step, .note, .helper, .approve')) el.remove();
    live.el = null; live.body = null; live.thinking = null;
  }

  // ─── Composer ───────────────────────────────────────────────────────────
  function wireComposer(g) {
    const input = $('#input');
    UI.autosize(input);
    const pop = $('#mentionPop');
    let options = []; let sel = 0;
    const closePop = () => { pop.classList.add('hidden'); options = []; };
    const showPop = () => {
      const upto = input.value.slice(0, input.selectionStart);
      const m = /(^|\s)@(\w*)$/.exec(upto);
      if (!m) { closePop(); return; }
      const q = m[2].toLowerCase();
      options = [...members(g), { id: '*', name: 'everyone', specialty: 'The whole group answers' }].filter((b) => b.name.toLowerCase().startsWith(q));
      if (!options.length) { closePop(); return; }
      sel = Math.min(sel, options.length - 1);
      pop.innerHTML = options.map((b, i) => `<button class="mention-opt${i === sel ? ' on' : ''}" data-i="${i}">${b.id === '*' ? `<span class="mention-all">${ICON.group}</span>` : A.renderAvatar(b.avatar, 22, { still: true })}<b>${esc(b.name)}</b><span>${esc(b.specialty || '')}</span></button>`).join('');
      pop.classList.remove('hidden');
      pop.querySelectorAll('[data-i]').forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(Number(el.dataset.i)); }));
    };
    const pick = (i) => {
      const b = options[i];
      if (!b) return;
      const pos = input.selectionStart;
      const before = input.value.slice(0, pos).replace(/@(\w*)$/, `@${b.name} `);
      input.value = before + input.value.slice(pos);
      input.selectionStart = input.selectionEnd = before.length;
      closePop();
      input.dispatchEvent(new Event('input'));
      input.focus();
    };
    input.addEventListener('input', () => { sel = 0; showPop(); });
    input.addEventListener('click', showPop);
    input.addEventListener('blur', () => setTimeout(closePop, 120));
    input.addEventListener('keydown', (e) => {
      if (options.length && !pop.classList.contains('hidden')) {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % options.length; showPop(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + options.length) % options.length; showPop(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sel); return; }
        if (e.key === 'Escape') { e.preventDefault(); closePop(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $('#sendBtn').addEventListener('click', () => (busy.has(g.id) ? api.groupStop(g.id) : send()));
    $('#modelBtn').addEventListener('click', (e) => UI.openMenu(e.currentTarget, [
      { label: 'Auto', on: S.models.selected === 'auto' || !S.models.selected, run: () => UI.pickModel('auto') },
      ...S.models.models.map((m) => ({ label: m.name, on: S.models.selected === m.id, run: () => UI.pickModel(m.id) })),
      '-',
      { note: 'Add your own models in Craft. They show up here too.' },
    ]));
  }

  function setSendState() {
    const btn = $('#sendBtn');
    if (!btn || !S.currentGroup) return;
    const isBusy = busy.has(S.currentGroup);
    btn.classList.toggle('stop', isBusy);
    btn.innerHTML = isBusy ? ICON.stop : ICON.up;
    btn.setAttribute('aria-label', isBusy ? 'Stop' : 'Send');
  }

  async function send() {
    const g = group(S.currentGroup);
    const input = $('#input');
    if (!g || !input) return;
    const text = input.value.trim();
    if (!text || busy.has(g.id)) return;
    messages.push({ kind: 'user', text, at: Date.now() });
    if (!$('#msgs')) render();
    else { input.value = ''; input.dispatchEvent(new Event('input')); UI.appendUser($('#msgs'), text); }
    UI.scrollDown(true);
    const r = await api.groupSend(g.id, text);
    if (r.error) {
      messages.pop();
      render();
      $('#input').value = text; $('#input').dispatchEvent(new Event('input'));
      UI.toast(r.error, 'error');
      return;
    }
    g.last = `You: ${text}`.slice(0, 90); g.updatedAt = Date.now();
  }

  // ─── Events from main.js ────────────────────────────────────────────────
  function onEvent(ev) {
    const g = group(ev.groupId);
    if (!g) return;
    const here = S.currentGroup === ev.groupId;
    const b = ev.botId ? UI.bot(ev.botId) : null;
    const detail = (t) => { if (here && live && live.thinking) live.thinking.querySelector('.detail').textContent = t; };
    switch (ev.type) {
      case 'start':
        busy.add(g.id); live = { groupId: g.id, botId: null };
        UI.renderSide(); setSendState();
        break;
      case 'turn':
        if (live) { live.botId = null; if (here) { liveBlock(ev.botId); UI.scrollDown(true); } else live.botId = ev.botId; }
        break;
      case 'thinking':
        if (here && liveBlock(ev.botId)) detail(String(ev.text || '').replace(/\s+/g, ' ').slice(0, 160));
        break;
      case 'tool_start':
        if (here && liveBlock(ev.botId)) detail(`${UI.VERB[ev.name] || ev.name} ${ev.label || ''}`);
        break;
      case 'tool':
        messages.push({ kind: 'tool', ...ev });
        if (here && liveBlock(ev.botId)) { UI.addToBody(live.body, UI.stepHtml(ev)); UI.scrollDown(); }
        break;
      case 'text':
        messages.push({ kind: 'assistant', botId: ev.botId, text: ev.text });
        g.last = `${b ? b.name : 'A bot'}: ${String(ev.text).replace(/\s+/g, ' ')}`.slice(0, 90);
        if (here && liveBlock(ev.botId)) { UI.addToBody(live.body, `<div class="m-text">${md(highlight(ev.text))}</div>`); UI.scrollDown(); }
        break;
      case 'turn_done':
        if (here) finishLive();
        break;
      case 'notice':
        if (here) {
          const body = ev.botId ? liveBlock(ev.botId) : null;
          if (body) UI.addToBody(body, `<div class="note">${esc(ev.text)}</div>`);
          else if ($('#msgs')) { const n = document.createElement('div'); n.className = 'note group-note'; n.textContent = ev.text; $('#msgs').appendChild(n); }
          UI.scrollDown();
        }
        break;
      case 'error':
        messages.push({ kind: 'error', botId: ev.botId, text: ev.text });
        if (here) {
          const body = ev.botId ? liveBlock(ev.botId) : null;
          if (body) UI.addToBody(body, `<div class="note err">${esc(ev.text)}</div>`);
          else if ($('#msgs')) { const n = document.createElement('div'); n.className = 'note err group-note'; n.textContent = ev.text; $('#msgs').appendChild(n); }
          UI.scrollDown();
        } else UI.toast(`${g.name}: ${ev.text}`, 'error');
        break;
      case 'approval':
        if (!here) UI.toast(`${b ? b.name : 'A bot'} in ${g.name} needs your OK.`);
        else if (liveBlock(ev.botId)) { UI.addToBody(live.body, UI.approvalHtml(ev)); UI.wireApproval(ev.requestId); UI.scrollDown(true); }
        break;
      case 'approval_done': {
        const card = document.querySelector(`.approve[data-req="${ev.requestId}"]`);
        if (card) card.outerHTML = `<div class="note">${ev.verdict === 'reject' ? 'You said no.' : 'You allowed it.'}</div>`;
        break;
      }
      case 'done':
        busy.delete(g.id);
        if (here) finishLive();
        live = null;
        if (ev.last) g.last = ev.last;
        g.updatedAt = Date.now();
        UI.renderSide(); setSendState();
        break;
      default: break;
    }
  }

  window.CrewGroups = { renderSide, create, open, onEvent, busy: () => [...busy] };
})();
