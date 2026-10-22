// The AI side of the life simulation's bridge (see harness.mjs).
//
//   node scripts/sim/model-bridge.mjs next <dir>
//       waits (up to ~100 s) for the next model request and prints it.
//       Prints "NO REQUEST YET" if none came, "SIMULATION FINISHED" at the end.
//   node scripts/sim/model-bridge.mjs reply <dir> <n>   (the answer on stdin)
//       answers request <n>.
import fs from 'fs';
import path from 'path';

const [cmd, dir, n] = process.argv.slice(2);
const pad = (x) => String(x).padStart(4, '0');
const open = () => fs.readdirSync(dir).filter((f) => /^req-\d+\.md$/.test(f)).sort()
  .filter((f) => !fs.existsSync(path.join(dir, f.replace('req-', 'res-').replace('.md', '.txt'))));

if (cmd === 'next') {
  const until = Date.now() + 100000;
  const tick = () => {
    const list = fs.existsSync(dir) ? open() : [];
    if (list.length) { process.stdout.write(fs.readFileSync(path.join(dir, list[0]), 'utf8')); return; }
    if (fs.existsSync(path.join(dir, 'DONE'))) { console.log(`SIMULATION FINISHED: ${fs.readFileSync(path.join(dir, 'DONE'), 'utf8').trim()}`); return; }
    if (Date.now() > until) { console.log('NO REQUEST YET (Codeply is busy). Run next again.'); return; }
    setTimeout(tick, 400);
  };
  tick();
} else if (cmd === 'reply') {
  let text = '';
  process.stdin.on('data', (c) => (text += c));
  process.stdin.on('end', () => {
    const f = path.join(dir, `res-${pad(n)}.txt`);
    fs.writeFileSync(`${f}.tmp`, text); fs.renameSync(`${f}.tmp`, f);
    console.log(`answered ${n}`);
  });
} else {
  console.error('usage: model-bridge.mjs next <dir> | reply <dir> <n>');
  process.exit(2);
}
