// Installing Iris on this PC, only when the user presses Download in Settings.
//
// Two files, each checked against a SHA-256 the app already knows before it is used:
//   1. llama-server (upstream llama.cpp, MIT), the pinned build in local-runtime.js
//      RUNTIME_BUILDS, from GitHub releases, unzipped into ~/.codeply/runtime/bin
//   2. the Iris model (private weights), from Codeply's private storage through a
//      signed link that lives 15 minutes and is only given to a signed-in user;
//      saved in ~/.codeply/models and registered in its manifest
//
// A model whose checksum is not in the catalog yet (not released) is never
// downloaded. After installing, selfTest() runs fixed batches through Iris and
// its guard; a model that fails is removed again.
//
// Nothing here runs by itself: context-desktop.js calls install() / remove().
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const { execFile } = require('child_process');

const SIGNED_LINK_SECONDS = 900;
const BUCKET = 'models';

let busy = null; // the install in progress (one at a time)

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

/** Stream url to dest, hashing as it goes. Throws (and deletes the part file) on a size or checksum mismatch. */
async function download(url, dest, { sha256, bytes, onProgress, headers, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(url, { headers: headers || {}, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || bytes || 0;
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const h = crypto.createHash('sha256');
  let done = 0; let last = 0;
  const meter = new Transform({
    transform(chunk, enc, cb) {
      h.update(chunk); done += chunk.length;
      const now = Date.now();
      if (onProgress && (now - last > 250 || done === total)) { last = now; try { onProgress({ done, total }); } catch {} }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part));
    const got = h.digest('hex');
    if (bytes && done !== bytes) throw new Error(`The file was ${done} bytes, expected ${bytes}.`);
    if (sha256 && got !== sha256) throw new Error('The file did not match its checksum, so it was thrown away.');
    fs.renameSync(part, dest);
    return { sha256: got, bytes: done };
  } catch (e) {
    try { fs.unlinkSync(part); } catch {}
    throw e;
  }
}

/**
 * The tar that ships with Windows 10 and later (bsdtar, reads zip), by its full path:
 * a GNU tar earlier on PATH (Git for Windows puts one there) cannot read zip files.
 */
function tarExe() {
  if (process.platform !== 'win32') return 'tar';
  const own = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(own) ? own : 'tar';
}

function unzip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile(tarExe(), ['-xf', zip, '-C', dir], { windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(`Could not unpack llama-server: ${String(errOut || err.message).slice(0, 200)}`)) : resolve()));
  });
}

/** Find llama-server inside an unpacked folder (some builds nest it one level down). */
function findExe(dir, exe) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name.toLowerCase() === exe.toLowerCase()) return p;
    try { if (fs.statSync(p).isDirectory()) { const inner = findExe(p, exe); if (inner) return inner; } } catch {}
  }
  return '';
}

/**
 * The llama-server build for this PC, into ~/.codeply/runtime/bin.
 * @param {object} RT  local-runtime.js
 */
async function installRuntime(RT, { onProgress, fetchImpl } = {}) {
  const build = RT.runtimeBuild();
  if (!build) throw new Error('Iris runs on Windows (x64) for now.');
  const binDir = path.join(RT.RUNTIME_DIR(), 'bin');
  const marker = path.join(binDir, 'BUILD');
  const own = path.join(binDir, RT.EXE);
  try { if (fs.existsSync(own) && fs.readFileSync(marker, 'utf8').trim() === build.sha256) return { skipped: true, path: own }; } catch {}
  const zip = path.join(RT.RUNTIME_DIR(), 'download', build.file);
  await download(build.url, zip, { sha256: build.sha256, bytes: build.bytes, onProgress, fetchImpl });
  const tmp = path.join(RT.RUNTIME_DIR(), `unpack-${Date.now()}`);
  try {
    await unzip(zip, tmp);
    const exe = findExe(tmp, RT.EXE);
    if (!exe) throw new Error('The llama-server download had no llama-server inside.');
    // The exe and the DLLs next to it.
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.mkdirSync(binDir, { recursive: true });
    const from = path.dirname(exe);
    for (const name of fs.readdirSync(from)) {
      const p = path.join(from, name);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(binDir, name));
    }
    fs.writeFileSync(marker, `${build.sha256}\n`);
    return { path: own, tag: build.tag };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(zip); } catch {}
  }
}

/** A 15-minute link to the private model file, for this signed-in user only. */
async function signedLink({ supabaseUrl, anonKey, token, storagePath, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: SIGNED_LINK_SECONDS }),
  });
  const data = await res.json().catch(() => ({}));
  const rel = data.signedURL || data.signedUrl;
  if (!res.ok || !rel) throw new Error(res.status === 404 ? 'Iris is not available to download yet.' : `Could not get the download link (HTTP ${res.status}).`);
  return /^https?:/.test(rel) ? rel : `${supabaseUrl}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`;
}

function writeManifest(RT, entry) {
  const file = path.join(RT.MODELS_DIR(), 'manifest.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  list = (Array.isArray(list) ? list : []).filter((m) => m.id !== entry.id);
  if (entry.file) list.push(entry);
  fs.mkdirSync(RT.MODELS_DIR(), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
}

/**
 * The Iris model file, into ~/.codeply/models.
 * @param {object} RT  local-runtime.js
 */
async function installModel(RT, { id = 'iris-1', getToken, supabaseUrl, anonKey, onProgress, fetchImpl } = {}) {
  const spec = RT.CATALOG[id];
  if (!spec) throw new Error(`Unknown model ${id}.`);
  if (!spec.sha256) throw new Error('Iris has not been released yet. It will appear here when it is ready.');
  const dest = path.join(RT.MODELS_DIR(), spec.file);
  if (fs.existsSync(dest) && await sha256File(dest) === spec.sha256) { writeManifest(RT, { id, file: spec.file, sha256: spec.sha256, bytes: fs.statSync(dest).size, license: spec.license, addedAt: new Date().toISOString() }); return { skipped: true }; }
  const token = getToken ? await getToken() : '';
  if (!token) throw new Error('Sign in to Codeply to download Iris.');
  const url = await signedLink({ supabaseUrl, anonKey, token, storagePath: spec.storagePath, fetchImpl });
  const got = await download(url, dest, { sha256: spec.sha256, bytes: spec.bytes || 0, onProgress, fetchImpl });
  writeManifest(RT, { id, file: spec.file, sha256: got.sha256, bytes: got.bytes, license: spec.license, contract: spec.contract, addedAt: new Date().toISOString() });
  return { bytes: got.bytes };
}

/** Fixed batches Iris must answer with valid JSON that passes the guard. Nothing here touches the brain. */
const SELF_TEST = [
  { text: 'user: I moved to Lahore last month, still getting used to it', source: 'chat', at: Date.UTC(2026, 10, 10, 9, 0) },
  { text: 'user: lol I would totally live on the moon if I could', source: 'chat', at: Date.UTC(2026, 10, 10, 9, 5) },
  { text: 'user: remind me, my card number is 4111111111111111', source: 'chat', at: Date.UTC(2026, 10, 10, 9, 10) },
];

/**
 * Run Iris on the fixed batches. Passes when every answer is valid JSON and no secret got through the guard.
 * @param {object} provider  a context-iris.js provider
 */
async function selfTest(provider, { tz = 'Asia/Karachi' } = {}) {
  const results = [];
  for (const ev of SELF_TEST) {
    try {
      const r = await provider.extract({ events: [{ ...ev, trust: 'user' }], known: [], now: ev.at, tz });
      const iris = r.answer && r.answer.iris;
      const leaked = iris && iris.ops.some((op) => /4111111111111111/.test(`${op.val || ''} ${op.attr || ''}`) && op.op !== 'skip');
      results.push({ ok: !!(iris && iris.valid) && !leaked, ms: r.ms, ops: iris ? iris.ops.length : 0, leaked: !!leaked });
    } catch (e) {
      results.push({ ok: false, error: String(e && e.message || e).slice(0, 160) });
    }
  }
  return { ok: results.every((x) => x.ok), results };
}

/** Remove the model (and, with runtime: true, llama-server). */
function remove(RT, { id = 'iris-1', runtime = false } = {}) {
  const spec = RT.CATALOG[id];
  if (spec) { try { fs.unlinkSync(path.join(RT.MODELS_DIR(), spec.file)); } catch {} }
  writeManifest(RT, { id });
  if (runtime) { try { fs.rmSync(path.join(RT.RUNTIME_DIR(), 'bin'), { recursive: true, force: true }); } catch {} }
  return true;
}

/** What is on this PC, for Settings. */
function status(RT, id = 'iris-1') {
  const spec = RT.CATALOG[id] || {};
  const build = RT.runtimeBuild();
  const model = RT.models().find((m) => m.id === id) || null;
  return {
    supported: !!build,
    released: !!spec.sha256,
    sizeMB: Math.round(((spec.bytes || 0) + (build ? build.bytes : 0)) / 1048576) || null,
    runtime: !!RT.findBinary(),
    model: !!model,
    installing: busy ? busy.step : '',
    contract: spec.contract || '',
  };
}

/**
 * Everything Iris needs, in order. One install at a time; a second call joins the first.
 * @param {object} RT  local-runtime.js
 * @param {{ getToken, supabaseUrl, anonKey, onProgress?: (p: { step, done, total }) => void, fetchImpl? }} o
 */
function install(RT, o = {}) {
  if (busy) return busy.promise;
  const report = (step) => (p) => { if (o.onProgress) { try { o.onProgress({ step, ...p }); } catch {} } };
  busy = { step: 'runtime' };
  busy.promise = (async () => {
    try {
      await installRuntime(RT, { onProgress: report('runtime'), fetchImpl: o.fetchImpl });
      busy.step = 'model';
      await installModel(RT, { ...o, onProgress: report('model') });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e).slice(0, 300) };
    } finally { busy = null; }
  })();
  return busy.promise;
}

module.exports = { install, installRuntime, installModel, remove, status, selfTest, download, signedLink, tarExe, SELF_TEST, BUCKET };
