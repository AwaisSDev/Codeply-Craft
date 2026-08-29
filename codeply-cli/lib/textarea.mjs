/**
 * Multiline composer input.
 *
 * ink-text-input is single-line and submits on any \r, which also means pasting
 * a code snippet fires a submit at the first newline. This replaces it.
 *
 * Getting a real shift+enter out of a terminal is the awkward part: by default
 * both enter and shift+enter send the same byte (\r), so they are physically
 * indistinguishable. We enable the kitty keyboard protocol's disambiguation
 * flag on mount (\x1b[>1u), which makes modified enter arrive as CSI 13;<mod>u
 * while leaving ordinary typing alone. Terminals that don't speak it ignore the
 * sequence, so the fallbacks below carry them:
 *
 *   shift+enter   real, when the terminal supports CSI-u    → newline
 *   alt+enter     arrives as ESC \r                          → newline
 *   ctrl+j        arrives as \n, always distinct from \r     → newline
 *   trailing \    backslash at end of line, then enter       → newline
 *   enter                                                    → submit
 *
 * Ink reports \r as key.return with input '\r'. \n parses as name 'enter', so
 * key.return is false — that difference is what makes ctrl+j detectable.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';

const KITTY_ON = '\x1b[>1u';
const KITTY_OFF = '\x1b[<u';
const KITTY_QUERY = '\x1b[?u';

// Replies the terminal sends back to our own queries. They arrive on stdin
// exactly like typed text, so without this they get inserted into the draft.
const TERMINAL_REPORT = /^\[[?0-9;]*[uRc]$/;

const INVERSE = '\x1b[7m';      // the cursor block
const INVERSE_OFF = '\x1b[27m';
const GREY = '\x1b[90m';        // placeholder
const GREY_OFF = '\x1b[39m';

// CSI 13;<modifier>u — enter with any modifier held.
const CSI_MODIFIED_ENTER = /^\[13;\d+u$/;

/**
 * Ask the terminal for kitty key disambiguation, then ask whether it took.
 *
 * Windows Terminal does not implement this protocol (it has its own
 * win32-input-mode instead), so on Windows the query simply goes unanswered and
 * shift+enter stays physically identical to enter. That is why the UI reports
 * whichever newline key actually works rather than promising shift+enter
 * everywhere — see `modifiedEnterWorks` in tui.mjs.
 */
export function enableModifiedEnter(stdout) {
  if (!stdout || !stdout.isTTY) return () => {};
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { stdout.write(KITTY_OFF); } catch {}
  };
  try {
    stdout.write(KITTY_ON);
    stdout.write(KITTY_QUERY); // a reply means the protocol is really supported
  } catch {}
  process.once('exit', restore);
  return restore;
}

/** True for a terminal's answer to one of our capability queries. */
export function isTerminalReport(input) {
  return TERMINAL_REPORT.test(input);
}

/** Split a string into rendered rows, wrapping each logical line at `width`. */
function layout(value, width) {
  const rows = [];
  const logical = value.split('\n');
  for (let li = 0; li < logical.length; li++) {
    const line = logical[li];
    let start = 0;
    do {
      const chunk = line.slice(start, start + width);
      rows.push({ line: li, start, text: chunk });
      start += width;
    } while (start < line.length);
  }
  return rows;
}

/** Absolute offset of the start of logical line `n`. */
function lineOffset(value, n) {
  let offset = 0;
  const lines = value.split('\n');
  for (let i = 0; i < n; i++) offset += lines[i].length + 1;
  return offset;
}

export default function TextArea({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  width = 60,
  focus = true,
  showCursor = true,
  // When the command palette is open it owns up/down for selection, so the
  // composer must not also move its cursor on those keys.
  allowVertical = true,
}) {
  const [cursor, setCursor] = React.useState(value.length);

  // Keep the cursor inside the value when it changes from outside (e.g. a
  // command completion replacing the draft).
  React.useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  const apply = React.useCallback((next, nextCursor) => {
    onChange(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
  }, [onChange]);

  const insert = React.useCallback((text) => {
    const next = value.slice(0, cursor) + text + value.slice(cursor);
    apply(next, cursor + text.length);
  }, [value, cursor, apply]);

  const newline = React.useCallback(() => insert('\n'), [insert]);

  useInput((input, key) => {
    if (!focus) return;

    // ── newline vs submit ──
    if (CSI_MODIFIED_ENTER.test(input)) { newline(); return; }
    // Capability replies must never land in the draft as literal text.
    if (TERMINAL_REPORT.test(input)) return;
    if (key.return && key.shift) { newline(); return; }
    if (!key.return && (input === '\r' || input === '\n')) { newline(); return; } // alt+enter, ctrl+j

    if (key.return) {
      // Trailing backslash is the universal fallback for terminals that send
      // the same byte for enter and shift+enter.
      if (value.slice(0, cursor).endsWith('\\')) {
        apply(value.slice(0, cursor - 1) + '\n' + value.slice(cursor), cursor);
        return;
      }
      onSubmit(value);
      return;
    }

    // ── multi-character input is a paste ──
    if (input.length > 1 && !key.ctrl && !key.meta) {
      insert(input.replace(/\r\n?/g, '\n'));
      return;
    }

    // ── editing ──
    if (key.backspace || (key.delete && !key.meta)) {
      // Ink reports the DEL byte (0x7f) as `delete`, which is what most
      // terminals actually send for the backspace key.
      if (cursor > 0) apply(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }

    if (key.ctrl) {
      switch (input) {
        case 'a': setCursor(lineOffset(value, value.slice(0, cursor).split('\n').length - 1)); return;
        case 'e': {
          const lines = value.split('\n');
          const li = value.slice(0, cursor).split('\n').length - 1;
          setCursor(lineOffset(value, li) + lines[li].length);
          return;
        }
        case 'k': {
          const rest = value.slice(cursor);
          const nl = rest.indexOf('\n');
          apply(value.slice(0, cursor) + (nl === -1 ? '' : rest.slice(nl)), cursor);
          return;
        }
        case 'u': {
          const li = value.slice(0, cursor).split('\n').length - 1;
          const start = lineOffset(value, li);
          apply(value.slice(0, start) + value.slice(cursor), start);
          return;
        }
        case 'w': {
          const before = value.slice(0, cursor);
          const trimmed = before.replace(/\s*\S+$/, '');
          apply(trimmed + value.slice(cursor), trimmed.length);
          return;
        }
        default: return;
      }
    }

    // ── movement ──
    if (key.leftArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCursor((c) => Math.min(value.length, c + 1)); return; }

    if (key.upArrow || key.downArrow) {
      if (!allowVertical) return;
      const lines = value.split('\n');
      const li = value.slice(0, cursor).split('\n').length - 1;
      const col = cursor - lineOffset(value, li);
      const target = key.upArrow ? li - 1 : li + 1;
      if (target < 0 || target >= lines.length) return;
      setCursor(lineOffset(value, target) + Math.min(col, lines[target].length));
      return;
    }

    // ── plain character ──
    if (input && !key.meta && !key.ctrl && !key.tab && !key.escape) {
      insert(input);
    }
  }, { isActive: focus });

  // ── render ──
  const w = Math.max(8, width);

  if (value.length === 0) {
    return React.createElement(
      Text,
      null,
      showCursor && focus
        ? INVERSE + (placeholder[0] || ' ') + INVERSE_OFF +
          GREY + placeholder.slice(1) + GREY_OFF
        : GREY + placeholder + GREY_OFF
    );
  }

  const rows = layout(value, w);
  const lines = value.split('\n');
  const curLine = value.slice(0, cursor).split('\n').length - 1;
  const curCol = cursor - lineOffset(value, curLine);

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...rows.map((row, i) => {
      const isCursorRow =
        focus && showCursor &&
        row.line === curLine &&
        curCol >= row.start &&
        (curCol < row.start + w || (row.start + w >= lines[row.line].length && curCol <= lines[row.line].length));

      if (!isCursorRow) {
        return React.createElement(Text, { key: i }, row.text || ' ');
      }
      const at = curCol - row.start;
      const before = row.text.slice(0, at);
      const under = row.text[at] ?? ' ';
      const after = row.text.slice(at + 1);
      return React.createElement(
        Text,
        { key: i },
        before + INVERSE + under + INVERSE_OFF + after
      );
    })
  );
}
