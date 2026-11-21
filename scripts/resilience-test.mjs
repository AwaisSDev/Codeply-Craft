// Background resilience (node scripts/resilience-test.mjs).
// Drives the real runAgent loop against a scripted fake model: outages are
// waited out, a fallback model takes over, a spent allowance parks the run and
// a resume finishes it, the step limit continues, and Stop ends a wait at once.
// Waits are scaled down (CODEPLY_RETRY_SCALE and retryScheduleMs) so it runs in seconds.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'codeply-cli');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-resil-'));
process.env.CODEPLY_BRAIN_DB = path.join(scratch, 'brain.db');
process.env.CODEPLY_WISP_DIR = path.join(scratch, 'wisp');
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.CODEPLY_RETRY_SCALE = '0.001';
process.env.CODEPLY_TRACK_KEY = 'test-key';
const agentMod = await import(pathToFileURL(path.join(CLI, 'lib/agent.mjs')).href);

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + String(extra).slice(0, 600)}`);
  if (!cond) failures++;
}

// ── The fake model (HTTP, for the user's own model) ──
let script = [];
let bodies = [];
let outage = 0; // answer 503 this many times before working
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    bodies.push({ url: req.url, body });
    if (req.url.startsWith('/down') || outage > 0) {
      if (outage > 0) outage--;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end('{"error":"unavailable"}');
    }
    const next = script.shift() ?? 'All done.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of String(next).match(/[\s\S]{1,40}/g) || ['']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const model = (p = 'v1') => ({ id: p, name: `Fake ${p}`, kind: 'openai', baseUrl: `http://127.0.0.1:${port}/${p}`, model: 'fake', apiKey: 'x', toolMode: 'text' });
const route = { custom: model('v1') };

// ── The fake hosted router (fetch hook), for limits ──
const realFetch = globalThis.fetch;
let routerScript = []; // each: a string reply, or { limited, resetsAt }
let routerCalls = [];
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('/functions/v1/auto')) return realFetch(url, init);
  routerCalls.push(JSON.parse(init.body));
  const next = routerScript.shift() ?? 'All done.';
  const body = typeof next === 'object' ? { success: false, limited: true, resetsAt: next.resetsAt, error: 'You have reached the limit for now.' }
    : { success: true, data: { choices: [{ message: { role: 'assistant', content: next } }] }, modelUsed: 'fake' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const write = (name, text) => `<codeply:write_file>\n<path>${name}</path>\n<content>\n${text}\n</content>\n</codeply:write_file>`;
function project() { return fs.mkdtempSync(path.join(scratch, 'proj-')); }
async function run(opts, { abortAfter } = {}) {
  const controller = new AbortController();
  if (abortAfter) setTimeout(() => controller.abort(), abortAfter);
  const events = [];
  const started = Date.now();
  for await (const ev of agentMod.runAgent({
    userMessage: 'Write the files a.txt and b.txt.', history: [], mode: 'Build', cwd: opts.cwd || project(),
    approve: async () => 'once', signal: controller.signal, route, maxSteps: 12, ...opts,
  })) events.push(ev);
  return { events, ms: Date.now() - started, of: (t) => events.filter((e) => e.type === t), health: (s) => events.filter((e) => e.type === 'health' && e.state === s) };
}
const fastSchedule = [10, 10, 10, 10, 10, 10];

// 1. Model down for "several minutes" (10 failed requests: three rounds), then back.
{
  outage = 10;
  script = [write('a.txt', 'one'), 'All done.'];
  bodies = [];
  const r = await run({ background: true, retryScheduleMs: fastSchedule, fallbacks: [] });
  check('outage: background run finishes after the model comes back', r.of('done').length === 1 && !r.of('error').length, JSON.stringify(r.events.filter((e) => e.type === 'error')));
  const h = r.health('retrying');
  check('outage: health retrying events carry attempt, reason and until', h.length >= 2 && h[0].attempt === 1 && h[1].attempt === 2 && /not answering/.test(h[0].reason) && !Number.isNaN(Date.parse(h[0].until)), JSON.stringify(h));
  check('outage: the work was done', r.of('tool_end').some((e) => e.name === 'write_file' && e.ok));
  check('outage: no em dash in user-facing health text', !h.some((e) => /—/.test(e.reason)));
}

// 2. Interactive run with the same outage still fails fast and says nothing about waiting.
{
  outage = 1000;
  bodies = [];
  const r = await run({ retryScheduleMs: fastSchedule });
  check('interactive: the outage is an error as before', r.of('error').length === 1 && !r.of('done').length);
  check('interactive: no health events', !r.events.some((e) => e.type === 'health'));
  check('interactive: only the quick retries were made', bodies.length === 4, `requests: ${bodies.length}`);
  outage = 0;
}

// 3. Limit with a reset time: parked with until + ledger, then resume finishes without repeating.
{
  const resetsAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  routerScript = [write('a.txt', 'one'), { limited: true, resetsAt }];
  routerCalls = [];
  const cwd = project();
  const r = await run({ background: true, route: { auto: true }, cwd });
  const parked = r.of('parked')[0];
  check('park: ends with parked, not error', !!parked && !r.of('error').length && !r.of('done').length, JSON.stringify(r.events.map((e) => e.type)));
  check('park: health parked carries the reset time', r.health('parked').length === 1 && r.health('parked')[0].until === resetsAt && !!r.health('parked')[0].reason);
  check('park: parked event has until and a ledger with the work done', parked && parked.until === resetsAt && parked.ledger.files.includes('a.txt') && parked.ledger.actions.length === 1 && /a\.txt/.test(parked.ledger.goal), JSON.stringify(parked && parked.ledger));
  const before = fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8');
  routerScript = [write('b.txt', 'two'), 'Both files are written.'];
  routerCalls = [];
  const r2 = await run({ background: true, route: { auto: true }, cwd, resume: parked.ledger });
  const asked = JSON.stringify(routerCalls[0] ? routerCalls[0].messages : '');
  check('resume: finishes', r2.of('done').length === 1 && !r2.of('error').length);
  check('resume: the model was told what is done and not to redo it', /Do not redo/.test(asked) && /a\.txt/.test(asked));
  check('resume: a.txt was not written again, b.txt was', fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8') === before && fs.existsSync(path.join(cwd, 'b.txt')) && r2.of('tool_end').filter((e) => e.name === 'write_file').length === 1);
  routerScript = [{ limited: true, resetsAt }];
  const r3 = await run({ route: { auto: true } });
  check('interactive: a limit is still the old error with limited: true', r3.of('error')[0]?.limited === true && !r3.of('parked').length);
}

// 4. Step limit: continued, finishes in part 2.
{
  script = [write('a.txt', 'one'), write('b.txt', 'two'), 'Both files are written.'];
  bodies = [];
  const r = await run({ background: true, maxSteps: 2, retryScheduleMs: fastSchedule, fallbacks: [] });
  check('continue: health continued part 2', r.health('continued').length === 1 && r.health('continued')[0].part === 2);
  check('continue: finishes with done, no error, no needs_you', r.of('done').length === 1 && !r.of('error').length && !r.health('needs_you').length && !r.of('done')[0].unfinished);
  const third = bodies[2] && JSON.stringify(bodies[2].body.messages);
  check('continue: the next part got a ledger message appended', /Do not redo/.test(third || '') && /a\.txt/.test(third || ''));
  const first = bodies[0].body.messages;
  const same = bodies[2].body.messages.slice(0, first.length).every((m, i) => JSON.stringify(m) === JSON.stringify(first[i]));
  check('continue: earlier messages unchanged (cache prefix holds)', same);
}

// 5. Never finishes: summary as a normal reply plus needs_you, not an error.
{
  script = [write('a.txt', '1'), write('b.txt', '2'), write('c.txt', '3'), 'So far a, b and c are written.'];
  const r = await run({ background: true, maxSteps: 1, maxContinuations: 1, retryScheduleMs: fastSchedule, fallbacks: [] });
  check('needs_you: ends unfinished with a reply and a health flag, no error', !r.of('error').length && r.health('needs_you').length === 1 && r.of('done')[0]?.unfinished === true && r.of('text').some((e) => !e.interim && e.text.length));
  script = [write('a.txt', '1'), write('b.txt', '2'), 'Wrapped up.'];
  const r2 = await run({ maxSteps: 1 });
  check('interactive: the step limit is still an error', r2.of('error').length === 1 && /Stopped after 1 steps/.test(r2.of('error')[0].error));
}

// 6. The primary keeps failing: the fallback model finishes the run.
{
  script = ['Fixed it on the backup.'];
  bodies = [];
  const r = await run({ background: true, route: { custom: model('down') }, fallbacks: [{ custom: model('backup') }], retryScheduleMs: [5, 5] });
  const fb = r.health('fallback');
  check('fallback: health fallback names the model and why', fb.length === 1 && /Fake backup/.test(fb[0].model) && /not answering/.test(fb[0].reason), JSON.stringify(fb));
  check('fallback: the backup finished the run', r.of('done').length === 1 && bodies.some((b) => b.url.startsWith('/backup')));
  const r2 = await run({ background: true, route: { custom: model('down') }, fallbacks: [{ custom: model('down-too') }], retryScheduleMs: [5] });
  check('fallback: when nothing works the run ends in an error', r2.of('error').length === 1, JSON.stringify(r2.events.map((e) => e.type + ':' + (e.state || ''))));
}

// 7. Stop during a retry wait ends the run at once.
{
  bodies = [];
  const r = await run({ background: true, route: { custom: model('down') }, fallbacks: [{ custom: model('backup') }], retryScheduleMs: [60000, 60000] }, { abortAfter: 400 });
  check('abort: stops during the wait, in well under the wait', r.of('aborted').length === 1 && r.ms < 5000, `${r.ms} ms`);
  check('abort: no fallback tried and no new request after Stop', !r.health('fallback').length && !bodies.some((b) => b.url.startsWith('/backup')));
}

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll resilience checks passed.');
process.exit(failures ? 1 : 0);
