// First run of Codeply Crew: welcome, meet the crew, terms, your name, how bots
// ask, what bots can see, done. Shown once, over the app, until it is finished.
// The choices land in Crew's settings, Life sources and the user's memory.
(() => {
  const api = window.crew;
  const $ = (q, el = document) => el.querySelector(q);
  const $$ = (q, el = document) => [...el.querySelectorAll(q)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // The default crew (codeply-cli/lib/bots.js TEMPLATES), with a short job each.
  const CREW = [
    { name: 'Orion', job: 'Leads the team', avatar: { shape: 'burst9', eyes: 'pills', color: 'graphite' } },
    { name: 'Vera', job: 'Research', avatar: { shape: 'drop', eyes: 'big', color: 'blue' } },
    { name: 'Remy', job: 'Writing and outreach', avatar: { shape: 'cloud', eyes: 'happy', color: 'pink', cheeks: true } },
    { name: 'Quinn', job: 'Analysis', avatar: { shape: 'squircle', eyes: 'ovals', color: 'teal', glasses: 'round' } },
    { name: 'Wren', job: 'Reports', avatar: { shape: 'star', eyes: 'dots', color: 'orange', accessory: 'sprout' } },
    { name: 'Axel', job: 'Builds and ships', avatar: { shape: 'burst7', eyes: 'sleepy', color: 'red', accessory: 'antenna' } },
    { name: 'Juno', job: 'Keeps watch', avatar: { shape: 'burst12', eyes: 'sparkle', color: 'purple', accessory: 'halo' } },
  ];
  const OTHER = 'Something else';
  const FOCUS = ['Building software', 'Running a business', 'Studying', 'Creating content', OTHER];
  const MODES = {
    ask: { label: 'Always ask', desc: 'Asks you before every command, click, email or edit.' },
    once: { label: 'Ask once', desc: 'Once you allow something, it is allowed for the rest of that chat. Emails still show every time.' },
  };
  // key: the onboarding switch; life: the Life source it turns on.
  const SOURCES = [
    { key: 'calendar', life: ['calendar'], name: 'Calendar', desc: 'Your events and who is in them.', ctx: 'Standup with Sara at 10:00', icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>' },
    { key: 'email', life: ['gmail'], name: 'Email', desc: 'Who wrote, and who is waiting on you.', ctx: 'Usman is waiting on a reply', icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>' },
    { key: 'screen', life: ['activity', 'screen'], name: 'What is on your screen', desc: 'The app in front. Private windows are skipped.', ctx: 'You are in VS Code, landing page', icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>' },
    { key: 'health', life: ['health'], name: 'Health', desc: 'Steps and sleep. Only bots you allow see it.', ctx: '4,200 steps so far today', icon: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z"/>' },
  ];
  const TERMS_URL = 'https://codeply.app/terms';
  const PRIVACY_URL = 'https://codeply.app/privacy';

  const STEPS_HTML = `
    <div class="ob-step" data-step="welcome">
      <h1 class="ob-rise" tabindex="-1">Your agents,<br>on your PC.</h1>
      <p class="ob-lede ob-rise">A small team of bots, each good at one thing. They work for you here, and remember what helps.</p>
      <div class="ob-actions ob-rise"><button class="ob-btn primary" data-next>Get started</button></div>
    </div>
    <div class="ob-step" data-step="meet" hidden>
      <h1 class="ob-rise" tabindex="-1">Meet your crew.</h1>
      <p class="ob-lede ob-rise">Seven bots, ready now. Orion leads and hands each job to the right teammate. You can make your own anytime.</p>
      <div class="ob-actions ob-rise"><button class="ob-btn ghost" data-back>Back</button><button class="ob-btn primary" data-next>Continue</button></div>
    </div>
    <div class="ob-step" data-step="terms" hidden>
      <h1 class="ob-rise" tabindex="-1">Before you start.</h1>
      <div class="ob-body ob-rise">
        <ul class="ob-facts">
          <li><span class="ob-ic"><svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5Z"/><path d="M9 12l2 2 4-4"/></svg></span><div><b>You set the limits.</b><span>Bots ask before they act, until you say otherwise.</span></div></li>
          <li><span class="ob-ic"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></span><div><b>It stays on this PC.</b><span>What your bots learn is kept here.</span></div></li>
          <li><span class="ob-ic"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></span><div><b>Forget anything.</b><span>See what they remember and remove it.</span></div></li>
        </ul>
      </div>
      <label class="ob-agree ob-rise"><input type="checkbox" id="obAgree"><span class="ob-box"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></span><span>I agree to the <a href="#" data-url="${TERMS_URL}">Terms of Service</a> and the <a href="#" data-url="${PRIVACY_URL}">Privacy Policy</a>.</span></label>
      <div class="ob-actions ob-rise"><button class="ob-btn ghost" data-back>Back</button><button class="ob-btn primary" data-next id="obAgreeNext" disabled>Continue</button></div>
    </div>
    <div class="ob-step" data-step="name" hidden>
      <h1 class="ob-rise" tabindex="-1">What should your agents call you?</h1>
      <div class="ob-body ob-rise">
        <label class="ob-field"><span class="ob-sr">Your name</span><input id="obName" type="text" autocomplete="given-name" placeholder="Your name" maxlength="40"></label>
        <div class="ob-sub" id="obFocusLabel">What do you mostly do? <em>Pick any, optional</em></div>
        <div class="ob-chips" role="group" aria-labelledby="obFocusLabel" id="obFocus"></div>
        <label class="ob-field other" id="obOtherWrap" hidden><span class="ob-sr">Something else you do</span><input id="obOther" type="text" placeholder="What else do you do?" maxlength="60"></label>
      </div>
      <div class="ob-actions ob-rise"><button class="ob-btn ghost" data-back>Back</button><button class="ob-btn primary" data-next id="obNameNext" disabled>Continue</button></div>
    </div>
    <div class="ob-step" data-step="ask" hidden>
      <h1 class="ob-rise" tabindex="-1">How should bots ask?</h1>
      <p class="ob-lede ob-rise">Before a command, a click, an email or an edit. Change it for any chat later.</p>
      <div class="ob-body ob-rise"><div class="ob-choices" role="radiogroup" aria-label="How bots ask" id="obModes"></div></div>
      <div class="ob-actions ob-rise"><button class="ob-btn ghost" data-back>Back</button><button class="ob-btn primary" data-next>Continue</button></div>
    </div>
    <div class="ob-step" data-step="see" hidden>
      <h1 class="ob-rise" tabindex="-1">What can your bots see?</h1>
      <p class="ob-lede ob-rise">Nothing, unless you turn it on. It helps them help you before you ask.</p>
      <div class="ob-body ob-rise"><div class="ob-switches" id="obSources"></div><p class="ob-later">You can change this anytime in Settings.</p></div>
      <div class="ob-actions ob-rise"><button class="ob-btn ghost" data-back>Back</button><button class="ob-btn primary" data-next>Continue</button></div>
    </div>
    <div class="ob-step" data-step="done" hidden>
      <h1 class="ob-rise" tabindex="-1" id="obDoneTitle">You're all set.</h1>
      <div class="ob-body ob-rise"><ul class="ob-summary" id="obSummary"></ul></div>
      <div class="ob-actions ob-rise"><button class="ob-btn ghost" data-back>Back</button><button class="ob-btn primary" id="obFinish">Open Agents<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>
    </div>`;

  const STAGE_HTML = `
    <div class="ob-scene" data-scene="welcome"><div class="ob-orbit" id="obOrbit"><img class="ob-mark" src="assets/logo/codeply-icon-256.png" alt=""></div></div>
    <div class="ob-scene" data-scene="meet"><div class="ob-crew" id="obCrew"></div></div>
    <div class="ob-scene" data-scene="terms"><div class="ob-pc" id="obPc">
      <div class="screen"><div class="lock"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div></div>
      <div class="stand"></div><div class="base"></div>
      <div class="note">Your agents work here, on this computer.</div>
    </div></div>
    <div class="ob-scene" data-scene="name"><div class="ob-chat" id="obChat"></div></div>
    <div class="ob-scene" data-scene="ask"><div class="ob-card" id="obCard"></div></div>
    <div class="ob-scene" data-scene="see"><div class="ob-context" id="obContext"></div></div>
    <div class="ob-scene" data-scene="done"><div><div class="ob-lineup" id="obLineup"></div><div class="ob-done-line" id="obDoneLine"></div></div></div>`;

  /** Shows the onboarding. Resolves once it is finished and saved. */
  function start({ settings, bots } = {}) {
    return new Promise((resolve) => {
      if ($('#onboard')) return resolve(false);
      // The user's own copies of the default bots, when they have them, so the faces match the sidebar.
      const crew = CREW.map((c) => {
        const mine = (bots || []).find((b) => String(b.name || '').toLowerCase() === c.name.toLowerCase());
        return mine && mine.avatar ? { ...c, avatar: mine.avatar } : c;
      });
      const A = window.CraftAvatar;
      const face = (bot, size) => (A ? A.renderAvatar(bot.avatar, size, { still: true }) : '');
      const state = {
        agreed: false, name: '', focus: [], other: '',
        mode: (settings && settings.accessDefault === 'once') ? 'once' : 'ask',
        sees: { calendar: false, email: false, screen: false, health: false },
      };

      const root = document.createElement('div');
      root.id = 'onboard';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', 'Set up Codeply');
      root.innerHTML = `<div class="ob">
        <section class="ob-copy">
          <div class="ob-brand"><img src="assets/logo/codeply-icon-small-48.png" alt="">Codeply</div>
          <div class="ob-progress" id="obProgress" aria-hidden="true"></div>
          <div class="ob-steps">${STEPS_HTML}</div>
        </section>
        <section class="ob-stage" aria-hidden="true">${STAGE_HTML}</section>
      </div>`;
      document.body.appendChild(root);
      const q = (s) => $(s, root);
      const qq = (s) => $$(s, root);

      const STEPS = qq('.ob-step').map((el) => el.dataset.step);
      let at = 0;
      q('#obProgress').innerHTML = STEPS.map(() => '<i></i>').join('');

      // Welcome: the crew sits on a loose ring around the mark.
      const W = q('#obOrbit').getBoundingClientRect().width || 440; // where they fly in from: the center, in pixels
      q('#obOrbit').insertAdjacentHTML('beforeend', crew.map((b, i) => {
        const a = (i / crew.length) * Math.PI * 2 - Math.PI / 2;
        const r = 40 + (i % 2) * 4; // percent of the orbit box, a little uneven
        const fx = Math.round(-Math.cos(a) * r / 100 * W);
        const fy = Math.round(-Math.sin(a) * r / 100 * W);
        return `<div class="ob-bot" style="--x:${(Math.cos(a) * r).toFixed(1)}%;--y:${(Math.sin(a) * r).toFixed(1)}%;--fx:${fx}px;--fy:${fy}px;--i:${i}"><span class="in">${face(b, i % 3 ? 64 : 76)}</span></div>`;
      }).join(''));
      q('#obCrew').innerHTML = crew.map((b, i) => `<div class="ob-member" style="--i:${i}">${face(b, 56)}<b>${esc(b.name)}</b><span>${esc(b.job)}</span></div>`).join('');
      // Terms: a few bots peek around the PC.
      const PEEK = [[0, '-8%', '-34px', 'auto', 'auto'], [3, 'auto', '-30px', '-6%', 'auto'], [4, '-10%', 'auto', 'auto', '64px'], [1, 'auto', 'auto', '-8%', '58px']];
      q('#obPc').insertAdjacentHTML('beforeend', PEEK.map(([n, left, top, right, bottom], i) => `<div class="peek" style="left:${left};top:${top};right:${right};bottom:${bottom};--i:${i}">${face(crew[n], 54)}</div>`).join(''));
      q('#obFocus').innerHTML = FOCUS.map((f) => `<button class="ob-chip" aria-pressed="false" data-focus="${esc(f)}">${esc(f)}</button>`).join('');
      q('#obModes').innerHTML = Object.entries(MODES).map(([k, m]) => `<button class="ob-choice" role="radio" aria-checked="${k === state.mode}" data-mode="${k}"><span><b>${esc(m.label)}</b><span>${esc(m.desc)}</span></span><span class="ob-radio"></span></button>`).join('');
      q('#obSources').innerHTML = SOURCES.map((s) => `<label class="ob-sw-row"><span class="t"><b>${esc(s.name)}</b><span>${esc(s.desc)}</span></span><span class="ob-switch"><input type="checkbox" data-source="${s.key}" aria-label="${esc(s.name)}"><span></span></span></label>`).join('');

      // Scenes that follow the choices
      /** What the user does, in words: the picked chips, with their own words for "Something else". */
      function doings() {
        const list = state.focus.filter((f) => f !== OTHER).map((f) => f.toLowerCase());
        if (state.focus.includes(OTHER) && state.other.trim()) list.push(state.other.trim());
        return list;
      }
      const joined = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
      function paintChat() {
        const n = state.name.trim();
        q('#obChat').innerHTML = `<div class="ob-msg">${face(crew[0], 56)}<div class="ob-bubble"><small>Orion</small>${n
          ? `Hi ${esc(n)}, good to meet you. ${doings().length ? `I'll set your agents up for ${esc(joined(doings()))}.` : 'Tell me what you are working on and I will find the right teammate.'}`
          : '<span class="ob-typing" aria-hidden="true"><i></i><i></i><i></i></span>'}</div></div>`;
      }
      function paintCard() {
        const once = state.mode === 'once';
        q('#obCard').innerHTML = `<div class="ob-swap">
          <div class="ob-card-head">${face(crew[5], 30)}<span>Axel, in your chat</span></div>
          <div class="ob-card-title">Run a command</div>
          <div class="ob-card-cmd">npm run build</div>
          <div class="ob-card-row">${once ? '<span class="note">Allowed for the rest of this chat once you say yes.</span><span class="ob-mini">Deny</span><span class="ob-mini primary">Allow</span>'
            : '<span class="ob-mini">Deny</span><span class="ob-mini">Allow for this chat</span><span class="ob-mini primary">Allow once</span>'}</div></div>`;
      }
      function paintContext() {
        const on = SOURCES.filter((s) => state.sees[s.key]);
        q('#obContext').innerHTML = `<h3>What your bots know right now</h3>${on.length
          ? on.map((s) => `<div class="ob-ctx-item ob-swap"><span class="ob-ic"><svg viewBox="0 0 24 24">${s.icon}</svg></span><div>${esc(s.ctx)}<span>${esc(s.name)}</span></div></div>`).join('')
          : '<div class="ob-ctx-empty"><span class="ob-ic"><svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a12.6 12.6 0 0 1-2.4 3.5M6.6 6.6C4.4 8 2.9 10 2 12c1 2.5 5 7 10 7a9.8 9.8 0 0 0 4.4-1"/></svg></span>Nothing yet. They only see what you turn on.</div>'}`;
      }
      function paintDone() {
        const n = state.name.trim();
        q('#obDoneTitle').textContent = n ? `You're all set, ${n}.` : "You're all set.";
        const seen = SOURCES.filter((s) => state.sees[s.key]).map((s) => s.name);
        q('#obSummary').innerHTML = [
          ['Your crew', `${crew.length} bots`],
          ['Bots ask', MODES[state.mode].label],
          ['They can see', seen.length ? seen.join(', ') : 'Nothing yet'],
        ].map(([k, v]) => `<li>${esc(k)}<span>${esc(v)}</span></li>`).join('');
        q('#obLineup').innerHTML = crew.map((b, i) => `<div class="ob-bot" style="--i:${i}">${face(b, i === 0 ? 96 : 76)}<span>${esc(b.name)}</span></div>`).join('');
        q('#obDoneLine').textContent = n ? `Say hi to Orion, ${n}. It knows the rest of the team.` : 'Say hi to Orion. It knows the rest of the team.';
      }

      // Moving between steps
      function go(to) {
        to = Math.max(0, Math.min(STEPS.length - 1, to));
        const steps = qq('.ob-step');
        const from = steps[at];
        const next = steps[to];
        from.hidden = true;
        from.classList.remove('enter');
        next.hidden = false;
        void next.offsetWidth; // restart the entrance
        next.classList.add('enter');
        at = to;
        const key = STEPS[at];
        qq('.ob-scene').forEach((s) => s.classList.toggle('on', s.dataset.scene === key));
        qq('#obProgress i').forEach((i, n) => i.classList.toggle('done', n <= at));
        if (key === 'name') paintChat();
        if (key === 'ask') paintCard();
        if (key === 'see') paintContext();
        if (key === 'done') paintDone();
        // A step with a text field starts in it; otherwise the heading takes focus for screen readers.
        const target = $('input[type="text"]', next) || $('h1', next);
        if (target) target.focus({ preventScroll: true });
      }
      const canGo = () => {
        const key = STEPS[at];
        if (key === 'terms') return state.agreed;
        if (key === 'name') return !!state.name.trim();
        return true;
      };

      root.addEventListener('click', (e) => {
        const link = e.target.closest('[data-url]');
        if (link) { e.preventDefault(); if (api && api.openExternal) api.openExternal(link.dataset.url); return; }
        if (e.target.closest('[data-next]')) { if (canGo()) go(at + 1); return; }
        if (e.target.closest('[data-back]')) { go(at - 1); return; }
        const chip = e.target.closest('[data-focus]');
        if (chip) {
          const f = chip.dataset.focus;
          const on = !state.focus.includes(f);
          state.focus = on ? [...state.focus, f] : state.focus.filter((x) => x !== f);
          chip.setAttribute('aria-pressed', String(on));
          if (f === OTHER) {
            q('#obOtherWrap').hidden = !on;
            if (on) q('#obOther').focus();
          }
          paintChat();
          return;
        }
        const mode = e.target.closest('[data-mode]');
        if (mode) {
          state.mode = mode.dataset.mode;
          qq('[data-mode]').forEach((m) => m.setAttribute('aria-checked', String(m === mode)));
          paintCard();
        }
      });
      q('#obAgree').addEventListener('change', (e) => { state.agreed = e.target.checked; q('#obAgreeNext').disabled = !state.agreed; });
      q('#obName').addEventListener('input', (e) => { state.name = e.target.value; q('#obNameNext').disabled = !state.name.trim(); paintChat(); });
      q('#obOther').addEventListener('input', (e) => { state.other = e.target.value; paintChat(); });
      q('#obSources').addEventListener('change', (e) => {
        const k = e.target.dataset.source;
        if (k) { state.sees[k] = e.target.checked; paintContext(); }
      });

      // Radio groups move with the arrow keys, like native radios.
      q('#obModes').addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) return;
        const items = qq('[data-mode]');
        const i = items.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        const n = items[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
        n.focus();
        n.click();
      });

      // Enter continues (not while a button has focus, it clicks itself); Escape goes back.
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.target.closest('button, a')) {
          e.preventDefault();
          if (STEPS[at] === 'done') q('#obFinish').click();
          else if (canGo()) go(at + 1);
        } else if (e.key === 'Escape' && at > 0) { e.stopPropagation(); go(at - 1); }
      });

      let saving = false;
      q('#obFinish').addEventListener('click', async () => {
        if (saving) return;
        saving = true;
        q('#obFinish').textContent = 'Opening Agents...';
        const name = state.name.trim();
        const focus = doings();
        let saved = null;
        try {
          saved = await api.setSettings({
            accessDefault: state.mode, onboarded: true, userName: name, focus,
            agreedToTerms: state.agreed, agreedAt: new Date().toISOString(),
          });
        } catch {}
        // Life only starts watching what was switched on.
        const sources = {};
        SOURCES.forEach((s) => s.life.forEach((k) => { sources[k] = !!state.sees[s.key]; }));
        const anyOn = SOURCES.some((s) => state.sees[s.key]);
        try { await api.lifeSet(anyOn ? { on: true, sources } : { sources }); } catch {}
        // What the crew should know about the user from day one. A failed save is not worth stopping for.
        try { if (name) await api.brainAdd({ text: `The user's name is ${name}.`, kind: 'fact' }); } catch {}
        try { if (focus.length) await api.brainAdd({ text: `The user mostly works on ${joined(focus)}.`, kind: 'fact' }); } catch {}
        root.classList.add('ob-leave');
        setTimeout(() => root.remove(), 380);
        resolve(saved && !saved.error ? saved : true);
      });

      go(0);
    });
  }

  window.CrewOnboarding = { start };
})();
