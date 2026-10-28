/**
 * Anthropic Messages API, streamed. Messages are already in the internal
 * format (Anthropic content blocks), so this is mostly transport.
 */
import { postJson, sse, ProviderError } from './http.mjs';

export function anthropicProvider({ apiKey, baseUrl = 'https://api.anthropic.com', headers = {} }) {
  return {
    kind: 'anthropic',
    async complete({ model, system, messages, tools, maxTokens = 16000, thinking, signal, onText, onThinking }) {
      const body = {
        model,
        max_tokens: maxTokens,
        system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
        messages: withCacheBreakpoint(messages),
        tools: tools?.length ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) : undefined,
        stream: true,
      };
      if (thinking) body.thinking = { type: 'enabled', budget_tokens: Math.min(thinking, maxTokens - 1000) };
      const res = await postJson(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...headers,
      }, body, { signal });

      const blocks = [];
      let stopReason = null;
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      for await (const { data } of sse(res)) {
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        switch (ev.type) {
          case 'message_start':
            Object.assign(usage, pickUsage(ev.message?.usage));
            break;
          case 'content_block_start': {
            const b = { ...ev.content_block };
            if (b.type === 'tool_use') { b.input = {}; b._json = ''; }
            if (b.type === 'text') b.text = '';
            if (b.type === 'thinking') b.thinking = '';
            blocks[ev.index] = b;
            break;
          }
          case 'content_block_delta': {
            const b = blocks[ev.index];
            const d = ev.delta;
            if (d.type === 'text_delta') { b.text += d.text; onText?.(d.text); }
            else if (d.type === 'input_json_delta') b._json += d.partial_json;
            else if (d.type === 'thinking_delta') { b.thinking += d.thinking; onThinking?.(d.thinking); }
            else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
            break;
          }
          case 'content_block_stop': {
            const b = blocks[ev.index];
            if (b?.type === 'tool_use') {
              try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = { _raw: b._json }; }
              delete b._json;
            }
            break;
          }
          case 'message_delta':
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage) Object.assign(usage, pickUsage(ev.usage));
            break;
          case 'error':
            throw new ProviderError(ev.error?.message || 'stream error', { retryable: ev.error?.type === 'overloaded_error' });
          default:
        }
      }
      return { content: blocks.filter(Boolean), stopReason: normalizeStop(stopReason), usage };
    },
  };
}

function pickUsage(u = {}) {
  const out = {};
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) if (typeof u[k] === 'number') out[k] = u[k];
  return out;
}

function normalizeStop(s) {
  if (s === 'tool_use') return 'tool_use';
  if (s === 'max_tokens') return 'max_tokens';
  if (s === 'refusal') return 'refusal';
  return 'end_turn';
}

/** Mark the last user turn cacheable so long sessions reuse the prefix. */
function withCacheBreakpoint(messages) {
  const out = messages.map((m) => ({ role: m.role, content: m.content }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user' || !Array.isArray(out[i].content) || !out[i].content.length) continue;
    const content = out[i].content.slice();
    const last = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
    content[content.length - 1] = last;
    out[i] = { ...out[i], content };
    break;
  }
  return out;
}
