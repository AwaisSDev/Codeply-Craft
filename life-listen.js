// Listening in the background (the Life source "heard"), free and on this PC.
//
// While Life and "Listen in the background" are on (and the user confirmed
// they tell people an assistant is listening), a hidden window keeps the mic
// open and cuts what it hears into utterances; Whisper turns each into text in
// its own process (the call helper's, call-listen.js). That text stays in
// memory only. After a quiet minute and a half, or every ten minutes of talk,
// one model call picks out what matters (to-dos, decisions, people, ideas,
// numbers and dates, plans) and only that joins the life context. The rest of
// the text is dropped, and no audio is ever kept.
//
// It pauses while the call helper has a call (that keeps its own transcript)
// and closes the mic when Life, the source or the consent goes off.
//
// main.js wires this in with init(deps); nothing here reaches into main.js.
const path = require('path');
const { BrowserWindow, session, ipcMain } = require('electron');

let deps = null;
let win = null;
const PARTITION = 'persist:craft-lifelisten';
const S = { lines: [], first: 0, last: 0, extracting: false, mic: false, error: '', heardAt: 0, savedAt: 0, run: null };
const lib = (name) => require(path.join(deps.cliDir, 'lib', name));
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const KINDS = ['todo', 'decision', 'person', 'idea', 'info'];
const DAY = 86400000;
// Two lines say the same thing when most words of the shorter one are in the other.
const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function sameThing(a, b) {
  const A = new Set(words(a)); const B = new Set(words(b));
  if (!A.size || !B.size) return false;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.75;
}
// Whisper's usual guesses for a room with no one talking.
const NOISE = /^\W*(you|thank you|thanks|thanks for watching|bye|okay|ok|so|hmm+|uh+|um+|oh|yeah|music)\W*$|subtitles by|amara\.org|^\W*$/i;

function callActive() { const c = deps.callState && deps.callState(); return !!(c && c.active); }
function wanted() {
  const life = deps.life;
  return life.isOn() && life.sourceOn('heard') && !!life.settings().calls.consentAck;
}

/** Open or close the mic to match the settings; called on every change and every few seconds. */
function sync() {
  if (!deps) return;
  const on = wanted() && !callActive();
  if (on && !win) open();
  else if (!on && win) close();
  maybeExtract(!on);
}

function open() {
  win = new BrowserWindow({
    show: false, width: 320, height: 200, skipTaskbar: true, title: 'Codeply Life listening',
    webPreferences: { preload: path.join(__dirname, 'life-listen', 'preload.js'), contextIsolation: true, nodeIntegration: false, partition: PARTITION, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'life-listen', 'index.html'));
  win.on('closed', () => { win = null; S.mic = false; });
  S.error = '';
  push();
}
function close() {
  const w = win; win = null; S.mic = false;
  try { if (w && !w.isDestroyed()) w.destroy(); } catch {}
  push();
}

async function chunk(pcm) {
  if (!win) return;
  const text = short(await deps.transcribe(pcm), 1000);
  if (!text || NOISE.test(text)) return;
  if (process.env.CRAFT_LIFE_DEBUG) console.log('[life listen] heard:', text);
  const now = Date.now();
  if (!S.first) S.first = now;
  S.last = now; S.heardAt = now;
  S.lines.push({ text, at: now });
  if (S.lines.length > 400) S.lines = S.lines.slice(-400);
}

const wordCount = (lines) => lines.reduce((n, l) => n + l.text.split(/\s+/).length, 0);

/** Time to pick out what matters: after a quiet 90 s, after 10 min of talk, or when the mic closes. */
function maybeExtract(force = false) {
  if (S.extracting || !S.lines.length) return;
  const now = Date.now();
  const quiet = now - S.last > 90000;
  const long = now - S.first > 10 * 60000;
  if (!force && !quiet && !long) return;
  // A few words here and there are not worth a model call: dropped once things go quiet.
  if (wordCount(S.lines) < 25) { if (quiet || force) { S.lines = []; S.first = 0; } return; }
  const lines = S.lines; S.lines = []; S.first = 0;
  S.extracting = true;
  S.run = { at: Date.now(), words: wordCount(lines), saved: 0, error: '' };
  extract(lines)
    .catch((e) => { S.run.error = String(e.message || e).slice(0, 200); console.warn('[life listen] extract:', e.message); })
    .finally(() => { S.extracting = false; push(); });
}

function clock(t, tz) { try { return new Date(t).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }

function heardPrompt({ lines, tz, now, doing, screen, plansAsk, kept = [] }) {
  const heard = lines.map((l) => `[${clock(l.at, tz)}] ${l.text}`).join('\n');
  const where = doing && doing.app ? `On the user's screen: ${doing.app}${doing.title ? `, "${short(doing.title, 100)}"` : ''}.` : '';
  const words = screen && screen.text && now - (screen.at || 0) < 5 * 60000 ? `Words on screen: "${short(screen.text, 500)}"` : '';
  return `You are the shared memory of the user's assistant bots. Below is what the PC's microphone heard around the user in the last few minutes, turned into text by speech recognition. It makes mistakes, and it does not say who is talking: it may be the user, people with them, someone on speaker, or a video, game or TV playing.

It is ${new Date(now).toLocaleString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} (${tz}). ${where}
${words}

Heard:
${heard}

Keep only what the user would want their assistants to remember later:
- todo: things the user promised or needs to do ("I'll send it tomorrow", "remind me to call mom")
- decision: what was decided or agreed
- person: facts about people the user knows (names, news, birthdays, preferences)
- idea: an idea the user had that is worth keeping
- info: numbers, addresses, prices, dates or deadlines said out loud
Ignore small talk, filler, songs, videos, TV, games, and anything unclear. Most of the time there is nothing worth keeping: then return empty lists.
${kept.length ? `\nAlready kept, do not repeat these:\n${kept.map((t) => `- ${t}`).join('\n')}\n` : ''}

${plansAsk || ''}

Respond with ONLY JSON: {"items": [{"kind": "todo|decision|person|idea|info", "title": "one short line a person can read at a glance, like: Promised Ali the deck by Friday", "detail": "one or two sentences with the specifics", "people": ["names mentioned"]}], "plans": []}`;
}

async function extract(lines) {
  const store = deps.life.getStore();
  if (!store || !deps.life.isOn()) throw new Error('Life is off');
  const L = lib('life.js');
  const tz = deps.life.localTz();
  const now = Date.now();
  const recent = store.items({ sources: ['heard'], from: now - 2 * DAY, limit: 60 });
  const prompt = heardPrompt({
    lines, tz, now,
    doing: deps.life.sourceOn('activity') ? store.getState('activity.current') : null,
    screen: deps.life.sourceOn('screen') ? store.getState('activity.screen') : null,
    plansAsk: deps.life.sourceOn('plans') ? L.plansAsk(now, tz) : '',
    kept: recent.slice(0, 30).map((x) => x.title),
  });
  const r = await lib('telemetry.js').withProduct('crew', () => deps.aiLib().chatJson([{ role: 'user', content: prompt }], { route: deps.currentRoute() }));
  if (!r || !r.success || !r.json) throw new Error((r && r.error) || 'no answer');
  const at = lines[0].at; const end = lines[lines.length - 1].at;
  const items = Array.isArray(r.json.items) ? r.json.items.slice(0, 8) : [];
  let saved = 0;
  items.forEach((x, i) => {
    const title = short(x && x.title, 140);
    if (!title || title.length < 4) return;
    // Heard twice (the same talk, or the model repeating itself): kept once.
    if (recent.some((y) => sameThing(y.title, title))) return;
    recent.unshift({ title });
    store.upsertItem({
      id: `heard:${at.toString(36)}:${i}`, source: 'heard', kind: KINDS.includes(x.kind) ? x.kind : 'info', at, end,
      title, body: short(x.detail, 600),
      people: (Array.isArray(x.people) ? x.people : []).map((p) => short(p, 60)).filter(Boolean).slice(0, 6),
      data: { from: 'mic' },
    });
    saved++;
  });
  const plans = Array.isArray(r.json.plans) && r.json.plans.length && deps.life.sourceOn('plans') ? L.notePlans(r.json.plans, { source: 'heard', tz }).length : 0;
  if (saved) S.savedAt = Date.now();
  S.run.saved = saved; S.run.plans = plans;
  console.log(`[life listen] ${S.run.words} words heard, ${saved} kept, ${plans} plans`);
}

function state() {
  if (!deps) return null;
  return { on: !!win, mic: S.mic, paused: wanted() && callActive() ? 'call' : '', error: S.error, heardAt: S.heardAt, savedAt: S.savedAt, thinking: S.extracting, pending: wordCount(S.lines), run: S.run };
}
function push() { if (deps && deps.life && deps.life.pushState) deps.life.pushState('heard'); }

function init(d) {
  deps = d;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media');
  ipcMain.on('lifelisten:chunk', (e, pcm) => { chunk(pcm).catch(() => {}); });
  ipcMain.on('lifelisten:status', (e, s) => { S.mic = !!(s && s.on); S.error = (s && s.error) || ''; push(); });
  setInterval(sync, 5000);
  setTimeout(sync, 8000);
}

module.exports = { init, sync, state, heardPrompt };
