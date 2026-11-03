// The frozen release: the model checksum and every evaluation file the release decisions rest on.
// FROZEN-MANIFEST.json lists their SHA-256; this checks them (and, with --gguf, the model file itself).
//
//   node release/memory-model/verify-frozen.mjs                 check the committed result files
//   node release/memory-model/verify-frozen.mjs --gguf <file>   also hash the model file (1.1 GB, ~5 s)
//   node release/memory-model/verify-frozen.mjs --write         (re)create the manifest: only for a NEW release
//
// Files kept out of the public repository (PRIVATE-DATA-MANIFEST.json) may be absent: they are reported, not
// failed, unless --require-private; restore them with release/memory-model/fetch-private-data.sh.
// Exit 1 if anything differs. Run before any commit that touches release/memory-model/results/.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MANIFEST = path.join(HERE, 'results/FROZEN-MANIFEST.json');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };

export const ARTIFACT = {
  name: 'codeply-memory-lfm3-s1-Q4_K_M.gguf', bytes: 1099627456,
  sha256: '7360aaed7410cac445d9901f8a85b876bee6b76d1cb83b05404480b5b9ac14f9',
  location: 'private Kaggle dataset awaissididique/codeply-memory-model-gguf, s1.tar',
  catalogId: 'lfm3-1.7b-memory-v1-q4',
};
const FROZEN = [
  'results/EXPORT-PARITY.md', 'results/TIERS-FROZEN.json', 'results/logprobs-parity-s1.json',
  'results/release-s1-val.json', 'results/release-s1-test-real.json', 'results/release-s1-bench.json',
  'results/details/release-s1-val.jsonl', 'results/details/release-s1-test-real.jsonl', 'results/details/release-s1-bench.jsonl',
  'results/tiers-s1-val-selection.json', 'results/tiers-s1-test.json',
  'results/integration-s1.json', 'results/integration-production-lfm3.json',
];
const hashFile = (f) => new Promise((ok, no) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(f).on('error', no).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex')));
});

async function main() {
  if (args.includes('--write')) {
    if (fs.existsSync(MANIFEST) && !args.includes('--force')) { console.error('manifest exists; a frozen release is not rewritten (--force only for a new release)'); process.exit(2); }
    const files = {};
    for (const f of FROZEN) files[f] = await hashFile(path.join(HERE, f));
    fs.writeFileSync(MANIFEST, `${JSON.stringify({ frozenAt: new Date().toISOString(), artifact: ARTIFACT, files }, null, 1)}\n`);
    console.log(`wrote ${path.relative(ROOT, MANIFEST)} (${FROZEN.length} files)`);
    return;
  }
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let bad = 0; let privateMissing = 0;
  const priv = JSON.parse(fs.readFileSync(path.join(HERE, 'PRIVATE-DATA-MANIFEST.json'), 'utf8')).files;
  if (m.artifact.sha256 !== ARTIFACT.sha256) { console.log(`DIFF artifact checksum in manifest ${m.artifact.sha256}`); bad++; }
  for (const [f, want] of Object.entries(m.files)) {
    let got = 'missing';
    try { got = await hashFile(path.join(HERE, f)); } catch {}
    const p = priv[`release/memory-model/${f}`];
    if (p && p.sha256 !== want) { console.log(`DIFF ${f}: private manifest ${p.sha256.slice(0, 12)} is not the frozen ${want.slice(0, 12)}`); bad++; continue; }
    if (got === 'missing' && p && !args.includes('--require-private')) { console.log(`priv ${f}: kept private, not present (fetch-private-data.sh)`); privateMissing++; continue; }
    if (got !== want) { console.log(`DIFF ${f}: ${got.slice(0, 12)} (frozen ${want.slice(0, 12)})`); bad++; }
  }
  const gguf = opt('gguf');
  if (gguf) {
    const got = await hashFile(gguf); const size = fs.statSync(gguf).size;
    if (got !== m.artifact.sha256 || size !== m.artifact.bytes) { console.log(`DIFF model file ${gguf}: ${got} (${size} bytes)`); bad++; } else console.log(`ok   model file ${m.artifact.name}`);
  }
  const n = Object.keys(m.files).length;
  console.log(bad ? `FROZEN RELEASE CHANGED: ${bad} difference(s)` : `ok   ${n - privateMissing} frozen files verified${privateMissing ? `, ${privateMissing} private not present` : ''}, artifact ${m.artifact.sha256.slice(0, 12)}`);
  process.exitCode = bad ? 1 : 0;
}
main();
