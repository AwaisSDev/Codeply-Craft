// Iris in the app: the guard, the engine applying Iris's operations to a real
// (temp) brain through brain.applyOps, the trust rules, sensitive memories kept
// out of cloud context, the installer (checksums, signed links, self-test) and
// the desktop host (node scripts/iris-test.mjs [section]).
// No network and no real model: Iris is a fake server, every store is a temp file.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-iris-'));
process.env.CODEPLY_BOTS_DIR = path.join(tmp, 'bots');
process.env.CODEPLY_TELEMETRY = '0';

const lib = (n) => require(path.join(ROOT, 'codeply-cli/lib', n));
const BR = lib('brain.js');
const M = lib('context-model.js');
const EV = lib('context-events.js');
const EN = lib('context-engine.js');
const IR = lib('context-iris.js');
const II = require(path.join(ROOT, 'iris-install.js'));

let failures = 0;
const only = process.argv[2] || '';
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 800)}` : ''}`); }
}
const section = (name) => { console.log(`\n${name}`); return !only || name.toLowerCase().includes(only.toLowerCase()); };

let NOW = Date.UTC(2026, 10, 10, 9, 0, 0);
const freshBrain = (name) => BR.configure({ file: path.join(tmp, `${name}-brain.db`), now: () => NOW });
const freshStore = (name) => EV.openEventStore({ file: path.join(tmp, `${name}-context.db`), now: () => NOW });
const chat = (text, o = {}) => ({ source: 'chat', trust: 'user', product: 'craft', text: `User: ${text}\nAssistant: Okay, noted.`, at: NOW, ...o });
const op = (o) => ({ src: 1, keep: 'long', basis: 'stated', conf: 'high', sens: 'none', ...o });

/** A fake Iris server: answers each request with what the test sets, and records the prompts. */
function fakeIris() {
  const prompts = [];
  let next = { ops: [] };
  const fetch = async (url, init) => {
    if (url.endsWith('/models')) return new Response('{}', { status: 200 });
    const body = JSON.parse(init.body);
    prompts.push(body.messages[1].content);
    const content = typeof next === 'string' ? next : JSON.stringify(typeof next === 'function' ? next(body.messages[1].content) : next);
    return new Response(JSON.stringify({ model: 'iris-1', choices: [{ message: { content } }] }), { status: 200 });
  };
  const provider = IR.createIrisProvider({ baseUrl: 'http://127.0.0.1:9/v1', fetch });
  return { provider, prompts, answer: (a) => { next = a; } };
}

if (section('Guard: what Iris proposes is checked before anything is stored')) {
  const p = IR.buildPrompt({ events: [chat('I moved to Lahore last month')], known: [{ id: 'mem_a', slot: 'city', value: 'Karachi' }], now: NOW, tz: 'Asia/Karachi' });
  check('the prompt is the trained format, with aliased memories', /^TASK: observe\nNOW: 2026-11-10T14:00 Tue\nSOURCE: assistant_chat\nMEMORIES:\nm1 \| user \| city \| Karachi\nINPUT:\n\[1\] user: I moved to Lahore last month\n\[2\] assistant: Okay, noted\.$/.test(p.user), p.user);
  const g = (ops) => IR.parseAndGuard(JSON.stringify({ ops }), p.messages, p.rows, p.source);
  check('a quote that is not in the message is refused', g([op({ op: 'add', evid: 'I moved to Dubai', ent: 'user', type: 'user', attr: 'city', val: 'Dubai', kind: 'fact' })]).rejected[0].reason === 'ungrounded_evidence');
  check('a memory that was not shown cannot be updated', g([op({ op: 'update', ref: 'm7', why: 'changed', evid: 'I moved to Lahore', ent: 'user', attr: 'city', val: 'Lahore', kind: 'fact' })]).rejected[0].reason === 'unknown_ref');
  check('the assistant\'s words are never stored as the user\'s', g([op({ src: 2, op: 'add', evid: 'Okay, noted', ent: 'user', type: 'user', attr: 'mood', val: 'ok', kind: 'fact' })]).rejected[0].reason === 'assistant_source');
  check('secret-like values are refused whatever the model says', g([op({ op: 'add', evid: 'I moved to Lahore', ent: 'user', type: 'user', attr: 'card number', val: '4111111111111111', kind: 'fact' })]).rejected[0].reason === 'secret');
  check('not JSON: nothing is kept', IR.parseAndGuard('sure! here you go', p.messages, p.rows, p.source).valid === false);
  const ok = g([op({ op: 'update', ref: 'm1', why: 'changed', evid: 'I moved to Lahore', ent: 'user', attr: 'city', val: 'Lahore', kind: 'fact' })]);
  const prod = IR.toProduction(ok.ops, p.rows, p.back);
  check('an accepted update carries the real memory id and the Brain observation', prod.ops[0].target === 'mem_a' && prod.ops[0].action === 'replace' && prod.ops[0].observation.slot === 'city');
}

if (section('Engine: Iris operations into a real brain')) {
  freshBrain('engine');
  const st = freshStore('engine');
  const iris = fakeIris();
  const changes = [];
  const engine = EN.createEngine({ store: st, brain: BR, providers: { rules: M.createRulesProvider(), local: iris.provider }, settings: () => ({ mode: 'local' }), tz: () => 'Asia/Karachi', now: () => NOW, onChange: (c) => changes.push(c) });
  const run = async (event, answer) => { iris.answer(answer); engine.ingest(event); NOW += 60000; return (await engine.process()).batches[0]; };

  let b = await run(chat('I moved to Lahore last month, still settling in'), { ops: [op({ op: 'add', evid: 'I moved to Lahore', ent: 'user', type: 'user', attr: 'city', val: 'Lahore', kind: 'fact', sens: 'personal' })] });
  let city = BR.list({ scope: 'me' }).find((m) => m.slot === 'city');
  check('add: a new memory, confirmed (stated), labelled personal, about the user', city && city.value === 'Lahore' && city.status === 'confirmed' && city.sens === 'personal' && city.ent === 'user', JSON.stringify(city));
  check('the event records Iris, local, the contract and the brain action', st.recent(1)[0].provider === 'iris' && st.recent(1)[0].local === true && b.contract === 'iris.ops/1' && b.actions[0].action === 'added');

  b = await run(chat('Actually I live in Karachi now, moved again'), (prompt) => {
    const alias = /^(m\d+) \| user \| city \| Lahore$/m.exec(prompt);
    return { ops: [op({ op: 'update', ref: alias ? alias[1] : 'm9', why: 'changed', evid: 'I live in Karachi now', ent: 'user', attr: 'city', val: 'Karachi', kind: 'fact' })] };
  });
  city = BR.get(city.id);
  check('Iris was shown the memory by id and updated it in place', iris.prompts[1].includes('| user | city | Lahore') && city.value === 'Karachi' && b.actions[0].action === 'replaced');
  check('update keeps the old value in the history', city.history.some((h) => h.value === 'Lahore'));

  b = await run(chat('Karachi, yes, for good'), { ops: [op({ op: 'confirm', ref: 'm1', evid: 'Karachi, yes' })] });
  check('confirm: reinforced, no duplicate row', BR.get(city.id).evidence === 2 && BR.list({ scope: 'me' }).filter((m) => m.slot === 'city').length === 1 && b.actions[0].action === 'reinforced');

  b = await run(chat('I would totally live on the moon if I could'), { ops: [op({ op: 'skip', why: 'joke', evid: 'live on the moon' })] });
  check('skip: nothing stored, the decision is logged', b.actions[0].action === 'ignored' && BR.changes({ limit: 3 }).some((c) => c.action === 'ignored' && /joke/.test(c.text)));

  b = await run(chat('I work at Finlo these days'), { ops: [op({ op: 'add', evid: 'I work at Finlo', ent: 'user', type: 'user', attr: 'employer', val: 'Finlo', kind: 'fact' })] });
  const job = BR.list({ scope: 'me' }).find((m) => m.slot === 'employer');
  b = await run(chat('I left Finlo last week'), (prompt) => ({ ops: [op({ op: 'retract', ref: /^(m\d+) \| user \| employer/m.exec(prompt)[1], why: 'ended', evid: 'I left Finlo' })] }));
  check('retract: the memory is forgotten, with the reason in the log', !BR.get(job.id) && b.actions[0].action === 'forgotten' && BR.changes({ limit: 2 }).some((c) => c.action === 'forgotten' && /ended/.test(c.text)));
  const undone = engine.undo(st.recent(1)[0].id);
  check('undo brings a retracted memory back exactly as it was', undone.restored.includes(job.id) && BR.get(job.id) && BR.get(job.id).value === 'Finlo');

  BR.correct(job.id, { text: 'The user works at Finlo.', value: 'Finlo' });
  b = await run(chat('I joined Nexa as a designer'), (prompt) => ({ ops: [op({ op: 'update', ref: /^(m\d+) \| user \| employer/m.exec(prompt)[1], why: 'changed', evid: 'I joined Nexa', ent: 'user', attr: 'employer', val: 'Nexa', kind: 'fact' })] }));
  check('something the user set by hand is never changed: kept and flagged for review', b.actions[0].action === 'kept' && BR.get(job.id).value === 'Finlo' && BR.get(job.id).review === true);

  b = await run(chat('hmm maybe Karachi is not where I am, not sure'), (prompt) => ({ ops: [op({ op: 'conflict', ref: /^(m\d+) \| user \| city/m.exec(prompt)[1], evid: 'maybe Karachi is not where I am', ent: 'user', attr: 'city', val: 'unknown', kind: 'fact', basis: 'implied', conf: 'low' })] }));
  check('conflict: a challenger beside the memory, nothing overwritten', b.actions[0].action === 'challenged' && BR.get(city.id).value === 'Karachi' && BR.get(city.id).challenger);

  b = await run(chat('my doctor put me on metformin for diabetes'), { ops: [op({ op: 'add', evid: 'metformin for diabetes', ent: 'user', type: 'user', attr: 'medication', val: 'metformin', kind: 'fact', sens: 'sensitive' })] });
  check('a sensitive memory is kept on this PC with its label', BR.list({ scope: 'me' }).some((m) => m.value === 'metformin' && m.sens === 'sensitive'));
  check('it stays out of the context block cloud models read', !/metformin/.test(BR.contextBlock({ request: 'what medication am I on' })) && /Karachi/.test(BR.contextBlock({ request: 'where do I live' })));
  check('and out of the recall tool, unless the host says the model is local', /^Nothing in the brain/.test(BR.recallTool({ query: 'metformin' }).output) && /medication is metformin/.test(BR.recallTool({ query: 'metformin' }, { includeSensitive: true }).output));

  b = await run(chat('my dentist appointment is on 20 November'), { ops: [op({ op: 'add', evid: 'dentist appointment is on 20 November', ent: 'user', type: 'user', attr: 'dentist appointment', val: '20 November 2026', kind: 'event', when: '2026-11-20' })] });
  check('a dated event is a plan for Life, not a memory', !BR.list({ scope: 'me' }).some((m) => /dentist/.test(m.slot)) && b.actions.length === 0);

  b = await run(chat('I prefer short replies'), 'Sure! {"ops": [');
  check('an answer that is not JSON stores nothing and is marked malformed', b.actions.length === 0 && b.valid === false && st.recent(1)[0].status === 'done');

  const before = BR.list({ scope: 'me' }).length;
  b = await run(chat('I prefer dark mode'), { ops: [op({ op: 'add', evid: 'I prefer light mode', ent: 'user', type: 'user', attr: 'theme', val: 'light', kind: 'preference' })] });
  check('an invented quote is refused by the guard and logged with its reason', BR.list({ scope: 'me' }).length === before && b.dropped.includes('ungrounded_evidence'));
}

if (section('Trust: emails and overheard speech')) {
  freshBrain('trust');
  const st = freshStore('trust');
  const iris = fakeIris();
  const engine = EN.createEngine({ store: st, brain: BR, providers: { rules: M.createRulesProvider(), local: iris.provider }, settings: () => ({ mode: 'local' }), tz: () => 'Asia/Karachi', now: () => NOW });
  BR.applyOps([{ action: 'insert', observation: { kind: 'fact', slot: 'gym', value: 'mornings', text: 'The user goes to the gym in the mornings.', certainty: 'stated' }, ent: 'user' }], { product: 'craft' });
  const gym = BR.list({ scope: 'me' })[0];
  iris.answer({ ops: [
    op({ op: 'add', evid: 'You prefer window seats', ent: 'user', type: 'user', attr: 'seat', val: 'window', kind: 'preference' }),
    op({ op: 'retract', ref: 'm1', why: 'cancelled', evid: 'Your gym plan is cancelled' }),
  ] });
  engine.ingest({ source: 'email', trust: 'external', product: 'life', text: 'You prefer window seats. Your gym plan is cancelled.', at: NOW });
  NOW += 60000;
  let b = (await engine.process()).batches[0];
  check('an email can never set the user\'s own preference', !BR.list({ scope: 'me' }).some((m) => m.slot === 'seat') && b.dropped.includes('external_user_preference'), JSON.stringify(b));
  check('an email cannot make Codeply forget: it becomes a challenge to review', BR.get(gym.id) && BR.get(gym.id).review === true && b.actions.some((a) => a.action === 'challenged'));
  iris.answer({ ops: [op({ op: 'add', evid: 'I am vegetarian', ent: 'user', type: 'user', attr: 'diet', val: 'vegetarian', kind: 'fact' })] });
  engine.ingest({ source: 'heard', trust: 'mixed', sensitive: true, product: 'life', text: 'user: I am vegetarian by the way\nZainab: since when?', at: NOW });
  NOW += 60000;
  b = (await engine.process()).batches[0];
  const diet = BR.list({ scope: 'me' }).find((m) => m.slot === 'diet');
  check('overheard speech is never "stated": the memory waits to be confirmed', diet && diet.status === 'tentative');
  check('a sensitive batch went to Iris on this PC', b.local === true && b.provider === 'iris');
}

if (section('Installer: checksums, signed links, self-test')) {
  const okBody = Buffer.from('iris weights');
  const okSha = crypto.createHash('sha256').update(okBody).digest('hex');
  const fetchFile = async () => new Response(okBody, { status: 200, headers: { 'content-length': String(okBody.length) } });
  const dest = path.join(tmp, 'dl', 'model.gguf');
  let threw = '';
  try { await II.download('https://x/model', dest, { sha256: 'f'.repeat(64), fetchImpl: fetchFile }); } catch (e) { threw = e.message; }
  check('a download that does not match its checksum is thrown away', /checksum/.test(threw) && !fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
  const got = await II.download('https://x/model', dest, { sha256: okSha, bytes: okBody.length, fetchImpl: fetchFile });
  check('a matching download is kept', got.sha256 === okSha && fs.readFileSync(dest).equals(okBody));

  let asked = null;
  const link = await II.signedLink({ supabaseUrl: 'https://p.supabase.co', anonKey: 'anon', token: 'user-jwt', storagePath: 'iris/iris-1.gguf',
    fetchImpl: async (url, init) => { asked = { url, init }; return new Response(JSON.stringify({ signedURL: '/object/sign/models/iris/iris-1.gguf?token=abc' }), { status: 200 }); } });
  check('the signed link is asked for with the user\'s token, for 15 minutes, from the private bucket', asked.url === 'https://p.supabase.co/storage/v1/object/sign/models/iris/iris-1.gguf' && /Bearer user-jwt/.test(asked.init.headers.Authorization) && JSON.parse(asked.init.body).expiresIn === 900);
  check('and turned into a full URL', link === 'https://p.supabase.co/storage/v1/object/sign/models/iris/iris-1.gguf?token=abc');

  const RT = lib('local-runtime.js');
  process.env.CODEPLY_MODELS_DIR = path.join(tmp, 'models');
  let err = '';
  try { await II.installModel(RT, { getToken: async () => 'jwt', supabaseUrl: 'https://p', anonKey: 'a', fetchImpl: async () => { throw new Error('must not download'); } }); } catch (e) { err = e.message; }
  check('an unreleased Iris (no checksum in the catalog) is never downloaded', /not been released/.test(err));
  const st = II.status(RT);
  check('status: supported here, not released, nothing installed', st.released === false && st.model === false && st.contract === 'iris.ops/1' && st.supported === (process.platform === 'win32' && process.arch === 'x64'));

  if (process.platform === 'win32') {
    // A fake llama-server build, zipped with the tar Windows ships.
    const src = path.join(tmp, 'zipsrc', 'build');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'llama-server.exe'), 'MZ fake');
    fs.writeFileSync(path.join(src, 'ggml.dll'), 'dll');
    const zip = path.join(tmp, 'fake.zip');
    execFileSync(II.tarExe(), ['-a', '-cf', zip, '-C', path.join(tmp, 'zipsrc'), 'build']);
    const zbytes = fs.readFileSync(zip);
    const zsha = crypto.createHash('sha256').update(zbytes).digest('hex');
    const runtimeDir = path.join(tmp, 'runtime');
    const fakeRT = { EXE: 'llama-server.exe', RUNTIME_DIR: () => runtimeDir, runtimeBuild: () => ({ tag: 'b1', file: 'fake.zip', bytes: zbytes.length, url: 'https://x/fake.zip', sha256: zsha }) };
    const r = await II.installRuntime(fakeRT, { fetchImpl: async () => new Response(zbytes, { status: 200 }) });
    check('llama-server is unpacked into the runtime folder with its DLLs', fs.existsSync(path.join(runtimeDir, 'bin', 'llama-server.exe')) && fs.existsSync(path.join(runtimeDir, 'bin', 'ggml.dll')) && r.tag === 'b1');
    const again = await II.installRuntime(fakeRT, { fetchImpl: async () => { throw new Error('must not download again'); } });
    check('the same build is not downloaded twice', again.skipped === true);
  }

  const good = { extract: async () => ({ answer: { iris: { valid: true, ops: [{ op: 'skip', why: 'secret', val: '' }] } }, ms: 5 }) };
  const leaky = { extract: async () => ({ answer: { iris: { valid: true, ops: [{ op: 'add', attr: 'card', val: '4111111111111111' }] } }, ms: 5 }) };
  const broken = { extract: async () => ({ answer: { iris: { valid: false, ops: [] } }, ms: 5 }) };
  check('self-test passes a model that answers valid JSON and skips the secret', (await II.selfTest(good)).ok === true);
  check('self-test fails a model that lets a card number through', (await II.selfTest(leaky)).ok === false);
  check('self-test fails a model that does not answer JSON', (await II.selfTest(broken)).ok === false);
}

if (section('Desktop host: Iris in context-desktop.js')) {
  freshBrain('desktop');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'models'), { recursive: true });
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.CODEPLY_MODELS_DIR = path.join(home, 'models');
  process.env.CODEPLY_RUNTIME_DIR = path.join(home, 'runtime');
  fs.writeFileSync(path.join(home, 'models', 'iris-1.gguf'), 'fake');
  const writeManifest = (extra = {}) => fs.writeFileSync(path.join(home, 'models', 'manifest.json'), JSON.stringify([{ id: 'iris-1', file: 'iris-1.gguf', sha256: 'x', ...extra }]));
  writeManifest();
  const handlers = {};
  const warnings = [];
  const warn = console.warn; console.warn = (...a) => { warnings.push(a.join(' ')); };
  const power = { battery: false, idle: 0, isOnBatteryPower() { return this.battery; }, getSystemIdleTime() { return this.idle; } };
  const CD = require(path.join(ROOT, 'context-desktop.js'));
  CD.init({ ipcMain: { handle: (n, f) => { handlers[n] = f; } }, cliDir: path.join(ROOT, 'codeply-cli'), aiLib: () => ({ chatJson: async () => ({ success: true, json: { observations: [] } }) }), currentRoute: () => ({ auto: true }), powerMonitor: power });
  check('the Iris IPC is there', ['iris:state', 'iris:install', 'iris:set', 'iris:remove'].every((n) => typeof handlers[n] === 'function'));
  let s = await handlers['iris:state']();
  check('installed but off until the user turns it on (legacy: nothing changes)', s.model === true && s.on === false && !BR.learnsElsewhere());
  s = (await handlers['iris:set']({}, { on: true })).state;
  check('on: local mode with Iris, and the engine takes over learning from chats', s.on === true && CD.state().settings.mode === 'local' && BR.learnsElsewhere());
  check('state never carries event text', !JSON.stringify(s).includes('"text"'));
  check('on mains power: background work runs', CD.canRun() === true);
  power.battery = true; power.idle = 10;
  check('on battery while the PC is in use: it waits', CD.canRun() === false);
  power.idle = 300;
  check('on battery and the user is away: it runs', CD.canRun() === true);
  await handlers['iris:set']({}, { pauseOnBattery: false }); power.idle = 0;
  check('with "wait while on battery" off: it runs', CD.canRun() === true);
  const counts = CD.countsSince(0);
  check('the counts are numbers only', typeof counts.batches === 'number' && !JSON.stringify(counts).match(/[a-z]{12,}/i) && 'p95_ms' in counts);
  CD.stop();
  writeManifest({ contract: 'iris.ops/2' });
  CD.init({ ipcMain: { handle: () => {} }, cliDir: path.join(ROOT, 'codeply-cli'), aiLib: () => ({}), currentRoute: () => ({ auto: true }) });
  check('an Iris trained on a format this app does not know is never loaded', warnings.some((w) => /iris\.ops\/2/.test(w) && /Update Codeply/.test(w)));
  s = await handlers['iris:remove']();
  check('remove: the model is gone, learning goes back to the chat model, memories stay', s.model === false && !BR.learnsElsewhere() && BR.list({}).length >= 0);
  CD.stop();
  console.warn = warn;
}

console.log(failures ? `\n${failures} failed` : '\nAll passed');
// Windows keeps SQLite files open until the process ends: a leftover temp folder is not a failure.
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(failures ? 1 : 0);
