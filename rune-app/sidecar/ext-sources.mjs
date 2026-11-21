// "Searched the web" under a reply, as the phone shows it: the pages a turn searched or opened
// (web_search, web_fetch), kept on that reply as `sources: [{ url, title, host }]` (the phone's
// own field), so the app draws them as chips that open in the browser.
//
// It watches each run's tool results (engine.mjs hooks.runEvent) and, when the run ends, puts what
// it found on the run's last answer and tells the app (`session_sync`).
const MAX = 8;
const pending = new Map(); // session id -> [{ url, title, host }]
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const clean = (u) => String(u || '').replace(/[.,;:!?]+$/, '');

function add(sessionId, url, title = '') {
  const u = clean(url);
  const host = hostOf(u);
  if (!host || host === 'localhost' || /^127\.|^\[?::1/.test(host)) return;
  const list = pending.get(sessionId) || [];
  if (list.some((s) => s.url === u) || list.length >= MAX) return;
  list.push({ url: u, title: String(title || '').slice(0, 120) || host, host });
  pending.set(sessionId, list);
}

/** Pages a tool result names: the page web_fetch opened, and the links a search returned. */
export function sourcesOf(ev) {
  const name = String(ev.name || '').replace(/^dsh:/, '');
  if (!/^(web_search|web_fetch|fetch|WebSearch|WebFetch)$/.test(name) || ev.ok === false) return [];
  const out = [];
  const a = ev.args && typeof ev.args === 'object' ? ev.args : {};
  if (a.url) out.push({ url: a.url, title: '' });
  const text = String(ev.output || '');
  for (const line of text.split('\n')) {
    const m = line.match(URL_RE);
    if (!m) continue;
    // "Title - https://..." or "[Title](https://...)": the words before the link are its title.
    const before = line.slice(0, line.indexOf(m[0])).replace(/[[\]()*#>-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\d+[.)]\s*/, '');
    for (const u of m) out.push({ url: u, title: before.slice(0, 120) });
  }
  return out;
}

export function start(ctx) {
  ctx.hooks.runEvent.push((session, ev) => {
    if (!session || !ev || ev.type !== 'tool_end') return;
    for (const s of sourcesOf(ev)) add(session.id, s.url, s.title);
  });
  ctx.hooks.runEnd.push((session) => {
    const list = session && pending.get(session.id);
    if (!list) return;
    pending.delete(session.id);
    const last = [...(session.messages || [])].reverse().find((m) => m && m.kind === 'assistant' && !m.interim);
    if (!last || !list.length) return;
    last.sources = list;
    try { ctx.api.save(); } catch { /* saved with the next change */ }
    try { ctx.emit(session.id, { type: 'session_sync', session: ctx.api.meta(session) }); } catch { /* nobody listening */ }
  });
}

export function route() {
  return false;
}
