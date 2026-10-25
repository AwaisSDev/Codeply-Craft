/**
 * Codeply add-on: when a turn is about to end, read its final answer. If it
 * says files were changed, tests were run, or something was deployed, and no
 * tool that could have done that succeeded this turn, send the model back once
 * to either do it or correct the summary. A real, observed failure on weaker
 * models: they narrate "I have now applied the change" instead of calling the
 * tool, and the chat describes progress that never happened.
 *
 * Ported from Classic Craft's claim audit (codeply-cli/lib/agent.mjs).
 * Steering only: nothing is blocked or rewritten.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CLAIM_CHANGED, CLAIM_SHIPPED, CLAIM_VERIFIED, claimedFiles } from './claims.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codeply-claim-check': { kind: 'codeply-claim-check' } & ContextFormed
  }
}

export { CLAIM_CHANGED, CLAIM_SHIPPED, CLAIM_VERIFIED, claimedFiles } from './claims.ts'
export const name = 'codeply-claim-check'

export interface Config {
  /** Times per turn the model is sent back for an unbacked claim. */
  maxNudgesPerTurn: number
  /** Tools that change files and name them. */
  editTools: string[]
  /** Tools that run commands: they can test, deploy, or change files without naming them. */
  shellTools: string[]
  /** Tools known to change nothing; any other tool might, so the file check stays out of its way. */
  readOnlyTools: string[]
}
export const Config: z<Config> = z.object({
  maxNudgesPerTurn: z.natural().default(1),
  editTools: z.array(z.string()).default(['write', 'edit', 'str_replace_editor']),
  shellTools: z.array(z.string()).default(['pwsh', 'bash']),
  readOnlyTools: z.array(z.string()).default([
    'read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search', 'todo_write', 'get_goal', 'create_goal', 'update_goal',
    'list_agents', 'job_list', 'job_output', 'skill', 'working_directory', 'lsp', 'send_message', 'interrupt_agent', 'job_kill',
  ]),
})

const SOURCE: MessageSource = { kind: 'codeply-claim-check' }

/** What actually happened in one turn, from the session log. */
export interface TurnFacts {
  /** The turn's last assistant text. */
  answer: string
  /** Names of tools that succeeded. */
  succeeded: Set<string>
  /** Base names (lower case) of files an edit tool changed. */
  edited: Set<string>
}

const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? p).toLowerCase()

/**
 * Fold one turn's events.
 * @param events - the session's own events.
 * @param turn - the turn to read.
 * @param editTools - tools whose file argument names a changed file.
 * @returns the turn's facts.
 */
export function turnFacts(events: readonly SessionEvent[], turn: number, editTools: ReadonlySet<string>): TurnFacts {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const facts: TurnFacts = { answer: '', succeeded: new Set(), edited: new Set() }
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.turn === turn) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(event.data.arguments) as Record<string, unknown> } catch {}
      calls.set(event.data.callId, { name: event.data.name, args })
    } else if (event.type === 'tool/result' && event.data.turn === turn) {
      const call = calls.get(event.data.message.toolCallId)
      if (call === undefined || event.data.error !== undefined || event.data.message.isError === true) continue
      facts.succeeded.add(call.name)
      if (editTools.has(call.name) && call.args.command !== 'view') {
        const file = call.args.file_path ?? call.args.path
        if (typeof file === 'string') facts.edited.add(baseName(file))
      }
    } else if (event.type === 'assistant/message' && event.data.turn === turn) {
      const text = event.data.message.content.map((b: ContentBlock) => (b.type === 'text' ? b.text : '')).join('')
      if (text.trim().length > 0) facts.answer = text
    }
  }
  return facts
}

/**
 * The correction for one turn's answer, if it claims what no tool did.
 * @param facts - the turn's facts.
 * @param config - tool classes.
 * @returns steering text, or undefined.
 */
export function correctionFor(facts: TurnFacts, config: Config): string | undefined {
  const { answer, succeeded, edited } = facts
  if (answer.length === 0) return undefined
  const ranShell = config.shellTools.some(t => succeeded.has(t))
  const known = new Set([...config.readOnlyTools, ...config.editTools, ...config.shellTools])
  const otherWriter = [...succeeded].some(t => !known.has(t))
  if (!ranShell && !otherWriter && CLAIM_CHANGED.test(answer)) {
    const missing = edited.size > 0 ? claimedFiles(answer).filter(f => !edited.has(f)) : []
    if (edited.size === 0) {
      return 'Your answer describes files as changed, but no file was written or edited this turn. Do not narrate work '
        + 'as done that you have not done. Make the change now with the write or edit tool (old_string copied from a file '
        + 'you have actually read), or if you cannot proceed, say so plainly instead of claiming success.'
    }
    if (missing.length > 0) {
      return `Your answer says ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} changed, but `
        + `${missing.length === 1 ? 'it was' : 'they were'} never written or edited this turn. Only claim what you did: `
        + 'make that change now, or correct your summary to the files you truly changed.'
    }
  }
  if (!ranShell && CLAIM_VERIFIED.test(answer)) {
    return 'Your answer says you ran, tested or verified something, but no command ran this turn. Never report a result you '
      + 'did not get from a tool: run it now, or say plainly that it is unverified.'
  }
  if (!ranShell && CLAIM_SHIPPED.test(answer)) {
    return 'Your answer says something was deployed, pushed or published, but no command ran this turn. Do it now, or say '
      + 'plainly that it has not been done.'
  }
  return undefined
}

export function apply(ctx: Context, config: Config): void {
  const editTools = new Set(config.editTools)
  const nudged = new WeakMap<Agent, { turn: number; count: number }>()
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const seen = nudged.get(agent)
    const count = seen?.turn === turn ? seen.count : 0
    if (count >= config.maxNudgesPerTurn) return
    const text = correctionFor(turnFacts(agent.session.ownEvents(), turn, editTools), config)
    if (text === undefined) return
    nudged.set(agent, { turn, count: count + 1 })
    agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...SOURCE, form: 'notice', summary: 'unbacked claim' },
    }))
  })
}
