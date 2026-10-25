/**
 * Haze 2, Codeply's hosted model, as a harness model adapter.
 *
 * Craft starts this engine with a loopback bridge (`CODEPLY_HAZE_BRIDGE_URL`)
 * and a per-launch secret (`CODEPLY_HAZE_BRIDGE_TOKEN`). The bridge runs in
 * Craft's own process, which already owns the person's sign-in, token refresh,
 * device id, Haze routing state and the fallbacks when the router is down, so
 * none of that is duplicated here and no account token ever reaches the engine.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { attributionHeaders, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { replyChunks, turnOf, wireRequest, wireTools } from './wire.ts'
import type { WireReply } from './wire.ts'

export { replyChunks, turnOf, wireRequest, wireTools } from './wire.ts'
export const name = 'llm-haze'
export const inject = ['llm']

/** The provider route and its single model: the router picks the real model per turn. */
export const PROVIDER = 'haze'
export const MODEL = 'haze-2'
/** The person's own models (Classic's Add a model), run by Craft with their own keys. */
export const OWN_PROVIDER = 'own'

export interface Config {
  /** Environment variable holding the bridge URL. */
  bridgeUrlEnv: string
  /** Environment variable holding the per-launch bridge secret. */
  bridgeTokenEnv: string
  /** Context window the route advertises; the smallest model Haze may route to. */
  contextWindow: number
  /** Give up on one bridge call after this long (long Claude turns stream keep-alives to Craft). */
  timeoutMs: number
}
export const Config: z<Config> = z.object({
  bridgeUrlEnv: z.string().default('CODEPLY_HAZE_BRIDGE_URL'),
  bridgeTokenEnv: z.string().default('CODEPLY_HAZE_BRIDGE_TOKEN'),
  contextWindow: z.natural().default(128_000),
  timeoutMs: z.natural().default(7 * 60_000),
})

/** What the bridge answers: Craft's `ai.chat()` result, as JSON. */
interface BridgeResponse {
  success?: boolean
  data?: WireReply
  modelUsed?: string
  error?: string
  limited?: boolean
  resetsAt?: string | null
  unreachable?: boolean
}

const INFO: LlmModelInfo = {
  provider: PROVIDER,
  id: MODEL,
  name: 'Haze 2',
  description: 'Codeply picks the model for each turn',
  inputModalities: ['text'],
}

/** One of the person's own models as Craft lists it (never with its key). */
interface OwnModel { id: string; name: string; model: string; kind: string }

class HazeAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context, private readonly config: Config) { super() }

  override providerInfo(provider: string) {
    return { id: provider, name: provider === OWN_PROVIDER ? 'Your models' : 'Haze 2' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (provider !== OWN_PROVIDER) return [INFO]
    return (await this.ownModels()).map(m => this.ownInfo(m))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider === OWN_PROVIDER) {
      const own = (await this.ownModels()).find(m => m.id === model)
      if (own === undefined) throw new LlmError(`"${model}" is no longer one of your models in Craft`, 'UNKNOWN_MODEL')
      return { ...this.ownInfo(own), context: { contextWindow: this.config.contextWindow } }
    }
    if (model !== MODEL) throw new LlmError(`Haze 2 has no model "${model}"`, 'UNKNOWN_MODEL')
    return { ...INFO, provider, context: { contextWindow: this.config.contextWindow } }
  }

  private ownInfo(m: OwnModel): LlmModelInfo {
    return { provider: OWN_PROVIDER, id: m.id, name: m.name || m.model, description: m.model, inputModalities: ['text'] }
  }

  /** The bridge's address and secret, when Craft started this engine. */
  private bridge(): { url: string; token: string } | undefined {
    const env = launchEnvironmentOf(this.ctx)
    const url = env.get(this.config.bridgeUrlEnv)?.value
    const token = env.get(this.config.bridgeTokenEnv)?.value
    return url === undefined || url.length === 0 || token === undefined || token.length === 0 ? undefined : { url, token }
  }

  /** Your models from Craft, read fresh each time (a local call), so an added model shows at once. */
  private async ownModels(): Promise<OwnModel[]> {
    const bridge = this.bridge()
    if (bridge === undefined) return []
    try {
      const response = await fetch(new URL('/models', bridge.url), {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${bridge.token}` },
      })
      if (!response.ok) return []
      const body = await response.json() as { models?: OwnModel[] }
      return Array.isArray(body.models) ? body.models.filter(m => typeof m.id === 'string' && m.id.length > 0) : []
    } catch {
      return []
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined && options.stop.length > 0) throw new LlmError('Haze 2 does not take stop sequences', 'UNSUPPORTED_OPTION')
    const bridge = this.bridge()
    if (bridge === undefined) {
      throw new LlmError('Haze 2 is only available when Craft starts this engine. Open it from Craft, or pick another model.', 'MISSING_CREDENTIAL')
    }
    const { url, token } = bridge
    const own = options.provider === OWN_PROVIDER
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const tools = wireTools(options.tools)
    const request = wireRequest(options)
    let response: Response
    let body: BridgeResponse
    try {
      response = await fetch(url, {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: { ...attributionHeaders(), 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messages: request.messages,
          ...tools === undefined ? {} : { tools },
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          chatId: options.sessionId ?? '',
          ...own ? { modelId: options.model } : {},
          purpose: options.purpose,
          haze: turnOf(options.messages, request.historyCount),
        }),
      })
      body = await response.json() as BridgeResponse
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('Haze 2 request aborted', 'ABORTED', { cause: error })
      if (timeout.aborted) throw new LlmError('Haze 2 took too long to answer', 'TIMEOUT', { cause: error })
      throw new LlmError('Could not reach Craft for Haze 2. Is Craft still open?', 'TRANSPORT', { cause: error })
    }
    if (response.status === 401) throw new LlmError('Craft refused this engine\'s Haze 2 request. Restart the engine from Craft.', 'AUTH', { status: 401 })
    if (body.success !== true) {
      const message = body.error ?? `Haze 2 failed (${response.status})`
      if (body.limited === true) throw new LlmError(message, QUOTA_EXCEEDED_CODE)
      if (/not signed in/i.test(message)) throw new LlmError('Sign in to Craft to use Haze 2, or pick another model.', 'AUTH')
      throw new LlmError(message, body.unreachable === true ? 'TRANSPORT' : 'SERVER')
    }
    yield * replyChunks(body.data ?? {})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter([PROVIDER, OWN_PROVIDER], new HazeAdapter(ctx, config))
}
