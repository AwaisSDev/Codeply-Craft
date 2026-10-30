// Put a context-intelligence model where the local runtime finds it
// (~/.codeply/models + manifest.json), from Hugging Face or a file you have.
//
//   node scripts/context/fetch-model.mjs list
//   node scripts/context/fetch-model.mjs qwen3-1.7b-q4            download it
//   node scripts/context/fetch-model.mjs qwen3-1.7b-q4 --from /path/to/file.gguf
//
// The SHA-256 of the file is recorded in the manifest; a later fetch of the
// same id with a different hash is refused unless --force.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const RT = require(path.join(ROOT, 'codeply-cli/lib/local-runtime.js'));

const args = process.argv.slice(2);
const id = args[0];
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };
if (!id || id === 'list') {
  for (const [k, m] of Object.entries(RT.CATALOG)) console.log(`${k.padEnd(18)} ${m.params.padEnd(5)} ${m.arch.padEnd(34)} ${m.license}`);
  process.exit(0);
}
const spec = RT.CATALOG[id];
if (!spec) { console.error(`Unknown model "${id}". Run with "list".`); process.exit(2); }

const dir = RT.MODELS_DIR();
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, spec.file);
const from = opt('from');

async function sha256(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

if (from) {
  if (!fs.existsSync(from)) { console.error(`No file at ${from}`); process.exit(2); }
  try { fs.unlinkSync(dest); } catch {}
  fs.symlinkSync(path.resolve(from), dest);
  console.log(`Linked ${from}`);
} else if (!fs.existsSync(dest)) {
  const url = `https://huggingface.co/${spec.repo}/resolve/main/${spec.file}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${dest}.part`));
  fs.renameSync(`${dest}.part`, dest);
}

const hash = await sha256(dest);
const manifestFile = path.join(dir, 'manifest.json');
let manifest = [];
try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch {}
const prev = manifest.find((m) => m.id === id);
if (prev && prev.sha256 && prev.sha256 !== hash && !args.includes('--force')) {
  console.error(`The file for ${id} changed (${prev.sha256.slice(0, 12)} -> ${hash.slice(0, 12)}). Use --force to accept it.`);
  process.exit(1);
}
manifest = manifest.filter((m) => m.id !== id);
manifest.push({ id, file: spec.file, sha256: hash, bytes: fs.statSync(dest).size, license: spec.license, addedAt: new Date().toISOString() });
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${id}: ${(fs.statSync(dest).size / 1048576).toFixed(0)} MB, sha256 ${hash}`);
