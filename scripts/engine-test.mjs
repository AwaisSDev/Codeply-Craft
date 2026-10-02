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
      // Everything sent since the model's own last reply (a batch of results, notes).
      let from = body.messages.length - 1;
      while (from > 0 && body.messages[from - 1].role !== 'assistant' && body.messages[from - 1].role !== 'system') from--;
      seen.push(body.messages.slice(from).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
      bodies.push(body);
      const next = script.shift() ?? 'All done.';
      if (next && typeof next === 'object' && next.status) {
        res.writeHead(next.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: next.error } }));
      }
      if (next && typeof next === 'object') {
        // A native tool-call reply, streamed the way OpenAI does: id and name
        // first, then the JSON arguments in small pieces.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (next.content) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: next.content } }] })}\n\n`);
        next.tool_calls.forEach((tc, index) => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_t${index}`, type: 'function', function: { name: tc.name, arguments: '' } }] } }] })}\n\n`);
          for (const piece of JSON.stringify(tc.args).match(/[\s\S]{1,7}/g)) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: piece } }] } }] })}\n\n`);
          }
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return sse(res, next);
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><head><title>x</title><script>var a=1</script></head><body><h1>Hello &amp; welcome</h1><p>See <a href="/docs">the docs</a>.</p><ul><li>one</li><li>two</li></ul></body></html>');
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
    approve: Object.assign(async () => 'once', opts.ask ? { ask: opts.ask } : {}), signal: new AbortController().signal, route, maxSteps: opts.maxSteps || 12, verifyOnly: opts.verifyOnly,
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

// 12. Several look-around blocks in one reply all run in that step.
{
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'beta\n');
  const r = await run([
    '<codeply:read_file>\n<path>a.txt</path>\n</codeply:read_file>\n<codeply:read_file>\n<path>b.txt</path>\n</codeply:read_file>',
    'a.txt says alpha and b.txt says beta.',
  ], 'what do the files say?', { mode: 'Ask' });
  const ends = r.events.filter((e) => e.type === 'tool_end' && e.name === 'read_file');
  check('batched reads both ran', ends.length === 2 && ends.every((e) => e.ok), JSON.stringify(ends));
  check('batched reads took one step', r.done && r.done.steps === 2, JSON.stringify(r.done));
}

// 13. A write is never batched with other blocks.
{
  const r = await run([
    '<codeply:write_file>\n<path>w1.md</path>\n<content>\none\n</content>\n</codeply:write_file>\n<codeply:read_file>\n<path>a.txt</path>\n</codeply:read_file>',
    'Wrote w1.md.',
  ]);
  const ends = r.events.filter((e) => e.type === 'tool_end');
  check('write runs alone', ends.length === 1 && ends[0].name === 'write_file', JSON.stringify(ends.map((e) => e.name)));
  check('told only the first block ran', r.seen.some((s) => s.includes('Only the first was performed')));
}

// 14. Text written after an action block (a guessed outcome) is dropped.
{
  const r = await run([
    '<codeply:list_dir>\n<path>.</path>\n</codeply:list_dir>\nDone! All tests pass and the site is deployed.',
    'The folder has a few text files.',
  ], 'look', { mode: 'Ask' });
  check('trailing guess never shown', !r.texts.some((t) => /All tests pass/.test(t)), JSON.stringify(r.texts));
}

// 15. A tool result the model wrote itself is caught.
{
  const r = await run([
    'Running it now.\n[tool result: run]\nexit code 0, all good',
    'I have not run anything yet.',
  ], 'run it', { mode: 'Ask' });
  check('fabricated tool result corrected', r.seen.some((s) => s.includes('tool result you wrote yourself')), JSON.stringify(r.seen));
  check('fabricated result never shown', !r.texts.some((t) => t.includes('[tool result')));
}

// 16. The same failing command three times in a row is stopped, with ideas for a way around it.
{
  const bad = '<codeply:run>\n<command>node -e "process.exit(3)"</command>\n</codeply:run>';
  const r = await run([bad, bad, bad, 'That command keeps failing with exit code 3; I could not get past it.'], 'run it');
  const runs = r.events.filter((e) => e.type === 'tool_end' && e.name === 'run');
  check('third identical run skipped', runs.length === 3 && /skipped/.test(runs[2].summary || ''), JSON.stringify(runs.map((e) => e.summary)));
  check('stuck note suggests workarounds', r.seen.some((s) => s.includes('Change your approach') && s.includes('command -v')), JSON.stringify(r.seen.at(-1)));
}

// 17. A near-miss edit shows the real lines; an imperfect copy still applies when it is unambiguous.
{
  fs.writeFileSync(path.join(tmp, 'long.js'), Array.from({ length: 300 }, (_, i) => `const value${i} = compute(${i});`).join('\n') + '\n');
  const r = await run([
    '<codeply:edit_file>\n<path>long.js</path>\n<search>\nconst valu150 = compte(150)\n</search>\n<replace>\nconst value150 = 0;\n</replace>\n</codeply:edit_file>',
    '<codeply:edit_file>\n<path>long.js</path>\n<search>\n    const value150 = compute(150);\n    const value151 = compute(151);\n</search>\n<replace>\n    const value150 = 0;\n    const value151 = compute(151);\n</replace>\n</codeply:edit_file>',
    '<codeply:run>\n<command>node --check long.js</command>\n</codeply:run>',
    'Set value150 to 0 in long.js and checked it with node --check.',
  ]);
  check('miss shows closest lines', r.seen.some((s) => s.includes('Closest match') && s.includes('151│const value150 = compute(150);')), r.seen[1]);
  const after = fs.readFileSync(path.join(tmp, 'long.js'), 'utf8');
  check('indent-shifted edit applied at the right place', after.includes('\nconst value150 = 0;\nconst value151'), after.split('\n').slice(149, 152).join(' | '));
}

// 18. <all>true</all> renames every occurrence; without it, duplicates are reported with line numbers.
{
  fs.writeFileSync(path.join(tmp, 'dup.js'), 'foo();\nbar();\nfoo();\n');
  const r = await run([
    '<codeply:edit_file>\n<path>dup.js</path>\n<search>\nfoo();\n</search>\n<replace>\nbaz();\n</replace>\n</codeply:edit_file>',
    '<codeply:edit_file>\n<path>dup.js</path>\n<search>\nfoo();\n</search>\n<replace>\nbaz();\n</replace>\n<all>true</all>\n</codeply:edit_file>',
    '<codeply:run>\n<command>node --check dup.js</command>\n</codeply:run>',
    'Renamed foo to baz in dup.js.',
  ]);
  check('duplicate match lists lines', r.seen.some((s) => s.includes('starting at lines 1, 3')), r.seen[1]);
  check('all=true replaced both', fs.readFileSync(path.join(tmp, 'dup.js'), 'utf8') === 'baz();\nbar();\nbaz();\n');
}

// 19. A file changed on disk after it was read is not edited blind.
{
  fs.writeFileSync(path.join(tmp, 'live.txt'), 'one\ntwo\n');
  const origApprove = null; // eslint-friendly placeholder
  script = [
    '<codeply:read_file>\n<path>live.txt</path>\n</codeply:read_file>',
    '<codeply:edit_file>\n<path>live.txt</path>\n<search>\ntwo\n</search>\n<replace>\nTWO\n</replace>\n</codeply:edit_file>',
    'Stopping here.',
  ];
  seen = [];
  const events = [];
  let step = 0;
  for await (const ev of runAgent({
    userMessage: 'edit it', history: [], mode: 'Build', cwd: tmp, route, maxSteps: 6,
    approve: async () => 'once', signal: new AbortController().signal,
  })) {
    events.push(ev);
    // Simulate the user saving the file in their editor right after the read.
    if (ev.type === 'tool_end' && ev.name === 'read_file' && step++ === 0) {
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(path.join(tmp, 'live.txt'), 'one\ntwo\nthree\n');
    }
  }
  void origApprove;
  const edit = events.find((e) => e.type === 'tool_end' && e.name === 'edit_file');
  check('stale file edit refused', edit && edit.ok === false && seen.some((s) => s.includes('changed on disk')), JSON.stringify(seen));
}

// 20. Search: context lines, files-only, and find-by-name.
{
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'x.test.js'), 'line1\nneedle here\nline3\n');
  const r = await run([
    '<codeply:search>\n<pattern>needle</pattern>\n<context>1</context>\n</codeply:search>\n<codeply:search>\n<glob>*.test.js</glob>\n</codeply:search>\n<codeply:search>\n<pattern>needle</pattern>\n<files_only>true</files_only>\n</codeply:search>',
    'Found it in src/x.test.js.',
  ], 'find needle', { mode: 'Ask' });
  const all = r.seen.join('\n');
  check('search context lines', all.includes('src/x.test.js-1- line1') && all.includes('src/x.test.js:2: needle here'), all.slice(0, 600));
  check('find files by name', all.includes('file(s) matching *.test.js') && all.includes('src/x.test.js'));
  check('files_only lists counts', all.includes('src/x.test.js  (1)'));
}

// 21. Project instruction files and git state reach the system prompt.
{
  const { buildSystemPrompt } = await import(pathToFileURL(path.join(CLI, 'lib/agent.mjs')).href);
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'Always use tabs in this repo.');
  const sys = buildSystemPrompt('Build', tmp, 'hi');
  check('AGENTS.md loaded', sys.includes('PROJECT INSTRUCTIONS') && sys.includes('Always use tabs in this repo.'));
  fs.rmSync(path.join(tmp, 'AGENTS.md'));
}

// 22. Claiming a change is still allowed after a shell command that could have made it.
{
  const r = await run([
    '<codeply:run>\n<command>node -e "require(\'fs\').writeFileSync(\'gen.txt\',\'x\')"</command>\n</codeply:run>',
    "I've created gen.txt with a script.",
  ]);
  check('claim after a real shell change is not blocked', r.texts.some((t) => t.includes("I've created gen.txt")), JSON.stringify(r.texts));
}

// 23. A failed command gets one concrete recovery hint; a piped-away failure is not taken as a pass.
{
  const hints = require(path.join(CLI, 'lib/terminal-hints.js'));
  check('hint: cmd.exe missing command', /not installed or not on PATH/.test(hints.annotateFailure('foo', 1, "'foo' is not recognized as an internal or external command,") || ''));
  check('hint: missing node package', /npm install/.test(hints.annotateFailure('node a.js', 1, "Error: Cannot find module 'express'") || ''));
  check('hint: port in use', /Port 3000/.test(hints.annotateFailure('node s.js', 1, 'Error: listen EADDRINUSE: address already in use :::3000') || ''));
  check('no hint on success', hints.annotateFailure('ls', 0, 'command not found') === null);
  check('masked failure caught', /Treat this run as FAILED/.test(hints.annotateMaskedSuccess('npm test | tail -5', 'Tests: 2 failed, 3 passed') || ''));
  check('grep output not flagged', hints.annotateMaskedSuccess('grep -r "npm ERR!" logs | head', 'npm ERR! x') === null);
  const r = await run([
    '<codeply:run>\n<command>node -e "console.log(\'Tests: 1 failed\')" | findstr Tests</command>\n</codeply:run>',
    'The test run reported 1 failed test, so it is not passing yet.',
  ], 'run the tests', { mode: 'Ask' });
  const ran = r.done?.actions.find((a) => a.tool === 'run');
  check('masked failure recorded as failed', ran && ran.exitCode === 1, JSON.stringify(r.done?.actions));
}

// 24. "Let me now..." with no action block is sent back once to actually act.
{
  const r = await run([
    "I found the bug in a.txt. Let me now update the file.",
    '<codeply:write_file>\n<path>a.txt</path>\n<content>\nALPHA\n</content>\n</codeply:write_file>',
    'Updated a.txt to ALPHA.',
  ]);
  check('stall nudged', r.seen.some((s) => s.includes('announces what you are about to do')), JSON.stringify(r.seen));
  check('announcement never shown as the answer', !r.texts.some((t) => t.includes('Let me now update')));
  check('then really wrote it', fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8').includes('ALPHA'));
}

// 25. The task list round-trips and only one item may be in progress.
{
  const r = await run([
    '<codeply:todo>\n<items>\n[x] read a.txt\n[>] update b.txt\n[>] check it\n[ ] summarize\n</items>\n</codeply:todo>',
    'Plan made.',
  ], 'plan it', { mode: 'Ask' });
  const t = r.events.find((e) => e.type === 'tool_end' && e.name === 'todo');
  check('todo accepted', t && t.ok && /1\/4 done/.test(t.summary || ''), JSON.stringify(t));
  check('only one in progress', t && t.meta.todos.filter((x) => x.status === 'in_progress').length === 1);
}

// 26. Running low on steps: one checkpoint, then a no-actions summary instead of a bare stop.
{
  const reads = Array.from({ length: 12 }, (_, i) => `<codeply:search>\n<pattern>zz${i}</pattern>\n</codeply:search>`);
  const r = await run([...reads, 'Summary: I searched for several patterns and found nothing; no files were changed.'], 'dig', { maxSteps: 12, mode: 'Ask' });
  check('budget checkpoint sent', r.seen.some((s) => s.includes('steps for this turn')), '');
  check('final summary shown after budget', r.texts.some((t) => t.startsWith('Summary: I searched')), JSON.stringify(r.texts));
  check('still reported as stopped', r.events.some((e) => e.type === 'error' && /Stopped after 12 steps/.test(e.error)));
}

// 27. Editing a Windows (CRLF) file keeps its line endings.
{
  fs.writeFileSync(path.join(tmp, 'win.txt'), 'one\r\ntwo\r\nthree\r\n');
  await run([
    '<codeply:edit_file>\n<path>win.txt</path>\n<search>\ntwo\n</search>\n<replace>\nTWO\n</replace>\n</codeply:edit_file>',
    'Changed two to TWO in win.txt.',
  ]);
  check('CRLF preserved on edit', fs.readFileSync(path.join(tmp, 'win.txt'), 'utf8') === 'one\r\nTWO\r\nthree\r\n', JSON.stringify(fs.readFileSync(path.join(tmp, 'win.txt'), 'utf8')));
}

// 28. The same tool failing with different arguments gets a "diagnose first" warning.
{
  const fails = [1, 2, 3].map((n) => `<codeply:run>\n<command>node -e "process.exit(${n})"</command>\n</codeply:run>`);
  const r = await run([...fails, 'Every command failed; I am blocked.'], 'run', { mode: 'Ask' });
  check('failure streak warning', r.seen.some((s) => s.includes('has failed 3 times in a row')), JSON.stringify(r.seen.at(-1)));
}

// 29. Huge command output is saved to a file the model can page through; the end is kept.
{
  const r = await run([
    '<codeply:run>\n<command>node -e "for (let i = 0; i < 4000; i++) console.log(\'row \' + i)"</command>\n</codeply:run>',
    'It printed 4000 rows.',
  ], 'print rows', { mode: 'Ask' });
  const all = r.seen.join('\n');
  const saved = (all.match(/saved at (\S+\.txt)/) || [])[1];
  check('long output spilled to a file', saved && fs.existsSync(saved) && fs.readFileSync(saved, 'utf8').includes('row 3999'), all.slice(0, 300));
  check('tail of output kept inline', all.includes('row 3999'));
}

// 30. read_file: near-miss names, binary files, offsets past the end.
{
  fs.writeFileSync(path.join(tmp, 'config.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(tmp, 'pic.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
  const r = await run([
    '<codeply:read_file>\n<path>confg.json</path>\n</codeply:read_file>\n<codeply:read_file>\n<path>pic.bin</path>\n</codeply:read_file>\n<codeply:read_file>\n<path>config.json</path>\n<offset>50</offset>\n</codeply:read_file>',
    'Done looking.',
  ], 'read', { mode: 'Ask' });
  const all = r.seen.join('\n');
  check('did-you-mean on a missing file', all.includes('Did you mean: config.json'), all.slice(0, 400));
  check('binary file refused', all.includes('is a binary file'));
  check('offset past the end explained', all.includes('past the end'));
}

// 31. A write that breaks syntax gets the error back at once, and the turn can't end while it stays broken.
{
  const r = await run([
    '<codeply:write_file>\n<path>broken.js</path>\n<content>\nfunction x( {\n</content>\n</codeply:write_file>',
    '<codeply:run>\n<command>node -e "1"</command>\n</codeply:run>',
    'Created broken.js.',
    '<codeply:write_file>\n<path>broken.js</path>\n<content>\nfunction x() {}\n</content>\n</codeply:write_file>',
    '<codeply:run>\n<command>node --check broken.js</command>\n</codeply:run>',
    'Created broken.js and node --check passes.',
  ]);
  check('syntax problem reported with the write', r.seen.some((s) => s.includes('Syntax check on broken.js found a problem')), r.seen[0]);
  check('finish blocked while still broken', r.seen.some((s) => s.includes('syntax check still fails for broken.js')), JSON.stringify(r.seen.slice(2, 3)));
  check('then fixed', r.done && fs.readFileSync(path.join(tmp, 'broken.js'), 'utf8').includes('function x() {}'));
}

// 32. ask_user reaches the host's question callback; without one the agent decides.
{
  const asked = [];
  script = [
    '<codeply:ask_user>\n<question>Which color?</question>\n<options>\nBlue (Recommended)\nRed\n</options>\n</codeply:ask_user>',
    'You picked Red, so I will use red.',
  ];
  seen = [];
  const approve = async () => 'once';
  approve.ask = async (q) => { asked.push(q); return 'Red'; };
  const events = [];
  for await (const ev of runAgent({ userMessage: 'pick', history: [], mode: 'Ask', cwd: tmp, route, maxSteps: 4, approve, signal: new AbortController().signal })) events.push(ev);
  check('question delivered with options', asked.length === 1 && asked[0].options.length === 2 && asked[0].options[0] === 'Blue (Recommended)', JSON.stringify(asked));
  check('answer returned to the model', seen.some((s) => s.includes('The user answered: Red')));
  const r2 = await run([
    '<codeply:ask_user>\n<question>Which color?</question>\n<options>\nBlue\n</options>\n</codeply:ask_user>',
    'No one to ask, so I chose blue.',
  ], 'pick', { mode: 'Ask' });
  check('unattended: told to decide itself', r2.seen.some((s) => s.includes('Pick the most sensible option yourself')));
}

// 33. "Always allow" for shell commands is scoped by command name.
{
  const { commandPatterns } = require(path.join(CLI, 'lib/arity.js'));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('arity: npm run dev', eq(commandPatterns('npm run dev'), ['npm run dev']));
  check('arity: chained git', eq(commandPatterns('git checkout main && git pull'), ['git checkout', 'git pull']));
  check('arity: interpreter keeps the script', eq(commandPatterns('node server.js --port 3000'), ['node server.js']));
  check('arity: subshell not scopable', commandPatterns('echo $(whoami)') === null);
  check('arity: redirect not scopable', commandPatterns('npm test > out.txt') === null);
}

// 34. Snapshots: undo puts changed files back, removes new ones, redo re-applies.
{
  const snap = require(path.join(CLI, 'lib/snapshot.js'));
  if (await snap.available()) {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-snap-'));
    fs.writeFileSync(path.join(proj, 'keep.txt'), 'v1\r\n');
    const t1 = await snap.track(proj);
    fs.writeFileSync(path.join(proj, 'keep.txt'), 'v2\r\n');
    fs.writeFileSync(path.join(proj, 'made.txt'), 'new');
    const t2 = await snap.track(proj);
    const changed = (await snap.changedFiles(proj, t1, t2)).map((c) => c.file).sort();
    check('snapshot sees both changes', JSON.stringify(changed) === '["keep.txt","made.txt"]', JSON.stringify(changed));
    await snap.restore(proj, t1, changed);
    check('undo restores and removes', fs.readFileSync(path.join(proj, 'keep.txt'), 'utf8') === 'v1\r\n' && !fs.existsSync(path.join(proj, 'made.txt')));
    await snap.restore(proj, t2, changed);
    check('redo re-applies', fs.readFileSync(path.join(proj, 'keep.txt'), 'utf8') === 'v2\r\n' && fs.existsSync(path.join(proj, 'made.txt')));
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(snap.gitDirFor(proj), { recursive: true, force: true });
  } else {
    console.log('SKIP  snapshots (git not installed)');
  }
}

// 35. Native tool calling: real tool_calls run, history goes back in native shape.
{
  bodies = [];
  const r = await run([
    { content: 'Looking first.', tool_calls: [{ name: 'list_dir', args: { path: '.' } }, { name: 'read_file', args: { path: 'a.txt' } }] },
    { tool_calls: [{ name: 'write_file', args: { path: 'native.txt', content: 'line one\n</content> stays literal\n' } }] },
    'Wrote native.txt.',
  ], 'native test');
  check('native: tools sent with the request', Array.isArray(bodies[0]?.tools) && bodies[0].tools.some((t) => t.function.name === 'edit_file'));
  check('native: parallel reads both ran', r.events.filter((e) => e.type === 'tool_end' && e.ok && (e.name === 'list_dir' || e.name === 'read_file')).length === 2);
  check('native: file content exact (no tag escaping issues)', fs.readFileSync(path.join(tmp, 'native.txt'), 'utf8') === 'line one\n</content> stays literal\n', JSON.stringify(fs.existsSync(path.join(tmp, 'native.txt')) && fs.readFileSync(path.join(tmp, 'native.txt'), 'utf8')));
  const second = bodies[1]?.messages || [];
  const asst = second.find((m) => m.role === 'assistant' && m.tool_calls);
  const tools = second.filter((m) => m.role === 'tool');
  check('native: history has tool_calls + matching tool results', asst && asst.tool_calls.length === 2 && tools.length === 2 && tools.every((t) => asst.tool_calls.some((c) => c.id === t.tool_call_id)), JSON.stringify(second.slice(-4)).slice(0, 400));
  check('native: system prompt has no tag examples', !String(bodies[0]?.messages[0]?.content).includes('<codeply:read_file>'));
}

// 35b. MCP: a stdio server's tools are listed, called natively, and results come back.
{
  const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-mcp-'));
  const serverJs = path.join(mcpDir, 'fake-mcp.js');
  fs.writeFileSync(serverJs, `
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (d) => {
  buf += d; let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' }, instructions: 'A fake weather server.' } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'get_weather', description: 'Weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, annotations: { readOnlyHint: true } }] } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Sunny in ' + m.params.arguments.city }] } });
  }
});`);
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-mcpproj-'));
  fs.mkdirSync(path.join(proj, '.codeply'));
  fs.writeFileSync(path.join(proj, '.codeply', 'mcp.json'), JSON.stringify({ mcpServers: { weather: { command: process.execPath, args: [serverJs] } } }));
  script = [
    { tool_calls: [{ name: 'mcp__weather__get_weather', args: { city: 'Lahore' } }] },
    'It is sunny in Lahore.',
  ];
  seen = []; bodies = [];
  const events = [];
  for await (const ev of runAgent({ userMessage: 'weather?', history: [], mode: 'Ask', cwd: proj, route, maxSteps: 4, approve: async () => 'once', signal: new AbortController().signal })) events.push(ev);
  check('mcp: tool offered natively', (bodies[0]?.tools || []).some((t) => t.function.name === 'mcp__weather__get_weather'));
  check('mcp: server listed in the prompt', String(bodies[0]?.messages[0]?.content).includes('MCP SERVERS') && String(bodies[0]?.messages[0]?.content).includes('get_weather(city)'));
  check('mcp: call ran and returned', seen.some((s) => s.includes('Sunny in Lahore')), JSON.stringify(seen.slice(-1)));
  const hist = bodies[1]?.messages || [];
  check('mcp: history keeps the native name', hist.some((m) => m.tool_calls && m.tool_calls[0].function.name === 'mcp__weather__get_weather'));
  require(path.join(CLI, 'lib/mcp.js')).closeAll();
  // Windows keeps the folder locked until the killed server has fully exited.
  await new Promise((r) => setTimeout(r, 500));
  for (const d of [proj, mcpDir]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
}

// 35c. Custom commands, permission rules, and shell-syntax workaround hints.
{
  const perms = require(path.join(CLI, 'lib/permissions.js'));
  const cmds = require(path.join(CLI, 'lib/commands.js'));
  const { commandPatterns } = require(path.join(CLI, 'lib/arity.js'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-rules-'));
  fs.mkdirSync(path.join(proj, '.codeply', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.codeply', 'permissions.json'), JSON.stringify({ deny: ['run:git push*', 'write_file:*.env'], allow: ['run:npm run *', 'run:git status', 'edit_file:src/**'] }));
  const run = (c) => perms.decide({ tool: 'run', detail: c, patterns: commandPatterns(c) }, proj).decision;
  check('perm: allowed command', run('npm run dev') === 'allow');
  check('perm: chain needs every part allowed', run('npm run build && npm install') === null);
  check('perm: deny beats allow in a chain', run('npm run dev && git push') === 'deny');
  check('perm: path rule', perms.decide({ tool: 'edit_file', path: 'src/a/b.ts' }, proj).decision === 'allow' && perms.decide({ tool: 'write_file', path: '.env' }, proj).decision === 'deny');
  fs.writeFileSync(path.join(proj, '.codeply', 'commands', 'review.md'), '---\ndescription: Review files\nmode: Plan\n---\nReview $ARGUMENTS for bugs.');
  const r = cmds.resolve('/review src/app.js', proj);
  check('command: expands with mode', r && r.prompt === 'Review src/app.js for bugs.' && r.command.mode === 'Plan', JSON.stringify(r));
  check('command: /goal never shadowed', cmds.resolve('/goal x', proj) === null);
  const hints = require(path.join(CLI, 'lib/terminal-hints.js'));
  check('hint: heredoc -> write_file', /write_file/.test(hints.annotateFailure('cat <<EOF > a', 1, '<< was unexpected at this time.') || ''));
  check('hint: PowerShell &&', /PowerShell 5\.1/.test(hints.annotateFailure('a && b', 1, "The token '&&' is not a valid statement separator in this version.") || ''));
  fs.rmSync(proj, { recursive: true, force: true });
}

// 36. A model that rejects tools drops to text actions and is remembered.
{
  bodies = [];
  const r = await run([
    { status: 400, error: 'This model does not support tools' },
    '<codeply:list_dir>\n<path>.</path>\n</codeply:list_dir>',
    'Listed it.',
  ], 'fallback test', { mode: 'Ask' });
  check('fallback: notice shown', r.events.some((e) => e.type === 'notice' && /switched to text actions/.test(e.text)));
  check('fallback: retried without tools, with tag examples', !bodies[1]?.tools && String(bodies[1]?.messages[0]?.content).includes('<codeply:read_file>'));
  check('fallback: then worked', r.done && r.events.some((e) => e.type === 'tool_end' && e.name === 'list_dir' && e.ok));
  bodies = [];
  await run(['Nothing to do.'], 'again', { mode: 'Ask' });
  check('fallback remembered for the next turn', !bodies[0]?.tools);
}

// ─── Round 4: apply_patch, web tools, plan mode ─────────────────────────────

{
  const { planPatch, parsePatch } = require(path.join(CLI, 'lib/apply-patch.js'));
  const files = { 'a.txt': 'one\ntwo\nthree\n', 'gone.txt': 'bye\n', 'crlf.txt': 'x\r\ny\r\nz\r\n' };
  const read = (p) => (p in files ? files[p] : null);
  const p1 = planPatch([
    '*** Begin Patch',
    '*** Add File: new/b.txt', '+hello', '+world',
    '*** Update File: a.txt', '@@', ' one', '-two', '+TWO', '+two and a half', ' three',
    '*** Delete File: gone.txt',
    '*** Update File: crlf.txt', '*** Move to: moved.txt', '@@', ' x', '-y', '+Y', ' z',
    '*** End Patch',
  ].join('\n'), read);
  check('patch: plans all four kinds', !p1.error && p1.changes.map((c) => c.kind).join() === 'add,update,delete,move', JSON.stringify(p1));
  check('patch: update applied', p1.changes[1]?.after === 'one\nTWO\ntwo and a half\nthree\n', JSON.stringify(p1.changes?.[1]));
  check('patch: CRLF kept', p1.changes[3]?.after === 'x\r\nY\r\nz\r\n', JSON.stringify(p1.changes?.[3]));
  check('patch: missing lines are reported', !!planPatch('*** Begin Patch\n*** Update File: a.txt\n@@\n-nope\n+x\n*** End Patch', read).error);
  check('patch: no header is reported', !!parsePatch('just text').error);
  check('patch: heredoc wrapper tolerated', !parsePatch("apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: q.txt\n+q\n*** End Patch\nEOF").error);
}

{
  fs.writeFileSync(path.join(tmp, 'p1.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(tmp, 'p2.txt'), 'delete me\n');
  const patch = '*** Begin Patch\n*** Update File: p1.txt\n@@\n alpha\n-beta\n+BETA\n gamma\n*** Add File: sub/p3.txt\n+fresh\n*** Delete File: p2.txt\n*** End Patch';
  const r = await run([
    '<codeply:read_file>\n<path>p1.txt</path>\n</codeply:read_file>',
    `<codeply:apply_patch>\n<patch>\n${patch}\n</patch>\n</codeply:apply_patch>`,
    'Patched p1.txt, added sub/p3.txt and removed p2.txt.',
  ]);
  check('apply_patch: update written', fs.readFileSync(path.join(tmp, 'p1.txt'), 'utf8') === 'alpha\nBETA\ngamma\n');
  check('apply_patch: add written', fs.existsSync(path.join(tmp, 'sub/p3.txt')));
  check('apply_patch: delete done', !fs.existsSync(path.join(tmp, 'p2.txt')));
  const act = r.done?.actions.find((a) => a.tool === 'apply_patch');
  check('apply_patch: action lists files', act?.ok && act.files?.length === 3, JSON.stringify(r.done?.actions));
  check('apply_patch: counts as an edit', r.done?.madeAnyEdit && r.done.writtenFiles.includes('p3.txt'), JSON.stringify(r.done));
}

{
  const r = await run([
    `<codeply:apply_patch>\n<patch>\n*** Begin Patch\n*** Add File: nope.txt\n+x\n*** End Patch\n</patch>\n</codeply:apply_patch>`,
    'I cannot change files in Plan mode.',
  ], 'add a file', { mode: 'Plan' });
  check('plan mode: apply_patch blocked', !fs.existsSync(path.join(tmp, 'nope.txt')) && r.seen.some((s) => s.includes('Blocked')), JSON.stringify(r.seen));
}

{
  const { fetchPage, htmlToText } = require(path.join(CLI, 'lib/web-tools.js'));
  const r = await fetchPage(`http://127.0.0.1:${port}/page`);
  check('web_fetch: html becomes readable text', r.ok && r.text.includes('# Hello & welcome') && r.text.includes('[the docs](http://127.0.0.1:') && r.text.includes('- one') && !r.text.includes('var a'), JSON.stringify(r));
  check('web_fetch: rejects non-http', !(await fetchPage('file:///etc/passwd')).ok);
  check('web_fetch: htmlToText drops scripts', !htmlToText('<p>hi</p><script>evil()</script>').includes('evil'));
  const viaAgent = await run([
    `<codeply:web_fetch>\n<url>http://127.0.0.1:${port}/page</url>\n</codeply:web_fetch>`,
    'The page greets you.',
  ], 'read that page', { mode: 'Ask' });
  check('web_fetch: works in Ask mode', viaAgent.seen.some((s) => s.includes('Hello & welcome')), JSON.stringify(viaAgent.seen));
}

{
  const asked = [];
  const r = await run([
    '<codeply:write_file>\n<path>src-out.txt</path>\n<content>\nno\n</content>\n</codeply:write_file>',
    '<codeply:write_file>\n<path>.codeply/plans/add-thing.md</path>\n<content>\n# Plan\n1. Do the thing\n</content>\n</codeply:write_file>',
    '<codeply:plan_exit>\n</codeply:plan_exit>',
    '<codeply:write_file>\n<path>built.txt</path>\n<content>\nbuilt\n</content>\n</codeply:write_file>',
    'Implemented the plan: created built.txt.',
  ], 'plan then build', { mode: 'Plan', ask: async (q) => { asked.push(q); return q.options[0]; } });
  check('plan: other files blocked in Plan mode', !fs.existsSync(path.join(tmp, 'src-out.txt')));
  check('plan: plan file written in Plan mode', fs.existsSync(path.join(tmp, '.codeply/plans/add-thing.md')));
  check('plan: user asked before switching', asked.length === 1 && /Build/.test(asked[0].question) && /Yes/.test(asked[0].options[0]), JSON.stringify(asked));
  check('plan: mode_switch event emitted', r.events.some((e) => e.type === 'mode_switch' && e.mode === 'Build'));
  check('plan: Build tools work after the switch', fs.existsSync(path.join(tmp, 'built.txt')));
  check('plan: plan file does not count as a project edit', !r.done?.writtenFiles.includes('add-thing.md'), JSON.stringify(r.done?.writtenFiles));
}

{
  const r = await run([
    '<codeply:write_file>\n<path>.codeply/plans/keep.md</path>\n<content>\n# Plan\n</content>\n</codeply:write_file>',
    '<codeply:plan_exit>\n</codeply:plan_exit>',
    '<codeply:write_file>\n<path>should-not-exist.txt</path>\n<content>\nx\n</content>\n</codeply:write_file>',
    'Still planning.',
  ], 'plan', { mode: 'Plan', ask: async (q) => q.options[1] });
  check('plan: "No" keeps Plan mode', !r.events.some((e) => e.type === 'mode_switch') && !fs.existsSync(path.join(tmp, 'should-not-exist.txt')));
}

{
  const r = await run([
    '<codeply:plan_exit>\n</codeply:plan_exit>',
    'Not applicable.',
  ], 'x', { mode: 'Build' });
  check('plan: plan_exit refused outside Plan mode', r.seen.some((s) => s.includes('only works in Plan mode')), JSON.stringify(r.seen));
}

// ── SQLite session store ──
{
  const { openSessionDb } = require(path.join(CLI, 'lib/session-db.js'));
  const dbFile = path.join(tmp, 'sessions.db');
  const db = openSessionDb(dbFile);
  if (!db) {
    console.log('SKIP  sqlite: no SQLite driver in this runtime (Craft falls back to JSON)');
  } else {
    check('sqlite: starts empty', db.isEmpty());
    const store = {
      projects: ['C:/a'], lastProject: 'C:/a', autoRouting: true,
      sessions: [
        { id: 's1', title: 'First', cwd: 'C:/a', messages: [{ kind: 'user', text: 'fix the Login button' }, { kind: 'assistant', text: 'Done, fixed it' }], alwaysAllowed: ['run:npm test'], createdAt: 1, updatedAt: 2, pinned: true },
        { id: 's2', title: 'Second', cwd: 'C:/b', messages: [{ kind: 'user', text: 'add a footer' }], alwaysAllowed: [], createdAt: 3, updatedAt: 4 },
      ],
    };
    db.save(store);
    db.close();
    const db2 = openSessionDb(dbFile);
    const back = db2.load();
    check('sqlite: sessions round-trip in order', back.sessions.map((s) => s.id).join() === 's1,s2');
    check('sqlite: messages, extras and allowlist survive', back.sessions[0].messages.length === 2 && back.sessions[0].pinned === true && back.sessions[0].alwaysAllowed[0] === 'run:npm test');
    check('sqlite: other store keys survive', back.lastProject === 'C:/a' && back.autoRouting === true && back.projects[0] === 'C:/a');
    // Mutate in place the way main.js does: edit a message, append one, delete a session.
    back.sessions[0].messages[1].text = 'Done, fixed the Login button';
    back.sessions[0].messages.push({ kind: 'user', text: 'thanks' });
    back.sessions = back.sessions.filter((s) => s.id !== 's2');
    db2.save(back);
    check('sqlite: search finds text across sessions', db2.search('login').length === 2 && db2.search('login')[0].sessionId === 's1');
    check('sqlite: deleted session is gone from search', db2.search('footer').length === 0);
    check('sqlite: search treats % and _ literally', db2.search('%').length === 0);
    back.sessions[0].messages.pop();
    db2.save(back);
    db2.close();
    const db3 = openSessionDb(dbFile);
    const again = db3.load();
    check('sqlite: edits, appends, trims and deletes persist', again.sessions.length === 1 && again.sessions[0].messages.length === 2 && /Login/.test(again.sessions[0].messages[1].text));
    db3.close();
  }
}

// ── Plugins ──
{
  const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const fakeHome = path.join(tmp, 'plugin-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.USERPROFILE = fakeHome; process.env.HOME = fakeHome;
  const plugins = require(path.join(CLI, 'lib/plugins.js'));
  const commandsLib = require(path.join(CLI, 'lib/commands.js'));
  const skillsLib = require(path.join(CLI, 'lib/skills.js'));
  const mcpLib = require(path.join(CLI, 'lib/mcp.js'));
  const proj = path.join(tmp, 'plugin-proj');
  fs.mkdirSync(proj, { recursive: true });
  const sysText = () => { const s = bodies[bodies.length - 1].messages[0].content; return typeof s === 'string' ? s : JSON.stringify(s); };

  const made = plugins.scaffoldPlugin('demo-kit', path.join(tmp, 'plugin-src'));
  check('plugin: init scaffolds a folder', made.ok && fs.existsSync(path.join(made.dir, 'codeply-plugin.json')));
  fs.writeFileSync(path.join(made.dir, 'instructions.md'), 'Always sign commits with the word PLUGINRULE.\n');
  fs.writeFileSync(path.join(made.dir, 'mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['${CODEPLY_PLUGIN_ROOT}/server.js'] } } }));
  fs.writeFileSync(path.join(made.dir, 'evil.md'), 'outside');
  fs.mkdirSync(path.join(made.dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(made.dir, 'node_modules', 'big.txt'), 'x');

  const prepared = await plugins.prepareInstall(made.dir);
  check('plugin: install shows what it contains before installing', prepared.ok && prepared.summary.commands === 1 && prepared.summary.skills === 1 && prepared.summary.mcpServers[0].runs.includes('server.js'), JSON.stringify(prepared));
  check('plugin: nothing is installed until confirmed', plugins.listPlugins(proj).length === 0);
  const done = plugins.finishInstall(prepared, { scope: 'user', cwd: proj });
  check('plugin: install copies it in without node_modules', done.ok && !fs.existsSync(path.join(done.dest, 'node_modules')) && fs.existsSync(path.join(done.dest, '.codeply-install.json')), JSON.stringify(done));
  const again = await plugins.prepareInstall(made.dir);
  check('plugin: a second install is refused without force', !plugins.finishInstall(again, { scope: 'user', cwd: proj }).ok);

  const hello = commandsLib.resolve('/demo-kit:hello the docs', proj);
  check('plugin: its commands run as /plugin:name', hello && /Greet the user/.test(hello.prompt) && /the docs/.test(hello.prompt), JSON.stringify(hello));
  check('plugin: its skills are listed and loadable', skillsLib.listSkills(proj).some((s) => s.name === 'demo-kit-example' && s.daily) && /Step by step/.test(skillsLib.loadSkillBody('demo-kit-example', proj) || ''));
  const srv = mcpLib.loadServers(proj)['demo-kit-tools'];
  check('plugin: MCP servers come through with the plugin folder filled in', srv && srv.args[0].endsWith('server.js') && !srv.args[0].includes('${'), JSON.stringify(srv));

  await run(['Noted.'], 'hi');
  check('plugin: its instructions reach the agent prompt', /PLUGINRULE/.test(sysText()) && /plugin demo-kit/.test(sysText()));

  plugins.setEnabled('demo-kit', false, proj);
  check('plugin: disabled means nothing is loaded', !commandsLib.resolve('/demo-kit:hello', proj) && !skillsLib.listSkills(proj).some((s) => s.plugin === 'demo-kit') && !mcpLib.loadServers(proj)['demo-kit-tools'] && plugins.instructionBlocks(proj).length === 0);
  plugins.setEnabled('demo-kit', true, proj);
  check('plugin: enabling brings it back', !!commandsLib.resolve('/demo-kit:hello', proj));

  fs.writeFileSync(path.join(fakeHome, '.codeply', 'plugins', 'outside.md'), 'outside');
  fs.writeFileSync(path.join(made.dir, 'codeply-plugin.json'), JSON.stringify({ name: 'demo-kit', version: '0.2.0', instructions: ['../outside.md', 'instructions.md'] }));
  const upd = await plugins.prepareUpdate('demo-kit', proj);
  check('plugin: update re-reads the source and reports the version', upd.ok && upd.summary.version === '0.2.0' && upd.before.version === '0.1.0', JSON.stringify(upd));
  const upDone = plugins.finishInstall(upd, { scope: upd.scope, cwd: proj, force: true });
  check('plugin: update replaces the files', upDone.ok && plugins.listPlugins(proj)[0].version === '0.2.0');
  check('plugin: an instruction path that leaves the plugin folder is ignored', plugins.instructionBlocks(proj).length === 1 && !/outside/.test(plugins.instructionBlocks(proj)[0].text));

  const projDone = await plugins.installPlugin(made.dir, { scope: 'project', cwd: proj });
  check('plugin: a project install overrides the user one of the same name', projDone.ok && plugins.listPlugins(proj).find((p) => p.name === 'demo-kit').scope === 'project' && plugins.listPlugins(null).find((p) => p.name === 'demo-kit').scope === 'user');

  const gh = plugins.parseSource('acme/tools#v2');
  check('plugin: sources are understood', gh.url === 'https://github.com/acme/tools.git' && gh.ref === 'v2'
    && plugins.parseSource('https://example.com/x.git').kind === 'git' && !!plugins.parseSource('http://example.com/x.git').error
    && !!plugins.parseSource('not a source').error && !!plugins.parseSource('acme/tools#--upload-pack=x').error);
  const empty = path.join(tmp, 'plugin-empty');
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, 'README.md'), 'nothing here');
  check('plugin: a folder with nothing to install is refused', !(await plugins.prepareInstall(empty)).ok);
  check('plugin: remove deletes it', plugins.removePlugin('demo-kit', proj).ok && plugins.removePlugin('demo-kit', proj).ok && !plugins.listPlugins(proj).length && !plugins.removePlugin('demo-kit', proj).ok);

  process.env.USERPROFILE = realHome.USERPROFILE;
  if (realHome.HOME === undefined) delete process.env.HOME; else process.env.HOME = realHome.HOME;
}

// ── GitHub agent ──
{
  const gh = await import(pathToFileURL(path.join(CLI, 'lib/github-agent.mjs')).href);
  const { execFileSync } = await import('child_process');
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

  const issueEv = (body, assoc = 'MEMBER', extra = {}) => ({
    action: 'created', repository: { full_name: 'o/r', default_branch: 'main' },
    issue: { number: 7, title: 'Add a greeting', body: 'We need a greeting file.', ...extra.issue },
    comment: { id: 55, body, user: { login: 'alice', type: 'User' }, author_association: assoc },
  });

  const p1 = gh.parseEvent('issue_comment', issueEv('/codeply add hello.txt'));
  check('github: a /codeply comment on an issue is a build request', p1.kind === 'issue' && p1.mode === 'Build' && p1.prompt === 'add hello.txt' && p1.number === 7, JSON.stringify(p1));
  check('github: "ask" and "plan" pick the read-only modes', gh.parseEvent('issue_comment', issueEv('/codeply ask why is it slow?')).mode === 'Ask'
    && gh.parseEvent('issue_comment', issueEv('@codeply plan the migration')).mode === 'Plan'
    && gh.parseEvent('issue_comment', issueEv('/craft plan the migration')).prompt === 'the migration');
  check('github: comments without the trigger, bots and outsiders are skipped', !!gh.parseEvent('issue_comment', issueEv('looks good')).skip
    && !!gh.parseEvent('issue_comment', issueEv('/codeply fix', 'NONE')).skip
    && !!gh.parseEvent('issue_comment', { ...issueEv('/codeply fix'), comment: { ...issueEv('/codeply fix').comment, user: { login: 'dependabot[bot]', type: 'Bot' } } }).skip
    && !!gh.parseEvent('push', { action: 'created' }).skip
    && !gh.parseEvent('issue_comment', issueEv('/codeply fix', 'CONTRIBUTOR'), { allowed: ['CONTRIBUTOR'] }).skip);
  check('github: a comment on a pull request is a pr request', gh.parseEvent('issue_comment', issueEv('/codeply review', 'OWNER', { issue: { pull_request: {} } })).kind === 'pr');

  const okRoute = gh.routeFromEnv({ CODEPLY_PROVIDER: 'anthropic', CODEPLY_API_KEY: 'k' });
  check('github: the model route comes from the environment', okRoute.route && okRoute.route.custom.baseUrl.includes('anthropic') && !!gh.routeFromEnv({ CODEPLY_PROVIDER: 'nope', CODEPLY_API_KEY: 'k' }).error
    && !!gh.routeFromEnv({}).error && !!gh.routeFromEnv({ CODEPLY_PROVIDER: 'openai' }).error
    && !gh.routeFromEnv({ CODEPLY_BASE_URL: 'http://localhost:11434/v1', CODEPLY_MODEL: 'llama3' }).error);

  const approve = gh.ciApprove(tmp);
  check('github: the agent cannot push or call gh, or run dangerous commands',
    (await approve({ tool: 'run', detail: 'git push origin main', title: 'Run git push' })) === 'reject'
    && (await approve({ tool: 'run', detail: 'npm test && git -C . push', title: 'x' })) === 'reject'
    && (await approve({ tool: 'run', detail: 'gh pr merge 1', title: 'x' })) === 'reject'
    && (await approve({ tool: 'run', detail: 'rm -rf /', title: 'x', danger: true })) === 'reject'
    && (await approve({ tool: 'run', detail: 'npm test', title: 'Run npm test' })) === 'once'
    && (await approve({ tool: 'write_file', detail: 'a.txt', title: 'Write a.txt' })) === 'once');

  // A fake GitHub API and a local bare remote.
  const calls = [];
  const comments = new Map();
  let nextId = 1000;
  let blockPrs = false;
  let prInfo = { head: { ref: 'feature', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: u.pathname, body, auth: init.headers && init.headers.Authorization });
    const reply = (status, json) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) });
    let m;
    if ((m = /^\/repos\/o\/r\/(issues|pulls)\/comments\/\d+\/reactions$/.exec(u.pathname))) return reply(201, {});
    if (init.method === 'POST' && (m = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(u.pathname))) { const id = nextId++; comments.set(id, body.body); return reply(201, { id }); }
    if (init.method === 'PATCH' && (m = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(u.pathname))) { comments.set(Number(m[1]), body.body); return reply(200, {}); }
    if (init.method === 'GET' && /^\/repos\/o\/r\/pulls\/\d+$/.test(u.pathname)) return reply(200, prInfo);
    if (init.method === 'POST' && u.pathname === '/repos/o/r/pulls') return blockPrs ? reply(403, { message: 'GitHub Actions is not permitted to create or approve pull requests.' }) : reply(201, { html_url: 'https://github.com/o/r/pull/99' });
    return reply(404, { message: 'not found' });
  };
  const lastComment = () => [...comments.values()].pop() || '';

  const bare = path.join(tmp, 'gh-remote.git');
  const work = path.join(tmp, 'gh-work');
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  sh(bare, 'init', '--bare');
  sh(work, 'init');
  fs.writeFileSync(path.join(work, 'README.md'), '# demo\n');
  sh(work, 'add', '-A');
  sh(work, ...ident, 'commit', '-m', 'init');
  sh(work, 'remote', 'add', 'origin', bare);
  sh(work, 'push', 'origin', 'HEAD:refs/heads/main');
  sh(work, 'push', 'origin', 'HEAD:refs/heads/feature');
  const baseBranch = sh(work, 'rev-parse', '--abbrev-ref', 'HEAD');
  const reset = () => { sh(work, 'checkout', '-f', baseBranch); calls.length = 0; comments.clear(); };
  const env = { GITHUB_RUN_ID: '424242', GITHUB_API_URL: 'https://api.test', GITHUB_SERVER_URL: 'https://github.test' };
  let runNo = 0;
  const go = (ev, name = 'issue_comment', replies = [], extra = {}) => {
    script = [...replies];
    env.GITHUB_RUN_ID = String(424242 + runNo++);
    return gh.runGithubAgent({ eventName: name, event: ev, cwd: work, token: 'TOK', route, env, fetchImpl: fakeFetch, maxSteps: 8, ...extra });
  };

  const r1 = await go(issueEv('/codeply add hello.txt'), 'issue_comment', [
    '<codeply:write_file>\n<path>hello.txt</path>\n<content>\nhello world\n</content>\n</codeply:write_file>',
    'Added hello.txt with a greeting.',
  ]);
  const branches = sh(bare, 'branch', '--list', 'codeply/*');
  const prCall = calls.find((c) => c.path === '/repos/o/r/pulls' && c.method === 'POST');
  check('github: an issue request commits to a new branch and opens a pull request', r1.status === 'pr' && /codeply\/issue-7-add-a-greeting/.test(branches) && prCall && prCall.body.head.startsWith('codeply/issue-7') && prCall.body.base === 'main' && /Closes #7/.test(prCall.body.body), JSON.stringify({ r1, branches, prCall }));
  const branchName = branches.replace('*', '').trim().split('\n')[0].trim();
  check('github: the pushed commit has the file and the bot identity', sh(bare, 'show', `${branchName}:hello.txt`).includes('hello world') && sh(bare, 'log', '-1', '--format=%an', branchName) === 'codeply[bot]');
  check('github: it reacts to the comment and updates one status comment', calls.some((c) => c.path.endsWith('/comments/55/reactions')) && comments.size === 1 && /pull\/99/.test(lastComment()) && /actions\/runs\/424242/.test(lastComment()), lastComment());
  check('github: the token is used for the API but never written into the repo', calls.every((c) => !c.auth || c.auth === 'Bearer TOK') && !sh(work, 'config', '--local', '--list').includes('TOK'));

  reset();
  const branchesBefore = sh(bare, 'branch', '--list').split('\n').length;
  const r2 = await go(issueEv('/codeply ask what is in this repo?'), 'issue_comment', ['It is a small demo repository.']);
  check('github: ask mode answers in a comment and changes nothing', r2.status === 'answered' && /small demo/.test(lastComment()) && !calls.some((c) => c.path === '/repos/o/r/pulls' && c.method === 'POST') && sh(bare, 'branch', '--list').split('\n').length === branchesBefore && !sh(work, 'status', '--porcelain'));

  reset();
  const r3 = await go(issueEv('/codeply add pr.txt', 'OWNER', { issue: { pull_request: {}, title: 'PR title' } }), 'issue_comment', [
    '<codeply:write_file>\n<path>pr.txt</path>\n<content>\nfrom the agent\n</content>\n</codeply:write_file>',
    'Added pr.txt.',
  ]);
  check('github: a comment on a pull request pushes to its branch and opens nothing new', r3.status === 'pushed' && sh(bare, 'show', 'feature:pr.txt').includes('from the agent') && !calls.some((c) => c.path === '/repos/o/r/pulls' && c.method === 'POST'), JSON.stringify(r3));

  reset();
  prInfo = { head: { ref: 'forkbranch', repo: { full_name: 'stranger/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const r4 = await go(issueEv('/codeply add x.txt', 'OWNER', { issue: { pull_request: {} } }), 'issue_comment', ['I would not change anything from a fork.']);
  check('github: pull requests from forks are answered read-only', r4.status === 'answered' && !sh(bare, 'branch', '--list', 'forkbranch') && !sh(work, 'status', '--porcelain'), JSON.stringify(r4));
  prInfo = { head: { ref: 'feature', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };

  reset();
  const r5 = await go(issueEv('please help', 'MEMBER'));
  const r6 = await go(issueEv('/codeply fix it', 'NONE'));
  check('github: skipped events touch nothing on GitHub', r5.status === 'skipped' && r6.status === 'skipped' && calls.length === 0);

  reset();
  const r7 = await go(issueEv('/codeply add z.txt'), 'issue_comment', [], { runAgentImpl: async function* () { throw new Error('model unreachable'); } });
  check('github: a failed run says so in the comment instead of going silent', r7.status === 'failed' && /model unreachable/.test(lastComment()));

  reset();
  const r8 = await go(issueEv('/codeply look around'), 'issue_comment', ['I looked around; there is nothing to change.']);
  check('github: a build that changes no files posts the answer and opens no pull request', r8.status === 'answered' && !calls.some((c) => c.path === '/repos/o/r/pulls' && c.method === 'POST'));

  reset();
  blockPrs = true;
  const r9 = await go(issueEv('/codeply add blocked.txt'), 'issue_comment', [
    '<codeply:write_file>\n<path>blocked.txt</path>\n<content>\nstill pushed\n</content>\n</codeply:write_file>',
    'Added blocked.txt.',
  ]);
  blockPrs = false;
  check('github: when Actions may not open pull requests, the branch is pushed and the reply links a one-click PR',
    r9.status === 'pushed' && /compare\/main\.\.\.codeply%2Fissue-7/.test(r9.url) && /Open the pull request/.test(lastComment()) && /Allow GitHub Actions to create/.test(lastComment()), JSON.stringify(r9));

  reset();
  let agentRan = false;
  const noAgent = { setupError: 'Set the CODEPLY_API_KEY secret.', runAgentImpl: async function* () { agentRan = true; } };
  const r10 = await go(issueEv('/codeply fix it'), 'issue_comment', [], noAgent);
  const r11 = await go(issueEv('nice work'), 'issue_comment', [], noAgent);
  check('github: a setup error is posted on the issue, but only for real /codeply requests',
    r10.status === 'failed' && /can't start yet: Set the CODEPLY_API_KEY/.test(lastComment()) && !agentRan && r11.status === 'skipped' && comments.size === 1);

  const bomKey = gh.routeFromEnv({ CODEPLY_PROVIDER: 'ollama', CODEPLY_API_KEY: '﻿abc.def\r\n' });
  check('github: keys lose a pasted BOM or newline, and ollama is a preset', bomKey.route && bomKey.route.custom.apiKey === 'abc.def' && bomKey.route.custom.baseUrl === 'https://ollama.com/v1'
    && !!gh.routeFromEnv({ CODEPLY_PROVIDER: 'ollama', CODEPLY_API_KEY: '﻿' }).error);

  const wfDir = path.join(tmp, 'gh-wf');
  fs.mkdirSync(wfDir, { recursive: true });
  const wf1 = gh.installWorkflow(wfDir);
  const yml = fs.readFileSync(wf1.file, 'utf8');
  check('github: the workflow file is written once, with credentials not persisted', wf1.ok && /persist-credentials: false/.test(yml) && /github run/.test(yml) && !gh.installWorkflow(wfDir).ok);
}

// ── Craft Cloud ──
{
  const cl = await import(pathToFileURL(path.join(CLI, 'lib/cloud.mjs')).href);
  const nacl = require(path.join(CLI, 'node_modules/tweetnacl'));
  const { execFileSync } = await import('child_process');
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  check('cloud: key scanner flags real keys but not public ones',
    cl.findSecret(`const k = "sk-ant-${'a'.repeat(30)}";`) === 'Anthropic key'
    && cl.findSecret(`x = "ghp_${'b'.repeat(36)}"`) === 'GitHub token'
    && cl.findSecret(`jwt = "eyJhbGciOiJIUzI1NiJ9.${b64u({ role: 'service_role' })}.signature123"`) === 'Supabase service_role key'
    && cl.findSecret(`anon = "eyJhbGciOiJIUzI1NiJ9.${b64u({ role: 'anon' })}.signature123"`) === null
    && cl.findSecret('const token = process.env.GITHUB_TOKEN; const apiKey = config.apiKey;') === null);

  const kp = nacl.box.keyPair();
  const sealed = cl.sealSecret(Buffer.from(kp.publicKey).toString('base64'), 'my-model-key');
  check('cloud: secrets are sealed the way GitHub expects (libsodium sealed box)', cl.openSealed(sealed, kp.publicKey, kp.secretKey) === 'my-model-key' && !sealed.includes('my-model-key'));

  check('cloud: models on this PC or without a key are refused for cloud runs',
    !!cl.cloudModelConfig({ kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' }).error
    && !!cl.cloudModelConfig({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt', apiKey: '' }).error
    && !!cl.cloudModelConfig(null).error
    && cl.cloudModelConfig({ kind: 'ollama', baseUrl: 'https://ollama.com/api', model: 'gemma4:31b', apiKey: 'k' }).baseUrl === 'https://ollama.com');

  check('cloud: the workflow starts only from Craft and never splices inputs into the shell',
    /workflow_dispatch/.test(cl.CLOUD_WORKFLOW) && !/issue_comment|pull_request|push:/.test(cl.CLOUD_WORKFLOW)
    && !/run:[^\n]*\$\{\{\s*inputs/.test(cl.CLOUD_WORKFLOW) && /persist-credentials: false/.test(cl.CLOUD_WORKFLOW) && /checks: write/.test(cl.CLOUD_WORKFLOW));

  // A fake GitHub: repos, secrets, variables, dispatches, runs, check runs, contents.
  const G = { repos: new Map(), secrets: new Map(), vars: new Map(), dispatches: [], runs: [], checks: [], files: new Map(), refs: new Set(), calls: [] };
  const fetchCloud = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    G.calls.push({ method, p, body, auth: init.headers && init.headers.Authorization });
    const reply = (status, json, headers = {}) => ({ ok: status < 400, status, text: async () => (json == null ? '' : JSON.stringify(json)), headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
    let m;
    if (p === '/user') return reply(200, { login: 'me' }, { 'x-oauth-scopes': 'repo, workflow, gist' });
    if (method === 'POST' && p === '/user/repos') { const full = `me/${body.name}`; G.repos.set(full, { full_name: full, private: body.private, description: body.description }); return reply(201, G.repos.get(full)); }
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p))) return G.repos.has(m[1]) ? reply(200, G.repos.get(m[1])) : reply(404, { message: 'Not Found' });
    if ((m = /\/actions\/secrets\/public-key$/.exec(p))) return reply(200, { key: Buffer.from(kp.publicKey).toString('base64'), key_id: 'kid1' });
    if (method === 'PUT' && (m = /\/actions\/secrets\/(\w+)$/.exec(p))) { G.secrets.set(m[1], body); return reply(201, null); }
    if (method === 'PATCH' && (m = /\/actions\/variables\/(\w+)$/.exec(p))) { if (!G.vars.has(m[1])) return reply(404, { message: 'Not Found' }); G.vars.set(m[1], body.value); return reply(204, null); }
    if (method === 'POST' && /\/actions\/variables$/.test(p)) { G.vars.set(body.name, body.value); return reply(201, null); }
    if (method === 'POST' && /\/actions\/workflows\/craft-cloud\.yml\/dispatches$/.test(p)) {
      G.dispatches.push(body);
      G.runs.push({ id: 7000 + G.runs.length, display_title: `craft ${body.inputs.task_id}`, head_sha: sh(bare, 'rev-parse', 'main'), status: 'in_progress', conclusion: null, html_url: 'https://github.test/run' });
      return reply(204, null);
    }
    if (/\/actions\/workflows\/craft-cloud\.yml\/runs$/.test(p)) return reply(200, { workflow_runs: [...G.runs].reverse() });
    if ((m = /\/actions\/runs\/(\d+)$/.exec(p))) return reply(200, G.runs.find((r) => r.id === Number(m[1])));
    if (method === 'POST' && /\/check-runs$/.test(p)) { const c = { id: 900 + G.checks.length, ...body }; G.checks.push(c); return reply(201, c); }
    if (method === 'PATCH' && (m = /\/check-runs\/(\d+)$/.exec(p))) { const c = G.checks.find((x) => x.id === Number(m[1])); Object.assign(c, body, { output: { ...c.output, ...body.output } }); return reply(200, c); }
    if ((m = /\/commits\/([0-9a-f]+)\/check-runs$/.exec(p))) return reply(200, { check_runs: G.checks.filter((c) => c.head_sha === m[1] && c.name === u.searchParams.get('check_name')) });
    if ((m = /\/git\/ref\/heads\/(.+)$/.exec(p))) return G.refs.has(m[1]) ? reply(200, { ref: m[1] }) : reply(404, { message: 'Not Found' });
    if (method === 'POST' && /\/git\/refs$/.test(p)) { G.refs.add(body.ref.replace('refs/heads/', '')); return reply(201, {}); }
    if (method === 'POST' && /\/merges$/.test(p)) { G.merges = [...(G.merges || []), body]; return reply(201, { sha: 'mergedsha' }); }
    if ((m = /\/contents\/(.+)$/.exec(p))) {
      const key = `${u.searchParams.get('ref') || (body && body.branch)}:${decodeURIComponent(m[1])}`;
      if (method === 'GET' && !G.files.has(key)) {
        const kids = [...G.files.keys()].filter((k) => k.startsWith(`${key}/`));
        if (kids.length) return reply(200, kids.map((k) => ({ name: k.slice(key.length + 1), path: k.slice(k.indexOf(':') + 1), sha: G.files.get(k).sha })));
      }
      if (method === 'DELETE') { G.files.delete(key); return reply(200, {}); }
      if (method === 'GET') return G.files.has(key) ? reply(200, { content: G.files.get(key).content, sha: G.files.get(key).sha }) : reply(404, { message: 'Not Found' });
      if (method === 'PUT') {
        if (!G.refs.has(body.branch)) return reply(404, { message: 'Branch not found' });
        const cur = G.files.get(key);
        if (cur && cur.sha !== body.sha) return reply(409, { message: 'sha mismatch' });
        G.files.set(key, { content: body.content, sha: `s${Math.random().toString(36).slice(2)}` });
        return reply(201, {});
      }
    }
    return reply(404, { message: `no fake for ${method} ${p}` });
  };

  const home = path.join(tmp, 'cloud-home');
  const bare = path.join(tmp, 'cloud-remote.git');
  const proj = path.join(tmp, 'cloud-proj');
  fs.mkdirSync(path.join(proj, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'dist'), { recursive: true });
  fs.mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '-q', '--bare');
  fs.writeFileSync(path.join(proj, 'index.js'), 'console.log("hi");\n');
  fs.writeFileSync(path.join(proj, 'other.txt'), 'one\n');
  fs.writeFileSync(path.join(proj, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(proj, 'dist', 'bundle.js'), 'built\n');
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET=hunter2\n');
  fs.writeFileSync(path.join(proj, '.env.example'), 'SECRET=\n');
  fs.writeFileSync(path.join(proj, 'creds.js'), `module.exports = "sk-ant-${'x'.repeat(30)}";\n`);
  fs.writeFileSync(path.join(proj, '.github', 'workflows', 'deploy.yml'), 'on: push\n');
  sh(proj, 'init', '-q');
  sh(proj, 'add', 'index.js', '.gitignore');
  sh(proj, ...ident, 'commit', '-q', '-m', 'mine');
  const projHead = sh(proj, 'rev-parse', 'HEAD');
  const projStatus = sh(proj, 'status', '--porcelain');

  const model = { id: 'm1', name: 'Ollama cloud', kind: 'ollama', baseUrl: 'https://ollama.com', model: 'gemma4:31b', apiKey: 'OLLAMA-KEY-1' };
  const common = { home, apiUrl: 'https://api.test', serverUrl: 'https://github.test', fetchImpl: fetchCloud, remoteUrl: bare };
  const setup = await cl.setupCloud({ cwd: proj, token: 'TOK', model, ...common });
  const repo = 'me/craft-workspace-cloud-proj';
  check('cloud: setup creates a private mirror repo', setup.repo === repo && setup.created && G.repos.get(repo).private === true, JSON.stringify(setup));
  const sec = G.secrets.get('CODEPLY_API_KEY');
  check('cloud: the model key is stored only as an encrypted secret', sec && sec.key_id === 'kid1' && cl.openSealed(sec.encrypted_value, kp.publicKey, kp.secretKey) === 'OLLAMA-KEY-1'
    && G.vars.get('CODEPLY_MODEL_KIND') === 'ollama' && G.vars.get('CODEPLY_MODEL') === 'gemma4:31b' && G.vars.get('CODEPLY_BASE_URL') === 'https://ollama.com'
    && ![...G.vars.values()].some((v) => v.includes('OLLAMA-KEY')));
  const mirrored = sh(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  check('cloud: the snapshot respects .gitignore and leaves out .env, key files and your own workflows',
    ['index.js', 'other.txt', '.gitignore', '.env.example', '.github/workflows/craft-cloud.yml'].every((f) => mirrored.includes(f))
    && !['.env', 'creds.js', 'dist/bundle.js', '.github/workflows/deploy.yml'].some((f) => mirrored.includes(f))
    && setup.skipped.some((s) => s.path === 'creds.js' && /Anthropic/.test(s.reason)), mirrored.join(','));
  check('cloud: the project\'s own git is never touched', sh(proj, 'rev-parse', 'HEAD') === projHead && sh(proj, 'status', '--porcelain') === projStatus && !fs.existsSync(path.join(proj, '.codeply')));
  check('cloud: the push token never lands in the mirror git config', !fs.readFileSync(path.join(home, 'cloud', fs.readdirSync(path.join(home, 'cloud'))[0], 'config'), 'utf8').includes('TOK'));

  const again = await cl.pushSnapshot({ cwd: proj, token: 'TOK', ...common });
  check('cloud: an unchanged folder is not pushed again', again.pushed === false);

  const task = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'add a greeting', mode: 'Build', sessionId: 'chat1', model, ...common, retryMs: 1 });
  const disp = G.dispatches.at(-1);
  check('cloud: a run dispatches the workflow with the task', disp && disp.ref === 'main' && disp.inputs.prompt === 'add a greeting' && disp.inputs.task_id === task.id && disp.inputs.session_id === 'chat1' && task.baseSha === sh(bare, 'rev-parse', 'main'));

  // The runner, as GitHub Actions would start it: a fresh checkout of the mirror.
  const runnerDir = path.join(tmp, 'cloud-runner');
  sh(tmp, 'clone', '-q', '-b', 'main', bare, runnerDir);
  let seenHistory = null;
  const agent = (writes) => async function* ({ cwd, history }) {
    seenHistory = history;
    for (const [f, text] of writes) fs.writeFileSync(path.join(cwd, f), text);
    for (const [f] of writes) yield { type: 'tool_end', name: 'write_file', args: { path: f }, ok: true };
    yield { type: 'text', text: writes.length ? 'Added a greeting.' : 'It prints hi.' };
    yield { type: 'done' };
  };
  const runnerEnv = (t, prompt, mode) => ({ GITHUB_REPOSITORY: repo, GITHUB_SHA: t.baseSha, GITHUB_API_URL: 'https://api.test', GITHUB_SERVER_URL: 'https://github.test', CRAFT_TASK_ID: t.id, CRAFT_PROMPT: prompt, CRAFT_MODE: mode, CRAFT_SESSION_ID: 'chat1', GITHUB_RUN_ID: '7000' });
  const out = await cl.runCloudRunner({ env: runnerEnv(task, 'add a greeting', 'Build'), cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 0, browserImpl: null,
    runAgentImpl: agent([['greet.js', 'module.exports = "hello";\n'], ['index.js', 'console.log("hi");\nconsole.log(require("./greet"));\n']]) });
  const chk = G.checks.find((c) => c.name === `craft ${task.id}`);
  check('cloud: the runner pushes changes to a task branch and reports in a check run',
    out.status === 'done' && /^craft\/add-a-greeting-[0-9a-z]{6}$/.test(out.result.branch) && sh(bare, 'show', `${out.result.branch}:greet.js`).includes('hello')
    && chk && chk.status === 'completed' && chk.conclusion === 'success' && JSON.parse(chk.output.text).files.includes('greet.js'), JSON.stringify(out));
  const chkData = JSON.parse(chk.output.text);
  const toolEv = (chkData.events || []).find((e) => e.t === 'tool' && e.args && e.args.path === 'greet.js');
  const pushedEv = (chkData.events || []).find((e) => e.t === 'pushed');
  check('cloud: the run is published as chat steps: tools with their arguments, then what was pushed with + and - lines',
    toolEv && toolEv.name === 'write_file' && pushedEv && pushedEv.branch === out.result.branch && pushedEv.merged && pushedEv.merged.ok && pushedEv.files.some((f) => f.file === 'greet.js' && f.added === 1)
    && chkData.stats.some((s) => s.file === 'index.js' && s.added === 1 && s.removed === 0) && chkData.answer === 'Added a greeting.', chk.output.text.slice(0, 400));
  const big = Array.from({ length: 300 }, (_, i) => ({ t: 'tool', name: 'edit_file', ok: true, args: { path: `f${i}.js`, search: 'x'.repeat(3000), replace: 'y'.repeat(3000) } }));
  const packed = cl.packEvents(big, 20000);
  check('cloud: a long run is fitted into the check run, keeping the latest steps readable',
    JSON.stringify(packed).length <= 20000 && packed[0].t === 'notice' && /earlier step/.test(packed[0].text) && packed.at(-1).args.path === 'f299.js'
    && cl.recordEvent({ type: 'tool_end', name: 'write_file', args: { path: 'a.js', content: 'secret body' }, ok: true }).args.content === undefined);
  check('cloud: progress shows the steps while it works', /write_file greet\.js/.test(chk.output.summary) || /Added a greeting/.test(chk.output.summary));
  const saved = G.files.get('craft-sessions:sessions/chat1.json');
  check('cloud: the chat is saved for the next run', saved && JSON.parse(Buffer.from(saved.content, 'base64').toString()).messages.length === 2);

  const task2 = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'what does index.js print?', mode: 'Ask', sessionId: 'chat1', ...common, retryMs: 1 });
  await cl.runCloudRunner({ env: runnerEnv(task2, 'what does index.js print?', 'Ask'), cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 0, browserImpl: null, runAgentImpl: agent([]) });
  check('cloud: a follow-up run continues the same chat', Array.isArray(seenHistory) && seenHistory.length === 2 && seenHistory[0].content === 'add a greeting');

  const st = await cl.cloudRunStatus({ cwd: proj, taskId: task.id, token: 'TOK', ...common });
  check('cloud: status reads the finished run', st.status === 'done' && st.result.files.includes('greet.js') && String(st.runId) === '7000', JSON.stringify(st));

  const failTask = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'x', sessionId: '', ...common, retryMs: 1 });
  const failOut = await cl.runCloudRunner({ env: runnerEnv(failTask, 'x', 'Build'), cwd: runnerDir, token: 'TOK', route: null, setupError: 'Set the CODEPLY_API_KEY secret.', fetchImpl: fetchCloud, idleMs: 0, browserImpl: null });
  const failSt = await cl.cloudRunStatus({ cwd: proj, taskId: failTask.id, token: 'TOK', ...common });
  check('cloud: a setup error comes back as a failed task with the reason', failOut.status === 'failed' && failSt.status === 'failed' && /CODEPLY_API_KEY/.test(failSt.error || ''), JSON.stringify(failSt));

  // Meanwhile the user kept working locally; pulling keeps that.
  fs.writeFileSync(path.join(proj, 'other.txt'), 'one\nedited locally\n');
  const pulled = await cl.pullCloudRun({ cwd: proj, taskId: task.id, token: 'TOK', ...common });
  check('cloud: pulling applies the run\'s changes and keeps local edits',
    pulled.applied && !pulled.conflicts.length && fs.readFileSync(path.join(proj, 'greet.js'), 'utf8').includes('hello')
    && fs.readFileSync(path.join(proj, 'index.js'), 'utf8').includes('require("./greet")') && fs.readFileSync(path.join(proj, 'other.txt'), 'utf8').includes('edited locally'), JSON.stringify(pulled));
  check('cloud: pulling never touches the project\'s own git', sh(proj, 'rev-parse', 'HEAD') === projHead && !fs.existsSync(path.join(proj, '.github', 'workflows', 'craft-cloud.yml')));
  check('cloud: a run is applied only once', (await cl.pullCloudRun({ cwd: proj, taskId: task.id, token: 'TOK', ...common })).applied === false);

  // Overlapping edits come back as conflict markers, not lost work.
  const t3 = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'change other', ...common, retryMs: 1 });
  sh(runnerDir, 'fetch', '-q', 'origin', 'main');
  sh(runnerDir, 'checkout', '-q', '-f', 'FETCH_HEAD');
  await cl.runCloudRunner({ env: runnerEnv({ ...t3, baseSha: sh(runnerDir, 'rev-parse', 'HEAD') }, 'change other', 'Build'), cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 0, browserImpl: null,
    runAgentImpl: agent([['other.txt', 'one\nfrom the cloud\n']]) });
  fs.writeFileSync(path.join(proj, 'other.txt'), 'one\nlocal change\n');
  await cl.cloudRunStatus({ cwd: proj, taskId: t3.id, token: 'TOK', ...common });
  const p3 = await cl.pullCloudRun({ cwd: proj, taskId: t3.id, token: 'TOK', ...common });
  const otherNow = fs.readFileSync(path.join(proj, 'other.txt'), 'utf8');
  check('cloud: overlapping edits become conflict markers instead of lost work', p3.conflicts.includes('other.txt') && /<<<<<<<[\s\S]*local change[\s\S]*from the cloud|<<<<<<<[\s\S]*from the cloud[\s\S]*local change/.test(otherNow), JSON.stringify(p3) + otherNow);

  check('cloud: task branches are named after what they do', cl.cloudBranchName('Make the theme white and black please', 'muoj2cb1e01206') === 'craft/make-the-theme-white-and-black-e01206'
    && cl.cloudBranchName('!!!', 'abc123') === 'craft/change-abc123');
  check('cloud: Build work is merged into the base branch after it is pushed', (G.merges || []).some((mg) => mg.base === 'main' && /^craft\/add-a-greeting-/.test(mg.head)));
  const doc1 = JSON.parse(Buffer.from(G.files.get(`craft-sessions:tasks/${task.id}.json`).content, 'base64').toString());
  check('cloud: each task writes a status file with its steps for the PC and the phone', doc1.status === 'done' && doc1.events.some((e) => e.t === 'pushed') && doc1.answer === 'Added a greeting.' && doc1.sessionId === 'chat1');

  // A runner stays up for the chat and takes the next message from the queue instead of a new runner starting.
  const dispatchesBefore = G.dispatches.length;
  const tq1 = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'first in a chat', mode: 'Ask', sessionId: 'chatq', ...common, retryMs: 1 });
  const ranPrompts = [];
  const qAgent = async function* ({ userMessage }) { ranPrompts.push(userMessage.split('\n')[0]); yield { type: 'text', text: `answered: ${userMessage.split('\n')[0]}` }; yield { type: 'done' }; };
  const runnerP = cl.runCloudRunner({ env: { ...runnerEnv(tq1, 'first in a chat', 'Ask'), CRAFT_SESSION_ID: 'chatq' }, cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 10000, pollMs: 50, browserImpl: null, runAgentImpl: qAgent });
  const liveKey = 'craft-sessions:live/chatq.json';
  for (let i = 0; i < 100; i++) {
    const lv = G.files.get(liveKey);
    if (lv && JSON.parse(Buffer.from(lv.content, 'base64').toString()).busy === false) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const tq2 = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'second in the same chat', mode: 'Ask', sessionId: 'chatq', ...common, retryMs: 1 });
  const qOut = await runnerP;
  const st2 = await cl.cloudRunStatus({ cwd: proj, taskId: tq2.id, token: 'TOK', ...common });
  check('cloud: a follow-up goes to the runner that is still up, not a new runner', tq2.queued === true && G.dispatches.length === dispatchesBefore + 1
    && qOut.results.length === 2 && ranPrompts.join('|') === 'first in a chat|second in the same chat' && st2.status === 'done' && /second in the same chat/.test(st2.result.answer), JSON.stringify({ q: tq2.queued, d: G.dispatches.length - dispatchesBefore, r: ranPrompts, st2 }));
  check('cloud: the runner leaves after idling and clears its live mark', !G.files.has(liveKey) && ![...G.files.keys()].some((k) => k.startsWith('craft-sessions:queue/chatq/')));

  // Repo mode: the project's own GitHub repo, the workflow committed there, the PC pulls merged work.
  const realBare = path.join(tmp, 'real-app.git');
  const realProj = path.join(tmp, 'real-app');
  fs.mkdirSync(realBare, { recursive: true });
  sh(realBare, 'init', '-q', '--bare', '-b', 'main');
  sh(tmp, 'clone', '-q', realBare, realProj);
  fs.writeFileSync(path.join(realProj, 'app.js'), 'v1\n');
  sh(realProj, 'add', '-A'); sh(realProj, ...ident, 'commit', '-q', '-m', 'v1'); sh(realProj, 'push', '-q', 'origin', 'HEAD:main');
  sh(realProj, 'branch', '-q', '--set-upstream-to=origin/main');
  sh(realProj, 'remote', 'set-url', '--push', 'origin', realBare);
  sh(realProj, 'config', 'remote.origin.url', 'https://github.com/me/real-app.git');
  G.repos.set('me/real-app', { full_name: 'me/real-app', private: true, default_branch: 'main', permissions: { push: true } });
  G.refs.add('main');
  check('cloud: the GitHub origin of a project is found', (await cl.githubOrigin(realProj)) === 'me/real-app');
  const setupR = await cl.setupCloud({ cwd: realProj, token: 'TOK', model, envText: 'DATABASE_URL=postgres://x\nAPI_TOKEN=abc', ...common });
  const wf = G.files.get('main:.github/workflows/craft-cloud.yml');
  check('cloud: repo mode commits the workflow to the default branch and stores the environment as a secret',
    setupR.kind === 'repo' && setupR.repo === 'me/real-app' && wf && Buffer.from(wf.content, 'base64').toString() === cl.CLOUD_WORKFLOW
    && cl.openSealed(G.secrets.get('CRAFT_ENV').encrypted_value, kp.publicKey, kp.secretKey) === 'DATABASE_URL=postgres://x\nAPI_TOKEN=abc', JSON.stringify(setupR));
  sh(realProj, 'config', 'remote.origin.url', realBare);
  const other = path.join(tmp, 'real-app-cloud');
  sh(tmp, 'clone', '-q', realBare, other);
  fs.writeFileSync(path.join(other, 'app.js'), 'v2 from the cloud\n');
  sh(other, 'add', '-A'); sh(other, ...ident, 'commit', '-q', '-m', 'Merge craft/make-it-v2-abc123'); sh(other, 'push', '-q', 'origin', 'HEAD:main');
  fs.writeFileSync(path.join(realProj, 'notes.txt'), 'my local note\n');
  const behind = await cl.checkBehind(realProj);
  check('cloud: before coding, the PC sees it is behind GitHub', behind.ok && behind.behind === 1 && behind.ahead === 0 && /make-it-v2/.test(behind.latest), JSON.stringify(behind));
  const pulledR = await cl.pullLatest(realProj);
  check('cloud: pulling brings the merged cloud work down and keeps local files', pulledR.pulled === 1 && fs.readFileSync(path.join(realProj, 'app.js'), 'utf8').includes('from the cloud')
    && fs.readFileSync(path.join(realProj, 'notes.txt'), 'utf8').includes('my local note') && (await cl.checkBehind(realProj)).behind === 0);

  let snapRefused = false;
  try { await cl.pushSnapshot({ cwd: realProj, token: 'TOK', ...common }); } catch (e) { snapRefused = /own repo/.test(e.message); }
  check('cloud: a project working in its own repo is never backed up over its main', snapRefused);
  fs.writeFileSync(path.join(realProj, 'app.js'), 'local v3\n');
  sh(realProj, 'add', 'app.js'); sh(realProj, ...ident, 'commit', '-q', '-m', 'local v3');
  sh(other, 'pull', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(other, 'app.js'), 'cloud v3\n');
  sh(other, 'add', '-A'); sh(other, ...ident, 'commit', '-q', '-m', 'cloud v3'); sh(other, 'push', '-q', 'origin', 'HEAD:main');
  let clashMsg = '';
  try { await cl.pullLatest(realProj); } catch (e) { clashMsg = e.message; }
  check('cloud: a pull that clashes is undone and says which files', /clash/.test(clashMsg) && /app\.js/.test(clashMsg)
    && !fs.existsSync(path.join(realProj, '.git', 'MERGE_HEAD')) && fs.readFileSync(path.join(realProj, 'app.js'), 'utf8').replace(/\r\n/g, '\n') === 'local v3\n', clashMsg); // core.autocrlf may re-checkout with CRLF

  // The cloud runner writes the environment to .env and never commits it.
  const envRunner = path.join(tmp, 'env-runner');
  sh(tmp, 'clone', '-q', '-b', 'main', bare, envRunner);
  const te = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'use the env', ...common, retryMs: 1 });
  let sawEnv = '';
  await cl.runCloudRunner({ env: { ...runnerEnv({ ...te, baseSha: sh(envRunner, 'rev-parse', 'HEAD') }, 'use the env', 'Build'), CRAFT_SESSION_ID: '', CRAFT_ENV: 'SECRET_X=42' }, cwd: envRunner, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 0, browserImpl: null,
    runAgentImpl: async function* ({ cwd }) { sawEnv = fs.readFileSync(path.join(cwd, '.env'), 'utf8'); fs.writeFileSync(path.join(cwd, 'used.txt'), 'ok\n'); yield { type: 'tool_end', name: 'write_file', args: { path: 'used.txt' }, ok: true }; yield { type: 'text', text: 'done' }; yield { type: 'done' }; } });
  const envDoc = JSON.parse(Buffer.from(G.files.get(`craft-sessions:tasks/${te.id}.json`).content, 'base64').toString());
  check('cloud: the environment is a .env on the cloud machine and is never committed', sawEnv.trim() === 'SECRET_X=42' && envDoc.files.includes('used.txt') && !envDoc.files.includes('.env'), JSON.stringify(envDoc.files));

  // Screenshots from the cloud browser are uploaded and linked from the step.
  const shotTask = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'check the page', mode: 'Ask', ...common, retryMs: 1 });
  const pngFile = path.join(tmp, 'fake-shot.png');
  fs.writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await cl.runCloudRunner({ env: { ...runnerEnv(shotTask, 'check the page', 'Ask'), CRAFT_SESSION_ID: '' }, cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 0,
    browserImpl: async () => ({ ok: true, title: 'x', screenshotPath: pngFile }),
    runAgentImpl: async function* ({ browser }) { await browser('http://localhost:3000', {}); yield { type: 'tool_end', name: 'browser_check', args: { url: 'http://localhost:3000' }, ok: true }; yield { type: 'text', text: 'looks fine' }; yield { type: 'done' }; } });
  const shotDoc = JSON.parse(Buffer.from(G.files.get(`craft-sessions:tasks/${shotTask.id}.json`).content, 'base64').toString());
  const shotEv = shotDoc.events.find((e) => e.name === 'browser_check');
  check('cloud: browser checks in the cloud upload their screenshot and the step links it', shotEv && shotEv.screenshot === `shots/${shotTask.id}/1.png` && G.files.has(`craft-sessions:shots/${shotTask.id}/1.png`), JSON.stringify(shotEv));
}

// ── Sharing a chat ──
{
  const share = require(path.join(CLI, 'lib/share.js'));
  const proj = path.join(os.homedir(), 'secret-project');
  const session = {
    title: 'Fix <b>login</b>', cwd: proj, updatedAt: Date.UTC(2026, 8, 30),
    messages: [
      { kind: 'user', text: `my key is sk-abcdefghijklmnopqrstuvwx and it lives in ${proj}\\src` },
      { kind: 'assistant', text: 'Looking around.', interim: true },
      { kind: 'reasoning', text: 'private chain of thought' },
      { kind: 'tool', name: 'read_file', label: `${proj}/src/a.js`, ok: true },
      { kind: 'tool', name: 'run', label: 'npm test', ok: false },
      { kind: 'assistant', text: 'Done.\n\n```js\nif (a < b && x) { alert("<script>") }\n```\n\n- one\n- **two** and `code` [docs](https://example.com/x) [bad](javascript:alert(1))' },
      { kind: 'notice', level: 'error', text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' },
      { kind: 'checkpoint', id: 'c1' },
    ],
  };
  const md = share.toMarkdown(session);
  check('share: markdown hides keys, home and project paths', !/sk-abcdefghijkl/.test(md) && !md.includes(proj) && !md.includes(os.homedir()) && /<project>/.test(md) && /\[hidden\]/.test(md) && !/abcdefghijklmnopqrstuvwxyz0123456789/.test(md), md);
  check('share: markdown leaves out thinking and narration unless asked, keeps tools', !/private chain/.test(md) && !/Looking around/.test(md) && /`run` npm test \(failed\)/.test(md) && /private chain/.test(share.toMarkdown(session, { includeThinking: true })));
  const html = share.toHtml(session);
  check('share: html is escaped and self-contained', !/<script/i.test(html.replace(/<style>[\s\S]*?<\/style>/, '')) && html.includes('&lt;script&gt;') && html.includes('Fix &lt;b&gt;login&lt;/b&gt;') && !/https?:\/\/[^"' ]*\.(css|js)/.test(html) && !/href="javascript:/i.test(html) && /href="https:\/\/example\.com\/x"/.test(html) && /<pre/.test(html) && /<strong>two<\/strong>/.test(html), html.slice(0, 400));
  const posted = [];
  const gistFetch = async (url, init) => { posted.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 201, text: async () => JSON.stringify({ html_url: 'https://gist.github.com/x/1' }) }; };
  const g = await share.createGist(session, 'TOK', { fetchImpl: gistFetch, apiUrl: 'https://api.test' });
  check('share: a gist is secret by default, holds scrubbed markdown and uses the token', g.ok && g.url.includes('gist.github.com') && posted[0].body.public === false && Object.values(posted[0].body.files)[0].content.includes('<project>') && posted[0].init.headers.Authorization === 'Bearer TOK' && posted[0].url === 'https://api.test/gists');
  const bad = await share.createGist(session, 'TOK', { fetchImpl: async () => ({ ok: false, status: 404, text: async () => '{"message":"Not Found"}' }) });
  check('share: a gist failure explains itself', !bad.ok && /Reconnect GitHub/.test(bad.error) && !(await share.createGist(session, '')).ok);
}

// ── Engine server (codeply serve): HTTP API + event stream ──
{
  const { startServer } = await import(pathToFileURL(path.join(CLI, 'lib/server.mjs')).href);
  const dataDir = path.join(tmp, 'serve-data');
  const projDir = path.join(tmp, 'serve-proj');
  fs.mkdirSync(projDir, { recursive: true });
  const srv = await startServer({ port: 0, password: 'pw123', cwd: projDir, dataDir, route });
  const auth = { Authorization: 'Bearer pw123' };
  const api = async (method, p, body, headers = auth) => {
    const r = await fetch(srv.url + p, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  // Follows /event for one chat; `onEvent` may answer prompts. Resolves when it returns 'stop'.
  const watch = (sessionId, onEvent, query = '') => new Promise((resolve) => {
    const ac = new AbortController();
    const events = [];
    const timer = setTimeout(() => { ac.abort(); resolve(events); }, 30000);
    (async () => {
      try {
        const r = await fetch(`${srv.url}/event?session=${sessionId}${query}`, { headers: auth, signal: ac.signal });
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6));
            events.push(ev);
            if ((await onEvent(ev)) === 'stop') { clearTimeout(timer); ac.abort(); resolve(events); return; }
          }
        }
      } catch { clearTimeout(timer); resolve(events); }
    })();
  });
  const runToEnd = async (sid, body, onEvent = () => {}) => {
    const watcher = watch(sid, async (ev) => { await onEvent(ev); if (ev.type === 'run_finished') return 'stop'; });
    await new Promise((r) => setTimeout(r, 50)); // let the stream attach
    const sent = await api('POST', `/session/${sid}/message`, body);
    return { sent, events: await watcher };
  };

  check('serve: /health needs no password', (await api('GET', '/health', null, {})).json?.ok === true);
  check('serve: missing password is refused', (await api('GET', '/session', null, {})).status === 401);
  check('serve: wrong password is refused', (await api('GET', '/session', null, { Authorization: 'Bearer nope' })).status === 401);
  check('serve: ?token= works (for EventSource)', (await fetch(`${srv.url}/session?token=pw123`)).status === 200);
  check('serve: browser origins are refused by default', (await api('GET', '/session', null, { ...auth, Origin: 'https://evil.example' })).status === 403);

  const created = await api('POST', '/session', { title: 'API chat' });
  const sid = created.json?.session?.id;
  check('serve: creates a chat in the given folder', created.status === 201 && created.json.session.cwd === projDir, created.text);

  script = ['Hello from the server.'];
  const a = await runToEnd(sid, { text: 'say hello', mode: 'Ask' });
  check('serve: message returns 202 and the run streams to the end', a.sent.status === 202 && a.events.some((e) => e.type === 'run_started') && a.events.some((e) => e.type === 'done') && a.events.some((e) => e.type === 'run_finished'), JSON.stringify(a.events.map((e) => e.type)));
  const got = await api('GET', `/session/${sid}`);
  check('serve: the chat holds the user and assistant messages', got.json?.session?.messages.some((m) => m.kind === 'user' && m.text === 'say hello') && got.json.session.messages.some((m) => m.kind === 'assistant' && /Hello from the server/.test(m.text)));

  // Approval flow: the write waits for an answer over HTTP.
  script = ['<codeply:write_file>\n<path>served.txt</path>\n<content>\nhi\n</content>\n</codeply:write_file>', 'Wrote it.'];
  let sawApproval = null;
  const b = await runToEnd(sid, { text: 'write served.txt', mode: 'Build' }, async (ev) => {
    if (ev.type === 'approval_request') { sawApproval = ev; await api('POST', `/permission/${ev.requestId}`, { verdict: 'once' }); }
  });
  check('serve: a write asks first, and "once" lets it through', !!sawApproval && /served\.txt/.test(sawApproval.title + sawApproval.detail) && fs.existsSync(path.join(projDir, 'served.txt')), JSON.stringify(sawApproval));
  check('serve: the approval is announced as resolved', b.events.some((e) => e.type === 'approval_resolved' && e.verdict === 'once'));
  check('serve: an answered request cannot be answered twice', (await api('POST', `/permission/${sawApproval.requestId}`, { verdict: 'once' })).status === 404);
  check('serve: Build turns leave an undo checkpoint', b.events.some((e) => e.type === 'checkpoint' && e.checkpoint.files.length >= 1), JSON.stringify(b.events.map((e) => e.type)));

  script = ['<codeply:write_file>\n<path>refused.txt</path>\n<content>\nno\n</content>\n</codeply:write_file>', 'Ok, not writing.'];
  await runToEnd(sid, { text: 'write refused.txt', mode: 'Build' }, async (ev) => {
    if (ev.type === 'approval_request') await api('POST', `/permission/${ev.requestId}`, { verdict: 'reject' });
  });
  check('serve: "reject" keeps the file from being written', !fs.existsSync(path.join(projDir, 'refused.txt')));

  script = ['<codeply:write_file>\n<path>bypassed.txt</path>\n<content>\nyes\n</content>\n</codeply:write_file>', 'Done.'];
  const c2 = await runToEnd(sid, { text: 'write bypassed.txt', mode: 'Build', bypass: true });
  check('serve: bypass writes without asking', fs.existsSync(path.join(projDir, 'bypassed.txt')) && !c2.events.some((e) => e.type === 'approval_request'));

  // Undo the last Build message through the API.
  const cp = c2.events.find((e) => e.type === 'checkpoint');
  const undone = cp ? await api('POST', `/session/${sid}/checkpoint/${cp.checkpoint.id}`, { undo: true }) : { status: 0 };
  check('serve: a message\'s changes can be undone over HTTP', undone.status === 200 && !fs.existsSync(path.join(projDir, 'bypassed.txt')), undone.text);

  // Abort while an approval is pending.
  script = ['<codeply:write_file>\n<path>aborted.txt</path>\n<content>\nx\n</content>\n</codeply:write_file>', 'unused'];
  const d = await runToEnd(sid, { text: 'write aborted.txt', mode: 'Build' }, async (ev) => {
    if (ev.type === 'approval_request') {
      const pend = await api('GET', `/session/${sid}/pending`);
      if (!pend.json.pending.some((p) => p.requestId === ev.requestId)) throw new Error('pending list missing the request');
      await api('POST', `/session/${sid}/abort`);
    }
  });
  check('serve: abort ends a run that is waiting on a prompt', d.events.some((e) => e.type === 'aborted' || e.type === 'run_finished') && !fs.existsSync(path.join(projDir, 'aborted.txt')));
  check('serve: nothing is left pending after the run', (await api('GET', `/session/${sid}/pending`)).json.pending.length === 0);

  check('serve: a second message during a run is refused with 409', await (async () => {
    script = ['<codeply:write_file>\n<path>busy.txt</path>\n<content>\nx\n</content>\n</codeply:write_file>', 'ok'];
    let second = null;
    await runToEnd(sid, { text: 'busy', mode: 'Build' }, async (ev) => {
      if (ev.type === 'approval_request') {
        second = await api('POST', `/session/${sid}/message`, { text: 'again', mode: 'Ask' });
        await api('POST', `/permission/${ev.requestId}`, { verdict: 'reject' });
      }
    });
    return second && second.status === 409;
  })());

  // Question flow.
  script = ['<codeply:ask_user>\n<question>Which colour?</question>\n<options>\nred\nblue\n</options>\n</codeply:ask_user>', 'Going with your pick.'];
  let asked = null;
  await runToEnd(sid, { text: 'pick a colour', mode: 'Ask' }, async (ev) => {
    if (ev.type === 'question_request') { asked = ev; await api('POST', `/question/${ev.requestId}`, { answer: 'blue' }); }
  });
  check('serve: ask_user questions are answered over HTTP', asked && asked.options.join() === 'red,blue' && seen.some((s) => /answered: blue/.test(s)), JSON.stringify({ asked, seen }));

  const replay = await watch(sid, (ev) => (ev.type === 'session_sync' ? 'stop' : undefined), '&after=1');
  check('serve: reconnecting with a last-seen id replays missed events', replay.some((e) => e.type === 'run_finished'), JSON.stringify(replay.map((e) => e.type)));

  const found = await api('GET', '/search?q=hello');
  check('serve: search finds text across chats', srv.storage === 'json' ? found.status === 501 : found.json?.results?.some((r) => r.sessionId === sid), found.text);
  const md = await api('GET', `/session/${sid}/export`);
  check('serve: a chat exports as markdown', md.status === 200 && /## You/.test(md.text) && /Hello from the server/.test(md.text));
  const htmlExp = await api('GET', `/session/${sid}/export?format=html`);
  check('serve: a chat exports as a web page', htmlExp.status === 200 && /<!doctype html>/.test(htmlExp.text) && /Hello from the server/.test(htmlExp.text));
  check('serve: rename works', (await api('PATCH', `/session/${sid}`, { title: 'Renamed' })).json?.session?.title === 'Renamed');

  await srv.close();
  const srv2 = await startServer({ port: 0, password: 'pw123', cwd: projDir, dataDir, route });
  srv.url = srv2.url;
  const again = await api('GET', '/session');
  check('serve: chats survive a restart', again.json?.sessions.some((s) => s.id === sid && s.title === 'Renamed'), again.text);
  check('serve: a deleted chat is gone', (await api('DELETE', `/session/${sid}`)).status === 200 && (await api('GET', `/session/${sid}`)).status === 404);
  await srv2.close();
}

// Bots: named agents with a job, tone and memory; ask_bot runs one agent at a time.
{
  const bots = require(path.join(CLI, 'lib/bots.js'));
  const Av = require(path.join(CLI, '..', 'bot-avatar.js'));
  const store = path.join(tmp, 'bots-home');
  bots.setBotsDir(store);
  try {
    const dot = bots.createFromTemplate('orchestrator');
    const res = bots.createFromTemplate('research');
    check('bots: templates create bots on disk', bots.listBots().length === 2 && fs.existsSync(path.join(store, `${dot.id}.json`)) && dot.role === 'orchestrator');
    check('bots: every team role has a template', ['orchestrator', 'research', 'outreach', 'analysis', 'reporting', 'execution', 'monitoring'].every((k) => bots.TEMPLATES.some((t) => t.key === k)));
    const upd = bots.updateBot(res.id, { name: 'Vera', tone: { preset: 'concise', custom: 'British spelling.' }, avatar: { shape: 'nope', color: '#123abc' }, approval: ['send', 'bogus'] });
    check('bots: update keeps id and creation time, cleans bad fields', upd.id === res.id && upd.createdAt === res.createdAt && upd.tone.preset === 'concise' && upd.avatar.shape === 'squircle' && upd.avatar.color === '#123abc' && upd.approval.join() === 'send');
    check('bots: found by id, name or a loose mention', bots.findBot(res.id)?.id === res.id && bots.findBot('Orion')?.id === dot.id && bots.findBot('ask vera please')?.id === res.id && !bots.findBot('nobody'));
    const temp = bots.createBot({ name: 'Temp' });
    check('bots: remove deletes the file', bots.removeBot(temp.id) && !bots.getBot(temp.id) && bots.listBots().length === 2);
    check('bots: a path-like id is refused', (() => { try { bots.updateBot('../evil', {}); return false; } catch { return true; } })());
    check('bots: canSkipApproval follows the boundary', !bots.canSkipApproval(upd, 'gmail_send') && bots.canSkipApproval(upd, 'write_file') && !bots.canSkipApproval(upd, 'read_file'));

    bots.createFromTemplate('execution');
    const team = bots.listBots();
    const dotNow = bots.getBot(dot.id);
    const p = bots.buildBotPrompt(dotNow, { team, canDelegate: true });
    check('bots: orchestrator prompt has identity, tone, approval, roster and how to delegate',
      /You are Orion/.test(p) && /TONE\n/.test(p) && /APPROVAL BOUNDARY/.test(p) && /- Vera \(specialist\): Research/.test(p) && /ONE AT A TIME/.test(p) && p.includes('<codeply:ask_bot>') && !p.includes('- Orion ('), p);
    check('bots: native prompt leaves out the tag example', !bots.buildBotPrompt(dotNow, { team, canDelegate: true, native: true }).includes('<codeply:ask_bot>'));
    check('bots: no long dashes in prompts', !(p + bots.teamPrompt(team) + bots.describePrompt('x')).includes(String.fromCharCode(0x2014)));

    bots.addMemory(res.id, ['The user prefers TypeScript.']);
    let asked = '';
    const fake = async (msgs) => { asked = msgs[0].content; return { success: true, json: { facts: ['The user prefers TypeScript over plain JavaScript.', 'The user deploys on Vercel.', 'The user likes short answers.', 'A fourth fact that must be dropped.'] } }; };
    const learned = await bots.learnFromTurn(bots.getBot(res.id), 'Use TS please, I deploy on vercel', 'Sure.', fake);
    const mem = bots.getBot(res.id).memory.map((m) => m.fact);
    check('bots: learnFromTurn keeps at most 3 facts and the newest wording wins', learned.added.length === 3 && mem.length === 3 && mem.includes('The user prefers TypeScript over plain JavaScript.') && !mem.includes('The user prefers TypeScript.') && asked.includes('Already known'), JSON.stringify(mem));
    check('bots: learned memory reaches the prompt', bots.buildBotPrompt(bots.getBot(res.id)).includes('- The user deploys on Vercel.'));
    check('bots: secrets are never remembered', (await bots.learnFromTurn(bots.getBot(res.id), 'x', 'y', async () => ({ success: true, json: { facts: ['api_key: sk-123456789'] } }))).added.length === 0);
    check('bots: a failing model teaches nothing and does not throw', (await bots.learnFromTurn(bots.getBot(res.id), 'x', 'y', async () => { throw new Error('down'); })).added.length === 0);
    bots.addMemory(res.id, Array.from({ length: 70 }, (_, i) => `Fact number ${i} about the project setup`));
    const capped = bots.getBot(res.id).memory;
    check('bots: memory is capped and keeps the newest', capped.length === bots.MAX_MEMORY && capped.at(-1).fact.includes('69'));
    check('bots: forget one fact, then clear all', bots.forget(res.id, 0).memory.length === bots.MAX_MEMORY - 1 && bots.clearMemory(res.id).memory.length === 0);

    // One agent at a time: two asks from different chats queue, never overlap.
    const lock = bots.createLock();
    let active = 0; let most = 0; const order = [];
    const work = (tag) => async () => { active++; most = Math.max(most, active); order.push(`${tag}+`); await new Promise((r) => setTimeout(r, 30)); order.push(`${tag}-`); active--; return `Summary: ${tag} done.`; };
    const [x, y] = await Promise.all([
      bots.delegate({ caller: null, name: 'Vera', task: 'one', depth: 0, token: 'chatA', lock, team, runBot: work('A') }),
      bots.delegate({ caller: null, name: 'Orion', task: 'two', depth: 0, token: 'chatB', lock, team, runBot: work('B') }),
    ]);
    check('bots: ask_bot sequential lock, two concurrent asks never overlap', most === 1 && x.ok && y.ok && order.join() === 'A+,A-,B+,B-', order.join());
    const nested = await Promise.race([
      bots.delegate({ caller: dotNow, name: 'Vera', task: 'outer', depth: 0, chain: [dot.id], token: 'chatC', lock, team,
        runBot: async (bot, sub) => {
          const inner = await bots.delegate({ caller: bot, name: 'Axel', task: 'inner', depth: sub.depth, chain: sub.chain, token: 'chatC', lock, team, runBot: async () => 'Summary: inner.' });
          const back = await bots.delegate({ caller: bot, name: 'Orion', task: 'loop', depth: sub.depth, chain: sub.chain, token: 'chatC', lock, team, runBot: async () => 'Summary: never.' });
          return `Summary: outer saw ${inner.ok ? 'ok' : 'refused'} and ${back.ok ? 'ok' : 'refused'}.`;
        } }),
      new Promise((r) => setTimeout(() => r('deadlock'), 2000)),
    ]);
    check('bots: a nested ask in the same chain never deadlocks, and cycles are refused', nested !== 'deadlock' && nested.ok && nested.meta.delegation.summary === 'outer saw ok and refused.', JSON.stringify(nested));
    const self = await bots.delegate({ caller: dotNow, name: 'Orion', task: 'x', depth: 0, token: 't1', lock, team, runBot: work('S') });
    const deep = await bots.delegate({ caller: null, name: 'Vera', task: 'x', depth: bots.MAX_DEPTH, token: 't2', lock, team, runBot: work('D') });
    const ghost = await bots.delegate({ caller: null, name: 'Nobody', task: 'x', depth: 0, token: 't3', lock, team, runBot: work('G') });
    check('bots: no self-calls, depth limit 2, unknown bots refused', !self.ok && /yourself/.test(self.output) && !deep.ok && /2 levels/.test(deep.output) && !ghost.ok && /no bot called/i.test(ghost.output));
    const pr = bots.parseResult('Summary: Found 3 docs.\nThey are in /docs.');
    check('bots: results come back structured', pr.summary === 'Found 3 docs.' && pr.details === 'They are in /docs.' && /RESULT FROM VERA/.test(x.output) && x.meta.delegation.bot.name === 'Vera');

    // ask_bot through the real agent loop.
    script = ['<codeply:ask_bot>\n<bot>Vera</bot>\n<task>\nFind where the docs live.\n</task>\n</codeply:ask_bot>', 'Vera says the docs are in /docs.'];
    seen = []; bodies = [];
    let subPrompt = '';
    const evs = [];
    for await (const ev of runAgent({
      userMessage: 'where are the docs?', history: [], mode: 'Ask', cwd: tmp, approve: async () => 'once', signal: new AbortController().signal, route, maxSteps: 6,
      botPrompt: (native) => bots.buildBotPrompt(dotNow, { team, canDelegate: true, native }),
      askBot: ({ name, task, signal }) => bots.delegate({ caller: dotNow, name, task, depth: 0, chain: [dot.id], token: 'loop', signal, team, runBot: async (bot, sub) => { subPrompt = sub.prompt; return 'Summary: The docs are in /docs.\nREADME links them too.'; } }),
    })) evs.push(ev);
    const end = evs.find((e) => e.type === 'tool_end' && e.name === 'ask_bot');
    check('bots: ask_bot runs in the agent loop and the result goes back to the caller', end && end.ok && end.meta.delegation.summary === 'The docs are in /docs.' && seen.some((s) => s.includes('RESULT FROM VERA')), JSON.stringify(end));
    check('bots: the bot prompt is in the system prompt, the helper hears who asked', bodies[0]?.messages[0]?.content.includes('You are Orion') && /Orion asked you to do one task/.test(subPrompt));
    script = ['<codeply:ask_bot>\n<bot>Vera</bot>\n<task>\nx\n</task>\n</codeply:ask_bot>', 'Fine, I will do it myself.'];
    const plain = [];
    for await (const ev of runAgent({ userMessage: 'q', history: [], mode: 'Ask', cwd: tmp, approve: async () => 'once', signal: new AbortController().signal, route, maxSteps: 4 })) plain.push(ev);
    check('bots: without a host askBot, ask_bot is refused cleanly', plain.some((e) => e.type === 'tool_end' && e.name === 'ask_bot' && !e.ok));

    // Avatars: every combination renders.
    let bad = 0; let n = 0;
    for (const shape of Object.keys(Av.SHAPES)) for (const eyes of Object.keys(Av.EYES)) for (const glasses of Object.keys(Av.GLASSES)) for (const accessory of Object.keys(Av.ACCESSORIES)) {
      let svg = '';
      try { svg = Av.renderAvatar({ shape, eyes, glasses, accessory, color: Object.keys(Av.COLORS)[n % 10], mouth: Object.keys(Av.MOUTHS)[n % 4], cheeks: n % 2 === 0 }, 64, { state: ['idle', 'working', 'done'][n % 3] }); } catch { bad++; }
      if (!/^<svg[\s\S]*<\/svg>$/.test(svg) || /NaN|undefined/.test(svg)) bad++;
      n++;
    }
    check('bots: avatar SVG renders for every shape, eyes, glasses and accessory combo', bad === 0 && n >= 9 * 6 * 4 * 7, `${bad} bad of ${n}`);
    check('bots: engine and renderer agree on avatar options', ['shape', 'eyes', 'glasses', 'accessory', 'mouth'].every((k) => {
      const r = Object.keys({ shape: Av.SHAPES, eyes: Av.EYES, glasses: Av.GLASSES, accessory: Av.ACCESSORIES, mouth: Av.MOUTHS }[k]);
      return r.length === bots.AVATAR_KEYS[k].length && r.every((v) => bots.AVATAR_KEYS[k].includes(v));
    }) && Object.keys(Av.COLORS).every((c) => bots.AVATAR_KEYS.color.includes(c)));
    check('bots: avatars saved with the old keys map to the new set, in the engine and the renderer', (() => {
      const old = { shape: 'bean', eyes: 'diamond', glasses: 'sunglasses', accessory: 'beret', mouth: 'smile', color: 'pink', cheeks: true };
      const e = bots.normalizeAvatar(old); const r = Av.normalizeAvatar(old);
      const legacyOk = ['shape', 'eyes', 'glasses', 'accessory', 'mouth'].every((k) => Object.entries(Av.LEGACY[k]).every(([o, n]) => bots.normalizeAvatar({ [k]: o })[k] === n && Av.normalizeAvatar({ [k]: o })[k] === n));
      return JSON.stringify(e) === JSON.stringify(r) && e.shape === 'pill' && e.eyes === 'lens' && e.accessory === 'propeller' && e.color === 'pink' && legacyOk &&
        Av.normalizeAvatar({ shape: 'constructor', color: 'toString' }).shape === 'squircle' && /^<svg/.test(Av.renderAvatar(old, 48));
    })());
    check('bots: every template has its own avatar shape', new Set(bots.TEMPLATES.map((t) => t.avatar.shape)).size === bots.TEMPLATES.length);
    check('bots: a described bot keeps irreversible actions behind approval', (() => {
      const d = bots.fromDescription({ name: 'Rex', role: 'specialist', approval: [], avatar: { shape: 'chip' } }, 'a reviewer');
      return d.name === 'Rex' && ['send', 'publish', 'databases'].every((k) => d.approval.includes(k)) && d.avatar.shape === 'chip' && !d.id;
    })());
  } finally {
    bots.setBotsDir(null);
  }
}

// ─── Gmail: "check my emails" lists the newest mail, errors say why ─────────
{
  const oauth = require(path.join(CLI, 'lib/oauth-connectors.js'));
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      const u = new URL(String(url));
      if (u.pathname.endsWith('/messages')) return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 });
      return new Response(JSON.stringify({ snippet: 'hello', payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'a@b.c' }] } }), { status: 200 });
    };
    const r = await oauth.gmailSearch('TOK', '*');
    check('gmail: "*" and empty queries list the newest mail instead of being sent as q', r.length === 1 && r[0].subject === 'Hi' && !new URL(seen[0]).searchParams.has('q'));
    seen.length = 0;
    await oauth.gmailSearch('TOK', 'is:unread');
    check('gmail: a real query is passed through', new URL(seen[0]).searchParams.get('q') === 'is:unread');
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 400, message: 'Bad Request', errors: [{ reason: 'failedPrecondition', message: 'Bad Request' }] } }), { status: 400 });
    let msg = ''; let status = 0;
    try { await oauth.gmailSearch('TOK', 'label:inbox'); } catch (e) { msg = e.message; status = e.status; }
    check('gmail: a bare "Bad Request" comes back with the status, the reason and what to do', status === 400 && /HTTP 400/.test(msg) && /failedPrecondition/.test(msg) && /Reconnect Gmail/.test(msg), msg);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }), { status: 400 });
    let code = ''; msg = '';
    try { await oauth.refreshGmailToken('id', 'secret', 'dead'); } catch (e) { code = e.code; msg = e.message; }
    check('gmail: an expired refresh token says to reconnect, not "Bad Request"', code === 'invalid_grant' && /Reconnect Gmail/.test(msg) && !/Bad Request/.test(msg), msg);
  } finally {
    globalThis.fetch = realFetch;
  }
}

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
