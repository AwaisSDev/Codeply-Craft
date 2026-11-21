/**
 * Codeply add-on: the user's connected Apps in DSH chats, the same way
 * Classic chats have them (codeply-cli/lib/apps.js, lib/mcp.js and the mcp
 * tool in lib/tools.mjs):
 *
 *   - the APPS AND MCP SERVERS section (each connected app and its tools) is
 *     added to the system prompt of every step
 *   - `use_app` calls one tool of one app; Craft asks the user first for any
 *     tool that is not marked read-only, with its own approval card
 *
 * Apps are remote MCP servers the user connected in Codeply's Apps window,
 * with their sign-in kept by Craft. This add-on only talks to Craft's
 * loopback bridge (`CODEPLY_HAZE_BRIDGE_URL` and its per-launch secret):
 * `POST /apps` for the prompt, `POST /apps/call` for a call. Craft is asked
 * again every few seconds, so an app connected while the engine runs is
 * there on the next step. With no app connected, or without the bridge (the
 * plain terminal app), nothing is added and `use_app` is not offered.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

export const name = 'codeply-apps'
export const inject = ['tools', 'systemPrompt']

/** What Craft says about the connected apps for one chat. */
interface AppsState { prompt?: string; apps?: number }

interface BridgeReply { ok?: boolean; output?: string }

/** Connecting to an app the first time can take a few seconds. */
const STATE_TIMEOUT_MS = 15_000
/** One answer serves a step's tool list and its prompt, then is asked again. */
const STATE_TTL_MS = 3_000
/** A call can wait on the user's approval, then on the app itself. */
const CALL_TIMEOUT_MS = 15 * 60_000

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

/**
 * Register the prompt and `use_app` when Craft's bridge is present.
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

  const states = new Map<string, { at: number; value: Promise<AppsState> }>()
  const stateOf = (chatId: string): Promise<AppsState> => {
    const cached = states.get(chatId)
    if (cached !== undefined && Date.now() - cached.at < STATE_TTL_MS) return cached.value
    const value = (async (): Promise<AppsState> => {
      try {
        const response = await post('/apps', { chatId, cwd: process.cwd() }, AbortSignal.timeout(STATE_TIMEOUT_MS))
        if (!response.ok) return {}
        return await response.json() as AppsState
      } catch {
        return {} // Craft busy or closed: this step goes on without apps
      }
    })()
    states.set(chatId, { at: Date.now(), value })
    for (const [key, entry] of states) if (Date.now() - entry.at > STATE_TTL_MS * 10) states.delete(key)
    return value
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.agent === undefined) return assembly
    const apps = await stateOf(String(context.agent.session.id ?? ''))
    const text = typeof apps.prompt === 'string' ? apps.prompt.trim() : ''
    if (text.length === 0) return assembly
    return { ...assembly, sections: [...assembly.sections, { name, text, interpolate: false }] }
  })

  ctx.tools.register(defineTool({
    name: 'use_app',
    description: 'Call one tool of one of the user\'s connected apps, listed under APPS AND MCP SERVERS. Reading just runs; anything that changes, sends, posts, pays or deletes asks the user on its own, so call it directly instead of asking in chat first.',
    parameters: {
      app: { type: 'string', required: true, description: 'The app\'s name as listed (the part before the parentheses), like mslearn.' },
      tool: { type: 'string', required: true, description: 'The tool\'s name as listed under that app.' },
      args: { type: 'json', description: 'The tool\'s arguments as a JSON object, like {"query": "x"}. Leave out for a tool with none.' },
    },
    output: OUTPUT,
    timeoutMs: CALL_TIMEOUT_MS,
    async execute(args, exec) {
      const chatId = String(exec.agent?.session.id ?? '')
      try {
        const response = await post('/apps/call', { chatId, cwd: process.cwd(), args }, exec.signal)
        const reply = await response.json() as BridgeReply
        return { ok: reply.ok === true, report: reply.output ?? 'use_app returned nothing.' }
      } catch (error) {
        if (exec.signal.aborted) throw error
        return { ok: false, report: 'Could not reach Codeply for the app. Is it still open? Go on without it; do not retry.' }
      }
    },
    presentCall: args => ({ card: 'generic', title: `${String(args.app ?? '')}: ${String(args.tool ?? '')}`, kind: 'other', rawInput: args }),
  }), { when: async ({ agent }) => ((await stateOf(String(agent.session.id ?? ''))).apps ?? 0) > 0 })
}
