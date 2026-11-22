// Saving a specialist from the app's editor (name, focus, instructions or house rules, Always on,
// face), the same change ext-agentsync's /ext/agentsync/specialists/update makes, under a path no
// other extension reads: a POST to any path starting "/ext/agents" can have its body read by
// ext-agents.mjs first, which leaves the request hanging.
//
//   POST /ext/specs/update   { id, name?, focus?, instructions?, voice?, alwaysOn?, shape?, color?, gear?, notes?, model? }
//                            -> { ok, error? }; the app reads /ext/agentsync/specialists again after
//
// Emits `team_changed`, and asks the account sync to send the change soon, so the phone follows.
const FIELDS = ['name', 'focus', 'instructions', 'voice', 'alwaysOn', 'shape', 'color', 'gear', 'notes', 'model'];

export async function route(ctx, req, res, url, p, reply) {
  if (!(req.method === 'POST' && p === '/ext/specs/update')) return false;
  try {
    const b = await ctx.readJson(req).catch(() => ({}));
    const w = ctx.need('wisp.js');
    const s = w.listSpecialists().find((x) => x.id === b.id);
    if (!s) { reply(200, { ok: false, error: 'No one on your team has that id.' }); return true; }
    const patch = {};
    for (const k of FIELDS) if (b[k] !== undefined) patch[k] = b[k];
    const r = w.updateSpecialist(s.id, patch);
    try { ctx.emit(null, { type: 'team_changed' }); } catch { /* nobody listening */ }
    try { ctx.shared.sync && ctx.shared.sync.syncSoon && ctx.shared.sync.syncSoon(500); } catch { /* next tick */ }
    reply(200, r ? { ok: true } : { ok: false, error: 'It was not saved.' });
  } catch (e) {
    reply(200, { ok: false, error: e.message });
  }
  return true;
}
