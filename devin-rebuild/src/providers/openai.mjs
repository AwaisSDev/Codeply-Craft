/**
 * Any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter,
 * Ollama, vLLM, LM Studio...), streamed. Converts to and from the internal
 * Anthropic-style content blocks.
 */
import { postJson, sse } from './http.mjs';

export function openaiProvider({ apiKey, baseUrl = 'https://api.openai.com/v1', headers = {} }) {
  return {
    kind: 'openai',
    async complete({ model, system, messages, tools, maxTokens = 16000, signal, onText }) {
      const body = {
        model,
        messages: toOpenAI(system, messages),
        tools: tools?.length ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) : undefined,
        max_completion_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      };
      const res = await postJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...headers,
      }, body, { signal });

      let text = '';
      const calls = [];
      let finish = null;
      const usage = { input_tokens: 0, output_tokens: 0 };
      for await (const { data } of sse(res)) {
        if (data === '[DONE]') break;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.usage) {
          usage.input_tokens = ev.usage.prompt_tokens ?? usage.input_tokens;
          usage.output_tokens = ev.usage.completion_tokens ?? usage.output_tokens;
          if (ev.usage.prompt_tokens_details?.cached_tokens) usage.cache_read_input_tokens = ev.usage.prompt_tokens_details.cached_tokens;
        }
        const choice = ev.choices?.[0];
        if (!choice) continue;
        const d = choice.delta || {};
        if (d.content) { text += d.content; onText?.(d.content); }
        for (const tc of d.tool_calls || []) {
          const slot = calls[tc.index ?? calls.length] ||= { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const content = [];
      if (text) content.push({ type: 'text', text });
      calls.filter(Boolean).forEach((c, i) => {
        let input = {};
        try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { _raw: c.args }; }
        content.push({ type: 'tool_use', id: c.id || `call_${i}`, name: c.name, input });
      });
      const stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
      return { content, stopReason, usage };
    },
  };
}

function blockText(c) {
  if (typeof c === 'string') return c;
  return (c || []).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('');
}

export function toOpenAI(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const results = m.content.filter((b) => b.type === 'tool_result');
    for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: blockText(r.content) });
    const rest = m.content.filter((b) => b.type !== 'tool_result');
    if (!rest.length) continue;
    const parts = rest.map((b) => (b.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
      : { type: 'text', text: b.text ?? '' }));
    out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts });
  }
  return out;
}
