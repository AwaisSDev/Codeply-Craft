// Smoke test for a packaged app (node scripts/dsh-smoke.mjs <resources dir>):
// the shipped Node starts the shipped DSH engine with the ACP profile and
// Codeply's add-ons, answers initialize and opens a session. No model call.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const resources = path.resolve(process.argv[2] || '');
const rt = path.join(resources, 'dsh-runtime');
const node = path.join(rt, process.platform === 'win32' ? 'node.exe' : 'node');
const bin = path.join(rt, 'engine', 'lib', 'bin.js');
for (const f of [node, bin]) if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-work-'));
const patch = path.join(home, 'patch.yml');
// The same add-ons Codeply CLI mounts (codeply-cli/lib/dsh-acp.mjs), so a missing package shows up here.
fs.writeFileSync(patch, `- insert:
    - id: llm-haze
      name: '@codeply/dsh-llm-haze'
    - id: codeply-design-tools
      name: '@codeply/dsh-design-tools'
    - id: codeply-shared-context
      name: '@codeply/dsh-shared-context'
`);

const started = Date.now();
const child = spawn(node, [bin, '--profile', 'acp', '--patch', patch], {
  cwd: work, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_HOME: home, NO_COLOR: '1', CODEPLY_HAZE_BRIDGE_URL: 'http://127.0.0.1:9/haze', CODEPLY_HAZE_BRIDGE_TOKEN: 'smoke' },
});
let err = '';
child.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
const waiting = new Map();
let buf = '';
child.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
let id = 0;
const call = (method, params) => new Promise((resolve, reject) => {
  const n = ++id;
  waiting.set(n, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
});
const fail = (why) => { console.error(`FAIL ${why}\n${err}`); child.kill(); process.exit(1); };
child.once('exit', (code) => fail(`engine exited (${code}) before answering`));
setTimeout(() => fail('no answer within 180 s'), 180000).unref();

try {
  await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const ready = Date.now() - started;
  const s = await call('session/new', { cwd: work, mcpServers: [] });
  if (!s || !s.sessionId) fail('session/new returned no session');
  console.log(`ok: engine answered in ${(ready / 1000).toFixed(1)} s, session ${s.sessionId} opened in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  child.removeAllListeners('exit');
  child.kill();
  process.exit(0);
} catch (e) { fail(e.message); }
