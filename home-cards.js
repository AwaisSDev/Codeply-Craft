// The cards under the home composer: a year of activity, recent chats, usage,
// pull requests and this month next to last month. They read what Codeply
// already has (your usage from the account, the chat list, and the GitHub CLI
// for pull requests) and draw again each time Home is shown. Turned on and off
// in Settings > Appearance > Home cards. Over a background they are frosted
// glass (wallpaper.css); without one they are plain cards.
(function () {
  'use strict';
  const KEY = 'craft-home-cards';
  const api = window.craft || null;
  const DAY = 86400000;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ic = (n) => (window.icon ? window.icon(n, 'ico-sm') : '');
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const short = (n) => (window.CraftUsage && window.CraftUsage.short ? window.CraftUsage.short(n) : String(Math.round(n || 0)));

  function enabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } }
  function setEnabled(on) {
    try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, 'off'); } catch {}
    render();
  }

  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    const d = Math.round(s / 86400);
    if (d === 1) return 'yesterday';
    if (d < 30) return d + ' days ago';
    return d < 60 ? 'last month' : Math.round(d / 30) + ' months ago';
  }

  let usage = null;   // { days: [{ d, t }], tokens, calls } from the account
  let usageAt = 0;
  let prs = null;     // { prs: [...] } or { error }
  async function loadUsage() {
    if (usage && Date.now() - usageAt < 5 * 60000) return usage;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const u = api && api.getUsage ? await api.getUsage(tz) : null;
      usage = u && !u.error ? u : { days: [] };
    } catch { usage = { days: [] }; }
    usageAt = Date.now();
    return usage;
  }
  async function loadPrs() {
    try { prs = api && api.homePrs ? await api.homePrs() : { error: 'none' }; } catch { prs = { error: 'gh' }; }
    return prs;
  }

  function sessions() {
    try { return (typeof state !== 'undefined' && state.sessions) || []; } catch { return []; }
  }

  // Activity: 53 weeks x 7 days, each square the day's tokens (or chats when
  // there is no usage data), in five steps of the accent color.
  function activityCard() {
    const byDay = {};
    let source = 'tokens';
    for (const r of (usage && usage.days) || []) byDay[r.d] = (byDay[r.d] || 0) + (Number(r.t) || 0);
    if (!Object.keys(byDay).length) {
      source = 'chats';
      for (const s of sessions()) if (s.updatedAt) { const k = dayKey(new Date(s.updatedAt)); byDay[k] = (byDay[k] || 0) + 1; }
    }
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end.getTime() - (52 * 7 + end.getDay()) * DAY);
    const vals = Object.values(byDay).filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 1;
    const steps = [q(0.25), q(0.5), q(0.75), q(0.92)];
    const level = (v) => (!v ? 0 : v <= steps[0] ? 1 : v <= steps[1] ? 2 : v <= steps[2] ? 3 : 4);
    let cells = '', active = 0, total = 0;
    for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
      const d = new Date(t);
      const v = byDay[dayKey(d)] || 0;
      if (v) { active++; total += v; }
      const what = source === 'tokens' ? `${short(v)} tokens` : `${v} chat${v === 1 ? '' : 's'}`;
      cells += `<i class="hc-sq l${level(v)}" title="${esc(d.toDateString())}: ${esc(what)}"></i>`;
    }
    const foot = source === 'tokens' ? `${active} active days · ${short(total)} tokens` : `${active} active days · ${sessions().length} chats`;
    return card('hc-activity', 'calendar', 'Activity', `<div class="hc-heat">${cells}</div>`,
      `<span>${esc(foot)}</span><span>Last 12 months</span>`);
  }

  function recentCard() {
    const list = sessions().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const rows = list.slice(0, 3).map((s) =>
      `<button type="button" class="hc-row" data-hc-chat="${esc(s.id)}"><span class="hc-row-t"><span>${esc(s.title || 'New chat')}</span></span><span class="hc-row-s">${esc(ago(s.updatedAt || Date.now()))}</span></button>`).join('');
    return card('hc-recent', 'clock', 'Recent chats', rows || '<div class="hc-empty">Your chats will show here.</div>',
      list.length > 3 ? `<button type="button" class="hc-more" data-hc-search>${list.length - 3} more</button>` : '');
  }

  function monthTotals() {
    const now = new Date();
    const m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const m1 = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    let chats = 0, chatsPrev = 0, tok = 0, tokPrev = 0;
    for (const s of sessions()) { const t = s.updatedAt || 0; if (t >= m0) chats++; else if (t >= m1) chatsPrev++; }
    for (const r of (usage && usage.days) || []) {
      const t = new Date(r.d + 'T00:00:00').getTime();
      if (t >= m0) tok += Number(r.t) || 0; else if (t >= m1) tokPrev += Number(r.t) || 0;
    }
    return { chats, chatsPrev, tok, tokPrev };
  }
  // Only a rise is shown (a small green +); a slower month just shows its number.
  const delta = (a, b) => (a > b ? `<span class="hc-delta up">+${short(a - b)}</span>` : '');

  function usageCard() {
    const lifetime = usage && usage.tokens ? short(usage.tokens) : '0';
    return card('hc-usage', 'chart', 'Total',
      `<div class="hc-total"><span class="hc-big">${esc(lifetime)}</span><span class="hc-unit">tokens</span></div>`,
      `<button type="button" class="hc-pill" data-hc-usage>Open usage${ic('arrow-right')}</button>`);
  }

  // This month: chats and tokens side by side, over a small bar for each day so far.
  function monthCard() {
    const m = monthTotals();
    const now = new Date();
    const byDay = {};
    for (const r of (usage && usage.days) || []) byDay[r.d] = (byDay[r.d] || 0) + (Number(r.t) || 0);
    // the whole month, so the chart keeps its shape: days so far as bars, the rest as faint stubs
    const inMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const days = [];
    for (let d = 1; d <= inMonth; d++) days.push(byDay[dayKey(new Date(now.getFullYear(), now.getMonth(), d))] || 0);
    const today = now.getDate();
    const peak = Math.max(1, ...days.slice(0, today));
    const mon = now.toLocaleString(undefined, { month: 'short' });
    const bars = days.map((v, i) => {
      if (i + 1 > today) return '<i class="hc-bar future"></i>';
      const h = v ? Math.max(14, Math.round((v / peak) * 100)) : 8;
      return `<i class="hc-bar${i + 1 === today ? ' today' : ''}${v ? '' : ' empty'}" style="height:${h}%" title="${mon} ${i + 1}: ${short(v)} tokens"></i>`;
    }).join('');
    return card('hc-month', 'calendar', 'This month',
      `<div class="hc-stats">` +
        `<div class="hc-stat"><div class="hc-num a">${m.chats}${delta(m.chats, m.chatsPrev)}</div><div class="hc-sub">chats</div></div>` +
        `<div class="hc-stat"><div class="hc-num b">${short(m.tok)}${delta(m.tok, m.tokPrev)}</div><div class="hc-sub">tokens</div></div>` +
      `</div><div class="hc-bars" aria-hidden="true">${bars}</div>`, '');
  }

  function prsCard() {
    let body;
    if (!prs) body = '<div class="hc-empty">Looking for your pull requests...</div>';
    else if (prs.error) body = '<div class="hc-empty">Install the GitHub CLI and sign in with gh auth login to see your pull requests here.</div>';
    else if (!prs.prs.length) body = '<div class="hc-empty">No pull requests yet.</div>';
    else body = prs.prs.slice(0, 3).map((p) =>
      `<button type="button" class="hc-row" data-hc-pr="${esc(p.url)}" title="${esc((p.repository && p.repository.nameWithOwner) || '')}"><span class="hc-row-t"><span class="hc-pr ${esc(String(p.state || '').toLowerCase())}">${ic('branch')}</span><span>${esc(p.title)}</span></span><span class="hc-row-s">${esc(ago(new Date(p.updatedAt).getTime()))}</span></button>`).join('');
    return card('hc-prs', 'branch', 'Pull requests', body, '');
  }

  function card(cls, icon, title, body, foot) {
    return `<section class="hc-card ${cls}"><div class="hc-head">${ic(icon)}<span>${esc(title)}</span></div><div class="hc-body">${body}</div>${foot ? `<div class="hc-foot">${foot}</div>` : ''}</section>`;
  }

  let root = null;
  function ensureRoot() {
    if (root) return root;
    const home = document.getElementById('viewHome');
    const wrap = home && home.querySelector('.home-composer');
    if (!wrap) return null;
    root = document.createElement('div');
    root.className = 'home-cards';
    wrap.after(root);
    root.addEventListener('click', (e) => {
      const c = e.target.closest('[data-hc-chat]');
      if (c && typeof openSession === 'function') { openSession(c.dataset.hcChat); return; }
      const p = e.target.closest('[data-hc-pr]');
      if (p && api && api.openExternal) { api.openExternal(p.dataset.hcPr); return; }
      if (e.target.closest('[data-hc-usage]') && window.CraftUsage) {
        const email = (typeof state !== 'undefined' && state.user && state.user.email) || '';
        const nameEl = document.getElementById('userName');
        window.CraftUsage.open({ name: nameEl ? nameEl.textContent : '', email });
        return;
      }
      if (e.target.closest('[data-hc-search]')) { const b = document.getElementById('sbSearchBtn'); if (b) b.click(); }
    });
    return root;
  }

  function draw() {
    if (!root) return;
    root.innerHTML = `<div class="hc-grid">${activityCard()}${recentCard()}${usageCard()}${prsCard()}${monthCard()}</div>`;
    // the question moved with the cards: check what is behind it again
    if (window.CraftWallpaper) requestAnimationFrame(() => window.CraftWallpaper.retone());
  }

  let busy = false;
  async function render() {
    const home = document.getElementById('viewHome');
    const on = enabled();
    if (home) home.classList.toggle('has-cards', on);
    if (!on) { if (root) root.innerHTML = ''; return; }
    if (!ensureRoot()) return;
    draw(); // right away with what is known, then again as data arrives
    if (busy) return;
    busy = true;
    try {
      await Promise.all([loadUsage().then(draw), loadPrs().then(draw)]);
    } finally { busy = false; }
  }

  window.CraftHomeCards = { render, enabled, setEnabled };
  // Home may already be showing (app.js ran first).
  const h = document.getElementById('viewHome');
  if (h && !h.classList.contains('hidden')) render();
})();
