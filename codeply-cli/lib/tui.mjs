/**
 * Codeply TUI - interactive shell.
 *
 * Layout follows the shape every good coding CLI has settled on (Claude Code,
 * Codex, Gemini CLI, OpenCode, Grok Build): a scrolling transcript, one quiet
 * input box at the bottom, one footer line under it.
 *
 *   ● Read src/config.js                 a step: bullet, tool, target
 *     ⎿  Read 84 lines                   its result, indented under it
 *   ● Update src/config.js
 *     ⎿  Updated src/config.js with 2 additions and 1 removal
 *        12 - const port = Number(raw);  inline diff, line numbers from the file
 *        12 + const port = parseInt(raw, 10);
 *   ╭──────────────────────────────────╮
 *   │ › _                              │
 *   ╰──────────────────────────────────╯
 *     Build mode (tab to switch)                       Haze 2
 *
 * Rendering model (important):
 *   Everything that is *finished* (banner + past messages + tool activity) is
 *   emitted through Ink's <Static>, which writes each item to stdout exactly
 *   once and never touches it again. Only the live area - spinner, approval
 *   prompt, command palette, composer, footer - lives in the re-rendered frame.
 *
 *   Ink redraws a frame by erasing the previous one, but it can only erase
 *   lines still on screen. Once the frame grows taller than the terminal, the
 *   erase is incomplete and the frame gets appended instead of replaced - you
 *   see the conversation twice. Keeping the live frame short makes the redraw
 *   exact. Rule for future edits: nothing tall goes outside <Static>.
 *
 *   Resizing changes where every line wraps, and <Static> cannot reflow what it
 *   already printed, so a width change clears the screen and reprints the
 *   transcript at the new width (the same thing Claude Code does).
 */
import React from 'react';
import { Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);
const auth = require('../lib/auth.js');
const appConfig = require('../lib/config.js');
const skills = require('../lib/skills.js');
const VERSION = require('../package.json').version;
import {
  renderMarkdown, Panel, hexToAnsi, hexToAnsiBg, visibleLength, SURFACE,
  ANSI_RESET, ANSI_BOLD, ANSI_ITALIC, ANSI_STRIKE,
} from '../lib/render-md.mjs';
import { runAgent } from '../lib/agent.mjs';
import { TOOL_DISPLAY } from '../lib/tools.mjs';
import TextArea, { enableModifiedEnter, isTerminalReport } from '../lib/textarea.mjs';
import { DshEngine, summarizeArgs } from '../lib/dsh-acp.mjs';

// ─── Glyphs ─────────────────────────────────────────────────────────────────
//
// Windows Terminal, VS Code and every macOS/Linux terminal have fonts with
// these symbols. The old console host (powershell.exe opened on its own) uses
// Consolas with no fallback, where most of them turn into boxes, so it gets a
// plain set. CODEPLY_ASCII=1 forces the plain set anywhere.

const FANCY = !process.env.CODEPLY_ASCII && (
  process.platform !== 'win32' ||
  !!process.env.WT_SESSION ||
  !!process.env.TERM_PROGRAM ||
  /xterm|kitty|alacritty|wezterm|ghostty/i.test(process.env.TERM || '')
);

const GL = FANCY
  ? {
    dot: '●', branch: '⎿', prompt: '›', pointer: '❯', star: '✻', warn: '⚠', cross: '✗',
    open: '☐', done: '☒', bypass: '⏵⏵', rule: '─', border: 'round',
    corners: ['╭', '╮', '╰', '╯'], spin: ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'],
  }
  : {
    dot: '•', branch: '└', prompt: '>', pointer: '>', star: '*', warn: '!', cross: 'x',
    open: '[ ]', done: '[x]', bypass: '>>', rule: '─', border: 'single',
    corners: ['┌', '┐', '└', '┘'], spin: ['-', '\\', '|', '/'],
  };

// ─── Theme ──────────────────────────────────────────────────────────────────
//
// Codeply blue (the app icon's #1f6bff) for the mascot and the welcome box, a
// lighter step of it for text so it stays readable on a dark background, greys
// for everything structural, and red/green/yellow kept for what they mean
// (failed, succeeded, needs attention).

const T = {
  brand: '#1f6bff',
  accent: '#5b9bff',
  text: '#e3e3e3',
  secondary: '#a8adb3',
  dim: '#80868b',
  faint: '#5f6368',
  border: '#4a4f55',
  ok: '#5bb974',
  err: '#f28b82',
  warn: '#fdd663',
};

const paint = (hex, s, extra = '') => hexToAnsi(hex) + extra + s + ANSI_RESET;
const bold = (hex, s) => paint(hex, s, ANSI_BOLD);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function fmtSecs(s) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const MODES = ['Build', 'Plan', 'Ask'];
const MODE_COLOR = { Build: T.accent, Plan: T.warn, Ask: '#81c995' };
const MODE_HINT = {
  Build: 'reads, edits and verifies files',
  Plan: 'investigates, then writes a plan',
  Ask: 'answers from the codebase, read-only',
};

// The Codeply agent: a solid blue ball with two eyes, in the spirit of Kimi
// CLI's blue square. Drawn as pixels, two per character cell with half blocks
// (▀: top pixel is the foreground colour, bottom pixel the background), which
// comes out square in a normal terminal font. The eyes are holes, so they take
// the terminal's own background colour. A slight top-to-bottom shade keeps it
// reading as a ball rather than a flat disc. Mirror-symmetric by construction.
const BALL_PIXELS = [
  '...XXXX...',
  '.XXXXXXXX.',
  '.XXXXXXXX.',
  'XXX.XX.XXX',
  'XXX.XX.XXX',
  'XXXXXXXXXX',
  'XXXXXXXXXX',
  '.XXXXXXXX.',
  '.XXXXXXXX.',
  '...XXXX...',
];
const BALL_TOP = '#6fa3ff';
const BALL_BOTTOM = '#1f56e0';

function shadeAt(y, h) {
  const t = h > 1 ? y / (h - 1) : 0;
  const a = [1, 3, 5].map((i) => parseInt(BALL_TOP.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(BALL_BOTTOM.slice(i, i + 2), 16));
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function drawBall(pixels) {
  const h = pixels.length;
  const rows = [];
  for (let y = 0; y < h; y += 2) {
    let line = '';
    for (let x = 0; x < pixels[y].length; x++) {
      const top = pixels[y][x] === 'X' ? shadeAt(y, h) : null;
      const bottom = pixels[y + 1] && pixels[y + 1][x] === 'X' ? shadeAt(y + 1, h) : null;
      if (!top && !bottom) line += ANSI_RESET + ' ';
      else if (top && !bottom) line += ANSI_RESET + hexToAnsi(top) + '▀';
      else if (!top) line += ANSI_RESET + hexToAnsi(bottom) + '▄';
      else line += hexToAnsi(top) + hexToAnsiBg(bottom) + '▀';
    }
    rows.push(line + ANSI_RESET);
  }
  return { rows, width: pixels[0].length };
}

const MASCOT = drawBall(BALL_PIXELS);

const COMMANDS = [
  { name: '/help', description: 'Show commands and keyboard shortcuts' },
  { name: '/clear', description: 'Clear the conversation and start fresh' },
  { name: '/mode', description: 'Cycle Build → Plan → Ask' },
  { name: '/provider', description: 'Show or switch the model provider (Haze 2 or your own key)' },
  { name: '/skill', description: 'List, install, or remove agent skills' },
  { name: '/login', description: 'Sign in with your Codeply account' },
  { name: '/logout', description: 'Sign out of this computer' },
  { name: '/whoami', description: 'Show the signed-in account' },
  { name: '/engine', description: 'Show or switch the engine: classic or dsh' },
  { name: '/keys', description: 'Show what your terminal sends for a key' },
  { name: '/quit', description: 'Exit Codeply' },
];

const WHATS_NEW = [
  'New terminal UI with inline diffs and step results',
  '↑ ↓ brings back earlier prompts',
  'Type while it works to queue a follow-up',
];

// ─── Tool presentation ──────────────────────────────────────────────────────

const TOOL_TITLE = {
  read_file: ['Read', 'Reading'],
  write_file: ['Write', 'Writing'],
  edit_file: ['Update', 'Editing'],
  apply_patch: ['Patch', 'Patching'],
  search: ['Search', 'Searching'],
  list_dir: ['List', 'Listing'],
  run: ['Run', 'Running'],
  job: ['Job', 'Checking job'],
  web_fetch: ['Fetch', 'Fetching'],
  web_search: ['Web search', 'Searching the web'],
  image_search: ['Image search', 'Searching images'],
  todo: ['Update todos', 'Updating todos'],
  use_skill: ['Skill', 'Loading skill'],
  list_skills: ['Skills', 'Listing skills'],
  browser_check: ['Browser check', 'Checking in the browser'],
  remember: ['Remember', 'Remembering'],
  recall: ['Recall', 'Recalling'],
  lsp: ['Code check', 'Checking code'],
  // The DSH engine's own tool names.
  read: ['Read', 'Reading'],
  edit: ['Update', 'Editing'],
  write: ['Write', 'Writing'],
  glob: ['Search', 'Searching'],
  grep: ['Search', 'Searching'],
  pwsh: ['Run', 'Running'],
  bash: ['Run', 'Running'],
  shell: ['Run', 'Running'],
};

function toolTitle(name) {
  if (TOOL_TITLE[name]) return TOOL_TITLE[name];
  const verb = (TOOL_DISPLAY[name] && TOOL_DISPLAY[name].verb) || String(name || 'tool').replace(/_/g, ' ');
  const cap = verb[0].toUpperCase() + verb.slice(1);
  return [cap, cap];
}

const argTarget = (args = {}) =>
  args.path || args.file_path || args.command || args.pattern || args.glob || args.url || args.query || args.name || '';

/** Line-level diff (LCS), so unchanged lines show as context, not -/+ pairs. */
function lineDiff(before, after) {
  const A = String(before ?? '').split('\n');
  const B = String(after ?? '').split('\n');
  const n = A.length;
  const m = B.length;
  if (n * m > 90000) return [...A.map((s) => ({ t: '-', s })), ...B.map((s) => ({ t: '+', s }))];
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: A[i++] });
    else out.push({ t: '+', s: B[j++] });
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}

/** 1-based line where `needle` starts in the file, or null. */
function lineOf(cwd, rel, needle) {
  if (!rel || !needle) return null;
  try {
    const content = fs.readFileSync(path.resolve(cwd, rel), 'utf8');
    const idx = content.indexOf(needle);
    return idx < 0 ? null : content.slice(0, idx).split('\n').length;
  } catch { return null; }
}

/** Diff rows as finished ANSI strings, filled to `width` like Claude Code's. */
function diffRows(diff, start, width, max = 24) {
  const w = Math.max(20, width);
  const numW = String((start || 1) + diff.length).length;
  let oldN = start || 1;
  let newN = start || 1;
  const rows = [];
  for (const d of diff.slice(0, max)) {
    const num = start ? String(d.t === '+' ? newN : oldN).padStart(numW) : ' '.repeat(numW);
    if (d.t !== '+') oldN++;
    if (d.t !== '-') newN++;
    let body = `${num} ${d.t} ${d.s.replace(/\t/g, '  ')}`;
    if (body.length > w) body = body.slice(0, w - 1) + '…';
    if (d.t === ' ') { rows.push(paint(T.dim, body)); continue; }
    const bg = d.t === '+' ? SURFACE.diffAdd : SURFACE.diffDel;
    const fg = d.t === '+' ? '#c8f2d2' : '#ffd4d4';
    rows.push(hexToAnsiBg(bg) + hexToAnsi(fg) + body + ' '.repeat(Math.max(0, w - body.length)) + ANSI_RESET);
  }
  if (diff.length > max) rows.push(paint(T.faint, `… +${diff.length - max} more lines`));
  return rows;
}

/** A finished tool call → a transcript entry with its result lines worked out. */
function toolMessage(e, cwd) {
  const meta = e.meta || {};
  const args = e.args || {};
  const [title] = toolTitle(e.name);
  const rejected = !!meta.rejected;
  const exitBad = meta.exitCode != null && meta.exitCode !== 0;
  const failed = !e.ok && !rejected;
  const msg = {
    role: 'tool',
    name: e.name,
    title,
    label: e.name === 'todo' ? '' : (meta.label || argTarget(args) || (e.ok ? e.summary : '') || ''),
    status: rejected ? 'declined' : failed || exitBad ? 'error' : 'ok',
    result: [],
  };
  const r = (s, color = T.dim) => msg.result.push(paint(color, s));

  if (rejected) { r('Declined', T.warn); return msg; }
  // A command that ran and failed still has output worth seeing: let it fall
  // through to the run/job rendering, which leads with the exit code.
  const ranAndFailed = (e.name === 'run' || e.name === 'job') && (meta.output != null || meta.exitCode != null);
  if (failed && !ranAndFailed) {
    msg.wrapResult = true;
    const why = String(e.error || e.summary || 'Failed').trim().split('\n').filter(Boolean).slice(0, 4);
    for (const line of why) r(stripAnsi(line), T.err);
    return msg;
  }

  switch (e.name) {
    case 'read_file':
      if (meta.linesShown && meta.count && meta.linesShown < meta.count) {
        const from = (meta.offset || 0) + 1;
        r(`Read lines ${from}-${from + meta.linesShown - 1} of ${meta.count}`);
      } else if (meta.count != null) r(`Read ${plural(meta.count, 'line')}`);
      break;
    case 'search':
      r(meta.count ? `Found ${plural(meta.count, 'match', 'matches')}` : 'No matches');
      break;
    case 'glob':
      r(meta.count ? `Found ${plural(meta.count, 'file')}` : 'No files found');
      break;
    case 'grep':
      r(meta.count ? `Found ${plural(meta.count, 'match', 'matches')}` : 'No matches');
      break;
    case 'list_dir':
      if (meta.count != null) r(plural(meta.count, 'entry', 'entries'));
      break;
    case 'edit_file': {
      if (meta.noop) { r('No changes needed'); break; }
      const search = args.search ?? args.old_string ?? args.old;
      const replace = args.replace ?? args.new_string ?? args.new;
      if (search != null && replace != null) {
        msg.diff = lineDiff(search, replace);
        msg.start = lineOf(cwd, args.path, replace);
        const adds = msg.diff.filter((d) => d.t === '+').length;
        const dels = msg.diff.filter((d) => d.t === '-').length;
        r(`Updated ${msg.label} with ${plural(adds, 'addition')} and ${plural(dels, 'removal')}`);
      } else {
        r(`Updated ${msg.label} (-${meta.removed || 0} +${meta.added || 0} lines)`);
      }
      break;
    }
    case 'write_file':
      if (meta.noop) { r('Already up to date, nothing written'); break; }
      if (!meta.removed) {
        r(`Wrote ${plural(meta.added || 0, 'line')} to ${msg.label}`);
        if (typeof args.content === 'string') {
          msg.diff = args.content.replace(/\n$/, '').split('\n').map((s) => ({ t: '+', s }));
          msg.start = 1;
          msg.maxDiff = 10;
        }
      } else {
        r(`Rewrote ${msg.label} (${meta.removed} → ${plural(meta.added || 0, 'line')})`);
      }
      break;
    case 'run':
    case 'job': {
      if (meta.background) { r(`Running in the background as job ${meta.jobId}`); break; }
      if (exitBad) r(`Exit code ${meta.exitCode}`, T.err);
      const out = stripAnsi(meta.output || '').replace(/\s+$/, '');
      const lines = out ? out.split('\n') : [];
      if (!lines.length && !exitBad) r('(no output)', T.faint);
      const SHOW = 5;
      if (lines.length > SHOW) r(`… ${plural(lines.length - SHOW, 'earlier line')}`, T.faint);
      for (const line of lines.slice(-SHOW)) r(line, T.secondary);
      break;
    }
    case 'todo':
      for (const t of meta.todos || []) {
        if (t.status === 'done') msg.result.push(paint(T.faint, `${GL.done} `) + paint(T.faint, t.text, ANSI_STRIKE));
        else if (t.status === 'dropped') msg.result.push(paint(T.faint, `${GL.open} ${t.text}`, ANSI_STRIKE));
        else if (t.status === 'in_progress') msg.result.push(paint(T.accent, `${GL.open} `) + bold(T.text, t.text));
        else msg.result.push(paint(T.secondary, `${GL.open} ${t.text}`));
      }
      break;
    default:
      if (meta.deduped) r('Unchanged, reused the earlier result');
      else if (meta.count != null) r(plural(meta.count, 'result'));
      else if (e.summary && e.summary !== msg.label) r(stripAnsi(e.summary));
  }

  if (Array.isArray(meta.problems) && meta.problems.length) {
    r(`${GL.warn} ${plural(meta.problems.length, 'problem')}: ${stripAnsi(meta.problems[0])}`, T.warn);
  }
  return msg;
}

/**
 * A DSH tool result (name, args, raw output text) in the shape the Classic
 * engine reports, so both engines get the same step rows and diffs.
 */
function fromDsh(e) {
  const a = e.args || {};
  const out = stripAnsi(e.output || '');
  const file = a.file_path || a.path || a.filePath;
  const lines = out.split('\n').filter((l) => l.trim());
  switch (e.name) {
    case 'read':
      return { ...e, name: 'read_file', args: { path: file }, meta: { label: file, count: (out.match(/^\d+: /gm) || []).length || undefined } };
    case 'edit':
      return { ...e, name: 'edit_file', args: { path: file, search: a.old_string, replace: a.new_string }, meta: { label: file } };
    case 'write':
      return { ...e, name: 'write_file', args: { path: file, content: a.content }, meta: { label: file, added: String(a.content || '').split('\n').length, removed: 0 } };
    case 'glob':
    case 'grep':
      return { ...e, meta: { label: a.pattern || a.query || '', count: e.ok ? lines.length : 0 } };
    case 'pwsh':
    case 'bash':
    case 'shell': {
      const code = /exit(?:\s+code)?:?\s*(-?\d+)/i.exec(out);
      return {
        ...e, name: 'run', args: { command: a.command },
        meta: { label: a.command, output: out.replace(/\n?\[stderr\]\n?/g, '\n'), exitCode: code ? Number(code[1]) : e.ok ? 0 : 1 },
      };
    }
    default:
      return { ...e, summary: e.ok ? lines[0] : undefined, meta: { label: summarizeArgs(a) } };
  }
}

function homePath(cwd) {
  const home = os.homedir();
  if (cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

/** Shorten a path from the left so it never blows out a line. */
function fitPath(p, max) {
  if (p.length <= max) return p;
  return '…' + p.slice(p.length - max + 1);
}

const fit = (s, max) => (s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s);

// ─── Banner (printed once into the scrollback) ──────────────────────────────
//
// Laid out like Kimi CLI's: one blue box sized to its content, the mascot on
// the left with the welcome text beside it, then where you are and what is
// answering. Everything is pre-flattened to one ANSI string per row.

// Picked once per launch, so a resize reprints the same line.
const GREETINGS = [
  (n) => `Hey ${n}! What are we building?`,
  (n) => `Welcome back, ${n}!`,
  (n) => `Good to see you, ${n}!`,
  (n) => `Hi ${n}, ready when you are`,
];
const GREETING_PICK = Math.floor(Math.random() * GREETINGS.length);
const GREETING = (name) => (name ? GREETINGS[GREETING_PICK](name) : 'Welcome to Codeply CLI!');

/** Styled pieces → { ansi, len } so rows can be padded by visible width. */
function piece(parts, max) {
  let ansi = '';
  let len = 0;
  for (const [text, color, isBold] of parts) {
    if (len >= max) break;
    const t = fit(String(text), max - len);
    ansi += paint(color, t, isBold ? ANSI_BOLD : '');
    len += t.length;
  }
  return { ansi, len };
}

function Banner({ cols, account, needsLogin, model, cwd, name, mode }) {
  const edge = (s) => paint(T.brand, s);
  const [tl, tr, bl, br] = GL.corners;
  const PAD = 3; // spaces between the border and the content, each side
  const GAP = 3; // between the mascot and the text beside it

  const side = [
    null,
    [[GREETING(name), T.text, true]],
    [['Send ', T.secondary], ['/help', T.text], [' for help, ', T.secondary], ['?', T.text], [' for shortcuts', T.secondary]],
    [[`${mode}`, T.accent], [mode === 'DSH engine' ? ' · /engine to switch' : ' · tab to switch', T.dim]],
    null,
  ];
  const info = [
    ['Directory:', [[homePath(cwd), T.secondary]], true],
    ['Account:', needsLogin ? [['not signed in, send /login to sign in', T.warn]] : [[account, T.secondary]]],
    ['Model:', [[model, T.secondary]]],
  ];
  const labelW = Math.max(...info.map(([l]) => l.length)) + 1;

  const plainLen = (parts) => parts.reduce((n, [t]) => n + String(t).length, 0);
  const wanted = Math.max(
    MASCOT.width + GAP + Math.max(...side.filter(Boolean).map(plainLen)),
    // A long path is shortened from the left rather than stretching the box.
    ...info.map(([, parts, isPath]) => labelW + (isPath ? Math.min(plainLen(parts), 48) : plainLen(parts)))
  );
  const inner = Math.max(20, Math.min(cols - 2 - 2 - PAD * 2, wanted));
  const width = inner + PAD * 2 + 2;

  const line = (p) => edge('│') + ' '.repeat(PAD) + p.ansi + ' '.repeat(Math.max(0, inner - p.len)) + ' '.repeat(PAD) + edge('│');
  const blank = line({ ansi: '', len: 0 });

  const rows = [edge(tl + GL.rule.repeat(width - 2) + tr), blank];
  const textRoom = inner - MASCOT.width - GAP;
  MASCOT.rows.forEach((ball, i) => {
    const text = side[i] && textRoom > 4 ? piece(side[i], textRoom) : { ansi: '', len: 0 };
    rows.push(line({ ansi: ball + ' '.repeat(GAP) + text.ansi, len: MASCOT.width + GAP + text.len }));
  });
  rows.push(blank);
  for (const [label, parts, isPath] of info) {
    const room = inner - labelW;
    const value = isPath ? [[fitPath(parts[0][0], room), parts[0][1]]] : parts;
    const p = piece(value, room);
    rows.push(line({ ansi: paint(T.dim, label.padEnd(labelW)) + p.ansi, len: labelW + p.len }));
  }
  rows.push(blank, edge(bl + GL.rule.repeat(width - 2) + br));

  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    ...rows.map((row, i) => React.createElement(Text, { key: i }, row))
  );
}

// ─── Transcript entries ─────────────────────────────────────────────────────

/** Bullet in a 2-column gutter, content beside it, one blank line after. */
function Bulleted({ bullet, children, gap = 1 }) {
  return React.createElement(
    Box,
    { flexDirection: 'row', marginBottom: gap },
    React.createElement(Box, { width: 2, flexShrink: 0 }, React.createElement(Text, null, bullet)),
    React.createElement(Box, { flexDirection: 'column', flexGrow: 1, flexShrink: 1 }, ...[].concat(children).filter(Boolean))
  );
}

/** The ⎿ result block under a step. */
function Result({ lines, wrap = 'truncate-end', extra = [] }) {
  if (!lines.length && !extra.length) return null;
  return React.createElement(
    Box,
    { flexDirection: 'row' },
    React.createElement(Box, { width: 3, flexShrink: 0 }, React.createElement(Text, null, paint(T.faint, GL.branch))),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1, flexShrink: 1 },
      ...lines.map((l, i) => React.createElement(Text, { key: `l${i}`, wrap }, l)),
      ...extra.map((l, i) => React.createElement(Text, { key: `x${i}` }, l))
    )
  );
}

function MessageBlock({ msg, cols, rows, banner }) {
  const width = cols - 2;

  if (msg.role === 'banner') return React.createElement(Banner, { cols, rows, ...banner });

  if (msg.role === 'user') {
    return React.createElement(
      Bulleted,
      { bullet: paint(T.dim, GL.prompt) },
      React.createElement(Text, { wrap: 'wrap' }, paint(T.secondary, msg.content))
    );
  }

  if (msg.role === 'assistant') {
    if (msg.plan) {
      return React.createElement(
        Bulleted,
        { bullet: paint(T.warn, GL.dot) },
        React.createElement(Panel, { title: 'Plan', lines: msg.content.split('\n'), width: width - 2, accent: T.warn })
      );
    }
    return React.createElement(Bulleted, { bullet: paint(T.text, GL.dot) }, ...renderMarkdown(msg.content, width - 2));
  }

  if (msg.role === 'tool') {
    const color = msg.status === 'error' ? T.err : msg.status === 'declined' ? T.warn : T.ok;
    const extra = msg.diff ? diffRows(msg.diff, msg.start, width - 5, msg.maxDiff || 24) : [];
    return React.createElement(
      Bulleted,
      { bullet: paint(color, GL.dot) },
      React.createElement(
        Text,
        { wrap: 'truncate-end' },
        bold(T.text, msg.title) + (msg.label ? ' ' + paint(T.secondary, msg.label.replace(/\s*\n\s*/g, ' ')) : '')
      ),
      React.createElement(Result, { lines: msg.result, wrap: msg.wrapResult ? 'wrap' : 'truncate-end', extra })
    );
  }

  if (msg.role === 'reasoning') {
    const preview = String(msg.text || '').replace(/\s+/g, ' ').trim();
    return React.createElement(
      Bulleted,
      { bullet: paint(T.faint, GL.star) },
      React.createElement(Text, null, paint(T.dim, `Thought for ${fmtSecs(Math.max(1, Math.round((msg.ms || 0) / 1000)))}`, ANSI_ITALIC)),
      preview && React.createElement(Text, { wrap: 'truncate-end' }, paint(T.faint, fit(preview, width * 2), ANSI_ITALIC))
    );
  }

  if (msg.role === 'notice') {
    const loud = msg.level === 'warn' || msg.level === 'limit';
    return React.createElement(
      Bulleted,
      { bullet: paint(loud ? T.warn : T.dim, loud ? GL.warn : GL.dot) },
      React.createElement(Text, { wrap: 'wrap' }, paint(loud ? T.warn : T.dim, msg.content))
    );
  }

  if (msg.role === 'system') {
    return React.createElement(
      Box,
      { flexDirection: 'row', marginBottom: 1, paddingLeft: 2 },
      React.createElement(Result, { lines: [paint(T.secondary, msg.content)], wrap: 'wrap' })
    );
  }

  if (msg.role === 'error') {
    return React.createElement(
      Bulleted,
      { bullet: paint(T.err, GL.dot) },
      React.createElement(Text, { wrap: 'wrap' }, paint(T.err, msg.content))
    );
  }

  if (msg.role === 'done') {
    const parts = [`Worked for ${fmtSecs(msg.secs)}`];
    if (msg.steps) parts.push(plural(msg.steps, 'step'));
    if (msg.files && msg.files.length) {
      parts.push(msg.files.length <= 2 ? `changed ${msg.files.join(', ')}` : `changed ${plural(msg.files.length, 'file')}`);
    }
    const label = ` ${parts.join(' · ')} `;
    const right = Math.max(0, width - label.length - 2);
    return React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { wrap: 'truncate-end' }, paint(T.faint, GL.rule.repeat(2) + label + GL.rule.repeat(right)))
    );
  }

  return null;
}

// ─── Live area ──────────────────────────────────────────────────────────────

// While the model is thinking (no tool running), the spinner word rotates
// every few seconds instead of sitting on one word for a minute.
const THINKING_WORDS = ['Thinking', 'Pondering', 'Tinkering', 'Brewing', 'Noodling', 'Cooking', 'Scheming', 'Untangling', 'Doodling'];

/** Spinner line with a soft shimmer running across the label. */
function Working({ label, startedAt, steps, queued, width }) {
  const wordOffset = React.useMemo(() => Math.floor(Math.random() * THINKING_WORDS.length), []);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const frame = GL.spin[tick % GL.spin.length];
  const word = label === 'Thinking' ? THINKING_WORDS[(wordOffset + Math.floor(secs / 4)) % THINKING_WORDS.length] : label;
  const text = `${word}…`;
  const head = tick % (text.length + 12);
  let shimmer = '';
  for (let i = 0; i < text.length; i++) {
    const d = Math.abs(i - head);
    shimmer += hexToAnsi(d === 0 ? '#ffffff' : d <= 2 ? T.text : T.secondary) + text[i];
  }
  const meta = [fmtSecs(secs), steps > 0 ? `step ${steps}` : null, 'esc to interrupt'].filter(Boolean).join(' · ');
  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1, width },
    React.createElement(Text, { wrap: 'truncate-end' }, paint(T.accent, frame + ' ') + shimmer + ANSI_RESET + paint(T.faint, ` (${meta})`)),
    queued && React.createElement(
      Text,
      { wrap: 'truncate-end' },
      paint(T.faint, `  ${GL.branch}  queued: `) + paint(T.secondary, queued.replace(/\s*\n\s*/g, ' '))
    )
  );
}

function approvalOptions(req) {
  const edits = ['edit_file', 'write_file', 'apply_patch'].includes(req.tool);
  const what = req.tool === 'run' ? 'commands' : edits ? 'file edits' : toolTitle(req.tool)[0].toLowerCase();
  return [
    { verdict: 'once', label: 'Yes' },
    { verdict: 'always', label: `Yes, and don't ask again for ${what} this session` },
    { verdict: 'reject', label: 'No (esc)' },
  ];
}

function approvalQuestion(req) {
  const base = req.path ? path.basename(req.path) : '';
  if (req.tool === 'edit_file') return `Do you want to make this edit to ${base}?`;
  if (req.tool === 'write_file') return /^Create/.test(req.title || '') ? `Do you want to create ${base}?` : `Do you want to overwrite ${base}?`;
  if (req.tool === 'run') return 'Do you want to run this command?';
  return 'Do you want to allow this?';
}

function ApprovalPrompt({ request, selected, cols, rows, cwd }) {
  const accent = request.danger ? T.err : T.accent;
  const width = cols - 2;
  const body = [];

  if (request.tool === 'run') {
    body.push(React.createElement(Text, { key: 'cmd', wrap: 'wrap' }, paint(T.dim, '$ ') + paint(T.text, request.detail || '')));
  } else if (request.detail && !request.diff) {
    body.push(React.createElement(Text, { key: 'det', wrap: 'wrap' }, paint(T.secondary, request.detail)));
  }
  if (request.diff) {
    const diff = lineDiff(request.diff.search, request.diff.replace);
    const start = lineOf(cwd, request.path, request.diff.search);
    const max = Math.max(3, rows - 16);
    diffRows(diff, start, width - 4, max).forEach((l, i) => body.push(React.createElement(Text, { key: `d${i}` }, l)));
  }

  const options = approvalOptions(request);
  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: GL.border, borderColor: accent, paddingX: 1, marginBottom: 1, width },
    React.createElement(
      Text,
      { wrap: 'truncate-end' },
      bold(accent, request.title || 'Permission needed') +
        (request.path && !String(request.title || '').includes(request.path) ? paint(T.dim, '  ' + request.path) : '') +
        (request.danger ? paint(T.err, `   ${GL.warn} looks destructive`) : '')
    ),
    ...body,
    React.createElement(Text, { key: 'q' }, ' '),
    React.createElement(Text, { key: 'qq', wrap: 'wrap' }, paint(T.text, approvalQuestion(request))),
    ...options.map((o, i) => React.createElement(
      Text,
      { key: `o${i}`, wrap: 'truncate-end' },
      i === selected
        ? paint(accent, `${GL.pointer} ${i + 1}. ${o.label}`)
        : paint(T.secondary, `  ${i + 1}. ${o.label}`)
    ))
  );
}

const PALETTE_ROWS = 8;

function CommandsMenu({ commands, selectedIndex, width }) {
  const start = Math.max(0, Math.min(selectedIndex - PALETTE_ROWS + 1, commands.length - PALETTE_ROWS));
  const shown = commands.slice(start, start + PALETTE_ROWS);
  const nameW = Math.max(...COMMANDS.map((c) => c.name.length)) + 3;
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingLeft: 2, width },
    ...shown.map((cmd, k) => {
      const selected = start + k === selectedIndex;
      return React.createElement(
        Text,
        { key: cmd.name, wrap: 'truncate-end' },
        selected
          ? bold(T.accent, cmd.name.padEnd(nameW)) + paint(T.text, cmd.description)
          : paint(T.secondary, cmd.name.padEnd(nameW)) + paint(T.dim, cmd.description)
      );
    }),
    commands.length > PALETTE_ROWS && React.createElement(
      Text,
      { key: 'more' },
      paint(T.faint, `${commands.length - PALETTE_ROWS} more, keep typing to filter`)
    )
  );
}

function Shortcuts({ width, newlineKey }) {
  const items = [
    ['/', 'for commands'], ['tab', 'to switch mode'], ['shift+tab', 'to toggle bypass'],
    [newlineKey, 'for a new line'], ['\\ enter', 'for a new line'], ['↑ ↓', 'for prompt history'],
    ['esc', 'to interrupt'], ['esc esc', 'to clear input'], ['ctrl+c', 'twice to quit'],
  ];
  const per = width >= 96 ? 3 : width >= 60 ? 2 : 1;
  const colW = Math.floor((width - 2) / per);
  const lines = [];
  for (let i = 0; i < items.length; i += per) {
    lines.push(items.slice(i, i + per).map(([k, d]) => {
      const cell = paint(T.text, k) + ' ' + paint(T.dim, d);
      return cell + ' '.repeat(Math.max(1, colW - k.length - d.length - 1));
    }).join(''));
  }
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingLeft: 2, width },
    ...lines.map((l, i) => React.createElement(Text, { key: i, wrap: 'truncate-end' }, l))
  );
}

// ─── App ────────────────────────────────────────────────────────────────────

const BANNER_ITEM = { id: 'banner', role: 'banner' };

const App = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = React.useState(stdout?.columns || 80);
  const [rows, setRows] = React.useState(stdout?.rows || 24);

  const [input, setInput] = React.useState('');
  const [modeIndex, setModeIndex] = React.useState(0);
  const [session, setSession] = React.useState(null);
  const [booted, setBooted] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [runStarted, setRunStarted] = React.useState(0);
  const [statusLine, setStatusLine] = React.useState('');
  const [steps, setSteps] = React.useState(0);
  const [chatHistory, setChatHistory] = React.useState([]);
  const [staticKey, setStaticKey] = React.useState(0);
  const [showCommands, setShowCommands] = React.useState(false);
  const [selectedCommand, setSelectedCommand] = React.useState(0);
  const [filteredCommands, setFilteredCommands] = React.useState(COMMANDS);
  const [showShortcuts, setShowShortcuts] = React.useState(false);
  const [escArmed, setEscArmed] = React.useState(false);
  const [ctrlCArmed, setCtrlCArmed] = React.useState(false);
  const [approval, setApproval] = React.useState(null);
  const [approvalIndex, setApprovalIndex] = React.useState(0);
  const [bypassMode, setBypassMode] = React.useState(false);
  const [activeAgents, setActiveAgents] = React.useState([]); // [{id,label}] - running subagents, this session's own run excluded
  const [queued, setQueued] = React.useState(null);
  const [exiting, setExiting] = React.useState(false);
  // Only true once the terminal answers our capability query. Windows Terminal
  // never does, so there we advertise ctrl+j instead of lying about shift+enter.
  const [modifiedEnterWorks, setModifiedEnterWorks] = React.useState(false);
  const [keyProbe, setKeyProbe] = React.useState(false);
  // 'classic' is codeply-cli's own agent; 'dsh' is Craft's DeepSeek Harness
  // fork, driven over ACP (see dsh-acp.mjs). `codeply dsh` starts in DSH.
  const [engine, setEngine] = React.useState(process.env.CODEPLY_ENGINE === 'dsh' ? 'dsh' : 'classic');
  const dshRef = React.useRef(null);
  const getDsh = React.useCallback(() => {
    if (!dshRef.current) dshRef.current = new DshEngine({ cwd: process.cwd() });
    return dshRef.current;
  }, []);
  const closeDsh = React.useCallback(() => {
    if (dshRef.current) { dshRef.current.close(); dshRef.current = null; }
  }, []);
  React.useEffect(() => {
    process.once('exit', closeDsh);
    return () => { process.off('exit', closeDsh); closeDsh(); };
  }, [closeDsh]);
  // Boot the engine in the background as soon as DSH is picked: its first
  // start takes a few seconds, and this hides most of it behind typing.
  React.useEffect(() => {
    if (engine !== 'dsh') return;
    getDsh().start().catch((e) => push({ role: 'error', content: e.message }));
  }, [engine]);

  const nextId = React.useRef(1);
  // A real AbortController, not a plain {aborted} object: its .signal ends up
  // handed straight to fetch() (see ai.js), which requires an actual
  // AbortSignal instance - a look-alike object throws a TypeError there
  // ("Expected signal ... to be an instance of AbortSignal"), and that
  // message contains the word "AbortSignal", which the fetch error classifier
  // then mistakes for a real abort. Net effect: every single turn "aborted"
  // immediately, before the model was ever called.
  const abortRef = React.useRef(new AbortController());
  const alwaysAllow = React.useRef(new Set());
  const convo = React.useRef([]); // {role,content} pairs handed to the agent
  const runningRef = React.useRef(false);
  const queuedRef = React.useRef(null);
  const submitRef = React.useRef(null);
  // Prompt history for up/down: past prompts, where we are in them, and the
  // unsent draft to come back to.
  const promptHistory = React.useRef([]);
  const historyPos = React.useRef(-1);
  const draft = React.useRef('');

  const cwd = process.cwd();
  const mode = MODES[modeIndex];
  const modeColor = MODE_COLOR[mode];

  const push = React.useCallback((msg) => {
    setChatHistory((prev) => [...prev, { id: `m-${nextId.current++}`, ...msg }]);
  }, []);

  // The banner names the account, so hold it back until the session lookup
  // settles (or briefly times out) instead of printing "not signed in" first.
  React.useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; setBooted(true); } };
    auth.getSession().then((s) => setSession(s)).catch(() => {}).finally(finish);
    const t = setTimeout(finish, 1200);
    return () => clearTimeout(t);
  }, []);

  // Ask the terminal to disambiguate shift+enter from enter (see textarea.mjs).
  React.useEffect(() => enableModifiedEnter(stdout), [stdout]);

  React.useEffect(() => {
    if (!stdout) return;
    const onResize = () => { setCols(stdout.columns || 80); setRows(stdout.rows || 24); };
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  // A width change reflows every line, and <Static> cannot reprint what it
  // already wrote: clear and print the whole transcript again at the new width.
  const firstWidth = React.useRef(true);
  React.useEffect(() => {
    if (firstWidth.current) { firstWidth.current = false; return; }
    const t = setTimeout(() => {
      if (stdout) stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setStaticKey((k) => k + 1);
    }, 150);
    return () => clearTimeout(t);
  }, [cols]);

  React.useEffect(() => {
    if (input.startsWith('/') && !input.includes('\n')) {
      const query = input.toLowerCase().split(/\s/)[0];
      const filtered = COMMANDS.filter((cmd) => cmd.name.startsWith(query));
      setFilteredCommands(filtered);
      setShowCommands(filtered.length > 0 && !input.includes(' '));
      setSelectedCommand(0);
    } else {
      setShowCommands(false);
    }
  }, [input]);

  React.useEffect(() => {
    if (!escArmed) return;
    const t = setTimeout(() => setEscArmed(false), 1500);
    return () => clearTimeout(t);
  }, [escArmed]);

  React.useEffect(() => {
    if (!ctrlCArmed) return;
    const t = setTimeout(() => setCtrlCArmed(false), 1500);
    return () => clearTimeout(t);
  }, [ctrlCArmed]);

  // Leave nothing behind: blank the live frame first, then exit, so the shell
  // prompt lands right under the transcript instead of under a dead input box.
  const quit = React.useCallback(() => {
    closeDsh();
    setExiting(true);
    setTimeout(() => exit(), 30);
  }, [exit]);

  // ── approval bridge: tools await this promise, the keypress handler settles it ──
  const requestApproval = React.useCallback((request) => {
    if (bypassModeRef.current) return Promise.resolve('always');
    if (alwaysAllow.current.has(request.tool)) return Promise.resolve('always');
    return new Promise((resolve) => {
      setApprovalIndex(0);
      setApproval({ request, resolve });
    });
  }, []);

  // Read inside the approval callback without re-creating it on every toggle -
  // requestApproval is captured once per run and handed down through several
  // layers of nested subagent calls, so it must see the current value, not a
  // stale one closed over when the run started.
  const bypassModeRef = React.useRef(false);
  React.useEffect(() => { bypassModeRef.current = bypassMode; }, [bypassMode]);

  // ── subagent bridge: nested runs report in here so the footer can show them ──
  const onSubagentEvent = React.useCallback((evt) => {
    if (evt.type === 'start') {
      setActiveAgents((prev) => [...prev, { id: evt.id, label: evt.label }]);
    } else if (evt.type === 'end') {
      setActiveAgents((prev) => prev.filter((a) => a.id !== evt.id));
    }
  }, []);

  const settleApproval = React.useCallback((verdict) => {
    setApproval((current) => {
      if (!current) return null;
      if (verdict === 'always') alwaysAllow.current.add(current.request.tool);
      current.resolve(verdict);
      return null;
    });
  }, []);

  // Up/down on the first/last line walks through earlier prompts.
  const onHistory = React.useCallback((dir) => {
    const list = promptHistory.current;
    if (!list.length) return false;
    let pos = historyPos.current;
    if (pos === -1) {
      if (dir > 0) return false;
      draft.current = input;
      pos = list.length - 1;
    } else {
      pos += dir;
    }
    if (pos < 0) pos = 0;
    if (pos >= list.length) {
      historyPos.current = -1;
      setInput(draft.current);
      return true;
    }
    historyPos.current = pos;
    setInput(list[pos]);
    return true;
  }, [input]);

  // "?" on an empty input opens the shortcuts list instead of typing a "?".
  const onChange = React.useCallback((next) => {
    if (input === '' && next === '?') { setShowShortcuts((s) => !s); return; }
    if (showShortcuts) setShowShortcuts(false);
    setInput(next);
  }, [input, showShortcuts]);

  useInput((char, key) => {
    // The terminal's answer to our kitty query - proof that modified enter is
    // really distinguishable here. Swallow it so it never reaches the draft.
    if (isTerminalReport(char)) { setModifiedEnterWorks(true); return; }

    // /keys diagnostic: report exactly what the terminal sent for one keypress.
    if (keyProbe) {
      setKeyProbe(false);
      const seq = JSON.stringify(char);
      const flags = ['ctrl', 'shift', 'meta', 'return', 'tab', 'escape', 'backspace', 'delete']
        .filter((f) => key[f]).join(', ') || 'none';
      push({ role: 'system', content: `Key sent: ${seq}\nFlags: ${flags}` });
      return;
    }

    // The approval prompt owns the keyboard while it is up.
    if (approval) {
      const options = approvalOptions(approval.request);
      if (key.upArrow) { setApprovalIndex((i) => (i > 0 ? i - 1 : options.length - 1)); return; }
      if (key.downArrow || key.tab) { setApprovalIndex((i) => (i + 1) % options.length); return; }
      if (key.return) { settleApproval(options[approvalIndex].verdict); return; }
      if (char === '1' || char === 'y') { settleApproval('once'); return; }
      if (char === '2' || char === 'a') { settleApproval('always'); return; }
      if (char === '3' || char === 'n' || key.escape) { settleApproval('reject'); return; }
      return;
    }

    if (key.escape) {
      if (running) { abortRef.current.abort(); setStatusLine('Interrupting'); return; }
      if (showCommands) { setShowCommands(false); return; }
      if (showShortcuts) { setShowShortcuts(false); return; }
      if (input.length > 0) {
        if (escArmed) { setInput(''); setEscArmed(false); }
        else { setEscArmed(true); }
        return;
      }
      return;
    }

    if (key.ctrl && char === 'c') {
      if (running) { abortRef.current.abort(); return; }
      if (input.length > 0) { setInput(''); return; }
      if (ctrlCArmed) { quit(); } else { setCtrlCArmed(true); }
      return;
    }

    if (key.tab && key.shift) {
      setBypassMode((b) => !b);
      return;
    }

    if (key.tab) {
      if (showCommands && filteredCommands.length > 0) {
        const sel = filteredCommands[selectedCommand];
        if (sel) { setInput(sel.name + ' '); setShowCommands(false); }
        return;
      }
      if (engine === 'dsh') return; // modes belong to the Classic engine
      setModeIndex((i) => (i + 1) % MODES.length);
      return;
    }

    if (showCommands) {
      if (key.upArrow) { setSelectedCommand((p) => (p > 0 ? p - 1 : filteredCommands.length - 1)); return; }
      if (key.downArrow) { setSelectedCommand((p) => (p < filteredCommands.length - 1 ? p + 1 : 0)); return; }
    }
  });

  // ── slash commands ──
  const runCommand = async (cmd, args = '') => {
    if (cmd === '/login') {
      push({ role: 'system', content: 'Opening sign-in…' });
      try {
        await auth.login();
        const s = await auth.getSession();
        setSession(s);
        push({ role: 'system', content: s ? `Signed in as ${s.user.email}` : 'Login cancelled or failed' });
      } catch (e) {
        push({ role: 'error', content: e.message || 'Login failed' });
      }
    } else if (cmd === '/logout') {
      await auth.logout();
      setSession(null);
      push({ role: 'system', content: 'Signed out' });
    } else if (cmd === '/whoami') {
      const s = await auth.getSession();
      push({ role: 'system', content: s ? s.user.email : 'Not signed in' });
    } else if (cmd === '/help') {
      const w = Math.max(...COMMANDS.map((c) => c.name.length)) + 3;
      push({
        role: 'system',
        content: 'Commands\n' + COMMANDS.map((c) => `  ${c.name.padEnd(w)}${c.description}`).join('\n') +
          '\n\nKeys\n' +
          `  ${(newlineKey + ' or \\ enter').padEnd(22)}new line\n` +
          `  ${'tab'.padEnd(22)}switch mode (Build, Plan, Ask)\n` +
          `  ${'shift+tab'.padEnd(22)}toggle bypass permissions\n` +
          `  ${'↑ ↓'.padEnd(22)}prompt history\n` +
          `  ${'esc'.padEnd(22)}interrupt a run, or twice to clear the input\n` +
          `  ${'ctrl+c'.padEnd(22)}twice to quit\n` +
          `\nModel\n  ${appConfig.describeProvider()}  (change with /provider)\n` +
          `\nWhat's new\n${WHATS_NEW.map((l) => `  ${l}`).join('\n')}`,
      });
    } else if (cmd === '/clear') {
      // <Static> never re-renders what it already printed, so a clear means
      // wiping the terminal and remounting it with a fresh key. The banner
      // comes back with it.
      convo.current = [];
      // A fresh DSH session too: the engine keeps its own history per session.
      if (engine === 'dsh') closeDsh();
      if (stdout) stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setChatHistory([]);
      setStaticKey((k) => k + 1);
    } else if (cmd === '/mode') {
      const next = (modeIndex + 1) % MODES.length;
      setModeIndex(next);
      push({ role: 'system', content: `${MODES[next]} mode: ${MODE_HINT[MODES[next]]}` });
    } else if (cmd === '/provider') {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const name = parts[0];

      if (!name) {
        const cfg = appConfig.getConfig();
        let msg = `Provider: ${appConfig.describeProvider(cfg)}\n` +
          `Providers: ${appConfig.PROVIDERS.join(', ')}\n` +
          'Set with /provider <name> [key], for example /provider openrouter sk-or-v1-...';
        if (cfg.provider === 'codeply') msg += `\n\n${appConfig.byokHint()}`;
        push({ role: 'system', content: msg });
        return;
      }

      if (!appConfig.PROVIDERS.includes(name)) {
        push({ role: 'error', content: `Unknown provider "${name}". Use one of: ${appConfig.PROVIDERS.join(', ')}.` });
        return;
      }

      const key = parts[1];
      const patch = { provider: name };
      if (key && (appConfig.BYOK_PROVIDERS.includes(name) || name === 'ollama')) {
        patch[name] = { apiKey: key };
      }

      const saved = appConfig.saveConfig(patch);
      if (!saved.ok) {
        push({ role: 'error', content: `Could not save config: ${saved.error}` });
        return;
      }
      setProvider(appConfig.getConfig());
      push({ role: 'system', content: `Provider set to ${appConfig.describeProvider(appConfig.getConfig())}` });
    } else if (cmd === '/engine') {
      const want = args.trim().toLowerCase();
      if (!want) {
        push({ role: 'system', content: `Engine: ${engine === 'dsh' ? "DSH (Craft's DeepSeek Harness fork, over ACP)" : 'Classic (codeply-cli)'}\nSwitch with /engine classic or /engine dsh` });
        return;
      }
      if (want !== 'dsh' && want !== 'classic') {
        push({ role: 'error', content: `Unknown engine "${want}". Use classic or dsh.` });
        return;
      }
      if (want === engine) { push({ role: 'system', content: `Already on the ${want === 'dsh' ? 'DSH' : 'Classic'} engine.` }); return; }
      if (want === 'classic') closeDsh();
      setEngine(want);
      push({ role: 'system', content: want === 'dsh' ? 'Switched to the DSH engine. Starting it…' : 'Switched to the Classic engine.' });
    } else if (cmd === '/keys') {
      push({ role: 'system', content: 'Press any key (or combination)…' });
      setKeyProbe(true);
    } else if (cmd === '/skill') {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      if (!sub || sub === 'list') {
        const list = skills.listSkills();
        if (list.length === 0) {
          push({ role: 'system', content: 'No skills available.' });
        } else {
          const lines = list.map((s) => `${s.name.padEnd(28)} [${s.source}]  ${s.description}`);
          push({ role: 'system', content: `Skills (${list.length})\n` + lines.join('\n') +
            '\n\n/skill install <path-or-github-url>   add one\n/skill remove <name>                   remove a user-installed one' });
        }
        return;
      }

      if (sub === 'install') {
        const source = parts.slice(1).join(' ');
        if (!source) { push({ role: 'error', content: 'Usage: /skill install <local-path-or-github-url>' }); return; }
        push({ role: 'system', content: `Installing from ${source}…` });
        try {
          const isLocal = fs.existsSync(source);
          const result = isLocal
            ? skills.installFromLocalDir(path.resolve(cwd, source))
            : await skills.installFromGitHub(source);
          if (isLocal) {
            if (!result.ok) push({ role: 'error', content: result.error });
            else push({ role: 'system', content: `Installed "${result.name}" to ${result.dest}` });
          } else if (!result.ok) {
            push({ role: 'error', content: result.error || `No skills installed from ${source}.` });
          } else {
            const names = result.installed.map((i) => i.name).join(', ');
            push({ role: 'system', content: `Installed ${result.installed.length} skill(s) from ${result.source}: ${names}` });
            if (result.failed.length) {
              push({ role: 'error', content: `${result.failed.length} failed: ${result.failed.map((f) => f.dir).join(', ')}` });
            }
          }
        } catch (e) {
          push({ role: 'error', content: `Install failed: ${e.message}` });
        }
        return;
      }

      if (sub === 'remove') {
        const name = parts[1];
        if (!name) { push({ role: 'error', content: 'Usage: /skill remove <name>' }); return; }
        const result = skills.removeSkill(name);
        push(result.ok
          ? { role: 'system', content: `Removed "${name}".` }
          : { role: 'error', content: result.error });
        return;
      }

      push({ role: 'error', content: `Unknown /skill subcommand "${sub}". Use list, install, or remove.` });
    } else if (cmd === '/quit' || cmd === '/exit') {
      quit();
    } else {
      push({ role: 'error', content: `Unknown command: ${cmd}. Type /help for available commands.` });
    }
  };

  // ── main turn ──
  const handleSubmit = async (value) => {
    const text = value.trim();
    if (!text) return;

    let submitValue = text;
    if (showCommands && filteredCommands[selectedCommand]) {
      const raw = text.split(/\s+/)[0].toLowerCase();
      if (!COMMANDS.some((c) => c.name === raw)) {
        submitValue = filteredCommands[selectedCommand].name;
      }
    }
    setShowCommands(false);
    setShowShortcuts(false);
    setInput('');
    historyPos.current = -1;
    draft.current = '';
    const list = promptHistory.current;
    if (list[list.length - 1] !== submitValue) list.push(submitValue);

    // Typed while a run is going: hold it and send it when the run ends.
    if (runningRef.current) {
      queuedRef.current = submitValue;
      setQueued(submitValue);
      return;
    }

    if (submitValue.startsWith('/')) {
      const [first, ...rest] = submitValue.split(/\s+/);
      const cmd = first.toLowerCase();
      if (cmd !== '/clear' && cmd !== '/quit' && cmd !== '/exit') push({ role: 'user', content: submitValue });
      await runCommand(cmd, rest.join(' '));
      return;
    }

    push({ role: 'user', content: submitValue });
    runningRef.current = true;
    setRunning(true);
    const startedAt = Date.now();
    setRunStarted(startedAt);
    setStatusLine('Thinking');
    setSteps(0);
    abortRef.current = new AbortController();
    let runMode = mode;

    const turn = [];
    try {
      if (engine === 'dsh' && !(dshRef.current && dshRef.current.sessionId)) setStatusLine('Starting the DSH engine');
      const stream = engine === 'dsh'
        ? getDsh().prompt(submitValue, { approve: requestApproval, signal: abortRef.current.signal })
        : runAgent({
        userMessage: submitValue,
        history: convo.current.slice(-20),
        mode,
        cwd,
        approve: requestApproval,
        signal: abortRef.current.signal,
        onSubagentEvent,
      });

      for await (const event of stream) {
        if (event.type === 'text') {
          // In Plan mode the substantial reply is the plan itself; short
          // interstitial notes ("let me check X") stay as ordinary prose.
          const isPlan = runMode === 'Plan' && !event.interim && event.text.split('\n').length >= 3;
          push({ role: 'assistant', content: event.text, plan: isPlan });
          turn.push({ role: 'assistant', content: event.text });
          setStatusLine('Thinking');
        } else if (event.type === 'reasoning') {
          push({ role: 'reasoning', text: event.text, ms: event.ms });
        } else if (event.type === 'notice') {
          push({ role: 'notice', level: event.level, content: event.text });
        } else if (event.type === 'tool_start') {
          const [, verb] = toolTitle(event.name);
          const target = argTarget(event.args).split('\n')[0];
          setSteps((n) => n + 1);
          setStatusLine(target ? `${verb} ${target}` : verb);
        } else if (event.type === 'tool_end') {
          push(toolMessage(event.engine === 'dsh' ? fromDsh(event) : event, cwd));
          setStatusLine('Thinking');
        } else if (event.type === 'verifying') {
          setStatusLine(`Verifying ${plural((event.files || []).length, 'file')}`);
        } else if (event.type === 'mode_switch') {
          const idx = MODES.indexOf(event.mode);
          if (idx >= 0) { setModeIndex(idx); runMode = event.mode; }
          push({ role: 'system', content: `Switched to ${event.mode} mode${event.planPath ? `. Plan saved to ${event.planPath}` : ''}` });
        } else if (event.type === 'done') {
          push({
            role: 'done',
            secs: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
            steps: event.steps,
            files: event.writtenFiles || [],
          });
        } else if (event.type === 'aborted') {
          push({ role: 'notice', level: 'info', content: 'Interrupted. Tell Codeply what to do instead, or press ↑ to edit your last message.' });
        } else if (event.type === 'error') {
          let content = event.error;
          if (event.limited && event.resetsAt) {
            const at = new Date(event.resetsAt);
            if (!Number.isNaN(at.getTime())) content += `\nResets at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
          }
          if (event.limited) content += `\n${appConfig.byokHint()}`;
          push({ role: 'error', content });
        }
      }
    } catch (e) {
      push({ role: 'error', content: e.message });
    } finally {
      convo.current = [...convo.current, { role: 'user', content: submitValue }, ...turn];
      runningRef.current = false;
      setRunning(false);
      setStatusLine('');
      // A run that ended while a prompt was up must not leave a dangling promise.
      setApproval((current) => { if (current) current.resolve('reject'); return null; });
      const next = queuedRef.current;
      if (next) {
        queuedRef.current = null;
        setQueued(null);
        setTimeout(() => submitRef.current && submitRef.current(next), 0);
      }
    }
  };
  submitRef.current = handleSubmit;

  // Ollama needs no Codeply sign-in, so showing "not signed in" there would be
  // a false alarm - surface the model that is actually answering instead.
  const [provider, setProvider] = React.useState(() => appConfig.getConfig());
  // The DSH engine always answers through Haze 2, whatever /provider says.
  const usingHaze = engine === 'dsh' || provider.provider === 'codeply';
  const needsLogin = usingHaze && !session;
  const modelLabel = engine === 'dsh' ? 'Haze 2 (auto) on the DSH engine' : usingHaze ? 'Haze 2 (auto)' : appConfig.describeProvider(provider);
  const modelShort = engine === 'dsh' ? 'DSH · Haze 2' : usingHaze ? 'Haze 2' : appConfig.describeProviderShort(provider);
  const account = session ? session.user.email : usingHaze ? 'not signed in' : 'using your own key';

  // Advertise the key that actually inserts a newline in THIS terminal.
  const newlineKey = modifiedEnterWorks ? 'shift+enter' : 'ctrl+j';

  if (exiting) return null;

  const width = Math.max(20, cols - 2);
  const items = booted ? [BANNER_ITEM, ...chatHistory] : [];
  const bannerProps = {
    account, needsLogin, model: modelLabel, cwd, mode: engine === 'dsh' ? 'DSH engine' : `${mode} mode`,
    name: (session?.user?.email || '').split('@')[0] || null,
  };

  // ── footer: one line, left = state, right = model ──
  let left;
  if (escArmed) left = paint(T.warn, `Press esc again to clear`);
  else if (ctrlCArmed) left = paint(T.warn, 'Press ctrl+c again to exit');
  else {
    left = (bypassMode ? paint(T.warn, `${GL.bypass} bypass permissions on`) + paint(T.faint, ' · ') : '') +
      (engine === 'dsh'
        ? paint(T.accent, 'DSH engine') + paint(T.faint, ' (/engine to switch)')
        : paint(modeColor, `${mode} mode`) + paint(T.faint, ' (tab to switch)'));
    if (!bypassMode && !running && !input) left += paint(T.faint, ' · ? for shortcuts');
  }
  const subagents = activeAgents.length;
  const rightPlain = (subagents ? `${plural(subagents, 'subagent')} · ` : '') + (needsLogin ? 'not signed in · /login' : modelShort);
  const right = (subagents ? paint(T.accent, `${plural(subagents, 'subagent')}`) + paint(T.faint, ' · ') : '') +
    (needsLogin ? paint(T.warn, 'not signed in · /login') : paint(T.dim, modelShort));
  const showRight = width - 4 - rightPlain.length >= 24;

  const footer = React.createElement(
    Box,
    { key: 'footer', flexDirection: 'row', width, paddingX: 2, flexShrink: 0 },
    React.createElement(
      Box,
      { flexGrow: 1, flexShrink: 1 },
      React.createElement(Text, { wrap: 'truncate-end' }, left)
    ),
    showRight && React.createElement(Box, { flexShrink: 0, marginLeft: 2 }, React.createElement(Text, null, right))
  );

  const borderColor = approval ? T.faint : bypassMode ? T.warn : mode === 'Build' ? T.border : modeColor;
  const composer = React.createElement(
    Box,
    { key: 'composer', flexDirection: 'row', borderStyle: GL.border, borderColor, paddingX: 1, width, flexShrink: 0 },
    React.createElement(Text, null, paint(running ? T.faint : T.accent, GL.prompt + ' ')),
    React.createElement(TextArea, {
      value: input,
      onChange,
      onSubmit: handleSubmit,
      onHistory,
      width: width - 6,
      focus: !approval && !keyProbe,
      allowVertical: !showCommands,
      placeholder: running
        ? 'Type to queue a follow-up'
        : 'Ask for a change, a fix, or an explanation',
    })
  );

  return React.createElement(
    Box,
    { flexDirection: 'column', width: cols },

    // ── Scrollback: printed once, never redrawn. Keeps the live frame short. ──
    // <Static> is absolutely positioned, so a parent's right padding does not
    // narrow it: each item carries its own width instead, or every wrapped
    // line comes out one column too wide and spills onto the next row.
    React.createElement(
      Static,
      { key: staticKey, items },
      (msg) => React.createElement(
        Box,
        { key: msg.id, width: cols - 1, paddingLeft: 1 },
        React.createElement(MessageBlock, { msg, cols, rows, banner: bannerProps })
      )
    ),

    // ── Live frame below ──
    React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    running && !approval && React.createElement(Working, {
      label: statusLine || 'Thinking', startedAt: runStarted, steps, queued, width,
    }),

    approval && React.createElement(ApprovalPrompt, {
      request: approval.request, selected: approvalIndex, cols, rows, cwd,
    }),

    booted && composer,
    booted && showCommands && React.createElement(CommandsMenu, { commands: filteredCommands, selectedIndex: selectedCommand, width }),
    booted && showShortcuts && !showCommands && React.createElement(Shortcuts, { width, newlineKey }),
    booted && !showCommands && footer
    )
  );
};

export default App;
