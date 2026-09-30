/**
 * Type-checks single files with the project's own TypeScript, in a separate
 * process so a slow first build never blocks the app. One worker per project
 * root; it keeps a LanguageService warm, so after the first file each check
 * only re-reads what changed.
 *
 * Messages in:  { id, file }            Messages out: { id, problems: string[] } | { id, error }
 * Started with: argv[2] = project root (folder with tsconfig/jsconfig), argv[3] = typescript module path
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const ts = require(process.argv[3]);
const MAX = 10;

const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') || ts.findConfigFile(root, ts.sys.fileExists, 'jsconfig.json');
let options = { allowJs: true, noEmit: true, skipLibCheck: true };
let fileNames = [];
if (configPath) {
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config || {}, ts.sys, path.dirname(configPath));
  options = { ...parsed.options, noEmit: true };
  fileNames = parsed.fileNames;
}
const extra = new Set(); // files checked that the config doesn't list

const versions = new Map();
const version = (f) => {
  try { return String(fs.statSync(f).mtimeMs); } catch { return '0'; }
};

const host = {
  getScriptFileNames: () => [...fileNames, ...extra],
  getScriptVersion: (f) => version(f),
  getScriptSnapshot: (f) => {
    if (!fs.existsSync(f)) return undefined;
    return ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8'));
  },
  getCurrentDirectory: () => root,
  getCompilationSettings: () => options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());

function check(file) {
  const abs = path.resolve(file);
  const norm = abs.replace(/\\/g, '/');
  if (!fileNames.some((f) => path.resolve(f) === abs)) extra.add(norm);
  versions.set(abs, version(abs));
  const diags = [...service.getSyntacticDiagnostics(norm), ...service.getSemanticDiagnostics(norm)]
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  return diags.slice(0, MAX).map((d) => {
    const line = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null;
    return `${line ? `line ${line}: ` : ''}TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

// ── Code navigation (the lsp tool): definition, references, hover, symbols ──
const rel = (f) => path.relative(root, f).replace(/\\/g, '/') || f;
function place(fileName, start) {
  const sf = service.getProgram().getSourceFile(fileName);
  if (!sf) return `${rel(fileName)}`;
  const { line, character } = sf.getLineAndCharacterOfPosition(start);
  return `${rel(fileName)}:${line + 1}:${character + 1}`;
}
function lineText(fileName, start) {
  const sf = service.getProgram().getSourceFile(fileName);
  if (!sf) return '';
  const { line } = sf.getLineAndCharacterOfPosition(start);
  return sf.text.split('\n')[line].trim().slice(0, 160);
}
let navFile = null;
function flattenTree(node, out, depth = 0) {
  for (const c of node.childItems || []) {
    const line = c.spans[0] ? navFile.getLineAndCharacterOfPosition(c.spans[0].start).line + 1 : '?';
    if (c.kind !== 'alias') out.push(`${'  '.repeat(depth)}${c.kind} ${c.text}  (line ${line})`);
    flattenTree(c, out, depth + 1);
  }
}

function navigate(msg) {
  const abs = path.resolve(msg.file || root);
  const norm = abs.replace(/\\/g, '/');
  if (msg.file && fs.existsSync(abs) && !fileNames.some((f) => path.resolve(f) === abs)) extra.add(norm);
  const op = msg.op;
  if (op === 'workspaceSymbol') {
    const items = (service.getNavigateToItems(msg.query || '', 200) || [])
      .filter((i) => !/[\\/]node_modules[\\/]/.test(i.fileName) && !/[\\/]typescript[\\/]lib[\\/]/.test(i.fileName))
      .slice(0, 40);
    return items.map((i) => `${i.kind} ${i.name}  ${place(i.fileName, i.textSpan.start)}`).join('\n') || 'No symbols match.';
  }
  const sf = service.getProgram().getSourceFile(norm);
  if (!sf) return `${msg.file} is not part of a TypeScript/JavaScript project this checker can see.`;
  if (op === 'documentSymbol') {
    navFile = sf;
    const out = [];
    flattenTree(service.getNavigationTree(norm), out);
    return out.join('\n') || 'No symbols in this file.';
  }
  // Position-based: 1-based line/character from the caller.
  const lines = sf.text.split('\n');
  const li = Math.min(Math.max((msg.line || 1) - 1, 0), lines.length - 1);
  let col = msg.character ? msg.character - 1 : -1;
  if (col < 0 && msg.symbol) {
    const at = lines[li].indexOf(msg.symbol);
    col = at >= 0 ? at : -1;
    if (col < 0) {
      const whole = new RegExp(`\\b${msg.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(sf.text);
      if (whole) return navigateAt(op, norm, whole.index);
      return `Could not find "${msg.symbol}" in ${msg.file}.`;
    }
  }
  if (col < 0) col = Math.max(0, lines[li].search(/\S/));
  const pos = sf.getPositionOfLineAndCharacter(li, col);
  return navigateAt(op, norm, pos);
}
function navigateAt(op, norm, pos) {
  if (op === 'hover') {
    const info = service.getQuickInfoAtPosition(norm, pos);
    if (!info) return 'No type information at that position.';
    const sig = ts.displayPartsToString(info.displayParts);
    const doc = ts.displayPartsToString(info.documentation);
    return doc ? `${sig}\n\n${doc}` : sig;
  }
  let locs;
  if (op === 'definition') locs = service.getDefinitionAtPosition(norm, pos) || [];
  else if (op === 'implementation') locs = service.getImplementationAtPosition(norm, pos) || [];
  else if (op === 'references') locs = service.getReferencesAtPosition(norm, pos) || [];
  else return `Unknown operation "${op}".`;
  if (!locs.length) return `No ${op} found at that position.`;
  const shown = locs.slice(0, 40).map((l) => `${place(l.fileName, l.textSpan.start)}  ${lineText(l.fileName, l.textSpan.start)}`);
  return `${locs.length} ${op === 'references' ? 'reference' : 'location'}${locs.length === 1 ? '' : 's'}${locs.length > 40 ? ' (first 40)' : ''}:\n${shown.join('\n')}`;
}

process.on('message', (msg) => {
  try {
    if (msg.op) process.send({ id: msg.id, text: navigate(msg) });
    else process.send({ id: msg.id, problems: check(msg.file) });
  } catch (e) { process.send({ id: msg.id, error: e.message }); }
});
process.send({ ready: true, hasConfig: !!configPath });
