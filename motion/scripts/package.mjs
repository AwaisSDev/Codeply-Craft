// Packs a release build of Codeply Motion for Craft to download: the binary,
// Motion's own licence and NOTICE, and the licence files of the engines it
// links (FilmCraft, EffectCraft, craft-libs), which their licences ask binary
// releases to ship. Writes dist/codeply-motion-<name>.zip and a .sha256 next
// to it, and prints the size.
//
//   node scripts/package.mjs <rust target> <binary name> <package name>
//   node scripts/package.mjs x86_64-pc-windows-msvc motion.exe win-x64
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [target, exe, name] = process.argv.slice(2);
if (!target || !exe || !name) { console.error('usage: package.mjs <target> <exe> <name>'); process.exit(2); }

const root = process.cwd(); // motion/
const dist = path.join(root, 'dist');
const dir = path.join(dist, `codeply-motion-${name}`);
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'third-party'), { recursive: true });

const bin = path.join(root, 'target', target, 'release', exe);
fs.copyFileSync(bin, path.join(dir, exe));
fs.copyFileSync(path.join(root, 'NOTICE'), path.join(dir, 'NOTICE'));
fs.copyFileSync(path.join(root, '..', 'LICENSE'), path.join(dir, 'LICENSE'));

// Where Cargo checked the engines out: walk up from each package's manifest to
// the repository root (the folder with the licence files) and copy them.
const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], { cwd: root, maxBuffer: 1 << 28 }).toString());
const NOTICE_FILES = /^(LICEN[SC]E|COPYING|NOTICE|ATTRIBUTION)/i;
const upstream = [['filmcraft-engine', 'filmcraft'], ['effectcraft-engine', 'effectcraft'], ['hayro-syntax', 'craft-libs']];
for (const [pkg, label] of upstream) {
  const p = meta.packages.find((x) => x.name === pkg && String(x.source || '').startsWith('git+'));
  if (!p) throw new Error(`${pkg} is not in the dependency graph`);
  // Up to the checkout's root (Cargo marks it with .cargo-ok, or it holds .git),
  // remembering the nearest folder with licence files on the way as a fallback.
  const noticesIn = (dir) => fs.readdirSync(dir).filter((f) => NOTICE_FILES.test(f) && fs.statSync(path.join(dir, f)).isFile());
  let d = path.dirname(p.manifest_path);
  let nearest = noticesIn(d).length ? d : null;
  while (d !== path.dirname(d) && !fs.existsSync(path.join(d, '.cargo-ok')) && !fs.existsSync(path.join(d, '.git'))) {
    d = path.dirname(d);
    if (!nearest && noticesIn(d).length) nearest = d;
  }
  if (!noticesIn(d).length && nearest) d = nearest;
  const files = noticesIn(d);
  if (!files.length) throw new Error(`no licence files found for ${pkg} under ${d}`);
  fs.mkdirSync(path.join(dir, 'third-party', label), { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(d, f), path.join(dir, 'third-party', label, f));
  console.log(`${label}: ${files.join(', ')}`);
}

// bsdtar (Windows and macOS) writes a zip when the name ends in .zip.
const zip = path.join(dist, `codeply-motion-${name}.zip`);
execFileSync('tar', ['-a', '-c', '-f', zip, '-C', dist, `codeply-motion-${name}`], { stdio: 'inherit' });
const sha = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(`${zip}.sha256`, `${sha}  ${path.basename(zip)}\n`);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`${path.basename(zip)}: ${mb(fs.statSync(zip).size)} (binary ${mb(fs.statSync(bin).size)}), sha256 ${sha}`);
