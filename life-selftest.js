// Life Integrated Bots self-test in real Electron: `CRAFT_LIFE_SELFTEST=<folder>`.
//
// The node tests (scripts/life-test.mjs) cover the engine. This runs the
// desktop side the way the app does: life-desktop.js with Electron's own
// safeStorage and Notification, the real Crew page (crew-main.js, preload,
// life.js) in a window, the Windows window sampler, the engine's bots and
// store. Google, the model and Codeply's server are fakes, and everything
// lives in a throwaway home folder, so it never touches the user's data or a
// Craft that is already running. Writes report.json and screenshots to the
// folder and exits 0 when every step passed.
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = __dirname;
const CLI_DIR = path.join(ROOT, 'codeply-cli');
const OUT = path.resolve(process.env.CRAFT_LIFE_SELFTEST || path.join(os.tmpdir(), 'craft-life-selftest'));
const HOME = path.join(os.tmpdir(), `craft-life-selftest-home-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
// ~/.codeply (bots, config, the life store) and Crew's own folder go to the throwaway home.
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.CODEPLY_TELEMETRY = '0'; // a test is not a user

const { app, BrowserWindow, ipcMain, safeStorage, Notification } = require('electron');
app.setPath('appData', path.join(HOME, 'AppData'));
app.setPath('userData', path.join(HOME, 'AppData', 'craft-life-selftest'));
app.on('window-all-closed', () => {});

const MIN = 60000; const HOUR = 3600000;
const results = [];
const step = async (name, fn, { timeoutMs = 60000 } = {}) => {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs))]);
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail == null ? '' : String(detail).slice(0, 400) });
    console.log(`  ok    ${name}${detail ? `  (${String(detail).slice(0, 160)})` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String((e && e.stack) || e).slice(0, 800) });
    console.log(`  FAIL  ${name}\n        ${String((e && e.message) || e).slice(0, 400)}`);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await wait(every);
  }
}

// ─── Fakes: Google, the model, Codeply's functions ──────────────────────────

const NOW = Date.now();
const events = [
  { id: 'hang', summary: 'Hangout with Hamza', location: 'Cafe Aylanto, Gulberg', start: { dateTime: new Date(NOW + 15 * MIN).toISOString() }, end: { dateTime: new Date(NOW + 2 * HOUR).toISOString() }, attendees: [{ email: 'me@example.com', self: true }, { email: 'hamza@example.com', displayName: 'Hamza' }] },
  { id: 'launch', summary: 'Craft launch deadline', start: { dateTime: new Date(NOW + 30 * HOUR).toISOString() }, end: { dateTime: new Date(NOW + 31 * HOUR).toISOString() } },
];
const mails = [
  { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'], from: 'Maria Lopez <maria@vc.example>', subject: 'Follow up on our call', at: NOW - 26 * HOUR },
];
const fakeGmail = () => ({
  profile: async () => ({ emailAddress: 'me@example.com', historyId: '10' }),
  list: async () => mails.map((m) => m.id),
  history: async (start) => ({ ids: [], historyId: String(Number(start) + 1) }),
  meta: async (id) => {
    const m = mails.find((x) => x.id === id);
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: 'Wanted to follow up', internalDate: String(m.at), payload: { headers: [{ name: 'From', value: m.from }, { name: 'To', value: 'me@example.com' }, { name: 'Subject', value: m.subject }] } };
  },
});
const modelCalls = [];
const fakeAi = {
  async chatJson(messages) {
    const p = String(messages[0].content || '');
    modelCalls.push(p.slice(0, 80));
    if (/decide whether the user's bots reach out/.test(p)) {
      const keys = [...p.matchAll(/key=(\S+)/g)].map((m) => m[1]);
      return { success: true, json: { messages: keys.map((key) => ({ key, send: true, how: 'text', text: key.startsWith('leaving') ? 'Hangout with Hamza in 15. Wallet, keys, phone?' : `About ${key}` })) } };
    }
    if (/Summarize this call/.test(p)) {
      if (/Zoom|contract|Acme/i.test(p)) return { success: true, json: { title: 'Zoom call about the Acme contract', summary: 'They said the Acme contract is due Friday. Zoe took over at the end.', people: ['Them'], plans: [], todo: [], forBot: [] } };
      return { success: true, json: { title: 'Call with Zoe about the weekend', summary: 'Planned brunch with Sara on Sunday at 11.', people: ['Sara'], plans: [{ what: 'Brunch with Sara', when: '', where: 'Cafe Zouk', who: ['Sara'] }], todo: ['Book a table for two'] } };
    }
    if (/quietly helping/.test(p)) return { success: true, json: { cards: [{ title: 'Acme contract', text: 'Due Friday (from what they said).' }], whisper: 'Ask whether Friday still works for the signature.' } };
    if (/has handed you a live call/.test(p)) return { success: true, json: { say: "Hi, this is Zoe, Awais's assistant. Awais's internet just dropped, he will call you back later. Thanks, bye for now." } };
    if (/This email came to your own address/.test(p)) return { success: true, json: { summary: 'Sara asks if Friday works for the review.', needsReply: true, reply: 'Hi Sara, Friday works. Zoe', urgent: false } };
    return { success: true, json: { facts: [], plans: [] } };
  },
};
const functionCalls = [];
// Desktop notifications are recorded, not shown: a test should not pop toasts on the user's screen.
const shown = [];
class FakeNotification { constructor(o) { this.o = o; } static isSupported() { return true; } on() {} show() { shown.push(this.o); } }
// Codeply's functions: reminders, and bot-mail / slack-events with a tiny in-memory server.
const serverInbox = [];
const fakeCallFunction = async (name, body) => {
  functionCalls.push({ name, body });
  if (name === 'bot-mail') {
    if (body.action === 'claim') return { success: true, address: `${String(body.local).toLowerCase()}@codeply.app` };
    if (body.action === 'list') return { success: true, domain: 'codeply.app', boxes: [{ address: 'zoe@codeply.app', bot_id: 'x', bot_name: 'Zoe' }], used: { day: 2, month: 7 }, limits: { day: 10, month: 50 }, sending: true };
    if (body.action === 'inbox') return { success: true, mail: serverInbox.splice(0) };
    if (body.action === 'send') return { success: true, id: `s${functionCalls.length}`, used: { day: 3, month: 8 }, limits: { day: 10, month: 50 }, from: 'zoe@codeply.app' };
  }
  if (name === 'slack-events') return { success: true, events: [] };
  return { success: true };
};

app.whenReady().then(async () => {
  // A config with Gmail "connected", so Crew and the life engine think Google is there.
  fs.mkdirSync(path.join(HOME, '.codeply'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.codeply', 'config.json'), JSON.stringify({ gmail: { accessToken: 'fake', refreshToken: 'fake', email: 'me@example.com', expiresAt: Date.now() + 3600e3 } }));
  const bots = require(path.join(CLI_DIR, 'lib', 'bots.js'));
  const zoe = bots.createBot({ name: 'Zoe', specialty: 'personal life and social plans', tone: { preset: 'playful' } });
  const rex = bots.createBot({ name: 'Rex', specialty: 'work and code, keeps projects on track' });

  const crewMain = require('./crew/crew-main');
  const lifeDesktop = require('./life-desktop');
  let host = null;
  let lifeDeps = null;

  await step('the life engine starts with Electron safeStorage', async () => {
    lifeDesktop.init(lifeDeps = {
      ipcMain, cliDir: CLI_DIR, ensureEngine: async () => true, safeStorage, Notification: FakeNotification, notifyIcon: undefined,
      userDataDir: app.getPath('userData'), modulePaths: [ROOT, CLI_DIR],
      configLib: () => require(path.join(CLI_DIR, 'lib', 'config.js')),
      oauthLib: () => ({ calendarListEvents: async () => events }),
      aiLib: () => fakeAi, currentRoute: () => ({ auto: true }),
      gmailToken: async () => 'fake', callFunction: fakeCallFunction, gmailApi: fakeGmail,
      projects: () => [{ path: ROOT, name: 'Codeply Craft', lastActive: Date.now() - HOUR }],
      crewThread: (botId, msg) => crewMain.addNote(CLI_DIR, botId, msg),
      crewEvent: (ev) => crewMain.pushEvent(ev),
      openBot: () => {},
    });
    crewMain.setLifeHooks({ onCall: (c) => lifeDesktop.noteCall(c) });
    if (lifeDesktop.isOn()) throw new Error('Life should be off until the user turns it on');
    return safeStorage.isEncryptionAvailable() ? 'safeStorage available' : 'no safeStorage (sealed items off)';
  });

  await step('the Crew page loads with the Life entry', async () => {
    // Off screen and never focused: capturePage needs a window that is really shown.
    host = new BrowserWindow({ width: 1280, height: 860, x: -6000, y: 0, show: false, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true } });
    host.showInactive();
    await host.loadURL('about:blank');
    crewMain.embed(CLI_DIR, host, { x: 0, y: 0, width: 1280, height: 860 });
    const wc = () => host.getBrowserViews()[0].webContents;
    await until(() => !wc().isLoading());
    await until(() => wc().executeJavaScript('!!document.querySelector("#lifeNav") && !!window.CrewState && (window.CrewState.catalog.bots || []).length === 2'), 20000);
    host.wc = wc;
    return 'Life button in the sidebar, 2 bots';
  });
  const js = (code) => host.wc().executeJavaScript(code);
  const shot = async (name) => {
    try { const img = await host.wc().capturePage(); fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG()); return name; } catch (e) { console.log(`  (no screenshot ${name}: ${e.message})`); return ''; }
  };

  await step('Life page: the intro, then Turn on Life', async () => {
    await js('document.querySelector("#lifeNav").click()');
    await until(() => js('!!document.querySelector(".life-intro [data-act=turn-on]")'));
    await shot('1-life-off');
    await js('document.querySelector(".life-intro [data-act=turn-on]").click()');
    await until(() => js('document.querySelectorAll(".life-src").length >= 8'));
    if (!lifeDesktop.isOn()) throw new Error('turning it on did not start the engine');
    return 'sources listed, engine running';
  });

  await step('calendar, Gmail and projects fill the store', async () => {
    const store = await until(() => lifeDesktop.getStore());
    await until(() => store.getItem('calendar:hang') && (store.getState('gmail.waiting') || []).length === 1 && store.items({ sources: ['projects'] }).length === 1, 30000).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(lifeDesktop.status().sources)}`); });
    const p = store.items({ sources: ['projects'] })[0];
    return `event at ${store.getItem('calendar:hang').place}; Maria waiting; project git=${p.data.git} lastPush=${!!p.data.lastPush}`;
  }, { timeoutMs: 40000 });

  await step('the window in front is sampled (Windows helper)', async () => {
    if (process.platform !== 'win32') return 'skipped: not Windows';
    const store = lifeDesktop.getStore();
    const idle = await until(() => store.getState('pc.idle'), 20000);
    const cur = store.getState('activity.current');
    return `idle ${idle.seconds}s, current: ${cur ? cur.kind : 'none (away or private)'}`;
  }, { timeoutMs: 30000 });

  await step('the bots see RIGHT NOW in their prompt', async () => {
    const prompt = bots.buildBotPrompt(bots.getBot(zoe.id), { native: true });
    if (!/RIGHT NOW/.test(prompt) || !/Hangout with Hamza/.test(prompt) || !/Maria/.test(prompt)) throw new Error(prompt.slice(-1500));
    return 'next event and who is waiting are in the prompt';
  });

  await step('a nudge 15 minutes before the hangout, from the life bot, in its thread', async () => {
    lifeDesktop.poke('nudges');
    const store = lifeDesktop.getStore();
    const n = await until(() => store.nudgesSince(NOW - HOUR, 10).find((x) => x.trigger === 'leaving'), 20000);
    if (n.botId !== zoe.id) throw new Error(`sent by ${n.botId}, expected Zoe`);
    if (!/Wallet, keys/.test(n.text)) throw new Error(n.text);
    const viaPhone = functionCalls.some((c) => c.name === 'reminders' && c.body.reminder.payload.nudge.id === n.id);
    return `"${n.text}" (${viaPhone ? 'phone' : shown.length ? 'desktop notification' : 'neither'} and Crew)`;
  });

  await step('the nudge card in Crew, and Helpful is saved', async () => {
    await js(`document.querySelector('.bot-item[data-id="${zoe.id}"]').click()`);
    await until(() => js('!!document.querySelector(".lcard.nudge [data-fb=helpful]")'));
    await shot('3-nudge-card');
    await js('document.querySelector(".lcard.nudge [data-fb=helpful]").click()');
    const store = lifeDesktop.getStore();
    await until(() => store.nudgesSince(NOW - HOUR, 10).some((x) => x.feedback === 'helpful'));
    return 'feedback stored';
  });

  await step('a call is summarized and kept sealed, its plan shared', async () => {
    const item = await lifeDesktop.noteCall({ source: 'crew', botId: zoe.id, ms: 95000, turns: [{ who: 'user', text: 'Let us do brunch with Sara on Sunday' }, { who: 'bot', text: 'Love it, I will remember.' }] });
    if (!item || item.title !== 'Call with Zoe about the weekend') throw new Error(JSON.stringify(item));
    const store = lifeDesktop.getStore();
    if (store.canSeal) {
      const files = ['life.db', 'life.db-wal'].map((f) => path.join(HOME, '.codeply', 'life', f)).filter((f) => fs.existsSync(f));
      if (files.some((f) => fs.readFileSync(f).toString('latin1').includes('brunch with Sara on Sunday'))) throw new Error('the transcript is on disk in clear text');
    }
    if (!store.search('Brunch with Sara').some((x) => x.source === 'plans')) throw new Error('the plan from the call is missing');
    return store.canSeal ? 'sealed on disk, plan stored' : 'no key on this PC: transcript not kept, plan stored';
  });

  await step('Orbit and drop questions are noted', async () => {
    lifeDesktop.noteAsk('How do I rebase onto main?', 'Run git rebase main', 'orbit');
    return lifeDesktop.getStore().search('rebase').length ? 'kept' : (() => { throw new Error('missing'); })();
  });

  await step('the bot editor has the Life settings and they save', async () => {
    const html = await js(`window.CrewLife.editorHtml(JSON.parse(JSON.stringify(window.CrewState.catalog.bots.find((b) => b.id === "${rex.id}"))), { id: "${rex.id}" })`);
    for (const want of ['Reads your life context', 'On its own', 'On calls', 'Get address']) if (!html.includes(want)) throw new Error(`missing "${want}"`);
    const r = await js(`window.crew.botsUpdate("${rex.id}", { autonomy: { level: 'hold', holdMinutes: 15 }, life: { read: true, speaksFor: ['deadline'] }, callStyle: { style: 'formal', excuses: ['Awais is in a meeting and will call you back.'] } })`);
    const b = bots.getBot(rex.id);
    if (b.autonomy.level !== 'hold' || b.autonomy.holdMinutes !== 15 || b.callStyle.excuses.length !== 1 || !b.life.speaksFor.includes('deadline')) throw new Error(JSON.stringify(r).slice(0, 400));
    return 'autonomy, life and call style saved on the bot';
  });

  // Screenshots come from an offscreen copy of the Crew page (a BrowserView cannot be captured off screen).
  async function pageShot(name, script, ready, height = 900) {
    const w = new BrowserWindow({ width: 1280, height, show: false, webPreferences: { offscreen: true, preload: path.join(ROOT, 'crew', 'preload.js'), contextIsolation: true } });
    try {
      await w.loadFile(path.join(ROOT, 'crew', 'index.html'), { query: { embedded: '1' } });
      await until(() => w.webContents.executeJavaScript('!!document.querySelector("#lifeNav") && !!window.CrewState && (window.CrewState.catalog.bots || []).length > 0'));
      await w.webContents.executeJavaScript(script);
      await until(() => w.webContents.executeJavaScript(ready));
      await wait(900);
      const img = await w.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
      return `${name}.png`;
    } finally { w.destroy(); }
  }
  await step('screenshots: the Life page and a nudge in a thread', async () => {
    const a = await pageShot('2-life-on', 'document.querySelector("#lifeNav").click()', '!!document.querySelector(".life-rows")');
    const b = await pageShot('3-nudge-card', `document.querySelector('.bot-item[data-id="${zoe.id}"]').click()`, '!!document.querySelector(".lcard.nudge")');
    return `${a}, ${b}`;
  });

  // ─── Bot mail, the autopilot and the call helper, wired like main.js ──────
  const botsMail = require('./bots-mail');
  const autopilot = require('./autopilot');
  const callListen = require('./call-listen');
  const keysSent = [];
  const tasksRun = [];
  const fakeAgent = {
    async* runAgent(o) {
      if (o.verifyOnly) { yield { type: 'text', text: 'Read the README again.\nVERIFIED: yes - the README has the new section' }; yield { type: 'done' }; return; }
      tasksRun.push(o.userMessage);
      yield { type: 'tool_end', name: 'edit_file', ok: true, summary: 'README.md' };
      yield { type: 'text', text: 'Tidied the README.' };
      yield { type: 'done' };
    },
  };
  // A valid, silent quarter-second WAV: the bot's "voice" in the takeover.
  const silentWav = (() => { const n = 4000; const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return new Uint8Array(b); })();
  const shared = {
    ipcMain, cliDir: CLI_DIR, ensureEngine: async () => true, Notification: FakeNotification, notifyIcon: undefined,
    configLib: () => require(path.join(CLI_DIR, 'lib', 'config.js')), oauthLib: () => ({}), aiLib: () => fakeAi, currentRoute: () => ({ auto: true }),
    callFunction: fakeCallFunction, localTz: () => 'Asia/Karachi', life: lifeDesktop,
    crewThread: (botId, msg) => crewMain.addNote(CLI_DIR, botId, msg), openBot: () => {},
  };

  await step('bot mail, the autopilot and the call helper start', async () => {
    lifeDesktop.setSettings({});
    lifeDeps.mailUsage = () => botsMail.usage();
    lifeDeps.autopilotState = () => autopilot.state();
    botsMail.init({ ...shared, onTask: (t) => autopilot.intake(t), hold: (h) => autopilot.hold(h), budgetLeft: (b, k) => autopilot.budgetLeft(b, k), audit: (e) => autopilot.audit(e) });
    autopilot.init({ ...shared, agentMod: () => fakeAgent, botsMail, projects: () => [], workspace: () => HOME, stopCrew: () => crewMain.stopAll(), stopCalls: () => callListen.stopAll() });
    const realCache = path.join(process.env.APPDATA || '', 'Codeply Crew', 'voice-models');
    callListen.init({
      ...shared, act: { supported: () => true, keys: async (k) => { keysSent.push(k); } },
      voiceLib: () => ({ engineOf: () => 'edge', speak: async () => ({ mime: 'audio/wav', data: silentWav }) }),
      serverToken: async () => '', userName: () => 'Awais', audit: (e) => autopilot.audit(e),
      sttCacheDir: fs.existsSync(realCache) ? realCache : undefined, windowPos: { x: -6000, y: 0 },
    });
    return fs.existsSync(realCache) ? 'Whisper from the cached model' : 'Whisper will download its model';
  });

  await step('a bot gets its own address (Edit bot, Email)', async () => {
    const r = await js(`window.crew.botMailClaim("${zoe.id}", "zoe")`);
    if (!r || !r.bot || r.bot.email.address !== 'zoe@codeply.app') throw new Error(JSON.stringify(r));
    if (bots.getBot(zoe.id).email.address !== 'zoe@codeply.app') throw new Error('not saved on the bot');
    if (!/YOUR OWN EMAIL/.test(bots.buildBotPrompt(bots.getBot(zoe.id), { native: true }))) throw new Error('the bot does not know its address');
    return 'zoe@codeply.app, and Zoe knows it';
  });

  await step('mail to the bot: a card with a draft, and Send reply sends it in the thread', async () => {
    serverInbox.push({ id: 'in1', botId: zoe.id, mailbox: 'zoe@codeply.app', from: 'sara@acme.example', fromName: 'Sara', subject: 'Friday?', text: 'Does Friday work for the review?', messageId: '<in1@acme>', fromUser: false, at: new Date().toISOString() });
    await botsMail.poll();
    await js(`document.querySelector('.bot-item[data-id="${zoe.id}"]').click()`);
    await until(() => js('!!document.querySelector(".lcard.mail [data-mail-send]")'));
    await js('document.querySelector(".lcard.mail [data-mail-send]").click()');
    const sent = await until(() => functionCalls.find((c) => c.name === 'bot-mail' && c.body.action === 'send'));
    if (sent.body.to !== 'sara@acme.example' || sent.body.inReplyTo !== '<in1@acme>' || !/Friday works/.test(sent.body.text)) throw new Error(JSON.stringify(sent.body));
    return `replied to ${sent.body.to}, subject "${sent.body.subject}"`;
  });

  await step('the Life page shows the crew\'s shared allowance', async () => {
    const st = await js('window.crew.lifeState()');
    if (!st.mail || st.mail.limits.month !== 50 || st.mail.limits.day !== 10) throw new Error(JSON.stringify(st.mail));
    return `${st.mail.used.month} of ${st.mail.limits.month} this month, ${st.mail.used.day} of ${st.mail.limits.day} today`;
  });

  await step('the autopilot works a task, checks it, and reports in the bot\'s thread', async () => {
    const r = autopilot.intake({ botId: rex.id, source: 'crew', requester: 'user', text: 'Tidy the README' });
    if (r.error) throw new Error(r.error);
    const s = lifeDesktop.getStore();
    const t = await until(() => { const x = s.getTask(r.task.id); return x && ['done', 'failed'].includes(x.status) && x; }, 20000);
    if (t.status !== 'done' || t.data.verified !== 'yes') throw new Error(JSON.stringify(t));
    await js(`document.querySelector('.bot-item[data-id="${rex.id}"]').click()`);
    await until(() => js('!!document.querySelector(".lcard.task .s-done")'));
    return `done, ${t.data.checked}`;
  });

  await step('the phone sees what is waiting and can cancel it (relay routes)', async () => {
    const held = autopilot.hold({ botId: zoe.id, tool: 'bot_email_send', title: 'Email Hamza the photos', detail: 'Hi Hamza', minutes: 30 });
    const g = await autopilot.bridge('GET', '/api/life', null);
    const o = g.body.outbox.find((x) => x.title === 'Email Hamza the photos');
    if (!o) throw new Error(JSON.stringify(g.body));
    const c = await autopilot.bridge('POST', '/api/life/outbox', { id: o.id, action: 'cancel' });
    if (c.status !== 200 || (await held) !== 'cancelled') throw new Error(JSON.stringify(c));
    return 'listed, then cancelled from the phone';
  });

  await step('Stop all bots from the Life page, then Resume', async () => {
    await js('document.querySelector("#lifeNav").click()');
    await until(() => js('!!document.querySelector("[data-act=stop-all]")'));
    await js('document.querySelector("[data-act=stop-all]").click()');
    await until(() => js('!!document.querySelector("[data-act=resume]")'));
    if (!lifeDesktop.settings().autopilot.paused) throw new Error('not paused');
    await js('document.querySelector("[data-act=resume]").click()');
    await until(() => !lifeDesktop.settings().autopilot.paused);
    return 'paused, then resumed';
  });

  await step('screenshot: the whole Life page with mail and the autopilot', async () => pageShot('4-life-full', 'document.querySelector("#lifeNav").click()', '!!document.querySelector(".life-meter")', 3000).then(() => pageShot('5-life-bottom', 'document.querySelector("#lifeNav").click(); setInterval(() => { const l = document.querySelector(".life"); if (l) l.scrollTop = 1e6; }, 200)', '!!document.querySelector(".life-meter") && document.querySelector(".life").scrollTop > 400')));

  // Speech made offline by Windows' own voice (System.Speech), as 16 kHz samples for Whisper.
  function speech(text) {
    if (process.platform !== 'win32') return null;
    const file = path.join(HOME, `say-${Date.now()}.wav`);
    require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $s.SetOutputToWaveFile('${file.replace(/'/g, "''")}'); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`], { windowsHide: true, cwd: HOME });
    const b = fs.readFileSync(file);
    const rate = b.readUInt32LE(24); const bits = b.readUInt16LE(34); const ch = b.readUInt16LE(22);
    let off = 12; while (off < b.length - 8 && b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
    const n = Math.floor(b.readUInt32LE(off + 4) / (bits / 8) / ch);
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = bits === 16 ? b.readInt16LE(off + 8 + i * 2 * ch) / 32768 : (b.readUInt8(off + 8 + i * ch) - 128) / 128;
    const out = new Float32Array(Math.floor(n * 16000 / rate));
    for (let i = 0; i < out.length; i++) { const x = i * rate / 16000; const j = Math.floor(x); out[i] = src[j] + (src[Math.min(j + 1, n - 1)] - src[j]) * (x - j); }
    return out;
  }

  const helper = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Call helper' || /call-listen/.test(w.webContents.getURL()));
  const hjs = (code) => helper().webContents.executeJavaScript(code);

  // The Zoom window stays in front for the whole test call (what the life sampler would report).
  const zoomSeen = setInterval(() => { const s = lifeDesktop.getStore(); if (s) s.setState('call.current', { app: 'Zoom', since: NOW, seenAt: Date.now() }); }, 2000);
  await step('a Zoom call shows up: the helper offers to listen, after a consent tick', async () => {
    lifeDesktop.setSettings({ calls: { listen: 'ask', consentAck: false, botId: zoe.id } });
    callListen.onCallWindow({ app: 'Zoom', since: Date.now(), seenAt: Date.now() });
    await until(() => helper() && !helper().webContents.isLoading());
    await until(() => hjs('!!document.querySelector("#listen") && document.querySelector("#listen").disabled && !!document.querySelector("#consent")'));
    // No real mic or system audio in a test: the window gets silent stand-ins.
    await hjs('navigator.mediaDevices.getUserMedia = async () => { throw new Error("no mic in the test"); }; navigator.mediaDevices.getDisplayMedia = async () => { throw new Error("no system audio in the test"); }; true');
    await hjs('document.querySelector("#consent").click(); true');
    await hjs('document.querySelector("#listen").click(); true');
    await until(() => callListen.state().active);
    if (!lifeDesktop.settings().calls.consentAck) throw new Error('consent not saved');
    return 'listening, consent remembered';
  });

  await step('Whisper on this PC writes the other side down', async () => {
    const pcm = speech('Sure, the Acme contract is due on Friday.');
    if (!pcm) return 'skipped: no Windows voice to make test speech';
    await callListen.chunk('them', pcm);
    const v = callListen.view();
    const line = v.turns.find((t) => t.who === 'them');
    if (!line || !/contract|friday/i.test(line.text)) throw new Error(JSON.stringify(v.turns));
    return `"${line.text}"`;
  }, { timeoutMs: 120000 });

  await step('cards and a whisper show in the helper', async () => {
    await until(() => hjs('!!document.querySelector(".card.whisper")'), 20000);
    const t = await hjs('document.querySelector(".card.whisper").innerText');
    return t.replace(/\s+/g, ' ').slice(0, 120);
  }, { timeoutMs: 30000 });

  await step('they ask for you, you are quiet: take over, the bot says it is your assistant, then hangs up Zoom', async () => {
    const pcm = speech('Awais? Are you there?');
    if (pcm) await callListen.chunk('them', pcm);
    if (!callListen.view().takeover) await hjs('document.querySelector("#handover").click(); true');
    await until(() => hjs('!!document.querySelector("#take")'), 15000);
    await hjs('document.querySelector("#take").click(); true');
    await until(() => keysSent.length >= 2, 20000);
    await until(() => !callListen.state().active, 15000);
    const said = callListen.view().turns.find((t) => t.who === 'bot');
    if (!said || !/Zoe, Awais's assistant/.test(said.text)) throw new Error(JSON.stringify(said));
    const call = lifeDesktop.getStore().items({ sources: ['calls'], limit: 5 }).find((x) => x.data.via === 'pc');
    if (!call) throw new Error('the call was not kept');
    return `said: "${said.text.slice(0, 70)}..."; keys ${keysSent.join(' then ')}; kept as "${call.title}"`;
  }, { timeoutMs: 60000 });

  clearInterval(zoomSeen);
  await step('turning Life off stops the engine and the bots stop seeing it', async () => {
    await js('window.crew.lifeSet({ on: false })');
    if (lifeDesktop.isOn()) throw new Error('still on');
    if (/RIGHT NOW/.test(bots.buildBotPrompt(bots.getBot(zoe.id), { native: true }))) throw new Error('the prompt still has life context');
    return 'off';
  });

  for (const extra of global.__lifeSelftestExtra || []) await extra({ step, js, shot, until, lifeDesktop, crewMain, bots, zoe, rex, HOME, OUT, functionCalls, modelCalls });

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), platform: process.platform, failed: failed.length, results, modelCalls: modelCalls.length }, null, 2));
  console.log(failed.length ? `\n${failed.length} failed` : '\nall passed');
  try { lifeDesktop.stop(); } catch {}
  setTimeout(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} app.exit(failed.length ? 1 : 0); }, 300);
});
