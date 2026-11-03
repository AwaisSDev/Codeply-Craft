// The memory model integration (release/memory-model/TIERS.md): confidences from token log-probabilities,
// carried by the guard next to (never inside) the model's answer, storage tiers in the engine, and pending
// memories in the brain (tentative, expiring unless seen again or confirmed). No network, no real model.
//   node scripts/memory-model-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-memory-model-'));
process.env.CODEPLY_TELEMETRY = '0';
const lib = (n) => require(path.join(ROOT, 'codeply-cli/lib', n));
const BR = lib('brain.js'); const S = lib('context-schema.js'); const M = lib('context-model.js');
const T = lib('context-tiers.js'); const EV = lib('context-events.js'); const EN = lib('context-engine.js'); const RT = lib('local-runtime.js');

let failures = 0;
function check(name, cond, extra = '') { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !extra ? '' : ` -- ${extra}`}`); if (!cond) failures++; }
const DAY = 86400000;
let NOW = Date.UTC(2026, 10, 3, 9, 0, 0);
const freshBrain = (name) => BR.configure({ file: path.join(tmp, `${name}-brain.db`), now: () => NOW });
const chat = (text) => ({ source: 'chat', trust: 'user', product: 'craft', text: `User: ${text}\nAssistant: Okay.`, at: NOW });
const obsJson = (list) => JSON.stringify({ observations: list, plans: [] });
const O = (slot, value, text, extra = {}) => ({ kind: 'fact', slot, value, text, certainty: 'stated', importance: 0.7, about: 'user', ...extra });
// Token stream for an answer: one token per character, log-probability chosen per observation.
function tokensFor(answer, lpOf) {
  const spans = T.observationSpans(answer);
  return [...answer].map((ch, i) => { const k = spans.findIndex(([a, b]) => i >= a && i < b); return { token: ch, logprob: k >= 0 ? lpOf(k, i - spans[k][0]) : -0.01 }; });
}

console.log('\nConfidences from token log-probabilities');
{
  const ans = obsJson([O('city', 'Karachi', 'The user lives in Karachi.'), O('job', 'nurse', 'The user is a "nurse" {night}.')]);
  const conf = T.confidences(ans, tokensFor(ans, (k, j) => (k === 0 ? Math.log(0.9) : j === 0 ? Math.log(0.3) : Math.log(0.95))));
  check('one confidence per observation, braces and quotes inside strings handled', conf && conf.length === 2, JSON.stringify(conf));
  check('exist is the probability of the opening token', Math.abs(conf[0].exist - 0.9) < 1e-3 && Math.abs(conf[1].exist - 0.3) < 1e-3, JSON.stringify(conf));
  check('mean and min are within [0, 1] and ordered', conf.every((c) => c.min <= c.mean && c.mean <= 1 && c.min > 0));
  check('tokens that do not reassemble the answer give no confidences', T.confidences(ans, tokensFor(ans, () => -0.1).slice(1)) === null);
  check('no logprobs: no confidences', T.confidences(ans, []) === null && T.confidences(ans, null) === null);
}

console.log('\nTiers');
{
  const cfg = { feature: 'exist', tauA: 0.8, tauP: 0.4 };
  check('invalid configs turn tiers off', T.tiersConfig(null) === null && T.tiersConfig({ feature: 'x', tauA: 0.5, tauP: 0.1 }) === null && T.tiersConfig({ feature: 'mean', tauA: 0.3, tauP: 0.6 }) === null);
  check('no config or no confidence: automatic (as before tiers)', T.tierFor({}, null) === 'automatic' && T.tierFor({ certainty: 'stated' }, cfg) === 'automatic');
  check('thresholds: automatic / pending / discard', T.tierFor({ confidence: { exist: 0.9 } }, cfg) === 'automatic' && T.tierFor({ confidence: { exist: 0.5 } }, cfg) === 'pending' && T.tierFor({ confidence: { exist: 0.1 } }, cfg) === 'discard');
  const { keep, discarded } = T.applyTiers([{ certainty: 'stated', confidence: { exist: 0.5 } }, { certainty: 'stated', confidence: { exist: 0.95 } }, { certainty: 'stated', confidence: { exist: 0.05 } }], cfg);
  check('pending loses "stated" and is marked pending; discarded are separate', keep.length === 2 && keep[0].pending === true && keep[0].certainty === 'implied' && keep[1].certainty === 'stated' && !keep[1].pending && discarded.length === 1);
}

console.log('\nThe guard carries confidences next to the answer, never from it');
{
  const events = [{ ...S.normalizeEvent(chat('I moved to Karachi last year and I work as a nurse.'), NOW).event }];
  const ans = obsJson([O('city', 'Karachi', 'The user lives in Karachi.', { confidence: { exist: 1 } }), O('city', 'Tokyo', 'The user lives in Tokyo.'), O('job', 'nurse', 'The user is a nurse.')]);
  const g = S.checkExtraction(ans, { events, confidences: [{ exist: 0.9, mean: 0.8, min: 0.5 }, { exist: 0.2, mean: 0.2, min: 0.2 }, { exist: 0.6, mean: 0.7, min: 0.4 }] });
  check('kept observations get the confidence of their own position (the dropped one in between does not shift it)', g.observations.length === 2 && g.observations[0].confidence.exist === 0.9 && g.observations[1].confidence.exist === 0.6, JSON.stringify(g.observations));
  const spoof = S.checkExtraction(ans, { events });
  check('a "confidence" written inside the answer is ignored', spoof.observations.every((o) => !o.confidence), JSON.stringify(spoof.observations));
  const misaligned = S.checkExtraction(ans, { events, confidences: [{ exist: 0.9 }] });
  check('confidences that do not line up with the answer are not used', misaligned.observations.every((o) => !o.confidence));
}

console.log('\nThe local backend asks for log-probabilities only when told to');
{
  const answer = obsJson([O('city', 'Karachi', 'The user lives in Karachi.')]);
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body); seen.push(b);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: 'fake', choices: [{ message: { content: answer }, ...(b.logprobs ? { logprobs: { content: tokensFor(answer, () => Math.log(0.7)) } } : {}) }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const input = { events: [S.normalizeEvent(chat('I moved to Karachi last year.'), NOW).event], known: [], now: NOW };
  const plain = await M.runExtraction(M.createLocalProvider({ baseUrl, model: 'm' }), input);
  const withConf = await M.runExtraction(M.createLocalProvider({ baseUrl, model: 'm', confidence: true }), input);
  server.close();
  check('without the option: no logprobs requested, no confidence', !seen[0].logprobs && plain.observations.length === 1 && !plain.observations[0].confidence);
  check('with the option: logprobs requested, confidence attached, same observation', seen[1].logprobs === true && withConf.observations.length === 1 && Math.abs(withConf.observations[0].confidence.exist - 0.7) < 1e-3 && withConf.observations[0].value === plain.observations[0].value, JSON.stringify(withConf.observations));
}

console.log('\nPending memories in the brain');
{
  freshBrain('pending');
  const r = BR.observe({ ...O('city', 'Karachi', 'The user lives in Karachi.'), pending: true }, { product: 'craft' });
  check('a pending observation is stored tentative with a 30-day expiry, even if "stated"', r.action === 'added' && r.memory.status === 'tentative' && r.memory.expiresAt === NOW + 30 * DAY, JSON.stringify(r.memory));
  NOW += 2 * DAY;
  const again = BR.observe({ ...O('city', 'Karachi', 'The user lives in Karachi.'), certainty: 'implied' }, { product: 'craft' });
  check('seen again: confirmed, expiry cleared', again.action === 'reinforced' && again.memory.status === 'confirmed' && again.memory.expiresAt === null, JSON.stringify(again.memory));
  const p2 = BR.observe({ ...O('pet', 'a cat named Biscuit', 'The user has a cat named Biscuit.'), pending: true }, { product: 'craft' });
  const conf = BR.confirm(p2.memory.id);
  check('confirmed by the user: confirmed, locked, expiry cleared', conf.status === 'confirmed' && conf.locked && conf.expiresAt === null);
  const p3 = BR.observe({ ...O('hobby', 'pottery', 'The user does pottery.'), pending: true }, { product: 'craft' });
  check('an unconfirmed pending memory is listed while it lasts', BR.list({}).some((m) => m.id === p3.memory.id));
  NOW += 31 * DAY;
  check('after 30 days without confirmation it is gone from the list', !BR.list({}).some((m) => m.id === p3.memory.id));
  NOW += 2 * DAY; // prune keeps an expired memory for one more day
  BR.prune();
  check('and prune deletes it; confirmed memories stay', !BR.get(p3.memory.id) && !!BR.get(again.memory.id) && !!BR.get(conf.id));
  const normal = BR.observe(O('lang', 'Spanish', 'The user speaks Spanish.'), { product: 'craft' });
  check('without pending nothing changes: stated is confirmed, no expiry', normal.memory.status === 'confirmed' && normal.memory.expiresAt === null);
  BR.close();
}

console.log('\nEngine: tiers end to end into a real brain');
{
  freshBrain('engine-tiers');
  const st = EV.openEventStore({ file: path.join(tmp, 'engine-tiers-context.db'), now: () => NOW });
  const ans = obsJson([O('city', 'Karachi', 'The user lives in Karachi.'), O('job', 'nurse', 'The user is a nurse.'), O('pet', 'Biscuit', 'The user has a cat named Biscuit.')]);
  const local = { info: () => ({ id: 'local', kind: 'local', local: true, model: 'memory-v1', style: 'full' }), available: async () => true,
    extract: async () => ({ answer: ans, model: 'memory-v1', ms: 5, usage: {}, confidences: [{ exist: 0.95, mean: 0.9, min: 0.8 }, { exist: 0.55, mean: 0.8, min: 0.5 }, { exist: 0.1, mean: 0.5, min: 0.1 }] }) };
  let tiers = { feature: 'exist', tauA: 0.8, tauP: 0.4 };
  const engine = EN.createEngine({ store: st, brain: BR, providers: { rules: M.createRulesProvider(), local }, settings: () => ({ mode: 'local', tiers }), tz: () => 'Asia/Karachi', now: () => NOW });
  engine.ingest(chat('I moved to Karachi last year, I work as a nurse and I have a cat named Biscuit.'));
  await engine.process();
  const mems = BR.list({});
  const by = (re) => mems.find((m) => re.test(m.text));
  check('automatic tier: confirmed', by(/Karachi/) && by(/Karachi/).status === 'confirmed' && by(/Karachi/).expiresAt === null);
  check('pending tier: tentative with an expiry', by(/nurse/) && by(/nurse/).status === 'tentative' && by(/nurse/).expiresAt > NOW);
  check('discard tier: not stored', !by(/Biscuit/));
  const out = st.recent(1)[0].outcome;
  check('the batch outcome records the tiers', out.tiers && out.tiers.pending === 1 && out.tiers.discarded === 1 && out.dropped.includes('low confidence') && out.actions.some((a) => a.tier === 'pending'), JSON.stringify(out));
  // Tiers off: everything the guard keeps is stored as before.
  freshBrain('engine-no-tiers'); tiers = null;
  engine.ingest(chat('Again: Karachi, nurse, cat named Biscuit.'));
  await engine.process();
  check('tiers off: every kept observation is stored, stated is confirmed', BR.list({}).length === 3 && BR.list({}).every((m) => m.status === 'confirmed'));
  st.close(); BR.close();
}

console.log('\nCatalog');
{
  const c = RT.CATALOG['lfm3-1.7b-memory-v1-q4'];
  check('the memory model reads the full prompt it was trained on, with thinking off and --swa-full', c && c.style === 'full' && c.extra.chat_template_kwargs.enable_thinking === false && c.serverArgs.includes('--swa-full'));
  check('it has no download repository until it is published', c.repo === '');
  check('it is opt-in: only used when selected', c.optIn === true);
  const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'release/memory-model/results/TIERS-FROZEN.json'), 'utf8')).s1;
  check('its tiers are the frozen 5:1 configuration (owner decision for opt-in testing)', c.tiers && c.tiers.feature === frozen.feature && c.tiers.tauA === frozen.byRatio['r=5'].tauA && c.tiers.tauP === frozen.byRatio['r=5'].tauP && T.tiersConfig(c.tiers) !== null, JSON.stringify(c.tiers));
  const inst = [{ id: 'lfm3-1.7b-memory-v1-q4', optIn: true }, { id: 'lfm3-1.7b-qad-q4' }];
  check('an installed opt-in model is not the fallback', RT.selectModel(inst, '').id === 'lfm3-1.7b-qad-q4');
  check('a selected opt-in model is used', RT.selectModel(inst, 'lfm3-1.7b-memory-v1-q4').id === 'lfm3-1.7b-memory-v1-q4');
  check('only an opt-in model installed: nothing runs until it is selected', RT.selectModel([inst[0]], '') === null);
}

// Installing from a file: the catalog checksum is enforced (a wrong file is refused and not linked).
{
  const { spawnSync } = await import('child_process');
  const dir = path.join(tmp, 'models'); const bogus = path.join(tmp, 'not-the-model.gguf');
  fs.writeFileSync(bogus, 'not the release candidate');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/context/fetch-model.mjs'), 'lfm3-1.7b-memory-v1-q4', '--from', bogus], { env: { ...process.env, CODEPLY_MODELS_DIR: dir }, encoding: 'utf8' });
  const linked = fs.existsSync(path.join(dir, RT.CATALOG['lfm3-1.7b-memory-v1-q4'].file));
  const manifest = fs.existsSync(path.join(dir, 'manifest.json')) ? fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8') : '';
  check('fetch-model refuses a file whose SHA-256 is not the catalog\'s', r.status === 1 && /not the catalog/.test(r.stderr) && !linked && !manifest.includes('memory-v1'), r.stderr);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exitCode = failures ? 1 : 0;
