// Pool v2: strata from screening, synthetic rewrites and the v1 pool.
//
//   node pool2.mjs --candidates ../data/wildchat-candidates.jsonl --screen ../out/screen-wildchat/screen.jsonl \
//        --v1 ../data/pool.jsonl --synthetic ../data/synthetic-synth-v1.jsonl --seed 1
// -> ../data/pool-v2.jsonl   (field `stratum`; labelling draws from it by stratum)
//    ../data/natural-v2.jsonl (unscreened random WildChat: the natural distribution, reported separately)
//
// Strata: wildchat-pos (screened: about the user / plan / temporary, not task-only),
// wildchat-neg (screened: task only), multiwoz, topical, romanurdu-uci (from v1),
// syn-ur, syn-mixed (synthetic, reported separately). Haiku's screening answers only
// decide membership of a stratum; they are not copied into the examples.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const args = process.argv.slice(2);
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const read = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const seed = opt('seed', '1');
const rank = (id, s) => crypto.createHash('sha1').update(`${seed}:${s}:${id}`).digest('hex');
const sorted = (rows, s) => rows.sort((a, b) => (rank(a.id, s) < rank(b.id, s) ? -1 : 1));
// Same rule as build.py: inputs with time words go to Opus (owner's routing).
const TEMPORAL = /\b(today|tonight|right now|at the moment|for now|currently|this week|this weekend|till|until|back by|on leave|out of office|sick|abhi|aaj|is hafte|kal tak)\b/i;
const route = (ex) => (TEMPORAL.test(ex.input.events.map((e) => e.text).join(' ')) ? 'opus-temporary' : 'sonnet');

const cands = read(opt('candidates'));
const screen = new Map(read(opt('screen')).map((r) => [r.id, r]));
const synthFrom = new Set(read(opt('synthetic')).map((r) => r.source.synthetic.fromId));
const pos = []; const neg = [];
for (const ex of cands) {
  const s = screen.get(ex.id);
  if (!s || s.error || synthFrom.has(ex.id)) continue;
  if ((s.about_user || s.plan || s.temporary) && !s.task_only) pos.push(ex);
  else if (s.task_only && !s.about_user && !s.plan && !s.temporary) neg.push(ex);
}
const v1 = read(opt('v1'));
const strata = {
  'wildchat-pos': sorted(pos, 'pos'),
  'wildchat-neg': sorted(neg, 'neg').slice(0, 4000),
  multiwoz: v1.filter((r) => r.id.startsWith('rl-multiwoz-')),
  topical: v1.filter((r) => r.id.startsWith('rl-topical-')),
  'romanurdu-uci': v1.filter((r) => r.id.startsWith('rl-romanurdu-')),
  'syn-ur': read(opt('synthetic')).filter((r) => r.stratum === 'syn-ur'),
  'syn-mixed': read(opt('synthetic')).filter((r) => r.stratum === 'syn-mixed'),
};
const pool = [];
for (const [k, rows] of Object.entries(strata)) for (const r of rows) pool.push({ ...r, stratum: k, route: route(r) });
fs.writeFileSync('../data/pool-v2.jsonl', pool.map((r) => JSON.stringify(r)).join('\n') + '\n');
// Natural distribution: unscreened random WildChat (screening not consulted).
const natural = sorted([...cands], 'natural').slice(0, 2000).map((r) => ({ ...r, stratum: 'natural', route: route(r) }));
fs.writeFileSync('../data/natural-v2.jsonl', natural.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({ ...Object.fromEntries(Object.entries(strata).map(([k, v]) => [k, v.length])), natural: natural.length, opusRoute: pool.filter((r) => r.route !== 'sonnet').length }, null, 1));
