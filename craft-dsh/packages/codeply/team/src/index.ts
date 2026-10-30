/**
 * Codeply add-on: Codeply's private specialists in DSH chats, the same way
 * Classic chats have them (codeply-cli/lib/bots.js teamPrompt and delegate):
 *
 *   - the CODEPLY and SPECIALISTS prompt (who Codeply is, its specialists,
 *     that the work is its own and a specialist is never named) is added to
 *     the system prompt of every step of a chat Craft runs as Codeply
 *   - `ask_bot` hands one task to a specialist and waits for its result; with
 *     a new name and a `specialty` it makes that specialist first, so a user
 *     with no bots yet still gets their first one
 *   - `hand_off` passes work on to the bot whose domain it is, without
 *     waiting, when Codeply can hand work on
 *
 * Craft owns the bots and runs the specialists; this add-on only talks to its
 * loopback bridge (`CODEPLY_HAZE_BRIDGE_URL` and its per-launch secret), per
 * chat (the DSH session id). A chat Craft did not start as Codeply gets none
 * of it, and without the bridge (the plain terminal app) nothing is
 * registered.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

export const name = 'codeply-team'
export const inject = ['tools', 'systemPrompt']

/** What Craft says about one chat: its prompt and which tools it has. */
interface TeamState { prompt?: string; askBot?: boolean; handOff?: boolean }

interface BridgeReply { ok?: boolean; output?: string }

const STATE_TIMEOUT_MS = 4_000
/** One answer serves a step's tool list and its prompt, then is asked again. */
const STATE_TTL_MS = 3_000
/** A specialist works with its own tools until it is done, like a long command. */
const ASK_TIMEOUT_MS = 30 * 60_000

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      report: { type: 'string', required: true },
    },
  },
  render: (_args: unknown, value: { report: string }) => [{ type: 'text' as const, text: value.report }],
} as const

/** The first line of a task, for the tool card (never the specialist's name). */
const firstLine = (text: unknown): string => String(text ?? '').split('\n')[0]?.trim().slice(0, 80) ?? ''

/**
 * Register the prompt and the two tools when Craft's bridge is present.
 * @param ctx - the engine context.
 */
export function apply(ctx: Context): void {
  const env = launchEnvironmentOf(ctx)
  const haze = env.get('CODEPLY_HAZE_BRIDGE_URL')?.value
  const token = env.get('CODEPLY_HAZE_BRIDGE_TOKEN')?.value
  if (haze === undefined || haze.length === 0 || token === undefined || token.length === 0) return

  const post = (route: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> => fetch(new URL(route, haze).href, {
    method: 'POST',
    signal,
    redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  const states = new Map<string, { at: number; value: Promise<TeamState> }>()
  const stateOf = (chatId: string): Promise<TeamState> => {
    const cached = states.get(chatId)
    if (cached !== undefined && Date.now() - cached.at < STATE_TTL_MS) return cached.value
    const value = (async (): Promise<TeamState> => {
      try {
        const response = await post('/team', { chatId }, AbortSignal.timeout(STATE_TIMEOUT_MS))
        if (!response.ok) return {}
        return await response.json() as TeamState
      } catch {
        return {} // Craft busy or closed: this step goes on without the team
      }
    })()
    states.set(chatId, { at: Date.now(), value })
    for (const [key, entry] of states) if (Date.now() - entry.at > STATE_TTL_MS * 10) states.delete(key)
    return value
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.agent === undefined) return assembly
    const team = await stateOf(String(context.agent.session.id ?? ''))
    const text = typeof team.prompt === 'string' ? team.prompt.trim() : ''
    if (text.length === 0) return assembly
    return { ...assembly, sections: [...assembly.sections, { name, text, interpolate: false }] }
  })

  const bridgeTool = (tool: 'ask_bot' | 'hand_off') => async (args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: { session: { id?: unknown } } }) => {
    const chatId = String(exec.agent?.session.id ?? '')
    try {
      const response = await post(`/team/${tool}`, { chatId, args }, exec.signal)
      const reply = await response.json() as BridgeReply
      return { ok: reply.ok === true, report: reply.output ?? `${tool} returned nothing.` }
    } catch (error) {
      if (exec.signal.aborted) throw error
      return { ok: false, report: `Could not reach Codeply for ${tool}. Is it still open? Do this part yourself; do not retry.` }
    } finally {
      states.delete(chatId) // a new specialist is on the list from the next step
    }
  }

  ctx.tools.register(defineTool({
    name: 'ask_bot',
    description: 'Hand one task to one of your specialists from the SPECIALISTS list and wait for its result. Only one runs at a time.',
    parameters: {
      bot: { type: 'string', required: true, description: 'Its name.' },
      task: { type: 'string', required: true, description: 'The one task, with all the context it needs (it sees nothing else).' },
      specialty: { type: 'string', description: 'Optional, only to make a new specialist (a name not on the list yet): its area in one line, like "Calendar: keeps the user\'s schedule and plans the day".' },
    },
    output: OUTPUT,
    timeoutMs: ASK_TIMEOUT_MS,
    execute: bridgeTool('ask_bot'),
    presentCall: args => ({ card: 'generic', title: `Working on: ${firstLine(args.task)}`, kind: 'other', rawInput: args }),
  }), { when: async ({ agent }) => (await stateOf(String(agent.session.id ?? ''))).askBot === true })

  ctx.tools.register(defineTool({
    name: 'hand_off',
    description: 'Pass the part of a job that belongs to another bot (calendar, email, reminders, research...) and carry on without waiting. Send only what they need.',
    parameters: {
      to: { type: 'string', required: true, description: 'A bot\'s name, or a domain: calendar, email, reminders, calls, texts, research, code, social, health, money.' },
      intent: { type: 'string', required: true, description: 'What they should get done, in one or two sentences.' },
      facts: { type: 'string', description: 'The facts they need, one per line: names, addresses, dates and times with the time zone, ids.' },
      decision: { type: 'string', description: 'What has been decided so far, if anything.' },
    },
    output: OUTPUT,
    timeoutMs: 60_000,
    execute: bridgeTool('hand_off'),
    presentCall: args => ({ card: 'generic', title: `Passed on: ${firstLine(args.intent)}`, kind: 'other', rawInput: args }),
  }), { when: async ({ agent }) => (await stateOf(String(agent.session.id ?? ''))).handOff === true })
}
