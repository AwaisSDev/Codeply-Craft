// Brain value matching (proposal, branch codeply-brain-value-match): a value that differs from the known one
// only by filler words or a plural ending reinforces the memory instead of replacing it; anything that changes
// the meaning (another word, a negation, a number) is still a different value.
//   node scripts/brain-value-match-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BR = require(path.join(ROOT, 'codeply-cli/lib/brain.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-value-match-'));
let failures = 0; let k = 0;
const check = (name, cond, extra = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !extra ? '' : ` -- ${extra}`}`); if (!cond) failures++; };
const NOW = Date.UTC(2026, 10, 3, 10, 0, 0);

/** A fresh brain that knows `known`, then hears `heard`; returns the action and the brain's memories. */
function hear(known, heard, { times = 1, certainty = 'stated' } = {}) {
  BR.configure({ file: path.join(tmp, `b${k++}.db`), now: () => NOW });
  BR.observe({ kind: 'fact', certainty: 'stated', ...known }, { product: 'test' });
  let r;
  for (let i = 0; i < times; i++) r = BR.observe({ kind: 'fact', certainty, ...heard }, { product: 'context' });
  const all = BR.list({});
  BR.close();
  return { action: r.action, all };
}

console.log('Same value, different wording: reinforced, one memory, nothing in its history');
for (const [known, heard] of [
  ['a dog named Sheru', 'dog named Sheru'],              // integration case dup-02
  ['short bullet points', 'short bullet-point'],
  ['The Lahore office', 'Lahore office'],
  ['my sister Ayesha', 'sister Ayesha'],
]) {
  const r = hear({ slot: 'x', value: known, text: `The user: ${known}.` }, { slot: 'x', value: heard, text: `The user: ${heard}.` });
  check(`"${known}" ~ "${heard}"`, r.action === 'reinforced' && r.all.length === 1 && r.all[0].evidence === 2 && r.all[0].history.length === 0 && r.all[0].value === known, `${r.action}, value ${r.all[0] && r.all[0].value}`);
}

console.log('\nA different meaning: still a different value (stated -> replaced, with history)');
for (const [known, heard] of [
  ['Lahore', 'Karachi'],
  ['likes coffee', 'no coffee'],
  ['coffee', 'no coffee'],
  ['2 cats', '3 cats'],
  ['dog named Sheru', 'dog named Moti'],
  ['short bullet points', 'long bullet points'],
  ['Lahore', 'Lahore to Karachi'],
  ['Islamabad', 'near F-9 Park, Islamabad'],
]) {
  const r = hear({ slot: 'x', value: known, text: `The user: ${known}.` }, { slot: 'x', value: heard, text: `The user: ${heard}.` });
  check(`"${known}" vs "${heard}"`, r.action === 'replaced' && r.all[0].history.length === 1 && r.all[0].value === heard, r.action);
}

console.log('\nA confirmed memory contradicted in passing: reworded challengers count as the same challenger');
{
  BR.configure({ file: path.join(tmp, `b${k++}.db`), now: () => NOW });
  BR.observe({ kind: 'fact', slot: 'pet', value: 'a cat named Biscuit', text: 'The user has a cat named Biscuit.', certainty: 'stated' }, { product: 'test' });
  const a = BR.observe({ kind: 'fact', slot: 'pet', value: 'a dog named Moti', text: 'The user has a dog named Moti.', certainty: 'implied' }, { product: 'context' });
  const b = BR.observe({ kind: 'fact', slot: 'pet', value: 'dog named Moti', text: 'The user has a dog named Moti.', certainty: 'implied' }, { product: 'context' });
  check('first remark challenges, a reworded second one counts as the same challenger', a.action === 'challenged' && (b.action === 'replaced' || (b.memory.challenger && b.memory.challenger.count === 2)), `${a.action} / ${b.action}`);
  BR.close();
}

console.log('\nAudit: the change log says what happened');
{
  const file = path.join(tmp, `b${k++}.db`);
  BR.configure({ file, now: () => NOW });
  BR.observe({ kind: 'fact', slot: 'pet', value: 'a dog named Sheru', text: 'The user has a dog named Sheru.', certainty: 'implied' }, { product: 'test' });
  BR.observe({ kind: 'fact', slot: 'pet', value: 'dog named Sheru', text: 'The user has a dog named Sheru.', certainty: 'implied' }, { product: 'context' });
  const m = BR.list({})[0];
  check('a tentative memory seen again in other words is confirmed (evidence 2), value kept as first written', m.status === 'confirmed' && m.evidence === 2 && m.value === 'a dog named Sheru');
  BR.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exitCode = failures ? 1 : 0;
