/**
 * Translation between the harness message log and the Haze 2 bridge wire.
 *
 * The bridge speaks OpenAI chat-completions shapes: Craft's Haze router takes
 * OpenAI messages plus `tools` and answers one complete `choices[0].message`.
 */
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'

/** One OpenAI-shaped tool call. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One OpenAI-shaped chat message. */
export type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** One OpenAI-shaped function declaration. */
export interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** Per-turn routing facts: Haze decides the model once per user turn. */
export interface HazeTurn {
  /** Stable across every step of one user turn. */
  turnId: string
  /** Assistant replies already made in this turn. */
  step: number
  /** Messages before this turn. */
  historyCount: number
}

/**
 * Model-visible text of content blocks. Images and files reach Haze as text:
 * the route declares text-only input, so the runtime normally projects them
 * first; this is the fallback for anything that slips through.
 * @param content - blocks of one message.
 * @returns joined text.
 */
function textOf(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[image: ${block.attachment.name ?? 'attached image'}]`)
    else if (block.type === 'file') parts.push(`[file: ${block.attachment.name}]`)
  }
  return parts.join('\n')
}

/**
 * Whether a message is something the person typed, as opposed to a notice,
 * hint or steering note a plugin added on the user side. Only these start a
 * Haze turn: a note in the middle of a turn must not re-route it or move the
 * history cache breakpoint.
 */
function isPersonInput(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  return !('source' in message) || message.source === undefined || message.source.kind === 'user'
}

/** A serialized request plus where this turn starts in it. */
export interface WireRequest {
  messages: WireMessage[]
  /**
   * Non-system wire messages before the one carrying this turn's own input:
   * Haze puts its history cache breakpoint on the message just before it, the
   * same count Classic Craft sends.
   */
  historyCount: number
}

/**
 * Serialize one request for the bridge.
 * @param options - the harness request.
 * @returns OpenAI-shaped messages (developer context folds into the user side) and the turn's start.
 */
export function wireRequest(options: GenerateOptions): WireRequest {
  const out: WireMessage[] = []
  let anchor = -1
  const system = [options.system ?? '']
  const pushUser = (text: string) => {
    if (text.length === 0) return
    const last = out[out.length - 1]
    // Consecutive user text (a developer notice beside the person's message) is one message on the wire.
    if (last !== undefined && last.role === 'user') last.content = `${last.content}\n\n${text}`
    else out.push({ role: 'user', content: text })
  }
  for (const message of options.messages as readonly RequestMessage[]) {
    switch (message.role) {
      case 'system':
        system.push(textOf(message.content))
        break
      case 'developer':
        pushUser(textOf(message.content))
        break
      case 'user':
        pushUser(textOf(message.content))
        if (isPersonInput(message)) anchor = out.length - 1
        break
      case 'assistant': {
        const calls: WireToolCall[] = []
        const text: string[] = []
        for (const block of message.content) {
          if (block.type === 'text') text.push(block.text)
          else if (block.type === 'tool-call') calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments || '{}' } })
        }
        out.push({ role: 'assistant', content: text.join(''), ...calls.length > 0 ? { tool_calls: calls } : {} })
        break
      }
      case 'tool':
        out.push({ role: 'tool', tool_call_id: message.toolCallId, content: textOf(message.content) || '(no output)' })
        break
    }
  }
  const prompt = system.filter(part => part.trim().length > 0).join('\n\n')
  return {
    messages: prompt.length > 0 ? [{ role: 'system', content: prompt }, ...out] : out,
    historyCount: Math.max(0, anchor),
  }
}

/**
 * Serialize tool declarations.
 * @param tools - step-admitted tool schemas.
 * @returns OpenAI function declarations, or undefined when there are none.
 */
export function wireTools(tools: readonly ToolSchema[] | undefined): WireTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
}

/**
 * Where this request sits in its user turn. The turn is keyed by the latest
 * user message, so every step of one turn shares one routing decision.
 * @param messages - the request history.
 * @returns routing facts for the bridge.
 */
export function turnOf(messages: readonly RequestMessage[], historyCount: number): HazeTurn {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPersonInput(messages[i]!)) { lastUser = i; break }
  }
  const anchor = lastUser >= 0 ? messages[lastUser]! : undefined
  const turnId = anchor !== undefined && 'id' in anchor && typeof anchor.id === 'string' ? anchor.id : `turn-${lastUser}`
  const step = lastUser < 0 ? 0 : messages.slice(lastUser + 1).filter(m => m.role === 'assistant').length
  return { turnId, step, historyCount }
}

/** The reply part of the bridge response. */
export interface WireReply {
  choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[]
  /** `prompt_tokens` includes cached input; Haze reports the cached part as `cache_read_tokens` / `cache_write_tokens`. */
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cache_read_tokens?: unknown; cache_write_tokens?: unknown }
}

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * Replay one complete reply as harness stream chunks: reasoning, text, then
 * tool calls in order, usage before finish, nothing after finish.
 * @param reply - the bridge's chat-completions body.
 * @returns the chunk sequence.
 */
export function * replyChunks(reply: WireReply): Generator<StreamChunk> {
  const choice = reply.choices?.[0]
  const message = choice?.message
  if (message === undefined) throw new LlmError('Haze 2 returned no message', 'EMPTY_RESPONSE')
  let index = 0
  // Haze's lighter models put their thinking in `reasoning`, the rest in `reasoning_content`.
  const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0
    ? message.reasoning_content
    : typeof message.reasoning === 'string' ? message.reasoning : ''
  if (reasoning.length > 0) {
    yield { type: 'block-start', index, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index, text: reasoning }
    yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } }
    index++
  }
  const text = typeof message.content === 'string' ? message.content : ''
  if (text.length > 0) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'text', text } }
    index++
  }
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Partial<WireToolCall>[] : []
  for (const call of calls) {
    if (typeof call?.function?.name !== 'string') throw new LlmError('Haze 2 returned a tool call with no name', 'MALFORMED_RESPONSE')
  }
  for (const [i, call] of calls.entries()) {
    const id = ToolCallId(typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_haze_${Date.now().toString(36)}_${i}`)
    const name = call.function!.name
    const raw = call.function!.arguments
    // Arguments stay raw JSON strings end to end; a parsed object is re-stringified.
    const args = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
    index++
  }
  if (index === 0) throw new LlmError('Haze 2 returned an empty reply', 'EMPTY_RESPONSE')
  const prompt = count(reply.usage?.prompt_tokens)
  const output = count(reply.usage?.completion_tokens)
  if (prompt !== undefined && output !== undefined) {
    const total = count(reply.usage?.total_tokens)
    const read = count(reply.usage?.cache_read_tokens) ?? 0
    const write = count(reply.usage?.cache_write_tokens) ?? 0
    // Harness counts are disjoint: uncached input alone, cache reads and writes beside it.
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.max(0, prompt - read - write),
        outputTokens: output,
        ...read > 0 ? { cacheReadTokens: read } : {},
        ...write > 0 ? { cacheWriteTokens: write } : {},
        ...total === undefined ? {} : { totalTokens: total },
      },
    }
  }
  const finish = choice?.finish_reason
  yield {
    type: 'finish',
    reason: calls.length > 0 ? { kind: 'tool-calls' } : finish === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' },
  }
}
