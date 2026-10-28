/**
 * Shared HTTP bits for model providers: JSON POST with retries on 429/5xx
 * and a Server-Sent Events reader.
 */

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

export class ProviderError extends Error {
  constructor(message, { status, body, retryable } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryable = !!retryable;
  }
}

/** POST json, retrying transient failures. Returns the fetch Response (ok). */
export async function postJson(url, headers, body, { signal, retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt++ >= retries) throw new ProviderError(`Network error calling ${new URL(url).host}: ${e.message}`, { retryable: true });
      await sleep(500 * 2 ** attempt, signal);
      continue;
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt++ < retries) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt, signal);
      continue;
    }
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || text; } catch { /* plain text */ }
    throw new ProviderError(`${res.status} ${res.statusText}: ${String(msg).slice(0, 500)}`, { status: res.status, body: text, retryable });
  }
}

/** Yield { event, data } for each SSE message in a fetch Response body. */
export async function* sse(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}
