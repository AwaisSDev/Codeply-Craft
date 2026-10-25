/**
 * Codeply TUI - Markdown renderer for AI responses.
 *
 * Turns a reply into Ink elements, one pre-flattened ANSI string per row
 * wherever possible (Ink allocates a layout node per element, so per-token
 * <Text> nodes make long replies crawl).
 *
 * Code blocks are printed without line numbers or filled backgrounds on
 * purpose: people select code straight out of the terminal, and a gutter or
 * trailing fill comes along with every copy.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const G = {
  blue: '#4285F4',
  red: '#EA4335',
  yellow: '#FBBC05',
  green: '#34A853',
};

// Reading colours for the transcript, shared with tui.mjs.
const INK = {
  text: '#e3e3e3',
  secondary: '#a8adb3',
  dim: '#80868b',
  faint: '#5f6368',
  code: '#8ab4f8',
  link: '#8ab4f8',
  bullet: '#8ab4f8',
};

// ─── Syntax highlighting ────────────────────────────────────────────────────
//
// highlight.js ships with the CLI (it comes in through marked-terminal), and
// knows every language a model is likely to fence. It is loaded lazily and
// optionally: if it is ever missing, the small regex highlighter below takes
// over instead of the reply failing to render.

const SYNTAX = {
  keyword: '#c586c0',
  built_in: '#4ec9b0',
  type: '#4ec9b0',
  literal: '#569cd6',
  number: '#b5cea8',
  string: '#ce9178',
  regexp: '#d16969',
  comment: '#6a9955',
  title: '#dcdcaa',
  function: '#dcdcaa',
  params: '#9cdcfe',
  attr: '#9cdcfe',
  attribute: '#9cdcfe',
  property: '#9cdcfe',
  variable: '#9cdcfe',
  tag: '#569cd6',
  name: '#569cd6',
  'selector-tag': '#d7ba7d',
  'selector-class': '#d7ba7d',
  'selector-id': '#d7ba7d',
  meta: '#9b9b9b',
  symbol: '#b5cea8',
  addition: '#89d185',
  deletion: '#f48771',
  section: '#569cd6',
  bullet: '#569cd6',
};
const CODE_TEXT = '#d4d4d4';

let hljs;
function loadHljs() {
  if (hljs !== undefined) return hljs;
  try { hljs = require('highlight.js'); } catch { hljs = null; }
  return hljs;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m]);

/** highlight.js HTML → rows of {text, color} segments. */
function hljsRows(code, lang) {
  const h = loadHljs();
  if (!h || !lang || !h.getLanguage(lang)) return null;
  let html;
  try { html = h.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { return null; }
  const rows = [[]];
  const stack = [];
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      const cls = m[1].split(/\s+/).map((c) => c.replace(/^hljs-/, '')).find((c) => SYNTAX[c]);
      stack.push(cls ? SYNTAX[cls] : stack[stack.length - 1] || null);
    } else if (m[0] === '</span>') {
      stack.pop();
    } else {
      const color = stack[stack.length - 1] || CODE_TEXT;
      const parts = decode(m[2]).split('\n');
      parts.forEach((p, i) => {
        if (i > 0) rows.push([]);
        if (p) rows[rows.length - 1].push({ text: p, color });
      });
    }
  }
  return rows;
}

/** Fallback highlighter for when highlight.js is unavailable or the language unknown. */
function highlightCode(code, lang) {
  const fromHljs = hljsRows(code, lang);
  if (fromHljs) return fromHljs;
  if (!lang) return code.split('\n').map((line) => [{ text: line, color: CODE_TEXT }]);
  return code.split('\n').map((line) => {
    if (/^\s*(\/\/|#|\/\*|\*|<!--)/.test(line)) return [{ text: line, color: SYNTAX.comment }];
    const regex = /("[^"]*"|'[^']*'|`[^`]*`)|(\b(?:function|const|let|var|if|else|return|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|from|default|async|await|try|catch|throw|typeof|instanceof|in|of|void|delete|def|fn|pub|use|struct|impl)\b)|(\b(?:null|undefined|true|false|None|True|False)\b)|(\b\d+\.?\d*\b)/g;
    const out = [];
    let last = 0;
    let match;
    while ((match = regex.exec(line)) !== null) {
      if (match.index > last) out.push({ text: line.slice(last, match.index), color: CODE_TEXT });
      const color = match[1] ? SYNTAX.string : match[2] ? SYNTAX.keyword : match[3] ? SYNTAX.literal : SYNTAX.number;
      out.push({ text: match[0], color });
      last = match.index + match[0].length;
    }
    if (last < line.length) out.push({ text: line.slice(last), color: CODE_TEXT });
    return out.length ? out : [{ text: line, color: CODE_TEXT }];
  });
}

// ─── ANSI helpers ───────────────────────────────────────────────────────────

function hexToAnsi(hex) {
  if (!hex) return '';
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Background counterpart of hexToAnsi. */
function hexToAnsiBg(hex) {
  if (!hex) return '';
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_ITALIC = '\x1b[3m';
const ANSI_UNDERLINE = '\x1b[4m';
const ANSI_STRIKE = '\x1b[9m';
const ANSI_BOLD_OFF = '\x1b[22m';
const ANSI_ITALIC_OFF = '\x1b[23m';

// Surface colours for filled blocks. Ink 5's <Box> has no backgroundColor, so
// every filled row is built by hand: set the bg, emit the content, pad out to
// the panel width so the fill reaches the right edge, then reset.
const SURFACE = {
  plan: '#161b22',
  planHeader: '#1d2530',
  diffAdd: '#173a24',
  diffDel: '#45191e',
  diffAddWord: '#22603a',
  diffDelWord: '#7a2a33',
};

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const visibleLength = (s) => s.replace(ANSI_PATTERN, '').length;

/**
 * Render coloured segments clipped to `width`, returning the ANSI string and
 * how many visible columns it used. Clipping happens per segment so a cut never
 * lands inside an escape sequence.
 */
function clipSegments(segments, width) {
  let out = '';
  let used = 0;
  for (const seg of segments) {
    if (used >= width) break;
    const room = width - used;
    const text = seg.text.length > room ? seg.text.slice(0, room) : seg.text;
    if (!text) continue;
    out += (seg.color ? hexToAnsi(seg.color) : '') + text;
    used += text.length;
  }
  return { text: out, used };
}

/** One full-width row of a filled panel. */
function fillRow(content, usedWidth, width, bg) {
  const pad = Math.max(0, width - usedWidth);
  return hexToAnsiBg(bg) + content + ' '.repeat(pad) + ANSI_RESET;
}

// ─── Inline markdown ────────────────────────────────────────────────────────

/**
 * Split a line into styled segments.
 *
 * Scans for whichever marker comes FIRST, so `code` before a **bold** run is
 * still code (the old pattern-by-pattern pass swallowed it as plain text).
 * Underscore emphasis needs a word boundary on both sides so snake_case
 * identifiers in prose stay intact.
 */
function parseInline(text) {
  const segments = [];
  const re = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])|(?<![\w])_(?![\s_])(.+?)(?<![\s_])_(?![\w])/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    if (m[2] != null) segments.push({ text: m[2], code: true });
    else if (m[3] != null) segments.push(...parseInline(m[3]).map((s) => ({ ...s, bold: true })));
    else if (m[4] != null) segments.push(...parseInline(m[4]).map((s) => ({ ...s, bold: true })));
    else if (m[5] != null) segments.push({ text: m[5], strike: true });
    else if (m[6] != null) {
      segments.push({ text: m[6], link: true });
      if (m[7] !== m[6]) segments.push({ text: ` (${m[7]})`, color: INK.faint });
    } else if (m[8] != null) segments.push(...parseInline(m[8]).map((s) => ({ ...s, italic: true })));
    else if (m[9] != null) segments.push(...parseInline(m[9]).map((s) => ({ ...s, italic: true })));
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

/** Segments → one ANSI string, every run closed with a full reset. */
function inlineAnsi(segments, baseColor = INK.text) {
  let out = '';
  for (const seg of segments) {
    let pre = hexToAnsi(seg.code ? INK.code : seg.link ? INK.link : seg.color || baseColor);
    if (seg.bold) pre += ANSI_BOLD;
    if (seg.italic) pre += ANSI_ITALIC;
    if (seg.strike) pre += ANSI_STRIKE;
    if (seg.link) pre += ANSI_UNDERLINE;
    out += pre + seg.text + ANSI_RESET;
  }
  return out;
}

function InlineText({ segments, color }) {
  return React.createElement(Text, { wrap: 'wrap' }, inlineAnsi(segments, color));
}

// ─── Blocks ─────────────────────────────────────────────────────────────────

const MAX_VISIBLE_LINES = 80;
const DEFAULT_PANEL_WIDTH = 76;

/**
 * A fenced block with no language that is plainly prose, not code.
 *
 * Models routinely wrap their closing summary in a bare ``` fence. Rendering
 * that as code is actively misleading, so it gets rendered as markdown
 * instead. Kept deliberately conservative: any whiff of real code and it stays
 * a code block.
 */
function looksLikeProse(lang, code) {
  if (lang) return false;
  const lines = code.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return false;

  const codeish = lines.filter((l) =>
    /[;{}]\s*$/.test(l) ||
    /^\s*(?:const|let|var|function|import|export|class|def|return|if|for|while|#include)\b/.test(l) ||
    /^\s*<\/?[a-zA-Z]/.test(l) ||
    /^\s*[\w-]+\s*:\s*[^\s].*;/.test(l)
  ).length;
  if (codeish > 0) return false;

  const proseish = lines.filter((l) =>
    /\*\*[^*]+\*\*/.test(l) ||
    /^\s*#{1,6}\s+\S/.test(l) ||
    /^\s*[-*]\s+\S/.test(l) ||
    /^\s*\d+\.\s+\S/.test(l)
  ).length;

  return proseish / lines.length >= 0.4;
}

function CodeBlock({ lang, code, truncated, width }) {
  const allLines = code.replace(/\s+$/, '').split('\n');
  const totalLines = allLines.length;
  const shouldTruncate = truncated !== false && totalLines > MAX_VISIBLE_LINES;
  const visibleLines = shouldTruncate ? allLines.slice(0, MAX_VISIBLE_LINES) : allLines;
  const isDiff = lang === 'diff' || lang === 'patch';
  const rows = isDiff ? null : highlightCode(visibleLines.join('\n'), lang);

  const lines = visibleLines.map((raw, i) => {
    if (isDiff) {
      const color = /^\+(?!\+\+)/.test(raw) ? SYNTAX.addition
        : /^-(?!--)/.test(raw) ? SYNTAX.deletion
        : /^@@/.test(raw) ? SYNTAX.literal : CODE_TEXT;
      return '  ' + hexToAnsi(color) + raw + ANSI_RESET;
    }
    const segs = rows[i] || [];
    return '  ' + segs.map((s) => hexToAnsi(s.color) + s.text).join('') + ANSI_RESET;
  });

  return React.createElement(
    Box,
    { flexDirection: 'column', width },
    ...lines.map((l, i) => React.createElement(Text, { key: i, wrap: 'wrap' }, l || ' ')),
    shouldTruncate && React.createElement(
      Text,
      { key: 'more' },
      hexToAnsi(INK.faint) + `  … ${totalLines - MAX_VISIBLE_LINES} more lines` + ANSI_RESET
    )
  );
}

/**
 * Style one segment without ever emitting a full reset.
 * ANSI_RESET would clear the panel's background mid-row and punch a hole in the
 * fill, so attributes are turned off individually instead.
 */
function styleSegment(seg, defaultColor) {
  let out = '';
  if (seg.bold) out += ANSI_BOLD;
  if (seg.italic) out += ANSI_ITALIC;
  out += hexToAnsi(seg.code ? INK.code : seg.color || defaultColor);
  out += seg.text;
  if (seg.italic) out += ANSI_ITALIC_OFF;
  if (seg.bold) out += ANSI_BOLD_OFF;
  return out;
}

/**
 * Word-wrap styled segments to `width`, returning rows of segments.
 * Wrapping happens on words rather than characters, and a word longer than the
 * whole width is hard-split so it can never overflow the panel.
 */
function wrapStyledSegments(segments, width, nextWidth = width) {
  const rows = [];
  let row = [];
  let used = 0;
  // Continuation rows carry a hanging indent, so they have less room than the
  // first. Wrapping every row at the first row's width overflows the panel by
  // exactly the indent.
  let limit = width;
  const flush = () => { rows.push(row); row = []; used = 0; limit = nextWidth; };

  for (const seg of segments) {
    for (const word of seg.text.split(/(\s+)/)) {
      if (!word) continue;
      const isSpace = /^\s+$/.test(word);
      if (isSpace && used === 0) continue;
      if (used + word.length <= limit) {
        row.push({ ...seg, text: word });
        used += word.length;
        continue;
      }
      if (isSpace) { flush(); continue; }
      if (used > 0) flush();
      let rest = word;
      while (rest.length > limit) {
        row.push({ ...seg, text: rest.slice(0, limit) });
        used = limit;
        flush();
        rest = rest.slice(limit);
      }
      if (rest) { row.push({ ...seg, text: rest }); used += rest.length; }
    }
  }
  if (row.length || rows.length === 0) flush();
  return rows;
}

/** Turn one raw markdown line into an indent + styled segments. */
function formatPanelLine(raw) {
  const indentMatch = raw.match(/^(\s*)/);
  const indent = Math.min(indentMatch ? indentMatch[1].length : 0, 12);
  const line = raw.slice(indent);

  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    return {
      indent,
      hanging: 0,
      segments: parseInline(heading[2]).map((s) => ({ ...s, bold: true, color: heading[1].length <= 2 ? INK.text : INK.secondary })),
    };
  }

  if (/^[-*_]{3,}\s*$/.test(line)) {
    return { indent, hanging: 0, rule: true, segments: [] };
  }

  const bullet = line.match(/^([-*])\s+(.*)$/);
  if (bullet) {
    return { indent, hanging: 2, segments: [{ text: '• ', color: INK.bullet }, ...parseInline(bullet[2])] };
  }

  const numbered = line.match(/^(\d+)\.\s+(.*)$/);
  if (numbered) {
    const marker = `${numbered[1]}. `;
    return { indent, hanging: marker.length, segments: [{ text: marker, color: INK.bullet }, ...parseInline(numbered[2])] };
  }

  return { indent, hanging: 0, segments: parseInline(line) };
}

/**
 * Filled panel for a plan. Content is wrapped, never clipped: a plan is meant
 * to be read, so losing the end of every long sentence defeats the point.
 */
function Panel({ title, lines, width, accent = G.yellow, bg = SURFACE.plan, headerBg = SURFACE.planHeader }) {
  const panelWidth = Math.max(24, Math.min(width || DEFAULT_PANEL_WIDTH, 120));
  const textColor = '#d5d9df';

  const head = ' ' + title;
  const header = fillRow(hexToAnsi(accent) + ANSI_BOLD + head + ANSI_BOLD_OFF, head.length, panelWidth, headerBg);

  const rendered = [];
  for (const raw of lines) {
    const { indent, hanging, segments, rule } = formatPanelLine(raw);

    if (rule) {
      rendered.push(hexToAnsiBg(bg) + '  ' + hexToAnsi('#3a4048') + '─'.repeat(Math.max(4, panelWidth - 4)));
      continue;
    }
    if (segments.length === 0) {
      rendered.push(hexToAnsiBg(bg) + ' ');
      continue;
    }

    const avail = Math.max(8, panelWidth - 2 - indent);
    const rows = wrapStyledSegments(segments, avail, Math.max(4, avail - hanging));
    rows.forEach((row, i) => {
      const pad = ' '.repeat(indent + (i > 0 ? hanging : 0));
      rendered.push(hexToAnsiBg(bg) + ' ' + pad + row.map((s) => styleSegment(s, textColor)).join(''));
    });
  }

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { key: 'h' }, header),
    ...rendered.map((content, i) => React.createElement(
      Text,
      { key: i },
      hexToAnsiBg(bg) + content + ' '.repeat(Math.max(0, panelWidth - visibleLength(content))) + ANSI_RESET
    ))
  );
}

function Heading({ level, children }) {
  const color = level <= 2 ? INK.text : INK.secondary;
  const segs = parseInline(children).map((s) => ({ ...s, bold: true, color: s.code ? undefined : color }));
  return React.createElement(Text, { wrap: 'wrap' }, (level === 1 ? ANSI_UNDERLINE : '') + inlineAnsi(segs, color));
}

/** A list item with a hanging indent, so wrapped lines sit under the text. */
function ListItem({ children, ordered, index, depth = 0 }) {
  const marker = ordered ? `${index}. ` : depth > 0 ? '· ' : '• ';
  return React.createElement(
    Box,
    { flexDirection: 'row', paddingLeft: depth * 2 },
    React.createElement(Text, null, hexToAnsi(INK.bullet) + marker + ANSI_RESET),
    React.createElement(Box, { flexGrow: 1, flexShrink: 1 }, React.createElement(InlineText, { segments: parseInline(children) }))
  );
}

function HorizontalRule({ width }) {
  return React.createElement(Text, null, hexToAnsi('#3c4043') + '─'.repeat(Math.max(8, Math.min(width || 50, 72))) + ANSI_RESET);
}

function Blockquote({ children }) {
  return React.createElement(
    Box,
    { flexDirection: 'row' },
    React.createElement(Text, null, hexToAnsi(INK.faint) + '│ ' + ANSI_RESET),
    React.createElement(Box, { flexGrow: 1, flexShrink: 1 }, React.createElement(InlineText, {
      segments: parseInline(children).map((s) => ({ ...s, italic: true })),
      color: INK.secondary,
    }))
  );
}

// ─── Tables ─────────────────────────────────────────────────────────────────

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line || '');
const plainLength = (cell) => parseInline(cell).reduce((n, s) => n + s.text.length, 0);

/** Fit a cell to `w` columns, keeping its inline styling. */
function fitCell(cell, w) {
  const segs = parseInline(cell);
  const out = [];
  let used = 0;
  for (const s of segs) {
    if (used >= w) break;
    let t = s.text;
    if (used + t.length > w) t = t.slice(0, Math.max(0, w - used - 1)) + '…';
    out.push({ ...s, text: t });
    used += t.length;
  }
  return inlineAnsi(out) + ' '.repeat(Math.max(0, w - used));
}

function Table({ header, rows, width }) {
  const cols = header.length;
  const all = [header, ...rows].map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  let widths = Array.from({ length: cols }, (_, i) => Math.max(3, ...all.map((r) => plainLength(r[i]))));
  // Shrink the widest columns until the table fits: 3 columns of chrome per cell.
  const budget = Math.max(cols * 4, (width || 80) - (cols * 3 + 1));
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const max = Math.max(...widths);
    if (max <= 4) break;
    widths = widths.map((w) => (w === max ? w - 1 : w));
  }
  const line = (l, m, r) => hexToAnsi(INK.faint) + l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r + ANSI_RESET;
  const bar = hexToAnsi(INK.faint) + '│' + ANSI_RESET;
  const row = (cells, bold) => bar + cells.map((c, i) => ' ' + (bold ? ANSI_BOLD : '') + fitCell(c, widths[i]) + ' ').join(bar) + bar;
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { key: 't' }, line('┌', '┬', '┐')),
    React.createElement(Text, { key: 'h' }, row(all[0], true)),
    React.createElement(Text, { key: 's' }, line('├', '┼', '┤')),
    ...all.slice(1).map((r, i) => React.createElement(Text, { key: `r${i}` }, row(r, false))),
    React.createElement(Text, { key: 'b' }, line('└', '┴', '┘'))
  );
}

// ─── Document ───────────────────────────────────────────────────────────────

const Spacer = ({ k }) => React.createElement(Text, { key: k }, ' ');

function renderMarkdown(md, width) {
  const elements = [];
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let gap = false; // a blank source line was seen since the last block

  const add = (el) => {
    if (gap && elements.length) elements.push(Spacer({ k: `sp-${elements.length}` }));
    gap = false;
    elements.push(el);
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const fence = trimmed.slice(0, 3);
      const lang = trimmed.slice(3).trim().split(/\s+/)[0].toLowerCase();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const body = codeLines.join('\n');
      if (looksLikeProse(lang, body)) {
        for (const el of renderMarkdown(body, width)) add(React.cloneElement(el, { key: `fenced-${elements.length}-${el.key}` }));
      } else {
        add(React.createElement(CodeBlock, { key: `code-${elements.length}`, lang, code: body, width }));
      }
      continue;
    }

    if (trimmed === '') { gap = true; i++; continue; }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)/);
    if (headingMatch) {
      if (elements.length) gap = true;
      add(React.createElement(Heading, { key: `h-${elements.length}`, level: headingMatch[1].length }, headingMatch[2].replace(/\s+#+\s*$/, '')));
      i++;
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed.replace(/\s/g, ''))) {
      add(React.createElement(HorizontalRule, { key: `hr-${elements.length}`, width }));
      i++;
      continue;
    }

    if (trimmed.startsWith('|') && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      add(React.createElement(Table, { key: `tb-${elements.length}`, header, rows, width }));
      continue;
    }

    if (trimmed.startsWith('>')) {
      add(React.createElement(Blockquote, { key: `bq-${elements.length}`, children: trimmed.replace(/^>\s?/, '') }));
      i++;
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+])\s+(.+)/);
    if (listMatch) {
      const task = listMatch[3].match(/^\[([ xX])\]\s+(.*)/);
      const text = task ? (task[1] === ' ' ? '☐ ' : '☒ ') + task[2] : listMatch[3];
      add(React.createElement(ListItem, { key: `li-${elements.length}`, children: text, depth: Math.min(3, Math.floor(listMatch[1].length / 2)) }));
      i++;
      continue;
    }

    const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)/);
    if (olMatch) {
      add(React.createElement(ListItem, {
        key: `oli-${elements.length}`, children: olMatch[3], ordered: true, index: parseInt(olMatch[2], 10),
        depth: Math.min(3, Math.floor(olMatch[1].length / 2)),
      }));
      i++;
      continue;
    }

    // Paragraph: consecutive plain lines, joined like markdown does.
    const paraLines = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || t.startsWith('```') || t.startsWith('~~~') || /^#{1,6}\s/.test(t) || t.startsWith('>') ||
        /^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t) || /^[-*_]{3,}$/.test(t.replace(/\s/g, '')) ||
        (t.startsWith('|') && isTableSep(lines[i + 1]))) break;
      paraLines.push(t);
      i++;
    }
    if (paraLines.length) {
      add(React.createElement(InlineText, { key: `p-${elements.length}`, segments: parseInline(paraLines.join(' ')) }));
    } else {
      i++;
    }
  }

  return elements;
}

export {
  renderMarkdown, CodeBlock, Panel, parseInline, inlineAnsi, looksLikeProse, highlightCode,
  hexToAnsi, hexToAnsiBg, fillRow, clipSegments, visibleLength, SURFACE, INK,
  ANSI_RESET, ANSI_BOLD, ANSI_DIM, ANSI_ITALIC, ANSI_STRIKE,
};
export default renderMarkdown;
