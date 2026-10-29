// The Usage page (account menu → Usage): the person's own token use, laid out
// like Codex's profile. Avatar and name, a row of totals, and a year of token
// activity (weekly stacks or a daily grid) with a tooltip per square; click a
// week or a day for its tokens per model.
// Data: api.getUsage(tz) → my_usage() in the database, every app and model.
(function () {
  const WEEKS = 52;
  const DAY = 86400000;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** 4.3bn, 392.8m, 12.5k, 940 */
  function short(n) {
    n = Number(n) || 0;
    const f = (x) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ''));
    if (n >= 1e9) return f(n / 1e9) + 'bn';
    if (n >= 1e6) return f(n / 1e6) + 'm';
    if (n >= 1e3) return f(n / 1e3) + 'k';
    return String(Math.round(n));
  }
  // Local calendar days as "YYYY-MM-DD" (the server groups by the same time zone)
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const nice = (d) => `${d.getDate()} ${LONG[d.getMonth()]} ${d.getFullYear()}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function streaks(byDay) {
    const days = Object.keys(byDay).filter((k) => byDay[k] > 0).sort();
    let longest = 0; let run = 0; let prev = null;
    for (const k of days) {
      const d = new Date(k + 'T00:00:00');
      run = prev && Math.round((d - prev) / DAY) === 1 ? run + 1 : 1;
      longest = Math.max(longest, run); prev = d;
    }
    // current: ends today, or yesterday when today has nothing yet
    let cur = 0; let d = startOfDay(new Date());
    if (!byDay[key(d)]) d = addDays(d, -1);
    while (byDay[key(d)] > 0) { cur++; d = addDays(d, -1); }
    return { current: cur, longest };
  }

  function weeks(byDay) {
    const today = startOfDay(new Date());
    const thisWeek = addDays(today, -today.getDay()); // weeks start on Sunday
    const out = [];
    for (let w = WEEKS - 1; w >= 0; w--) {
      const start = addDays(thisWeek, -7 * w);
      let t = 0;
      const cells = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(start, i);
        const v = d > today ? null : (byDay[key(d)] || 0);
        cells.push({ d, t: v });
        t += v || 0;
      }
      out.push({ start, t, cells });
    }
    return out;
  }

  function monthLabels(ws) {
    // a label under the first week whose Sunday falls in a new month
    let last = -1;
    const out = ws.map((w) => {
      const m = w.start.getMonth();
      if (m === last) return '';
      last = m;
      return MONTHS[m];
    });
    // a cut-off first month whose label would run into the next one is left out
    const next = out.findIndex((l, i) => i > 0 && l);
    if (next > -1 && next < 3) out[0] = '';
    return out;
  }

  function chart(ws, mode, sel) {
    const cols = ws.map((w, i) => {
      if (mode === 'weekly') {
        const max = Math.max(1, ...ws.map((x) => x.t));
        const lit = w.t > 0 ? Math.max(1, Math.round((w.t / max) * 7)) : 0;
        const tip = `${short(w.t)} tokens on week of ${nice(w.start)}`;
        return `<div class="us-col${sel === 'w' + i ? ' sel' : ''}" data-tip="${esc(tip)}" data-sel="w${i}">${Array.from({ length: 7 }, (_, r) => `<i class="${6 - r < lit ? 'on' : ''}"></i>`).join('')}</div>`;
      }
      const max = Math.max(1, ...ws.flatMap((x) => x.cells.map((c) => c.t || 0)));
      return `<div class="us-col daily">${w.cells.map((c) => {
        if (c.t === null) return '<i class="future"></i>';
        const lv = c.t > 0 ? Math.min(4, 1 + Math.floor((c.t / max) * 4)) : 0;
        const k = 'd' + key(c.d);
        return `<i class="${lv ? 'l' + lv : ''}${sel === k ? ' sel' : ''}" data-tip="${esc(`${short(c.t)} tokens on ${nice(c.d)}`)}" data-sel="${k}"></i>`;
      }).join('')}</div>`;
    }).join('');
    const labels = monthLabels(ws).map((m) => `<span>${m}</span>`).join('');
    return `<div class="us-grid">${cols}</div><div class="us-months">${labels}</div>`;
  }

  let root = null; let data = null; let mode = 'weekly'; let sel = null;

  const modelName = (m) => String(m).replace(/^[\w.-]+\//, ''); // "openai/gpt-oss-120b" → "gpt-oss-120b"
  /** The tokens per model for one week ("w12") or one day ("d2026-10-11"). */
  function breakdown(ws, rows) {
    if (!sel) return '';
    let title; let dayKeys;
    if (sel[0] === 'w') {
      const w = ws[Number(sel.slice(1))];
      if (!w) return '';
      title = `Week of ${nice(w.start)}`;
      dayKeys = w.cells.map((c) => key(c.d));
    } else {
      const d = new Date(sel.slice(1) + 'T00:00:00');
      title = d.toLocaleDateString(undefined, { weekday: 'long' }) + ', ' + nice(d);
      dayKeys = [sel.slice(1)];
    }
    const per = {}; let t = 0; let n = 0;
    for (const k of dayKeys) {
      const r = rows[k];
      if (!r) continue;
      t += Number(r.t) || 0; n += Number(r.n) || 0;
      for (const [m, v] of Object.entries(r.m || {})) {
        const p = per[m] || (per[m] = [0, 0]);
        p[0] += Number(v[0]) || 0; p[1] += Number(v[1]) || 0;
      }
    }
    const list = Object.entries(per).sort((a, b) => b[1][0] - a[1][0]);
    const top = list.length ? Math.max(1, list[0][1][0]) : 1;
    const body = list.length
      ? list.map(([m, [mt, mn]]) => `
        <div class="us-model">
          <span class="us-model-name" title="${esc(m)}">${esc(modelName(m))}</span>
          <span class="us-model-bar"><i style="width:${Math.max(2, (mt / top) * 100).toFixed(1)}%"></i></span>
          <span class="us-model-num">${short(mt)}</span>
          <span class="us-model-pct">${t ? Math.round((mt / t) * 100) : 0}%</span>
          <span class="us-model-calls">${plural(mn, 'call')}</span>
        </div>`).join('')
      : '<div class="us-model-empty">Nothing used on this ' + (sel[0] === 'w' ? 'week' : 'day') + '.</div>';
    return `
      <div class="us-detail">
        <div class="us-detail-head">
          <div><b>${esc(title)}</b><span>${short(t)} tokens · ${plural(n, 'call')}</span></div>
          <button class="us-detail-x" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
        ${body}
      </div>`;
  }
  function close() {
    if (!root) return;
    root.classList.remove('open');
    const r = root; root = null;
    setTimeout(() => r.remove(), 160);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function render() {
    const body = root.querySelector('.us-body');
    if (!data) { body.innerHTML = '<div class="us-note">Loading your usage…</div>'; return; }
    if (data.error) { body.innerHTML = `<div class="us-note">${esc(data.error)}</div>`; return; }
    const byDay = {}; const rows = {};
    for (const r of data.days || []) { byDay[r.d] = Number(r.t) || 0; rows[r.d] = r; }
    const peak = (data.days || []).reduce((a, r) => (Number(r.t) > (a ? Number(a.t) : -1) ? r : a), null);
    const s = streaks(byDay);
    const ws = weeks(byDay);
    const stats = [
      [short(data.tokens), 'Lifetime tokens'],
      [peak ? short(peak.t) : '0', 'Peak day'],
      [esc(data.favorite || 'None yet'), 'Favorite model'],
      [plural(s.current, 'day'), 'Current streak'],
      [plural(s.longest, 'day'), 'Longest streak'],
    ];
    body.innerHTML = `
      <div class="us-stats">${stats.map(([v, l]) => `<div class="us-stat"><b title="${v}">${v}</b><span>${l}</span></div>`).join('')}</div>
      <div class="us-head">
        <h3>Token activity</h3>
        <div class="us-seg" role="group" aria-label="Group by">
          <button data-mode="daily" class="${mode === 'daily' ? 'on' : ''}">Daily</button>
          <button data-mode="weekly" class="${mode === 'weekly' ? 'on' : ''}">Weekly</button>
        </div>
      </div>
      <div class="us-chart">${chart(ws, mode, sel)}<div class="us-tip" hidden></div></div>
      ${breakdown(ws, rows)}
      <p class="us-foot">${short(data.calls)} model calls across the app, your agents, the CLI, cloud runs and your phone. Counts only, never what you wrote.</p>`;
    body.querySelectorAll('.us-seg button').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; sel = null; render(); }));
    const x = body.querySelector('.us-detail-x');
    if (x) x.addEventListener('click', () => { sel = null; render(); });
    const box = body.querySelector('.us-chart');
    const tip = box.querySelector('.us-tip');
    box.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.dataset.tip;
      tip.hidden = false;
      const br = box.getBoundingClientRect(); const r = t.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2 - br.left, tip.offsetWidth / 2), br.width - tip.offsetWidth / 2);
      tip.style.left = x + 'px';
      tip.style.top = (r.top - br.top - 8) + 'px';
    });
    box.addEventListener('mouseleave', () => { tip.hidden = true; });
    // click a week (or a day) for its tokens per model; again to close
    box.addEventListener('click', (e) => {
      const t = e.target.closest('[data-sel]');
      if (!t) return;
      sel = sel === t.dataset.sel ? null : t.dataset.sel;
      render();
    });
  }

  async function open({ name = '', email = '' } = {}) {
    if (root) return;
    const who = name && name !== 'Not signed in' ? name : (email.split('@')[0] || 'You');
    const initials = who.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'C';
    const handle = (email.split('@')[0] || who).toLowerCase();
    root = document.createElement('div');
    root.className = 'us-backdrop';
    root.innerHTML = `
      <div class="us-page" role="dialog" aria-label="Usage">
        <button class="us-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        <div class="us-avatar">${esc(initials)}</div>
        <h2 class="us-name">${esc(who)}</h2>
        <div class="us-handle">@${esc(handle)} <span>·</span> <em>Codeply</em></div>
        <div class="us-body"></div>
      </div>`;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.querySelector('.us-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => root && root.classList.add('open'));
    data = null; sel = null; render();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try { data = window.craft ? await window.craft.getUsage(tz) : { error: 'Usage needs the Codeply app.' }; } catch (e) { data = { error: e.message || 'Could not load your usage.' }; }
    if (root) render();
  }

  window.CraftUsage = { open, close, short };
})();
