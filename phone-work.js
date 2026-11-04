// Work that doesn't need the PC: scheduled cloud tasks, the calendar, and live checks.
//
//   Schedules  A scheduled task is a GitHub Actions workflow in the project's repo
//              (.github/workflows/craft-loop-<id>.yml) with a cron and the task's prompt. GitHub
//              runs it on its own machines with the same runner as Codeply Cloud, so it works with
//              the PC off and the phone closed. Each run reports to tasks/loop-<id>-<runId>.json on
//              craft-sessions, which is what the phone shows. Nothing runs on Codeply's servers.
//   Calendar   Google Calendar, read and written straight from the phone with the Google sign-in
//              connected in Codeply (the account's connections). The token is refreshed here.
//   Checks     GitHub (the default branch's checks and statuses, open pull requests, Actions runs),
//              Vercel (the deployments of the project linked to the repo) and Supabase (projects and
//              their health, through the integration-status function because Supabase's API does
//              not answer browsers). Every line comes from one of those APIs and says when it was read;
//              anything that couldn't be read says why instead of guessing.
//
// Chat uses statusNote() to answer "is CI passing?"-style questions from the same reads (phone.js).
(() => {
  'use strict';
  const P = () => window.CraftPhone;
  if (!window.CraftPhone) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  const svg = (d, w = 20) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    back: svg('<path d="M15 5l-7 7 7 7"/>', 22),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 22),
    again: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4"/>', 20),
    cal: svg('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>', 22),
    checks: svg('<path d="M4 7l2 2 3.5-3.5M4 14l2 2 3.5-3.5M13 7.5h7M13 14.5h7"/>', 22),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 18),
    // Specialists: Wisp's face, a solid soft pentagon (white in dark mode) with eyes in the background colour.
    bots: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.32 5.45Q12.00 3.50 14.68 5.45L18.26 8.05Q20.94 10.00 19.92 13.15L18.55 17.35Q17.53 20.50 14.21 20.50L9.79 20.50Q6.47 20.50 5.45 17.35L4.08 13.15Q3.06 10.00 5.74 8.05Z"/><ellipse cx="9.75" cy="12" rx="1.4" ry="2.15" style="fill:var(--bg,#000)" stroke="none"/><ellipse cx="14.25" cy="12" rx="1.4" ry="2.15" style="fill:var(--bg,#000)" stroke="none"/></svg>',
  };
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const stamp = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const dayName = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : dayName(t); };
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const toast = (msg) => { const t = document.createElement('div'); t.className = 'wk-toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200); };

  // ─── Shared UI: full-screen panels and bottom sheets ────────────────────────
  function panel(id, title, right = '') {
    let s = $(id);
    if (s) return s;
    s = document.createElement('section');
    s.className = 'panel hidden'; s.id = id; s.setAttribute('role', 'dialog'); s.setAttribute('aria-modal', 'true'); s.setAttribute('aria-label', title);
    s.innerHTML = `<header class="top"><button class="icon-btn" data-wk-back aria-label="Back">${ICON.back}</button><div class="top-title">${esc(title)}</div>${right || '<span class="icon-btn" aria-hidden="true"></span>'}</header><div class="panel-body"></div>`;
    document.body.appendChild(s);
    s.querySelector('[data-wk-back]').addEventListener('click', () => s.classList.add('hidden'));
    return s;
  }
  const show = (el) => { el.parentNode.appendChild(el); el.classList.remove('hidden'); };
  function sheet(html, { onClose } = {}) {
    const s = document.createElement('div');
    s.className = 'wk-sheet';
    s.innerHTML = `<div class="wk-sheet-bg"></div><div class="wk-sheet-card"><div class="wk-handle"></div>${html}</div>`;
    document.body.appendChild(s);
    const close = () => { s.remove(); if (onClose) onClose(); };
    s.querySelector('.wk-sheet-bg').addEventListener('click', close);
    s.addEventListener('click', (e) => { if (e.target.closest('[data-wk-close]')) close(); });
    return { el: s, close, q: (sel) => s.querySelector(sel) };
  }
  const dot = (state) => `<i class="wk-dot ${state}"></i>`;
  const LABEL = { pass: 'Passing', fail: 'Failing', pending: 'Running', none: 'No checks', skip: 'Skipped', cancel: 'Cancelled', off: 'Not connected', err: 'Couldn’t check' };

  // ─── Projects that can run in the cloud (the repos Codeply Cloud is set up on) ─
  function envs() {
    const st = P().state || {};
    const out = []; const seen = new Set();
    const first = P().cloudEnvForBots && P().cloudEnvForBots();
    for (const e of [first, ...Object.values(st.envs || {})]) if (e && e.repo && !seen.has(e.repo)) { seen.add(e.repo); out.push(e); }
    return out;
  }
  function currentRepo() {
    const st = P().state || {};
    const chat = (st.chats || []).find((c) => c.id === st.current);
    const env = chat && chat.project && P().envFor ? P().envFor(chat.project) : null;
    return (env && env.repo) || (envs()[0] && envs()[0].repo) || '';
  }
  const gh = async (route, opts) => (await P().gh('GET', route, null, opts)).json;

  // ═══ SCHEDULES ══════════════════════════════════════════════════════════════
  const PREFIX = 'craft-loop-';
  const SKEY = 'craft-phone-schedules';
  const sched = { list: load(SKEY, []), at: 0, loading: false, error: '' };
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const engine = () => { const m = String(P().CLOUD_WORKFLOW || '').match(/CRAFT_ENGINE:-([^}"]+)\}/); return m ? m[1] : 'codeply-cli@0.5'; };
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const unb64 = (s) => decodeURIComponent(escape(atob(String(s || '').replace(/\s/g, ''))));

  /** GitHub cron (UTC) for a schedule in local time. s: { every, time 'HH:MM', day 0-6, date 'YYYY-MM-DD', minute } */
  function cronFor(s) {
    if (s.every === '30m') return { cron: '*/30 * * * *' };
    if (s.every === 'hour') return { cron: `${Number(s.minute) || 0} * * * *` };
    const [hh, mm] = String(s.time || '09:00').split(':').map(Number);
    if (s.every === 'once') {
      const d = new Date(`${s.date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
      return { cron: `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`, year: d.getUTCFullYear(), at: d.getTime() };
    }
    const want = s.every === 'day' ? [0, 1, 2, 3, 4, 5, 6] : s.every === 'weekdays' ? [1, 2, 3, 4, 5] : [Number(s.day) || 1];
    const utc = want.map((d) => { const r = new Date(); r.setHours(hh, mm, 0, 0); r.setDate(r.getDate() + ((d - r.getDay() + 7) % 7)); return r; });
    const u = utc[0];
    const dows = s.every === 'day' ? '*' : [...new Set(utc.map((r) => r.getUTCDay()))].sort().join(',');
    return { cron: `${u.getUTCMinutes()} ${u.getUTCHours()} * * ${dows}` };
  }
  function whenText(s) {
    const t = s.time ? new Date(`2000-01-01T${s.time}:00`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    if (s.every === '30m') return 'Every 30 minutes';
    if (s.every === 'hour') return 'Every hour';
    if (s.every === 'day') return `Every day at ${t}`;
    if (s.every === 'weekdays') return `Weekdays at ${t}`;
    if (s.every === 'week') return `Every ${DAYS[Number(s.day) || 0]} at ${t}`;
    if (s.every === 'once') return `Once, ${dayName(new Date(`${s.date}T${s.time}:00`))} at ${t}`;
    return 'Scheduled';
  }
  /** The next time a 5-field UTC cron fires after now (minute steps, up to 8 days), or null. */
  function nextRun(cron, s) {
    if (s && s.every === 'once') { const at = cronFor(s).at; return at > Date.now() ? at : null; }
    const f = cron.trim().split(/\s+/);
    if (f.length !== 5) return null;
    const match = (spec, v) => spec.split(',').some((part) => { if (part === '*') return true; const st = part.match(/^\*\/(\d+)$/); if (st) return v % Number(st[1]) === 0; return Number(part) === v; });
    const d = new Date(); d.setUTCSeconds(0, 0); d.setUTCMinutes(d.getUTCMinutes() + 1);
    for (let i = 0; i < 8 * 1440; i++, d.setUTCMinutes(d.getUTCMinutes() + 1)) {
      if (match(f[0], d.getUTCMinutes()) && match(f[1], d.getUTCHours()) && match(f[2], d.getUTCDate()) && match(f[3], d.getUTCMonth() + 1) && match(f[4], d.getUTCDay())) return d.getTime();
    }
    return null;
  }
  function loopYaml(id, meta, cron, year) {
    const prompt = String(meta.prompt).replace(/\$\{\{/g, '$ {{').replace(/\r/g, '');
    const block = prompt.split('\n').map((l) => `            ${l}`).join('\n');
    const guard = year ? `          if [ "$GITHUB_EVENT_NAME" = "schedule" ] && [ "$(date -u +%Y)" != "${year}" ]; then echo "This one-time task was for ${year}."; exit 0; fi\n` : '';
    return `# Written by Codeply. A scheduled task: GitHub runs it at the times below on its own
# machines, so it works with your PC off. Manage it in the Codeply app (Tasks, Scheduled).
# craft-loop: ${b64(JSON.stringify(meta))}
name: craft-loop-${id}
run-name: craft loop-${id}-\${{ github.run_id }}

on:
  schedule:
    - cron: '${cron}'
  workflow_dispatch:

permissions:
  contents: write
  checks: write

concurrency:
  group: craft-loop-${id}
  cancel-in-progress: false

jobs:
  craft:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run Craft
        run: |
${guard}          npx -y --package="\${CRAFT_ENGINE:-${engine()}}" codeply cloud runner
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          CODEPLY_API_KEY: \${{ secrets.CODEPLY_API_KEY }}
          CODEPLY_TRACK_KEY: \${{ secrets.CODEPLY_TRACK_KEY }}
          CODEPLY_MODEL_KIND: \${{ vars.CODEPLY_MODEL_KIND }}
          CODEPLY_MODEL: \${{ vars.CODEPLY_MODEL }}
          CODEPLY_BASE_URL: \${{ vars.CODEPLY_BASE_URL }}
          CRAFT_ENGINE: \${{ vars.CRAFT_ENGINE }}
          CRAFT_ENV: \${{ secrets.CRAFT_ENV }}
          CRAFT_MERGE: \${{ vars.CRAFT_MERGE }}
          CRAFT_PERMISSIONS: \${{ vars.CRAFT_PERMISSIONS }}
          CRAFT_BASE: \${{ github.ref_name }}
          CRAFT_MODE: Build
          CRAFT_TASK_ID: loop-${id}-\${{ github.run_id }}
          CRAFT_SESSION_ID: ''
          CRAFT_PROMPT: |
${block}
`;
  }
  const loopPath = (id) => `.github/workflows/${PREFIX}${id}.yml`;
  const runState = (run, doc) => {
    if (!run) return 'none';
    if (run.status !== 'completed') return 'running';
    if (doc && doc.status === 'failed') return 'failed';
    if (run.conclusion === 'success') return doc && doc.status === 'done' ? 'done' : doc ? 'running' : 'done';
    if (run.conclusion === 'skipped') return 'skipped';
    return run.conclusion === 'cancelled' ? 'cancelled' : 'failed';
  };

  /** Reads every scheduled task in every cloud repo from GitHub. */
  async function loadSchedules() {
    if (sched.loading) return;
    sched.loading = true; sched.error = '';
    try {
      if (!(await P().ensureGithub())) throw new Error('Connect GitHub (menu, Cloud) to see scheduled tasks.');
      const list = [];
      for (const env of envs()) {
        const base = env.base || (await gh(`/repos/${env.repo}`)).default_branch || 'main';
        const dir = await P().gh('GET', `/repos/${env.repo}/contents/.github/workflows?ref=${enc(base)}`, null, { allow: [404] });
        const files = dir.status === 200 && Array.isArray(dir.json) ? dir.json.filter((f) => f.name.startsWith(PREFIX) && f.name.endsWith('.yml')) : [];
        for (const f of files) {
          const id = f.name.slice(PREFIX.length, -4);
          const raw = await P().gh('GET', `/repos/${env.repo}/contents/${encodeURI(f.path)}?ref=${enc(base)}`, null, { allow: [404], accept: 'application/vnd.github.raw+json' });
          const m = String(raw.text || '').match(/# craft-loop: ([A-Za-z0-9+/=]+)/);
          let meta = {};
          try { meta = m ? JSON.parse(unb64(m[1])) : {}; } catch {}
          const cron = (String(raw.text || '').match(/- cron: '([^']+)'/) || [])[1] || '';
          const wf = await P().gh('GET', `/repos/${env.repo}/actions/workflows/${enc(f.name)}`, null, { allow: [404] });
          const runsRes = wf.status === 200 ? await P().gh('GET', `/repos/${env.repo}/actions/workflows/${enc(f.name)}/runs?per_page=5`, null, { allow: [404] }) : null;
          const runs = runsRes && runsRes.json && Array.isArray(runsRes.json.workflow_runs) ? runsRes.json.workflow_runs : [];
          const old = sched.list.find((x) => x.repo === env.repo && x.id === id);
          const docs = (old && old.docs) || {};
          for (const r of runs.slice(0, 3)) {
            const key = String(r.id);
            const known = docs[key];
            if (known && (known.status === 'done' || known.status === 'failed')) continue;
            const doc = await P().readSessionJson(env.repo, `tasks/loop-${id}-${r.id}.json`).catch(() => null);
            if (doc) docs[key] = { status: doc.status, reply: String(doc.reply || doc.answer || '').slice(0, 4000), error: doc.error || '', branch: doc.branch || '', merged: doc.merged || null };
          }
          list.push({ id, repo: env.repo, base, path: f.path, sha: f.sha, meta, cron, state: wf.status === 200 ? wf.json.state : 'new', docs,
            runs: runs.map((r) => ({ id: r.id, status: r.status, conclusion: r.conclusion, event: r.event, url: r.html_url, at: Date.parse(r.run_started_at || r.created_at), updated: Date.parse(r.updated_at) })) });
        }
      }
      sched.list = list; sched.at = Date.now();
      save(SKEY, list);
    } catch (e) { sched.error = e.message; }
    finally { sched.loading = false; document.dispatchEvent(new Event('craft:approvals')); refreshOpenSchedule(); }
  }
  const scheduleStatus = (s) => {
    if (s.state === 'disabled_manually') return { cls: 'off', text: 'Paused' };
    if (s.state === 'disabled_inactivity') return { cls: 'warn', text: 'Paused by GitHub: no activity in the repo for 60 days' };
    if (s.meta.every === 'once' && s.runs.some((r) => r.event === 'schedule' && r.status === 'completed')) return { cls: 'off', text: 'Ran once' };
    const nx = nextRun(s.cron, s.meta);
    if (s.state === 'new') return { cls: 'off', text: `GitHub is registering it${nx ? ` · first run ${dayName(nx)} ${time(nx)}` : ''}` };
    return nx ? { cls: 'on', text: `Next: ${dayName(nx)}, ${time(nx)}` } : { cls: 'off', text: 'No upcoming run' };
  };
  const RUN_TEXT = { running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', none: 'Not run yet' };
  /** The Scheduled block at the top of Tasks (phone-app.js puts it there). */
  function schedulesHtml() {
    if (!sched.loading && Date.now() - sched.at > 60000) setTimeout(loadSchedules, 0);
    const rows = sched.list.map((s) => {
      const st = scheduleStatus(s);
      const last = s.runs[0];
      const ls = runState(last, last && s.docs[String(last.id)]);
      return `<button type="button" class="wk-sched" data-work="open" data-repo="${esc(s.repo)}" data-id="${esc(s.id)}">
        <span class="wk-sched-ico">${ICON.clock}</span>
        <span class="wk-sched-main"><b>${esc(s.meta.title || 'Scheduled task')}</b><small>${esc(whenText(s.meta))} · ${esc(s.repo.split('/')[1] || s.repo)}</small><small class="wk-${st.cls}">${esc(st.text)}</small></span>
        <span class="wk-last ${ls}">${last ? `${esc(RUN_TEXT[ls])}<em>${esc(ago(last.updated || last.at))}</em>` : esc(RUN_TEXT.none)}</span></button>`;
    }).join('');
    const status = sched.error ? `<p class="note wk-err">${esc(sched.error)}</p>` : sched.loading && !sched.list.length ? '<p class="note">Checking GitHub…</p>' : !sched.list.length ? '<p class="note">Nothing scheduled. A scheduled task runs in the cloud at the times you pick, with your PC off.</p>' : '';
    return `<div id="wkBots" data-work="bots"></div><div class="wk-block" data-work="sched"><div class="sec"><h2>Scheduled</h2><button type="button" data-work="new">New</button></div>${rows ? `<div class="wk-list">${rows}</div>` : ''}${status}</div>`;
  }
  /** Recent scheduled runs as Tasks rows. */
  function scheduledTasks() {
    const out = [];
    for (const s of sched.list) for (const r of s.runs.slice(0, 3)) {
      const doc = s.docs[String(r.id)];
      const st = runState(r, doc);
      const state = st === 'running' ? 'running' : st === 'done' ? 'done' : st === 'skipped' ? 'done' : 'failed';
      out.push({ id: `s:${s.repo}|${s.id}|${r.id}`, title: s.meta.title || 'Scheduled task', state, cloud: true, where: `Scheduled · ${s.repo.split('/')[1] || s.repo}`,
        step: state === 'running' ? 'Running in the cloud' : '', error: state === 'failed' ? (doc && doc.error) || (st === 'cancelled' ? 'Cancelled' : 'The run failed on GitHub.') : '',
        since: state === 'running' ? r.at : 0, at: r.updated || r.at });
    }
    return out;
  }

  // New schedule
  function newSchedule() {
    const list = envs();
    if (!list.length) {
      const s = sheet(`<h2 class="wk-title">Set up the cloud first</h2><p class="wk-text">Scheduled tasks run with Codeply Cloud on GitHub. Set it up for a project once, then schedule anything.</p><div class="wk-actions"><button class="btn btn-quiet" data-wk-close>Not now</button><button class="btn btn-primary" data-go>Set up</button></div>`);
      s.q('[data-go]').addEventListener('click', () => { s.close(); P().openSetup && P().openSetup(); });
      return;
    }
    const today = new Date(); const pad = (n) => String(n).padStart(2, '0');
    const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const s = sheet(`<h2 class="wk-title">New scheduled task</h2>
      <label class="wk-field"><span>What should Codeply do?</span><textarea id="wkPrompt" rows="3" placeholder="Check for outdated dependencies and open a pull request with the safe updates"></textarea></label>
      <label class="wk-field"><span>Project</span><select id="wkRepo">${list.map((e) => `<option value="${esc(e.repo)}"${e.repo === currentRepo() ? ' selected' : ''}>${esc(e.repo)}</option>`).join('')}</select></label>
      <label class="wk-field"><span>When</span><select id="wkEvery"><option value="once">Once</option><option value="day" selected>Every day</option><option value="weekdays">Weekdays</option><option value="week">Every week</option><option value="hour">Every hour</option><option value="30m">Every 30 minutes</option></select></label>
      <div class="wk-row2"><label class="wk-field" id="wkDayF" hidden><span>Day</span><select id="wkDay">${DAYS.map((d, i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="wk-field" id="wkDateF" hidden><span>Date</span><input type="date" id="wkDate" value="${iso}" min="${iso}"></label>
        <label class="wk-field" id="wkTimeF"><span>Time</span><input type="time" id="wkTime" value="09:00"></label></div>
      <p class="wk-text small" id="wkHint"></p><p class="wk-text small wk-err" id="wkErr"></p>
      <div class="wk-actions"><button class="btn btn-quiet" data-wk-close>Cancel</button><button class="btn btn-primary" id="wkSave">Schedule</button></div>`);
    const every = s.q('#wkEvery');
    const sync = () => {
      const v = every.value;
      s.q('#wkDayF').hidden = v !== 'week'; s.q('#wkDateF').hidden = v !== 'once'; s.q('#wkTimeF').hidden = v === 'hour' || v === '30m';
      s.q('#wkHint').textContent = `Runs on GitHub Actions in ${s.q('#wkRepo').value} and uses its Actions minutes. GitHub can start a scheduled run a few minutes late.${v === '30m' ? ' Every 30 minutes adds up: about 48 runs a day.' : ''}`;
    };
    every.addEventListener('change', sync); s.q('#wkRepo').addEventListener('change', sync); sync();
    s.q('#wkSave').addEventListener('click', async () => {
      const btn = s.q('#wkSave'); const err = s.q('#wkErr'); err.textContent = '';
      const prompt = s.q('#wkPrompt').value.trim();
      if (!prompt) { err.textContent = 'Write what Codeply should do.'; return; }
      const meta = { title: prompt.split('\n')[0].slice(0, 70), prompt, every: every.value, time: s.q('#wkTime').value || '09:00', day: Number(s.q('#wkDay').value), date: s.q('#wkDate').value, minute: new Date().getMinutes(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, created: Date.now() };
      const c = cronFor(meta);
      if (meta.every === 'once' && !(c.at > Date.now() + 5 * 60000)) { err.textContent = 'Pick a time at least 5 minutes from now.'; return; }
      btn.disabled = true; btn.textContent = 'Scheduling…';
      try {
        const env = envs().find((e) => e.repo === s.q('#wkRepo').value);
        if (!(await P().ensureGithub())) throw new Error('Connect GitHub first (menu, Cloud).');
        await P().ensureRepoReady(env.repo, env.base);
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const r = await P().gh('PUT', `/repos/${env.repo}/contents/${encodeURI(loopPath(id))}`, { message: `Codeply schedule: ${meta.title}`, branch: (P().state.envs[env.repo] || env).base || env.base, content: b64(loopYaml(id, meta, c.cron, c.year)) });
        if (r.status >= 300) throw new Error('GitHub didn’t accept the schedule file.');
        s.close(); toast(`Scheduled: ${whenText(meta)}`);
        sched.at = 0; await loadSchedules();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Schedule';
        err.textContent = /workflow/i.test(e.message) || e.status === 404 || e.status === 403 ? `${e.message} Scheduling needs GitHub's "workflow" permission on ${s.q('#wkRepo').value}.` : e.message;
      }
    });
  }

  // One schedule: details, runs, run now / pause / delete
  let openSched = null;
  function refreshOpenSchedule() { if (openSched && document.body.contains(openSched.el)) renderSchedule(openSched); }
  function openSchedule(repo, id) {
    const s = sheet('<div class="wk-sched-detail"></div>', { onClose: () => { openSched = null; } });
    openSched = { ...s, repo, id };
    renderSchedule(openSched);
  }
  function renderSchedule(o) {
    const s = sched.list.find((x) => x.repo === o.repo && x.id === o.id);
    const box = o.q('.wk-sched-detail');
    if (!s) { box.innerHTML = '<p class="wk-text">This schedule is gone.</p><div class="wk-actions"><button class="btn btn-quiet" data-wk-close>Close</button></div>'; return; }
    const st = scheduleStatus(s);
    const paused = s.state === 'disabled_manually' || s.state === 'disabled_inactivity';
    box.innerHTML = `<h2 class="wk-title">${esc(s.meta.title || 'Scheduled task')}</h2>
      <p class="wk-text">${esc(whenText(s.meta))}<br><span class="wk-${st.cls}">${esc(st.text)}</span></p>
      <div class="wk-prompt">${esc(s.meta.prompt || '')}</div>
      <p class="wk-text small">${esc(s.repo)} · runs on GitHub Actions</p>
      <div class="wk-actions wrap"><button class="btn btn-outline" data-act="run">Run now</button><button class="btn btn-outline" data-act="${paused ? 'resume' : 'pause'}">${paused ? 'Resume' : 'Pause'}</button><button class="btn btn-outline danger" data-act="delete">Delete</button></div>
      <p class="wk-text small wk-err" data-err></p>
      <div class="sec"><h2>Recent runs</h2><span>${sched.at ? `checked ${esc(stamp(sched.at))}` : ''}</span></div>
      ${s.runs.length ? `<div class="wk-list">${s.runs.map((r) => { const ls = runState(r, s.docs[String(r.id)]); return `<button type="button" class="wk-run" data-run="${r.id}">${dot(ls === 'done' ? 'pass' : ls === 'running' ? 'pending' : ls === 'failed' || ls === 'cancelled' ? 'fail' : 'skip')}<span><b>${esc(RUN_TEXT[ls])}</b><small>${esc(dayName(r.at))}, ${esc(time(r.at))}${r.event === 'workflow_dispatch' ? ' · run by hand' : ''}</small></span></button>`; }).join('')}</div>` : '<p class="note">No runs yet.</p>'}`;
    const err = box.querySelector('[data-err]');
    box.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => openRun(`${s.repo}|${s.id}|${b.dataset.run}`)));
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.act; err.textContent = '';
      if (act === 'delete' && !confirm('Delete this scheduled task? Its past runs stay on GitHub.')) return;
      b.disabled = true;
      try {
        const file = enc(`${PREFIX}${s.id}.yml`);
        if (act === 'run') { await P().gh('POST', `/repos/${s.repo}/actions/workflows/${file}/dispatches`, { ref: s.base }); toast('Started. It shows up here in a few seconds.'); }
        if (act === 'pause') await P().gh('PUT', `/repos/${s.repo}/actions/workflows/${file}/disable`);
        if (act === 'resume') await P().gh('PUT', `/repos/${s.repo}/actions/workflows/${file}/enable`);
        if (act === 'delete') {
          const cur = await P().gh('GET', `/repos/${s.repo}/contents/${encodeURI(s.path)}?ref=${enc(s.base)}`);
          await P().gh('DELETE', `/repos/${s.repo}/contents/${encodeURI(s.path)}`, { message: `Codeply: remove schedule ${s.meta.title || s.id}`, sha: cur.json.sha, branch: s.base });
          sched.list = sched.list.filter((x) => x !== s); save(SKEY, sched.list); o.close(); toast('Deleted'); document.dispatchEvent(new Event('craft:approvals')); return;
        }
        sched.at = 0; setTimeout(loadSchedules, act === 'run' ? 4000 : 300);
      } catch (e) { err.textContent = e.message; }
      finally { b.disabled = false; }
    }));
  }
  /** One run's result: what the run reported (tasks/loop-<id>-<run>.json), never a summary made up here. */
  function openRun(key) {
    const [repo, id, runId] = key.split('|');
    const s = sched.list.find((x) => x.repo === repo && x.id === id);
    const r = s && s.runs.find((x) => String(x.id) === runId);
    if (!s || !r) return;
    const doc = s.docs[runId];
    const ls = runState(r, doc);
    const body = doc && doc.reply ? `<div class="wk-md">${P().md ? P().md(doc.reply) : esc(doc.reply)}</div>`
      : ls === 'running' ? '<p class="wk-text">Still running. The result shows here when it finishes.</p>'
        : `<p class="wk-text ${ls === 'failed' ? 'wk-err' : ''}">${esc((doc && doc.error) || (ls === 'failed' ? 'The run failed on GitHub before Codeply could report back. Open it on GitHub to see the log.' : 'This run didn’t report a result.'))}</p>`;
    sheet(`<h2 class="wk-title">${esc(s.meta.title || 'Scheduled task')}</h2><p class="wk-text">${dot(ls === 'done' ? 'pass' : ls === 'running' ? 'pending' : 'fail')} ${esc(RUN_TEXT[ls])} · ${esc(dayName(r.at))}, ${esc(time(r.at))}</p>${body}
      ${doc && doc.branch ? `<p class="wk-text small">Branch: ${esc(doc.branch)}${doc.merged ? ' · merged' : ''}</p>` : ''}
      <div class="wk-actions"><a class="btn btn-outline" href="${esc(r.url)}" target="_blank" rel="noopener">Open on GitHub</a><button class="btn btn-quiet" data-wk-close>Close</button></div>`);
  }

  // ═══ CALENDAR ═══════════════════════════════════════════════════════════════
  let gTok = null;
  const calErr = (code, msg) => Object.assign(new Error(msg), { code });
  async function googleToken(force = false) {
    const g = (await P().accountConnections({ fresh: force })).gmail;
    if (!g || !g.accessToken) throw calErr('off', 'Google isn’t connected to your Codeply account yet. Connect Gmail once in Codeply on your PC (Connect Apps, Gmail); after that the calendar works here with the PC off.');
    if (!force && gTok && gTok.exp > Date.now() + 60000) return gTok.token;
    if (!force && g.expiresAt && g.expiresAt > Date.now() + 60000) { gTok = { token: g.accessToken, exp: g.expiresAt }; return gTok.token; }
    if (!g.refreshToken || !g.clientId || !g.clientSecret) { if (!force) return g.accessToken; throw calErr('expired', 'The Google sign-in saved to your account has expired and can’t be renewed from the phone. Open Codeply on your PC once to renew it.'); }
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw calErr('expired', j.error === 'invalid_grant' ? 'Google says the sign-in was revoked or expired. Reconnect Gmail in Codeply on your PC (Connect Apps).' : `Google wouldn’t renew the sign-in (HTTP ${r.status}${j.error ? `, ${j.error}` : ''}).`);
    gTok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return gTok.token;
  }
  async function gcal(method, path, body) {
    const call = async (tok) => fetch(`https://www.googleapis.com/calendar/v3${path}`, { method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let r = await call(await googleToken(false));
    if (r.status === 401) { gTok = null; r = await call(await googleToken(true)); }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || '';
      if (r.status === 403 && /insufficient|scope/i.test(`${reason} ${j.error && j.error.message}`)) throw calErr('scope', 'Your Google connection was made before Calendar was added. Reconnect Gmail in Codeply on your PC once (Connect Apps) to allow the calendar.');
      throw calErr('http', `Google Calendar said no (HTTP ${r.status}${j.error && j.error.message ? `: ${j.error.message}` : ''}).`);
    }
    return j;
  }
  async function calendarEvents(from, to) {
    const q = `timeMin=${enc(new Date(from).toISOString())}&timeMax=${enc(new Date(to).toISOString())}&singleEvents=true&orderBy=startTime&maxResults=100`;
    const j = await gcal('GET', `/calendars/primary/events?${q}`);
    return (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
      id: e.id, title: e.summary || '(No title)', allDay: !!(e.start && e.start.date), location: e.location || '', link: e.htmlLink || '',
      start: e.start && (e.start.dateTime ? Date.parse(e.start.dateTime) : Date.parse(`${e.start.date}T00:00:00`)),
      end: e.end && (e.end.dateTime ? Date.parse(e.end.dateTime) : Date.parse(`${e.end.date}T00:00:00`)),
      meet: e.hangoutLink || '',
    }));
  }
  const cal = { events: load('craft-phone-cal', []), at: 0, error: '', loading: false };
  async function loadCalendar() {
    cal.loading = true; cal.error = ''; renderCalendar();
    try {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      cal.events = await calendarEvents(from.getTime(), from.getTime() + 14 * 86400000);
      cal.at = Date.now(); save('craft-phone-cal', cal.events);
    } catch (e) { cal.error = e.message; }
    finally { cal.loading = false; renderCalendar(); }
  }
  function openCalendar() {
    const p = panel('calPanel', 'Calendar', `<button class="icon-btn" data-wk-add aria-label="Add event">${ICON.plus}</button>`);
    if (!p.dataset.wired) { p.dataset.wired = '1'; p.querySelector('[data-wk-add]').addEventListener('click', addEvent); }
    show(p); loadCalendar();
  }
  function renderCalendar() {
    const p = $('calPanel'); if (!p) return;
    const body = p.querySelector('.panel-body');
    const byDay = new Map();
    for (const e of cal.events) { const k = new Date(e.start).toDateString(); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
    const today = new Date().toDateString(); const tomorrow = new Date(Date.now() + 86400000).toDateString();
    const head = cal.error ? `<p class="note wk-err">${esc(cal.error)}</p>` : `<p class="note">${cal.loading ? 'Reading Google Calendar…' : cal.at ? `From Google Calendar · read at ${esc(stamp(cal.at))}` : ''}</p>`;
    body.innerHTML = `<div class="wk-calbar"><span>Next 14 days</span><button type="button" data-wk-reload>${ICON.again}</button></div>${head}`
      + (cal.events.length ? [...byDay.entries()].map(([k, list]) => `<div class="sec"><h2>${k === today ? 'Today' : k === tomorrow ? 'Tomorrow' : esc(dayName(list[0].start))}</h2></div><div class="wk-list">${list.map((e) => `<button type="button" class="wk-ev" data-ev="${esc(e.id)}"><span class="wk-ev-time">${e.allDay ? 'All day' : `${esc(time(e.start))}<em>${esc(time(e.end))}</em>`}</span><span class="wk-ev-main"><b>${esc(e.title)}</b>${e.location ? `<small>${esc(e.location)}</small>` : ''}</span></button>`).join('')}</div>`).join('')
        : !cal.loading && !cal.error ? '<p class="note" style="text-align:center;margin-top:40px">Nothing in the next 14 days.</p>' : '');
    body.querySelector('[data-wk-reload]').addEventListener('click', loadCalendar);
    body.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => eventSheet(cal.events.find((e) => e.id === b.dataset.ev))));
  }
  function eventSheet(e) {
    if (!e) return;
    const s = sheet(`<h2 class="wk-title">${esc(e.title)}</h2><p class="wk-text">${esc(dayName(e.start))}${e.allDay ? ' · all day' : `, ${esc(time(e.start))} – ${esc(time(e.end))}`}</p>${e.location ? `<p class="wk-text">${esc(e.location)}</p>` : ''}
      <p class="wk-text small wk-err" data-err></p>
      <div class="wk-actions wrap">${e.meet ? `<a class="btn btn-outline" href="${esc(e.meet)}" target="_blank" rel="noopener">Join</a>` : ''}${e.link ? `<a class="btn btn-outline" href="${esc(e.link)}" target="_blank" rel="noopener">Open in Google</a>` : ''}<button class="btn btn-outline danger" data-del>Delete</button><button class="btn btn-quiet" data-wk-close>Close</button></div>`);
    s.q('[data-del]').addEventListener('click', async () => {
      if (!confirm(`Delete “${e.title}” from your Google Calendar?`)) return;
      try { await gcal('DELETE', `/calendars/primary/events/${enc(e.id)}`); s.close(); toast('Deleted from Google Calendar'); loadCalendar(); }
      catch (x) { s.q('[data-err]').textContent = x.message; }
    });
  }
  function addEvent() {
    const pad = (n) => String(n).padStart(2, '0'); const d = new Date(Date.now() + 3600000);
    const s = sheet(`<h2 class="wk-title">New event</h2>
      <label class="wk-field"><span>Title</span><input id="evTitle" placeholder="Call with Sam"></label>
      <div class="wk-row2"><label class="wk-field"><span>Date</span><input type="date" id="evDate" value="${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}"></label>
      <label class="wk-field"><span>Time</span><input type="time" id="evTime" value="${pad(d.getHours())}:00"></label></div>
      <label class="wk-field"><span>Length</span><select id="evLen"><option value="30">30 minutes</option><option value="60" selected>1 hour</option><option value="120">2 hours</option><option value="day">All day</option></select></label>
      <p class="wk-text small wk-err" data-err></p>
      <div class="wk-actions"><button class="btn btn-quiet" data-wk-close>Cancel</button><button class="btn btn-primary" data-add>Add to Google Calendar</button></div>`);
    s.q('[data-add]').addEventListener('click', async () => {
      const title = s.q('#evTitle').value.trim(); const date = s.q('#evDate').value; const t = s.q('#evTime').value; const len = s.q('#evLen').value;
      if (!title) { s.q('[data-err]').textContent = 'Give it a title.'; return; }
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      let ev;
      if (len === 'day') { const next = new Date(`${date}T00:00:00`); next.setDate(next.getDate() + 1); ev = { summary: title, start: { date }, end: { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` } }; }
      else { const st = new Date(`${date}T${t}:00`); const en = new Date(st.getTime() + Number(len) * 60000); ev = { summary: title, start: { dateTime: st.toISOString(), timeZone: tz }, end: { dateTime: en.toISOString(), timeZone: tz } }; }
      const b = s.q('[data-add]'); b.disabled = true;
      try { await gcal('POST', '/calendars/primary/events', ev); s.close(); toast('Added to Google Calendar'); loadCalendar(); }
      catch (e) { b.disabled = false; s.q('[data-err]').textContent = e.message; }
    });
    setTimeout(() => s.q('#evTitle').focus(), 50);
  }

  // ═══ CHECKS ═════════════════════════════════════════════════════════════════
  const CONC = { success: 'pass', neutral: 'skip', skipped: 'skip', stale: 'skip', cancelled: 'cancel', failure: 'fail', timed_out: 'fail', action_required: 'fail', startup_failure: 'fail', error: 'fail' };
  /** Check runs + commit statuses for one commit, the way GitHub's own checks badge adds them up. */
  async function commitChecks(repo, sha) {
    const [runs, status] = await Promise.all([gh(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`), gh(`/repos/${repo}/commits/${sha}/status`)]);
    const items = (runs.check_runs || []).map((c) => ({ name: c.name, state: c.status !== 'completed' ? 'pending' : CONC[c.conclusion] || 'skip', url: c.html_url, detail: (c.output && c.output.title) || '' }));
    const seen = new Set();
    for (const s of status.statuses || []) { if (seen.has(s.context)) continue; seen.add(s.context); items.push({ name: s.context, state: s.state === 'success' ? 'pass' : s.state === 'pending' ? 'pending' : 'fail', url: s.target_url || '', detail: s.description || '' }); }
    const overall = items.some((i) => i.state === 'fail') ? 'fail' : items.some((i) => i.state === 'pending') ? 'pending' : items.length ? 'pass' : 'none';
    return { overall, items };
  }
  async function githubChecks(repo) {
    if (!(await P().ensureGithub())) return { state: 'off', error: 'GitHub isn’t connected on this phone. Connect it in menu, Cloud.' };
    const info = await gh(`/repos/${repo}`);
    const branch = info.default_branch;
    const commit = await gh(`/repos/${repo}/commits/${enc(branch)}`);
    const checks = await commitChecks(repo, commit.sha);
    const pulls = await gh(`/repos/${repo}/pulls?state=open&per_page=5`);
    const prs = await Promise.all((pulls || []).map(async (p) => ({ number: p.number, title: p.title, url: p.html_url, draft: p.draft, author: p.user && p.user.login, checks: await commitChecks(repo, p.head.sha).catch(() => ({ overall: 'err', items: [] })) })));
    const runs = (await gh(`/repos/${repo}/actions/runs?per_page=6`)).workflow_runs || [];
    return { state: checks.overall, repo, branch, url: info.html_url, commit: { sha: commit.sha.slice(0, 7), message: String((commit.commit && commit.commit.message) || '').split('\n')[0], author: (commit.author && commit.author.login) || (commit.commit && commit.commit.author && commit.commit.author.name) || '', at: Date.parse(commit.commit && commit.commit.committer && commit.commit.committer.date), url: commit.html_url }, checks, prs,
      runs: runs.map((r) => ({ name: r.display_title || r.name, workflow: r.name, state: r.status !== 'completed' ? 'pending' : CONC[r.conclusion] || 'skip', url: r.html_url, at: Date.parse(r.updated_at), branch: r.head_branch })) };
  }
  async function vercelChecks(repo, conns) {
    const v = conns.vercel;
    if (!v || !v.accessToken) return { state: 'off', error: 'Vercel isn’t connected to your Codeply account. Connect it once in Codeply on your PC (Connect Apps, Vercel).' };
    const team = v.teamId ? `teamId=${enc(v.teamId)}&` : '';
    const vc = async (path) => { const r = await fetch(`https://api.vercel.com${path}`, { headers: { Authorization: `Bearer ${v.accessToken}` } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `Vercel refused the saved sign-in (HTTP ${r.status}). Reconnect Vercel in Codeply on your PC.` : `Vercel said no (HTTP ${r.status}${j.error && j.error.message ? `: ${j.error.message}` : ''}).`); return j; };
    const projects = (await vc(`/v9/projects?${team}limit=100`)).projects || [];
    const linked = projects.filter((p) => p.link && p.link.type === 'github' && `${p.link.org}/${p.link.repo}`.toLowerCase() === repo.toLowerCase());
    if (!linked.length) return { state: 'none', error: `No Vercel project is linked to ${repo}. (Checked ${projects.length} project${projects.length === 1 ? '' : 's'} on this Vercel account.)` };
    const out = [];
    for (const p of linked.slice(0, 2)) {
      const deps = (await vc(`/v6/deployments?${team}projectId=${enc(p.id)}&limit=6`)).deployments || [];
      out.push({ name: p.name, deployments: deps.map((d) => ({ state: d.readyState || d.state, url: `https://${d.url}`, target: d.target || 'preview', at: d.created || d.createdAt, ref: (d.meta && d.meta.githubCommitRef) || '', message: (d.meta && d.meta.githubCommitMessage) || '' })) });
    }
    const prod = out[0].deployments.find((d) => d.target === 'production');
    const st = prod ? (prod.state === 'READY' ? 'pass' : prod.state === 'ERROR' ? 'fail' : prod.state === 'CANCELED' ? 'cancel' : 'pending') : 'none';
    return { state: st, projects: out };
  }
  /** Supabase's management API doesn't answer browsers, so this goes through the integration-status function. */
  async function supabaseApi(path, conns) {
    const s = conns.supabase;
    const token = await P().accessToken();
    const r = await fetch(`${P().SUPABASE_URL}/functions/v1/integration-status`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: P().SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'supabase', path, token: s.accessToken, refresh: s.refreshToken ? { refreshToken: s.refreshToken, clientId: s.clientId, clientSecret: s.clientSecret } : null }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 && !j.status) throw Object.assign(new Error('Supabase checks need the integration-status function on Codeply’s server, and it isn’t deployed yet.'), { code: 'missing' });
    if (!r.ok) throw new Error(j.error || `The status function failed (HTTP ${r.status}).`);
    if (j.status === 401 || j.status === 403) throw new Error(`Supabase refused the saved sign-in (HTTP ${j.status}). Reconnect Supabase in Codeply on your PC.`);
    if (j.status >= 300) throw new Error(`Supabase said no (HTTP ${j.status}${j.json && j.json.message ? `: ${j.json.message}` : ''}).`);
    return j.json;
  }
  async function supabaseChecks(conns) {
    if (!conns.supabase || !conns.supabase.accessToken) return { state: 'off', error: 'Supabase isn’t connected to your Codeply account. Connect it once in Codeply on your PC (Connect Apps, Supabase).' };
    const projects = await supabaseApi('/v1/projects', conns);
    const list = [];
    for (const p of (projects || []).slice(0, 4)) {
      const ref = p.ref || p.id;
      let health = null;
      if (p.status === 'ACTIVE_HEALTHY' || p.status === 'ACTIVE_UNHEALTHY') health = await supabaseApi(`/v1/projects/${ref}/health?services=auth&services=db&services=rest&services=storage`, conns).catch((e) => ({ error: e.message }));
      list.push({ name: p.name, ref, region: p.region, status: p.status, url: `https://supabase.com/dashboard/project/${ref}`, health: Array.isArray(health) ? health.map((h) => ({ name: h.name, healthy: !!h.healthy, status: h.status })) : null, healthError: health && health.error });
    }
    const bad = list.some((p) => p.status !== 'ACTIVE_HEALTHY' && !/PAUSED|INACTIVE/.test(p.status) || (p.health && p.health.some((h) => !h.healthy)));
    return { state: !list.length ? 'none' : bad ? 'fail' : 'pass', projects: list };
  }
  const checks = { repo: load('craft-phone-checks-repo', ''), at: 0, gh: null, vercel: null, supabase: null, loading: false };
  async function runChecks(repo) {
    const part = (fn) => fn().catch((e) => ({ state: e.code === 'missing' ? 'off' : 'err', error: e.message }));
    let conns = {};
    let connErr = '';
    try { conns = await P().accountConnections({ fresh: true }); } catch (e) { connErr = e.message; }
    const noConn = () => Promise.resolve({ state: 'err', error: connErr });
    const [g, v, s] = await Promise.all([repo ? part(() => githubChecks(repo)) : Promise.resolve({ state: 'off', error: 'Pick a repo.' }), connErr ? noConn() : repo ? part(() => vercelChecks(repo, conns)) : Promise.resolve({ state: 'off', error: '' }), connErr ? noConn() : part(() => supabaseChecks(conns))]);
    return { repo, at: Date.now(), gh: g, vercel: v, supabase: s };
  }
  async function loadChecks() {
    checks.loading = true; renderChecks();
    try { Object.assign(checks, await runChecks(checks.repo)); }
    finally { checks.loading = false; renderChecks(); }
  }
  // ─── Tasks has two tabs: Tasks (phone-app.js draws it) and Checks (drawn here) ─
  let tab = 'tasks';
  function tabs() {
    const panelEl = $('tasksPanel');
    if (!panelEl || $('wkTabs')) return;
    const bar = document.createElement('div');
    bar.id = 'wkTabs'; bar.className = 'wk-tabs seg wide';
    bar.innerHTML = '<button type="button" data-tab="tasks" class="on">Tasks</button><button type="button" data-tab="checks">Checks</button>';
    panelEl.querySelector('.top').after(bar);
    const box = document.createElement('div'); box.id = 'tasksChecks'; box.className = 'panel-body hidden';
    $('tasksBody').after(box);
    bar.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  }
  function setTab(t) {
    tabs(); tab = t;
    document.querySelectorAll('#wkTabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('tasksBody').classList.toggle('hidden', t !== 'tasks');
    $('tasksChecks').classList.toggle('hidden', t !== 'checks');
    const plus = document.querySelector('#tasksPanel [data-q="new"]'); if (plus) plus.style.visibility = t === 'tasks' ? '' : 'hidden';
    if (t === 'checks') { if (!checks.repo || !envs().some((e) => e.repo === checks.repo)) checks.repo = currentRepo(); loadChecks(); }
  }
  function openChecks() {
    tabs();
    const p = $('tasksPanel'); if (!p) return;
    show(p); setTab('checks');
  }
  const row = (state, title, sub, url, right = '') => `<${url ? `a href="${esc(url)}" target="_blank" rel="noopener"` : 'div'} class="wk-ck">${dot(state)}<span class="wk-ck-main"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${right ? `<span class="wk-ck-r">${esc(right)}</span>` : ''}</${url ? 'a' : 'div'}>`;
  const sectionHead = (name, part) => `<div class="sec"><h2>${esc(name)}</h2><span class="wk-pill ${part ? part.state : ''}">${part ? esc(LABEL[part.state] || '') : ''}</span></div>`;
  function renderChecks() {
    const body = $('tasksChecks'); if (!body) return;
    const list = envs();
    const picker = list.length ? `<div class="chips">${list.map((e) => `<button type="button" data-repo="${esc(e.repo)}" class="${e.repo === checks.repo ? 'on' : ''}">${esc(e.repo.split('/')[1] || e.repo)}</button>`).join('')}</div>` : '<p class="note">No GitHub repo yet. Set up Codeply Cloud for a project (menu, Cloud) to check it here.</p>';
    const when = checks.loading ? 'Checking…' : checks.at ? `Read live from the GitHub, Vercel and Supabase APIs at ${stamp(checks.at)}. Tap a line to open it.` : '';
    let html = `<div class="wk-calbar"><span>Live status</span><button type="button" data-wk-recheck aria-label="Check again">${ICON.again}</button></div>${picker}<p class="note">${esc(when)}</p>`;
    const g = checks.gh;
    if (g && checks.repo) {
      html += sectionHead(`GitHub · ${checks.repo}`, g);
      if (g.error) html += `<p class="note ${g.state === 'err' ? 'wk-err' : ''}">${esc(g.error)}</p>`;
      else {
        html += `<div class="wk-list">${row(g.state, `${g.branch}: ${g.commit.message || g.commit.sha}`, `${g.commit.sha} · ${g.commit.author} · ${ago(g.commit.at)}`, g.commit.url, LABEL[g.checks.overall])}`
          + g.checks.items.map((i) => row(i.state, i.name, i.detail, i.url, LABEL[i.state])).join('') + '</div>';
        html += `<div class="sec"><h2>Open pull requests</h2><span>${g.prs.length}</span></div>`
          + (g.prs.length ? `<div class="wk-list">${g.prs.map((pr) => row(pr.checks.overall, `#${pr.number} ${pr.title}`, `${pr.draft ? 'Draft · ' : ''}${pr.author || ''}`, pr.url, LABEL[pr.checks.overall])).join('')}</div>` : '<p class="note">None open.</p>');
        html += '<div class="sec"><h2>Recent Actions runs</h2></div>' + (g.runs.length ? `<div class="wk-list">${g.runs.map((r) => row(r.state, r.name, `${r.workflow} · ${r.branch} · ${ago(r.at)}`, r.url, LABEL[r.state])).join('')}</div>` : '<p class="note">No runs.</p>');
      }
    }
    const v = checks.vercel;
    if (v) {
      html += sectionHead('Vercel', v);
      if (v.error) html += `<p class="note ${v.state === 'err' ? 'wk-err' : ''}">${esc(v.error)}</p>`;
      else html += v.projects.map((pj) => `<div class="wk-list">${pj.deployments.map((d) => row(d.state === 'READY' ? 'pass' : d.state === 'ERROR' ? 'fail' : d.state === 'CANCELED' ? 'cancel' : 'pending', `${pj.name} · ${d.target === 'production' ? 'Production' : 'Preview'}`, `${d.ref ? `${d.ref} · ` : ''}${d.message ? `${d.message.split('\n')[0]} · ` : ''}${ago(d.at)}`, d.url, d.state === 'READY' ? 'Ready' : d.state === 'ERROR' ? 'Error' : d.state === 'CANCELED' ? 'Cancelled' : String(d.state || '').toLowerCase())).join('') || row('none', pj.name, 'No deployments yet', '')}</div>`).join('');
    }
    const s = checks.supabase;
    if (s) {
      html += sectionHead('Supabase', s);
      if (s.error) html += `<p class="note ${s.state === 'err' ? 'wk-err' : ''}">${esc(s.error)}</p>`;
      else html += s.projects.length ? `<div class="wk-list">${s.projects.map((pj) => row(pj.status === 'ACTIVE_HEALTHY' && !(pj.health && pj.health.some((h) => !h.healthy)) ? 'pass' : /PAUSED|INACTIVE/.test(pj.status) ? 'skip' : /COMING_UP|RESTORING|RESIZING|UPGRADING/.test(pj.status) ? 'pending' : 'fail', pj.name,
        `${pj.region} · ${pj.status.replace(/_/g, ' ').toLowerCase()}${pj.health ? ` · ${pj.health.map((h) => `${h.name} ${h.healthy ? 'ok' : 'down'}`).join(', ')}` : pj.healthError ? ` · health not read: ${pj.healthError}` : ''}`, pj.url)).join('')}</div>` : '<p class="note">No Supabase projects on this account.</p>';
    }
    body.innerHTML = html;
    body.querySelectorAll('[data-repo]').forEach((b) => b.addEventListener('click', () => { checks.repo = b.dataset.repo; save('craft-phone-checks-repo', checks.repo); loadChecks(); }));
    const re = body.querySelector('[data-wk-recheck]'); if (re) re.addEventListener('click', loadChecks);
  }

  // ═══ Chat: answer status questions from live reads ══════════════════════════
  const STATUS_RE = /\b(ci|builds?|checks?|tests? (pass|fail)\w*|passing|failing|pipelines?|actions? runs?|workflows?|deploy(ed|ment|ments|s)?|vercel|supabase|pull requests?|prs?|production|site (up|down|live)|is (it|my site|the site|the app) (up|down|live)|calendar|meetings?|agenda|events? (today|tomorrow)|scheduled( tasks?)?|schedules?|loops?)\b/i;
  const ASK_RE = /\?|\b(status|check|is|are|did|does|do i|how|what|which|any|show|tell|list|when)\b/i;
  const isStatusQuestion = (t) => STATUS_RE.test(String(t || '')) && ASK_RE.test(String(t || ''));
  async function statusNote(text) {
    const t = String(text || '');
    const lines = [];
    if (/\b(calendar|meetings?|agenda|events?)\b/i.test(t)) {
      try {
        const from = new Date(); from.setHours(0, 0, 0, 0);
        const ev = await calendarEvents(from.getTime(), from.getTime() + 2 * 86400000);
        lines.push(`Google Calendar, today and tomorrow (${ev.length} event${ev.length === 1 ? '' : 's'}):`, ...ev.map((e) => `- ${dayName(e.start)} ${e.allDay ? 'all day' : `${time(e.start)}-${time(e.end)}`}: ${e.title}${e.location ? ` (${e.location})` : ''}`));
      } catch (e) { lines.push(`Google Calendar could not be read: ${e.message}`); }
    }
    if (/\b(scheduled|schedules?|loops?)\b/i.test(t)) {
      await loadSchedules();
      if (sched.error) lines.push(`Scheduled tasks could not be read: ${sched.error}`);
      else lines.push(`Scheduled tasks (${sched.list.length}):`, ...sched.list.map((s) => { const last = s.runs[0]; return `- ${s.meta.title} (${whenText(s.meta)}, ${s.repo}): ${scheduleStatus(s).text}; last run: ${last ? `${RUN_TEXT[runState(last, s.docs[String(last.id)])]} ${ago(last.updated || last.at)}` : 'none yet'}`; }));
    }
    if (/\b(ci|builds?|checks?|tests?|passing|failing|pipelines?|actions?|workflows?|deploy\w*|vercel|supabase|pull requests?|prs?|production|site|app)\b/i.test(t)) {
      const repo = currentRepo();
      const r = await runChecks(repo);
      const g = r.gh;
      if (!repo) lines.push('GitHub: no repo is set up for Codeply Cloud on this phone, so nothing was checked.');
      else if (g.error) lines.push(`GitHub (${repo}) could not be read: ${g.error}`);
      else {
        lines.push(`GitHub ${repo}, branch ${g.branch}, latest commit ${g.commit.sha} "${g.commit.message}" by ${g.commit.author}: checks ${LABEL[g.checks.overall].toLowerCase()}.`,
          ...g.checks.items.map((i) => `- ${i.name}: ${LABEL[i.state].toLowerCase()}${i.detail ? ` (${i.detail})` : ''}`),
          `Open pull requests: ${g.prs.length ? g.prs.map((p) => `#${p.number} "${p.title}" checks ${LABEL[p.checks.overall].toLowerCase()}`).join('; ') : 'none'}.`);
      }
      const v = r.vercel;
      lines.push(v.error ? `Vercel: ${v.error}` : `Vercel: ${v.projects.map((p) => `${p.name}: ${p.deployments.slice(0, 3).map((d) => `${d.target} ${String(d.state).toLowerCase()} ${ago(d.at)} ${d.url}`).join('; ')}`).join(' | ')}`);
      const s = r.supabase;
      lines.push(s.error ? `Supabase: ${s.error}` : `Supabase: ${s.projects.map((p) => `${p.name} ${p.status}${p.health ? ` (${p.health.map((h) => `${h.name} ${h.healthy ? 'ok' : 'down'}`).join(', ')})` : ''}`).join('; ') || 'no projects'}`);
    }
    return lines.join('\n');
  }

  // ─── Wiring ─────────────────────────────────────────────────────────────────
  function addDrawerItems() {
    const tasks = $('drawerTasks');
    if (!tasks || $('drawerCalendar')) return;
    const item = (id, icon, label, fn) => { const b = document.createElement('button'); b.className = 'drawer-item'; b.id = id; b.innerHTML = `${icon}<span>${label}</span>`; b.addEventListener('click', () => { if (P().closeDrawer) P().closeDrawer(); fn(); }); return b; };
    tasks.after(item('drawerCalendar', ICON.cal, 'Calendar', openCalendar), item('drawerSpecialists', ICON.bots, 'Specialists', openSpecialists));
  }
  // ═══ SPECIALISTS: the ones Wisp has called or made ══════════════════════════
  // From the PC when it's online (Wisp's team: built-in specialists Wisp has called, and the ones it made), kept
  // on the phone for when it's offline; plus every specialist seen in this phone's chats (wisp_agent events).
  const TKEY = 'craft-phone-team';
  const team = { list: load(TKEY, { team: [], at: 0 }), loading: false, error: '' };
  function seenInChats() {
    const st = P().state || {}; const seen = {};
    const visit = (o, chat, depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if ((o.kind === 'wisp_agent' || o.type === 'wisp_agent') && o.agent && o.agent.name) {
        const k = String(o.agent.id || o.agent.name).toLowerCase();
        const s = seen[k] || (seen[k] = { ...o.agent, calls: 0, made: false, chats: new Set(), lastAt: 0 });
        if (o.phase === 'start') s.calls++;
        if (o.phase === 'created') s.made = true;
        if (chat) s.chats.add(chat.id);
        s.lastAt = Math.max(s.lastAt, Number(o.at) || chat && chat.updatedAt || 0);
        s.lastChat = chat ? chat.id : s.lastChat;
        return;
      }
      for (const v of Array.isArray(o) ? o : Object.values(o)) visit(v, chat, depth + 1);
    };
    for (const c of st.chats || []) { try { visit(P().chatBody(c.id), c); } catch {} }
    return seen;
  }
  async function loadTeam() {
    if (team.loading) return;
    team.loading = true; team.error = ''; renderSpecialists();
    try {
      if (P().relay && P().relay.pcId) {
        const r = await P().relayRequest('GET', '/api/wisp/team');
        if (r && Array.isArray(r.team)) { team.list = { team: r.team, at: Date.now() }; save(TKEY, team.list); }
      }
    } catch (e) { team.error = /404|not found/i.test(e.message) ? 'Update Codeply on your PC to see its whole team here.' : `Couldn't get the team from your PC: ${e.message}`; }
    finally { team.loading = false; renderSpecialists(); }
  }
  function openSpecialists() {
    const p = panel('specPanel', 'Specialists');
    show(p); renderSpecialists(); loadTeam();
  }
  function renderSpecialists() {
    const p = $('specPanel'); if (!p) return;
    const body = p.querySelector('.panel-body');
    const seen = seenInChats();
    const map = new Map();
    for (const s of team.list.team || []) map.set(String(s.id || s.name).toLowerCase(), { ...s, made: !s.builtin, calls: s.uses || 0 });
    for (const [k, s] of Object.entries(seen)) {
      const cur = map.get(k) || [...map.values()].find((x) => String(x.name).toLowerCase() === String(s.name).toLowerCase());
      if (cur) { cur.calls = Math.max(cur.calls || 0, s.calls); cur.lastChat = s.lastChat; cur.lastAt = s.lastAt; if (s.made) cur.made = true; }
      else map.set(k, { id: s.id || k, name: s.name, focus: s.focus || '', shape: s.shape, color: s.color, made: s.made, calls: s.calls, lastChat: s.lastChat, lastAt: s.lastAt });
    }
    const all = [...map.values()];
    const made = all.filter((s) => s.made);
    const called = all.filter((s) => !s.made && s.calls > 0).sort((a, b) => (b.calls || 0) - (a.calls || 0));
    const row = (s) => `<button type="button" class="wk-spec" data-spec="${esc(s.id)}"><span class="wk-spec-face" data-face="${esc(s.shape || 'pentagon')}" data-color="${esc(s.color || '')}"></span>
      <span class="wk-spec-main"><b>${esc(s.name)}</b><small>${esc(s.focus || (s.made ? 'Made by Wisp' : ''))}</small>${s.instructions ? `<small class="wk-spec-ins">${esc(short(s.instructions, 120))}</small>` : ''}</span>
      <span class="wk-spec-n">${s.calls ? `${s.calls} call${s.calls === 1 ? '' : 's'}` : s.made ? 'New' : ''}</span></button>`;
    const note = team.loading ? 'Getting the team from your PC…' : team.error ? team.error : team.list.at ? `From your PC · ${ago(team.list.at)}` : P().relay && P().relay.pcId ? '' : 'Your PC is offline: showing what this phone has seen.';
    body.innerHTML = `<p class="note ${team.error ? 'wk-err' : ''}">${esc(note)}</p>`
      + (made.length ? `<div class="sec"><h2>Made by Wisp</h2><span>${made.length}</span></div><div class="wk-list">${made.map(row).join('')}</div>` : '')
      + (called.length ? `<div class="sec"><h2>Called in your chats</h2><span>${called.length}</span></div><div class="wk-list">${called.map(row).join('')}</div>` : '')
      + (!made.length && !called.length ? '<p class="note" style="text-align:center;margin-top:40px">No specialists yet. When Wisp calls one into a chat (Frontend, Testing…) or makes a new one, it shows up here.</p>' : '');
    body.querySelectorAll('.wk-spec-face').forEach((el) => { try { const w = window.CraftWisp.mount(el, { size: 'md', shape: el.dataset.face, morph: false }); if (el.dataset.color) w.setColor(el.dataset.color); w.setMood('happy', true); } catch {} });
    body.querySelectorAll('[data-spec]').forEach((b) => b.addEventListener('click', () => {
      const s = all.find((x) => String(x.id) === b.dataset.spec); if (!s) return;
      const hist = (s.history || []).slice(0, 5);
      const sh = sheet(`<h2 class="wk-title">${esc(s.name)}</h2><p class="wk-text">${esc(s.focus || '')}${s.made ? ' · made by Wisp' : ''}</p>
        ${s.instructions ? `<div class="wk-prompt">${esc(s.instructions)}</div>` : ''}
        ${hist.length ? `<div class="sec"><h2>Recent jobs</h2></div><div class="wk-list">${hist.map((h) => `<div class="wk-ck">${dot(h.ok === false ? 'fail' : 'pass')}<span class="wk-ck-main"><b>${esc(short(h.task || h.title || '', 90))}</b>${h.at ? `<small>${esc(ago(h.at))}</small>` : ''}</span></div>`).join('')}</div>` : ''}
        <div class="wk-actions">${s.lastChat ? '<button class="btn btn-outline" data-go>Open its last chat</button>' : ''}<button class="btn btn-quiet" data-wk-close>Close</button></div>`);
      const go = sh.q('[data-go]'); if (go) go.addEventListener('click', () => { sh.close(); p.classList.add('hidden'); P().openChat(s.lastChat); });
    }));
  }
  const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

  function wire() {
    addDrawerItems();
    tabs();
    // The drawer's Tasks always opens on the Tasks tab.
    const dt = $('drawerTasks'); if (dt) dt.addEventListener('click', () => setTab('tasks'));
    const tb = $('tasksBody');
    if (tb) tb.addEventListener('click', (e) => {
      const n = e.target.closest('[data-work="new"]'); if (n) { newSchedule(); return; }
      const o = e.target.closest('[data-work="open"]'); if (o) openSchedule(o.dataset.repo, o.dataset.id);
    });
    // Running scheduled tasks: look again every 30 s while the Tasks panel is open.
    setInterval(() => { const tp = $('tasksPanel'); if (!document.hidden && tp && !tp.classList.contains('hidden') && sched.list.some((s) => s.runs.some((r) => r.status !== 'completed'))) loadSchedules(); }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.CraftWork = { openSpecialists, setTab, schedulesHtml, scheduledTasks, openRun, loadSchedules, openCalendar, openChecks, isStatusQuestion, statusNote, cronFor, nextRun, loopYaml, whenText, runChecks };
})();
