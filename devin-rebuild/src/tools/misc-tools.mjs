/**
 * webfetch and todo_write.
 */

const MAX_FETCH = 100_000;

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${t.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webFetchTool = {
  name: 'webfetch',
  kind: 'network',
  description: 'Fetch a URL over HTTP(S) and return its content as text (HTML is converted to readable text). Use for documentation and API references.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
  target: (input) => input.url,
  async run(input, ctx) {
    let url;
    try { url = new URL(input.url); } catch { return { isError: true, content: `Invalid URL: ${input.url}` }; }
    if (url.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(url.host)) url.protocol = 'https:';
    let res;
    try {
      res = await fetch(url, { signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), headers: { 'user-agent': 'dvn-cli/0.1 (+webfetch)' } });
    } catch (e) { return { isError: true, content: `Fetch failed: ${e.message}` }; }
    const type = res.headers.get('content-type') || '';
    let text = await res.text();
    if (/html/i.test(type) || /^\s*<!doctype html|^\s*<html/i.test(text)) text = htmlToText(text);
    if (text.length > MAX_FETCH) text = text.slice(0, MAX_FETCH) + `\n… [truncated ${text.length - MAX_FETCH} characters]`;
    return { isError: !res.ok, content: `${res.status} ${res.statusText} ${url.href}\n\n${text}` };
  },
};

export const todoTool = {
  name: 'todo_write',
  kind: 'meta',
  description: 'Keep a visible task list for multi-step work. Send the whole list each time. Exactly one item should be in_progress while you work; mark items completed as soon as they are done.',
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  target: () => null,
  async run(input, ctx) {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    if (ctx.session) ctx.session.todos = todos;
    ctx.ui?.todos?.(todos);
    const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
    return { content: todos.length ? todos.map((t) => `${mark[t.status] || '[ ]'} ${t.content}`).join('\n') : 'Todo list cleared.' };
  },
};
