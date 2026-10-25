/**
 * Quick syntax checks on a file the agent just wrote or edited, so a broken
 * change is reported in the same step instead of surfacing three steps later
 * (or never). Syntax only, and fast: nothing here needs a language server.
 *
 * Ported from Classic Craft (codeply-cli/lib/diagnostics.js), whose idea came
 * from opencode appending LSP errors to edit results. checkFile() never
 * throws; when a checker is missing or unsure it stays quiet.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, parse } from 'node:path'

const TIMEOUT_MS = 8000
const MAX_PROBLEMS = 10

interface RunResult { code: number; out: string }

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1
      done({ code, out: `${stdout}${stderr}` })
    })
  })
}

// ── JavaScript ──
async function checkJs(file: string): Promise<string[]> {
  const r = await run(process.execPath, ['--check', file])
  if (r.code === 0) return []
  const text = r.out.trim()
  // JSX in a .js file (common in React projects) is not plain JS; node can't judge it.
  if (/Unexpected token '<'|Unexpected token <|JSX/.test(text)) return []
  const loc = text.match(/:(\d+)\r?\n/)
  const msg = text.match(/^(SyntaxError: .+)$/m)?.[1] ?? text.split('\n').find(l => l.trim().length > 0) ?? 'syntax error'
  return [`${loc ? `line ${loc[1]}: ` : ''}${msg}`]
}

// ── JSON ──
const JSONC_NAMES = /^(tsconfig.*|jsconfig.*|\.eslintrc|devcontainer|settings|launch|tasks|extensions)\.json$/i
function checkJson(file: string, text: string): string[] {
  if (JSONC_NAMES.test(basename(file)) || /[\\/]\.vscode[\\/]/.test(file)) return []
  try {
    JSON.parse(text.replace(/^\uFEFF/, ''))
    return []
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const pos = Number(message.match(/position (\d+)/)?.[1])
    const line = Number.isFinite(pos) ? text.slice(0, pos).split('\n').length : null
    return [`${line !== null ? `line ${line}: ` : ''}invalid JSON (${message.replace(/ in JSON at position \d+.*$/, '')})`]
  }
}

// ── TypeScript / TSX, through the project's own compiler, syntax only ──
function findUp(start: string, rel: string): string | null {
  let dir = start
  const root = parse(start).root
  while (true) {
    const p = join(dir, rel)
    if (existsSync(p)) return p
    if (dir === root) return null
    dir = dirname(dir)
  }
}

interface TsLike {
  transpileModule(text: string, options: Record<string, unknown>): { diagnostics?: { category: number; start?: number; file?: { getLineAndCharacterOfPosition(p: number): { line: number } }; messageText: unknown }[] }
  flattenDiagnosticMessageText(m: unknown, sep: string): string
  DiagnosticCategory: { Error: number }
  JsxEmit: { Preserve: number }
  ScriptTarget: { ESNext: number }
  ModuleKind: { ESNext: number }
}

function checkTs(file: string, text: string): string[] {
  const tsDir = findUp(dirname(file), join('node_modules', 'typescript'))
  if (tsDir === null) return []
  let ts: TsLike
  // The project's own compiler, resolved from the edited file.
  try { ts = createRequire(file)('typescript') as TsLike } catch { return [] }
  const out = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: file.endsWith('x') ? ts.JsxEmit.Preserve : undefined, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  })
  return (out.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).map((d) => {
    const line = d.file !== undefined && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null
    return `${line !== null ? `line ${line}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`
  })
}

// ── CSS: unbalanced braces are the classic broken-edit symptom ──
function checkCss(text: string): string[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
  let depth = 0
  let line = 1
  for (const ch of clean) {
    if (ch === '\n') line++
    else if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) return [`line ${line}: a "}" with no matching "{"`]
  }
  return depth > 0 ? [`${depth} "{" never closed (end of file)`] : []
}

// ── Python ──
let pythonCmd: string | null | undefined // undefined = not probed yet, null = none found
async function checkPy(file: string): Promise<string[]> {
  if (pythonCmd === undefined) {
    pythonCmd = null
    for (const c of process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']) {
      const r = await run(c, ['--version'])
      if (r.code === 0 && /Python 3/.test(r.out)) { pythonCmd = c; break }
    }
  }
  if (pythonCmd === null) return []
  const code = 'import sys,ast\nsrc=open(sys.argv[1],encoding="utf-8").read()\ntry:\n ast.parse(src)\nexcept SyntaxError as e:\n print(f"line {e.lineno}: SyntaxError: {e.msg}");sys.exit(1)'
  const r = await run(pythonCmd, ['-c', code, file])
  return r.code === 0 ? [] : [r.out.trim().split('\n').pop() ?? 'SyntaxError']
}

const CHECKED = new Set(['.js', '.cjs', '.mjs', '.json', '.ts', '.tsx', '.mts', '.cts', '.jsx', '.css', '.py'])

/**
 * Check one file that just changed.
 * @param abs - absolute path of the file.
 * @returns problems, empty when clean or not checkable.
 */
export async function checkFile(abs: string): Promise<string[]> {
  try {
    const ext = extname(abs).toLowerCase()
    if (!CHECKED.has(ext)) return []
    if ((await stat(abs)).size > 2_000_000) return []
    const text = await readFile(abs, 'utf8')
    let problems: string[] = []
    if (ext === '.js' || ext === '.cjs' || ext === '.mjs') problems = await checkJs(abs)
    else if (ext === '.json') problems = checkJson(abs, text)
    else if (ext === '.jsx' || ext.startsWith('.ts') || ext === '.mts' || ext === '.cts') problems = checkTs(abs, text)
    else if (ext === '.css') problems = checkCss(text)
    else if (ext === '.py') problems = await checkPy(abs)
    return problems.filter(Boolean).slice(0, MAX_PROBLEMS)
  } catch {
    return []
  }
}
