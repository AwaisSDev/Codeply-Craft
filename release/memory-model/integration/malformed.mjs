// Deterministic part of the integration suite: what the production path does with malformed or hostile backend
// output. A fake provider returns each answer; the real guard (context-schema.js via runExtraction) and the real
// brain process it. No model needed; every case must pass.
//
//   node release/memory-model/integration/malformed.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { runCase } from './run-integration.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const M = require(path.join(ROOT, 'codeply-cli/lib/context-model.js'));

const EV = 'User: I moved to Karachi last year and I work as a nurse.\nAssistant: Nice!';
const obs = (o) => JSON.stringify({ observations: [{ kind: 'fact', slot: 'city', value: 'Karachi', text: 'The user lives in Karachi.', certainty: 'stated', importance: 0.7, about: 'user', ...o }], plans: [] });
const CASES = [
  { id: 'empty answer', answer: '', expect: { stored: 0 } },
  { id: 'not JSON', answer: 'Sure! The user lives in Karachi.', expect: { stored: 0 } },
  { id: 'wrong top-level types', answer: '{"observations": "Karachi", "plans": 5}', expect: { stored: 0 } },
  { id: 'truncated JSON', answer: '{"observations":[{"kind":"fact","slot":"city","value":"Karachi"', expect: { stored: 0 } },
  { id: 'JSON array instead of object', answer: '[{"kind":"fact","value":"Karachi"}]', expect: { stored: 0 } },
  { id: 'null observation items', answer: '{"observations":[null, 3, "x"],"plans":[]}', expect: { stored: 0 } },
  { id: 'valid grounded observation', answer: obs({}), expect: { stored: 1, re: /karachi/i } },
  { id: 'invalid enums', answer: obs({ kind: 'banana', certainty: 'maybe' }), expect: { maxStored: 1, noThrow: true } },
  { id: 'hallucinated (not in the events)', answer: obs({ slot: 'city', value: 'Tokyo', text: 'The user lives in Tokyo.' }), expect: { stored: 0 } },
  { id: 'secret in a grounded value', event: 'User: my password is hunter2bravo, I live in Karachi.\nAssistant: Please do not share passwords.', answer: obs({ slot: 'password', value: 'hunter2bravo', text: 'The user password is hunter2bravo.' }), expect: { stored: 0, secret: 'hunter2bravo' } },
  { id: 'joking certainty', answer: obs({ certainty: 'joking' }), expect: { stored: 0 } },
  { id: 'quoting certainty', answer: obs({ certainty: 'quoting' }), expect: { stored: 0 } },
  { id: 'hypothetical certainty', answer: obs({ certainty: 'hypothetical' }), expect: { stored: 0 } },
  { id: 'extra unknown fields', answer: obs({ evil: '<script>', p: { exist: 0.9 } }), expect: { stored: 1, re: /karachi/i } },
  { id: 'fifty observations', answer: JSON.stringify({ observations: Array.from({ length: 50 }, (_, i) => ({ kind: 'fact', slot: `city ${i}`, value: 'Karachi', text: `The user lives in Karachi (${i}).`, certainty: 'stated', importance: 0.7, about: 'user' })), plans: [] }), expect: { maxStored: 12 } },
  { id: 'very long value', answer: obs({ value: `Karachi ${'x'.repeat(5000)}` }), expect: { maxStored: 1, noThrow: true } },
  { id: 'markdown code fence', answer: '```json\n' + obs({}) + '\n```', expect: { maxStored: 1, noThrow: true } },
  { id: 'backend throws', throws: true, expect: { stored: 0 } },
];

const fake = (c) => ({
  info: () => ({ id: 'local', kind: 'local', local: true, model: 'fake', style: 'full' }),
  available: async () => true,
  async extract() { if (c.throws) throw new Error('connection reset'); return { answer: c.answer, model: 'fake', ms: 1, usage: {} }; },
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-malformed-'));
let failed = 0;
for (const [k, c] of CASES.entries()) {
  let outcome; let err = null;
  try { ({ outcome } = await runCase({ id: c.id, category: 'malformed', text: c.event || EV }, fake(c), tmp, k)); } catch (e) { err = e; }
  const problems = [];
  if (err) problems.push(`threw: ${err.message}`);
  else {
    const stored = outcome.results.filter((r) => ['added', 'replaced'].includes(r.action));
    if (c.expect.stored != null && stored.length !== c.expect.stored) problems.push(`stored ${stored.length}, expected ${c.expect.stored}`);
    if (c.expect.maxStored != null && stored.length > c.expect.maxStored) problems.push(`stored ${stored.length} > ${c.expect.maxStored}`);
    if (c.expect.re && !stored.some((r) => c.expect.re.test(`${r.memory.value} ${r.memory.text}`))) problems.push('expected memory missing');
    if (c.expect.secret && JSON.stringify(outcome.allMemories).includes(c.expect.secret)) problems.push('secret reached the brain');
  }
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${c.id}${problems.length ? ` - ${problems.join('; ')}` : ''}`);
}
console.log(`\nmalformed: ${CASES.length - failed}/${CASES.length} passed`);
process.exitCode = failed ? 1 : 0;
void M;
