/**
 * Codeply add-on: `/undo` puts back the files the most recent turn changed.
 *
 * It needs no snapshots of its own: DSH's workspace-changes plugin already
 * records each turn's changes (git snapshots plus whole-file captures around
 * file-tool edits) and serves them as unified-diff hunks. Undo reverses those
 * hunks, but only when every file still holds exactly what that turn left, so
 * a later edit (by the agent or by hand) is never overwritten: one mismatch
 * and nothing is touched. Files the turn created are deleted, files it
 * deleted come back. The model is told in its next request.
 *
 * Classic Craft's per-message Undo (codeply-cli/lib/snapshot.js) in this
 * engine's terms. A second `/undo` goes one more turn back.
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import { deletedLines, joinText, reverseHunks, splitText } from './reverse.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codeply-undo': { kind: 'codeply-undo' } & ContextFormed
  }
}

export { deletedLines, joinText, reverseHunks, splitText } from './reverse.ts'
export const name = 'codeply-undo'
export const inject = ['commands', 'workspaceChanges']

const SOURCE: MessageSource = { kind: 'codeply-undo' }

/** One planned file write, decided before anything is written. */
type Step =
  | { kind: 'write'; file: string; display: string; text: string }
  | { kind: 'delete'; file: string; display: string }

export function apply(ctx: Context): void {
  /** Sessions -> `workspace/changes` sequence numbers already undone. */
  const undone = new WeakMap<Session, Set<number>>()

  async function undo(invocation: CommandInvocation): Promise<CommandResult> {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: 'Usage: /undo (no arguments)' }
    const { agent, signal } = invocation
    const session = agent.session
    const done = undone.get(session) ?? new Set<number>()
    // The latest turn summary not undone yet; a later event for the same turn replaces earlier ones.
    const latestByTurn = new Map<number, number>()
    for (const event of session.ownEvents()) {
      if (event.type === 'workspace/changes') latestByTurn.set(event.data.turn, event.seq)
    }
    const candidates = [...latestByTurn].sort((a, b) => b[0] - a[0]).filter(([, seq]) => !done.has(seq))
    let target: { turn: number; seq: number; files: number } | undefined
    for (const [turn, seq] of candidates) {
      const summary = ctx.workspaceChanges.summary(session.id, seq)
      if (summary !== undefined && summary.total > 0) { target = { turn, seq, files: summary.total }; break }
    }
    if (target === undefined) return { kind: 'success', text: 'Nothing to undo: no turn in this session changed files.' }
    const summary = ctx.workspaceChanges.summary(session.id, target.seq)!
    if (summary.total > summary.files.length) {
      return { kind: 'error', text: `That turn changed ${summary.total} files, more than can be undone safely here. Use git to restore them.` }
    }
    const steps: Step[] = []
    const skipped: string[] = []
    for (let index = 0; index < summary.files.length; index++) {
      const entry = summary.files[index]!
      const file = isAbsolute(entry.path) ? entry.path : resolve(summary.cwd, entry.path)
      const diff = await ctx.workspaceChanges.diff(session.id, target.seq, index, signal)
      if (diff === undefined || diff.kind !== 'text') { skipped.push(entry.display); continue }
      if (!diff.after) {
        if (existsSync(file)) return { kind: 'error', text: `Not undone: ${entry.display} was deleted by that turn and exists again now.` }
        steps.push({ kind: 'write', file, display: entry.display, text: joinText({ lines: deletedLines(diff.hunks), eol: '\n', finalNewline: true }) })
        continue
      }
      let current: string
      try { current = await readFile(file, 'utf8') } catch {
        return { kind: 'error', text: `Not undone: ${entry.display} is gone or unreadable now.` }
      }
      const split = splitText(current)
      const restored = reverseHunks(split.lines, diff.hunks)
      if (restored === undefined) {
        return { kind: 'error', text: `Not undone: ${entry.display} changed after that turn. Nothing was touched.` }
      }
      if (!diff.before) {
        if (restored.length !== 0) return { kind: 'error', text: `Not undone: ${entry.display} changed after that turn. Nothing was touched.` }
        steps.push({ kind: 'delete', file, display: entry.display })
      } else {
        steps.push({ kind: 'write', file, display: entry.display, text: joinText({ ...split, lines: restored }) })
      }
    }
    if (steps.length === 0) return { kind: 'error', text: `That turn's changes can't be undone here (${skipped.join(', ')}: binary or too large).` }
    signal.throwIfAborted()
    for (const step of steps) {
      if (step.kind === 'delete') await rm(step.file, { force: true })
      else { await mkdir(dirname(step.file), { recursive: true }); await writeFile(step.file, step.text, 'utf8') }
    }
    done.add(target.seq)
    undone.set(session, done)
    const names = steps.map(s => s.display)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `The user undid your file changes from an earlier turn. These files are back as they were before it: ${names.join(', ')}. Read them again before editing.` }],
      source: { ...SOURCE, form: 'notice', summary: 'changes undone' },
    }))
    const extra = skipped.length > 0 ? ` Not undone (binary or too large): ${skipped.join(', ')}.` : ''
    return { kind: 'success', text: `Undid ${steps.length} file${steps.length === 1 ? '' : 's'}: ${names.join(', ')}.${extra}` }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@codeply/dsh-undo'),
      name: 'undo',
      description: 'Undo the file changes from the last turn',
      handler: undo,
    })
  }, 'codeply-undo command')
}
