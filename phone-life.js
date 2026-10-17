// Bots at work, on the phone: what the user's bots are doing by themselves.
//
// The PC runs the autopilot (autopilot.js). From the Calls panel the user
// can see what is waiting to go out (an email, a deploy, a post held for a
// few minutes) and cancel it or send it now, see tasks in progress, and stop
// every bot at once. It asks the PC over the relay (GET /api/life), so it
// only shows while the PC is online; with the PC off, nothing runs anyway.
(() => {
  const P = window.CraftPhone;
  if (!P) return;
  const { esc } = P;
  let mounted = null;
  let data = null;
  let error = '';
  let lastFetch = 0;

  const when = (t) => {
    const m = Math.round((t - Date.now()) / 60000);
    if (m <= 0) return 'now';
    if (m < 60) return `in ${m} min`;
    return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  function html() {
    if (!data) return error ? `<div class="life-card"><p class="calls-status err">${esc(error)}</p></div>` : '';
    const { paused, outbox = [], tasks = [] } = data;
    if (!paused && !outbox.length && !tasks.length) return '';
    const name = (id) => ((data.bots || []).find((b) => b.id === id) || {}).name || 'A bot';
    return `<div class="life-card">
      <div class="life-head"><strong>Bots at work</strong>${paused ? '<button type="button" class="life-btn" data-life="resume">Resume</button>' : '<button type="button" class="life-btn danger" data-life="stop">Stop all bots</button>'}</div>
      ${paused ? '<p class="calls-status">All bots are stopped. Nothing runs on its own until you resume.</p>' : ''}
      ${outbox.map((o) => `<div class="life-row"><span class="bot-main"><strong>${esc(o.title)}</strong><small>${esc(name(o.botId))} · ${o.status === 'needs_you' ? 'needs your OK' : `goes ${esc(when(o.dueAt))}`}</small></span>
        <button type="button" class="life-btn" data-out="${esc(o.id)}" data-act="now">${o.status === 'needs_you' ? 'Allow' : 'Send now'}</button><button type="button" class="life-btn danger" data-out="${esc(o.id)}" data-act="cancel">Cancel</button></div>`).join('')}
      ${tasks.map((t) => `<div class="life-row"><span class="bot-main"><strong>${esc(t.text)}</strong><small>${esc(name(t.botId))} · ${esc(String(t.status).replace('_', ' '))}</small></span></div>`).join('')}
    </div>`;
  }

  function paint() {
    if (!mounted || !mounted.isConnected) { mounted = null; return; }
    mounted.innerHTML = html();
    mounted.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await P.relayRequest('POST', '/api/life/outbox', { id: b.dataset.out, action: b.dataset.act }); } catch (e) { error = e.message; }
      refresh(true);
    }));
    mounted.querySelectorAll('[data-life]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await P.relayRequest('POST', b.dataset.life === 'stop' ? '/api/life/stop' : '/api/life/resume', {}); } catch (e) { error = e.message; }
      refresh(true);
    }));
  }

  async function refresh(force) {
    if (!force && Date.now() - lastFetch < 10000) { paint(); return; }
    lastFetch = Date.now();
    try { data = await P.relayRequest('GET', '/api/life'); error = ''; }
    catch (e) { data = null; error = /404|not found/i.test(e.message) ? '' : ''; }
    paint();
  }

  /** phone-calls.js gives us a spot in the Calls panel. */
  function mount(el) {
    if (!el) return;
    mounted = el;
    paint();
    refresh(false);
  }

  window.CraftLife = { mount, refresh };
})();
