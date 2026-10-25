// Codeply Crew on iPhone: sign-in and the relay to the PC.
//
// Same Supabase project and relay protocol as the phone app (phone.js): the
// PC listens on a Realtime channel named after the user and their relay
// secret, and answers /api/bots requests with the bots on that PC. This file
// is also the window.CraftPhone that phone-calls.js (the shared call engine)
// expects; Crew has no cloud runner, so those hooks are empty.
'use strict';

(() => {
  const SUPABASE_URL = 'https://zswkhfkfseclgadhvobg.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpzd2toZmtmc2VjbGdhZGh2b2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzYyOTgsImV4cCI6MjA5NTgxMjI5OH0.EoTQdIGQQDrN1uEqQfya3VmrQMT68jkzPLphbLwNTWg';
  const AI_PROXY_URL = `${SUPABASE_URL}/functions/v1/ai-proxy`;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const randHex = (n) => { const b = new Uint8Array(Math.ceil(n / 2)); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, n); };
  const newId = () => Date.now().toString(36) + randHex(6);

  // This phone, for the daily limits (sent as x-codeply-device, like phone.js).
  let device = '';
  try { device = localStorage.getItem('codeply.device') || ''; } catch {}
  if (!/^[a-f0-9]{64}$/.test(device)) { device = randHex(64); try { localStorage.setItem('codeply.device', device); } catch {} }
  const deviceHeader = () => ({ 'x-codeply-device': device });

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'crew-ios-auth' },
  });
  async function currentSession() { const { data } = await sb.auth.getSession(); return (data && data.session) || null; }
  async function accessToken() {
    const s = await currentSession();
    if (!s) throw new Error('You are signed out. Sign in again.');
    return s.access_token;
  }

  // ─── Relay (same protocol as phone.js) ──────────────────────────────────────
  const RELAY_CHUNK = 60000;
  const relay = { channel: null, pcId: null, pcs: [], pending: new Map(), parts: new Map(), connecting: null, noPc: false, retry: null, user: null };
  const emit = (name) => window.dispatchEvent(new CustomEvent(name));

  function relaySend(event, obj) {
    if (!relay.channel) return;
    const str = JSON.stringify(obj);
    const id = newId();
    const n = Math.max(1, Math.ceil(str.length / RELAY_CHUNK));
    for (let i = 0; i < n; i++) relay.channel.send({ type: 'broadcast', event, payload: { id, i, n, d: str.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK) } });
  }
  function relayAssemble(payload) {
    if (!payload || typeof payload.d !== 'string') return null;
    if (payload.n === 1) { try { return JSON.parse(payload.d); } catch { return null; } }
    if (payload.n > 200) return null;
    for (const [k, e] of relay.parts) if (Date.now() - e.at > 60000) relay.parts.delete(k);
    let entry = relay.parts.get(payload.id);
    if (!entry) { entry = { n: payload.n, got: 0, chunks: [], at: Date.now() }; relay.parts.set(payload.id, entry); }
    if (entry.chunks[payload.i] === undefined) { entry.chunks[payload.i] = payload.d; entry.got++; }
    if (entry.got < entry.n) return null;
    relay.parts.delete(payload.id);
    try { return JSON.parse(entry.chunks.join('')); } catch { return null; }
  }
  function updatePcs() {
    const ps = relay.channel ? relay.channel.presenceState() : {};
    relay.pcs = Object.entries(ps).map(([key, metas]) => ({ deviceId: key, ...(metas[0] || {}) })).sort((a, b) => (b.since || 0) - (a.since || 0));
    const was = relay.pcId;
    if (!relay.pcs.some((p) => p.deviceId === relay.pcId)) relay.pcId = (relay.pcs[0] && relay.pcs[0].deviceId) || null;
    emit('crew:pc');
    if (relay.pcId && relay.pcId !== was) emit('craft:pc-online'); // phone-calls.js refreshes the bots
  }
  async function openRelay() {
    if (relay.channel) return;
    const { data, error } = await sb.auth.getUser();
    if (error || !data || !data.user) throw new Error('signed out');
    relay.user = data.user;
    const secret = data.user.user_metadata && data.user.user_metadata.craft_relay;
    if (!secret) { relay.noPc = true; emit('crew:pc'); return; } // never signed in on a PC
    const channel = sb.channel(`craft-${data.user.id}-${secret}`, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'res' }, ({ payload }) => {
      const msg = relayAssemble(payload);
      if (!msg) return;
      const p = relay.pending.get(msg.id);
      if (!p) return;
      relay.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.status >= 200 && msg.status < 300) p.resolve(msg.body);
      else p.reject(Object.assign(new Error((msg.body && msg.body.error) || 'Your PC could not do that.'), { status: msg.status }));
    });
    channel.on('presence', { event: 'sync' }, updatePcs);
    relay.channel = channel;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 12000);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(status)); }
      });
    });
  }
  async function closeRelay() {
    clearTimeout(relay.retry);
    for (const [, p] of relay.pending) { clearTimeout(p.timer); p.reject(new Error('Disconnected.')); }
    relay.pending.clear();
    if (relay.channel) { try { await sb.removeChannel(relay.channel); } catch {} }
    Object.assign(relay, { channel: null, pcId: null, pcs: [], connecting: null });
    emit('crew:pc');
  }
  /** Connect in the background and keep retrying quietly. */
  function startRelay() {
    if (relay.connecting || relay.channel) return relay.connecting;
    relay.connecting = openRelay().catch(async (e) => {
      if (relay.channel) { try { await sb.removeChannel(relay.channel); } catch {} relay.channel = null; }
      if (e.message !== 'signed out') { clearTimeout(relay.retry); relay.retry = setTimeout(startRelay, 15000); }
    }).finally(() => { relay.connecting = null; });
    return relay.connecting;
  }
  async function relayRequest(method, path, reqBody, timeoutMs = 25000) {
    if (!relay.channel || !relay.pcId) throw new Error('Your PC is offline.');
    const id = newId();
    const token = await accessToken();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { relay.pending.delete(id); reject(Object.assign(new Error("Your PC didn't answer. Make sure it's on, awake and online."), { timeout: true })); }, timeoutMs);
      relay.pending.set(id, { resolve, reject, timer });
      relaySend('req', { id, to: relay.pcId, method, path, body: reqBody == null ? null : reqBody, accessToken: token });
    });
  }
  // iOS pauses the app in the background and the socket can die: reconnect on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && relay.user && !relay.channel) startRelay();
  });

  const pcName = () => { const m = relay.pcs.find((p) => p.deviceId === relay.pcId); return (m && m.device) || 'Your PC'; };

  window.CraftPhone = {
    sb, relay, relayRequest, accessToken, esc, load, save, newId, deviceHeader, AI_PROXY_URL, SUPABASE_ANON_KEY,
    closeDrawer() {}, cloudEnvForBots: () => null, startCloudTask: null, pollCloudTask: null,
  };
  window.CrewCore = { sb, relay, startRelay, closeRelay, relayRequest, accessToken, currentSession, esc, load, save, newId, deviceHeader, pcName, AI_PROXY_URL, SUPABASE_ANON_KEY };
})();
