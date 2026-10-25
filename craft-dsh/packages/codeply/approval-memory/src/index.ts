/**
 * Codeply add-on: "Ask once". DSH approvals are one-shot; in the Ask once mode
 * (the `workspace-write` preset, relabelled in the picker) this remembers what
 * the person approved and answers the same kind of request again in the same
 * chat without asking. "Always ask" and "Full access" are untouched.
 *
 * The kind of request is the tool, plus the command's first word for shell
 * tools (`pwsh:npm`, `bash:git`), so approving `npm install` covers `npm test`
 * but not `rm`. Memory lives in this process and ends with the chat.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'

export const name = 'codeply-approval-memory'
export const inject = ['approval']

export interface Config {
  /** The permission preset that means "Ask once". */
  preset: string
  /** Tools whose first command word is part of the remembered kind. */
  shellTools: string[]
}
export const Config: z<Config> = z.object({
  preset: z.string().default('workspace-write'),
  shellTools: z.array(z.string()).default(['pwsh', 'bash']),
})

/** The session's current permission preset, from its own log. */
function presetOf(session: Session): string | undefined {
  let preset: string | undefined
  for (const event of session.ownEvents()) {
    if (event.type === 'permission/preset') preset = event.data.preset
  }
  return preset
}

/** The first word of a shell call's command, found by its call id. */
function commandHead(session: Session, callId: string | undefined): string {
  if (callId === undefined) return ''
  for (const event of session.ownEvents()) {
    if (event.type !== 'tool/call' || event.data.callId !== callId) continue
    try {
      const command = (JSON.parse(event.data.arguments) as { command?: unknown }).command
      return typeof command === 'string' ? (command.trim().split(/\s+/)[0] ?? '').toLowerCase() : ''
    } catch {
      return ''
    }
  }
  return ''
}

export function apply(ctx: Context, config: Config): void {
  const shellTools = new Set(config.shellTools)
  const remembered = new WeakMap<Session, Set<string>>()
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    const session = req.agent.session
    // Unknown means the session never switched: the deployment default, which is this preset.
    const preset = presetOf(session) ?? config.preset
    if (preset !== config.preset) return next()
    const kind = shellTools.has(req.toolName) ? `${req.toolName}:${commandHead(session, req.callId)}` : req.toolName
    const known = remembered.get(session)
    if (known?.has(kind) === true) return 'allowed-once'
    const outcome = await next()
    if (outcome === 'allowed-once') {
      const set = known ?? new Set<string>()
      set.add(kind)
      remembered.set(session, set)
    }
    return outcome
  })
}
