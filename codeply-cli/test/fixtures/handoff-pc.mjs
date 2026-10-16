// Plays the PC's side of a protected run for handoff.test.mjs: holds the lease,
// does a few steps with real file edits, pushes a WIP after each, then starts
// one more edit it never pushes and waits to be killed.
import fs from 'fs';
import path from 'path';
import { makeLease, newRunState, recordEvent, pushWip } from '../../lib/handoff.mjs';

const { PROJ, HOME_DIR, REMOTE, SID, LEASE_URL, STEPS, BEAT_MS, FENCE_MS } = process.env;
const call = async (op, body) => {
  const r = await fetch(`${LEASE_URL}/${op}`, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${op} ${r.status}`);
  return r.json();
};
const store = { begin: (row) => call('begin', row), beat: (b) => call('beat', b), end: (b) => call('end', b) };

const state = newRunState({ sessionId: SID, mode: 'Build', userMessage: 'Build the six-step thing', history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }] });
const todos = (n) => Array.from({ length: 6 }, (_, i) => ({ text: `step ${i + 1}`, status: i < n ? 'done' : i === n ? 'in_progress' : 'pending' }));

let sha = (await pushWip({ cwd: PROJ, home: HOME_DIR, repo: 'me/proj', sessionId: SID, state, force: true, remoteUrl: REMOTE })).sha;
const lease = makeLease({ store, sessionId: SID, beatMs: Number(BEAT_MS), fenceMs: Number(FENCE_MS) });
await lease.start({ repo: 'me/proj', base: 'main', kind: 'mirror', mode: 'Build', wipSha: sha });

for (let i = 1; i <= Number(STEPS); i++) {
  fs.writeFileSync(path.join(PROJ, `step${i}.txt`), `line one from the PC, step ${i}\n`);
  recordEvent(state, { type: 'tool_end', name: 'todo', ok: true, meta: { todos: todos(i) } });
  recordEvent(state, { type: 'tool_end', name: 'write_file', args: { path: `step${i}.txt` }, summary: `step${i}.txt`, ok: true });
  sha = (await pushWip({ cwd: PROJ, home: HOME_DIR, repo: 'me/proj', sessionId: SID, state, parent: sha, remoteUrl: REMOTE })).sha;
  lease.saved(sha);
  await lease.beat();
}
// The edit that is in flight when the power goes: on disk, never pushed.
fs.writeFileSync(path.join(PROJ, 'unpushed.txt'), 'written right before the power cut\n');
process.stdout.write(`READY ${sha}\n`);
setInterval(() => {}, 1000);
