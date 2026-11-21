/**
 * Codeply add-on: the shared context. Every part of Codeply (chats, agents,
 * quick chat, voice mode, the phone, Codeply CLI) reads one brain, one picture of the
 * user's day and one ledger of what Codeply did. This brings the same view
 * into DSH chats:
 *
 *   - at the first step of a turn, Codeply's block (preferences, project
 *     decisions, open to-dos, what is coming up today, what Codeply did
 *     lately and whether it was checked) is added as context; it is added
 *     again only when it changed, so a long chat does not fill up with copies
 *   - `remember`, `recall` and `life_context`, answered by the same code
 *     Classic uses, so what a DSH chat learns is known everywhere else
 *
 * Codeply owns the stores; this add-on only talks to its loopback bridge
 * (`CODEPLY_HAZE_BRIDGE_URL` and its per-launch secret). Without the bridge
 * (the plain terminal app) nothing is registered.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codeply-shared-context': { kind: 'codeply-shared-context' } & ContextFormed
  }
}

export const name = 'codeply-shared-context'
export const inject = ['agents', 'tools']

interface BridgeReply { ok?: boolean; output?: string; text?: string }

const CONTEXT_TIMEOUT_MS = 4_000

/** The text of the newest user message in a request, for ranking what the brain brings up. */
function requestText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: string, content?: unknown } | undefined
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((p: { type?: string, text?: string }) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
        .join(' ')
        .trim()
    }
  }
  return ''
}

/**
 * Register the turn context and the brain tools when Codeply's bridge is present.
 * @param ctx - the engine context.
 */
export function apply(ctx: Context): void {
  const env = launchEnvironmentOf(ctx)
  const haze = env.get('CODEPLY_HAZE_BRIDGE_URL')?.value
  const token = env.get('CODEPLY_HAZE_BRIDGE_TOKEN')?.value
  if (haze === undefined || haze.length === 0 || token === undefined || token.length === 0) return
  const cwd = process.cwd()

  const call = async (route: string, body: Record<string, unknown>, signal: AbortSignal): Promise<BridgeReply> => {
    const response = await fetch(new URL(route, haze).href, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ cwd, ...body }),
    })
    return await response.json() as BridgeReply
  }

  // Per session: the hash of the last block added, so an unchanged block is not added again.
  const lastAdded = new Map<string, string>()

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    let text = ''
    try {
      const timeout = AbortSignal.timeout(CONTEXT_TIMEOUT_MS)
      const reply = await call('/context', { request: requestText(decision.messages), chatId: String(agent.session.id ?? '') }, AbortSignal.any([signal, timeout]))
      text = reply.ok === true && typeof reply.text === 'string' ? reply.text.trim() : ''
    } catch {
      return decision // Codeply busy or closed: the turn goes on without it
    }
    if (text.length === 0) return decision
    const sessionKey = String(agent.session.id ?? '')
    const hash = createHash('sha1').update(text).digest('hex')
    if (lastAdded.get(sessionKey) === hash) return decision
    lastAdded.set(sessionKey, hash)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })

  const bridgeTool = (tool: string) => async (args: Record<string, unknown>, exec: { signal: AbortSignal }) => {
    try {
      const reply = await call(`/brain/${tool}`, { args }, exec.signal)
      return { ok: reply.ok === true, report: reply.output ?? '' }
    } catch (error) {
      if (exec.signal.aborted) throw error
      return { ok: false, report: 'Could not reach Codeply\'s brain. Is Codeply still open? Carry on without it; do not retry this.' }
    }
  }

  ctx.tools.register(defineTool({
    name: 'remember',
    description: 'Save one lasting thing to the user\'s shared Codeply brain, which every Codeply app reads: a preference, a fact about them, a routine, how they like to work, a project decision, idea, requirement or to-do, or temporary context. Or remove one with forget. Never save passwords, keys or other secrets.',
    parameters: {
      kind: { type: 'string', description: 'preference, fact, routine, style, decision, idea, requirement, todo or context (temporary).' },
      slot: { type: 'string', description: 'What it is about in 1 to 4 words, the same each time (reply length, auth provider).' },
      value: { type: 'string', description: 'The value in a few words.' },
      text: { type: 'string', description: 'One short third-person sentence, e.g. The user wants short replies.' },
      certainty: { type: 'string', description: 'stated, implied, temporary, joking (not saved), hypothetical or quoting.' },
      project: { type: 'string', description: 'The project, for decisions, ideas, requirements and to-dos. Default: this folder.' },
      until: { type: 'string', description: 'For context: when it stops being true, in the user\'s local time (17:00 or 2026-10-26T17:00).' },
      forget: { type: 'string', description: 'A memory id from recall, to remove it instead.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    timeoutMs: 15_000,
    execute: bridgeTool('remember'),
    presentCall: args => ({ card: 'generic', title: args.forget ? 'Forget a memory' : 'Remember', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'recall',
    description: 'Search the user\'s shared Codeply brain: preferences and facts, project decisions and to-dos from any Codeply app, temporary context, lessons other agents learned.',
    parameters: {
      query: { type: 'string', description: 'Words to look for. Empty lists the newest.' },
      project: { type: 'string', description: 'Only this project.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    timeoutMs: 15_000,
    execute: bridgeTool('recall'),
    presentCall: args => ({ card: 'generic', title: `Recall ${args.query ?? ''}`.trim(), kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'life_context',
    description: 'Look up the user\'s day, shared by every Codeply app: calendar, email (and who is waiting on a reply), plans, projects.',
    parameters: {
      about: { type: 'string', description: 'now, today, tomorrow, week, person, email, plans or projects. Leave empty to search with query.' },
      query: { type: 'string', description: 'A name for about=person, or words to search for.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    timeoutMs: 15_000,
    execute: bridgeTool('life_context'),
    presentCall: args => ({ card: 'generic', title: `Look up ${args.about ?? args.query ?? 'the day'}`, kind: 'search', rawInput: args }),
  }))
}
