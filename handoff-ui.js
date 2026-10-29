// The handoff line above the chat composer (handoff-desktop.js sends the
// 'handoff' events): a quiet "Cloud backup on" while a protected run goes,
// and the orange box when this PC is offline or the task is in the cloud.
// Loaded after app.js and uses its globals (api, state).
(() => {
  if (!window.craft || !window.craft.handoffStatus) return;

  const WARN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/></svg>';
  let el = null;
  let last = { status: 'off' };
  let ticker = null;

  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s} s ago`;
    return `${Math.round(s / 60)} min ago`;
  }

  function host() {
    if (el && el.isConnected) return el;
    const composer = document.querySelector('.chat-composer .composer');
    if (!composer) return null;
    el = document.createElement('div');
    el.className = 'handoff-line hidden';
    el.setAttribute('role', 'status');
    composer.parentNode.insertBefore(el, composer);
    return el;
  }

  function warn(text) {
    return `<div class="handoff-warn">${WARN_ICON}<span>${text}</span></div>`;
  }

  function paint() {
    const box = host();
    if (!box) return;
    const d = last;
    let html = '';
    if (d.status === 'protected' || d.status === 'starting') {
      html = `<div class="handoff-quiet"><span class="handoff-dot"></span>Cloud backup on${d.savedAt ? ` · saved ${ago(d.savedAt)}` : ''}</div>`;
    } else if (d.status === 'offline_local') {
      html = warn(`You're offline. Cloud backup is paused, so changes since ${clock(d.since || d.savedAt || Date.now())} aren't backed up. Codeply keeps working here and backs them up when you're back.`);
    } else if (d.status === 'offline') {
      html = warn("You're offline. If the connection doesn't come back soon, this task pauses here and the cloud carries it on.");
    } else if (d.status === 'paused') {
      html = warn('Paused: no connection. If this PC stays offline, the cloud carries the task on, and it comes back here when you are online.');
    } else if (d.status === 'cloud') {
      html = warn('The cloud has this task while this PC was offline. It comes back here when you are online.');
    } else if (d.status === 'returning' || d.status === 'resuming') {
      html = '<div class="handoff-quiet"><span class="handoff-dot busy"></span>Bringing this task back from the cloud...</div>';
    }
    box.innerHTML = html;
    box.classList.toggle('hidden', !html);
    clearInterval(ticker);
    if (d.status === 'protected' && d.savedAt) ticker = setInterval(paint, 5000);
  }

  /** A 'handoff' event for the open chat. */
  function render(data) {
    last = { ...data };
    paint();
  }

  /** The chat changed: ask where it stands. */
  async function show(sessionId) {
    last = { status: 'off' };
    paint();
    if (!sessionId) return;
    try {
      const s = await window.craft.handoffStatus(sessionId);
      if (sessionId === state.currentSessionId && s) render(s);
    } catch {}
  }

  window.CraftHandoff = { render, show };
})();
