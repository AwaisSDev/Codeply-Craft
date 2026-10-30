// Does the brain put the right memories in front of the agent? Seeds a brain
// with one synthetic person's memories (about 120: preferences, facts,
// people, routines, to-dos, and decisions across six projects), then asks
// the questions agents get and checks what brain.contextBlock() (every agent
// turn) and the recall tool return.
//
//   node ml/eval/retrieval.mjs   → ml/results/retrieval.json
//   node ml/eval/retrieval.mjs --embed ~/models/bge-small-en-v1.5-q8_0.gguf --pooling cls --name bge-small
//       the same queries with meaning-based scores (context-retrieval.js) added
//       to the brain's ranking → ml/results/retrieval-<name>.json
//
// For each query, "relevant" is every memory of the facet it is about.
//   block precision   relevant lines in the block / memory lines in the block
//   block recall      relevant memories in the block / relevant memories
//   recall@10         the recall tool: relevant in its first 10 hits / relevant (capped at 10)
//   tokens            size of the block (what every turn pays for)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);
const BR = require(path.join(ROOT, 'codeply-cli/lib/brain.js'));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const EMBED = opt('embed', '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-retrieval-'));
let NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
BR.configure({ file: path.join(tmp, 'brain.db'), now: () => NOW });

const facets = {};
function add(facet, o) {
  NOW -= 3600000; // older memories first
  const r = BR.observe({ certainty: 'stated', ...o }, { product: 'eval' });
  if (r.memory) (facets[facet] = facets[facet] || []).push(r.memory.id);
}

// The person.
const PROJECTS = {
  'pantry-pal': [['database', 'Supabase'], ['auth', 'magic links'], ['hosting', 'Vercel'], ['payments', 'Stripe'], ['frontend framework', 'Next.js'], ['launch city', 'Lahore']],
  LedgerLite: [['database', 'Postgres'], ['pricing', 'free up to 50 invoices then 9 dollars'], ['backend language', 'Go'], ['hosting', 'Fly.io'], ['release date', 'December 1st']],
  'tutor-match': [['frontend framework', 'Flutter'], ['database', 'Firebase'], ['payments', 'JazzCash'], ['auth', 'SMS login']],
  'clinic-booking': [['database', 'MySQL'], ['styling', 'Tailwind'], ['hosting', 'a VPS on Hetzner'], ['backend language', 'PHP']],
  'farm-ledger': [['frontend framework', 'React Native'], ['database', 'SQLite'], ['requirement', 'must work offline']],
  'event-hub': [['frontend framework', 'SvelteKit'], ['hosting', 'Cloudflare Pages'], ['payments', 'Paddle']],
};
for (const [p, ds] of Object.entries(PROJECTS)) {
  BR.touchProject({ name: p });
  for (const [slot, v] of ds) add(`project:${p}`, { kind: slot === 'requirement' ? 'requirement' : 'decision', slot, value: v, text: `The ${p} project uses ${v} for ${slot}.`, project: p });
  add(`project:${p}`, { kind: 'idea', slot: 'idea', value: `an idea for ${p}`, text: `An idea for ${p}: add a referral program.`, project: p });
}
const writing = [['writing tone', 'friendly but brief'], ['emojis in emails', 'none'], ['email sign-off', 'Best, Awais'], ['language for replies', 'English'], ['client emails', 'always CC Hassan']];
for (const [slot, v] of writing) add('writing', { kind: 'preference', slot, value: v, text: `For emails, the user wants ${slot}: ${v}.` });
const coding = [['code editor', 'VS Code'], ['package manager', 'pnpm'], ['indentation', 'two spaces'], ['testing framework', 'Vitest'], ['editor theme', 'dark mode'], ['commit style', 'conventional commits'], ['code comments', 'only when needed']];
for (const [slot, v] of coding) add('coding', { kind: 'preference', slot, value: v, text: `When coding, the user prefers ${v} for ${slot}.` });
const schedule = [['meeting time', 'no meetings before 11am'], ['friday schedule', 'nothing after 12:30 on Fridays'], ['working hours', '10am to 7pm']];
for (const [slot, v] of schedule) add('schedule', { kind: 'preference', slot, value: v, text: `For scheduling, ${v}.` });
for (const [slot, v] of [['gym', 'goes to the gym at 7am'], ['jummah', 'leaves early on Fridays for Jummah'], ['family call', 'calls their parents on Sundays']]) add('schedule', { kind: 'routine', slot, value: v, text: `The user ${v}.` });
const PEOPLE = { Inaya: ['daughter', ['is 7 years old', 'loves dinosaurs', 'is allergic to peanuts']], Hassan: ['business partner', ['handles the accounts', 'prefers WhatsApp', 'lives in Karachi']], Zoya: ['cofounder', ['does all the design', 'is vegetarian']], Ammi: ['mother', ['has a birthday on 12 December', 'likes gardening']] };
for (const [n, [rel, fs2]] of Object.entries(PEOPLE)) for (const f of fs2) add(`person:${n}`, { kind: 'fact', slot: `${n.toLowerCase()} ${f.split(' ').slice(-1)[0]}`, value: f, text: `${n}, the user's ${rel}, ${f}.` });
for (const [slot, v] of [['drink', 'black coffee'], ['favorite food', 'nihari'], ['diet', 'halal only'], ['travel seat', 'aisle seat'], ['music while working', 'lo-fi']]) add('lifestyle', { kind: 'preference', slot, value: v, text: `The user prefers ${v} for ${slot}.` });
for (const [slot, v] of [['occupation', 'founder of a small software studio'], ['home city', 'Lahore'], ['languages', 'Urdu, English and Punjabi']]) add('about', { kind: 'fact', slot, value: v, text: `The user's ${slot}: ${v}.` });
NOW = Date.UTC(2026, 9, 30, 9, 0, 0);

const QUERIES = [
  ['project:pantry-pal', 'add a payments page to pantry-pal', { cwd: '/home/u/code/pantry-pal' }],
  ['project:pantry-pal', 'what auth did we pick for pantry pal?', {}],
  ['project:LedgerLite', 'set up the database migrations', { cwd: '/home/u/code/LedgerLite' }],
  ['project:LedgerLite', 'when is the ledgerlite release and how much does it cost', {}],
  ['project:tutor-match', 'fix the login flow', { cwd: '/home/u/work/tutor-match' }],
  ['project:clinic-booking', 'deploy the clinic booking site', {}],
  ['project:farm-ledger', 'the app crashes when there is no internet', { cwd: '/home/u/code/farm-ledger' }],
  ['project:event-hub', 'add a checkout to event hub', {}],
  ['writing', 'draft an email to the client about the delay', {}],
  ['writing', 'write a reply to Sana thanking her for the intro', {}],
  ['coding', 'set up a new typescript library with tests', { cwd: '/tmp/scratch-lib' }],
  ['coding', 'create a repo for my new side project', {}],
  ['schedule', 'find a slot for a 1 hour call with the investor next week', {}],
  ['schedule', 'book a meeting with the team on friday', {}],
  ['person:Inaya', 'ideas for Inaya\'s birthday party', {}],
  ['person:Inaya', 'what snacks should I pack for my daughter\'s school trip', {}],
  ['person:Hassan', 'send Hassan the invoice totals for October', {}],
  ['person:Zoya', 'ask Zoya for the new logo files', {}],
  ['person:Ammi', 'gift ideas for my mother', {}],
  ['lifestyle', 'order lunch for me', {}],
  ['lifestyle', 'book my flight to Dubai', {}],
  ['about', 'write a short bio for my LinkedIn', {}],
];

const memLines = (block) => block.split('\n').filter((l) => /^- /.test(l));
let retriever = null; let runtime = null;
if (EMBED) {
  const RT = require(path.join(ROOT, 'codeply-cli/lib/local-runtime.js'));
  const CR = require(path.join(ROOT, 'codeply-cli/lib/context-retrieval.js'));
  runtime = RT.createRuntime({ model: { id: path.basename(EMBED), path: EMBED, ctx: 2048 }, idleMs: 0, args: ['--embedding', '--pooling', opt('pooling', 'mean'), '-b', '2048', '-ub', '2048'] });
  retriever = CR.createRetriever({ brain: BR, model: path.basename(EMBED), embed: CR.llamaEmbedder({ ensure: runtime.ensure }), prefix: { query: opt('prefix-query', ''), doc: opt('prefix-doc', '') }, maxNewPerCall: 500, store: CR.vectorStore({ memory: true }) });
}
const rows = [];
const embedMs = [];
for (const [facet, request, o] of QUERIES) {
  const relevant = facets[facet] || [];
  const relMem = relevant.map((id) => BR.get(id));
  let semantic = null;
  if (retriever) { const t = Date.now(); semantic = await retriever.scores(request); embedMs.push(Date.now() - t); }
  const block = BR.contextBlock({ request, ...o, native: true, semantic });
  const lines = memLines(block);
  const inBlock = relMem.filter((m) => lines.some((l) => l.includes(m.text)));
  // recall@10: the recall tool, or with a retriever the 10 closest memories in meaning
  const top = semantic ? [...semantic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id) : null;
  const hits = top ? top : BR.recallTool({ query: request }).output.split('\n').filter((l) => /^- \[/.test(l)).slice(0, 10);
  const recallHits = relMem.filter((m) => hits.some((h) => h.includes(m.id)));
  rows.push({
    facet, request, relevant: relevant.length, blockLines: lines.length,
    blockPrecision: lines.length ? inBlock.length / lines.length : 0,
    blockRecall: relevant.length ? inBlock.length / relevant.length : 0,
    recallAt10: relevant.length ? recallHits.length / Math.min(10, relevant.length) : 0,
    tokens: Math.ceil(block.length / 3.6),
  });
}
const mean = (k, rs = rows) => Math.round((rs.reduce((s, r) => s + r[k], 0) / Math.max(1, rs.length)) * 1000) / 1000;
const kinds = [...new Set(rows.map((r) => r.facet.split(':')[0]))];
const result = {
  retrieval: EMBED ? `words + meaning (${path.basename(EMBED)})` : 'words (brain as shipped)', embedMsMean: embedMs.length ? Math.round(embedMs.reduce((a, b) => a + b, 0) / embedMs.length) : null,
  memories: Object.values(facets).flat().length, queries: rows.length,
  blockPrecision: mean('blockPrecision'), blockRecall: mean('blockRecall'), recallAt10: mean('recallAt10'), tokensMean: mean('tokens'),
  byFacetKind: Object.fromEntries(kinds.map((k) => { const rs = rows.filter((r) => r.facet.split(':')[0] === k); return [k, { n: rs.length, blockPrecision: mean('blockPrecision', rs), blockRecall: mean('blockRecall', rs), recallAt10: mean('recallAt10', rs) }]; })),
  rows: rows.map((r) => ({ ...r, blockPrecision: Math.round(r.blockPrecision * 100) / 100, blockRecall: Math.round(r.blockRecall * 100) / 100, recallAt10: Math.round(r.recallAt10 * 100) / 100 })),
};
fs.mkdirSync(path.join(ROOT, 'ml/results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'ml/results', EMBED ? `retrieval-${opt('name', path.basename(EMBED, '.gguf'))}.json` : 'retrieval.json'), `${JSON.stringify(result, null, 2)}\n`);
const { rows: _r, ...head } = result;
console.log(JSON.stringify(head, null, 1));
for (const r of rows) console.log(`${r.facet.padEnd(24)} P ${r.blockPrecision.toFixed(2)} R ${r.blockRecall.toFixed(2)} r@10 ${r.recallAt10.toFixed(2)}  ${r.request}`);
if (runtime) runtime.stop();
fs.rmSync(tmp, { recursive: true, force: true });
