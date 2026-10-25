/** Reverse a turn's unified-diff hunks on a file's current text. Pure, no I/O. */

/** One hunk as `workspaceChanges.diff` serves it. */
export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** A text split into lines, with the line ending and final newline it had. */
export interface SplitText {
  lines: string[]
  eol: '\n' | '\r\n'
  finalNewline: boolean
}

export function splitText(text: string): SplitText {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const finalNewline = text.endsWith('\n')
  const body = finalNewline ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text
  return { lines: body.length === 0 && !finalNewline ? [] : body.split(/\r?\n/), eol, finalNewline }
}

export function joinText({ lines, eol, finalNewline }: SplitText): string {
  return lines.length === 0 ? '' : lines.join(eol) + (finalNewline ? eol : '')
}

const side = (hunk: Hunk, keep: '+' | '-'): string[] =>
  hunk.lines.filter(l => l[0] === ' ' || l[0] === keep).map(l => l.slice(1))

/**
 * Put the turn-start lines back in place of the turn-end lines.
 * @param current - the file's lines now.
 * @param hunks - the turn's hunks, in file order.
 * @returns the turn-start lines, or undefined when the file no longer matches
 *   what the turn left (it changed since), so nothing should be written.
 */
export function reverseHunks(current: readonly string[], hunks: readonly Hunk[]): string[] | undefined {
  const out = [...current]
  // Last hunk first, so earlier hunks' line numbers stay valid.
  for (const hunk of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const after = side(hunk, '+')
    const before = side(hunk, '-')
    const start = hunk.newLines === 0 ? 0 : hunk.newStart - 1
    if (hunk.newLines === 0 && out.length !== 0) return undefined
    for (let i = 0; i < after.length; i++) {
      if (out[start + i] !== after[i]) return undefined
    }
    out.splice(start, after.length, ...before)
  }
  return out
}

/** The turn-start lines of a file the turn deleted (every hunk line is a removal or context). */
export function deletedLines(hunks: readonly Hunk[]): string[] {
  return [...hunks].sort((a, b) => a.oldStart - b.oldStart).flatMap(h => side(h, '-'))
}
