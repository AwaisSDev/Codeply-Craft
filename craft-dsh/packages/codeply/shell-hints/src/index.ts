/**
 * Codeply add-on: after a shell command, one recovery hint when it failed, or
 * a warning when its exit 0 is masking a failure (`cmd | tail`, `cmd || echo`).
 *
 * Observe-and-enrich only: the result passes through unchanged and the hint
 * rides along as additional context, so a later listener can still block or
 * replace the result.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { annotateFailure, annotateMaskedSuccess } from './hints.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codeply-shell-hint': { kind: 'codeply-shell-hint' } & ContextFormed
  }
}

export { annotateFailure, annotateMaskedSuccess } from './hints.ts'
export const name = 'codeply-shell-hints'

export interface Config {
  /** Tool names whose results are shell output carrying `[exit code: N]` markers. */
  tools: string[]
}
export const Config: z<Config> = z.object({
  tools: z.array(z.string()).default(['pwsh', 'bash']),
})

const SOURCE: MessageSource = { kind: 'codeply-shell-hint' }

const textOf = (content: readonly ContentBlock[]): string =>
  content.map(block => (block.type === 'text' ? block.text : '')).join('\n')

/**
 * The hint for one shell result, if any.
 * @param exec - the shell call.
 * @param result - its outcome.
 * @returns hint text, or undefined.
 */
export function hintFor(exec: ToolExecution, result: Readonly<ToolExecutionResult>): string | undefined {
  const args = exec.arguments as { command?: unknown } | undefined
  const command = typeof args?.command === 'string' ? args.command : ''
  const output = textOf(result.content)
  const codes = [...output.matchAll(/\[exit code: (-?\d+)\]/g)]
  const exitCode = codes.length > 0 ? Number(codes[codes.length - 1]![1]) : 0
  return (exitCode !== 0 ? annotateFailure(exitCode, output) : annotateMaskedSuccess(command, output)) ?? undefined
}

export function apply(ctx: Context, config: Config): void {
  const tools = new Set(config.tools)
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    if (!tools.has(exec.name) || exec.agent === undefined) return downstream
    const hint = hintFor(exec, result)
    if (hint === undefined) return downstream
    const note = createUserMessage({
      content: [{ type: 'text', text: `Hint for the last ${exec.name} command: ${hint}` }],
      source: { ...SOURCE, form: 'notice', summary: 'shell hint' },
    })
    return { ...downstream, additionalContexts: [...downstream.additionalContexts ?? [], note] }
  })
}
