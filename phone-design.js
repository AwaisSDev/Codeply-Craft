// Design on the phone. The designs synced from Craft (supabase/designs.sql), a start
// box, and one design at a time: a live preview, its chat in short, and changes.
// With the PC online, Craft's agent on the PC does the designing (it has the taste
// skill, real references and its checks) and this follows along; with the PC off,
// the phone asks Haze for one self-contained HTML file. "Build it in Craft" asks
// the PC to turn a website or app design into a working project.
(() => {
  const P = window.CraftPhone;
  if (!P || !document.getElementById('design')) return;
  const $ = (id) => document.getElementById(id);
  const esc = P.esc;

  const KINDS = [
    { id: 'website', label: 'Website', hint: 'A landing page for a small coffee roaster, warm and editorial', icon: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/>' },
    { id: 'app', label: 'App', hint: 'A habit tracker: today, one habit, and the week', icon: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>' },
    { id: 'slides', label: 'Slides', hint: 'A 6-slide pitch deck for a student food delivery startup', icon: '<rect x="2.5" y="4.5" width="19" height="12.5" rx="2"/><path d="M12 17v3.5M8.5 20.5h7"/>' },
    { id: 'doc', label: 'Document', hint: 'A one-page resume for a junior product designer', icon: '<path d="M6 2.8h8L18.5 7.3v13.9H6z"/><path d="M14 2.8v4.5h4.5M9 12h6.5M9 15.5h6.5"/>' },
    { id: 'poster', label: 'Poster', hint: 'A poster for a jazz night this Friday at 9 on a rooftop', icon: '<rect x="5.5" y="2.5" width="13" height="19" rx="1.5"/><path d="M8.5 16h7M8.5 18.5h4.5"/>' },
    { id: 'social', label: 'Social post', hint: 'An Instagram post for our summer sale, 30% off', icon: '<rect x="3" y="3" width="18" height="18" rx="4.5"/><circle cx="12" cy="12" r="4"/>' },
    { id: 'logo', label: 'Logo', hint: 'A logo for Kite, a calm budgeting app', icon: '<path d="M12 2.8 20.5 12 12 21.2 3.5 12z"/>' },
  ];
  const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];
  const icon = (id, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${kindOf(id).icon}</svg>`;
  const SIZE = { website: [1440, 900], app: [1440, 1000], slides: [1280, 720], doc: [816, 1056], poster: [1080, 1350], social: [1080, 1080], logo: [1200, 800] };
  const STEP = {
    use_skill: 'Getting ready', design_direction: 'Choosing a direction', design_reference_search: 'Looking at references', view_images: 'Looking at references',
    image_search: 'Finding pictures', fetch_image: 'Finding pictures', write_file: 'Drawing it', edit_file: 'Refining it', apply_patch: 'Refining it',
    design_lint: 'Checking it', read_file: 'Reading the design',
  };
  const KEY = { list: 'craft-designs', html: (id) => `craft-design-html:${id}` };
  const D = { list: P.load(KEY.list, []), cur: null, kind: null, syncOk: null, polls: new Map(), sending: false, width: 'phone' };
  const saveList = () => P.save(KEY.list, D.list.slice(0, 80));
  const byId = (id) => D.list.find((d) => d.id === id) || null;
  const uid = () => (P.state.user && P.state.user.id) || null;
  const pcOn = () => !!(P.relay && P.relay.pcId);
  const ago = (t) => { const m = Math.round((Date.now() - (t || 0)) / 60000); if (m < 1) return 'now'; if (m < 60) return `${m}m`; const h = Math.round(m / 60); return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`; };

  // ─── the panel ────────────────────────────────────────────────────────────
  function openPanel() { $('design').classList.remove('hidden'); showList(); refresh(); }
  function closePanel() { $('design').classList.add('hidden'); D.cur = null; }
  $('drawerDesign').addEventListener('click', () => { P.closeDrawer(); openPanel(); });
  $('designBack').addEventListener('click', () => (D.cur ? showList() : closePanel()));

  // ─── synced designs ───────────────────────────────────────────────────────
  async function refresh() {
    if (!P.sb || !uid()) return;
    try {
      const { data, error } = await P.sb.from('designs').select('id, title, kind, summary, chat, origin, version, deleted, updated_at').order('updated_at', { ascending: false }).limit(100);
      if (error) throw error;
      D.syncOk = true;
      for (const row of data || []) {
        const d = byId(row.id);
        if (row.deleted) { if (d) D.list = D.list.filter((x) => x !== d); continue; }
        const at = Date.parse(row.updated_at) || Date.now();
        if (!d) D.list.push({ id: row.id, title: row.title, kind: row.kind, summary: row.summary, chat: row.chat || [], version: row.version, origin: row.origin, updatedAt: at });
        else if ((row.version || 0) >= (d.version || 0) && !d.running) Object.assign(d, { title: row.title, kind: row.kind, summary: row.summary, chat: row.chat || d.chat, version: row.version, updatedAt: at });
      }
      D.list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      saveList();
    } catch (e) {
      if (/does not exist|schema cache|could not find/i.test(String(e.message || ''))) D.syncOk = false;
    }
    if (!D.cur) renderList();
  }

  // The design's HTML: this phone's copy, the synced files (pictures through signed links), or the PC.
  async function htmlFor(d, { fresh = false } = {}) {
    const c = P.load(KEY.html(d.id), null);
    if (!fresh && c && c.html && (c.version || 0) >= (d.version || 0) && (!c.expires || c.expires > Date.now())) return c.html;
    let html = null; let expires = 0;
    if (D.syncOk && uid()) { html = await fromStorage(d).catch(() => null); if (html) expires = Date.now() + 50 * 60000; }
    if (!html && pcOn()) {
      try { const r = await P.relayRequest('GET', `/api/design/html?id=${encodeURIComponent(d.id)}`, null, 60000); html = r && r.html ? r.html : null; } catch {}
    }
    if (!html && c && c.html) return c.html;
    if (html) keepHtml(d, html, expires);
    return html;
  }
  function keepHtml(d, html, expires = 0) {
    const entry = { version: d.version || 0, html, expires };
    if (P.save(KEY.html(d.id), entry)) return;
    // Storage full: forget the copies of the oldest designs and try once more.
    for (const old of D.list.slice(20)) { try { localStorage.removeItem(KEY.html(old.id)); } catch {} }
    P.save(KEY.html(d.id), entry);
  }
  async function fromStorage(d) {
    const base = `${uid()}/${d.id}`;
    const { data, error } = await P.sb.storage.from('designs').download(`${base}/index.html`);
    if (error || !data) return null;
    let html = await data.text();
    const rels = [...new Set([...html.matchAll(/["'(]((?:\.\/)?assets\/[^"')?#\s]+)/g)].map((m) => m[1].replace(/^\.\//, '')))];
    if (rels.length) {
      const { data: signed } = await P.sb.storage.from('designs').createSignedUrls(rels.map((r) => `${base}/${r}`), 3600);
      const map = new Map((signed || []).filter((s) => s.signedUrl).map((s) => [s.path.slice(base.length + 1), s.signedUrl]));
      html = html.replace(/(["'(])((?:\.\/)?assets\/[^"')?#\s]+)/g, (m, q, rel) => { const u = map.get(rel.replace(/^\.\//, '')); return u ? q + u : m; });
    }
    return html;
  }
  async function pushDesign(d, html) {
    if (!D.syncOk || !uid()) return;
    const up = await P.sb.storage.from('designs').upload(`${uid()}/${d.id}/index.html`, new Blob([html], { type: 'text/html' }), { upsert: true, contentType: 'text/html' });
    if (up.error) return;
    await P.sb.from('designs').upsert({ id: d.id, user_id: uid(), title: d.title, kind: d.kind, summary: d.summary || '', chat: (d.chat || []).slice(-40), origin: 'phone', version: d.version, deleted: false, updated_at: new Date().toISOString() });
  }

  // ─── making and changing ──────────────────────────────────────────────────
  async function create(text, kind) {
    if (pcOn()) {
      try {
        const r = await P.relayRequest('POST', '/api/design/create', { text, kind }, 90000);
        const d = { id: r.id, title: text.slice(0, 60), kind: kind || 'website', chat: [{ role: 'user', text, at: Date.now() }], version: 0, origin: 'phone', updatedAt: Date.now(), running: true, onPc: true };
        D.list.unshift(d); saveList(); openDesign(d.id); poll(d.id);
        return;
      } catch (e) { if (!e.timeout) note(e.message, true); }
    }
    const d = { id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: text.slice(0, 60), kind: kind || 'website', chat: [], version: 0, origin: 'phone', updatedAt: Date.now() };
    D.list.unshift(d); saveList(); openDesign(d.id);
    await direct(d, text);
  }
  async function change(d, text) {
    if (pcOn() && (d.onPc || D.syncOk)) {
      try {
        d.chat = [...(d.chat || []), { role: 'user', text, at: Date.now() }];
        d.running = true; d.step = null; saveList(); renderOne();
        await P.relayRequest('POST', '/api/design/send', { id: d.id, text }, 90000);
        d.onPc = true; poll(d.id);
        return;
      } catch (e) { d.chat.pop(); d.running = false; if (!/gone|not on this PC/i.test(e.message)) { note(e.message, true); renderOne(); return; } }
    }
    await direct(d, text);
  }

  // The PC is working on it: follow along, then fetch the result.
  function poll(id) {
    clearInterval(D.polls.get(id));
    const t = setInterval(async () => {
      const d = byId(id);
      if (!d) { clearInterval(t); D.polls.delete(id); return; }
      let st;
      try { st = await P.relayRequest('GET', `/api/design/state?id=${encodeURIComponent(id)}`, null, 20000); } catch { return; }
      Object.assign(d, { title: st.title, kind: st.kind, summary: st.summary, chat: st.chat && st.chat.length ? st.chat : d.chat, step: st.lastStep, running: st.running, updatedAt: Date.now() });
      if (!st.running) {
        clearInterval(t); D.polls.delete(id);
        d.version = Math.max(d.version || 0, st.version || 0) || 1;
        await htmlFor(d, { fresh: true });
      }
      saveList();
      if (D.cur === id) renderOne(!st.running);
    }, 3000);
    D.polls.set(id, t);
  }

  // The PC is off: Haze writes the design as one self-contained HTML file.
  const SYSTEM = `You are Codeply Design. You make one design as one self-contained HTML file and nothing else: no backend, nothing that saves or sends.
Kinds and formats: website = a full responsive page with <meta name="viewport" content="width=device-width, initial-scale=1">; app = the flow's screens side by side, each a 390x844 frame (<section class="screen">) on a neutral canvas; slides = 16:9, each slide a <section class="slide"> of 1280x720, stacked; doc = pages of 816x1056 (<section class="page">) that also print; poster = one 1080x1350 <section class="poster">; social = 1080x1080 posts; logo = the mark as inline SVG on light and dark grounds with the wordmark.
Taste: one idea per design. Type at few sizes far apart, at most two families, from Google Fonts with display=swap. Planned colour, not the category default: no purple-blue gradients, no gradient text, no glassmorphism, no glowing buttons, no three identical icon cards, no emoji as icons, not everything centred. Real words, never lorem ipsum; no stock phrases like "Unlock", "Seamless", "Elevate". Pictures: only real photo URLs you are sure exist (https://picsum.photos/id/<n>/1600/1000 is fine) or none; shapes and type can carry it.
Reply with the whole file in one \`\`\`html block, then one or two short lines on the idea, the type and the colour.`;
  const fence = '```';
  async function direct(d, text) {
    const current = d.version ? await htmlFor(d) : null;
    d.chat = [...(d.chat || []), { role: 'user', text, at: Date.now() }];
    d.running = true; d.step = 'write_file'; saveList(); renderOne();
    let error = null;
    try {
      const token = await P.accessToken();
      const ask = current
        ? `This is the current ${kindOf(d.kind).label.toLowerCase()} design:\n${fence}html\n${current.slice(0, 120000)}\n${fence}\n\nChange it: ${text}\nReply with the whole updated file.`
        : `Make a ${kindOf(d.kind).label.toLowerCase()} design: ${text}`;
      const res = await fetch(P.AI_PROXY_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...P.deviceHeader() },
        body: JSON.stringify({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: ask }], opts: { maxTokens: 16000 } }),
      });
      const data = await res.json().catch(() => ({}));
      const reply = res.ok && data.success && data.data && data.data.choices && data.data.choices[0] ? String(data.data.choices[0].message.content || '') : '';
      if (!reply) throw new Error(data.error || `Codeply could not design that (${res.status}).`);
      const m = reply.match(/```html\s*([\s\S]*?)```/i) || reply.match(/(<!doctype html[\s\S]*<\/html>)/i);
      const html = m ? m[1].trim() : '';
      if (!/<html|<body|<section|<svg/i.test(html)) throw new Error('The reply had no design in it. Try again.');
      const after = reply.replace(/```html[\s\S]*?```/i, '').trim().slice(0, 600);
      const title = (html.match(/<title>([^<]{2,80})<\/title>/i) || [])[1];
      if (title && d.version === 0) d.title = title.trim();
      d.version = (d.version || 0) + 1; d.summary = after.split('\n')[0].slice(0, 200);
      keepHtml(d, html);
      d.chat.push({ role: 'assistant', text: after || 'Done.', at: Date.now() });
      pushDesign(d, html).catch(() => {});
    } catch (e) {
      error = /fetch|network/i.test(e.message) ? "Can't reach Codeply. Check your internet connection." : e.message;
      d.chat.push({ role: 'error', text: error, at: Date.now() });
    }
    d.running = false; d.step = null; d.updatedAt = Date.now();
    saveList();
    if (D.cur === d.id) renderOne(true);
  }

  async function build(d) {
    if (!pcOn()) { note('Build it in Craft needs your PC on: Craft builds it there.', true); return; }
    note('Setting it up in Craft on your PC…');
    try {
      const html = D.syncOk ? null : await htmlFor(d);
      const r = await P.relayRequest('POST', '/api/design/build', { id: d.id, ...(html ? { html, title: d.title, kind: d.kind } : {}) }, 120000);
      note(r && r.error ? r.error : 'Craft is building it on your PC. The chat is in your chat list.', !!(r && r.error));
    } catch (e) { note(e.message, true); }
  }

  // ─── views ────────────────────────────────────────────────────────────────
  const body = $('designBody');
  const input = $('designInput');
  let noteTimer = null;
  function note(text, bad) {
    const n = $('designNote'); n.textContent = text || ''; n.classList.toggle('bad', !!bad);
    clearTimeout(noteTimer); if (text && !bad) noteTimer = setTimeout(() => { n.textContent = ''; }, 6000);
  }
  function renderKinds() {
    const box = $('designKinds');
    box.hidden = !!D.cur;
    box.innerHTML = KINDS.map((k) => `<button type="button" class="dg-kind${D.kind === k.id ? ' on' : ''}" data-k="${k.id}">${icon(k.id, 17)}${k.label}</button>`).join('');
    box.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => { D.kind = D.kind === b.dataset.k ? null : b.dataset.k; renderKinds(); input.focus(); }));
    input.placeholder = D.cur ? 'Ask for changes' : (D.kind ? kindOf(D.kind).hint : 'What should we design?');
  }
  function showList() { D.cur = null; $('designTitle').textContent = 'Design'; renderKinds(); renderList(); }
  function renderList() {
    if (D.cur) return;
    const items = D.list.map((d) => `<button type="button" class="dg-item" data-id="${esc(d.id)}"><span class="dg-ico">${icon(d.kind)}</span><span class="dg-t"><b>${esc(d.title)}</b><small>${esc(kindOf(d.kind).label)} · ${esc(ago(d.updatedAt))}</small></span>${d.running ? '<span class="spinner"></span>' : ''}</button>`).join('');
    body.innerHTML = `
      <div class="dg-hero"><h1>What should we design?</h1><p>Websites, app screens, slides, documents, posters, posts and logos. Designs only: when a website or app should really work, build it in Craft.</p></div>
      ${D.syncOk === false ? '<p class="dg-hint">Designs from your PC show up here after a one-time setup on the server.</p>' : ''}
      ${items ? `<div class="dg-label">Your designs</div><div class="dg-list">${items}</div>` : ''}`;
    body.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => openDesign(b.dataset.id)));
  }
  function openDesign(id) {
    const d = byId(id);
    if (!d) return;
    D.cur = id;
    D.width = d.kind === 'website' ? 'phone' : 'fit';
    renderKinds(); renderOne(true);
    if (d.running && d.onPc && !D.polls.has(id)) poll(id);
  }
  // The design at its own width, scaled to the screen. A website can be seen at phone width, as it really is.
  async function renderOne(reload) {
    const d = byId(D.cur);
    if (!d) return showList();
    $('designTitle').textContent = d.title;
    const old = body.querySelector('.dg-stage');
    const steps = d.running ? `<div class="dg-status"><span class="spinner"></span><span class="shine">${esc(STEP[d.step] || (d.onPc ? 'Designing on your PC' : 'Designing'))}</span></div>` : '';
    const chat = (d.chat || []).map((m) => m.role === 'user' ? `<div class="msg user">${esc(m.text)}</div>` : m.role === 'error' ? `<div class="dg-err">${esc(m.text)}</div>` : `<div class="dg-reply">${P.md ? P.md(m.text) : esc(m.text)}</div>`).join('');
    const canBuild = d.kind === 'website' || d.kind === 'app';
    const html = `
      <div class="dg-stage" id="dgStage">${old && !reload ? old.innerHTML : '<div class="dg-wait"><span class="spinner"></span></div>'}</div>
      <div class="dg-actions">
        ${d.kind === 'website' ? `<div class="dg-seg"><button type="button" data-w="phone" class="${D.width === 'phone' ? 'on' : ''}">Phone</button><button type="button" data-w="fit" class="${D.width === 'fit' ? 'on' : ''}">Desktop</button></div>` : `<span class="dg-kindtag">${icon(d.kind, 16)}${esc(kindOf(d.kind).label)}</span>`}
        ${canBuild ? '<button type="button" class="dg-build" id="dgBuild"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 4-4 16M7 8l-4 4 4 4M17 8l4 4-4 4"/></svg>Build it in Craft</button>' : ''}
      </div>
      <div class="dg-chat">${chat}${steps}</div>`;
    body.innerHTML = html;
    body.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => { D.width = b.dataset.w; renderOne(true); }));
    const bb = $('dgBuild'); if (bb) bb.addEventListener('click', () => build(d));
    if (reload || !old) await paint(d);
    body.scrollTop = 0;
  }
  async function paint(d) {
    const stage = $('dgStage');
    if (!stage) return;
    if (!d.version && d.running) { stage.innerHTML = '<div class="dg-wait"><span class="spinner"></span><span class="shine">Designing</span></div>'; return; }
    const html = await htmlFor(d);
    if (D.cur !== d.id || !$('dgStage')) return;
    if (!html) { stage.innerHTML = `<div class="dg-wait">${pcOn() || D.syncOk ? 'Nothing to show yet.' : 'This design is on your PC. Turn it on to see it here.'}</div>`; return; }
    const [w, h] = SIZE[d.kind] || SIZE.website;
    const avail = stage.clientWidth || (window.innerWidth - 36);
    const designW = d.kind === 'website' && D.width === 'phone' ? 390 : w;
    const whole = ['poster', 'social', 'logo'].includes(d.kind);
    const scale = Math.min(1, avail / designW);
    const frameH = whole ? h : Math.round(Math.min(window.innerHeight * 0.62, 640) / scale);
    stage.innerHTML = `<div class="dg-frame" style="width:${Math.round(designW * scale)}px;height:${Math.round(frameH * scale)}px"><iframe sandbox="allow-scripts" title="${esc(d.title)}" style="width:${designW}px;height:${frameH}px;transform:scale(${scale})"></iframe></div>`;
    stage.querySelector('iframe').srcdoc = html;
  }

  // ─── the composer ─────────────────────────────────────────────────────────
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('designComposer').requestSubmit(); } });
  $('designComposer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || D.sending) return;
    const d = D.cur ? byId(D.cur) : null;
    if (d && d.running) { note('Wait for this change to finish.', true); return; }
    D.sending = true; input.value = ''; autosize(); note('');
    try { if (d) await change(d, text); else await create(text, D.kind); } finally { D.sending = false; D.kind = null; }
  });
  window.addEventListener('craft:pc-online', () => { if (!$('design').classList.contains('hidden')) refresh(); });
  window.addEventListener('resize', () => { const d = D.cur && byId(D.cur); if (d) paint(d); });
})();
