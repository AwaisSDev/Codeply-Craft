/**
 * Codeply add-on: no OS sandbox, and "Approve manually" really asks.
 *
 * DSH confines every shell command and file write in an OS sandbox
 * (`workspace-write` by default) and only asks the user when a call wants out
 * of it. That blocks ordinary work (npm's cache under AppData, `git clone`,
 * global installs) with EPERM. Codeply runs the engine like Claude Code and
 * Classic Craft instead: no sandbox (`DSH_PERMISSION_MODE=danger-full-access`,
 * set by the host), and under the `ask` approval policy the person approves
 * each write, edit, shell command or background agents before it runs.
 * The host answers those asks itself when the person picked "Full access".
 *
 * Two jobs:
 * - Ask before a mutating tool when the session's approval policy is `ask`
 *   (`never` passes through: asking under it would auto-reject everything).
 * - Chats started before this change have `workspace-write` pinned in their
 *   own log; each one is moved to the deployment's mode when it opens.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'

export const name = 'codeply-ask-first'
export const inject = ['approval', 'sandboxPolicy']

export interface Config {
  /** Tools that change files or run commands: each call asks under the `ask` policy. */
  tools: string[]
  /** `str_replace_editor` commands that only read, so never ask. */
  readOnlyEditorCommands: string[]
  /** Move sessions whose log pins another sandbox mode to the deployment's mode when they open. */
  migrateSandbox: boolean
}
export const Config: z<Config> = z.object({
  tools: z.array(z.string()).default(['write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'start_agents']),
  readOnlyEditorCommands: z.array(z.string()).default(['view']),
  migrateSandbox: z.boolean().default(true),
})

/** A short line for the approval card: the command, the path, or the task. */
function summary(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'task', 'prompt']) {
    const v = a[key]
    if (typeof v === 'string' && v.trim() !== '') return v.length > 300 ? `${v.slice(0, 300)}…` : v
  }
  return undefined
}

export function apply(ctx: Context, config: Config): void {
  const tools = new Set(config.tools)
  const readOnly = new Set(config.readOnlyEditorCommands)

  const policyOf = (session: Session): 'ask' | 'never' =>
    ctx.approval.overrideOf(session) ?? ctx.approval.config.policy ?? 'ask'

  if (config.migrateSandbox) {
    ctx.on('agent/created', ({ agent }) => {
      const session = agent.session
      const pinned = ctx.sandboxPolicy.overrideOf(session)
      const wanted = ctx.sandboxPolicy.defaultMode
      if (pinned !== undefined && pinned !== wanted) setSandboxMode(session, wanted)
      return undefined
    })
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!tools.has(exec.name) || exec.agent === undefined) return next()
    if (exec.name === 'str_replace_editor') {
      const command = (exec.arguments as { command?: unknown } | null)?.command
      if (typeof command === 'string' && readOnly.has(command)) return next()
    }
    if (policyOf(exec.agent.session) !== 'ask') return next()
    // Let earlier rules deny first; only an allow becomes an ask.
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    const line = summary(exec)
    return { kind: 'ask', reason: line === undefined ? `Allow ${exec.name}?` : `Allow ${exec.name}: ${line}` }
  })
}
