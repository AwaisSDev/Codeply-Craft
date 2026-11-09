// Tests for the Iris provider, with a stubbed model server (no model needed):
//   node research/iris/integration/iris-provider.test.mjs
// With a live llama-server serving the Iris GGUF:
//   IRIS_URL=http://127.0.0.1:8080/v1 node research/iris/integration/iris-provider.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createIrisProvider, buildPrompt, parseAndGuard } = require('./iris-provider.js');

const events = [{ id: 'e1', source: 'texts', at: Date.UTC(2026, 1, 17, 13, 5) / 1000, trust: 'mixed',
  text: 'Zainab: Hira! meetup ka kya scene hai? 6 ko hi hai na\nUser: nahi yaar postpone ho gaya, ab 20 March ko hai. organisers ne kal email ki\nZainab: haan pakka, meri flight 19 ki raat ki hai' }];
const known = [{ id: 'mem_81', kind: 'fact', slot: 'date', value: '6 March 2026', entity: 'Dubai design meetup', when: '2026-03-06' },
  { id: 'mem_12', kind: 'fact', slot: 'employer', value: 'Finlo' }];
const modelAnswer = JSON.stringify({ ops: [
  { src: 2, evid: 'postpone ho gaya, ab 20 March ko hai', op: 'update', ref: 'm1', ent: 'Dubai design meetup', attr: 'date', val: '20 March 2026', kind: 'event', when: '2026-03-20', keep: 'long', why: 'changed', basis: 'stated', conf: 'high', sens: 'none' },
  { src: 3, evid: 'meri flight 19 ki raat ki hai', op: 'add', ent: 'Zainab', type: 'person', attr: 'dubai flight', val: 'night of 19 March 2026', kind: 'event', when: '2026-03-19', keep: 'long', basis: 'stated', conf: 'high', sens: 'none' },
  { src: 2, evid: 'the user loves postponements', op: 'add', ent: 'user', type: 'user', attr: 'likes', val: 'postponements', kind: 'preference', keep: 'long', basis: 'stated', conf: 'high', sens: 'none' },
  { src: 1, evid: 'meetup ka kya scene hai', op: 'confirm', ref: 'm9' },
] });
const stub = async (url, init) => {
  if (url.endsWith('/models')) return { ok: true };
  const body = JSON.parse(init.body);
  assert.equal(body.temperature, 0);
  assert.match(body.messages[1].content, /^TASK: observe\nNOW: 2026-02-17T13:05 Tue\nSOURCE: personal_chat\nMEMORIES:\nm1 \| Dubai design meetup \| date \| 6 March 2026 \| when 2026-03-06\nm2 \| user \| employer \| Finlo\nINPUT:\n\[1\] Zainab: /);
  return { ok: true, json: async () => ({ model: 'iris-1', choices: [{ message: { content: modelAnswer } }], usage: { completion_tokens: 120 } }) };
};

const p = buildPrompt({ events, known, tz: 'UTC' });
assert.equal(p.messages.length, 3);
assert.equal(p.messages[1].who, 'user');

const iris = createIrisProvider({ baseUrl: 'http://127.0.0.1:8080/v1', fetch: stub });
assert.equal(await iris.available(), true);
const r = await iris.extract({ events, known, tz: 'UTC' });
const { iris: x, observations, plans } = r.answer;
assert.equal(x.ops.length, 2, 'two ops pass the guard');
assert.deepEqual(x.rejected.map((j) => j.reason), ['ungrounded_evidence', 'unknown_ref'], 'invented evidence and unknown targets are refused');
assert.equal(x.ops[0].action, 'replace');
assert.equal(x.ops[0].target, 'mem_81', 'the alias maps back to the Brain id');
assert.equal(x.ops[1].action, 'insert');
assert.equal(plans.length, 2);
assert.equal(plans[0].when, '2026-03-20');
assert.equal(observations.length, 0, 'dated events are plans in production, not observations');

// malformed output keeps nothing
const bad = parseAndGuard('{"ops": [', p.messages, p.rows, p.source);
assert.equal(bad.valid, false); assert.equal(bad.ops.length, 0);
// a remote URL is refused under the local label
await assert.rejects(() => createIrisProvider({ baseUrl: 'https://example.com/v1', fetch: stub }).extract({ events, known }), /on this PC/);
// secrets never pass
const sec = parseAndGuard(JSON.stringify({ ops: [{ src: 2, evid: 'postpone ho gaya', op: 'add', ent: 'user', type: 'user', attr: 'wifi password', val: 'Tulip#9921x', kind: 'fact', keep: 'long', basis: 'stated', conf: 'high', sens: 'none' }] }), p.messages, p.rows, p.source);
assert.equal(sec.rejected[0].reason, 'secret');
console.log('iris-provider: stub tests passed');

if (process.env.IRIS_URL) {
  const live = createIrisProvider({ baseUrl: process.env.IRIS_URL });
  const out = await live.extract({ events, known, tz: 'UTC' });
  console.log('live:', JSON.stringify(out.answer.iris, null, 1), `${out.ms} ms`);
  assert.equal(out.answer.iris.valid, true, 'live model returns schema-valid JSON');
}
