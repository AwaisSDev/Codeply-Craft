/**
 * Codeply add-on: when an edit's old_string is not in the file, show the model
 * the region it most likely meant, with line numbers, so it copies the real
 * text on its next try instead of re-reading a long file or guessing again
 * from memory. When old_string matches more than once, list where.
 *
 * Ported from Classic Craft (codeply-cli/lib/tools.mjs nearestMatchHint).
 * Observe-and-enrich only: the failure passes through unchanged.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codeply-edit-near-miss': { kind: 'codeply-edit-near-miss' } & ContextFormed
  }
}

export const name = 'codeply-edit-near-miss'

export interface Config {
  /** Skip files larger than this. */
  maxFileBytes: number
}
export const Config: z<Config> = z.object({
  maxFileBytes: z.natural().default(2_000_000),
})

const SOURCE: MessageSource = { kind: 'codeply-edit-near-miss' }

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

/** Dice similarity of two trimmed lines, 0..1. */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const A = bigrams(a)
  const B = bigrams(b)
  let overlap = 0
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0)
  return (2 * overlap) / (a.length - 1 + b.length - 1)
}

/**
 * The file region a missed search block most likely meant.
 * @param content - the file as it is now.
 * @param search - the old_string that did not match.
 * @returns hint text, or '' when nothing is close enough.
 */
export function nearestMatchHint(content: string, search: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const want = search.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean)
  if (want.length === 0 || lines.length === 0) return ''
  let best = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length === 0) continue
    // Score a candidate start by how well the next few file lines line up
    // with the first few search lines, not by one line alone: a single
    // closing brace or "return x;" matches all over a file.
    let score = 0
    let n = 0
    for (let k = 0, fi = i; k < Math.min(3, want.length) && fi < lines.length; fi++) {
      const ft = lines[fi]!.trim()
      if (ft.length === 0) continue
      score += lineSimilarity(ft, want[k]!)
      n++
      k++
    }
    score = n > 0 ? score / Math.min(3, want.length) : 0
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (best === -1 || bestScore < 0.45) return ''
  const from = Math.max(0, best - 2)
  const to = Math.min(lines.length, best + want.length + 3)
  const width = String(to).length
  const excerpt = lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(width)}│${l}`).join('\n')
  return `Closest match in the file right now (lines ${from + 1}-${to}). Copy old_string from here, without the line-number prefix:\n${excerpt}`
}

/** 1-based line numbers where an exact block starts. */
export function exactMatchLines(content: string, block: string): number[] {
  const text = content.replace(/\r\n/g, '\n')
  const needle = block.replace(/\r\n/g, '\n')
  const out: number[] = []
  for (let at = text.indexOf(needle); at !== -1 && out.length < 20; at = text.indexOf(needle, at + 1)) {
    out.push(text.slice(0, at).split('\n').length)
  }
  return out
}

/** The path and search text of an edit call, for `edit` and `str_replace_editor`. */
function editTarget(exec: ToolExecution): { path: string; search: string } | undefined {
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  if (exec.name === 'edit' && typeof args.file_path === 'string' && typeof args.old_string === 'string') {
    return { path: args.file_path, search: args.old_string }
  }
  if (exec.name === 'str_replace_editor' && args.command === 'str_replace' && typeof args.path === 'string' && typeof args.old_str === 'string') {
    return { path: args.path, search: args.old_str }
  }
  return undefined
}

function failureKind(result: Readonly<ToolExecutionResult>): 'missing' | 'ambiguous' | undefined {
  if (!result.isError) return undefined
  const code = result.error.info?.code ?? ''
  const message = result.error.message
  if (code === 'FS_EDIT_NOT_FOUND' || /was not found in|did not appear|no match/i.test(message)) return 'missing'
  if (code === 'FS_AMBIGUOUS_EDIT' || /multiple|more than once|appears \d+ times/i.test(message)) return 'ambiguous'
  return undefined
}

export function apply(ctx: Context, config: Config): void {
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    const kind = failureKind(result)
    const target = kind === undefined ? undefined : editTarget(exec)
    if (kind === undefined || target === undefined || exec.agent === undefined) return downstream
    let text: string
    try {
      const cwd = await ctx.get('workingDirectory')?.ensure(exec.agent, exec.signal)
      const file = isAbsolute(target.path) || cwd === undefined ? target.path : resolve(cwd, target.path)
      const content = await readFile(file, 'utf8')
      if (Buffer.byteLength(content) > config.maxFileBytes) return downstream
      if (kind === 'missing') {
        text = nearestMatchHint(content, target.search)
      } else {
        const at = exactMatchLines(content, target.search)
        text = at.length > 1 ? `old_string appears ${at.length} times, starting on lines ${at.join(', ')}. Include more surrounding lines so it matches once, or set replace_all if every one should change.` : ''
      }
    } catch {
      return downstream
    }
    if (text.length === 0) return downstream
    const note = createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...SOURCE, form: 'notice', summary: kind === 'missing' ? 'closest match' : 'match lines' },
    })
    return { ...downstream, additionalContexts: [...downstream.additionalContexts ?? [], note] }
  })
}
