/**
 * Quick syntax checks on a file the agent just wrote or edited, so a broken
 * change is reported in the same step instead of surfacing three steps later
 * (or never). Syntax only, and fast: nothing here type-checks a whole project
 * or needs a language server. Idea from opencode, which appends LSP errors to
 * edit results.
 *
 * checkFile() never throws; when a checker is missing or unsure it stays quiet.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TIMEOUT_MS = 8000;
const MAX_PROBLEMS = 10;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout || ''}${stderr || ''}`, missing: err && err.code === 'ENOENT' });
    });
  });
}

// ── JavaScript ──
async function checkJs(file) {
  const r = await run(process.execPath, ['--check', file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  if (r.code === 0) return [];
  const text = r.out.trim();
  // JSX in a .js file (common in React projects) is not plain JS; node can't judge it.
  if (/Unexpected token '<'|Unexpected token <|JSX/.test(text)) return [];
  const loc = text.match(/:(\d+)\r?\n/);
  const msg = (text.match(/^(SyntaxError: .+)$/m) || [null, text.split('\n').find((l) => l.trim()) || 'syntax error'])[1];
  return [`${loc ? `line ${loc[1]}: ` : ''}${msg}`];
}

// ── JSON ──
const JSONC_NAMES = /^(tsconfig.*|jsconfig.*|\.eslintrc|devcontainer|settings|launch|tasks|extensions)\.json$/i;
function checkJson(file, text) {
  if (JSONC_NAMES.test(path.basename(file)) || /[\\/]\.vscode[\\/]/.test(file)) return [];
  try { JSON.parse(text.replace(/^\uFEFF/, '')); return []; }
  catch (e) {
    const pos = Number((e.message.match(/position (\d+)/) || [])[1]);
    const line = Number.isFinite(pos) ? text.slice(0, pos).split('\n').length : null;
    return [`${line ? `line ${line}: ` : ''}invalid JSON (${e.message.replace(/ in JSON at position \d+.*$/, '')})`];
  }
}

// ── TypeScript / TSX, through the project's own compiler, syntax only ──
function findUp(start, rel, stop) {
  let dir = start;
  while (true) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir || (stop && dir === stop)) return null;
    dir = up;
  }
}
// ── Real type checking (semantic), in a warm worker per project ──
const { fork } = require('child_process');
const workers = new Map(); // project root -> { proc, pending, nextId, ready }
const FIRST_CHECK_MS = 25000; // a big project's first build can take a while
const CHECK_MS = 10000;

function typeWorker(projectRoot, tsDir) {
  let w = workers.get(projectRoot);
  if (w && !w.dead) return w;
  const proc = fork(path.join(__dirname, 'typecheck-worker.js'), [projectRoot, tsDir], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  w = { proc, pending: new Map(), nextId: 1, checks: 0, dead: false };
  proc.on('message', (m) => {
    const p = m && m.id != null && w.pending.get(m.id);
    if (p) { w.pending.delete(m.id); p(m); }
  });
  proc.on('exit', () => { w.dead = true; for (const [, p] of w.pending) p({ error: 'worker exited' }); w.pending.clear(); });
  proc.unref();
  workers.set(projectRoot, w);
  return w;
}

function typeCheck(file, projectRoot, tsDir) {
  const w = typeWorker(projectRoot, tsDir);
  const timeout = w.checks++ === 0 ? FIRST_CHECK_MS : CHECK_MS;
  return new Promise((resolve) => {
    const id = w.nextId++;
    const timer = setTimeout(() => { w.pending.delete(id); resolve(null); }, timeout);
    w.pending.set(id, (m) => { clearTimeout(timer); resolve(m.error ? null : m.problems); });
    try { w.proc.send({ id, file }); } catch { clearTimeout(timer); resolve(null); }
  });
}
process.on('exit', () => { for (const [, w] of workers) try { w.proc.kill(); } catch {} });

/**
 * Code navigation through the project's own TypeScript (works for .ts, .tsx, .js, .jsx).
 * @param {{op:'definition'|'references'|'implementation'|'hover'|'documentSymbol'|'workspaceSymbol', file?:string, line?:number, character?:number, symbol?:string, query?:string}} req
 * @returns {Promise<{ok:boolean, text:string}>}
 */
async function navigate(req, cwd) {
  const start = req.file ? path.dirname(req.file) : cwd;
  const tsDir = findUp(start, path.join('node_modules', 'typescript'), path.parse(cwd).root);
  if (!tsDir) return { ok: false, text: 'Code navigation needs TypeScript installed in the project (run npm install typescript). Use search instead.' };
  const cfg = findUp(start, 'tsconfig.json', path.parse(cwd).root) || findUp(start, 'jsconfig.json', path.parse(cwd).root);
  const projectRoot = cfg ? path.dirname(cfg) : cwd;
  const w = typeWorker(projectRoot, tsDir);
  const timeout = w.checks++ === 0 ? FIRST_CHECK_MS : CHECK_MS;
  return new Promise((resolve) => {
    const id = w.nextId++;
    const timer = setTimeout(() => { w.pending.delete(id); resolve({ ok: false, text: 'Code navigation timed out (the project is still loading). Try again, or use search.' }); }, timeout + 10000);
    w.pending.set(id, (m) => { clearTimeout(timer); resolve(m.error ? { ok: false, text: `Code navigation failed: ${m.error}` } : { ok: true, text: m.text }); });
    try { w.proc.send({ id, ...req }); } catch { clearTimeout(timer); resolve({ ok: false, text: 'Code navigation is unavailable.' }); }
  });
}

async function checkTs(file, text, cwd) {
  const tsDir = findUp(path.dirname(file), path.join('node_modules', 'typescript'), path.parse(cwd).root);
  if (!tsDir) return [];
  // With a tsconfig/jsconfig the project is set up for type checking: ask
  // the worker for real (semantic) errors. It falls back to the syntax-only
  // pass below when it's slow or unavailable.
  const cfg = findUp(path.dirname(file), 'tsconfig.json', path.parse(cwd).root) || findUp(path.dirname(file), 'jsconfig.json', path.parse(cwd).root);
  if (cfg) {
    const problems = await typeCheck(file, path.dirname(cfg), tsDir);
    if (problems) return problems;
  }
  let ts;
  try { ts = require(tsDir); } catch { return []; }
  const out = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: file.endsWith('x') ? ts.JsxEmit.Preserve : undefined, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error).map((d) => {
    const line = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null;
    return `${line ? `line ${line}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

// ── CSS: unbalanced braces are the classic broken-edit symptom ──
function checkCss(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  let depth = 0, line = 1;
  for (const ch of clean) {
    if (ch === '\n') line++;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return [`line ${line}: a "}" with no matching "{"`];
  }
  return depth > 0 ? [`${depth} "{" never closed (end of file)`] : [];
}

// ── Python ──
let pythonCmd; // undefined = not probed yet, null = none found
async function checkPy(file) {
  if (pythonCmd === undefined) {
    pythonCmd = null;
    for (const c of process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']) {
      const r = await run(c, ['--version']);
      if (r.code === 0 && /Python 3/.test(r.out)) { pythonCmd = c; break; }
    }
  }
  if (!pythonCmd) return [];
  const code = 'import sys,ast\nsrc=open(sys.argv[1],encoding="utf-8").read()\ntry:\n ast.parse(src)\nexcept SyntaxError as e:\n print(f"line {e.lineno}: SyntaxError: {e.msg}");sys.exit(1)';
  const r = await run(pythonCmd, ['-c', code, file]);
  return r.code === 0 ? [] : [r.out.trim().split('\n').pop()];
}

/**
 * @param {string} abs  absolute path of the file that just changed
 * @param {string} cwd  project root
 * @returns {Promise<string[]>} problems, empty when clean or not checkable
 */
async function checkFile(abs, cwd) {
  try {
    const ext = path.extname(abs).toLowerCase();
    if (!['.js', '.cjs', '.mjs', '.json', '.ts', '.tsx', '.mts', '.cts', '.jsx', '.css', '.py'].includes(ext)) return [];
    const stat = fs.statSync(abs);
    if (stat.size > 2_000_000) return [];
    const text = fs.readFileSync(abs, 'utf8');
    let problems = [];
    if (ext === '.js' || ext === '.cjs' || ext === '.mjs') problems = await checkJs(abs);
    else if (ext === '.json') problems = checkJson(abs, text);
    else if (ext === '.jsx' || ext.startsWith('.ts') || ext === '.mts' || ext === '.cts') problems = await checkTs(abs, text, cwd);
    else if (ext === '.css') problems = checkCss(text);
    else if (ext === '.py') problems = await checkPy(abs);
    return problems.filter(Boolean).slice(0, MAX_PROBLEMS);
  } catch { return []; }
}

module.exports = { checkFile, navigate };
