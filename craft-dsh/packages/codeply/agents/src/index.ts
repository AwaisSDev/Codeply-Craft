/**
 * Codeply add-on: background agents for the main agent of a chat Craft runs.
 *
 *   - `start_agents` starts one agent, or a swarm of 2 to 6 on one goal that
 *     share a team channel, each with a name and a mascot of its own (and
 *     with `browser`, its own tab in Codeply's browser). It returns at once;
 *     their report comes back to the chat as an automatic message.
 *   - `message_agent` redirects or interrupts one by name, while it works or
 *     as its next round; `stop_agent` stops one.
 *   - a BACKGROUND AGENTS section in the system prompt: how to use them, and
 *     the agents this chat already has.
 *
 * The host runs the agents (the Rune app's sidecar, `ext-agents.mjs`); this
 * add-on only talks to its loopback bridge (`CODEPLY_HAZE_BRIDGE_URL` and its
 * per-launch secret), per chat (the DSH session id). Without the bridge, or
 * for a chat the host does not run, nothing is registered or shown.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

export const name = 'codeply-agents'
export const inject = ['tools', 'systemPrompt']

interface AgentsState { enabled?: boolean; prompt?: string }
interface BridgeReply { ok?: boolean; output?: string }

const STATE_TIMEOUT_MS = 4_000
const STATE_TTL_MS = 3_000

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

const firstLine = (text: unknown): string => String(text ?? '').split('\n')[0]?.trim().slice(0, 80) ?? ''

/**
 * Register the prompt and the three tools when the host's bridge is present.
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

  const states = new Map<string, { at: number; value: Promise<AgentsState> }>()
  const stateOf = (chatId: string): Promise<AgentsState> => {
    const cached = states.get(chatId)
    if (cached !== undefined && Date.now() - cached.at < STATE_TTL_MS) return cached.value
    const value = (async (): Promise<AgentsState> => {
      try {
        const response = await post('/agents', { chatId }, AbortSignal.timeout(STATE_TIMEOUT_MS))
        if (!response.ok) return {}
        return await response.json() as AgentsState
      } catch {
        return {}
      }
    })()
    states.set(chatId, { at: Date.now(), value })
    for (const [key, entry] of states) if (Date.now() - entry.at > STATE_TTL_MS * 10) states.delete(key)
    return value
  }
  const enabled = async ({ agent }: { agent: { session: { id?: unknown } } }): Promise<boolean> => (await stateOf(String(agent.session.id ?? ''))).enabled === true

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.agent === undefined) return assembly
    const state = await stateOf(String(context.agent.session.id ?? ''))
    const text = state.enabled === true && typeof state.prompt === 'string' ? state.prompt.trim() : ''
    if (text.length === 0) return assembly
    return { ...assembly, sections: [...assembly.sections, { name, text, interpolate: false }] }
  })

  const bridgeTool = (tool: 'start_agents' | 'message_agent' | 'stop_agent') => async (args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: { session: { id?: unknown } } }) => {
    const chatId = String(exec.agent?.session.id ?? '')
    try {
      const response = await post(`/agents/${tool}`, { chatId, args }, exec.signal)
      const reply = await response.json() as BridgeReply
      return { ok: reply.ok === true, report: reply.output ?? `${tool} returned nothing.` }
    } catch (error) {
      if (exec.signal.aborted) throw error
      return { ok: false, report: `Could not reach Codeply for ${tool}. Is it still open? Do this part yourself; do not retry.` }
    } finally {
      states.delete(chatId) // the new agents are in the prompt from the next step
    }
  }

  ctx.tools.register(defineTool({
    name: 'start_agents',
    description: 'Start Codeply background agents on a job and carry on without waiting: one agent, or a swarm of 2 to 6 on one goal that share a team channel. Each has a name and works in this project folder. Their report arrives in this chat later as an automatic message.',
    parameters: {
      task: { type: 'string', required: true, description: 'The goal, with everything they need: who it is for, the stack, the files, and what "done" means.' },
      agents: {
        type: 'array',
        description: 'Optional, for a swarm: one entry per agent, each with its part. No two on the same file; one agent owns the file that combines them. Leave out for a single agent.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            part: { type: 'string', required: true, description: 'What this agent does.' },
            name: { type: 'string', description: 'Optional name; by default each gets one of its own.' },
            files: { type: 'array', items: { type: 'string' }, description: 'Files that are this agent\'s.' },
          },
        },
      },
      count: { type: 'integer', description: 'Optional: how many agents when you give no parts (they split the goal themselves).' },
      browser: { type: 'boolean', description: 'Optional: true to give each agent its own tab in Codeply\'s browser, for trying a site, testing flows or research.' },
    },
    output: OUTPUT,
    timeoutMs: 60_000,
    execute: bridgeTool('start_agents'),
    presentCall: args => ({ card: 'generic', title: `Background agents: ${firstLine(args.task)}`, kind: 'other', rawInput: args }),
  }), { when: enabled })

  ctx.tools.register(defineTool({
    name: 'message_agent',
    description: 'Send one of this chat\'s background agents a message by its name: it gets it while it works (to redirect or interrupt it), or starts another round on it when it is done.',
    parameters: {
      agent: { type: 'string', required: true, description: 'Its name.' },
      text: { type: 'string', required: true, description: 'Exactly what it should do differently, or what to do next.' },
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    execute: bridgeTool('message_agent'),
    presentCall: args => ({ card: 'generic', title: `Message to ${firstLine(args.agent)}`, kind: 'other', rawInput: args }),
  }), { when: enabled })

  ctx.tools.register(defineTool({
    name: 'stop_agent',
    description: 'Stop one of this chat\'s background agents by its name.',
    parameters: {
      agent: { type: 'string', required: true, description: 'Its name.' },
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    execute: bridgeTool('stop_agent'),
    presentCall: args => ({ card: 'generic', title: `Stop ${firstLine(args.agent)}`, kind: 'other', rawInput: args }),
  }), { when: enabled })
}
