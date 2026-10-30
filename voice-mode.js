// Codeply Orbit (voice mode): hold Alt+C (Option+C on a Mac), talk, let go.
//
// A tap still opens the drop. Held past HOLD_MS, the same keys start listening:
// a small Codeply buddy rides next to the cursor with a live waveform, the
// screens are captured, and on release what you said is transcribed on this PC
// (Whisper, crew/voice.js), sent with the screenshots to the selected model
// (Haze 2 by default), and the answer is spoken back while the buddy points,
// draws arrows, circles and boxes on the screen. "How do I..." questions turn
// into a walkthrough: one step at a time, the next one after you click.
// "Craft, do X" hands the task to the drop's agent.
//
// Globals shortcuts only report key down, so the release comes from a
// listen-only keyboard hook (uiohook-napi). Without the hook (a Mac without the
// Accessibility permission) Alt+C stays a plain tap that opens the drop.
const { BrowserWindow, screen, ipcMain, desktopCapturer, systemPreferences, app, utilityProcess } = require('electron');
const path = require('path');
const act = require('./voice/act');
const tools = require('./voice/tools');

const HOLD_MS = 280;          // held this long = talking, shorter = a tap
const MAX_LISTEN_MS = 60000;
const MAX_TEACH_STEPS = 15;
const MAX_ACT_STEPS = 25;     // screenshots in one "do this for me" task
const MAX_DONE_CHECKS = 3;    // extra looks to confirm a task is really finished before it says so
const TEACH_WAIT_MS = 3 * 60000;
const HISTORY_TTL_MS = 3 * 60000;
const SHOT_BOX = { width: 1280, height: 800 }; // screenshots fit in this box (keeps the image cost down)
const EDGE_VOICE = 'en-US-AvaMultilingualNeural';
const SERVER_VOICE = 'aura-2-thalia-en';  // Codeply's voice server (Deepgram), when Edge says no
// What Whisper "hears" in silence or a breath: never a real question.
const NOT_SPEECH = /^(you|thank you|thanks|thanks for watching|bye|okay|ok|uh|um|hmm|so)[.!?]*$/i;

let host = null;
let hook = null;              // uiohook-napi, when it loads
let keys = null;
let voiceLib = null;          // crew/voice.js: Whisper and the voices
const overlays = new Map();   // display id -> BrowserWindow

const S = {
  state: 'idle',              // idle | listening | thinking | speaking | teaching
  pressed: false,
  holdTimer: null,
  listenTimer: null,
  idleTimer: null,
  followTimer: null,
  turn: 0,                    // bumps on every new question; stale work checks it and stops
  shots: null,                // Promise<[{ display, image, w, h, index }]>
  strokes: [],                // what the person circled while talking
  history: [],                // short text memory for follow-ups
  lastAt: 0,
  buddyDisplay: null,
  away: false,                // the buddy is off pointing, not following the cursor
  teach: null,                // { goal, steps }
  doneLog: [],                // what this task did so far, in a few words each
  toolResults: [],            // command output waiting to go back to the model
  lookNext: false,            // the next look needs a screenshot (it clicked, typed or opened something)
  pcmWaiters: new Map(),
  playWaiters: new Map(),
  question: '',
};

// ─── Small helpers ──────────────────────────────────────────────────────────
const isMac = process.platform === 'darwin';
const muted = () => host.getSetting('voiceMuted') === true;
const log = (...a) => console.log('[voice]', ...a);
const DEBUG = !app.isPackaged && !!process.env.CRAFT_VOICE_DEBUG; // dev runs: log every Alt/C event

function ov(displayId) { const w = overlays.get(displayId); return w && !w.isDestroyed() ? w : null; }
function sendTo(displayId, msg) { const w = ov(displayId); if (w) w.webContents.send('voice:cmd', msg); }
function sendAll(msg) { for (const id of overlays.keys()) sendTo(id, msg); }
function audioHost() { return screen.getPrimaryDisplay().id; } // mic and speaker live in the primary screen's overlay
function displayAtCursor() { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); }

// ─── Overlays: one transparent, click-through window per screen ─────────────
function makeOverlay(d) {
  const w = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, show: false,
    alwaysOnTop: true, backgroundColor: '#00000000', enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'voice', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  // Plain click-through. (Electron's { forward: true } hooks the system mouse, and the cursor stutters whenever the app is busy.)
  w.setIgnoreMouseEvents(true);
  if (isMac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Kept out of screenshots, so the model never sees the buddy or its own drawings.
  // (CRAFT_VOICE_VISIBLE in a dev run keeps it capturable, for testing.)
  if (app.isPackaged || !process.env.CRAFT_VOICE_VISIBLE) w.setContentProtection(true);
  w.loadFile(path.join(__dirname, 'voice', 'overlay.html'), { query: { display: String(d.id), audio: d.id === audioHost() ? '1' : '0' } });
  w.on('closed', () => { if (overlays.get(d.id) === w) overlays.delete(d.id); });
  overlays.set(d.id, w);
  return w;
}

function syncOverlays() {
  const ds = screen.getAllDisplays();
  const ids = new Set(ds.map((d) => d.id));
  for (const [id, w] of overlays) if (!ids.has(id) || w.isDestroyed()) { try { w.destroy(); } catch {} overlays.delete(id); }
  for (const d of ds) {
    const w = ov(d.id);
    if (!w) makeOverlay(d);
    else w.setBounds(d.bounds);
  }
}

function showOverlays() {
  syncOverlays();
  for (const w of overlays.values()) if (!w.isVisible()) w.showInactive();
}
function hideOverlays() {
  setHover(null); bubbleRect = null;
  for (const w of overlays.values()) if (!w.isDestroyed() && w.isVisible()) w.hide();
}
// The bubble catches the mouse only while the cursor is over it, so you can drag
// it; everything else stays click-through. (A 50 ms position check, not a mouse
// hook, so the cursor never lags.) Its own clicks during a task always go through.
let bubbleRect = null; let hoverWin = null; let hoverTimer = null;
function setHover(win) {
  if (hoverWin === win) return;
  if (hoverWin && !hoverWin.isDestroyed() && S.state !== 'listening') hoverWin.setIgnoreMouseEvents(true);
  hoverWin = win;
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false);
}
function watchHover() {
  if (hoverTimer) return;
  hoverTimer = setInterval(() => {
    if (S.state === 'listening') { hoverWin = null; return; }
    if (!bubbleRect) { setHover(null); clearInterval(hoverTimer); hoverTimer = null; return; }
    if (S.injecting) { setHover(null); return; }
    const d = screen.getAllDisplays().find((x) => x.id === bubbleRect.display);
    const w = d && ov(d.id);
    if (!w) { setHover(null); return; }
    const p = screen.getCursorScreenPoint(); const x = p.x - d.bounds.x; const y = p.y - d.bounds.y; const r = bubbleRect;
    setHover(x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4 ? w : null);
  }, 50);
}

function catchMouse(on) {
  hoverWin = null;
  for (const w of overlays.values()) if (!w.isDestroyed()) w.setIgnoreMouseEvents(!on);
  // Windows lets clicks fall through fully transparent pixels, so each screen
  // gets a barely-there tint while you can draw (see body.catching).
  if (!(DEBUG && process.env.CRAFT_VOICE_NO_TINT)) sendAll({ type: 'catch', on: !!on });
}

function whenLoaded(w) {
  return new Promise((r) => (w.webContents.isLoading() ? w.webContents.once('did-finish-load', r) : r()));
}

// ─── The buddy follows the cursor while it isn't pointing somewhere ─────────
function startFollow() {
  if (S.followTimer) return;
  let last = '';
  S.followTimer = setInterval(() => {
    if (S.away) return;
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    if (S.buddyDisplay !== d.id) {
      if (S.buddyDisplay != null) sendTo(S.buddyDisplay, { type: 'buddy-hide' });
      S.buddyDisplay = d.id;
    }
    const key = `${d.id}:${p.x}:${p.y}`;
    if (key === last) return;
    last = key;
    sendTo(d.id, { type: 'cursor', x: p.x - d.bounds.x, y: p.y - d.bounds.y });
  }, 16);
}
function stopFollow() { clearInterval(S.followTimer); S.followTimer = null; }

function setMode(mode, extra = {}) {
  if (S.buddyDisplay == null) S.buddyDisplay = displayAtCursor().id;
  // With the top bar showing, it has the waveform and the shimmer, so the buddy's pill leaves them out.
  let bar = false;
  try { bar = !require('./island').isHidden(); } catch {}
  sendTo(S.buddyDisplay, { type: 'mode', mode, bar, ...extra });
  toBar('voiceState', mode);
}

// The top bar (island.js) mirrors Orbit: a waveform while you talk, a shimmer
// while it thinks, and what it heard and says in a card under the line. Loaded on first use; the bar missing never stops a turn.
let bar = null;
function toBar(fn, arg) {
  if (bar === null) { try { bar = require('./island'); } catch { bar = false; } }
  if (bar) { try { bar[fn](arg); } catch {} }
}

// ─── Hotkey: tap opens the drop, hold talks ────────────────────────────────
/** drop.js calls this on every Alt+C key down (the global shortcut). */
function press(tap) {
  if (!hook) { tap(); return; }
  if (DEBUG) log(`shortcut (pressed=${S.pressed}, c=${S.cDown}, alt=${S.altDown})`);
  if (S.pressed) return; // key repeat
  // The shortcut arrived after the keys were already let go: a tap.
  if (S.upAt && Date.now() - S.upAt < 500 && S.upAt >= (S.downAt || 0)) { tap(); return; }
  // The shortcut proves the keys are down right now, even if the hook hasn't said so yet.
  S.cDown = true; S.altDown = true;
  S.pressed = true;
  S.tap = tap;
  sendTo(audioHost(), { type: 'mic-arm' }); // start the mic now so the first word isn't cut off
  warmStt();
  clearTimeout(S.holdTimer);
  S.holdTimer = setTimeout(async () => {
    S.holdTimer = null;
    // Already let go (the release beat the shortcut here): it was a tap.
    if (await keysReleased()) {
      S.pressed = false;
      sendTo(audioHost(), { type: 'mic-cancel' });
      if (S.tap) S.tap();
      return;
    }
    beginListening();
  }, HOLD_MS);
}

// Are Alt and C really up? Windows itself is the judge when the helper is
// running: apps (Electron among them) send fake Alt presses to grab focus, and
// the key hook reports those as you letting go. Without the helper, the hook decides.
async function keysReleased() {
  const h = await act.held().catch(() => null);
  if (h) return !h.alt || !h.c;
  return !(S.cDown && S.altDown);
}

async function release() {
  if (!S.pressed) return;
  if (!(await keysReleased())) { if (DEBUG) log('ignored a key-up: Alt and C are still held'); S.cDown = true; S.altDown = true; return; }
  if (!S.pressed) return;
  S.pressed = false;
  if (S.holdTimer) {
    clearTimeout(S.holdTimer); S.holdTimer = null;
    sendTo(audioHost(), { type: 'mic-cancel' });
    // A tap while an answer is up carries the question over to the drop.
    if (S.lastAnswerAt && Date.now() - S.lastAnswerAt < 20000 && S.question) { const q = S.question; cancel(); host.openDrop(q); return; }
    if (S.tap) S.tap();
    return;
  }
  if (S.state === 'listening') finishListening();
}

function startHook() {
  if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) {
    log('hold-to-talk needs the Accessibility permission; Option+C stays a tap until it is granted');
    // Ask once; the OS shows its own prompt. Craft picks it up on the next launch.
    if (!host.getSetting('voiceAskedAccessibility')) { host.setSetting('voiceAskedAccessibility', true); systemPreferences.isTrustedAccessibilityClient(true); }
    return;
  }
  try {
    const m = require('uiohook-napi');
    keys = m.UiohookKey;
    const releaseKeys = new Set([keys.C, keys.Alt, keys.AltRight]);
    // The real state of the keys. Under load Windows can deliver the release
    // before the shortcut itself, so tap or hold is decided from this, not from event order.
    const track = (code, down) => {
      if (DEBUG && (code === keys.C || code === keys.Alt)) log(`key ${code === keys.C ? 'C' : 'Alt'} ${down ? 'down' : 'up'} (pressed=${S.pressed}, state=${S.state})`);
      if (code === keys.C) S.cDown = down;
      else if (code === keys.Alt || code === keys.AltRight) S.altDown = down;
      else return;
      if (down) S.downAt = Date.now(); else S.upAt = Date.now();
    };
    m.uIOhook.on('keydown', (e) => track(e.keycode, true));
    if (DEBUG) { let n = 0; m.uIOhook.on('mousemove', () => { n++; }); setInterval(() => { if (S.state === 'listening') log(`hook alive: ${n} mouse moves in the last second`); n = 0; }, 1000); }
    m.uIOhook.on('keyup', (e) => { track(e.keycode, false); if (releaseKeys.has(e.keycode)) release(); });
    m.uIOhook.on('keydown', (e) => { if (e.keycode === keys.Escape && S.state !== 'idle') cancel(); });
    m.uIOhook.on('mousedown', (e) => { if (S.state === 'teaching') stepDone(e); });
    m.uIOhook.start();
    hook = m.uIOhook;
  } catch (e) {
    console.warn('[voice] keyboard hook unavailable, Alt+C stays a tap:', e.message);
    hook = null;
  }
}

// ─── Listening ──────────────────────────────────────────────────────────────
async function beginListening() {
  stopTurn();
  const turn = ++S.turn;
  S.state = 'listening';
  S.lastAnswerAt = 0;
  S.doneLog = [];
  S.toolResults = [];
  S.guiUsed = false;
  S.strokes = [];
  S.away = false;
  clearTimeout(S.idleTimer);
  showOverlays();
  await Promise.all([...overlays.values()].map(whenLoaded));
  if (turn !== S.turn) return;
  sendAll({ type: 'clear' });
  toBar('voiceWords', { clear: true });
  S.buddyDisplay = null;
  startFollow();
  setMode('listening');
  catchMouse(true); // drag to circle something while talking
  sendTo(audioHost(), { type: 'mic-start' });
  clearTimeout(S.listenTimer);
  S.listenTimer = setTimeout(() => { if (S.state === 'listening' && turn === S.turn) { S.pressed = false; finishListening(); } }, MAX_LISTEN_MS);
  // Belt and braces: the key hook can miss a release, so while listening Craft
  // also asks Windows itself whether Alt and C are still held (voice/act.js).
  clearInterval(S.listenPoll);
  let asking = false;
  S.listenPoll = setInterval(async () => {
    if (S.state !== 'listening' || turn !== S.turn) { clearInterval(S.listenPoll); return; }
    if (asking) return;
    asking = true;
    const up = await keysReleased();
    asking = false;
    if (up && S.state === 'listening' && turn === S.turn) {
      if (DEBUG) log('release found by polling');
      clearInterval(S.listenPoll);
      S.pressed = false; S.cDown = false; S.altDown = false;
      finishListening();
    }
  }, 150);
  if (S.history.length && Date.now() - S.lastAt > HISTORY_TTL_MS) S.history = [];
}

function requestPcm() {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const t = setTimeout(() => { S.pcmWaiters.delete(id); resolve(null); }, 4000);
    S.pcmWaiters.set(id, (pcm) => { clearTimeout(t); resolve(pcm); });
    sendTo(audioHost(), { type: 'mic-stop', id });
  });
}

async function finishListening() {
  const turn = S.turn;
  clearTimeout(S.listenTimer);
  catchMouse(false);
  S.state = 'thinking';
  // Let go: a second cursor takes over, and the person's own cursor is free again.
  S.away = true;
  sendTo(S.buddyDisplay, { type: 'detach' });
  setMode('thinking');
  S.t0 = Date.now();
  // The screens are captured now, on release, alongside speech to text: nothing
  // heavy runs while the key is held, so Windows never drops the key's release.
  S.shots = captureScreens().catch((e) => { log('screenshot failed:', e.message); return []; });
  const pcm = await requestPcm();
  if (turn !== S.turn) return;
  if (!pcm || pcm.length < 16000 * 0.3) return finish('I didn\'t hear anything. Hold Alt+C while you talk.');
  let text = '';
  try {
    if (!sttReady) setMode('thinking', { note: 'Getting voice ready…' });
    text = await transcribe(pcm);
    log(`heard in ${Date.now() - S.t0}ms: ${text}`);
    host.setSetting('voiceUsed', true);
    if (!app.isPackaged && process.env.CRAFT_VOICE_SAY) text = process.env.CRAFT_VOICE_SAY; // dev test: a fixed question
  } catch (e) {
    return finish(`Voice couldn't start: ${e.message}`);
  }
  if (turn !== S.turn) return;
  if (!text || (NOT_SPEECH.test(text.trim()) && pcm.length < 16000 * 2.5)) return finish('I didn\'t catch that. Try again?');
  S.question = text;
  sendTo(S.buddyDisplay, { type: 'heard', text });
  toBar('voiceWords', { heard: text });
  await answer({ said: text, turn });
}

// ─── Screens ────────────────────────────────────────────────────────────────
async function captureScreens() {
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: SHOT_BOX });
  const out = [];
  displays.forEach((d, i) => {
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[i];
    if (!src || src.thumbnail.isEmpty()) return;
    const { width: w, height: h } = src.thumbnail.getSize();
    out.push({ display: d, index: out.length + 1, w, h, url: 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(72).toString('base64') });
  });
  return out;
}

const toImg = (shot, x, y) => [Math.round((x * shot.w) / shot.display.bounds.width), Math.round((y * shot.h) / shot.display.bounds.height)];
const toDip = (shot, x, y) => [(x * shot.display.bounds.width) / shot.w, (y * shot.display.bounds.height) / shot.h];

// ─── The model ──────────────────────────────────────────────────────────────
const SYSTEM = `You are Codeply in voice mode, an on-screen buddy. You live next to the user's mouse cursor on their computer. They hold a key, talk to you, and let go. You get what they said and screenshots of their screens.

Talk the way a friendly expert talks out loud: short plain sentences, no markdown, no lists, no code blocks, no emojis, no URLs read out. Usually one to three sentences and under 60 words, unless they ask for detail.

You can show things on screen with tags. Tags are never spoken. Coordinates are pixels in that screen's screenshot, 0,0 is the top left.
[POINT:x,y:label:screenN] fly to an element and show a 2 to 4 word label
[ARROW:x1,y1:x2,y2:screenN] draw an arrow from one spot to another
[CIRCLE:x,y:r:screenN] circle something, r is the radius in pixels
[BOX:x,y,w,h:label:screenN] highlight a rectangle
Math: write every formula or expression as LaTeX between single dollar signs, like $E = mc^2$ or $KE = \\frac{1}{2}mv^2$. It is shown as real math on screen and read out in words for you, so never spell math out in words yourself.

When you explain something that is on screen, show it while you talk: [POINT] at the part each sentence is about so your cursor moves along with the explanation, circle or box it, and use arrows for how one thing leads to another. One drawing per sentence is about right. Your text bubble moves out of the way of your drawings on its own.

Put a tag right after the sentence it belongs to; it is drawn while that sentence is spoken. Only point at things you can actually see. If you can't find something, say so instead of guessing.

Teaching: when they want to learn how to do something in an app, give only the first step, point at exactly where to click, and end with [NEXT]. After they do it you get a fresh screenshot and give the next step the same way. When the task is finished, say so without [NEXT].

The web: for anything current or anything you don't know for sure (news, prices, weather, scores, releases, docs, facts about a person, place or product), look it up before answering: [SEARCH:a few words] gives you search results as text, [FETCH:https link] reads one page. The results come back to you right away, then answer from them in a sentence or two and say where it's from in a few words.

Coding work: when they ask Codeply to build, make, fix or change code or a project (work for the coding agent, not something to do on the screen), reply with one short sentence like "On it, starting on that." and add [AGENT:the task, written out clearly as an instruction]. Never use [AGENT] for questions.`;

// What it may do on the screen when asked: real clicks and keys (voice/act.js).
const ACTIONS = `

Using the computer: when they ask you to click, open, type, press, scroll or otherwise do something on their screen, do it with these tags. They run for real, in order, while you talk.
[CLICK:x,y:label:screenN] click (label: 1 to 3 words for what you click)
[DOUBLE:x,y:label:screenN] double click
[RIGHT:x,y:label:screenN] right click
[CTRLCLICK:x,y:label:screenN] Ctrl+click, to add one more item to a selection (several files at once)
[DRAG:x1,y1:x2,y2:screenN] press at the first spot, glide to the second, let go (drop a file on a folder)
[MOVE:x,y:screenN] move the mouse there without clicking, to hover or to reveal an auto-hidden taskbar or dock at the very edge of the screen
[SCROLL:x,y:n:screenN] scroll n lines down over that spot (negative n scrolls up)
[TYPE:text] type text where the text cursor is (never a ] inside)
[KEY:combo] press keys, like ctrl+t, enter, escape, win, alt+tab
[WAIT:ms] wait that long (up to 15000) before the next action, for a page or video to load
[CONTINUE] after these actions, send me a fresh screenshot so I can take the next step
[LOOK] add to [CONTINUE] when you need a screenshot after commands only

Commands, for files and the web. They are instant and need no screenshot, so use them instead of clicking through File Explorer or a browser whenever they can do the job:
[LIST:folder] what's in a folder (Desktop, Downloads, Documents, Pictures, or a full path)
[MKDIR:folder] make a folder
[MOVEFILE:from|to folder] move files; * works in the file name, like Desktop\cats\*|Desktop\posts
[COPYFILE:from|to folder] copy the same way
[RENAME:file|new name] rename one file or folder
[RMDIR:folder] remove a folder once it is EMPTY (it goes to the Recycle Bin), to tidy up after moving everything out
[OPEN:file, folder or https link] open it in its app
After LIST (and SEARCH or FETCH) the results come back to you as text right away (no screenshot), then act on them in the same task. To sort files: LIST the folder, MKDIR the categories, then one MOVEFILE per group. Files stay inside the user's folder and nothing gets overwritten. Files can't be deleted (say so if asked); empty folders can be removed with RMDIR after their files are moved out.
Be fast: every [CONTINUE] costs the user a few seconds. Take the shortest path: keyboard shortcuts, and typing a URL or search straight into the address bar (for example ctrl+l, then youtube.com/results?search_query=the+weeknd+timeless, then enter) instead of clicking through pages. Chain everything you can predict in one reply (ctrl+t, type, enter, wait, click) and only [CONTINUE] when you truly need to see the screen again. On the steps in between, reply with tags only, no words.
Big tasks: when a request has several parts (open two tabs, send each one a message, read the replies), start your first reply with [PLAN:first part|second part|third part], short parts in order, then start on part 1 right away. Mark a part finished with [DONE:n] (its number) as soon as the screen shows it is finished. The task is only over when every part is finished: never say "Done." while a part is left. If they asked you to find something out (like what each AI replied), your last line can say it in one short sentence.
Files: to move several files in File Explorer, click the first, [CTRLCLICK] each other one, [KEY:ctrl+x], open the target folder, [KEY:ctrl+v], then go back for the next group. Or [DRAG] a selection onto a folder. Do every group before you say "Done.": if they asked to sort 12 images into 5 folders, all 12 must be in a folder.
Videos and ads: looking at a new screenshot already takes about 5 seconds, so keep waits short. After starting a YouTube video, [WAIT:1500] then [CONTINUE] to check for an ad. If there is a "Skip" button, click exactly that button. If an ad is playing with no Skip button yet, [WAIT:2000] and [CONTINUE] again. If no ad is playing, you're done. Never click the video itself to get past an ad.
Don't narrate what you do: the label on your cursor already shows it. Say "On it." when you start and "Done." when it's finished, and nothing at all on the steps in between. For a task with several steps, do as many steps as you safely can from one screenshot, end with [CONTINUE], and keep going with each new screenshot until it is done; then say "Done." without [CONTINUE]. If the taskbar or dock isn't visible it may be auto-hidden: [MOVE] to the very bottom edge first, then [CONTINUE].
Only act when they ask you to. Before anything that sends, posts, buys, pays, deletes, closes unsaved work or can't be undone, ask out loud first and wait for a yes. Never type passwords, card numbers or other secrets.`;

const actionsOn = () => act.supported() && host.getSetting('voiceActions') !== false;
function systemPrompt() {
  const os = isMac ? 'macOS (use cmd for shortcuts)' : process.platform === 'win32' ? 'Windows' : 'Linux';
  return `${SYSTEM}${actionsOn() ? `${ACTIONS}\nThe user's folders: ${tools.folders()}.` : ''}\n\nThis computer runs ${os}.`;
}

function describeScreens(shots) {
  const p = screen.getCursorScreenPoint();
  const lines = shots.map((s) => `screen${s.index} is image ${s.index} (${s.w}x${s.h}${s.display.id === screen.getPrimaryDisplay().id ? ', main screen' : ''})`);
  const at = shots.find((s) => p.x >= s.display.bounds.x && p.x < s.display.bounds.x + s.display.bounds.width && p.y >= s.display.bounds.y && p.y < s.display.bounds.y + s.display.bounds.height);
  if (at) { const [x, y] = toImg(at, p.x - at.display.bounds.x, p.y - at.display.bounds.y); lines.push(`The mouse is at ${x},${y} on screen${at.index}.`); }
  for (const st of S.strokes) {
    const shot = shots.find((s) => s.display.id === st.displayId);
    if (!shot) continue;
    const [x1, y1] = toImg(shot, st.box.x, st.box.y);
    const [x2, y2] = toImg(shot, st.box.x + st.box.w, st.box.y + st.box.h);
    lines.push(`While talking they circled the area from ${x1},${y1} to ${x2},${y2} on screen${shot.index}. "This" or "that" most likely means what is inside it.`);
  }
  return lines.join('\n');
}

// Questions about what's on screen ("this", "click", "explain", a circle drawn...).
const SCREEN_WORDS = /\b(this|that|these|those|here|there|screen|see|look|view|showing|shown|on my|click|tap|press|button|tab|window|icon|menu|where|point|circle|highlight|teach|walk me|step by step|scroll|drag|select|explain|which one|open|close|switch|picture|image|photo|diagram|chart|graph|formula|structure|page)\b/i;
const needsScreen = (said) => SCREEN_WORDS.test(String(said || ''));
// Questions about now ("who won", "latest", "price", "weather"...): Craft searches
// the web itself before asking, since a model may answer those from stale memory.
const CURRENT_WORDS = /\b(latest|newest|recent|recently|current|currently|right now|today|tonight|tomorrow|yesterday|this (week|month|year)|news|price|prices|cost|weather|forecast|score|scores|won|winner|stock|released?|update|updates|who is|how much|when (is|does|did|will)|20[2-3]\d)\b/i;
const needsWeb = (said) => CURRENT_WORDS.test(String(said || ''));
// Tags that carry screen coordinates: never acted on from a model that didn't see the screen.
const COORD_KINDS = new Set(['POINT', 'ARROW', 'CIRCLE', 'BOX', 'CLICK', 'CTRLCLICK', 'DOUBLE', 'RIGHT', 'DRAG', 'MOVE', 'SCROLL']);

// Haze 2 first. On a day its Claude allowance is used up, Haze answers with its
// free text model (gpt-oss 120B), which is fine for talking but can't see: then
// anything with a screenshot goes to Gemma 4, which can. Gemma also stands in
// when the free model sends back nothing. With the user's own model selected,
// that model answers everything.
async function callModel(messages, hasImages) {
  const route = host.route();
  const ai = host.ai();
  const today = new Date().toDateString();
  const gemma = async () => { const g = await ai.chatVision(messages, { maxTokens: 500 }); return g && g.success ? g : null; };
  if (route.auto && hasImages && S.claudeOutDay === today) {
    const g = await gemma();
    if (g) return { r: g };
  }
  const r = await ai.chat(messages, {
    route, maxTokens: 500,
    haze: { product: 'craft', surface: 'voice', chatId: 'voice', turnId: `v${Date.now().toString(36)}`, step: 0, historyCount: S.history.length },
  });
  if (r && r.success && r.route && r.route.tier === 'free') {
    if (/allowance/i.test(r.route.reason || '')) S.claudeOutDay = today;
    const empty = !String(r.data?.choices?.[0]?.message?.content || '').trim();
    if (hasImages || empty) {
      log(`Haze is on its free model (${r.route.reason || 'free tier'}): ${hasImages ? 'screenshot' : 'empty reply'}, using Gemma 4`);
      const g = await gemma();
      if (g) return { r: g };
      if (hasImages) return { blind: true };
    }
  }
  return { r };
}

async function answer({ said, turn, followUp, screen }) {
  S.state = 'thinking';
  toBar('voiceState', 'thinking');
  if (!followUp || followUp.kind !== 'act') setMode('thinking'); // mid-task it keeps its working ring
  const ok = await host.loadEngine();
  if (!ok) return finish('Codeply\'s engine isn\'t ready yet.');
  const route = host.route();
  if (route.auto && !(await host.signedIn())) return finish('Sign in to Codeply to use voice with Haze 2.');
  // Screenshots are the costly part, so one goes along only when the question is
  // about the screen (or a task step changed it). Otherwise the model answers from
  // text and replies [LOOK] when it does need to see.
  const midTask = followUp && followUp.kind === 'act';
  const wantScreen = screen != null ? screen
    : !followUp ? (S.strokes.length > 0 || needsScreen(said))
      : midTask ? !!followUp.look : true;
  const searching = !followUp && !screen && needsWeb(said) ? tools.run('SEARCH', said, host.cliDir) : null;
  const shots = !wantScreen ? [] : await (followUp || screen ? captureScreens().catch(() => []) : S.shots);
  if (searching) {
    const found = await searching;
    log(`searched the web first: ${found.split('\n')[0].slice(0, 120)}`);
    S.toolResults.push(`(Codeply already searched the web for this question)\n${found}`);
  }
  const results = S.toolResults.length ? `\nCommand results:\n${S.toolResults.join('\n---\n')}\n` : '';
  if (turn !== S.turn) return;
  const intro = !followUp ? `They said: "${said}"${results ? `\n${results}Answer from these results (not from memory), and say where it's from in a few words.` : ''}`
    : followUp.kind === 'act'
      ? `Task: "${S.task.goal}".${planText()} Done so far: ${S.doneLog.slice(-10).join(', ') || 'nothing'}${followUp.errors ? ` (failed: ${followUp.errors})` : ''}.${results}${followUp.checking ? ` Before it counts as done, check ${shots.length ? 'this screen' : 'the results'} against the whole original request: if anything is missing, half done or didn't work, do it now. If every part really is finished, reply "Done." with no actions (mark plan parts with [DONE:n]).` : ''} ${shots.length ? 'This is the screen now: take' : 'Take'} the next step, or say "Done." when every part is finished.`
      : `They did the step you showed${followUp.at ? ` (they clicked at ${followUp.at})` : ''}. This is the screen now. Give the next step of "${S.teach.goal}", or say it's done.`;
  const screenNote = shots.length ? describeScreens(shots)
    : 'No screenshot is attached (they cost time). If you need to see the screen to answer, or to point, click or draw, reply with only [LOOK].';
  const content = [{ type: 'text', text: `${intro}\n\n${screenNote}` }, ...shots.map((s) => ({ type: 'image_url', image_url: { url: s.url } }))];
  // Mid-task looks skip the chat history (the intro already says what's done): a smaller request answers faster.
  const messages = [{ role: 'system', content: systemPrompt() }, ...(midTask ? [] : S.history), { role: 'user', content }];
  const tAsk = Date.now();
  const { r, blind } = await callModel(messages, shots.length > 0);
  if (turn !== S.turn) return;
  if (blind) {
    S.task = null; S.teach = null;
    return finish("You've used today's Haze allowance and this build has no image model, so I can't see your screen until it resets. Pick your own model in Codeply's model menu to keep going.");
  }
  if (r && r.success) log(`answered by ${r.modelUsed || r.data?.model || '?'} in ${Date.now() - tAsk}ms${shots.length ? '' : ' (no screenshot)'}`);
  if (!r || !r.success) return finish(r && r.error ? `Couldn't answer: ${r.error}` : 'Couldn\'t reach the model.');
  const reply = String(r.data?.choices?.[0]?.message?.content || '').trim();
  if (!reply) return finish('The model sent back nothing. Try again?');
  // It answered without seeing but needs to: asked to [LOOK], or tried to point,
  // click or draw (any coordinates would be guesses). Ask again with a screenshot.
  const p0 = parse(reply);
  const onlyLook = p0.look && !p0.cont && !p0.chunks.some((c) => c.actions.length);
  const blindCoords = p0.chunks.some((c) => c.actions.some((a) => COORD_KINDS.has(a.kind)));
  if (!shots.length && screen !== true && (onlyLook || blindCoords)) {
    log('it needs to see the screen: asking again with a screenshot');
    return answer({ said, turn, followUp: followUp && { ...followUp, look: true }, screen: true });
  }
  S.toolResults = [];
  if (!midTask) {
    S.history.push({ role: 'user', content: followUp ? `(did the step) ${intro}` : `They said: "${said}"` }, { role: 'assistant', content: reply });
    S.history = S.history.slice(-8);
    // What was asked joins the shared life context (life-desktop.js); the answer without its pointing marks.
    if (!followUp && host.onAsk) { try { host.onAsk(said, reply.replace(/\[[A-Z]+[^\]]*\]/g, ' ')); } catch {} }
  }
  S.lastAt = Date.now();
  await perform(parse(reply), shots, turn);
}

// "Text [TAG:...] more text [TAG]" -> chunks of speech, each with the drawings that go with it.
function parse(reply) {
  const chunks = [];
  let cur = { text: '', actions: [] };
  const re = /\[(POINT|ARROW|CIRCLE|BOX|NEXT|AGENT|CLICK|CTRLCLICK|DOUBLE|RIGHT|DRAG|MOVEFILE|MOVE|SCROLL|TYPE|KEY|WAIT|CONTINUE|LOOK|PLAN|DONE|LIST|MKDIR|COPYFILE|RENAME|RMDIR|OPEN|FETCH|SEARCH)(?::([^\]]*))?\]/gi;
  let last = 0; let m;
  let next = false; let agent = null; let cont = false; let plan = null; const done = []; let look = false;
  while ((m = re.exec(reply))) {
    cur.text += reply.slice(last, m.index);
    last = re.lastIndex;
    const kind = m[1].toUpperCase();
    if (kind === 'NEXT') { next = true; continue; }
    if (kind === 'CONTINUE') { cont = true; continue; }
    if (kind === 'LOOK') { look = true; continue; }
    if (kind === 'PLAN') { plan = String(m[2] || '').split('|').map((s) => s.trim()).filter(Boolean).slice(0, 12); continue; }
    if (kind === 'DONE') { for (const n of String(m[2] || '').split(',')) if (Number(n) > 0) done.push(Number(n)); continue; }
    if (kind === 'AGENT') { agent = String(m[2] || '').trim() || null; continue; }
    cur.actions.push({ kind, arg: m[2] || '' });
    chunks.push(cur);
    cur = { text: '', actions: [] };
  }
  cur.text += reply.slice(last);
  chunks.push(cur);
  for (const c of chunks) c.text = c.text.replace(/\s+/g, ' ').trim();
  return { chunks: chunks.filter((c) => c.text || c.actions.length), next, agent, cont, plan, done, look };
}

// " Plan: 1. [x] open ChatGPT  2. [ ] ask it ..." for the model's next look.
function planText() {
  if (!S.task || !S.task.plan) return '';
  return ` Plan: ${S.task.plan.map((p, i) => `${i + 1}. [${p.done ? 'x' : ' '}] ${p.t}`).join('  ')}.`;
}

const GUI_KINDS = new Set(['CLICK', 'CTRLCLICK', 'DOUBLE', 'RIGHT', 'DRAG', 'MOVE', 'SCROLL', 'TYPE', 'KEY', 'WAIT']);
const TOOL_KINDS = new Set(tools.KINDS);
const ACT_KINDS = new Set([...GUI_KINDS, ...TOOL_KINDS]);
const INFO_KINDS = new Set(['LIST', 'FETCH', 'SEARCH']); // their results always go back to the model
const WEB_KINDS = new Set(['FETCH', 'SEARCH']);          // read only: allowed even with clicking turned off
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One action tag -> real input. The second cursor flies to the spot and shows
// what it's about to do for a moment first, so Esc can still stop it.
async function doAction(action, shots, turn) {
  const k = action.kind;
  if (!actionsOn() && !WEB_KINDS.has(k)) return;
  const parts = action.arg.split(':');
  if (GUI_KINDS.has(k) && k !== 'WAIT') S.guiUsed = true;
  if (TOOL_KINDS.has(k)) {
    // A command: no cursor flight, just the working ring, and the result goes back to the model as text.
    sendTo(S.buddyDisplay, { type: 'mode', mode: 'working' });
    const out = await tools.run(k, action.arg, host.cliDir);
    log(`${k.toLowerCase()}: ${out.split('\n')[0].slice(0, 160)}`);
    S.toolResults.push(out);
    S.doneLog.push(`${k.toLowerCase()} ${action.arg.slice(0, 80)}`);
    if (k === 'OPEN') S.lookNext = true; // something new is on screen
    return;
  }
  if (k === 'WAIT') {
    sendTo(S.buddyDisplay, { type: 'mode', mode: 'working' });
    const ms = Math.max(200, Math.min(15000, Number(action.arg) || 1500));
    await sleep(ms);
    S.doneLog.push(`waited ${(ms / 1000).toFixed(1)}s`);
    return;
  }
  S.doneLog.push(k === 'TYPE' ? `typed "${action.arg.slice(0, 60)}"` : k === 'KEY' ? `pressed ${action.arg}` : `${k.toLowerCase()} ${parts.slice(1, -1).join(':').trim() || parts[0]}`);
  // Once a task is underway the "about to click" pause is short, so it flows.
  const preview = S.task ? 300 : 550;
  let gx = 0; let gy = 0;
  let gx2 = 0; let gy2 = 0;
  if (['CLICK', 'CTRLCLICK', 'DOUBLE', 'RIGHT', 'MOVE', 'SCROLL', 'DRAG'].includes(k)) {
    const shot = screenOf(shots, parts[parts.length - 1]);
    const [x, y] = nums(parts[0]);
    if (!shot || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`no spot to ${k.toLowerCase()}`);
    const inside = (px, py) => toDip(shot, Math.max(0, Math.min(shot.w - 1, px)), Math.max(0, Math.min(shot.h - 1, py)));
    const [dx, dy] = inside(x, y);
    gx = shot.display.bounds.x + dx; gy = shot.display.bounds.y + dy;
    if (k === 'DRAG') {
      const [x2, y2] = nums(parts[1]);
      if (!Number.isFinite(x2) || !Number.isFinite(y2)) throw new Error('no spot to drag to');
      const [ex, ey] = inside(x2, y2);
      gx2 = shot.display.bounds.x + ex; gy2 = shot.display.bounds.y + ey;
    }
    const what = k === 'DRAG' ? '' : parts.slice(1, -1).join(':').trim();
    const label = k === 'MOVE' ? '' : k === 'SCROLL' ? 'Scrolling' : k === 'DRAG' ? 'Dragging'
      : `${k === 'DOUBLE' ? 'Double click ' : k === 'RIGHT' ? 'Right click ' : k === 'CTRLCLICK' ? 'Add ' : 'Click '}${what}`.trim();
    flyBuddy(shot.display.id, [dx, dy], label);
    await sleep(k === 'MOVE' ? 250 : preview);
  } else await sleep(80);
  if (turn !== S.turn) return; // Esc, or a new question, while it was showing
  S.injecting = true;
  setHover(null); // the click must reach the app, never the bubble
  try {
    if (k === 'CLICK') await act.click(gx, gy);
    else if (k === 'CTRLCLICK') await act.click(gx, gy, { mods: [isMac ? 'cmd' : 'ctrl'] });
    else if (k === 'DRAG') await act.drag(gx, gy, gx2, gy2);
    else if (k === 'DOUBLE') await act.click(gx, gy, { count: 2 });
    else if (k === 'RIGHT') await act.click(gx, gy, { button: 'right' });
    else if (k === 'MOVE') await act.move(gx, gy);
    else if (k === 'SCROLL') await act.scroll(gx, gy, Number(parts[1]));
    else if (k === 'TYPE') await act.type(action.arg);
    else if (k === 'KEY') await act.keys(action.arg);
  } finally {
    setTimeout(() => { S.injecting = false; }, 150);
  }
  await sleep(k === 'TYPE' || k === 'KEY' ? 120 : 180);
}

const nums = (s) => String(s || '').split(',').map((n) => Number(String(n).trim()));
function screenOf(shots, tag) {
  const n = Number(String(tag || '').replace(/[^0-9]/g, '')) || 1;
  return shots.find((s) => s.index === n) || shots[0];
}

// One tag -> a drawing on the right overlay, in that screen's own coordinates.
function draw(action, shots) {
  const parts = action.arg.split(':');
  const shot = screenOf(shots, parts[parts.length - 1]);
  if (!shot) return;
  const id = shot.display.id;
  const pt = (s) => { const [x, y] = nums(s); return Number.isFinite(x) && Number.isFinite(y) ? toDip(shot, x, y) : null; };
  if (action.kind === 'POINT') {
    const p = pt(parts[0]); if (!p) return;
    const label = parts.slice(1, -1).join(':').trim();
    flyBuddy(id, p, label);
  } else if (action.kind === 'ARROW') {
    const a = pt(parts[0]); const b = pt(parts[1]); if (!a || !b) return;
    sendTo(id, { type: 'arrow', from: a, to: b });
  } else if (action.kind === 'CIRCLE') {
    const c = pt(parts[0]); const r = Number(parts[1]); if (!c) return;
    const scale = shot.display.bounds.width / shot.w;
    sendTo(id, { type: 'circle', at: c, r: Math.max(14, (Number.isFinite(r) ? r : 30) * scale) });
  } else if (action.kind === 'BOX') {
    const [x, y, w, h] = nums(parts[0]); if (![x, y, w, h].every(Number.isFinite)) return;
    const [dx, dy] = toDip(shot, x, y); const [dw, dh] = toDip(shot, w, h);
    sendTo(id, { type: 'box', x: dx, y: dy, w: dw, h: dh, label: parts.slice(1, -1).join(':').trim() });
  }
}

function flyBuddy(displayId, at, label) {
  S.away = true;
  if (S.buddyDisplay !== displayId) {
    if (S.buddyDisplay != null) sendTo(S.buddyDisplay, { type: 'buddy-hide' });
    S.buddyDisplay = displayId;
  }
  sendTo(displayId, { type: 'point', x: at[0], y: at[1], label });
}

// ─── Speaking ───────────────────────────────────────────────────────────────
// Sentences, never cut inside a $formula$.
function sentences(t) {
  const out = []; let cur = ''; let inMath = false;
  const str = String(t);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    cur += ch;
    if (ch === '$') inMath = !inMath;
    else if (!inMath && /[.!?]/.test(ch) && (i + 1 >= str.length || /\s/.test(str[i + 1]))) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

// What the voice reads: formulas in words ("v squared"), no markdown.
const GREEK = /\\(alpha|beta|gamma|delta|Delta|epsilon|theta|lambda|mu|pi|rho|sigma|Sigma|tau|phi|omega|Omega)\b/g;
const FUNCS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'max', 'min', 'lim', 'exp']);
const MATH_RULES = [
  [/\^\{2\}|\^2(?!\d)/g, ' squared '], [/\^\{3\}|\^3(?!\d)/g, ' cubed '],
  [/\^\{([^{}]*)\}/g, ' to the power of $1 '], [/\^(\w)/g, ' to the power of $1 '],
  [/_\{([^{}]*)\}/g, ' sub $1 '], [/_(\w)/g, ' sub $1 '],
  [/\\(times|cdot)\b/g, ' times '], [/\\div\b/g, ' divided by '], [/\\pm\b/g, ' plus or minus '],
  [/\\leq?\b/g, ' is at most '], [/\\geq?\b/g, ' is at least '], [/\\neq?\b/g, ' is not equal to '], [/\\approx\b/g, ' is about '],
  [/\\infty\b/g, ' infinity '], [/\\int\b/g, ' the integral of '], [/\\sum\b/g, ' the sum of '], [/\\(to|rightarrow)\b/g, ' goes to '],
  [GREEK, ' $1 '],
  [/\\(text|mathrm|mathbf|operatorname)\{([^{}]*)\}/g, ' $2 '], [/\\(left|right)\b|\\[,;!]/g, ' '],
  [/=/g, ' equals '], [/\+/g, ' plus '], [/(^|[\s(])-|\s-\s/g, '$1 minus '], [/</g, ' is less than '], [/>/g, ' is greater than '],
  [/\//g, ' over '], [/[{}\\()]/g, ' '],
];
function mathWords(tex) {
  let m = String(tex)
    .replace(/\\(sin|cos|tan|log|ln|exp|lim|max|min)\b/g, ' $1 ')
    // short runs of letters are separate variables: "mv" is "m v"
    .replace(/(?<![\\a-zA-Z])([a-zA-Z]{2,3})(?![a-zA-Z])/g, (w) => (FUNCS.has(w) ? w : w.split('').join(' ')));
  for (let i = 0; i < 4; i++) {
    m = m.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, ' $1 over $2 ').replace(/\\sqrt\{([^{}]*)\}/g, ' the square root of $1 ');
  }
  for (const [re, to] of MATH_RULES) m = m.replace(re, to);
  return m.replace(/\s+/g, ' ').trim();
}
function spoken(t) {
  return String(t).replace(/\$([^$]+)\$/g, (x, tex) => ` ${mathWords(tex)} `).replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
}

// Edge's free voice first. When it refuses (429 and the like) it rests for a
// minute and Codeply's voice server speaks instead; if that fails too, the
// answer is text only. Never Kokoro here: it loads slowly and hogs the CPU.
let edgeRestUntil = 0;
async function speakAudio(text) {
  if (muted()) return null;
  const v = stt();
  if (Date.now() > edgeRestUntil) {
    try { return await v.speak(text, { engine: 'edge', voice: EDGE_VOICE, botId: 'craft-voice', offline: false }); } catch (e) {
      edgeRestUntil = Date.now() + 60000;
      log('Edge voice failed, using Codeply voices for a minute:', e.message);
    }
  }
  try {
    return await v.speak(text, { engine: 'deepgram', voice: SERVER_VOICE, botId: 'craft-voice', serverToken: host.accessToken, offline: false });
  } catch (e) { log('no voice, text only:', e.message); return null; }
}
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

function play(audio, text) {
  // No audio (muted or offline): give the bubble reading time instead.
  if (!audio) return new Promise((r) => setTimeout(r, Math.min(9000, 900 + text.split(/\s+/).length * 260)));
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const t = setTimeout(() => { S.playWaiters.delete(id); resolve(); }, 60000);
    S.playWaiters.set(id, () => { clearTimeout(t); resolve(); });
    sendTo(audioHost(), { type: 'play', id, mime: audio.mime, data: audio.data });
  });
}

async function perform({ chunks, next, agent, cont, plan, done, look }, shots, turn) {
  S.state = 'speaking';
  // LIST, FETCH and SEARCH results always go back to the model, so the task goes on.
  const usedWeb = chunks.some((c) => c.actions.some((a) => WEB_KINDS.has(a.kind)));
  if (usedWeb || (actionsOn() && chunks.some((c) => c.actions.some((a) => INFO_KINDS.has(a.kind))))) cont = true;
  // The task's plan: its parts, ticked off as the model sees them finished.
  if (plan && plan.length > 1) {
    if (!S.task) S.task = { goal: S.question, steps: 0, checks: 0 };
    S.task.plan = plan.map((t) => ({ t, done: false }));
  }
  if (S.task && S.task.plan) for (const n of done || []) if (S.task.plan[n - 1]) S.task.plan[n - 1].done = true;
  // Completion check: a task never ends on the model's word alone. When it says
  // "Done." right after acting, or with parts of its plan left, it gets one more
  // quiet look to compare the screen with the request, and keeps going if needed.
  let checking = false;
  const actedNow = chunks.some((c) => c.actions.some((a) => ACT_KINDS.has(a.kind) && a.kind !== 'WAIT'));
  const planLeft = !!(S.task && S.task.plan && S.task.plan.some((p) => !p.done));
  const checks = S.task ? S.task.checks || 0 : 0;
  if (!cont && actionsOn() && (actedNow || planLeft) && checks < MAX_DONE_CHECKS) {
    if (!S.task) S.task = { goal: S.question, steps: 0, checks: 0 };
    S.task.checks = checks + 1;
    cont = true; checking = true;
    log(`checking the task is really finished (${planLeft ? 'plan has parts left' : 'it just acted'})`);
  }
  // Clicks and keys run one after another while it talks; drawings show at once.
  let acting = Promise.resolve();
  const errors = [];
  const runAction = (a) => {
    acting = acting.then(() => doAction(a, shots, turn)).catch((e) => { errors.push(e.message); log('action failed:', e.message); });
  };
  const key = (host.hotkeyLabel && host.hotkeyLabel()) || (isMac ? 'Option+C' : 'Alt+C');
  setMode('speaking', { hint: `Esc stops · tap ${key} for quick chat` });
  toBar('voiceWords', { hint: `Esc stops · tap ${key} for quick chat` });
  // Every sentence in order; the next one is made while the current one plays.
  const queue = [];
  for (const c of chunks) {
    const ss = sentences(c.text);
    if (!ss.length) queue.push({ text: '', actions: c.actions });
    ss.forEach((s, i) => queue.push({ text: s, actions: i === 0 ? c.actions : [] }));
  }
  // Doing things: get the job done, don't talk it through. Steps in the middle
  // of a task are silent; the first and last say one short line at most.
  // (Only clicking tasks go quiet; an answer looked up on the web is told in full.)
  const doing = chunks.some((c) => c.actions.some((a) => GUI_KINDS.has(a.kind) || (TOOL_KINDS.has(a.kind) && !WEB_KINDS.has(a.kind))));
  if (S.task && cont) for (const q of queue) q.text = '';
  else if (doing || S.guiUsed) { let said = false; for (const q of queue) { if (q.text && said) q.text = ''; else if (q.text) said = true; } }
  let pending = queue.length && queue[0].text ? speakAudio(spoken(queue[0].text)) : null;
  let firstAudio = true;
  for (let i = 0; i < queue.length; i++) {
    if (turn !== S.turn) return;
    const q = queue[i];
    // Clicks and drawings never wait on the voice; the voice gets 5 seconds at most.
    for (const a of q.actions) (ACT_KINDS.has(a.kind) ? runAction(a) : draw(a, shots));
    const audio = q.text ? await withTimeout(pending, 5000) : null;
    const nextQ = queue.slice(i + 1).find((x) => x.text);
    pending = nextQ ? speakAudio(spoken(nextQ.text)) : null;
    if (firstAudio && q.text) { firstAudio = false; log(`first words after ${Date.now() - S.t0}ms`); }
    if (q.text) {
      sendTo(S.buddyDisplay, { type: 'say', text: q.text });
      toBar('voiceWords', { say: q.text });
      await play(audio, q.text);
    }
  }
  await acting;
  if (turn !== S.turn) return;
  // Something failed: never stop there, look again and recover.
  if (!cont && errors.length && actionsOn() && (S.task ? S.task.checks || 0 : 0) < MAX_DONE_CHECKS) {
    if (!S.task) S.task = { goal: S.question, steps: 0, checks: 0 };
    S.task.checks = (S.task.checks || 0) + 1;
    cont = true; checking = true;
  }
  if (agent) host.voiceTask(agent);
  // A task with more steps: look at the screen again and keep going.
  if (cont && (actionsOn() || usedWeb)) {
    if (!S.task) S.task = { goal: S.question, steps: 0 };
    S.task.steps++;
    if (S.task.steps < MAX_ACT_STEPS) {
      S.state = 'thinking';
      toBar('voiceState', 'thinking');
      // A small spinning ring on the cursor, not a stop: the flow keeps going.
      sendTo(S.buddyDisplay, { type: 'mode', mode: 'working' });
      await sleep(300); // let the screen settle
      if (turn !== S.turn) return;
      sendAll({ type: 'clear-drawings' });
      // A screenshot only when the screen changed (clicks, keys, something opened) or it asked to [LOOK].
      const lookNow = look || S.lookNext || chunks.some((c) => c.actions.some((a) => GUI_KINDS.has(a.kind)));
      S.lookNext = false;
      return answer({ said: '', turn, followUp: { kind: 'act', errors: errors.join('; '), checking, look: lookNow } });
    }
  }
  S.task = null;
  if (next) {
    if (!S.teach) S.teach = { goal: S.question, steps: 0 };
    S.teach.steps++;
    if (S.teach.steps < MAX_TEACH_STEPS) {
      S.state = 'teaching';
      toBar('voiceState', 'teaching');
      sendTo(S.buddyDisplay, { type: 'your-turn' });
      clearTimeout(S.idleTimer);
      S.idleTimer = setTimeout(() => { if (S.state === 'teaching') finish(); }, TEACH_WAIT_MS);
      return;
    }
  }
  S.teach = null;
  finish();
}

// In a walkthrough: they clicked, let the screen settle, then the next step.
let stepping = false;
function stepDone(e) {
  if (stepping) return;
  stepping = true;
  const turn = ++S.turn;
  clearTimeout(S.idleTimer);
  const p = screen.getCursorScreenPoint();
  setTimeout(async () => {
    stepping = false;
    if (turn !== S.turn) return;
    sendAll({ type: 'clear-drawings' });
    S.away = false;
    let at = '';
    const shots = await captureScreens().catch(() => []);
    const shot = shots.find((s) => p.x >= s.display.bounds.x && p.x < s.display.bounds.x + s.display.bounds.width);
    if (shot) { const [x, y] = toImg(shot, p.x - shot.display.bounds.x, p.y - shot.display.bounds.y); at = `${x},${y} on screen${shot.index}`; }
    S.shots = Promise.resolve(shots);
    await answer({ said: '', turn, followUp: { at } });
  }, 900);
}

// ─── Ending ─────────────────────────────────────────────────────────────────
function finish(note) {
  if (note) { setMode('speaking'); sendTo(S.buddyDisplay, { type: 'say', text: note, note: true }); toBar('voiceWords', { say: note, note: true }); }
  S.state = 'idle';
  toBar('voiceState', 'idle');
  clearTimeout(S.idleTimer);
  // The buddy stays on what it pointed at for a beat, comes home, the drawings fade, then everything hides.
  if (!note) S.lastAnswerAt = Date.now();
  S.idleTimer = setTimeout(() => {
    sendAll({ type: 'fade' });
    toBar('voiceWords', { clear: true });
    S.idleTimer = setTimeout(() => { if (S.state === 'idle') { stopFollow(); hideOverlays(); S.buddyDisplay = null; } }, 700);
  }, note ? 3500 : 6000);
}

function stopTurn() {
  S.turn++;
  S.teach = null;
  S.task = null;
  clearTimeout(S.idleTimer); clearTimeout(S.listenTimer);
  sendTo(audioHost(), { type: 'stop-audio' });
  for (const done of S.playWaiters.values()) done();
  S.playWaiters.clear();
}

function cancel() {
  stopTurn();
  catchMouse(false);
  sendTo(audioHost(), { type: 'mic-cancel' });
  S.state = 'idle';
  toBar('voiceState', 'idle');
  sendAll({ type: 'fade' });
  setTimeout(() => { if (S.state === 'idle') { stopFollow(); hideOverlays(); S.buddyDisplay = null; } }, 500);
}

// ─── Speech to text, in its own process ─────────────────────────────────────
let sttProc = null;
let sttReady = false;
const sttWaiters = new Map();
function sttProcess() {
  if (sttProc) return sttProc;
  const cache = path.join(app.getPath('appData'), 'Codeply Crew', 'voice-models');
  sttProc = utilityProcess.fork(path.join(__dirname, 'voice', 'stt-process.js'), [cache], { serviceName: 'Codeply voice' });
  sttProc.on('message', (m) => {
    if (!m) return;
    if (m.type === 'ready') { sttReady = true; log(`speech model ready in ${m.ms}ms`); return; }
    if (m.type === 'error' && !m.id) { log('speech model:', m.error); return; }
    const w = sttWaiters.get(m.id);
    if (w) { sttWaiters.delete(m.id); w(m); }
  });
  sttProc.on('exit', () => {
    sttProc = null; sttReady = false;
    for (const w of sttWaiters.values()) w({ type: 'error', error: 'the speech process stopped' });
    sttWaiters.clear();
  });
  return sttProc;
}
function warmStt() { try { sttProcess().postMessage({ type: 'load' }); } catch (e) { log(e.message); } }
function transcribe(pcm) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const t = setTimeout(() => { sttWaiters.delete(id); reject(new Error('speech to text took too long')); }, 90000);
    sttWaiters.set(id, (m) => { clearTimeout(t); if (m.type === 'result') resolve(m.text); else reject(new Error(m.error)); });
    sttProcess().postMessage({ type: 'transcribe', id, pcm });
  });
}

function stt() {
  if (!voiceLib) {
    voiceLib = require('./crew/voice');
    voiceLib.init({ cacheDir: path.join(app.getPath('appData'), 'Codeply Crew', 'voice-models') });
  }
  return voiceLib;
}

// ─── Wiring ─────────────────────────────────────────────────────────────────
function init(h) {
  host = h;
  ipcMain.on('voice:from', (e, m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'level') { if (S.buddyDisplay != null) sendTo(S.buddyDisplay, { type: 'level', v: m.v }); toBar('voiceLevel', m.v); }
    else if (m.type === 'pcm') { const w = S.pcmWaiters.get(m.id); if (w) { S.pcmWaiters.delete(m.id); w(m.pcm); } }
    else if (m.type === 'played') { const w = S.playWaiters.get(m.id); if (w) { S.playWaiters.delete(m.id); w(); } }
    else if (m.type === 'stroke') {
      if (DEBUG) log(`stroke from screen ${m.display} while ${S.state}: ${JSON.stringify(m.box)}`);
      if (S.state === 'listening') S.strokes.push({ displayId: Number(m.display), box: m.box });
    }
    else if (m.type === 'bubble-rect') {
      bubbleRect = m.none ? null : { display: Number(m.display), x: m.x, y: m.y, w: m.w, h: m.h };
      if (bubbleRect) watchHover();
    }
    else if (m.type === 'stop') cancel();
    else if (m.type === 'open-drop') { const q = S.question; cancel(); host.openDrop(q); }
    else if (m.type === 'mic-error') { if (S.state === 'listening' || S.state === 'thinking') { S.turn++; catchMouse(false); finish(`I can't hear you: ${m.error}`); } }
  });
  screen.on('display-added', () => { if (overlays.size) syncOverlays(); });
  screen.on('display-removed', () => { if (overlays.size) syncOverlays(); });
  screen.on('display-metrics-changed', () => { if (overlays.size) syncOverlays(); });
  startHook();
  // The overlays load once, early, so the first hold shows the buddy at once.
  setTimeout(() => { try { syncOverlays(); } catch (e) { log(e.message); } }, 3000);
  // Someone who uses voice gets Whisper loaded in the background, so the first answer isn't the slow one.
  if (hook && host.getSetting('voiceUsed')) setTimeout(warmStt, 10000);
  // The Windows helper (clicks, and the "are the keys still held?" check) compiles
  // once per launch: do it early while idle, never on a key press.
  if (hook) setTimeout(() => act.warm(), 6000);
}

function dispose() {
  try { if (hook) hook.stop(); } catch {}
  try { if (sttProc) sttProc.kill(); } catch {}
  for (const w of overlays.values()) { try { w.destroy(); } catch {} }
}

module.exports = {
  init, press, dispose, available: () => !!hook,
  setMuted: (on) => host.setSetting('voiceMuted', !!on), isMuted: () => muted(),
  canAct: () => act.supported(), actionsOn: () => actionsOn(), setActions: (on) => host.setSetting('voiceActions', !!on),
};
