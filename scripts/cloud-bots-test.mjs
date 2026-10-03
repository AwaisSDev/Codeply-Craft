// Cloud runs with a bot: the bot's prompt reaches the agent, its reply lands in
// the task doc, and tasks without a bot work as before (node scripts/cloud-bots-test.mjs).
// Same fake GitHub style as engine-test.mjs; no network, no model.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL, fileURLToPath } from 'url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'codeply-cli');
const cl = await import(pathToFileURL(path.join(CLI, 'lib/cloud.mjs')).href);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 600)}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-cloud-bots-'));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

// The user's repo (a "repo" kind cloud project) and the runner's checkout of it.
const bare = path.join(tmp, 'app.git');
const proj = path.join(tmp, 'app');
fs.mkdirSync(bare, { recursive: true });
sh(bare, 'init', '-q', '--bare', '-b', 'main');
sh(tmp, 'clone', '-q', bare, proj);
fs.writeFileSync(path.join(proj, 'README.md'), '# app\n');
sh(proj, 'add', '.');
sh(proj, ...ident, 'commit', '-q', '-m', 'first');
sh(proj, 'push', '-q', 'origin', 'HEAD:main');
const headSha = sh(bare, 'rev-parse', 'main');
const runnerDir = path.join(tmp, 'runner');
sh(tmp, 'clone', '-q', '-b', 'main', bare, runnerDir);

const repo = 'me/app';
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
const key = path.resolve(proj).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
fs.writeFileSync(path.join(home, 'cloud.json'), JSON.stringify({ projects: { [key]: { cwd: path.resolve(proj), kind: 'repo', repo, base: 'main', tasks: [] } } }));

// A fake GitHub: dispatches, check runs, refs, merges and contents on branches.
const G = { dispatches: [], checks: [], files: new Map(), refs: new Set(['main']), calls: [] };
const fetchCloud = async (url, init = {}) => {
  const u = new URL(url);
  const p = u.pathname;
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  G.calls.push({ method, p, body });
  const reply = (status, json) => ({ ok: status < 400, status, text: async () => (json == null ? '' : JSON.stringify(json)), headers: { get: () => null } });
  let m;
  if (method === 'POST' && /\/actions\/workflows\/craft-cloud\.yml\/dispatches$/.test(p)) { G.dispatches.push(body); return reply(204, null); }
  if (method === 'POST' && /\/check-runs$/.test(p)) { const c = { id: 900 + G.checks.length, ...body }; G.checks.push(c); return reply(201, c); }
  if (method === 'PATCH' && (m = /\/check-runs\/(\d+)$/.exec(p))) { const c = G.checks.find((x) => x.id === Number(m[1])); Object.assign(c, body); return reply(200, c); }
  if ((m = /\/git\/ref\/heads\/(.+)$/.exec(p))) return G.refs.has(m[1]) ? reply(200, { ref: m[1], object: { sha: headSha } }) : reply(404, { message: 'Not Found' });
  if (method === 'POST' && /\/git\/refs$/.test(p)) { G.refs.add(body.ref.replace('refs/heads/', '')); return reply(201, {}); }
  if (method === 'POST' && /\/merges$/.test(p)) return reply(201, { sha: 'mergedsha' });
  if ((m = /\/contents\/(.+)$/.exec(p))) {
    const k = `${u.searchParams.get('ref') || (body && body.branch)}:${decodeURIComponent(m[1])}`;
    if (method === 'GET' && !G.files.has(k)) {
      const kids = [...G.files.keys()].filter((x) => x.startsWith(`${k}/`));
      if (kids.length) return reply(200, kids.map((x) => ({ name: x.slice(k.length + 1), path: x.slice(x.indexOf(':') + 1), sha: G.files.get(x).sha })));
    }
    if (method === 'DELETE') { G.files.delete(k); return reply(200, {}); }
    if (method === 'GET') return G.files.has(k) ? reply(200, { content: G.files.get(k).content, sha: G.files.get(k).sha }) : reply(404, { message: 'Not Found' });
    if (method === 'PUT') {
      if (!G.refs.has(body.branch)) return reply(404, { message: 'Branch not found' });
      const cur = G.files.get(k);
      if (cur && cur.sha !== body.sha) return reply(409, { message: 'sha mismatch' });
      G.files.set(k, { content: body.content, sha: `s${Math.random().toString(36).slice(2)}` });
      return reply(201, {});
    }
  }
  return reply(404, { message: `no fake for ${method} ${p}` });
};
const readJson = (k) => { const f = G.files.get(k); return f ? JSON.parse(Buffer.from(f.content, 'base64').toString()) : null; };
const common = { home, apiUrl: 'https://api.test', serverUrl: 'https://github.test', fetchImpl: fetchCloud, retryMs: 1 };
const runnerEnv = (t, prompt, mode, sid = '') => ({ GITHUB_REPOSITORY: repo, GITHUB_SHA: headSha, GITHUB_API_URL: 'https://api.test', GITHUB_SERVER_URL: 'https://github.test', CRAFT_TASK_ID: t.id, CRAFT_PROMPT: prompt, CRAFT_MODE: mode, CRAFT_SESSION_ID: sid, GITHUB_RUN_ID: '8000' });

// A fake agent that records what it was given.
let seen = null;
const agent = (text) => async function* (opts) {
  seen = opts;
  yield { type: 'tool_end', name: 'run_command', args: { command: 'curl -s https://example.com' }, ok: true };
  yield { type: 'text', text: 'Thinking out loud.', interim: true };
  yield { type: 'text', text };
  yield { type: 'done' };
};

const BOT_PROMPT = 'You are Nova, the user\'s research bot.\n'.padEnd(5000, 'x');

console.log('cloud bots');

// 1. A bot task, dispatched: the bot travels next to the dispatch, on craft-sessions.
const t1 = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'Find the latest Node LTS version', mode: 'Build', sessionId: 'call1', bot: { name: 'Nova', prompt: BOT_PROMPT }, kind: 'task', ...common });
const d1 = G.dispatches.at(-1);
const req1 = readJson(`craft-sessions:requests/${t1.id}.json`);
check('a bot task dispatches with the same workflow inputs as before', d1 && Object.keys(d1.inputs).sort().join(',') === 'mode,prompt,session_id,task_id' && d1.inputs.task_id === t1.id, JSON.stringify(d1));
check('the bot prompt is written to requests/<id>.json, creating craft-sessions if needed', G.refs.has('craft-sessions') && req1 && req1.bot.name === 'Nova' && req1.bot.prompt === BOT_PROMPT.trim() && req1.kind === 'task', JSON.stringify(req1).slice(0, 200));
check('the local task record keeps the bot name, never its prompt', t1.bot && t1.bot.name === 'Nova' && !('prompt' in t1.bot) && t1.kind === 'task');

const out1 = await cl.runCloudRunner({ env: runnerEnv(t1, 'Find the latest Node LTS version', 'Build', 'call1'), cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 0, browserImpl: null, runAgentImpl: agent('Node 24 is the current LTS.') });
check('the runner passes the bot prompt to the agent as botPrompt', seen && seen.botPrompt === BOT_PROMPT.trim(), seen && String(seen.botPrompt).slice(0, 80));
check('a task run tells the agent it is in the cloud, away from the user\'s PC', seen && /not on the user's PC/.test(seen.userMessage) && /read out to the user/.test(seen.userMessage) && seen.userMessage.startsWith('Find the latest Node LTS version'));
const doc1 = readJson(`craft-sessions:tasks/${t1.id}.json`);
check('the bot\'s final reply is recorded in the task doc as reply (and answer)', out1.status === 'done' && doc1 && doc1.status === 'done' && doc1.reply === 'Node 24 is the current LTS.' && doc1.answer === 'Node 24 is the current LTS.', JSON.stringify(doc1).slice(0, 400));
check('the task doc names the bot and kind, without the bot prompt', doc1.bot && doc1.bot.name === 'Nova' && !doc1.bot.prompt && doc1.kind === 'task' && !JSON.stringify(doc1).includes('xxxxxxxxxx'));
check('the request file is cleaned up once the runner took it', !G.files.has(`craft-sessions:requests/${t1.id}.json`));

// 2. An old-style code task (no bot): unchanged.
seen = null;
const t2 = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'what does README say?', mode: 'Ask', sessionId: '', ...common });
check('a task without a bot writes no request file', !G.files.has(`craft-sessions:requests/${t2.id}.json`) && !t2.bot && !t2.kind);
const out2 = await cl.runCloudRunner({ env: runnerEnv(t2, 'what does README say?', 'Ask'), cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 0, browserImpl: null, runAgentImpl: agent('It says app.') });
const doc2 = readJson(`craft-sessions:tasks/${t2.id}.json`);
check('a task without a bot runs with no botPrompt and the usual repo note', seen && !('botPrompt' in seen) && /fresh copy of the repository/.test(seen.userMessage));
check('its task doc is as before: answer, no reply, no bot', out2.status === 'done' && doc2.answer === 'It says app.' && !('reply' in doc2) && !('bot' in doc2) && !('kind' in doc2), JSON.stringify(doc2).slice(0, 300));

// 3. A runner dispatched by an older Craft (no request file at all) still works.
seen = null;
const out3 = await cl.runCloudRunner({ env: runnerEnv({ id: 'oldstyle1' }, 'say hi', 'Ask'), cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 0, browserImpl: null, runAgentImpl: agent('Hi.') });
check('a dispatch with no request file runs as a plain code task', out3.status === 'done' && seen && seen.botPrompt === undefined);

// 4. A follow-up in the same call goes through the queue, bot included.
seen = null;
const ran = [];
const qAgent = async function* (opts) { ran.push({ msg: opts.userMessage.split('\n')[0], bot: opts.botPrompt || null }); yield { type: 'text', text: `done: ${opts.userMessage.split('\n')[0]}` }; yield { type: 'done' }; };
const tq1 = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'first job', mode: 'Build', sessionId: 'callq', bot: { name: 'Nova', prompt: 'You are Nova.' }, kind: 'task', ...common });
const runnerP = cl.runCloudRunner({ env: runnerEnv(tq1, 'first job', 'Build', 'callq'), cwd: runnerDir, token: 'TOK', route: {}, fetchImpl: fetchCloud, updateMs: 0, idleMs: 10000, pollMs: 40, browserImpl: null, runAgentImpl: qAgent });
for (let i = 0; i < 150; i++) {
  const lv = readJson('craft-sessions:live/callq.json');
  if (lv && lv.busy === false) break;
  await new Promise((r) => setTimeout(r, 30));
}
const dispatchesBefore = G.dispatches.length;
const tq2 = await cl.startCloudRun({ cwd: proj, token: 'TOK', prompt: 'second job', mode: 'Build', sessionId: 'callq', bot: { name: 'Nova', prompt: 'You are Nova.' }, kind: 'task', ...common });
const qOut = await runnerP;
const docq2 = readJson(`craft-sessions:tasks/${tq2.id}.json`);
check('a queued follow-up carries the bot too, and its reply is recorded', tq2.queued === true && G.dispatches.length === dispatchesBefore && qOut.results.length === 2
  && ran.length === 2 && ran.every((r) => r.bot === 'You are Nova.') && docq2 && docq2.reply === 'done: second job', JSON.stringify({ ran, docq2 }).slice(0, 400));

// 5. Bad bot values are ignored, not fatal.
check('cleanBot ignores empty or odd bots and caps long prompts', cl.cleanBot(null) === null && cl.cleanBot({ name: 'x', prompt: '  ' }) === null && cl.cleanBot('str') === null
  && cl.cleanBot({ prompt: 'p' }).name === 'Bot' && cl.cleanBot({ name: 'n', prompt: 'y'.repeat(50000) }).prompt.length === 30000);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
