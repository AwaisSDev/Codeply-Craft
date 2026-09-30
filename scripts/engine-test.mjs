// Drives the real runAgent loop against a scripted fake model server (npm run test:engine).
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'codeply-cli');
const { runAgent } = await import(pathToFileURL(path.join(CLI, 'lib/agent.mjs')).href);
const { createRequire } = await import('module');
const require = createRequire(import.meta.url);
const ai = require(path.join(CLI, 'lib/ai.js'));

let script = [];         // queue of replies (strings) for the next test
let seen = [];           // last user message content the model saw per call
let bodies = [];         // full request bodies, for checking what went over the wire
function sse(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of text.match(/[\s\S]{1,40}/g) || ['']) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/chat/completions') {
      const last = body.messages[body.messages.length - 1];
      seen.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
      const next = script.shift() ?? 'All done.';
      return sse(res, next);
    }
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b', size: 1, details: { family: 'llama', parameter_size: '8B' } }] }));
    }
    if (req.url === '/api/chat') {
      if (body.options?.num_ctx !== 32768) { res.writeHead(400); return res.end('{"error":"num_ctx missing"}'); }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'O' } }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'K' }, done: true }) + '\n');
      return res.end();
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const route = { custom: { id: 't', name: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake', apiKey: 'x' } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-test-'));
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
}

async function run(replies, userMessage = 'do the thing', opts = {}) {
  script = [...replies];
  seen = [];
  const events = [];
  for await (const ev of runAgent({
    userMessage, history: [], mode: opts.mode || 'Build', cwd: tmp,
    approve: async () => 'once', signal: new AbortController().signal, route, maxSteps: opts.maxSteps || 12, verifyOnly: opts.verifyOnly,
  })) events.push(ev);
  return { events, seen, texts: events.filter((e) => e.type === 'text').map((e) => e.text), done: events.find((e) => e.type === 'done') };
}

// 1. Claims an edit with no action block → silently corrected, false claim never shown.
{
  const r = await run([
    "I've updated app.js with the fix.",
    '<codeply:write_file>\n<path>notes.md</path>\n<content>\nhello\n</content>\n</codeply:write_file>',
    'Wrote notes.md with a greeting.',
  ]);
  check('hallucinated edit is corrected', r.seen.some((s) => s.includes('no action block')));
  check('false claim never shown', !r.texts.some((t) => t.includes("I've updated app.js")), JSON.stringify(r.texts));
  check('turn finishes with real edit', r.done && r.done.writtenFiles.includes('notes.md'));
}

// 2. Edits a .js file then tries to finish → verification gate forces a check.
{
  const r = await run([
    '<codeply:write_file>\n<path>sum.js</path>\n<content>\nmodule.exports = (a, b) => a + b;\n</content>\n</codeply:write_file>',
    'Created sum.js.',
    '<codeply:run>\n<command>node --check sum.js</command>\n</codeply:run>',
    'Created sum.js and checked it with node --check (exit 0).',
  ]);
  check('verify gate fires after code edit', r.seen.some((s) => s.includes("haven't checked the result")), JSON.stringify(r.seen));
  check('verifying event emitted', r.events.some((e) => e.type === 'verifying'));
  check('premature summary hidden', !r.texts.includes('Created sum.js.'), JSON.stringify(r.texts));
  const runAction = r.done?.actions.find((a) => a.tool === 'run');
  check('run recorded with exit code 0', runAction && runAction.exitCode === 0, JSON.stringify(r.done?.actions));
  check('no unverified files at done', r.done && r.done.unverifiedFiles.length === 0);
}

// 3. Claims tests pass without running anything → corrected.
{
  const r = await run([
    'I ran the tests and all tests pass.',
    'I have not run any tests; I only looked at the code.',
  ], 'are the tests ok?', { mode: 'Ask' });
  check('unbacked "tests pass" claim is corrected', r.seen.some((s) => s.includes('no tool that could have done that')), JSON.stringify(r.seen));
  check('unbacked claim never shown', !r.texts.some((t) => /all tests pass/i.test(t)));
}

// 4. Last command failed, model claims success → pushed back.
{
  const r = await run([
    '<codeply:write_file>\n<path>bad.js</path>\n<content>\nconst = ;\n</content>\n</codeply:write_file>',
    '<codeply:run>\n<command>node --check bad.js</command>\n</codeply:run>',
    'Everything is working great.',
    'node --check bad.js still fails with a SyntaxError; I could not fix it in this step.',
  ]);
  check('failed command is not glossed over', r.seen.some((s) => s.includes('exited with code')), JSON.stringify(r.seen));
}

// 5. Claims a deploy with no deploy tool → corrected.
{
  const r = await run([
    "I've deployed the site and it is now live at https://x.vercel.app.",
    'I have not deployed anything yet.',
  ], 'deploy it', { mode: 'Ask' });
  check('unbacked deploy claim is corrected', r.seen.some((s) => s.includes('deployed, pushed or published')));
}

// 6. Plan mode cannot mutate through side doors.
{
  const r = await run([
    '<codeply:fetch_image>\n<url>https://example.com/a.png</url>\n<path>a.png</path>\n</codeply:fetch_image>',
    'I would download an image.',
  ], 'plan it', { mode: 'Plan' });
  const t = r.events.find((e) => e.type === 'tool_end');
  check('fetch_image blocked in Plan mode', t && t.ok === false);
}

// 7. Removed tools are gone.
{
  const r = await run([
    '<codeply:dispatch_agent>\n<name>Pixel</name>\n<task>x</task>\n</codeply:dispatch_agent>',
    'Doing it myself instead.',
  ]);
  const t = r.events.find((e) => e.type === 'tool_end');
  check('dispatch_agent no longer exists', t && t.ok === false);
}

// 8. Native Ollama path + model listing + URL normalization.
{
  const list = await ai.listOllamaModels(`http://127.0.0.1:${port}`);
  check('ollama model listing', list.ok && list.models[0].name === 'llama3.1:8b', JSON.stringify(list));
  const t = await ai.testModel({ kind: 'ollama', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'llama3.1:8b' });
  check('ollama native chat with num_ctx', t.ok && t.reply === 'OK', JSON.stringify(t));
  const t2 = await ai.testModel({ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake' });
  check('custom openai-compatible model test', t2.ok, JSON.stringify(t2));
  const u = ai.chatCompletionsUrl;
  check('url: /v1', u('https://api.openai.com/v1') === 'https://api.openai.com/v1/chat/completions');
  check('url: bare host', u('https://api.deepseek.com') === 'https://api.deepseek.com/v1/chat/completions');
  check('url: /openai', u('https://generativelanguage.googleapis.com/v1beta/openai/') === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  check('url: full', u('http://x/v1/chat/completions') === 'http://x/v1/chat/completions');
  const bad = await ai.testModel({ kind: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'x' });
  check('unreachable ollama gives a helpful error', !bad.ok && /Is Ollama running/.test(bad.error), bad.error);
}

// 9. The per-turn step budget is honored (/goal passes a bigger one).
{
  const reads = Array.from({ length: 10 }, (_, i) => `<codeply:list_dir>
<path>d${i}</path>
</codeply:list_dir>`);
  const r = await run(reads, 'look around', { maxSteps: 3 });
  const err = r.events.find((e) => e.type === 'error');
  check('step budget respected', err && /Stopped after 3 steps/.test(err.error), err && err.error);
}

// 10. A checking turn may describe earlier turns' changes without being blocked.
{
  const r = await run([`The header has been updated and the page works.
GOAL_STATUS: ACHIEVED`], 'check the goal', { verifyOnly: true });
  check('verification turn is not blocked for describing earlier work', r.done && r.texts.some((t) => t.includes('GOAL_STATUS: ACHIEVED')));
}

// 11. Narration next to an action is marked interim (shown as "Thinking"); the final answer is not.
{
  const r = await run([
    `I'll look at the folder first.
<codeply:list_dir>
<path>.</path>
</codeply:list_dir>`,
    'The folder is empty.',
  ], 'what is in this folder?', { mode: 'Ask' });
  const texts = r.events.filter((e) => e.type === 'text');
  check('narration marked as thinking', texts[0] && texts[0].interim === true, JSON.stringify(texts));
  check('final answer shown normally', texts.at(-1) && texts.at(-1).interim === false && texts.at(-1).text === 'The folder is empty.');
}

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
