// Models: the list the composer picks from, adding your own, and keeping them in step with the
// Codeply account (the phone). It is main.js's "Models" block (models:* and ollamaCloud:* IPC) over
// HTTP, on the same files, so the Electron app and this one see the same models:
//   ~/.codeply/config.json   selectedModel, models[] (config.js; keys never leave this PC except to
//                            the base URL they were entered for, and, with "Use on my phone" on, once
//                            to the account's user-models function, model-sync.js)
// The chat run reads the selection through routeFor() in engine.mjs; "auto" is Haze 2.
//
//   GET    /ext/models[?sync=1]      { selected, models[], signedIn }; sync=1 also catches the phone up
//   POST   /ext/models/select        { id }                  'auto' or a model id
//   POST   /ext/models/save          { id?, kind, name, baseUrl, model, apiKey?, phone?, skipTest? }
//   DELETE /ext/models/:id
//   POST   /ext/models/effort        { id, effort }          '' for the provider's default
//   POST   /ext/models/effort-levels { id, force? }          asks the provider which levels it takes
//   POST   /ext/models/phone         { id, on }
//   GET    /ext/models/ollama[?host=]   the models an Ollama host has pulled, and whether it runs
//
// Every answer is 200 with { ok, error?, state? } so the app reads the reason; 4xx only for a bad
// request. Models that ask for a key never send it back: the list carries `hasKey` and a preview.

const AUTO = 'auto';
let phoneUserId = null;
let syncing = null;

const libs = (ctx) => ({
  config: ctx.need('config.js'),
  sync: ctx.need('model-sync.js'),
  ai: ctx.need('ai.js'),
  auth: ctx.need('auth.js'),
});

async function userId(auth) {
  try { const s = await auth.getSession(); return (s && s.user && s.user.id) || null; } catch { return null; }
}

function publicModel(L, m) {
  const phone = L.sync.phoneStatus(m, phoneUserId);
  return {
    id: m.id, name: m.name, kind: m.kind, baseUrl: m.baseUrl, model: m.model, effort: m.effort || '',
    effortLevels: Array.isArray(m.effortLevels) && m.effortFor === `${m.baseUrl}|${m.model}` ? m.effortLevels : null,
    effortNote: m.effortNote || '',
    hasKey: !!m.apiKey, keyPreview: m.apiKey ? L.config.maskKey(m.apiKey) : '',
    phone, synced: phone.synced,
  };
}

/** What the app shows. The ChatGPT plan's models are not offered here (the Electron menu dropped them too). */
function state(L) {
  return {
    selected: L.config.getSelectedModelId(),
    models: L.config.getModels().filter((m) => m.kind !== 'chatgpt').map((m) => publicModel(L, m)),
  };
}

function phoneClient(L) {
  return L.sync.createModelSync({
    getAccessToken: () => L.auth.getAccessToken(),
    url: `${L.auth.SUPABASE_URL}/functions/v1/user-models`,
    anonKey: L.auth.SUPABASE_ANON_KEY,
  });
}

/** Sends one model to the account if its toggle is on. withKey re-sends the key. */
async function pushToPhone(ctx, L, id, { withKey = false } = {}) {
  const m = L.config.getModel(id);
  if (!m || m.phone !== true) return { ok: true, skipped: true };
  phoneUserId = await userId(L.auth);
  const blocker = L.sync.phoneBlocker(m);
  if (blocker) return { ok: false, error: blocker };
  const fresh = withKey || !m.phoneSyncedAt || m.phoneUser !== phoneUserId;
  const r = await phoneClient(L).push(m, { withKey: fresh });
  L.config.setModelPhone(id, r.ok
    ? { phoneSyncedAt: Date.now(), phoneUser: phoneUserId, phoneError: '' }
    : { phoneError: r.error, ...(fresh ? { phoneSyncedAt: 0 } : {}) });
  ctx.emit(null, { type: 'models_changed' });
  return r;
}

async function removeFromPhone(L, id) {
  const r = await phoneClient(L).remove(id);
  if (r.ok) L.config.setModelPhone(id, { phoneSyncedAt: 0, phoneError: '' });
  return r;
}

/** After a sign-in or time offline: finish queued removals, then sync every model whose toggle is on. */
function syncPhoneModels(ctx, L) {
  if (!syncing) {
    syncing = (async () => {
      phoneUserId = await userId(L.auth);
      if (!phoneUserId) return;
      const client = phoneClient(L);
      const pending = L.config.getPhoneDeletes();
      if (pending.length) {
        const left = [];
        for (const d of pending) {
          if (d.user && d.user !== phoneUserId) { left.push(d); continue; } // another account's: wait for it
          const r = await client.remove(d.id);
          if (!r.ok) left.push(d);
        }
        L.config.setPhoneDeletes(left);
        ctx.emit(null, { type: 'models_changed' });
      }
      for (const m of L.config.getModels()) {
        if (m.phone !== true || L.sync.phoneBlocker(m)) continue;
        if (m.phoneSyncedAt && !m.phoneError && m.phoneUser === phoneUserId) continue;
        await pushToPhone(ctx, L, m.id); // emits models_changed itself
      }
    })().catch(() => {}).finally(() => { syncing = null; });
  }
  return syncing;
}

/** Tests, saves and selects a model, then syncs it to the phone. main.js's saveModelInput. */
async function saveModel(ctx, L, input) {
  const existing = input && input.id ? L.config.getModel(String(input.id)) : null;
  const keyGiven = input && input.apiKey !== undefined && input.apiKey !== null;
  const candidate = {
    kind: input && input.kind === 'ollama' ? 'ollama' : 'openai',
    name: String((input && input.name) || '').trim(),
    baseUrl: String((input && input.baseUrl) || '').trim().replace(/\/+$/, ''),
    model: String((input && input.model) || '').trim(),
    apiKey: keyGiven ? String(input.apiKey).trim() : ((existing && existing.apiKey) || ''),
  };
  // A saved key only ever goes to the URL it was entered for.
  if (existing && candidate.baseUrl !== existing.baseUrl && !keyGiven) {
    return { ok: false, error: 'You changed the base URL, so enter the API key again for the new address.' };
  }
  if (!candidate.model) return { ok: false, error: 'Enter the model id.' };
  if (!/^https?:\/\//i.test(candidate.baseUrl)) return { ok: false, error: 'The base URL must start with http:// or https://.' };
  if (!(input && input.skipTest)) {
    const t = await L.ai.testModel(candidate);
    if (!t.ok) return { ok: false, testFailed: true, error: t.error };
  }
  // "Use on my phone" defaults to on for a new model; an edit keeps the choice.
  const phone = input && typeof input.phone === 'boolean' ? input.phone : (existing ? existing.phone : true);
  const saved = L.config.saveModel({ ...input, ...candidate, id: existing && existing.id, phone });
  if (!saved.ok) return saved;
  L.config.selectModel(saved.model.id);
  const keyChanged = !existing || candidate.apiKey !== existing.apiKey || candidate.baseUrl !== existing.baseUrl;
  if (phone === true && !L.sync.phoneBlocker(saved.model)) pushToPhone(ctx, L, saved.model.id, { withKey: keyChanged }).catch(() => {});
  else if (existing && existing.phoneSyncedAt) removeFromPhone(L, saved.model.id).then(() => ctx.emit(null, { type: 'models_changed' })).catch(() => {});
  return { ok: true, model: publicModel(L, saved.model), state: state(L) };
}

export function start(ctx) {
  // The ChatGPT plan's models were dropped from the menu: anyone still on one goes back to Haze 2.
  try {
    const config = ctx.need('config.js');
    const sel = config.getModel(config.getSelectedModelId());
    if (sel && sel.kind === 'chatgpt') config.selectModel(AUTO);
  } catch { /* no config yet */ }
}

export async function route(ctx, req, res, url, p, reply) {
  if (p !== '/ext/models' && !p.startsWith('/ext/models/')) return false;
  const L = libs(ctx);
  const done = (r) => { reply(200, r); return true; };
  const rest = p.slice('/ext/models'.length);

  if (req.method === 'GET' && rest === '') {
    if (url.searchParams.get('sync')) syncPhoneModels(ctx, L);
    phoneUserId = phoneUserId || await userId(L.auth);
    return done({ ...state(L), signedIn: !!phoneUserId });
  }
  if (req.method === 'GET' && rest === '/ollama') {
    const r = await L.ai.listOllamaModels(url.searchParams.get('host') || 'http://localhost:11434');
    return done(r);
  }
  if (req.method === 'POST' && rest === '/select') {
    const body = await ctx.readJson(req);
    const r = L.config.selectModel(String(body.id || AUTO));
    return done(r.ok ? { ok: true, state: state(L) } : r);
  }
  if (req.method === 'POST' && rest === '/save') {
    return done(await saveModel(ctx, L, await ctx.readJson(req)));
  }
  if (req.method === 'POST' && rest === '/effort') {
    const body = await ctx.readJson(req);
    const r = L.config.setModelEffort(String(body.id || ''), String(body.effort || ''));
    return done(r.ok ? { ok: true, state: state(L) } : r);
  }
  if (req.method === 'POST' && rest === '/effort-levels') {
    const body = await ctx.readJson(req);
    const m = L.config.getModel(String(body.id || ''));
    if (!m) return done({ ok: false, error: 'Effort can only be set on your own models.' });
    if (!body.force && Array.isArray(m.effortLevels) && m.effortFor === `${m.baseUrl}|${m.model}`) return done({ ok: true, state: state(L) });
    const r = await L.ai.probeEffortLevels(m);
    if (!r.ok) return done(r);
    const w = L.config.setModelEffortLevels(m.id, r);
    return done(w.ok ? { ok: true, state: state(L) } : w);
  }
  if (req.method === 'POST' && rest === '/phone') {
    const body = await ctx.readJson(req);
    const id = String(body.id || '');
    const m = L.config.getModel(id);
    if (!m) return done({ ok: false, error: 'Unknown model.' });
    if (body.on) {
      const blocker = L.sync.phoneBlocker(m);
      if (blocker) return done({ ok: false, error: blocker, state: state(L) });
      L.config.setModelPhone(id, { phone: true });
      const r = await pushToPhone(ctx, L, id, { withKey: true });
      return done({ ok: !!r.ok, error: r.ok ? undefined : r.error, state: state(L) });
    }
    L.config.setModelPhone(id, { phone: false });
    let r = { ok: true };
    if (m.phoneSyncedAt) r = await removeFromPhone(L, id);
    if (!r.ok) L.config.setModelPhone(id, { phoneError: r.error });
    ctx.emit(null, { type: 'models_changed' });
    return done({ ok: !!r.ok, error: r.ok ? undefined : `Turned off here, but it is still on your account: ${r.error}`, state: state(L) });
  }
  const del = /^\/([^/]+)$/.exec(rest);
  if (req.method === 'DELETE' && del) {
    const id = decodeURIComponent(del[1]);
    const r = L.config.deleteModel(id);
    // A synced copy is queued for removal (config.js) and removed now if possible.
    if (r.ok && L.config.getPhoneDeletes().some((d) => d.id === id)) syncPhoneModels(ctx, L);
    return done(r.ok ? { ok: true, state: state(L) } : r);
  }
  reply(404, { error: 'Not found.' });
  return true;
}
