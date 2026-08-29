/**
 * Codeply TUI — Google-brand interactive shell.
 *
 * Rendering model (important):
 *   Everything that is *finished* (banner + past messages + tool activity) is
 *   emitted through Ink's <Static>, which writes each item to stdout exactly
 *   once and never touches it again. Only the live area — spinner, approval
 *   prompt, command palette, composer, hints — lives in the re-rendered frame.
 *
 *   This is what kills the flicker/duplicate-screen bug: Ink redraws a frame by
 *   erasing the previous one, but it can only erase lines still on screen. Once
 *   the frame grows taller than the terminal, the erase is incomplete and the
 *   frame gets appended instead of replaced — you see the conversation twice.
 *   Keeping the live frame a handful of lines tall makes the redraw exact.
 *
 *   Rule for future edits: nothing tall goes outside <Static>.
 *
 *   ┌ scrollback (banner + conversation, via <Static>) ──┐
 *   ├ live frame ────────────────────────────────────────┤
 *   │ spinner · approval · palette · composer · hints    │
 *   └────────────────────────────────────────────────────┘
 */
import React from 'react';
import { Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import Spinner from 'ink-spinner';
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
  renderMarkdown, Panel, hexToAnsi, hexToAnsiBg, fillRow, SURFACE,
  ANSI_RESET, ANSI_BOLD, ANSI_DIM,
} from '../lib/render-md.mjs';
import { runAgent } from '../lib/agent.mjs';
import { TOOL_DISPLAY } from '../lib/tools.mjs';
import TextArea, { enableModifiedEnter, isTerminalReport } from '../lib/textarea.mjs';

// ─── Theme (Google brand) ───────────────────────────────────────────────────
const G = {
  blue: '#4285F4',
  red: '#EA4335',
  yellow: '#FBBC05',
  green: '#34A853',
};

const T = {
  accent: G.blue,
  text: '#e8eaed',
  secondary: '#9aa0a6',
  dim: '#80868b',
  muted: '#5f6368',
  faint: '#3c4043',
  border: '#3c4043',
  cycle: [G.blue, G.red, G.yellow, G.green],
};

// The mascot's own colour, from mascot.png — the home screen's box border and
// headings pick this up too, so the splash reads as one themed piece instead
// of the mascot looking like a sticker dropped on top of an unrelated blue box.
const MASCOT_ORANGE = '#E8821E';

const MODES = ['Build', 'Plan', 'Ask'];
const MODE_COLOR = { Build: G.blue, Plan: G.yellow, Ask: G.green };
const MODE_HINT = {
  Build: 'reads, edits and verifies files',
  Plan: 'investigates, then writes a plan',
  Ask: 'answers from the codebase, read-only',
};

// CODEPLY block letters — fixed per-letter widths, one Google color each.
// C=blue O=red D=yellow E=green P=blue L=red Y=yellow
const LOGO_SEGMENTS = [
  [
    { t: ' ██████╗ ', c: G.blue }, { t: ' ██████╗ ', c: G.red },
    { t: '██████╗  ', c: G.yellow }, { t: '███████╗ ', c: G.green },
    { t: '██████╗  ', c: G.blue }, { t: '██╗      ', c: G.red },
    { t: '██╗   ██╗', c: G.yellow },
  ],
  [
    { t: '██╔════╝ ', c: G.blue }, { t: '██╔═══██╗', c: G.red },
    { t: '██╔══██╗ ', c: G.yellow }, { t: '██╔════╝ ', c: G.green },
    { t: '██╔══██╗ ', c: G.blue }, { t: '██║      ', c: G.red },
    { t: '╚██╗ ██╔╝', c: G.yellow },
  ],
  [
    { t: '██║      ', c: G.blue }, { t: '██║   ██║', c: G.red },
    { t: '██║  ██║ ', c: G.yellow }, { t: '█████╗   ', c: G.green },
    { t: '██████╔╝ ', c: G.blue }, { t: '██║      ', c: G.red },
    { t: ' ╚████╔╝ ', c: G.yellow },
  ],
  [
    { t: '██║      ', c: G.blue }, { t: '██║   ██║', c: G.red },
    { t: '██║  ██║ ', c: G.yellow }, { t: '██╔══╝   ', c: G.green },
    { t: '██╔═══╝  ', c: G.blue }, { t: '██║      ', c: G.red },
    { t: '  ╚██╔╝  ', c: G.yellow },
  ],
  [
    { t: '╚██████╗ ', c: G.blue }, { t: '╚██████╔╝', c: G.red },
    { t: '██████╔╝ ', c: G.yellow }, { t: '███████╗ ', c: G.green },
    { t: '██║      ', c: G.blue }, { t: '███████╗ ', c: G.red },
    { t: '   ██║   ', c: G.yellow },
  ],
  [
    { t: ' ╚═════╝ ', c: G.blue }, { t: ' ╚═════╝ ', c: G.red },
    { t: '╚═════╝  ', c: G.yellow }, { t: '╚══════╝ ', c: G.green },
    { t: '╚═╝      ', c: G.blue }, { t: '╚══════╝ ', c: G.red },
    { t: '   ╚═╝   ', c: G.yellow },
  ],
];

// Pre-flattened to one ANSI string per row: 6 <Text> nodes instead of 42.
const LOGO_ROWS = LOGO_SEGMENTS.map((row) =>
  row.map((s) => hexToAnsi(s.c) + ANSI_BOLD + s.t + ANSI_RESET).join('')
);
const LOGO_WIDTH = LOGO_SEGMENTS[0].reduce((n, s) => n + s.t.length, 0);

const WORDMARK = hexToAnsi(G.yellow) + ANSI_BOLD + 'codeply' + ANSI_RESET;

const COMMANDS = [
  { name: '/login', description: 'Sign in with your Codeply account' },
  { name: '/logout', description: 'Sign out of current session' },
  { name: '/whoami', description: 'Show currently signed-in account' },
  { name: '/help', description: 'Show available commands' },
  { name: '/clear', description: 'Clear conversation and context' },
  { name: '/mode', description: 'Cycle Build → Plan → Ask' },
  { name: '/provider', description: 'Show or switch model provider (BYOK: openrouter, groq, anthropic, openai)' },
  { name: '/skill', description: 'List, install, or remove agent skills' },
  { name: '/keys', description: 'Show what your terminal sends for a key' },
  { name: '/quit', description: 'Exit Codeply' },
];

const TIPS = [
  ['ctrl+j', 'inserts a new line — or end a line with \\ and press enter'],
  ['Press tab', 'to cycle Build → Plan → Ask without leaving the composer'],
  ['Press esc', 'while it is working to interrupt the run'],
  ['Ask it to fix a failing test', 'it can run commands and iterate on the output'],
  ['Run /keys', 'to see exactly what your terminal sends for a key'],
];

const WHATS_NEW = [
  'Real subagents — delegate independent chunks of a task with `subagent`; every write it makes still asks you first',
  'Added shift+tab to toggle bypass permissions without leaving the composer',
  '/skill install now accepts a bare GitHub owner/repo, not just a full URL',
];

// A tiny pixel mascot echoing mascot.png's blocky orange creature — pointy
// ear notches, a solid head, two eyes, comb-like legs. The terminal's own
// background already stands in for every "black" pixel in the source art, so
// only the orange pixels need marking; everything else is a plain space.
const MASCOT_ROWS = [
  ' █   █ ',
  '████████',
  '██ █ ███',
  '████████',
  '█ █ █ █',
];

function homePath(cwd) {
  const home = os.homedir();
  if (cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

/** Shorten a path from the left so it never blows out the footer. */
function fitPath(p, max) {
  if (p.length <= max) return p;
  return '…' + p.slice(p.length - max + 1);
}

// ─── Home screen ────────────────────────────────────────────────────────────
//
// A single bordered box — title baked into the top border, a left column
// (identity: mascot, account, mode, cwd) and a right column (tips / what's
// new) split by one interior divider that runs the full height. Everything
// is pre-flattened to one ANSI string per row, same discipline as the rest of
// this file: a handful of <Text> nodes, not one per glyph.

const BOX_MIN_COLS = 74; // below this, two columns can't breathe — fall back to the compact mark

/** Pad/truncate plain text to exactly `width` visible columns, then colour it. */
function cell(text, width, color, opts = {}) {
  const t = String(text ?? '');
  const fit = t.length > width ? (width > 1 ? t.slice(0, width - 1) + '…' : t.slice(0, width)) : t;
  const pad = ' '.repeat(Math.max(0, width - fit.length));
  const styled = (color ? hexToAnsi(color) : '') + (opts.bold ? ANSI_BOLD : '') + (opts.dim ? ANSI_DIM : '') + fit + ANSI_RESET;
  return styled + pad;
}

/** Centre plain text within `width` columns before it goes through cell(). */
function centered(text, width) {
  const t = String(text ?? '');
  if (t.length >= width) return t;
  const left = Math.floor((width - t.length) / 2);
  return ' '.repeat(left) + t;
}

/** Shared by BoxHome and its caller — the caller needs leftInner/rightInner
 *  up front to centre text at the right width before the rows are built. */
function boxHomeMetrics(cols) {
  const boxWidth = Math.max(60, Math.min(cols - 2, 96));
  const leftColW = Math.round(boxWidth * 0.44);
  const rightColW = boxWidth - leftColW - 3; // 3 = two side borders + one divider
  return { boxWidth, leftColW, rightColW, leftInner: leftColW - 2, rightInner: rightColW - 2 };
}

function BoxHome({ cols, title, left, right, borderColor }) {
  const { boxWidth, leftInner, rightInner } = boxHomeMetrics(cols);
  const rowCount = Math.max(left.length, right.length);
  const border = hexToAnsi(borderColor);

  const topPrefix = `── ${title} `;
  const topDashes = Math.max(0, boxWidth - topPrefix.length - 2);
  const top = border + '┌' + topPrefix + '─'.repeat(topDashes) + '┐' + ANSI_RESET;
  const bottom = border + '└' + '─'.repeat(boxWidth - 2) + '┘' + ANSI_RESET;

  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const l = left[i] || { text: '' };
    const r = right[i] || { text: '' };
    rows.push(
      border + '│' + ANSI_RESET + ' ' +
        cell(l.text, leftInner, l.color, l) +
        ' ' + border + '│' + ANSI_RESET + ' ' +
        cell(r.text, rightInner, r.color, r) +
        ' ' + border + '│' + ANSI_RESET
    );
  }

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { key: 'top' }, top),
    ...rows.map((row, i) => React.createElement(Text, { key: `r${i}` }, row)),
    React.createElement(Text, { key: 'bot' }, bottom)
  );
}

function CompactMark({ cols }) {
  const wide = cols >= LOGO_WIDTH + 4;
  return React.createElement(
    Box,
    { flexDirection: 'column', width: cols, alignItems: 'center' },
    wide
      ? LOGO_ROWS.map((row, i) => React.createElement(Text, { key: `lg-${i}` }, row))
      : React.createElement(Text, { key: 'lg' }, WORDMARK),
    React.createElement(
      Box,
      { key: 'tag', marginTop: 1, flexDirection: 'column', alignItems: 'center' },
      React.createElement(
        Text,
        null,
        hexToAnsi(T.secondary) + 'An agent that reads your code, edits it, and checks its work.' + ANSI_RESET
      ),
      React.createElement(
        Text,
        null,
        hexToAnsi(T.muted) + 'interactive shell' + ANSI_RESET +
          hexToAnsi(T.faint) + '  ·  ' + ANSI_RESET +
          hexToAnsi(T.muted) + 'v' + VERSION + ANSI_RESET
      )
    )
  );
}

// ─── Message blocks ─────────────────────────────────────────────────────────

/** One line of tool activity in the transcript. */
function ToolLine({ msg }) {
  const display = TOOL_DISPLAY[msg.name] || { verb: msg.name, icon: '▸' };
  const failed = !msg.ok;
  const wrote = msg.name === 'write_file' || msg.name === 'edit_file';
  const ran = msg.name === 'run';

  const iconColor = failed ? G.red : wrote ? G.yellow : ran ? G.green : G.blue;
  const detail = [msg.label, msg.detail].filter(Boolean).join('  ·  ');

  return React.createElement(
    Text,
    { wrap: 'truncate-end' },
    hexToAnsi(iconColor) + display.icon + ' ' + ANSI_RESET +
      hexToAnsi(failed ? G.red : T.secondary) + display.verb.padEnd(6) + ANSI_RESET +
      hexToAnsi(T.dim) + ' ' + detail + ANSI_RESET
  );
}

function MessageBlock({ msg, cols }) {
  if (msg.role === 'user') {
    return React.createElement(
      Box,
      { flexDirection: 'row', marginBottom: 1, gap: 1 },
      React.createElement(Text, { color: G.blue }, '▌'),
      React.createElement(
        Box,
        { flexDirection: 'column', flexGrow: 1 },
        React.createElement(Text, null, hexToAnsi(T.dim) + ANSI_DIM + 'you' + ANSI_RESET),
        React.createElement(Text, { color: T.text, wrap: 'wrap' }, msg.content)
      )
    );
  }

  if (msg.role === 'assistant') {
    // A plan is a deliverable, not chatter — give it its own panel so it stands
    // apart from the running commentary above and below it.
    if (msg.plan) {
      return React.createElement(
        Box,
        { flexDirection: 'row', marginBottom: 1, gap: 1 },
        React.createElement(Text, { color: G.yellow }, '▌'),
        React.createElement(
          Box,
          { flexDirection: 'column', flexGrow: 1 },
          React.createElement(Panel, {
            title: 'plan',
            lines: msg.content.split('\n'),
            width: cols - 4,
            accent: G.yellow,
          })
        )
      );
    }
    return React.createElement(
      Box,
      { flexDirection: 'row', marginBottom: 1, gap: 1 },
      React.createElement(Text, { color: G.green }, '▌'),
      React.createElement(
        Box,
        { flexDirection: 'column', flexGrow: 1 },
        React.createElement(Text, null, WORDMARK),
        ...renderMarkdown(msg.content, cols - 4)
      )
    );
  }

  if (msg.role === 'tool') {
    return React.createElement(
      Box,
      { flexDirection: 'row', marginBottom: 0, paddingLeft: 2 },
      React.createElement(ToolLine, { msg })
    );
  }

  if (msg.role === 'system') {
    return React.createElement(
      Box,
      { flexDirection: 'row', marginBottom: 1, gap: 1 },
      React.createElement(Text, { color: G.yellow }, '◆'),
      React.createElement(Text, { color: T.secondary, wrap: 'wrap' }, msg.content)
    );
  }

  if (msg.role === 'error') {
    return React.createElement(
      Box,
      { flexDirection: 'row', marginBottom: 1, gap: 1 },
      React.createElement(Text, { color: G.red }, '✗'),
      React.createElement(Text, { color: G.red, wrap: 'wrap' }, msg.content)
    );
  }

  return null;
}

// ─── Command palette ────────────────────────────────────────────────────────

function CommandsMenu({ commands, selectedIndex }) {
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: T.border,
      paddingX: 1,
      marginBottom: 1,
      flexShrink: 0,
    },
    React.createElement(
      Text,
      null,
      hexToAnsi(T.muted) + '↑↓' + ANSI_RESET + hexToAnsi(T.faint) + ' select   ' + ANSI_RESET +
        hexToAnsi(T.muted) + 'tab' + ANSI_RESET + hexToAnsi(T.faint) + ' complete   ' + ANSI_RESET +
        hexToAnsi(T.muted) + 'esc' + ANSI_RESET + hexToAnsi(T.faint) + ' dismiss' + ANSI_RESET
    ),
    ...commands.map((cmd, i) => {
      const selected = i === selectedIndex;
      const nameColor = selected ? T.cycle[i % T.cycle.length] : T.secondary;
      return React.createElement(
        Text,
        { key: cmd.name, wrap: 'truncate-end' },
        (selected ? hexToAnsi(G.blue) + '› ' + ANSI_RESET : '  ') +
          hexToAnsi(nameColor) + (selected ? ANSI_BOLD : '') + cmd.name.padEnd(10) + ANSI_RESET +
          hexToAnsi(selected ? T.dim : T.faint) + ' ' + cmd.description + ANSI_RESET
      );
    })
  );
}

// ─── Approval prompt ────────────────────────────────────────────────────────

function ApprovalPrompt({ request }) {
  const accent = request.danger ? G.red : G.yellow;
  const lines = [];

  if (request.diff) {
    const removed = request.diff.search.split('\n').slice(0, 6);
    const added = request.diff.replace.split('\n').slice(0, 6);
    for (const l of removed) lines.push(hexToAnsi(G.red) + '- ' + l + ANSI_RESET);
    for (const l of added) lines.push(hexToAnsi(G.green) + '+ ' + l + ANSI_RESET);
  }

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: accent,
      paddingX: 1,
      marginBottom: 1,
      flexShrink: 0,
    },
    React.createElement(
      Text,
      { wrap: 'truncate-end' },
      hexToAnsi(accent) + ANSI_BOLD + request.title + ANSI_RESET +
        (request.danger ? hexToAnsi(G.red) + '   ⚠ looks destructive' + ANSI_RESET : '')
    ),
    request.detail && React.createElement(
      Text,
      { wrap: 'truncate-end' },
      hexToAnsi(T.secondary) + request.detail + ANSI_RESET
    ),
    ...lines.map((l, i) => React.createElement(Text, { key: i, wrap: 'truncate-end' }, l)),
    React.createElement(
      Text,
      null,
      hexToAnsi(G.green) + 'y' + ANSI_RESET + hexToAnsi(T.faint) + ' approve   ' + ANSI_RESET +
        hexToAnsi(G.blue) + 'a' + ANSI_RESET + hexToAnsi(T.faint) + ' approve all this session   ' + ANSI_RESET +
        hexToAnsi(G.red) + 'n' + ANSI_RESET + hexToAnsi(T.faint) + ' decline' + ANSI_RESET
    )
  );
}

// ─── Status bar ─────────────────────────────────────────────────────────────

/** Permission-bypass state and the running-agent count, pinned bottom-left. */
function StatusBar({ bypassMode, agentCount }) {
  const glyphColor = bypassMode ? G.yellow : T.muted;
  return React.createElement(
    Text,
    { wrap: 'truncate-end' },
    hexToAnsi(glyphColor) + ANSI_BOLD + '⏵⏵ ' + ANSI_RESET +
      hexToAnsi(bypassMode ? G.yellow : T.secondary) + `bypass permissions ${bypassMode ? 'on' : 'off'}` + ANSI_RESET +
      hexToAnsi(T.faint) + ' (shift+tab to cycle)' + ANSI_RESET +
      hexToAnsi(T.faint) + '  ·  ' + ANSI_RESET +
      hexToAnsi(T.muted) + '← ' + agentCount + (agentCount === 1 ? ' agent' : ' agents') + ANSI_RESET
  );
}

// ─── App ────────────────────────────────────────────────────────────────────

const App = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = React.useState(stdout?.columns || 80);
  const [rows, setRows] = React.useState(stdout?.rows || 24);

  const [input, setInput] = React.useState('');
  const [modeIndex, setModeIndex] = React.useState(0);
  const [session, setSession] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState('');
  const [elapsed, setElapsed] = React.useState(0);
  const [steps, setSteps] = React.useState(0);
  const [chatHistory, setChatHistory] = React.useState([]);
  const [staticKey, setStaticKey] = React.useState(0);
  const [showCommands, setShowCommands] = React.useState(false);
  const [selectedCommand, setSelectedCommand] = React.useState(0);
  const [filteredCommands, setFilteredCommands] = React.useState(COMMANDS);
  const [escArmed, setEscArmed] = React.useState(false);
  const [approval, setApproval] = React.useState(null);
  const [bypassMode, setBypassMode] = React.useState(false);
  const [activeAgents, setActiveAgents] = React.useState([]); // [{id,label}] — running subagents, this session's own run excluded
  // Only true once the terminal answers our capability query. Windows Terminal
  // never does, so there we advertise ctrl+j instead of lying about shift+enter.
  const [modifiedEnterWorks, setModifiedEnterWorks] = React.useState(false);
  const [keyProbe, setKeyProbe] = React.useState(false);

  const nextId = React.useRef(1);
  // A real AbortController, not a plain {aborted} object: its .signal ends up
  // handed straight to fetch() (see ai.js), which requires an actual
  // AbortSignal instance — a look-alike object throws a TypeError there
  // ("Expected signal ... to be an instance of AbortSignal"), and that
  // message contains the word "AbortSignal", which the fetch error classifier
  // then mistakes for a real abort. Net effect: every single turn "aborted"
  // immediately, before the model was ever called.
  const abortRef = React.useRef(new AbortController());
  const alwaysAllow = React.useRef(new Set());
  const convo = React.useRef([]); // {role,content} pairs handed to the agent

  const cwd = process.cwd();
  const mode = MODES[modeIndex];
  const modeColor = MODE_COLOR[mode];
  const tip = React.useMemo(() => TIPS[Math.floor(Math.random() * TIPS.length)], []);

  const push = React.useCallback((msg) => {
    setChatHistory((prev) => [...prev, { id: `m-${nextId.current++}`, ...msg }]);
  }, []);

  React.useEffect(() => {
    auth.getSession().then((s) => setSession(s)).catch(() => {});
  }, []);

  // Ask the terminal to disambiguate shift+enter from enter (see textarea.mjs).
  React.useEffect(() => enableModifiedEnter(stdout), [stdout]);

  React.useEffect(() => {
    if (!stdout) return;
    const onResize = () => { setCols(stdout.columns || 80); setRows(stdout.rows || 24); };
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  React.useEffect(() => {
    if (input.startsWith('/') && !input.includes('\n')) {
      const query = input.toLowerCase().split(/\s/)[0];
      const filtered = COMMANDS.filter((cmd) => cmd.name.startsWith(query));
      setFilteredCommands(filtered);
      setShowCommands(filtered.length > 0);
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

  // Elapsed counter while the agent works. The spinner already repaints the
  // live frame several times a second, so this ticker costs nothing extra.
  React.useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const startedAt = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);

  // ── approval bridge: tools await this promise, the keypress handler settles it ──
  const requestApproval = React.useCallback((request) => {
    if (bypassModeRef.current) return Promise.resolve('always');
    if (alwaysAllow.current.has(request.tool)) return Promise.resolve('always');
    return new Promise((resolve) => {
      setApproval({ request, resolve });
    });
  }, []);

  // Read inside the approval callback without re-creating it on every toggle —
  // requestApproval is captured once per run and handed down through several
  // layers of nested subagent calls, so it must see the current value, not a
  // stale one closed over when the run started.
  const bypassModeRef = React.useRef(false);
  React.useEffect(() => { bypassModeRef.current = bypassMode; }, [bypassMode]);

  // ── subagent bridge: nested runs report in here so the status bar can show them ──
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

  useInput((char, key) => {
    // The terminal's answer to our kitty query — proof that modified enter is
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
      if (char === 'y' || key.return) { settleApproval('once'); return; }
      if (char === 'a') { settleApproval('always'); return; }
      if (char === 'n' || key.escape) { settleApproval('reject'); return; }
      return;
    }

    if (key.escape) {
      if (running) { abortRef.current.abort(); setStatusLine('interrupting…'); return; }
      if (showCommands) { setShowCommands(false); return; }
      if (input.length > 0) {
        if (escArmed) { setInput(''); setEscArmed(false); }
        else { setEscArmed(true); }
        return;
      }
      if (escArmed) { exit(); } else { setEscArmed(true); }
      return;
    }

    if (key.ctrl && char === 'c') {
      if (running) { abortRef.current.abort(); return; }
      if (input.length > 0) { setInput(''); return; }
      exit();
      return;
    }

    if (key.tab && key.shift) {
      // Deliberately no chat message here — this is a status-bar toggle, not
      // conversation content, and pushing one would knock a bare "/"-free home
      // screen straight into the compact conversation layout for no reason.
      setBypassMode((b) => !b);
      return;
    }

    if (key.tab) {
      if (showCommands && filteredCommands.length > 0) {
        const sel = filteredCommands[selectedCommand];
        if (sel) { setInput(sel.name + ' '); setShowCommands(false); }
        return;
      }
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
      push({
        role: 'system',
        content: 'Commands\n' + COMMANDS.map((c) => `${c.name.padEnd(10)} ${c.description}`).join('\n') +
          '\n\nKeys\nshift+enter / ctrl+j   new line\ntab                    switch mode\nesc                    interrupt a run\n' +
          `\nModel\n${appConfig.describeProvider()}  —  change with \`codeply provider\`\n`,
      });
    } else if (cmd === '/clear') {
      // <Static> never re-renders what it already printed, so a clear means
      // wiping the terminal and remounting it with a fresh key. Empty history
      // also drops us back to the home splash.
      convo.current = [];
      if (stdout) stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setChatHistory([]);
      setStaticKey((k) => k + 1);
    } else if (cmd === '/mode') {
      const next = (modeIndex + 1) % MODES.length;
      setModeIndex(next);
      push({ role: 'system', content: `Mode → ${MODES[next]} — ${MODE_HINT[MODES[next]]}` });
    } else if (cmd === '/provider') {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const name = parts[0];

      if (!name) {
        const cfg = appConfig.getConfig();
        let msg = `Provider: ${appConfig.describeProvider(cfg)}\n` +
          `Providers: ${appConfig.PROVIDERS.join(', ')}\n` +
          'Set with /provider <name> [key]  —  e.g. /provider openrouter sk-or-v1-...';
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
      push({ role: 'system', content: `Provider → ${appConfig.describeProvider(appConfig.getConfig())}` });
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
            else push({ role: 'system', content: `Installed "${result.name}" → ${result.dest}` });
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
      exit();
    } else {
      push({ role: 'error', content: `Unknown command: ${cmd}. Type /help for available commands.` });
    }
  };

  // ── main turn ──
  const handleSubmit = async (value) => {
    const text = value.trim();
    if (!text || running) return;

    let submitValue = text;
    if (showCommands && filteredCommands[selectedCommand]) {
      const raw = text.split(/\s+/)[0].toLowerCase();
      if (!COMMANDS.some((c) => c.name === raw)) {
        submitValue = filteredCommands[selectedCommand].name;
      }
    }
    setShowCommands(false);
    setInput('');

    if (submitValue.startsWith('/')) {
      const [first, ...rest] = submitValue.split(/\s+/);
      await runCommand(first.toLowerCase(), rest.join(' '));
      return;
    }

    push({ role: 'user', content: submitValue });
    setRunning(true);
    setStatusLine('thinking…');
    setSteps(0);
    abortRef.current = new AbortController();

    const turn = [];
    try {
      const stream = runAgent({
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
          const isPlan = mode === 'Plan' && event.text.split('\n').length >= 3;
          push({ role: 'assistant', content: event.text, plan: isPlan });
          turn.push({ role: 'assistant', content: event.text });
          setStatusLine('working…');
        } else if (event.type === 'tool_start') {
          const display = TOOL_DISPLAY[event.name] || { verb: event.name };
          setSteps((n) => n + 1);
          setStatusLine(`${display.verb} ${event.args.path || event.args.command || event.args.pattern || ''}`.trim());
        } else if (event.type === 'tool_end') {
          const meta = event.meta || {};
          const unit = event.name === 'search' ? 'matches'
            : event.name === 'list_dir' ? 'entries'
            : 'lines';
          let detail = '';
          if (meta.count != null) detail = `${meta.count} ${unit}`;
          if (meta.added != null) detail = `-${meta.removed || 0} +${meta.added}`;
          if (meta.exitCode != null) detail = `exit ${meta.exitCode}`;
          if (meta.noop) detail = 'no change';
          if (meta.rejected) detail = 'declined';
          push({
            role: 'tool',
            name: event.name,
            ok: event.ok && !meta.rejected && (meta.exitCode == null || meta.exitCode === 0),
            label: event.summary || '',
            detail,
          });
          setStatusLine('thinking…');
        } else if (event.type === 'aborted') {
          push({ role: 'system', content: 'Interrupted.' });
        } else if (event.type === 'error') {
          push({ role: 'error', content: event.error });
        }
      }
    } catch (e) {
      push({ role: 'error', content: e.message });
    } finally {
      convo.current = [...convo.current, { role: 'user', content: submitValue }, ...turn];
      setRunning(false);
      setStatusLine('');
      // A run that ended while a prompt was up must not leave a dangling promise.
      setApproval((current) => { if (current) current.resolve('reject'); return null; });
    }
  };

  // Ollama needs no Codeply sign-in, so showing "not signed in" there would be
  // a false alarm — surface the model that is actually answering instead.
  const provider = React.useMemo(() => appConfig.getConfig(), []);
  const usingOllama = provider.provider === 'ollama';
  const account = usingOllama
    ? appConfig.describeProviderShort(provider)
    : session ? session.user.email : 'not signed in';

  // Advertise the key that actually inserts a newline in THIS terminal.
  const newlineKey = modifiedEnterWorks ? 'shift+enter' : 'ctrl+j';

  const isHome = chatHistory.length === 0;
  // The splash needs real estate; in a short or narrow window fall straight
  // through to the compact layout rather than rendering a cramped one.
  const showSplash = isHome && rows >= 22 && cols >= 44;
  // 1 for this session's own run, plus whatever subagents it has spawned and
  // are still going — matches what the status bar's "← N agent" is counting.
  const agentCount = 1 + activeAgents.length;

  // On home the composer is a centred column like an app window; in
  // conversation it spans the width so long messages have room.
  const shellWidth = showSplash ? Math.min(cols - 4, 92) : cols - 2;
  const inner = Math.max(20, shellWidth);

  // Two-column rows are laid out by hand: Ink truncates each child against the
  // width it was given, so without explicit widths the columns run into each
  // other on narrow terminals instead of truncating cleanly.
  const rightHint = escArmed
    ? `esc again to ${input.length > 0 ? 'clear' : 'quit'}`
    : running ? 'esc interrupts' : 'enter to send';
  const footRight = fitPath(homePath(cwd), Math.max(12, Math.floor(inner * 0.45))) + '  codeply ' + VERSION;
  const hintsWidth = Math.max(10, inner - rightHint.length - 2);
  const tipWidth = inner - footRight.length - 2;
  const showTip = tipWidth >= 24;

  const composer = React.createElement(
    Box,
    {
      key: 'composer',
      flexDirection: 'column',
      borderStyle: 'bold',
      borderTop: false,
      borderRight: false,
      borderBottom: false,
      borderLeftColor: running ? T.muted : modeColor,
      paddingLeft: 1,
      width: shellWidth,
      marginTop: showSplash ? 2 : 0,
      flexShrink: 0,
    },
    React.createElement(TextArea, {
      value: input,
      onChange: setInput,
      onSubmit: handleSubmit,
      width: inner - 3,
      focus: !running && !approval,
      allowVertical: !showCommands,
      placeholder: running
        ? 'working — esc to interrupt'
        : 'Ask for a change, a fix, or an explanation…  (/ for commands)',
    }),
    React.createElement(
      Text,
      { wrap: 'truncate-end' },
      hexToAnsi(modeColor) + ANSI_BOLD + mode + ANSI_RESET +
        hexToAnsi(T.faint) + '  ·  ' + ANSI_RESET +
        hexToAnsi(T.muted) + MODE_HINT[mode] + ANSI_RESET +
        hexToAnsi(T.faint) + '  ·  ' + ANSI_RESET +
        hexToAnsi(usingOllama || session ? T.dim : G.yellow) + account + ANSI_RESET
    )
  );

  const hints = React.createElement(
    Box,
    { key: 'hints', flexDirection: 'row', justifyContent: 'space-between', width: shellWidth, marginTop: 1, flexShrink: 0 },
    React.createElement(
      Box,
      { width: hintsWidth, flexShrink: 0 },
      React.createElement(
        Text,
        { wrap: 'truncate-end' },
        hexToAnsi(G.blue) + 'tab' + ANSI_RESET + hexToAnsi(T.faint) + ' mode   ' + ANSI_RESET +
          hexToAnsi(G.red) + newlineKey + ANSI_RESET + hexToAnsi(T.faint) + ' newline   ' + ANSI_RESET +
          hexToAnsi(G.yellow) + '/' + ANSI_RESET + hexToAnsi(T.faint) + ' commands   ' + ANSI_RESET +
          hexToAnsi(G.green) + 'esc' + ANSI_RESET + hexToAnsi(T.faint) + ' interrupt' + ANSI_RESET
      )
    ),
    React.createElement(
      Text,
      null,
      (escArmed ? hexToAnsi(G.yellow) : hexToAnsi(T.faint)) + rightHint + ANSI_RESET
    )
  );

  const tipLine = React.createElement(
    Box,
    { key: 'tip', width: shellWidth, flexShrink: 0 },
    showTip && React.createElement(
      Text,
      { wrap: 'truncate-end' },
      hexToAnsi(G.yellow) + '• ' + ANSI_RESET +
        hexToAnsi(T.muted) + tip[0] + ANSI_RESET +
        hexToAnsi(T.faint) + ' ' + tip[1] + ANSI_RESET
    )
  );

  const footer = React.createElement(
    Box,
    { key: 'footer', flexDirection: 'row', justifyContent: 'space-between', width: shellWidth, flexShrink: 0 },
    React.createElement(
      Box,
      { width: Math.max(0, tipWidth), flexShrink: 0 },
      showTip && React.createElement(
        Text,
        { wrap: 'truncate-end' },
        hexToAnsi(G.yellow) + '• ' + ANSI_RESET +
          hexToAnsi(T.muted) + tip[0] + ANSI_RESET +
          hexToAnsi(T.faint) + ' ' + tip[1] + ANSI_RESET
      )
    ),
    React.createElement(Text, null, hexToAnsi(T.faint) + footRight + ANSI_RESET)
  );

  const statusBar = React.createElement(
    Box,
    { key: 'statusbar', width: shellWidth, marginTop: 1, flexShrink: 0 },
    React.createElement(StatusBar, { bypassMode, agentCount })
  );

  // ── Home: one full-viewport screen, centred like an app ──
  if (showSplash) {
    const avail = rows - 1;
    const canBox = cols >= BOX_MIN_COLS;

    const { leftInner, rightInner } = boxHomeMetrics(cols);
    const welcomeName = (session?.user?.email || '').split('@')[0] || null;
    const leftRows = [
      { text: '' },
      { text: centered(welcomeName ? `Welcome back, ${welcomeName}!` : 'Welcome to Codeply', leftInner), bold: true, color: T.text },
      { text: '' },
      ...MASCOT_ROWS.map((row) => ({ text: centered(row, leftInner), color: T.accent })),
      { text: '' },
      { text: centered(`${mode} mode · v${VERSION}`, leftInner), color: T.muted },
      { text: centered(usingOllama || session ? account : 'not signed in — /login', leftInner), color: usingOllama || session ? T.secondary : G.yellow },
      { text: centered(fitPath(homePath(cwd), Math.max(10, leftInner - 2)), leftInner), color: T.faint },
    ];
    const rightRows = [
      { text: 'Tips for getting started', bold: true, color: T.accent },
      { text: `${tip[0]} ${tip[1]}` },
      { text: '' },
      { text: 'What\'s new', bold: true, color: T.accent },
      ...WHATS_NEW.map((line) => ({ text: line, color: T.secondary })),
    ].map((r) => ({ color: T.secondary, ...r }));

    return React.createElement(
      Box,
      { flexDirection: 'column', width: cols, height: avail, alignItems: 'center', justifyContent: 'center' },
      canBox
        ? React.createElement(BoxHome, {
            key: 'home', cols, title: `Codeply CLI v${VERSION}`,
            left: leftRows, right: rightRows, borderColor: T.accent,
          })
        : React.createElement(CompactMark, { key: 'home', cols }),
      composer,
      hints,
      tipLine,
      statusBar
    );
  }

  // ── Conversation: scrollback + a deliberately short live frame ──
  return React.createElement(
    Box,
    { flexDirection: 'column', width: cols, paddingX: 1 },

    // ── Scrollback: printed once, never redrawn. Keeps the live frame short. ──
    React.createElement(
      Static,
      { key: staticKey, items: chatHistory },
      (msg) => React.createElement(MessageBlock, { key: msg.id, msg, cols: cols - 2 })
    ),

    // ── Live frame below ──

    running && React.createElement(
      Box,
      { flexDirection: 'row', gap: 1, marginBottom: 1, flexShrink: 0 },
      React.createElement(Text, { color: T.accent }, React.createElement(Spinner, { type: 'dots' })),
      React.createElement(
        Text,
        { wrap: 'truncate-end' },
        hexToAnsi(T.dim) + (statusLine || 'working…') + ANSI_RESET +
          hexToAnsi(T.faint) + '   ' + elapsed + 's' + ANSI_RESET +
          (steps > 0 ? hexToAnsi(T.faint) + '  ·  step ' + steps + ANSI_RESET : '')
      )
    ),

    approval && React.createElement(ApprovalPrompt, { request: approval.request }),

    showCommands && React.createElement(CommandsMenu, {
      commands: filteredCommands,
      selectedIndex: selectedCommand,
    }),

    composer,
    hints,
    footer,
    statusBar
  );
};

export default App;
