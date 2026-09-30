/**
 * One short, actionable recovery hint for a failed shell command, and a
 * warning when an exit code of 0 is hiding a failure.
 *
 * Adapted from Hermes Agent (tools/terminal_hints.py), MIT License,
 * Copyright (c) 2025 Nous Research - https://github.com/NousResearch/hermes-agent
 * Windows (cmd.exe / PowerShell) and Node patterns added for Codeply.
 *
 * Rules: hints only fire on a non-zero exit, first match wins, only the head
 * of the output is scanned (hints key on error headers, not deep logs), and
 * each hint states the next action to take. Pure functions, no I/O.
 */

const SCAN_CHARS = 4000;

const MISSING_COMMAND_HINTS = {
  python: 'There is no bare `python` here. Try `python3` or `py` (Windows launcher), or the project venv interpreter.',
  pip: 'There is no bare `pip` here. Try `pip3`, `python -m pip` / `py -m pip`, or the project venv pip.',
};

function missingCommandHint(cmd) {
  const name = String(cmd || '').replace(/^['"]|['"]$/g, '');
  const onWindows = process.platform === 'win32';
  return MISSING_COMMAND_HINTS[name.toLowerCase()] ||
    `\`${name}\` is not installed or not on PATH. Check with \`${onWindows ? `where ${name}` : `command -v ${name}`}\`, ` +
    `then install it (${onWindows ? 'winget, npm -g, or the tool\'s installer' : 'brew/apt/npm -g'}) or use its full path. ` +
    'Do not retry the same command unchanged.';
}

const rx = (pattern, message) => ({ pattern, message });

// The shell itself choked on the command's syntax. Retrying a variation of
// the same one-liner rarely works; a different tool does.
const WRITE_IT_INSTEAD = 'Do not retry a variation of this one-liner. Write the content with write_file instead ' +
  '(for a script: write_file it, then run it with node/python/etc.).';

// Ordered roughly by how often they show up. First match wins.
const OUTPUT_HINTS = [
  rx(/<< was unexpected at this time|The '<' operator is reserved for future use|Missing file specification after redirection operator|here-document at line \d+ delimited by end-of-file/i,
    `This shell cannot take a heredoc (<<) here (cmd.exe and PowerShell have none). ${WRITE_IT_INSTEAD}`),
  rx(/The token '&&' is not a valid statement separator|The token '\|\|' is not a valid statement separator/i,
    'This is Windows PowerShell 5.1, which has no && or ||. Chain with `;` (or `if ($?) { next }`), or run the whole line through `cmd /c "..."`.'),
  rx(/The string is missing the terminator|unexpected EOF while looking for matching|Unterminated quoted string|syntax error: unterminated quoted string/i,
    `The shell's quoting broke on this command (nested or multi-line quotes). ${WRITE_IT_INSTEAD}`),
  rx(/The command line is too long|Argument list too long|E2BIG/i,
    `The command is longer than the shell allows. ${WRITE_IT_INSTEAD}`),
  rx(/The filename, directory name, or volume label syntax is incorrect/i,
    'Windows rejected a path in this command: check for forward/back slash mix-ups, stray quotes, or characters like : * ? " < > | in a file name.'),
  rx(/^CONFLICT |Automatic merge failed|needs merge/m,
    'Git merge conflict. Do not retry this command. Fix the conflicted files listed above (edit, then `git add`), ' +
    'then continue (`git rebase --continue` or commit the merge), or abort with `--abort`.'),
  rx(/(?:bash: line \d+: |bash: |sh: \d*:? ?)?([\w.+-]+): command not found/, (m) => missingCommandHint(m[1])),
  // cmd.exe
  rx(/'([^']+)' is not recognized as an internal or external command/i, (m) => missingCommandHint(m[1])),
  // PowerShell
  rx(/The term '([^']+)' is not recognized as (?:the )?name of a cmdlet/i, (m) => missingCommandHint(m[1])),
  rx(/Cannot find module '([^']+)'/,
    (m) => m[1].startsWith('.') || m[1].includes('/') && !m[1].startsWith('@')
      ? `Node cannot find '${m[1]}'. Check the path is right relative to the file that requires it (list_dir), and the file extension.`
      : `Node cannot find the package '${m[1]}'. Run \`npm install\` in the project folder (or \`npm install ${m[1]}\` if it is not in package.json yet).`),
  rx(/(?:ModuleNotFoundError|ImportError): No module named '?([\w.]+)/,
    (m) => `Python cannot import '${m[1]}'. Usually the wrong interpreter is running: use the project venv's python. ` +
      'Only pip install it if it is genuinely missing from that environment.'),
  rx(/npm ERR! (?:code )?ERESOLVE|could not resolve dependency/i,
    'npm dependency conflict. Read which packages clash above; retry with `--legacy-peer-deps` only if the versions are genuinely compatible.'),
  rx(/Missing script: "?([\w:.-]+)/,
    (m) => `package.json has no "${m[1]}" script. Check the real script names (read package.json) instead of guessing.`),
  rx(/EADDRINUSE[^\n]*?:(\d+)/,
    (m) => `Port ${m[1]} is already in use, probably by a server you started earlier. Reuse that server, or pick another port.`),
  rx(/(?:fatal|error):.*?'([^']+)' already exists/,
    (m) => `'${m[1]}' already exists, so retrying unchanged will keep failing. Reuse it, pick another name, or delete it first if it is stale.`),
  rx(/API rate limit|was submitted too quickly/,
    'Rate limit hit, so immediate retries will keep failing. Do other work first and retry this later.'),
  rx(/Permission denied|EACCES|EPERM|Access is denied/,
    'Permission denied. Check the target path is writable and not open in another program; prefer a folder the user owns. ' +
    'Do not escalate privileges unless the task truly needs it.'),
  rx(/cannot be loaded because running scripts is disabled/i,
    'PowerShell blocked the script (execution policy). Run the tool through its .cmd shim (e.g. `npm.cmd`, `npx.cmd`) or through cmd instead of changing system policy.'),
  rx(/ENOENT[^\n]*?'([^']+)'/,
    (m) => `No such file or folder: '${m[1]}'. Check the path with list_dir before retrying.`),
];

const EXIT_CODE_HINTS = {
  124: 'Exit 124: the command timed out. Run something smaller, or start long-running servers in the background instead of waiting on them.',
  126: 'Exit 126: the file exists but is not executable. Run it through its interpreter (e.g. `node script.js`, `bash script.sh`).',
  127: 'Exit 127: command not found. Check it is installed and on PATH, or use its full path.',
  137: 'Exit 137: the process was killed, usually out of memory. Reduce what it processes at once before retrying.',
  9009: 'Exit 9009: Windows could not find that program. Check it is installed and on PATH (`where <name>`).',
};

/** @returns {string|null} one recovery hint for a failed command */
function annotateFailure(command, exitCode, output) {
  if (!exitCode) return null;
  const window = String(output || '').slice(0, SCAN_CHARS);
  if (window) {
    for (const { pattern, message } of OUTPUT_HINTS) {
      const m = window.match(pattern);
      if (m) return typeof message === 'function' ? message(m) : message;
    }
  }
  return EXIT_CODE_HINTS[exitCode] || null;
}

// ─── Masked success ─────────────────────────────────────────────────────────
// `npm test | tail -20` exits with tail's 0 and `build || echo done` with
// echo's 0, so the model can conclude a build passed while its own output
// says it failed. Needs BOTH a masking shape AND a strong, tool-specific
// failure line, and skips read-only commands whose output legitimately
// contains error text (grep for "error", cat a log).

const PASSTHROUGH = '(?:tail|head|cat|tee|less|more|wc|sort|uniq|Select-Object|Out-String|findstr)';
const MASKING_SHAPES = [
  [new RegExp(`(?<!\\|)\\|(?!\\|)\\s*${PASSTHROUGH}\\b[^|]*$`, 'i'),
    'Exit 0 here is the status of the last command in the pipe (tail/head/...), NOT of the command before it, and the ' +
    'output shows a failure. Treat this run as FAILED: run the command again without the pipe to get its real exit code.'],
  [/\|\|\s*(?:echo\b|printf\b|true\b|exit 0\b|:\s|:$)/i,
    'Exit 0 here comes from the `||` fallback, NOT from the command before it, and the output shows a failure. ' +
    'Treat this run as FAILED: run the command on its own to get its real exit code.'],
  [/;\s*(?:exit\s+0|echo\b[^;|&]*)\s*$/i,
    'Exit 0 here comes from the command after the `;`, NOT from the one before it, and the output shows a failure. ' +
    'Treat this run as FAILED: run the command on its own to get its real exit code.'],
];

const READONLY_HEADS = new Set(['grep', 'rg', 'ag', 'find', 'findstr', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'jq', 'awk', 'sed', 'echo', 'printf', 'get-content', 'select-string']);

const FAILURE_SHAPES = new RegExp([
  'error\\[E\\d+\\]', 'error: could not compile', 'error: aborting due to',   // rust
  'Traceback \\(most recent call last\\)',                                      // python
  '^(?:=+ )?\\d+ failed', '^FAILED (?:\\S+::|\\S+\\.py)',                       // pytest
  'compilation terminated\\.',                                                   // gcc/clang
  'npm ERR!', '^npm error ',                                                     // npm
  'BUILD FAILED', 'Build FAILED', 'FAILED: ',                                    // gradle/msbuild/ninja
  '^make(?:\\[\\d+\\])?: \\*\\*\\*',                                             // make
  '^\\s*(?:Tests?|Test Suites):\\s+\\d+ failed',                                 // jest/vitest
  'error TS\\d{4}:',                                                             // tsc
  '^SyntaxError: ',                                                              // node
].join('|'), 'm');

function firstToken(command) {
  for (const tok of String(command || '').trim().split(/\s+/)) {
    if (!tok.includes('=') || /^(=|\.\/|\/)/.test(tok)) return tok.split(/[\\/]/).pop().toLowerCase();
  }
  return '';
}

/** @returns {string|null} a warning when an exit-0 result likely hides a failure */
function annotateMaskedSuccess(command, output) {
  const window = String(output || '').slice(0, SCAN_CHARS);
  if (!command || !window || READONLY_HEADS.has(firstToken(command)) || !FAILURE_SHAPES.test(window)) return null;
  const hit = MASKING_SHAPES.find(([shape]) => shape.test(command));
  return hit ? hit[1] : null;
}

module.exports = { annotateFailure, annotateMaskedSuccess };
