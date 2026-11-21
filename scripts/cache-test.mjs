// How much of each model request a prompt cache can serve (npm run test:cache).
// Drives the real runAgent loop on the user's own key (a custom route, where
// the cache layout matters most) against a scripted fake model, captures every
// request body, and measures the byte-identical prefix each request shares with
// the request before it: that prefix is what Anthropic, OpenAI, OpenRouter,
// DeepSeek and a local model's KV cache can reuse. Also checks the Anthropic
// breakpoints, the history window across many turns, and that Wisp's cached
// prompt does not change when a specialist finishes a job.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'codeply-cli');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-cache-'));
process.env.CODEPLY_BRAIN_DB = path.join(scratch, 'brain.db');
process.env.CODEPLY_WISP_DIR = path.join(scratch, 'wisp');
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
const require = createRequire(import.meta.url);
const agentMod = await import(pathToFileURL(path.join(CLI, 'lib/agent.mjs')).href);
const history = require(path.join(CLI, 'lib/history.js'));
const ai = require(path.join(CLI, 'lib/ai.js'));
const wisp = require(path.join(CLI, 'lib/wisp.js'));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + String(extra).slice(0, 400)}`);
  if (!cond) failures++;
}
const pct = (x) => `${(100 * x).toFixed(1)}%`;

// ── The fake model: scripted replies, every request body kept ──
let script = [];
const bodies = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    bodies.push(JSON.parse(raw || '{}'));
    const next = script.shift() ?? 'Done.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of String(next).match(/[\s\S]{1,200}/g) || ['']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const route = { custom: { id: 'k', name: 'Own key', kind: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fake', apiKey: 'x', toolMode: 'text' } };

/** What a prefix cache could serve of request b, given request a just before it (in characters). */
function shared(a, b) {
  const x = JSON.stringify({ tools: a.tools || null, messages: a.messages });
  const y = JSON.stringify({ tools: b.tools || null, messages: b.messages });
  let i = 0;
  const n = Math.min(x.length, y.length);
  while (i < n && x.charCodeAt(i) === y.charCodeAt(i)) i++;
  return { prefix: i, total: y.length };
}
/** Share of all input characters (after the very first request) a prefix cache could serve. */
// share: of everything sent after the first request, how much was a cached prefix
//   (the rest is new: a fresh file read can never come from a cache).
// reuse: of what the previous request already sent, how much came back as a
//   cached prefix. This is the part the harness controls; 100% is perfect.
function served(list) {
  let p = 0; let t = 0; let prev = 0; let breaks = 0;
  for (let i = 1; i < list.length; i++) {
    const s = shared(list[i - 1], list[i]);
    const before = JSON.stringify({ tools: list[i - 1].tools || null, messages: list[i - 1].messages }).length;
    p += s.prefix; t += s.total; prev += before;
    if (s.prefix / before < 0.5) breaks++;
  }
  return { share: t ? p / t : 1, reuse: prev ? p / prev : 1, breaks };
}

const read = (f) => `<codeply:read_file>\n<path>${f}</path>\n</codeply:read_file>`;
async function turn(cwd, userMessage, replies, hist = []) {
  script = [...replies];
  const start = bodies.length;
  const events = [];
  for await (const ev of agentMod.runAgent({ userMessage, history: hist, mode: 'Build', cwd, approve: async () => 'once', signal: new AbortController().signal, route, maxSteps: 30 })) events.push(ev);
  return { requests: bodies.slice(start), events, final: events.filter((e) => e.type === 'text' && !e.interim).map((e) => e.text).join('\n') };
}

// 1. An everyday turn, then a follow-up: read, edit, check, re-read, answer.
let everyday;
{
  const cwd = fs.mkdtempSync(path.join(scratch, 'proj-'));
  const body = (name) => Array.from({ length: 220 }, (_, i) => `export function ${name}${i}(x) { return x * ${i} + 1; } // keep`).join('\n') + '\n';
  for (const f of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(cwd, f), body(f[0]));
  const t1 = await turn(cwd, 'Make a0 in a.js return x + 2, then check it.', [
    read('a.js'), read('b.js'),
    '<codeply:edit_file>\n<path>a.js</path>\n<search>export function a0(x) { return x * 0 + 1; }</search>\n<replace>export function a0(x) { return x + 2; }</replace>\n</codeply:edit_file>',
    '<codeply:run>\n<command>node --check a.js</command>\n</codeply:run>',
    read('a.js'),
    'Done: a0 in a.js now returns x + 2, and node --check a.js passes.',
  ]);
  const session = { messages: [{ kind: 'user', text: 'Make a0 in a.js return x + 2, then check it.' }, { kind: 'tool', name: 'edit_file', label: 'a.js', ok: true }, { kind: 'assistant', text: t1.final }] };
  const t2 = await turn(cwd, 'Now write jest tests for the react component in c.js and set up the docker deployment.', [read('c.js'), 'c.js has 220 small functions; nothing to change.'], history.buildHistory(session));
  if (process.env.CACHE_DEBUG) for (let i = 1; i < t1.requests.length; i++) {
    const a = t1.requests[i - 1].messages; const b = t1.requests[i].messages;
    let k = 0; while (k < a.length && JSON.stringify(a[k]) === JSON.stringify(b[k])) k++;
    const am = JSON.stringify(a[k] || null); const bm = JSON.stringify(b[k] || null);
    let c = 0; while (c < am.length && am[c] === bm[c]) c++;
    console.log(`step ${i}: diverges at message ${k}/${a.length} (${a[k] && a[k].role}), char ${c}: old=${am.slice(c, c + 160)} || new=${bm.slice(c, c + 160)}`);
  }
  const within = served([...t1.requests]);
  const across = shared(t1.requests[t1.requests.length - 1], t2.requests[0]);
  const all = served([...t1.requests, ...t2.requests]);
  everyday = within.reuse; void all;
  // Between turns the last turn's tool output is dropped on purpose (the history keeps a short record), so that pair is scored on its own.
  console.log(`      everyday turn: ${t1.requests.length} requests; ${pct(within.reuse)} of what was already sent is reused from cache; ${pct(within.share)} of all input (the rest is new file reads); next turn's first request ${pct(across.prefix / across.total)} cached`);
  check('everyday: 99%+ of what was already sent comes back from the cache', within.reuse >= 0.99, pct(within.reuse));
  check('everyday: no step rewrites the transcript (no cache break)', within.breaks === 0, within.breaks);
  check('everyday: a new turn keeps the system prompt and the history cached', across.prefix / across.total >= 0.85, pct(across.prefix / across.total));
  const sys = t1.requests[0].messages.filter((m) => m.role === 'system');
  check('layout: one system message on a provider that wants one, the tool reference first', sys.length === 1 && /TOOL|tool/.test(sys[0].content.slice(0, 4000)) && !/PROJECT CONTEXT/.test(sys[0].content), sys.map((m) => m.content.slice(0, 80)).join(' | '));
  check('layout: the turn\'s context rides on the user message', /<turn-context>[\s\S]*PROJECT CONTEXT/.test(JSON.stringify(t1.requests[0].messages[1].content)));
}

// 2. A long turn that outgrows the context budget: old output is trimmed in one go, not every step.
{
  const cwd = fs.mkdtempSync(path.join(scratch, 'big-'));
  const files = Array.from({ length: 14 }, (_, i) => `big${i}.txt`);
  for (const f of files) fs.writeFileSync(path.join(cwd, f), Array.from({ length: 400 }, (_, i) => `${f} line ${i}: ${'lorem ipsum dolor sit amet '.repeat(2)}`).join('\n'));
  const t = await turn(cwd, 'Read every big file and tell me how many lines each has.', [...files.map(read), 'Each file has 400 lines.']);
  const r = served(t.requests);
  const dropped = t.requests.some((b) => JSON.stringify(b.messages).includes('older tool output dropped'));
  console.log(`      long turn: ${t.requests.length} requests, trimmed: ${dropped}, cache breaks: ${r.breaks}, ${pct(r.reuse)} reused, ${pct(r.share)} of all input`);
  check('long turn: the budget was really exceeded and trimmed', dropped);
  check('long turn: at most two cache breaks from trimming', r.breaks <= 2, r.breaks);
  check('long turn: 90%+ of what was already sent is still reused', r.reuse >= 0.9, pct(r.reuse));
}

// 3. A long chat: the history window moves in steps, not every turn.
{
  const mk = (n) => ({ messages: Array.from({ length: n }, (_, i) => [{ kind: 'user', text: `question ${i} `.repeat(20) }, { kind: 'assistant', text: `answer ${i} `.repeat(40) }]).flat() });
  // What turn n sent (its history), against what turn n+1 sends.
  const list = [];
  for (let n = 10; n <= 60; n++) list.push({ messages: history.buildHistory(mk(n)) });
  const r = served(list);
  console.log(`      long chat (50 turns): ${pct(r.reuse)} of the history reused turn to turn, ${r.breaks} window moves`);
  check('long chat: the window moves at most once every 10 turns', r.breaks <= 5, r.breaks);
  check('long chat: 85%+ of the history is reused from one turn to the next', r.reuse >= 0.85, pct(r.reuse));
}

// 4. Anthropic breakpoints.
{
  const turns = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text: `a${i}` }] : `u${i}` }));
  const L = ai.anthropicCacheLayout(['C'.repeat(30000), 'P'.repeat(3000)], turns.map((t) => ({ ...t })));
  const marks = [...L.system, ...L.turns.flatMap((t) => (Array.isArray(t.content) ? t.content : []))].filter((b) => b.cache_control);
  check('anthropic: core and project each get a 1-hour breakpoint', L.system.every((b) => b.cache_control && b.cache_control.ttl === '1h'));
  check('anthropic: the newest message always gets one, however short', JSON.stringify(L.turns[L.turns.length - 1].content).includes('cache_control'));
  check('anthropic: never more than 4 breakpoints, longer TTL first', marks.length <= 4 && marks.findIndex((b) => !b.cache_control.ttl) >= 2);
  const many = ai.anthropicCacheLayout(['A'.repeat(9000), 'B'.repeat(9000), 'C'.repeat(9000), 'D'], [{ role: 'user', content: 'hi' }]);
  check('anthropic: extra system messages never push it past 4', [...many.system, ...many.turns.flatMap((t) => (Array.isArray(t.content) ? t.content : []))].filter((b) => b.cache_control).length <= 4);
  const json = ai.anthropicCacheLayout(['C'.repeat(9000)], [{ role: 'user', content: 'x' }], { json: true });
  check('anthropic: the JSON instruction sits after the cached system block', json.system.length === 2 && json.system[0].cache_control && !json.system[1].cache_control);
  const or = ai.cacheShapedMessages([{ role: 'system', content: 'core' }, { role: 'system', content: 'proj' }, { role: 'user', content: 'hi' }], 'https://openrouter.ai/api/v1/chat/completions', 'anthropic/claude-sonnet-5-5');
  check('openrouter claude: markers on both system blocks and the newest message', or[0].content.length === 2 && or[0].content.every((b) => b.cache_control) && or[1].content[0].cache_control);
}

// 5. Wisp's cached prompt holds still while the team works.
{
  const before = wisp.wispPrompt({ native: true });
  wisp.noteRun('frontend', { ok: true, task: 'Fix the header' });
  wisp.noteRun('frontend', { ok: true, task: 'Fix the footer' });
  check('wisp: a finished specialist job does not change the lead\'s cached prompt', wisp.wispPrompt({ native: true }) === before);
  const spec = wisp.findSpecialist('frontend');
  check('wisp: a specialist\'s prompt is the same before and after its jobs (its record goes with the task)', !/YOUR LAST JOBS/.test(wisp.specialistPrompt(spec)) && /YOUR LAST JOBS[\s\S]*Fix the footer/.test(wisp.trackRecord(spec)));
}

server.close();
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
console.log(failures ? `\n${failures} FAILED` : `\nAll passed (everyday turns: ${pct(everyday)} of what was already sent reused from cache)`);
process.exit(failures ? 1 : 0);
