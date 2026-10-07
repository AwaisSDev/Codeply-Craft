// Edit / retry a sent message: where the chat is cut and which files go back
// (chat-rewind.js), plus a real restore through snapshot.js on a temp folder.
// node scripts/rewind-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { planRewind } = require(path.join(ROOT, 'chat-rewind.js'));
const snapshot = require(path.join(ROOT, 'codeply-cli', 'lib', 'snapshot.js'));

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };

// ── planRewind ──
const msgs = [
  { kind: 'user', text: 'first' },
  { kind: 'assistant', text: 'one' },
  { kind: 'checkpoint', id: 'k1', cwd: '/p', beforeTree: 't0', afterTree: 't1', files: [{ status: 'A', file: 'a.txt' }] },
  { kind: 'user', text: 'second' },
  { kind: 'assistant', text: 'two' },
  { kind: 'checkpoint', id: 'k2', cwd: '/p', beforeTree: 't1', afterTree: 't2', files: [{ status: 'M', file: 'a.txt' }, { status: 'A', file: 'b.txt' }] },
  { kind: 'user', text: 'third' },
  { kind: 'assistant', text: 'three' },
];
let p = planRewind(msgs, 1, 'second');
check('cuts at the second user message', p && p.index === 3);
check('restores to the snapshot from before it ran', p && p.restore && p.restore.tree === 't1');
check('restores every file later turns touched', p && p.restore.files.sort().join() === 'a.txt,b.txt');
p = planRewind(msgs, 0, 'first');
check('first message goes back to the oldest snapshot', p && p.index === 0 && p.restore.tree === 't0');
p = planRewind(msgs, 2, 'third');
check('last message with no file changes after it has nothing to restore', p && p.index === 6 && p.restore === null);
p = planRewind(msgs, 0, 'third');
check('a drifted index falls back to the message with that text', p && p.index === 6);
check('an unknown message gives null', planRewind(msgs, 5, 'nope') === null);
check('missing messages give null', planRewind(null, 0) === null);

// ── a real restore on disk ──
if (await snapshot.available()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-rewind-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'before');
    const before = await snapshot.track(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'after');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'made by the reply');
    const after = await snapshot.track(dir);
    const files = (await snapshot.changedFiles(dir, before, after)).map((f) => f.file);
    const plan = planRewind([
      { kind: 'user', text: 'edit me' },
      { kind: 'checkpoint', id: 'k', cwd: dir, beforeTree: before, afterTree: after, files: files.map((file) => ({ status: 'M', file })) },
    ], 0, 'edit me');
    const r = await snapshot.restore(plan.restore.cwd, plan.restore.tree, plan.restore.files);
    check('restore puts a changed file back', fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'before');
    check('restore removes a file the reply created', !fs.existsSync(path.join(dir, 'new.txt')) && r.ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(snapshot.gitDirFor(dir), { recursive: true, force: true });
  }
} else {
  console.log('SKIP restore on disk (git not found)');
}

console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
