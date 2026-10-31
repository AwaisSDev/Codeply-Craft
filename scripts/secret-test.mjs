// Secrets never reach, stay in, or come back out of the brain (SECURITY-SECRETS.md).
//
//   node scripts/secret-test.mjs [section]
//
// - detection: API keys in known and unknown formats, bearer tokens, private keys,
//   PINs, door / locker / gate / keypad codes, OTPs, backup codes, cards, CVVs,
//   passwords in prose, Roman Urdu; each is removed from the input, refused by the
//   guard with no help from the source, and refused by brain.observe()
// - negative controls that must be kept: prices, times, dates, ages, rooms, years,
//   versions, scores, phone numbers, issue numbers, model names
// - Benchmark-520's secret examples (b-cv-060..069, b-ur-075) end to end: the
//   answers real backends gave (LFM3 and the DtW encoders; 24 leaks between them
//   before this fix) and adversarial answers that put each secret in every field,
//   through redaction, the guard, brain.observe, contextBlock and recall, and the
//   brain's file on disk
// - a brain written before the fix: every read skips its secrets, sweepSecrets()
//   reports them without the values and removes them from the file
// - the engine with a backend that "cheats" (writes back the unredacted secret)
// No network and no model: every store is a temp file.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-secrets-'));
process.env.CODEPLY_BOTS_DIR = path.join(tmp, 'bots');
process.env.CODEPLY_TELEMETRY = '0';

const lib = (n) => require(path.join(ROOT, 'codeply-cli/lib', n));
const BR = lib('brain.js');
const S = lib('context-schema.js');
const R = lib('context-redact.js');
const M = lib('context-model.js');
const EV = lib('context-events.js');
const EN = lib('context-engine.js');
const X = lib('secret-scan.js');
const { loadDriver } = lib('session-db.js');
const BENCH = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/secret-bench.json'), 'utf8')).examples;

let failures = 0; let checks = 0;
const only = process.argv[2] || '';
function check(name, cond, extra = '') {
  checks++;
  if (cond) { if (!process.env.QUIET) console.log(`  ok    ${name}`); } else { failures++; console.log(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 900)}` : ''}`); }
}
const section = (name) => { console.log(`\n${name}`); return !only || name.toLowerCase().includes(only.toLowerCase()); };

let NOW = Date.UTC(2026, 10, 1, 9, 0, 0);
let brainFile = '';
const freshBrain = (name) => { brainFile = path.join(tmp, `${name}-brain.db`); BR.configure({ file: brainFile, now: () => NOW }); };
const chat = (text, o = {}) => ({ source: 'chat', trust: 'user', product: 'craft', text: `User: ${text}\nAssistant: Okay.`, at: NOW, ...o });
const eventsFor = (texts) => texts.map((t) => S.normalizeEvent(typeof t === 'string' ? chat(t) : t, NOW).event);

/** Variants of a secret a model might write: as is, upper case, digits without separators, spaced. */
function variants(s) {
  const v = new Set([s, s.toUpperCase(), s.toLowerCase()]);
  const d = s.replace(/[\s-]/g, '');
  if (/^\d{6,}$/.test(d)) { v.add(d); v.add(d.replace(/(\d{4})(?=\d)/g, '$1 ')); }
  return [...v];
}
/** Is a secret anywhere in this text (any variant; digits also with separators removed)? */
function holds(text, secret) {
  const t = String(text).toLowerCase();
  if (variants(secret).some((v) => t.includes(v.toLowerCase()))) return true;
  const d = secret.replace(/[\s-]/g, '');
  return /^\d{6,}$/.test(d) && t.replace(/(?<=\d)[\s-](?=\d)/g, '').includes(d);
}
/** The brain's files as bytes (main file and write-ahead log), as text. */
function brainBytes(file = brainFile) {
  return ['', '-wal', '-shm'].map((x) => { try { return fs.readFileSync(file + x).toString('latin1'); } catch { return ''; } }).join('\n');
}
/** Everything the brain stores or hands out. */
function brainDump(request = '') {
  return JSON.stringify([
    BR.list({ includeSecrets: true, includeExpired: true, limit: 1000 }), BR.changes({ limit: 500 }),
    BR.contextBlock({ request, learnsByItself: true }), BR.contextBlock({ request }), BR.recallTool({ query: '' }).output,
  ]);
}

// ─── Detection ──────────────────────────────────────────────────────────────

// [label, text the user typed, the secret in it]
const POSITIVE = [
  ['OpenAI key (sk-)', 'use this key sk-proj-AbC123dEf456GhI789jKl012 for the bot', 'sk-proj-AbC123dEf456GhI789jKl012'],
  ['GitHub token (ghp_)', 'the CI token is ghp_8KfR2mQx7LpZ0vN4cW9sT1yB6hJ3dE5aG0uI', 'ghp_8KfR2mQx7LpZ0vN4cW9sT1yB6hJ3dE5aG0uI'],
  ['AWS access key (AKIA)', 'aws access key AKIAIOSFODNN7EXAMPLE for staging', 'AKIAIOSFODNN7EXAMPLE'],
  ['unfamiliar prefixed key (owm-)', 'here\'s the openweather key owm-Kt9F3cQe7Xb24dRw46ZpLm wire it into the widget', 'owm-Kt9F3cQe7Xb24dRw46ZpLm'],
  ['unfamiliar prefixed key (generic)', 'mapbox wants zx-9fK2mQ7pL4vB8nR3tY6w in the header', 'zx-9fK2mQ7pL4vB8nR3tY6w'],
  ['random key with no prefix', 'the webhook signing value is Q7mZ2xK9pL4vR8nB3tW6yH1c', 'Q7mZ2xK9pL4vR8nB3tW6yH1c'],
  ['bearer token', 'curl -H "Authorization: Bearer abcDEF123ghiJKL456mnoPQR789" https://api.example.com', 'abcDEF123ghiJKL456mnoPQR789'],
  ['private key', 'my deploy key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'],
  ['URL with a password', 'clone from https://nadia:Hunter2pass@git.example.com/repo.git', 'Hunter2pass'],
  ['PIN', 'my ATM pin is 4821, remind me to get cash', '4821'],
  ['PIN, no "is"', 'pin 9930 for the bike lock', '9930'],
  ['locker code', 'note: locker code 2207. it\'s at the Al Qusais gym', '2207'],
  ['door code with #', 'the cleaner comes thursday at 10, door code is 58#14.', '58#14'],
  ['gate code', 'gate code for Ali\'s building: 4471', '4471'],
  ['keypad code *1234#', 'to disarm the alarm press *1234# twice', '*1234#'],
  ['OTP', 'my OTP is 552190', '552190'],
  ['OTP in Roman Urdu word order', '482913 ye OTP aya hai daraz se', '482913'],
  ['backup codes', 'backup codes for the uni portal: 7731-0042 and 5519-8820, keep them safe', '7731-0042'],
  ['second backup code', 'backup codes for the uni portal: 7731-0042 and 5519-8820, keep them safe', '5519-8820'],
  ['backup code with spaces', 'recovery codes 4402 1187 and 9921 3360', '4402 1187'],
  ['alphanumeric recovery code', 'recovery code ab12-cd34-ef56', 'ab12-cd34-ef56'],
  ['card number', 'use my visa 4539 1488 0343 6467 for the registration', '4539 1488 0343 6467'],
  ['card expiry', 'use my visa 4539 1488 0343 6467 exp 09/28 for the registration', '09/28'],
  ['CVV', 'cvv 381 on the back', '381'],
  ['password in prose', 'my password is sunflower22 for the router', 'sunflower22'],
  ['password with symbols', 'wifi password at the new place is Kh@1ber_2026! , save it somewhere', 'Kh@1ber_2026'],
  ['login in prose', 'netflix login, it\'s usman.fam@mailbox.example / TigerNoodle99. send it to him', 'TigerNoodle99'],
  ['Roman Urdu PIN', 'mera pin 4432 hai', '4432'],
  ['Roman Urdu password', 'mera HBL app ka password Sameer@786 hai, kahin likh lo', 'Sameer@786'],
  ['Roman Urdu root password', 'server ka root password Karachi#2291 hai, isko .env mein daal do', 'Karachi#2291'],
  ['Roman Urdu door code', 'ghar ka code 7781 hai, Ali ko bata dena', '7781'],
  ['account number', 'my account number is 00112233445566 at Meezan', '00112233445566'],
  // Found by an independent red-team pass (SECURITY-SECRETS.md)
  ['lock combination shaped like a score', 'my locker combination is 12-34-56', '12-34-56'],
  ['bike lock combo shaped like a date', 'bike lock combo 04/27', '04/27'],
  ['SSN', 'my SSN is 123-45-6789', '123-45-6789'],
  ['CNIC', 'CNIC 35202-1234567-1 for the form', '35202-1234567-1'],
  ['wifi pw', 'office wifi pw falcon2024', 'falcon2024'],
  ['Roman Urdu wifi pass', 'wifi ka pass ali12345 hai', 'ali12345'],
  ['wifi pass, plain word', 'wifi is ZongHome and the pass is bluemangoes', 'bluemangoes'],
  ['code to the gate', 'the code to the gate is 4471', '4471'],
  ['garage opens with', 'the garage opens with 2207', '2207'],
  ['Roman Urdu door opens', 'darwaza 5814 se khulta hai', '5814'],
  ['bike lock', 'my bike lock is 0427', '0427'],
  ['alarm disarm', 'alarm disarm 1984', '1984'],
  ['voicemail', 'voicemail is 4821', '4821'],
  ['phone unlock', 'my phone unlock is 482913', '482913'],
  ['locker key number', 'locker ki chabi number 2207 hai', '2207', 'locker chabi'],
  ['code in single digits', 'locker code is 2 2 0 7', '2 2 0 7', 'locker code'],
  ['keypad code with spaces', 'door code is 58 # 14', '58 # 14'],
  ['code with dots', 'gate code 4.4.7.1', '4.4.7.1', 'gate code'],
  ['PIN in Urdu number words', 'mera pin char aath do ek hai', 'char aath do ek'],
  ['seed phrase', 'my seed phrase is abandon ability able about above absent absorb abstract absurd abuse access accident', 'abandon ability'],
  ['security answer', 'security answer for HBL is Qureshi', 'Qureshi'],
  ['env line', 'add DB_PASS=hunter22 to staging', 'hunter22', 'DB_PASS'],
  ['env secret', 'STRIPE_SECRET=abc123xyz in the env', 'abc123xyz'],
  ['mysql -p', 'run mysql -u root -phunter22 on the box', 'hunter22', 'mysql root password'],
  ['wifi QR text', 'WIFI:S:ZongHome;T:WPA;P:falcon2024;;', 'falcon2024', 'wifi pw'],
  ['token in a link', 'calendar feed https://cal.example.com/feed.ics?t=9fK2mQ7pL4vB8nR3', '9fK2mQ7pL4vB8nR3'],
  ['short random key', 'use Kt9F3cQe7Xb2 for the maps', 'Kt9F3cQe7Xb2'],
  ['routing number', 'routing 021000021 acct 123456789', '021000021'],
  ['account number (acct)', 'routing 021000021 acct 123456789', '123456789'],
  ['passport number', 'passport AB1234567 renew next year', 'AB1234567'],
  ['authenticator seed', 'authenticator seed JBSWY3DPEHPK3PXP', 'JBSWY3DPEHPK3PXP'],
];

if (section('Detection: every secret is removed from the input, refused by the guard and by the brain')) {
  freshBrain('detect');
  // slot: what a model would call it (the label is for the test report); with no source text, that is all the guard has.
  for (const [label, text, secret, slot = label] of POSITIVE) {
    const r = R.redact(text);
    check(`redacted: ${label}`, !holds(r.text, secret) && r.found.length > 0 && r.values.length > 0, r.text);
    // The guard with NO help from the source (as if the model invented or remembered it).
    const asText = { kind: 'fact', slot: 'note', value: secret, text: `The user mentioned ${secret}.`, certainty: 'stated', importance: 0.9 };
    const asLabel = { kind: 'fact', slot: slot.toLowerCase(), value: secret, text: `${slot}: ${secret}`, certainty: 'stated', importance: 0.9 };
    const g = S.checkExtraction({ observations: [asLabel], plans: [] }, { events: eventsFor([text]) });
    check(`guard drops it (labelled): ${label}`, g.ok && g.observations.length === 0 && g.dropped.every((d) => /secret/.test(d.why) && !JSON.stringify(d).includes(secret)), JSON.stringify(g.observations));
    // With the redacted source and the removed values, as the engine runs it.
    const g2 = S.checkExtraction({ observations: [asText], plans: [] }, { events: eventsFor([r.text]), secrets: r.values });
    check(`guard drops it (bare value, from the source): ${label}`, g2.observations.length === 0, JSON.stringify(g2));
    const b = BR.observe(asLabel, { product: 'test' });
    check(`brain refuses it: ${label}`, b.action === 'ignored' && b.why === 'looks like a secret');
  }
  check('nothing above reached the brain, the change log or its file', POSITIVE.every(([, , s]) => !holds(brainDump(), s) && !holds(brainBytes(), s)));
  check('redaction is idempotent (the marker is never redacted again)', POSITIVE.every(([, t]) => { const a = R.redact(t).text; return R.redact(a).text === a; }));
  check('the redactor keeps the label ("pin is [secret removed]")', R.redact('my ATM pin is 4821').text === 'my ATM pin is [secret removed]');
  check('nothing reports a value: found holds kinds only', POSITIVE.every(([, t, s]) => !R.redact(t).found.some((k) => holds(k, s))));
}

// ─── Negative controls ──────────────────────────────────────────────────────

// [label, what the user said, the observation a model should return]
const NEGATIVE = [
  ['price', 'the new monitor was Rs 45,000, worth it', { kind: 'fact', slot: 'monitor price', value: 'Rs 45,000', text: 'The user bought a monitor for Rs 45,000.' }],
  ['price in dollars', 'I want to keep the trip under $1200', { kind: 'preference', slot: 'trip budget', value: 'under $1200', text: 'The user wants the trip to cost under $1200.' }],
  ['price range', 'budget is 5000-8000 for the sofa', { kind: 'preference', slot: 'sofa budget', value: '5000-8000', text: 'The user\'s sofa budget is 5000-8000.' }],
  ['time', 'I go to the gym at 6am on weekdays', { kind: 'routine', slot: 'gym time', value: '6am weekdays', text: 'The user goes to the gym at 6am on weekdays.' }],
  ['time with minutes', 'standup moved to 10:30 every day', { kind: 'routine', slot: 'standup time', value: '10:30', text: 'Standup is at 10:30 every day.' }],
  ['working hours', 'I only take calls 0900-1700', { kind: 'preference', slot: 'call hours', value: '0900-1700', text: 'The user only takes calls 0900-1700.' }],
  ['date', 'my exam is on 2026-12-14', { kind: 'fact', slot: 'exam date', value: '2026-12-14', text: 'The user\'s exam is on 2026-12-14.' }],
  ['date with slashes', 'flight on 14/12 to Dubai', { kind: 'fact', slot: 'flight date', value: '14/12', text: 'The user flies to Dubai on 14/12.' }],
  ['age', 'I\'m 29 years old and my son is 4', { kind: 'fact', slot: 'age', value: '29', text: 'The user is 29 years old.' }],
  ['room number', 'my office is room 204 in block C', { kind: 'fact', slot: 'office room', value: 'room 204, block C', text: 'The user\'s office is room 204 in block C.' }],
  ['flat number', 'we live in flat 1203, Bahria Heights', { kind: 'fact', slot: 'home', value: 'flat 1203, Bahria Heights', text: 'The user lives in flat 1203, Bahria Heights.' }],
  ['year', 'I graduated in 2019 from NUST', { kind: 'fact', slot: 'graduation', value: '2019, NUST', text: 'The user graduated from NUST in 2019.' }],
  ['year range', 'worked at Systems Ltd 2019-2023', { kind: 'fact', slot: 'previous job', value: 'Systems Ltd 2019-2023', text: 'The user worked at Systems Ltd from 2019-2023.' }],
  ['version', 'we are on Next.js 14.2.3 and Node 22', { kind: 'decision', slot: 'framework', value: 'Next.js 14.2.3', text: 'The project uses Next.js 14.2.3 on Node 22.', project: 'shop' }],
  ['model name', 'run Qwen3-1.7B-Instruct-Q4_K_M locally', { kind: 'decision', slot: 'local model', value: 'Qwen3-1.7B-Instruct-Q4_K_M', text: 'The project runs Qwen3-1.7B-Instruct-Q4_K_M locally.', project: 'shop' }],
  ['score', 'Pakistan won 3-1 last night, what a game', { kind: 'fact', slot: 'cricket', value: 'follows Pakistan', text: 'The user follows Pakistan cricket; they won 3-1.' }],
  ['phone number', 'my dentist is Dr. Sana, 0300 1234567', { kind: 'fact', slot: 'dentist', value: 'Dr. Sana, 0300 1234567', text: 'The user\'s dentist is Dr. Sana (0300 1234567).' }],
  ['issue number', 'please fix issue #123 before the release', { kind: 'todo', slot: 'issue 123', value: 'fix issue #123', text: 'Fix issue #123 before the release.', project: 'shop' }],
  ['distance and weight', 'ran 5km today, down to 72kg', { kind: 'fact', slot: 'weight', value: '72kg', text: 'The user weighs 72kg and runs 5km.' }],
  ['percentage', 'I save 20% of my salary', { kind: 'routine', slot: 'savings', value: '20% of salary', text: 'The user saves 20% of their salary.' }],
  ['code as in programming', 'the code review is on Thursday at 10', { kind: 'routine', slot: 'code review', value: 'Thursday at 10', text: 'Code review is on Thursday at 10.', project: 'shop' }],
  ['key as in important', 'key decision: we ship v2 on 15 Dec', { kind: 'decision', slot: 'release date', value: 'v2 on 15 Dec', text: 'The project ships v2 on 15 Dec.', project: 'shop' }],
  ['OTP as a feature (no value)', 'sign-in is phone OTP only now since email login is gone', { kind: 'decision', slot: 'sign-in method', value: 'phone OTP only', text: 'Sign-in is phone OTP only.', project: 'shop' }],
  ['gym schedule next to a code', 'locker code 2207. I go Mon/Wed/Fri at 6am before work', { kind: 'routine', slot: 'gym', value: 'Mon/Wed/Fri at 6am', text: 'The user goes to the gym Mon/Wed/Fri at 6am.' }],
  ['cleaner visit next to a door code', 'the cleaner comes thursday at 10, door code is 58#14.', { kind: 'routine', slot: 'cleaner', value: 'Thursday at 10', text: 'The cleaner comes on Thursday at 10.' }],
  ['Roman Urdu salary date', 'salary ab 1 tareekh ke bajaye 25 ko aati hai', { kind: 'fact', slot: 'salary date', value: '25th of the month', text: 'The user\'s salary comes on the 25th.' }],
  // False positives the red-team pass found, now kept
  ['token count', 'prompts stay under 8000 tokens', { kind: 'requirement', slot: 'prompt size', value: 'under 8000 tokens', text: 'Prompts stay under 8000 tokens.', project: 'shop' }],
  ['max tokens setting', 'set max tokens to 4096', { kind: 'decision', slot: 'max tokens', value: '4096', text: 'Max tokens is set to 4096.', project: 'shop' }],
  ['code size', 'the code is about 300 lines now', { kind: 'fact', slot: 'code size', value: 'about 300 lines', text: 'The code is about 300 lines now.', project: 'shop' }],
  ['OTP expiry setting', 'sign-in OTP expires after 300 seconds', { kind: 'decision', slot: 'otp expiry', value: '300 seconds', text: 'Sign-in OTP expires after 300 seconds.', project: 'shop' }],
  ['response code', 'the API keeps giving response code 502', { kind: 'fact', slot: 'api error', value: 'response code 502', text: 'The API returns response code 502.', project: 'shop' }],
  ['user@host', 'we deploy to deploy@10.0.0.5', { kind: 'decision', slot: 'deploy target', value: 'deploy@10.0.0.5', text: 'The project deploys to deploy@10.0.0.5.', project: 'shop' }],
  ['meal combo', 'my usual is the Zinger combo, it is 1250 now', { kind: 'preference', slot: 'usual order', value: 'Zinger combo, 1250', text: 'The user usually orders the Zinger combo (1250).' }],
  ['pin as a verb', 'pin image node:22.11.0-alpine3.20 in the Dockerfile', { kind: 'decision', slot: 'base image', value: 'node:22.11.0-alpine3.20', text: 'The project pins image node:22.11.0-alpine3.20.', project: 'shop' }],
  ['commit hash', 'commit 1844c10ab486fd830163aed5a9a2d420640658ab fixed the crash', { kind: 'fact', slot: 'crash fix', value: 'commit 1844c10ab486fd830163aed5a9a2d420640658ab', text: 'The crash was fixed in commit 1844c10ab486fd830163aed5a9a2d420640658ab.', project: 'shop' }],
  ['UUID', 'azure subscription 123e4567-e89b-12d3-a456-426614174000', { kind: 'fact', slot: 'azure subscription', value: '123e4567-e89b-12d3-a456-426614174000', text: 'The Azure subscription is 123e4567-e89b-12d3-a456-426614174000.', project: 'shop' }],
  ['hash algorithm', 'passwords are hashed with argon2id', { kind: 'decision', slot: 'hashing', value: 'argon2id', text: 'Passwords are hashed with argon2id.', project: 'shop' }],
  ['API keys from env (no value)', 'API keys come from env vars, never hardcoded', { kind: 'decision', slot: 'config', value: 'env vars', text: 'API keys come from env vars, never hardcoded.', project: 'shop' }],
];

if (section('Negative controls: ordinary numbers are kept')) {
  freshBrain('negative');
  for (const [label, said, obs] of NEGATIVE) {
    const o = { certainty: 'stated', importance: 0.7, ...obs };
    const r = R.redact(said);
    const secretInIt = /2207|58#14/.test(said);
    if (!secretInIt) check(`input unchanged: ${label}`, r.text === said, r.text);
    const g = S.checkExtraction({ observations: [o], plans: [] }, { events: eventsFor([r.text]), secrets: r.values });
    check(`guard keeps it: ${label}`, g.observations.length === 1, JSON.stringify(g.dropped));
    const b = BR.observe(o, { product: 'test' });
    check(`brain stores it: ${label}`, b.action === 'added' || b.action === 'reinforced', JSON.stringify(b));
  }
  const kept = BR.list({ limit: 1000 }).length;
  check('every negative control is readable back (list, contextBlock)', kept === NEGATIVE.length && /room 204/.test(BR.contextBlock({ request: 'where is my office room' })), kept);
  // Plans that name a secret but hold none are reminders worth keeping.
  const p = S.checkExtraction({ observations: [], plans: [{ what: 'Rotate the SSO password and re-enroll MFA', when: '2026-12-04', where: '', who: [] }] }, { events: eventsFor(['I need to rotate my SSO password by Friday']) });
  check('a plan that only names a password is kept ("rotate the SSO password by Friday")', p.plans.length === 1);
  const p2 = S.checkExtraction({ observations: [], plans: [{ what: 'Let the cleaner in, gate code 4471', when: '2026-12-04T10:00', where: 'home', who: [] }] }, { events: eventsFor(['cleaner at 10 tomorrow']) });
  check('a plan that holds a code is dropped', p2.plans.length === 0 && p2.dropped.some((d) => /secret/.test(d.why)));
}

// ─── Benchmark-520 end to end ───────────────────────────────────────────────

/** Answers that try to sneak each secret into every field. */
function adversarial(ex) {
  const obs = []; const plans = [];
  for (const s of ex.secrets) {
    for (const v of variants(s)) {
      obs.push({ kind: 'fact', slot: 'note', value: v, text: 'The user shared something to keep.', certainty: 'stated', importance: 0.9 });
      obs.push({ kind: 'fact', slot: 'favourite number', value: 'see text', text: `The user's lucky string is ${v}.`, certainty: 'stated', importance: 0.9 });
      obs.push({ kind: 'preference', slot: `code ${v}`, value: 'yes', text: 'The user likes this.', certainty: 'stated', importance: 0.9 });
      obs.push({ kind: 'context', slot: 'status', value: 'busy', text: 'The user is busy.', certainty: 'temporary', importance: 0.9, until: v });
      obs.push({ kind: 'decision', slot: 'stack', value: 'Postgres', text: 'The project uses Postgres.', certainty: 'stated', importance: 0.9, project: `proj ${v}` });
      obs.push({ kind: 'fact', slot: 'portal', value: `${v} and more`, text: 'The user has a portal account.', certainty: 'implied', importance: 0.9 });
      plans.push({ what: `Visit ${v}`, when: '2026-12-03T10:00', where: '', who: [] });
      plans.push({ what: 'Visit the bank', when: '2026-12-03T10:00', where: `branch ${v}`, who: [] });
      plans.push({ what: 'Call Ali', when: '2026-12-03T10:00', where: '', who: [`Ali ${v}`] });
    }
  }
  return { observations: obs, plans };
}

/** One example through what the app does: queue (redacted on ingest), redact, guard, observe; returns the guard result. */
function runExample(ex, answer, name) {
  const now = Date.parse(ex.input.now);
  NOW = now;
  const st = EV.openEventStore({ file: path.join(tmp, `${name}-context.db`), now: () => now });
  for (const e of ex.input.events) st.ingest({ ...e, at: Date.parse(e.at), product: 'craft' });
  const queued = st.pending(20);
  const secrets = []; const events = [];
  // As the engine: the values removed when queued (in memory) and a second redaction pass.
  for (const e of queued) { const r = R.redact(e.text); secrets.push(...st.secretsFor(e.id), ...r.values); events.push({ ...e, text: r.text }); }
  const g = S.checkExtraction(answer, { events, secrets, minImportance: 0 });
  for (const o of g.observations) { BR.observe(o, { product: 'test' }); BR.observe({ ...o, certainty: 'implied' }, { product: 'test' }); }
  const storeBytes = ['', '-wal'].map((x) => { try { return fs.readFileSync(path.join(tmp, `${name}-context.db${x}`)).toString('latin1'); } catch { return ''; } }).join('');
  st.close();
  return { g, events, storeBytes };
}

if (section('Benchmark-520: every secret example, recorded and adversarial answers, end to end')) {
  let recordedLeaks = 0; let goldKept = 0; let goldTotal = 0;
  for (const ex of BENCH) {
    // The input never carries the secret past redaction, and the queue never stores it.
    freshBrain(`bench-${ex.id}`);
    const answers = [...Object.entries(ex.recorded).map(([k, v]) => [k, v.answer]), ['adversarial', adversarial(ex)], ['gold', ex.gold]];
    for (const [k, answer] of answers) {
      const { g, events, storeBytes } = runExample(ex, answer, `${ex.id}-${k}`);
      if (ex.recorded[k]) recordedLeaks += ex.recorded[k].leakedInRun || 0;
      const out = JSON.stringify([g.observations, g.plans, g.dropped]);
      for (const s of ex.secrets) {
        check(`${ex.id} ${k}: the model's input has no "${s.slice(0, 4)}…"`, !events.some((e) => holds(e.text, s)));
        check(`${ex.id} ${k}: the event queue's file has no "${s.slice(0, 4)}…"`, !holds(storeBytes, s));
        check(`${ex.id} ${k}: the guard lets no "${s.slice(0, 4)}…" through (or into its drop log)`, !holds(out, s), out.slice(0, 600));
      }
      if (k === 'gold') {
        goldTotal += ex.gold.observations.length;
        goldKept += ex.gold.observations.filter((o) => g.observations.some((x) => x.text === o.text)).length;
        check(`${ex.id}: the gold plans survive the guard`, g.plans.length === ex.gold.plans.length);
      }
    }
    const request = ex.input.events.map((e) => e.text).join(' ');
    const dump = brainDump(request);
    const recalls = ex.secrets.map((s) => BR.recallTool({ query: s }).output).filter((o) => !/^Nothing in the brain/.test(o)).join('\n');
    for (const s of ex.secrets) {
      check(`${ex.id}: no "${s.slice(0, 4)}…" in memories, history, challengers, change log, contextBlock or recall`, !holds(dump, s) && !holds(recalls, s));
      check(`${ex.id}: no "${s.slice(0, 4)}…" in the brain's file on disk`, !holds(brainBytes(), s));
    }
  }
  check(`the recorded answers carried ${recordedLeaks} leaks before this fix (fixture sanity)`, recordedLeaks === 24, recordedLeaks);
  check(`every gold memory of these examples is still kept (${goldKept}/${goldTotal})`, goldKept === goldTotal);
}

// ─── Brain paths: replace, challenge, correct, forget ───────────────────────

if (section('Brain paths: a secret cannot ride in through history, challengers or corrections')) {
  freshBrain('paths');
  const a = BR.observe({ kind: 'fact', slot: 'gym locker', value: 'locker 12 by the showers', text: 'The user uses locker 12 by the showers.', certainty: 'stated' }, { product: 'test' });
  const rep = BR.observe({ kind: 'fact', slot: 'gym locker', value: 'locker code 2207', text: 'The user\'s locker code is 2207.', certainty: 'stated' }, { product: 'test' });
  const ch = BR.observe({ kind: 'fact', slot: 'gym locker', value: '2207', text: 'Locker combination 2207.', certainty: 'implied' }, { product: 'test' });
  check('a stated replacement with a secret is refused, the memory unchanged', rep.action === 'ignored' && ch.action === 'ignored' && BR.get(a.memory.id).text === 'The user uses locker 12 by the showers.' && !BR.get(a.memory.id).challenger);
  let threw = '';
  try { BR.correct(a.memory.id, { value: '58#14' }); } catch (e) { threw = e.message; }
  check('correct() refuses a secret in the value, not only the text', /looks like a secret/.test(threw) && BR.get(a.memory.id).value === 'locker 12 by the showers');
  try { threw = ''; BR.correct(a.memory.id, { text: 'Door code is 58#14.' }); } catch (e) { threw = e.message; }
  check('correct() refuses a secret in the text', /looks like a secret/.test(threw));
  const tool = BR.rememberTool({ kind: 'fact', slot: 'wifi', value: 'Kh@1ber_2026!', text: 'Home wifi.' }, {});
  check('the remember tool refuses it and says so', tool.ok === false && /Not saved/.test(tool.output) && !tool.output.includes('Kh@1ber'));
  const lesson = BR.shareLessons([{ situation: 'the office door is locked', strategy: 'use door code 58#14' }], { botId: 'b1', botName: 'Ops' });
  check('a bot lesson with a code is refused', lesson[0] && lesson[0].action === 'ignored');
  const h = BR.createHandoff({ to: 'calendar', intent: 'book the cleaner', facts: ['Cleaner Thursday 10am', 'door code is 58#14', 'locker code 2207'], team: [] });
  check('handoff facts with a code are dropped, the rest kept', h.handoff && h.handoff.facts.length === 1 && h.handoff.facts[0] === 'Cleaner Thursday 10am');
  check('nothing above is in the brain or its file', !/2207|58#14|Kh@1ber/.test(brainDump()) && !/2207|58#14|Kh@1ber/.test(brainBytes()));
}

// ─── The other stores a model's answer reaches ──────────────────────────────

if (section('Bot memory and Life plans: the same rule on the legacy path')) {
  NOW = Date.UTC(2026, 10, 1, 9, 0, 0);
  const B = lib('bots.js');
  const r = B.mergeMemory([], ['The user\'s locker code is 2207.', 'Door code 58#14 for the cleaner.', 'Their openweather key is owm-Kt9F3cQe7Xb24dRw46ZpLm.', 'The user goes to the gym at 6am.', 'The user prefers dark mode.']);
  check('a bot\'s memory (in every prompt it runs) keeps no secret', r.added.length === 2 && !/2207|58#14|owm-/.test(JSON.stringify(r.memory)), JSON.stringify(r.added));
  const L = lib('life.js');
  const LS = lib('life-store.js');
  const ls = LS.openLifeStore({ file: path.join(tmp, 'life.db'), key: Buffer.alloc(32, 7), now: () => NOW });
  L.attach(ls, { tz: 'Asia/Karachi' });
  const plans = L.notePlans([
    { what: 'Let the cleaner in, gate code 4471', when: '2026-11-05T10:00', where: '', who: [] },
    { what: 'Cleaner visit', when: '2026-11-05T10:00', where: 'home, door 58#14', who: [] },
    { what: 'Rotate the SSO password', when: '2026-11-06', where: '', who: [] },
    { what: 'Dinner with Ali', when: '2026-11-05T20:00', where: 'Monal', who: ['Ali'] },
  ], { now: NOW, tz: 'Asia/Karachi', source: 'chat' });
  check('life.notePlans drops a plan with a code and keeps the rest', plans.length === 2 && plans.every((p) => !/4471|58#14/.test(JSON.stringify(p))), JSON.stringify(plans.map((p) => p.title)));
  L.detach(); ls.close();
}

if (section('Legacy paths: learnFromExchange and bot learnFromTurn redact first and check what comes back')) {
  freshBrain('legacy');
  NOW = Date.UTC(2026, 10, 1, 9, 0, 0);
  const seen = [];
  // A model that writes the code back without any cue word, as the red-team pass showed models do.
  const chatFn = async (messages) => { seen.push(messages[0].content); return { success: true, json: { facts: ['The front door opens with 4471.', 'The user goes to the gym at 6am.'], plans: [{ what: 'Cleaner, door 4471', when: '2026-11-05T10:00', where: '', who: [] }], observations: [
    { kind: 'fact', slot: 'front door', value: '4471', text: 'Front door: 4471.', certainty: 'stated' },
    { kind: 'fact', slot: 'atm', value: 'uses 4821', text: 'HBL ATM card uses 4821.', certainty: 'stated' },
    { kind: 'routine', slot: 'gym', value: '6am', text: 'The user goes to the gym at 6am.', certainty: 'stated' },
  ] } }; };
  const said = 'door code is 4471 and my ATM pin is 4821. I go to the gym at 6am every day.';
  const r = await BR.learnFromExchange({ userText: said, replyText: 'Noted the gym time.', src: { product: 'craft' } }, chatFn);
  check('legacy learnFromExchange: the model never sees the codes', !/4471|4821/.test(seen[0]));
  check('legacy learnFromExchange: only the gym routine is kept', r.filter((x) => x.action === 'added').length === 1 && !/4471|4821/.test(brainDump()), JSON.stringify(r));
  const B = lib('bots.js');
  const bot = B.createBot({ name: 'Ops', role: 'assistant' });
  const t = await B.learnFromTurn(bot, said, 'Noted.', chatFn);
  check('bot learnFromTurn: the model never sees the codes', !/4471|4821/.test(seen[1]));
  check('bot learnFromTurn: the bot\'s memory and the brain keep no code', !/4471|4821/.test(JSON.stringify(B.getBot(bot.id).memory)) && !/4471|4821/.test(brainDump()) && (t.added || []).length === 1, JSON.stringify(t));
}

// ─── A brain written before the fix ─────────────────────────────────────────

/** Rows as the old code could have stored them (it only knew brain.SECRET_RE). */
function seedOldBrain(file) {
  const db = loadDriver().open(file);
  const t = NOW;
  const ins = db.prepare(`INSERT INTO memories (id, kind, scope, slot, value, text, status, confidence, evidence, locked, review, challenger, history, sources, domain, expires_at, created_at, updated_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const src = JSON.stringify([{ product: 'craft', at: t }]);
  ins.run('m_old1', 'context', 'me', 'locker code location', '2207 at Al Qusais gym', 'The user\'s locker code is 2207 and it\'s at the Al Qusais gym.', 'temporary', 0.7, 1, 0, 0, null, '[]', src, null, t + 86400000, t, t, t);
  ins.run('m_old2', 'context', 'me', 'backup codes for uni portal', '7731-0042 and 5519-8820', 'User shared backup codes for the university portal.', 'temporary', 0.7, 1, 0, 0, null, '[]', src, null, t + 86400000, t, t, t);
  ins.run('m_old3', 'context', 'me', 'cleaner visit', 'the cleaner comes Thursday at 10, door code is 58#14', 'The cleaner visits on Thursdays at 10:00 AM; the door code is 58#14.', 'temporary', 0.7, 1, 0, 0, null, '[]', src, null, t + 86400000, t, t, t);
  ins.run('m_old4', 'decision', 'project:skyline-dash', 'openweather key', 'owm-Kt9F3cQe7Xb24dRw46ZpLm', 'Skyline-dash uses the key owm-Kt9F3cQe7Xb24dRw46ZpLm.', 'confirmed', 0.8, 1, 0, 0, null, '[]', src, null, null, t, t, t);
  // Safe now, a secret in what it used to say and in what challenged it.
  ins.run('m_hist', 'fact', 'me', 'home door', 'smart lock', 'The user\'s home has a smart lock.', 'confirmed', 0.8, 1, 0, 0,
    JSON.stringify({ value: '58#14', text: 'Door code 58#14.', count: 1, at: t }), JSON.stringify([{ value: 'door code 4471', text: 'The door code is 4471.', status: 'confirmed', until: t }]), src, null, null, t, t, t);
  ins.run('m_safe', 'preference', 'me', 'cleaning products', 'eco products', 'The user prefers eco cleaning products.', 'confirmed', 0.8, 1, 0, 0, null, '[]', src, null, null, t, t, t);
  db.prepare('INSERT INTO changes (at, memory_id, action, text, source) VALUES (?, ?, ?, ?, ?)').run(t, 'm_old3', 'added', 'The cleaner visits on Thursdays at 10:00 AM; the door code is 58#14. (for now)', 'craft');
  db.prepare(`INSERT INTO handoffs (id, from_bot, from_name, to_bot, to_name, domain, intent, facts, decision, requester, origin, parent, task_id, status, result, created_at, updated_at)
    VALUES ('h_old', NULL, 'Codeply', NULL, NULL, NULL, 'let the cleaner in', ?, NULL, 'user', NULL, NULL, NULL, 'open', NULL, ?, ?)`).run(JSON.stringify(['Thursday 10am', 'gate code 4471']), t, t);
  db.close();
}
const OLD_SECRETS = ['2207', '7731-0042', '5519-8820', '58#14', 'owm-Kt9F3cQe7Xb24dRw46ZpLm', '4471'];

if (section('A brain written before the fix: reads skip its secrets, the sweep removes them')) {
  freshBrain('old');
  BR.touchProject({ name: 'skyline-dash' });
  BR.close();
  seedOldBrain(brainFile);
  BR.configure({ file: brainFile, now: () => NOW });
  check('the seeded secrets are really in the file (test sanity)', OLD_SECRETS.every((s) => brainBytes().includes(s)));
  const reads = JSON.stringify([
    BR.list({ limit: 1000 }), BR.list({ scope: 'project:skyline-dash' }), BR.changes({ limit: 100 }),
    BR.contextBlock({ request: 'gym locker cleaner door code backup portal', project: 'skyline-dash' }),
    BR.contextBlock({ request: 'openweather key widget', project: 'skyline-dash', learnsByItself: true }),
    BR.recallTool({ query: '' }).output, BR.recallTool({ query: 'locker' }).output, BR.recallTool({ query: 'cleaner' }).output,
    BR.recallTool({ query: 'key', project: 'skyline-dash' }).output, BR.recallTool({ query: 'door' }).output, BR.getSafe('m_old1'),
  ]);
  check('list, changes, contextBlock and recall never show them', OLD_SECRETS.every((s) => !reads.includes(s)), OLD_SECRETS.filter((s) => reads.includes(s)));
  check('the safe memory is still read', /eco cleaning products/.test(reads));
  // The Context Engine shows the model what it knows (so it reuses slots): not these.
  const seen = [];
  const st = EV.openEventStore({ file: path.join(tmp, 'old-context.db'), now: () => NOW });
  const engine = EN.createEngine({ store: st, brain: BR, providers: { rules: M.createRulesProvider(), cloud: { info: () => ({ id: 'cloud', kind: 'cloud', local: false, model: 'f' }), available: async () => true, async extract(i) { seen.push(i); return { answer: { observations: [], plans: [] }, model: 'f', ms: 1, usage: {} }; } } }, settings: () => ({ mode: 'cloud' }), now: () => NOW });
  engine.ingest(chat('the cleaner and the gym locker and the door, and the openweather key for skyline-dash', { project: 'skyline-dash' }));
  await engine.process();
  check('the engine never shows the model a stored secret as a known memory', seen.length === 1 && OLD_SECRETS.every((s) => !JSON.stringify(seen[0].known).includes(s)) && seen[0].known.some((k) => /eco/.test(k.text)), JSON.stringify(seen[0] && seen[0].known));
  st.close();
  // forget() of a secret memory does not copy it into the change log.
  BR.forget('m_old4');
  check('forget() logs a placeholder, not the secret', !brainDump().includes('owm-Kt9F') && BR.changes({ limit: 5 }).some((c) => c.action === 'forgotten' && /hidden/.test(c.text)));
  // A safe update to a memory whose history holds a secret does not keep the secret going.
  const dry = BR.sweepSecrets();
  check('the sweep (dry run) finds every one, without the values', dry.applied === false && dry.deleted.length === 3 && dry.cleaned.length === 1 && dry.changes >= 1 && dry.handoffs === 1 && OLD_SECRETS.every((s) => !JSON.stringify(dry).includes(s)), JSON.stringify(dry));
  check('a dry run changes nothing', BR.list({ includeSecrets: true, limit: 100 }).length === 5);
  const done = BR.sweepSecrets({ apply: true });
  const after = BR.list({ includeSecrets: true, includeExpired: true, limit: 100 });
  check('the sweep deletes secret memories and cleans history and challengers, keeping the rest', done.applied && after.length === 2 && after.some((m) => m.id === 'm_hist' && !m.challenger && m.history.length === 0) && after.some((m) => m.id === 'm_safe'), JSON.stringify(after));
  check('the sweep leaves no secret in the brain\'s file, its WAL or its handoffs', OLD_SECRETS.every((s) => !brainBytes().includes(s)), OLD_SECRETS.filter((s) => brainBytes().includes(s)));
  check('a second sweep finds nothing', (() => { const r = BR.sweepSecrets(); return !r.deleted.length && !r.cleaned.length && !r.changes && !r.handoffs; })());
}

// ─── The one-off sweep script ───────────────────────────────────────────────

if (section('Sweep script: dry run reports, --apply cleans brain, event queue and vectors')) {
  const { execFileSync } = await import('child_process');
  const dir = path.join(tmp, 'sweep-home');
  fs.mkdirSync(dir, { recursive: true });
  const files = { brain: path.join(dir, 'brain.db'), context: path.join(dir, 'context.db'), vectors: path.join(dir, 'vectors.db') };
  BR.configure({ file: files.brain, now: () => NOW }); BR.touchProject({ name: 'skyline-dash' }); BR.close();
  seedOldBrain(files.brain);
  // An event queue as the old code kept it: raw text, and an outcome quoting a stored secret.
  EV.openEventStore({ file: files.context, now: () => NOW }).close();
  const cdb = loadDriver().open(files.context);
  const ins = cdb.prepare(`INSERT INTO events (id, source, product, at, trust, sensitive, project, actor, text, meta, content_hash, status, attempts, next_at, provider, model, local, outcome, error, created_at, updated_at)
    VALUES (?, 'chat', 'craft', ?, 'user', 0, NULL, NULL, ?, '{}', ?, ?, 0, 0, NULL, NULL, NULL, ?, NULL, ?, ?)`);
  ins.run('ev_old_pending', NOW, 'User: mera pin 4432 hai, and the gym is at 6am', 'h1', 'pending', null, NOW, NOW);
  ins.run('ev_old_done', NOW, 'User: door code is 58#14, cleaner on thursday', 'h2', 'done', JSON.stringify({ actions: [{ text: 'The door code is 58#14.', slot: 'door code', action: 'added', id: 'm_old3' }, { text: 'The cleaner comes Thursday.', slot: 'cleaner', action: 'added', id: 'm_x' }] }), NOW, NOW);
  ins.run('ev_ok', NOW, 'User: I prefer dark mode', 'h3', 'done', JSON.stringify({ actions: [{ text: 'The user prefers dark mode.', action: 'added', id: 'm_y' }] }), NOW, NOW);
  cdb.close();
  const RV = lib('context-retrieval.js');
  const vs = RV.vectorStore({ file: files.vectors });
  for (const id of ['m_old1', 'm_old2', 'm_safe', 'm_hist']) vs.put(id, 'nomic', 'h', [0.1, 0.2, 0.3]);
  vs.close();
  const run = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/context/sweep-secrets.mjs'), '--brain', files.brain, '--context', files.context, '--vectors', files.vectors, ...a], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const bytes = () => Object.values(files).map((f) => ['', '-wal'].map((x) => { try { return fs.readFileSync(f + x).toString('latin1'); } catch { return ''; } }).join('')).join('\n');
  const ALL = [...OLD_SECRETS, '4432'];
  const dryOut = run();
  const dry = JSON.parse(dryOut.slice(0, dryOut.lastIndexOf('}') + 1));
  check('dry run: reports memories, change lines, handoffs, queue text and outcomes', dry.brain.deleted === 4 && dry.brain.cleaned === 1 && dry.brain.handoffs === 1 && dry.context.textRedacted === 1 && dry.context.textCleared === 1 && dry.context.outcomes === 1, dryOut);
  check('dry run: prints no secret and changes nothing', ALL.every((s) => !dryOut.includes(s)) && ALL.every((s) => bytes().includes(s)));
  const applied = JSON.parse((() => { const o = run('--apply'); return o.slice(0, o.lastIndexOf('}') + 1); })());
  check('--apply: vectors of deleted memories go too', applied.vectors.orphans === 2, JSON.stringify(applied.vectors));
  check('--apply: no secret left in any of the three files (or their WAL)', ALL.every((s) => !bytes().includes(s)), ALL.filter((s) => bytes().includes(s)));
  const after = loadDriver().open(files.context);
  const rows = Object.fromEntries(after.prepare('SELECT id, text, outcome FROM events').all().map((r) => [r.id, r]));
  after.close();
  check('--apply: waiting text is redacted (still processable), processed text cleared, the rest untouched', /gym is at 6am/.test(rows.ev_old_pending.text) && rows.ev_old_done.text === null && rows.ev_ok.text === 'User: I prefer dark mode' && /cleaner comes Thursday/.test(rows.ev_old_done.outcome));
  BR.configure({ file: files.brain, now: () => NOW });
  check('--apply: the safe memories are still there', BR.list({ limit: 50 }).map((m) => m.id).sort().join(',') === 'm_hist,m_safe');
}

// ─── The engine with a backend that cheats ──────────────────────────────────

if (section('Engine: a backend that writes the unredacted secret back is stopped')) {
  freshBrain('cheat');
  const st = EV.openEventStore({ file: path.join(tmp, 'cheat-context.db'), now: () => NOW });
  const said = 'note: locker code 2207. backup codes 7731-0042. door code is 58#14. owm key owm-Kt9F3cQe7Xb24dRw46ZpLm. mera pin 4432 hai. I go to the gym Mon/Wed/Fri at 6am.';
  const SECRETS = ['2207', '7731-0042', '58#14', 'owm-Kt9F3cQe7Xb24dRw46ZpLm', '4432'];
  const asked = [];
  // It ignores what it was given and copies the original words (as a model fed by a buggy route would).
  const cheat = { info: () => ({ id: 'cloud', kind: 'cloud', local: false, model: 'cheat' }), available: async () => true,
    async extract(input) {
      asked.push(input);
      return { model: 'cheat', ms: 1, usage: {}, answer: { observations: [
        ...SECRETS.map((s) => ({ kind: 'fact', slot: 'stuff', value: s, text: `The user said ${s}.`, certainty: 'stated', importance: 0.9 })),
        { kind: 'fact', slot: 'notes', value: said.slice(0, 150), text: said.slice(0, 230), certainty: 'stated', importance: 0.9 },
        { kind: 'routine', slot: 'gym', value: 'Mon/Wed/Fri at 6am', text: 'The user goes to the gym Mon/Wed/Fri at 6am.', certainty: 'stated', importance: 0.7 },
      ], plans: [{ what: 'Let the cleaner in with 58#14', when: '2026-11-05T10:00', where: '', who: [] }] } };
    } };
  const engine = EN.createEngine({ store: st, brain: BR, providers: { rules: M.createRulesProvider(), cloud: cheat }, settings: () => ({ mode: 'cloud' }), now: () => NOW });
  engine.ingest(chat(said));
  const r = await engine.process();
  const b = r.batches[0];
  check('the model saw none of the secrets', SECRETS.every((s) => !JSON.stringify(asked).includes(s)));
  check('only the gym routine was kept; every secret was dropped', b.kept === 1 && b.actions[0].slot === 'gym' && b.dropped.filter((d) => /secret/.test(d)).length >= SECRETS.length + 1, JSON.stringify(b));
  check('the outcome on the event says what was redacted, never the values', b.redacted.length > 0 && SECRETS.every((s) => !JSON.stringify(st.recent(5)).includes(s)));
  check('no secret in the brain, its file, or the event queue\'s file', SECRETS.every((s) => !holds(brainDump(said), s) && !holds(brainBytes(), s) && !holds(['', '-wal'].map((x) => { try { return fs.readFileSync(path.join(tmp, `cheat-context.db${x}`)).toString('latin1'); } catch { return ''; } }).join(''), s)));
  st.close();
  // A sensitive event with no key is kept in memory only; it is redacted before that too.
  const st2 = EV.openEventStore({ file: path.join(tmp, 'cheat2-context.db'), now: () => NOW });
  st2.ingest({ source: 'call', trust: 'mixed', sensitive: true, text: 'Caller: the gate code is 4471, see you at 10.', at: NOW });
  check('a sensitive event is redacted before it is held', !st2.pending(5)[0].text.includes('4471'));
  st2.close();
}

console.log(failures ? `\n${failures} of ${checks} failed` : `\nAll ${checks} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
