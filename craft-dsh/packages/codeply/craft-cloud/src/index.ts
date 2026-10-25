/**
 * Codeply add-on: Craft Cloud as a model. Pick "Craft Cloud" in the model
 * picker and each message runs as a Craft Cloud task (a GitHub Actions runner
 * on the project's repo or its private mirror), the same runs Classic's Cloud
 * chip starts. The turn stays an ordinary turn: the person's message is
 * logged, the runner's progress streams in as the thinking text, and the
 * cloud's final answer is the reply. `/cloud apply` brings a finished task's
 * changes into the folder (Classic's Apply), `/cloud cancel` stops one.
 *
 * Craft owns GitHub and the cloud state: this talks to Craft's loopback bridge
 * (`/cloud/*` beside `/haze`), which calls Classic's cloud-desktop.js.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'codeply-craft-cloud'
export const inject = ['llm']

export const PROVIDER = 'craft-cloud'
export const MODEL = 'cloud'

export interface Config {
  /** Environment variable holding Craft's bridge URL (its `/haze` endpoint; `/cloud/*` sits beside it). */
  bridgeUrlEnv: string
  bridgeTokenEnv: string
  /** How often to ask for the task's progress. */
  pollMs: number
  /** Give up following a task after this long (it keeps running in the cloud). */
  maxWaitMs: number
}
export const Config: z<Config> = z.object({
  bridgeUrlEnv: z.string().default('CODEPLY_HAZE_BRIDGE_URL'),
  bridgeTokenEnv: z.string().default('CODEPLY_HAZE_BRIDGE_TOKEN'),
  pollMs: z.natural().default(5000),
  maxWaitMs: z.natural().default(3 * 60 * 60_000),
})

/** One cloud task as Craft reports it (cloud-desktop.js taskView). */
interface CloudTask {
  id: string
  status: string
  progress?: string
  error?: string | null
  answer?: string
  kind?: 'repo' | 'mirror'
  branch?: string | null
  base?: string
  merged?: unknown
  files?: unknown[]
  runUrl?: string | null
  steps?: number
}

const INFO: LlmModelInfo = {
  provider: PROVIDER,
  id: MODEL,
  name: 'Craft Cloud',
  description: 'Runs the task on Craft Cloud, so your PC can be off',
  inputModalities: ['text'],
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** The latest message the person typed in this request. */
function promptOf(messages: readonly RequestMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    if ('source' in m && m.source !== undefined && m.source.kind !== 'user') continue
    return m.content.map(b => (b.type === 'text' ? b.text : '')).join('\n').trim()
  }
  return ''
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

/** Where the task's changes are, and what to do about them. */
function changesNote(task: CloudTask): string {
  const files = Array.isArray(task.files) ? task.files.length : 0
  if (files === 0) return ''
  const what = `${files} file${files === 1 ? '' : 's'} changed`
  if (task.kind === 'repo') {
    return task.merged ? `${what}, merged into ${task.base ?? 'the base branch'} on GitHub. Type /cloud apply to pull them here.`
      : `${what} on branch ${task.branch ?? 'the task branch'}. Type /cloud apply to bring them here.`
  }
  return `${what} in Craft Cloud's copy of this project. Type /cloud apply to bring them into this folder.`
}

export function apply(ctx: Context, config: Config): void {
  /** Session id -> the folder and task of its latest cloud run, for /cloud. */
  const latest = new Map<string, { cwd: string; taskId: string }>()

  const bridge = async (action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const env = launchEnvironmentOf(ctx)
    const haze = env.get(config.bridgeUrlEnv)?.value
    const token = env.get(config.bridgeTokenEnv)?.value
    if (haze === undefined || token === undefined || haze.length === 0) {
      throw new LlmError('Craft Cloud is only available when Craft starts this engine.', 'MISSING_CREDENTIAL')
    }
    const res = await fetch(haze.replace(/\/haze$/, `/cloud/${action}`), {
      method: 'POST',
      ...signal === undefined ? {} : { signal },
      headers: { ...attributionHeaders(), 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    return await res.json() as Record<string, unknown>
  }

  const folderOf = async (sessionId: string | undefined, signal?: AbortSignal): Promise<string> => {
    const agent = sessionId === undefined ? undefined : ctx.get('agents')?.get(sessionId as never)
    const cwd = agent === undefined ? undefined : await ctx.get('workingDirectory')?.ensure(agent, signal)
    if (cwd === undefined) throw new LlmError('Craft Cloud needs a project folder for this chat.', 'INVALID_REQUEST')
    return cwd
  }

  class CraftCloudAdapter extends LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: 'Craft Cloud' } }
    override listModels(): Promise<readonly LlmModelInfo[]> { return Promise.resolve([INFO]) }
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      if (model !== MODEL) return Promise.reject(new LlmError(`Craft Cloud has no model "${model}"`, 'UNKNOWN_MODEL'))
      return Promise.resolve({ ...INFO, provider, context: { contextWindow: 200_000 } })
    }

    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const prompt = promptOf(options.messages)
      // Housekeeping calls (titles, compaction) never start a cloud run.
      if (options.purpose !== undefined) {
        const text = options.purpose === 'session-title' ? (prompt.split(/\s+/).slice(0, 6).join(' ') || 'Craft Cloud task') : 'Earlier work ran on Craft Cloud.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (prompt.length === 0) throw new LlmError('Nothing to send to Craft Cloud.', 'INVALID_REQUEST')
      const cwd = await folderOf(options.sessionId, options.signal)
      const started = await bridge('start', { cwd, prompt, sessionId: options.sessionId ?? '' }, options.signal)
      if (typeof started.error === 'string') throw new LlmError(started.error, 'INVALID_REQUEST')
      let task = started.task as CloudTask
      latest.set(options.sessionId ?? '', { cwd, taskId: task.id })

      let thinking = ''
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      const say = function * (line: string): Generator<StreamChunk> {
        const text = `${thinking.length > 0 ? '\n' : ''}${line}`
        thinking += text
        yield { type: 'reasoning-delta', index: 0, text }
      }
      yield * say(`Running on Craft Cloud${task.kind === 'repo' ? ' in the project repo' : ''}. Your PC can be off.`)
      const t0 = Date.now()
      let lastLine = ''
      let lastNote = Date.now()
      try {
        while (!TERMINAL.has(task.status)) {
          if (Date.now() - t0 > config.maxWaitMs) {
            throw new LlmError('Stopped following the Craft Cloud task here; it keeps running in the cloud. Type /cloud status later.', 'TIMEOUT')
          }
          await sleep(config.pollMs, options.signal)
          const status = await bridge('status', { cwd, taskId: task.id }, options.signal)
          if (status.task !== undefined) task = status.task as CloudTask
          const line = task.status === 'queued' ? 'Waiting for a cloud runner...'
            : task.status === 'starting' ? 'Starting the cloud runner...'
            : task.progress !== undefined && task.progress.length > 0 ? task.progress : ''
          if (line.length > 0 && line !== lastLine) {
            lastLine = line
            lastNote = Date.now()
            yield * say(line)
          } else if (Date.now() - lastNote > 60_000) {
            lastNote = Date.now()
            yield * say(`Still working (${Math.round((Date.now() - t0) / 60_000)} min)...`)
          }
        }
      } catch (error) {
        if (options.signal?.aborted === true) {
          // Stop in the new Craft stops the cloud run too.
          void bridge('cancel', { cwd, taskId: task.id }).catch(() => {})
          throw new LlmError('Craft Cloud task stopped.', 'ABORTED', { cause: error })
        }
        throw error
      }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } }
      if (task.status !== 'done') {
        throw new LlmError(task.error ?? (task.status === 'cancelled' ? 'The Craft Cloud task was cancelled.' : 'The Craft Cloud task failed.'), 'SERVER')
      }
      const note = changesNote(task)
      const text = [task.answer && task.answer.trim().length > 0 ? task.answer.trim() : 'Done on Craft Cloud.', note].filter(Boolean).join('\n\n')
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text }
      yield { type: 'block-end', index: 1, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  ctx.llm.registerAdapter([PROVIDER], new CraftCloudAdapter())

  const command = async ({ agent, rawInput }: CommandInvocation): Promise<CommandResult> => {
    const action = rawInput.trim().toLowerCase()
    const last = latest.get(agent.session.id)
    if (action === '' || action === 'help') {
      return { kind: 'success', text: 'Pick Craft Cloud in the model picker to run messages on Craft Cloud. /cloud apply brings the latest task\'s changes here, /cloud status shows where it is, /cloud cancel stops it.' }
    }
    if (last === undefined) return { kind: 'error', text: 'No Craft Cloud task in this chat yet.' }
    try {
      if (action === 'apply') {
        const r = await bridge('apply', last)
        if (typeof r.error === 'string') return { kind: 'error', text: r.error }
        return { kind: 'success', text: r.applied === false ? 'Nothing new to apply.' : 'Craft Cloud\'s changes are in this folder now.' }
      }
      if (action === 'status') {
        const r = await bridge('status', last)
        const task = r.task as CloudTask | undefined
        return task === undefined ? { kind: 'error', text: String(r.error ?? 'Could not reach Craft Cloud.') }
          : { kind: 'success', text: `Craft Cloud task: ${task.status}${task.progress ? `, ${task.progress}` : ''}${task.runUrl ? ` (${task.runUrl})` : ''}` }
      }
      if (action === 'cancel') {
        const r = await bridge('cancel', last)
        return typeof r.error === 'string' ? { kind: 'error', text: r.error } : { kind: 'success', text: 'Craft Cloud task cancelled.' }
      }
    } catch (e) {
      return { kind: 'error', text: e instanceof Error ? e.message : String(e) }
    }
    return { kind: 'error', text: 'Usage: /cloud [apply|status|cancel]' }
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(function* () {
      yield commandCtx.commands.register({
        definitionId: CommandDefinitionId('@codeply/dsh-craft-cloud'),
        name: 'cloud',
        description: 'Craft Cloud: apply, status or cancel the latest task',
        handler: command,
      })
    }, 'codeply-craft-cloud command')
  })
}
