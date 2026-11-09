// Chats synced through the user's account (supabase/chats.sql), so a chat is the same everywhere:
// the phone app, mobile.codeply.app and codeply.app/chat (each keeps its own copy in the browser).
//
//   - A change (a message, a reply, a rename, a cloud task's steps) is uploaded a moment later.
//   - Other devices' changes come in every 20 seconds, when the app comes back to the front, and at
//     once when Supabase Realtime is on for the table.
//   - The newer copy of a chat wins (its updatedAt). A chat deleted on one device goes on all of them.
//   - The first time a device syncs, the chats it already has are uploaded.
//   - Without the table yet (supabase/chats.sql not run), nothing happens and nothing breaks.
// phone.js calls CraftSync.changed() from saveChats, saveBody and deleteChat.
(() => {
  'use strict';
  const C = window.CraftPhone;
  if (!C || !C.sb) return;
  const st = C.state;
  const sb = C.sb;
  const MAX_BODY = 350000;      // characters of JSON per chat; older steps are trimmed past this
  const PULL_EVERY = 20000;
  const PAGE = 200;

  let uid = null;               // the signed-in user these chats belong to
  let applying = false;         // writing what came in: those saves are not changes to send back
  let missing = false;          // no chats table yet
  let channel = null;
  let pushTimer = null, pullTimer = null, pushing = null, pulling = null;
  const dirty = new Set();      // chats to upload
  const gone = new Set();       // chats deleted here
  const known = new Map();      // id -> the updatedAt last sent or received

  const lastKey = () => `craft-sync-since-${uid}`;
  const getSince = () => { try { return Number(localStorage.getItem(lastKey())) || 0; } catch { return 0; } };
  const setSince = (t) => { try { localStorage.setItem(lastKey(), String(t)); } catch {} };
  const isMissing = (e) => /does not exist|schema cache|PGRST205|42P01|relation .*chats/i.test(`${(e && e.code) || ''} ${(e && e.message) || ''}`);

  /** phone.js: something changed. what: 'chats' (the list), 'body' (one chat), 'delete'. */
  function changed(what, id) {
    if (applying) return;
    if (!uid) tick(); // signed in before this script started watching
    if (what === 'body' && id) dirty.add(id);
    else if (what === 'delete' && id) { gone.add(id); dirty.delete(id); }
    else if (what === 'chats') for (const c of st.chats) if ((c.updatedAt || 0) !== known.get(c.id)) dirty.add(c.id);
    schedulePush();
  }
  function schedulePush(ms = 1200) { clearTimeout(pushTimer); pushTimer = setTimeout(() => push().catch(() => {}), ms); }
  function schedulePull(ms = 500) { clearTimeout(pullTimer); pullTimer = setTimeout(() => pull().catch(() => {}), ms); }

  /** What is worth sending of a chat: everything, trimmed when it is very long. */
  function slim(b) {
    const out = { ...b };
    out.messages = (b.messages || []).map((m) => (m.thumbs && JSON.stringify(m.thumbs).length > 200000 ? { ...m, thumbs: undefined } : m));
    if ((out.pcItems || []).length > 150) out.pcItems = out.pcItems.slice(-150);
    if (JSON.stringify(out).length > MAX_BODY) {
      out.pcItems = (out.pcItems || []).slice(-40);
      out.tasks = (out.tasks || []).map((t) => ({ ...t, events: (t.events || []).slice(-20) }));
    }
    if (JSON.stringify(out).length > MAX_BODY) out.messages = out.messages.map((m) => ({ ...m, thumbs: undefined })).slice(-200);
    return out;
  }
  const worthKeeping = (m, b) => !!(m.title || (b.messages || []).length || (b.tasks || []).length || m.pcSessionId);

  async function push() {
    if (!uid || missing) return;
    if (pushing) return pushing.then(() => push());
    const rows = [];
    const now = new Date().toISOString();
    for (const id of gone) rows.push({ user_id: uid, id, meta: {}, body: {}, deleted: true, updated_at: now });
    for (const id of dirty) {
      const m = C.chatMeta(id);
      if (!m) continue;
      const b = C.chatBody(id);
      if (!worthKeeping(m, b)) continue;
      rows.push({ user_id: uid, id, meta: { ...m }, body: slim(b), deleted: false, updated_at: now });
    }
    gone.clear(); dirty.clear();
    if (!rows.length) return;
    pushing = (async () => {
      for (let i = 0; i < rows.length; i += 20) {
        const chunk = rows.slice(i, i + 20);
        const { error } = await sb.from('chats').upsert(chunk, { onConflict: 'user_id,id' });
        if (error) {
          if (isMissing(error)) { missing = true; return; }
          // try again later
          for (const r of chunk) (r.deleted ? gone : dirty).add(r.id);
          schedulePush(15000);
          return;
        }
        for (const r of chunk) if (!r.deleted) known.set(r.id, r.meta.updatedAt || 0);
      }
    })();
    try { await pushing; } finally { pushing = null; }
  }

  async function pull() {
    if (!uid || missing) return;
    if (pulling) return pulling;
    pulling = (async () => {
      const first = !getSince();
      let since = getSince();
      let changedList = false, changedCurrent = false;
      for (;;) {
        let q = sb.from('chats').select('id, meta, body, deleted, updated_at').order('updated_at', { ascending: true }).limit(PAGE);
        if (since) q = q.gt('updated_at', new Date(since).toISOString());
        const { data, error } = await q;
        if (error) { if (isMissing(error)) missing = true; return; }
        applying = true;
        try {
          for (const r of data || []) {
            const res = apply(r);
            if (res) { changedList = true; if (r.id === st.current) changedCurrent = true; }
            since = Math.max(since, Date.parse(r.updated_at) || 0);
          }
          if (changedList) C.saveChats();
        } finally { applying = false; }
        setSince(since);
        if (!data || data.length < PAGE) break;
      }
      if (changedList) C.renderChatList();
      if (changedCurrent || (st.current && !C.chatMeta(st.current))) C.renderFeed();
      // A device syncing for the first time uploads the chats it already had
      if (first) { for (const c of st.chats) if (!known.has(c.id)) dirty.add(c.id); schedulePush(300); }
      if (!channel) listen();
    })();
    try { await pulling; } finally { pulling = null; }
  }

  /** One chat from the account. true when something here changed. */
  function apply(r) {
    const local = C.chatMeta(r.id);
    if (r.deleted) {
      known.delete(r.id);
      if (!local) return false;
      C.deleteChat(r.id, { silent: true, fromSync: true });
      return true;
    }
    const m = r.meta || {};
    const theirs = m.updatedAt || 0, ours = local ? local.updatedAt || 0 : -1;
    if (local && ours >= theirs) {
      if (ours > theirs) dirty.add(r.id); // ours is newer: send it
      known.set(r.id, theirs);
      return false;
    }
    if (st.busy && st.busy.has(r.id)) return false; // a reply is coming in here right now
    const meta = { ...m, id: r.id };
    if (local) { for (const k of Object.keys(local)) if (!(k in meta)) delete local[k]; Object.assign(local, meta); }
    else st.chats.push(meta);
    st.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    st.bodies.set(r.id, { messages: [], pcItems: [], tasks: [], ...(r.body || {}) });
    C.saveBody(r.id);
    known.set(r.id, theirs);
    return true;
  }

  /** Live: another device's change pulls at once (when Realtime is on for the table). */
  function listen() {
    try {
      channel = sb.channel(`chats-${uid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chats', filter: `user_id=eq.${uid}` }, () => schedulePull(300))
        .subscribe();
    } catch { channel = null; }
  }
  function stop() {
    if (channel) { try { sb.removeChannel(channel); } catch {} channel = null; }
    dirty.clear(); gone.clear(); known.clear();
  }

  // Who is signed in: start, switch or stop
  async function tick() {
    // the session itself (stored on this device), not state.user, which other code refreshes from the network
    let id = null;
    try { const s = await C.currentSession(); id = (s && s.user && s.user.id) || null; } catch {}
    if (document.getElementById('app').classList.contains('hidden')) id = null; // signed out, or not in yet
    if (id !== uid) { stop(); uid = id || null; missing = false; if (uid) schedulePull(200); return; }
    if (uid && document.visibilityState === 'visible') schedulePull(0);
  }
  setInterval(tick, PULL_EVERY);
  // sign-in can finish before this script runs, or a little after: look often until someone is signed in
  const early = setInterval(() => { if (uid) clearInterval(early); else tick(); }, 2000);
  setTimeout(tick, 300);
  // signing in: the app appears
  const app = document.getElementById('app');
  if (app) new MutationObserver(() => setTimeout(tick, 300)).observe(app, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tick(); schedulePull(0); } else push().catch(() => {}); });
  addEventListener('pagehide', () => { push().catch(() => {}); });
  // without the table, look again now and then (it may have been made since)
  setInterval(() => { if (missing) { missing = false; schedulePull(0); } }, 5 * 60 * 1000);

  window.CraftSync = { changed, pull, push, get state() { return { uid, missing, dirty: [...dirty], gone: [...gone], live: !!channel }; } };
})();
