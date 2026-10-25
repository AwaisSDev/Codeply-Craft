/**
 * Codeply add-on: after every successful write or edit, a fast syntax check of
 * the file (JS through `node --check`, JSON, TS/TSX through the project's own
 * TypeScript, CSS braces, Python `ast`). Problems reach the model in the same
 * step, and a turn cannot quietly end while a file it changed still fails:
 * the model is sent back once to fix it or say so.
 *
 * Ported from Classic Craft (codeply-cli/lib/diagnostics.js and the
 * verification loop in agent.mjs). Observe-and-enrich only.
 */
import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { checkFile } from './checks.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codeply-edit-checks': { kind: 'codeply-edit-checks' } & ContextFormed
  }
}

export { checkFile } from './checks.ts'
export const name = 'codeply-edit-checks'

export interface Config {
  /** Times per turn the model is sent back for a file still failing its check. */
  maxNudgesPerTurn: number
}
export const Config: z<Config> = z.object({
  maxNudgesPerTurn: z.natural().default(1),
})

const SOURCE: MessageSource = { kind: 'codeply-edit-checks' }

/** The file a successful mutation touched, for `write`, `edit` and `str_replace_editor`. */
function changedPath(exec: ToolExecution): string | undefined {
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  if ((exec.name === 'write' || exec.name === 'edit') && typeof args.file_path === 'string') return args.file_path
  if (exec.name === 'str_replace_editor' && args.command !== 'view' && typeof args.path === 'string') return args.path
  return undefined
}

const note = (text: string, summary: string) =>
  createUserMessage({ content: [{ type: 'text', text }] as ContentBlock[], source: { ...SOURCE, form: 'notice', summary } })

interface AgentState {
  /** Files (absolute) whose last check failed: the path as the model wrote it, and the problems. */
  open: Map<string, { shown: string; problems: string[] }>
  nudgedTurn: number
  nudges: number
}

export function apply(ctx: Context, config: Config): void {
  const states = new WeakMap<Agent, AgentState>()
  const stateOf = (agent: Agent): AgentState => {
    let s = states.get(agent)
    if (s === undefined) { s = { open: new Map(), nudgedTurn: -1, nudges: 0 }; states.set(agent, s) }
    return s
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    const target = changedPath(exec)
    if (target === undefined || exec.agent === undefined || result.isError || downstream.kind !== 'accept') return downstream
    let file: string
    try {
      const cwd = await ctx.get('workingDirectory')?.ensure(exec.agent, exec.signal)
      file = isAbsolute(target) || cwd === undefined ? target : resolve(cwd, target)
    } catch {
      return downstream
    }
    const problems = await checkFile(file)
    const state = stateOf(exec.agent)
    if (problems.length === 0) {
      state.open.delete(file)
      return downstream
    }
    state.open.set(file, { shown: target, problems })
    const text = `Syntax check failed for ${target} after this change:\n${problems.map(p => `- ${p}`).join('\n')}\nFix it before moving on.`
    return { ...downstream, additionalContexts: [...downstream.additionalContexts ?? [], note(text, `check failed: ${target}`)] }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = states.get(agent)
    if (state === undefined || state.open.size === 0) return
    if (state.nudgedTurn !== turn) { state.nudgedTurn = turn; state.nudges = 0 }
    if (state.nudges >= config.maxNudgesPerTurn) return
    state.nudges++
    const list = [...state.open.values()].map(({ shown, problems }) => `- ${shown}: ${problems[0]}`).join('\n')
    agent.steer(note(
      `You are finishing, but the syntax check still fails for:\n${list}\nFix it, or if you cannot, say so plainly in your summary.`,
      'unfixed check',
    ))
  })
}
