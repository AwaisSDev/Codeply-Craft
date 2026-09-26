/**
 * Codeply TUI - Markdown renderer for AI responses.
 * Parses markdown into Ink-compatible React elements with syntax coloring.
 */
import React from 'react';
import { Box, Text } from 'ink';

const G = {
  blue: '#4285F4',
  red: '#EA4335',
  yellow: '#FBBC05',
  green: '#34A853',
};

// Minimal syntax highlighter for code blocks
function highlightCode(code, lang) {
  const lines = code.split('\n');
  return lines.map((line) => {
    let colored = line;

    // Comments
    if (/^\s*\/\//.test(line) || /^\s*#/.test(line) || /^\s*\/\*/.test(line) || /^\s*\*/.test(line) || /^\s*<!--/.test(line)) {
      return [{ text: line, color: '#5f6368' }];
    }

    // Strings (basic)
    const parts = [];
    let remaining = line;
    // Match strings, keywords, tags, numbers, properties
    const regex = /("[^"]*"|'[^']*'|`[^`]*`)|(\b(?:function|const|let|var|if|else|return|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|from|default|async|await|try|catch|throw|typeof|instanceof|in|of|void|delete|null|undefined|true|false)\b)|(<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>?)|(\b\d+\.?\d*\b)|(#[0-9a-fA-F]{3,8})|(\b(?:style|color|display|margin|padding|border|background|width|height|font|position|top|left|right|bottom|text|align|overflow|flex|grid|gap|opacity|transform|transition|animation|content|justify|items|center|none|block|inline|relative|absolute|fixed|solid|dashed|hidden|auto|inherit|initial|unset)\b)/g;

    let lastIdx = 0;
    let match;
    const result = [];

    while ((match = regex.exec(remaining)) !== null) {
      // Text before match
      if (match.index > lastIdx) {
        result.push({ text: remaining.slice(lastIdx, match.index), color: '#e8eaed' });
      }

      if (match[1]) {
        // String
        result.push({ text: match[0], color: '#34A853' });
      } else if (match[2]) {
        // Keyword
        result.push({ text: match[0], color: '#4285F4' });
      } else if (match[3]) {
        // HTML tag
        result.push({ text: match[0], color: '#EA4335' });
      } else if (match[4]) {
        // Number
        result.push({ text: match[0], color: '#FBBC05' });
      } else if (match[5]) {
        // Hex color
        result.push({ text: match[0], color: '#FBBC05' });
      } else if (match[6]) {
        // CSS property
        result.push({ text: match[0], color: '#e8eaed' });
      } else {
        result.push({ text: match[0], color: '#e8eaed' });
      }
      lastIdx = match.index + match[0].length;
    }

    if (lastIdx < remaining.length) {
      result.push({ text: remaining.slice(lastIdx), color: '#e8eaed' });
    }

    return result.length ? result : [{ text: line, color: '#e8eaed' }];
  });
}

// Convert hex color to ANSI escape sequence
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
const ANSI_BG_CODE = '\x1b[48;2;45;46;48m'; // #2d2e30

// Surface colours for filled blocks. Ink 5's <Box> has no backgroundColor, so
// every filled row is built by hand: set the bg, emit the content, pad out to
// the panel width so the fill reaches the right edge, then reset. Padding has
// to be measured on the *visible* text, which is why widths are tracked
// explicitly rather than using String#padEnd on an ANSI-laden string.
const SURFACE = {
  codeHeader: '#20242b',
  codeBody: '#15181c',
  gutter: '#1b1f24',
  plan: '#161b22',
  planHeader: '#1d2530',
  diffAdd: '#0e2417',
  diffDel: '#2a1418',
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

function InlineText({ segments }) {
  // Build a single string with ANSI escape codes for styling.
  // This avoids creating multiple <Text> elements which Ink wraps independently.
  let flat = '';
  for (const seg of segments) {
    let prefix = '';
    let suffix = '';
    if (seg.bold) prefix += ANSI_BOLD;
    if (seg.italic) prefix += ANSI_ITALIC;
    if (seg.code) {
      prefix += hexToAnsi(G.yellow) + ANSI_BG_CODE;
      suffix = ANSI_RESET;
      flat += prefix + ` ${seg.text} ` + suffix;
    } else if (seg.color) {
      prefix += hexToAnsi(seg.color);
      suffix = ANSI_RESET;
      flat += prefix + seg.text + suffix;
    } else {
      flat += seg.text;
    }
  }
  return React.createElement(Text, { wrap: 'wrap' }, flat);
}

function parseInline(text) {
  const segments = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold: **text** or __text__
    let match = remaining.match(/^(.*?)\*\*(.+?)\*\*/s);
    if (!match) match = remaining.match(/^(.*?)__(.+?)__/s);
    if (match && match[1].length < remaining.length) {
      if (match[1]) segments.push({ text: match[1] });
      segments.push({ text: match[2], bold: true });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic: *text* or _text_
    match = remaining.match(/^(.*?)\*(.+?)\*/s);
    if (!match) match = remaining.match(/^(.*?)_(.+?)_/s);
    if (match && match[1].length < remaining.length) {
      if (match[1]) segments.push({ text: match[1] });
      segments.push({ text: match[2], italic: true });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline code: `text`
    match = remaining.match(/^(.*?)`(.+?)`/s);
    if (match && match[1].length < remaining.length) {
      if (match[1]) segments.push({ text: match[1] });
      segments.push({ text: match[2], code: true });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // No more formatting
    segments.push({ text: remaining });
    break;
  }

  return segments;
}

const MAX_VISIBLE_LINES = 30;
const DEFAULT_PANEL_WIDTH = 76;

/**
 * A fenced block with no language that is plainly prose, not code.
 *
 * Models routinely wrap their closing summary in a bare ``` fence. Rendering
 * that as a code panel - line numbers, syntax colours, "15 lines" - is actively
 * misleading, so it gets rendered as markdown instead. Kept deliberately
 * conservative: any whiff of real code and it stays a code block.
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
    /\*\*[^*]+\*\*/.test(l) ||        // bold
    /^\s*#{1,6}\s+\S/.test(l) ||      // heading
    /^\s*[-*]\s+\S/.test(l) ||        // bullet
    /^\s*\d+\.\s+\S/.test(l)          // numbered
  ).length;

  return proseish / lines.length >= 0.4;
}

function CodeBlock({ lang, code, truncated, width }) {
  const allLines = code.split('\n');
  const totalLines = allLines.length;
  const shouldTruncate = truncated !== false && totalLines > MAX_VISIBLE_LINES;
  const visibleLines = shouldTruncate ? allLines.slice(0, MAX_VISIBLE_LINES) : allLines;
  const highlighted = highlightCode(visibleLines.join('\n'), lang);
  const langLabel = lang || 'code';

  const panelWidth = Math.max(24, Math.min(width || DEFAULT_PANEL_WIDTH, 120));
  const gutterWidth = String(visibleLines.length).length + 1;
  const bodyWidth = panelWidth - gutterWidth - 2;

  const countLabel = shouldTruncate
    ? `${totalLines} lines · first ${MAX_VISIBLE_LINES}`
    : `${totalLines} line${totalLines === 1 ? '' : 's'}`;

  // Header: language on the left, line count pushed to the right edge.
  const headLeft = ' ' + langLabel;
  const headGap = Math.max(1, panelWidth - headLeft.length - countLabel.length - 1);
  const header = fillRow(
    hexToAnsi(G.blue) + ANSI_BOLD + headLeft + ANSI_RESET + hexToAnsiBg(SURFACE.codeHeader) +
      ' '.repeat(headGap) + hexToAnsi('#6b7280') + countLabel + ' ',
    headLeft.length + headGap + countLabel.length + 1,
    panelWidth,
    SURFACE.codeHeader
  );

  const rows = highlighted.map((segments, i) => {
    const raw = visibleLines[i] ?? '';
    // Diff hunks get a tinted row so +/- reads at a glance.
    const isAdd = /^\+(?!\+)/.test(raw);
    const isDel = /^-(?!-)/.test(raw);
    const bg = isAdd ? SURFACE.diffAdd : isDel ? SURFACE.diffDel : SURFACE.codeBody;

    const num = String(i + 1).padStart(gutterWidth - 1);
    const gutter = hexToAnsiBg(SURFACE.gutter) + hexToAnsi('#4b5563') + ' ' + num + ANSI_RESET;
    const { text, used } = clipSegments(segments, bodyWidth);
    const body = hexToAnsiBg(bg) + ' ' + text;

    return React.createElement(
      Text,
      { key: i },
      gutter + fillRow(body, used + 1, panelWidth - gutterWidth, bg)
    );
  });

  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    React.createElement(Text, null, header),
    // One <Text> per line, pre-flattened to ANSI. Ink allocates a Yoga layout
    // node per element, so per-token <Text> nodes make long blocks crawl.
    ...rows,
    shouldTruncate && React.createElement(
      Text,
      null,
      fillRow(
        hexToAnsiBg(SURFACE.codeHeader) + hexToAnsi('#6b7280') +
          `   ⋯ ${totalLines - MAX_VISIBLE_LINES} more lines`,
        `   ⋯ ${totalLines - MAX_VISIBLE_LINES} more lines`.length,
        panelWidth,
        SURFACE.codeHeader
      )
    )
  );
}

const ANSI_BOLD_OFF = '\x1b[22m';
const ANSI_ITALIC_OFF = '\x1b[23m';

/**
 * Style one segment without ever emitting a full reset.
 * ANSI_RESET would clear the panel's background mid-row and punch a hole in the
 * fill, so attributes are turned off individually instead.
 */
function styleSegment(seg, defaultColor) {
  let out = '';
  if (seg.bold) out += ANSI_BOLD;
  if (seg.italic) out += ANSI_ITALIC;
  out += hexToAnsi(seg.color || defaultColor);
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
      if (isSpace && used === 0) continue;           // no leading space on a wrapped row
      if (used + word.length <= limit) {
        row.push({ ...seg, text: word });
        used += word.length;
        continue;
      }
      if (isSpace) { flush(); continue; }            // break at the space itself
      if (used > 0) flush();
      let rest = word;
      while (rest.length > limit) {                  // pathologically long token
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
    const level = heading[1].length;
    const color = level <= 2 ? G.blue : level === 3 ? G.green : G.yellow;
    return {
      indent,
      hanging: 0,
      segments: parseInline(heading[2]).map((s) => ({ ...s, bold: true, color })),
    };
  }

  if (/^[-*_]{3,}\s*$/.test(line)) {
    return { indent, hanging: 0, rule: true, segments: [] };
  }

  const bullet = line.match(/^([-*])\s+(.*)$/);
  if (bullet) {
    return {
      indent,
      hanging: 2,
      segments: [{ text: '• ', color: G.blue }, ...parseInline(bullet[2])],
    };
  }

  const numbered = line.match(/^(\d+)\.\s+(.*)$/);
  if (numbered) {
    const marker = `${numbered[1]}. `;
    return {
      indent,
      hanging: marker.length,
      segments: [{ text: marker, color: G.blue }, ...parseInline(numbered[2])],
    };
  }

  return { indent, hanging: 0, segments: parseInline(line) };
}

/**
 * Filled panel for a plan / reasoning block - same visual family as CodeBlock
 * so the transcript reads as one system, but without the line-number gutter
 * since prose is not addressed by line.
 *
 * Content is wrapped, never clipped: a plan is meant to be read, so losing the
 * end of every long sentence defeats the point.
 */
function Panel({ title, lines, width, accent = G.yellow, bg = SURFACE.plan, headerBg = SURFACE.planHeader }) {
  const panelWidth = Math.max(24, Math.min(width || DEFAULT_PANEL_WIDTH, 120));
  const textColor = '#d5d9df';

  const head = ' ' + title;
  const header = fillRow(
    hexToAnsi(accent) + ANSI_BOLD + head + ANSI_BOLD_OFF,
    head.length,
    panelWidth,
    headerBg
  );

  const rendered = [];
  for (const raw of lines) {
    const { indent, hanging, segments, rule } = formatPanelLine(raw);

    if (rule) {
      const dash = '─'.repeat(Math.max(4, panelWidth - 4));
      rendered.push(hexToAnsiBg(bg) + '  ' + hexToAnsi('#3a4048') + dash);
      continue;
    }
    if (segments.length === 0) {
      rendered.push(hexToAnsiBg(bg) + ' ');
      continue;
    }

    const avail = Math.max(8, panelWidth - 2 - indent);
    const rows = wrapStyledSegments(segments, avail, Math.max(4, avail - hanging));
    rows.forEach((row, i) => {
      // Continuation rows line up under the text, not under the bullet.
      const pad = ' '.repeat(indent + (i > 0 ? hanging : 0));
      const body = row.map((s) => styleSegment(s, textColor)).join('');
      rendered.push(hexToAnsiBg(bg) + ' ' + pad + body);
    });
  }

  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    React.createElement(Text, { key: 'h' }, header),
    ...rendered.map((content, i) => {
      const used = visibleLength(content);
      return React.createElement(
        Text,
        { key: i },
        hexToAnsiBg(bg) + content + ' '.repeat(Math.max(0, panelWidth - used)) + ANSI_RESET
      );
    })
  );
}

function Heading({ level, children }) {
  const color = level === 1 ? G.blue : level === 2 ? G.green : G.yellow;
  return React.createElement(
    Box,
    { marginBottom: 1, marginTop: level <= 2 ? 1 : 0 },
    React.createElement(Text, { color, bold: level <= 2, wrap: 'wrap' }, children)
  );
}

function ListItem({ children, ordered, index }) {
  const bullet = ordered ? `${index}. ` : '  • ';
  const bulletColored = hexToAnsi(G.blue) + bullet + ANSI_RESET;
  const segments = parseInline(children);
  let content = '';
  for (const seg of segments) {
    let prefix = '';
    if (seg.bold) prefix += ANSI_BOLD;
    if (seg.italic) prefix += ANSI_ITALIC;
    if (seg.color) prefix += hexToAnsi(seg.color);
    content += prefix + seg.text + (prefix ? ANSI_RESET : '');
  }
  return React.createElement(Text, { wrap: 'wrap' }, '  ' + bulletColored + content);
}

function HorizontalRule({ width }) {
  return React.createElement(
    Box,
    { marginY: 1 },
    React.createElement(Text, { color: '#3c4043' }, '─'.repeat(Math.max(8, Math.min(width || 50, 72))))
  );
}

function Blockquote({ children }) {
  return React.createElement(
    Box,
    {
      borderStyle: 'bold',
      borderTop: false,
      borderRight: false,
      borderBottom: false,
      borderLeftColor: G.blue,
      paddingLeft: 1,
      marginBottom: 1,
    },
    React.createElement(Text, { color: '#9aa0a6', italic: true, wrap: 'wrap' }, children)
  );
}

function renderMarkdown(md, width) {
  const elements = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block: ```lang ... ```
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const body = codeLines.join('\n');
      if (looksLikeProse(lang, body)) {
        // A bare fence around a written summary - render it as what it is.
        for (const el of renderMarkdown(body, width)) {
          elements.push(React.cloneElement(el, { key: `fenced-${elements.length}-${el.key}` }));
        }
      } else {
        elements.push(React.createElement(CodeBlock, {
          key: `code-${elements.length}`, lang, code: body, width,
        }));
      }
      continue;
    }

    // Heading: # ## ###
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      elements.push(React.createElement(Heading, { key: `h-${elements.length}`, level: headingMatch[1].length }, headingMatch[2]));
      i++;
      continue;
    }

    // Horizontal rule: --- or *** or ___
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      elements.push(React.createElement(HorizontalRule, { key: `hr-${elements.length}`, width }));
      i++;
      continue;
    }

    // Blockquote: > text
    if (line.trim().startsWith('>')) {
      elements.push(React.createElement(Blockquote, { key: `bq-${elements.length}`, children: line.trim().slice(1).trim() }));
      i++;
      continue;
    }

    // Unordered list: - or * text
    const listMatch = line.match(/^(\s*)([-*])\s+(.+)/);
    if (listMatch) {
      elements.push(React.createElement(ListItem, { key: `li-${elements.length}`, children: listMatch[3] }));
      i++;
      continue;
    }

    // Ordered list: 1. text
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (olMatch) {
      elements.push(React.createElement(ListItem, { key: `oli-${elements.length}`, children: olMatch[3], ordered: true, index: parseInt(olMatch[2]) }));
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-empty lines
    const paraLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('```') && !lines[i].trim().startsWith('#') && !lines[i].trim().startsWith('>') && !/^[-*]\s/.test(lines[i].trim()) && !/^\d+\.\s/.test(lines[i].trim()) && !/^[-*_]{3,}\s*$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      elements.push(
        React.createElement(InlineText, { key: `p-${elements.length}`, segments: parseInline(paraLines.join(' ')) })
      );
    }
  }

  return elements;
}

export {
  renderMarkdown, CodeBlock, Panel, parseInline, looksLikeProse,
  hexToAnsi, hexToAnsiBg, fillRow, clipSegments, visibleLength, SURFACE,
  ANSI_RESET, ANSI_BOLD, ANSI_DIM, ANSI_ITALIC,
};
export default renderMarkdown;
