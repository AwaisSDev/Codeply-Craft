/**
 * Codeply CLI - AI client
 *
 * Backends, selected by lib/config.js:
 *
 *   codeply     the 'ai-proxy' Supabase Edge Function the desktop app uses
 *               (see Codeply-App/supabase/functions/ai-proxy). No provider
 *               key lives in this CLI; it authenticates with the signed-in
 *               session from lib/auth.js, so usage counts against that
 *               account's shared daily cap.
 *
 *   ollama      Ollama's OpenAI-compatible /v1/chat/completions, either the
 *               cloud (ollama.com, bearer key) or a local daemon (no key).
 *               No Codeply sign-in required, and no daily cap.
 *
 *   openrouter, groq, openai, google, qwen   BYOK: the user's own key against
 *               that provider's OpenAI-compatible chat completions endpoint.
 *               No Codeply account involved at all. OpenRouter is itself an
 *               aggregator, so its model ids carry the upstream namespace
 *               ('google/gemma-4-26b-a4b-it:free', 'stealth/ox-alpha') - that
 *               is also how Codeply reaches models no first-party API serves.
 *
 *   anthropic   BYOK against Anthropic's Messages API, which is NOT
 *               OpenAI-compatible (different endpoint, a top-level `system`
 *               field instead of a system message, and a `content` array in
 *               the response) - handled by its own converter below.
 *
 * All of these return the identical shape - {success, data:{choices:[{message}]}, …} -
 * so nothing downstream (agent loop, edit engine) knows or cares which ran.
 */
const { SUPABASE_URL, SUPABASE_ANON_KEY, getAccessToken } = require('./auth');
const { getConfig, byokHint, PROVIDERS } = require('./config');

const AI_PROXY_URL = `${SUPABASE_URL}/functions/v1/ai-proxy`;

function isRateLimitError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('rate limit') || s.includes('429') || s.includes('tokens per day')
    || s.includes('tokens per minute') || s.includes(' tpd') || s.includes(' tpm')
    || s.includes('quota') || s.includes('daily ai request limit');
}

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1200, 4000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Statuses worth retrying. 546 is Supabase's own code for an Edge Function
 * killed for exceeding its resource limits (WORKER_LIMIT) - it fires on long
 * generations and is usually transient, so a retry is far more useful to the
 * user than surfacing "HTTP 546". 5xx and 429 get the same treatment.
 */
function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

/** Turn a bare status into something a user can act on. */
function describeStatus(status) {
  if (status === 546) {
    return 'The AI service hit its resource limit mid-request (Supabase 546). ' +
      'This usually happens on very long generations - try a narrower request, ' +
      'or ask for a targeted edit instead of a full-file rewrite.';
  }
  if (status === 504 || status === 408) return 'The AI service timed out. Try a smaller request.';
  if (status === 429) return 'Rate limited by the AI service. Wait a moment and try again.';
  if (status >= 500) return `The AI service is temporarily unavailable (HTTP ${status}).`;
  return `HTTP ${status}`;
}

/**
 * Retry wrapper shared by both backends.
 * `send` returns { done, value } to stop, or { retryable, error } to try again.
 */
async function withRetries(send) {
  let lastError = 'Request failed';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 4000);
    const step = await send();
    if (step.done) return step.value;
    // A user-triggered abort must never be retried - retrying is exactly the
    // "stop didn't stop" bug: it would fire a brand new request right after
    // the one Stop just cancelled.
    if (step.aborted) return { success: false, error: 'aborted', aborted: true };
    lastError = step.error;
    if (!step.retryable) return { success: false, error: lastError };
  }
  return { success: false, error: lastError };
}

/** True when `e` is the AbortError a fetch() throws for an aborted signal. */
function isAbortError(e) {
  return e && (e.name === 'AbortError' || /aborted|abortsignal/i.test(String(e.message || '')));
}

// Every provider call below is wrapped in withRetries, which has no timeout
// of its own - the only AbortSignal ever wired into fetch() was the user's
// own manual Stop button. A connection that stalls (accepted but never
// responds, or a streamed body that stops sending bytes mid-generation)
// previously just hung forever with zero CPU and no visible error - "is it
// thinking or just dead" is exactly what that looks like from the outside.
// This gives every attempt a hard ceiling so a stalled request surfaces as a
// real, retryable error instead of an indefinite silent wait.
const REQUEST_TIMEOUT_MS = 120_000;

/** Combines the caller's own abort signal (Stop button) with a hard timeout into one signal to hand fetch(). */
function withTimeout(signal, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  return {
    signal: controller.signal,
    // Whether THIS particular abort was the timeout firing rather than the
    // user's own Stop - callers use this to report "the request stalled"
    // instead of silently treating a stall as if the user had cancelled it.
    isTimeout: () => controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout',
    cleanup: () => clearTimeout(timer),
  };
}

/**
 * Same idea as withTimeout, but resettable - for a streamed response, a flat
 * ceiling on the whole request would kill a legitimately long generation that
 * just happens to keep actively sending bytes. poke() bumps the clock every
 * time a chunk actually arrives, so this only fires on a genuine stall (no
 * bytes at all for `ms`), never on a slow-but-still-streaming one.
 */
function withIdleTimeout(signal, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  return {
    signal: controller.signal,
    poke: () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('timeout')), ms); },
    isTimeout: () => controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout',
    cleanup: () => clearTimeout(timer),
  };
}

async function chatViaProxy(messages, opts) {
  const token = await getAccessToken();
  if (!token) return { success: false, error: 'Not signed in. Sign in to use Auto, or pick one of your own models.' };

  return withRetries(async () => {
    let res, body;
    const { signal, isTimeout, cleanup } = withTimeout(opts.signal);
    try {
      res = await fetch(AI_PROXY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        // meta is optional, display-only context (what was asked, which file) -
        // the proxy logs it to usage_history so CLI activity shows up in the
        // admin dashboard next to the desktop app, same as this app's own calls.
        body: JSON.stringify({ messages, opts, meta: opts.meta }),
        signal,
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      if (isTimeout()) return { retryable: true, error: 'The request timed out with no response from the AI proxy - retrying.' };
      if (isAbortError(e)) return { aborted: true };
      // Network-level failure - also worth another go.
      return { retryable: true, error: e.message };
    } finally {
      cleanup();
    }

    if (res.ok && body.success) {
      return { done: true, value: { success: true, data: body.data, modelUsed: body.modelUsed } };
    }

    // A structured error from the function itself is final: it means the
    // function ran and deliberately rejected us (auth, daily cap, provider
    // error). Retrying that just burns the user's quota.
    if (body.error) {
      const hitCap = isRateLimitError(body.error) || /daily .* (limit|cap)/i.test(body.error);
      const error = hitCap ? `${body.error} ${byokHint()}` : body.error;
      return { done: true, value: { success: false, error } };
    }

    return { retryable: isTransientStatus(res.status), error: describeStatus(res.status) };
  });
}

/**
 * Failures that are about THIS key rather than about the request - an
 * exhausted daily/hourly quota, a rate limit, a revoked or invalid key, an
 * account with nothing left to spend. When a second key is configured these
 * are worth giving up on immediately: no amount of retrying the same key
 * fixes any of them, and the other account very likely can serve the request
 * right now.
 */
function isKeyLevelFailure(msg, status) {
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  const s = String(msg || '');
  return isRateLimitError(s)
    || /insufficient|billing|payment|credit|exceed|capacity|unauthor|invalid.*key|forbidden|expired|suspend/i.test(s);
}

/**
 * Errors that mean the REQUEST is wrong, not the key - a model name that
 * doesn't exist on the host, say. Switching accounts can't help, so the
 * second key is left alone rather than spending it on the same guaranteed
 * failure (and showing the user the same error twice as long).
 */
function isKeyIndependentFailure(msg) {
  return /not found|does not exist|unknown model/i.test(String(msg || ''));
}

/**
 * Ollama with automatic account failover.
 *
 * Two cloud keys can be configured (apiKey and apiKeyFallback in
 * ~/.codeply/config.json - two separate ollama.com accounts). This tries
 * them in order: the first key gets the normal retry cycle for ordinary
 * transient hiccups, but the moment a failure looks like it's about that
 * KEY - rate limited, over quota, out of credit, revoked - the request moves
 * straight to the other account instead of burning retries on an account
 * that has already said no. One key being full or broken therefore doesn't
 * stop the app; it just quietly finishes on the other one.
 *
 * A local daemon (no key at all) is the one case with nothing to fail over
 * to, and needs none - it runs as the single "keyless" attempt.
 */
async function chatViaOllama(messages, opts, cfg) {
  const { host, model, apiKey, apiKeyFallback, numCtx } = cfg.ollama;
  const isLocal = /localhost|127\.0\.0\.1/.test(host);

  const keys = [];
  for (const k of [apiKey, apiKeyFallback]) {
    if (k && !keys.includes(k)) keys.push(k);
  }
  if (!keys.length) {
    if (!isLocal) {
      return { success: false, error: `No Ollama API key set for ${host}. Run \`codeply provider ollama --key <key>\`.` };
    }
    keys.push(''); // local daemon - one keyless attempt
  }

  let last = { success: false, error: 'Request failed' };
  for (let i = 0; i < keys.length; i++) {
    const hasSpare = i < keys.length - 1;
    last = await ollamaRequest(host, model, keys[i], isLocal, messages, opts, numCtx, hasSpare);
    // Success, or the user pressed Stop: either way we're done - an abort
    // must never be "retried" on the other account.
    if (last.success || last.aborted) return last;
    if (!hasSpare) break;
    if (isKeyIndependentFailure(last.error)) return last;
  }

  if (keys.length > 1) {
    return { ...last, error: `${last.error} (both Ollama accounts were tried)` };
  }
  return last;
}

function ollamaRequest(host, model, apiKey, isLocal, messages, opts, numCtx, hasSpare) {
  return streamingChatRequest({
    url: `${host}/v1/chat/completions`, label: 'Ollama', model, apiKey, isLocal, messages, opts, hasSpare,
    extraBody: numCtx ? { options: { num_ctx: numCtx } } : null,
  });
}

/**
 * One streamed OpenAI-compatible chat completion, reassembled into the plain
 * non-streaming response shape. Shared by the Ollama cloud/local path and by
 * every user-added custom model. Falls back cleanly to a plain JSON body for
 * servers that ignore `stream: true`.
 */
async function streamingChatRequest({ url, label, model, apiKey, isLocal, messages, opts, hasSpare, extraBody, idleMs }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  // Harmless for a real Ollama host (unrecognized header, ignored) - but
  // without it, an ngrok free-tier tunnel intercepts every request itself and
  // returns its own "you're about to visit..." interstitial page instead of
  // ever forwarding to the actual server behind it. A self-hosted preset
  // (Colab notebook, home server) tunneled through ngrok's free tier is
  // common enough that this is worth sending unconditionally rather than
  // only when the host string happens to contain "ngrok".
  headers['ngrok-skip-browser-warning'] = 'true';

  return withRetries(async () => {
    let res;
    const { signal, poke, isTimeout, cleanup } = withIdleTimeout(opts.signal, idleMs);
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          // Provider-specific extras (e.g. Ollama's `options.num_ctx`).
          ...(extraBody || {}),
          // Streamed, not buffered: a non-streaming request sends nothing over
          // the wire until generation is completely done, and proxies/tunnels
          // kill a connection that stays silent for a minute or two. Streaming
          // keeps bytes flowing from the first token; the chunks are
          // reassembled into the non-streaming shape below.
          stream: true,
        }),
        signal,
      });
    } catch (e) {
      cleanup();
      if (isTimeout()) return { retryable: true, error: `${label} timed out with no response${isLocal ? ' - is the local server running?' : ' - retrying.'}` };
      if (isAbortError(e)) return { aborted: true };
      const hint = isLocal ? ` Is the ${label} server running at ${url}?` : '';
      return { retryable: true, error: e.message + hint };
    }

    // Errors (bad model name, auth, ...) come back as one plain JSON body,
    // not a stream - content-type is the reliable signal for which shape
    // actually arrived, since res.ok alone can't distinguish a streamed 200
    // from a JSON-error 200 some proxies in front of Ollama return.
    const isStream = (res.headers.get('content-type') || '').includes('text/event-stream');

    if (!isStream) {
      cleanup(); // no more bytes expected - the idle clock has nothing left to guard
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.choices?.[0]) {
        return { done: true, value: { success: true, data: body, modelUsed: body.model || model } };
      }
      const apiError = body?.error?.message || body?.error;
      if (apiError) {
        const msg = typeof apiError === 'string' ? apiError : JSON.stringify(apiError);
        const fatal = /not found|does not exist|unknown model|unauthor|invalid.*key|forbidden/i.test(msg);
        if (fatal) return { done: true, value: { success: false, error: `${label}: ${msg}` } };
        // Another account is standing by, and this failure is this account's
        // own (quota, rate limit, no credit) - stop retrying it and let
        // chatViaOllama move the request over there right now.
        if (hasSpare && isKeyLevelFailure(msg, res.status)) {
          return { done: true, value: { success: false, error: `${label}: ${msg}` } };
        }
        return { retryable: isTransientStatus(res.status), error: `${label}: ${msg}` };
      }
      if (hasSpare && isKeyLevelFailure('', res.status)) {
        return { done: true, value: { success: false, error: `${label}: ${describeStatus(res.status)}` } };
      }
      return { retryable: isTransientStatus(res.status), error: describeStatus(res.status) };
    }

    // Reassemble the OpenAI-shaped SSE chunks (data: {...choices[0].delta...})
    // into the exact same {choices:[{message:{content,reasoning}}]} shape a
    // non-streaming call returns.
    let content = '';
    let reasoning = '';
    let finishReason = null;
    let modelUsed = model;
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        poke(); // a real chunk arrived - the stream is alive, push the stall clock back out
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8');
        let nlIndex;
        while ((nlIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIndex).trim();
          buffer = buffer.slice(nlIndex + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          modelUsed = evt.model || modelUsed;
          const delta = evt.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (delta?.reasoning) reasoning += delta.reasoning;
          if (evt.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
        }
      }
    } catch (e) {
      if (isTimeout()) return { retryable: true, error: `${label} stopped sending data mid-response (stalled stream) - retrying.` };
      if (isAbortError(e)) return { aborted: true };
      return { retryable: true, error: `${label} stream interrupted: ${e.message}` };
    } finally {
      cleanup();
    }

    if (!res.ok && !content) {
      if (hasSpare && isKeyLevelFailure('', res.status)) {
        return { done: true, value: { success: false, error: `${label}: ${describeStatus(res.status)}` } };
      }
      return { retryable: isTransientStatus(res.status), error: describeStatus(res.status) };
    }

    const message = { role: 'assistant', content };
    if (reasoning) message.reasoning = reasoning;
    return {
      done: true,
      value: {
        success: true,
        data: { choices: [{ message, finish_reason: finishReason }], model: modelUsed },
        modelUsed,
      },
    };
  });
}

// OpenAI-compatible /v1/chat/completions endpoints for the providers below,
// all of which speak that same dialect. Ollama has its own function above because it
// also has to handle "no key at all for a local daemon", which these never do.
const OPENAI_COMPATIBLE = {
  // OpenRouter fronts every other vendor plus the anonymously-published
  // stealth models (stealth/ox-alpha, ~1M context) that have no first-party
  // API at all, so one key here reaches models the rest of this table can't.
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    label: 'OpenRouter',
    extraHeaders: { 'HTTP-Referer': 'https://codeply.online', 'X-Title': 'Codeply' },
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    label: 'Groq',
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    label: 'OpenAI',
  },
  // Google AI Studio (Gemini) exposes an OpenAI-compatible chat completions
  // endpoint alongside its native API - using it means Gemini needs no
  // special-cased request/response shape, same as openrouter/groq/openai.
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    label: 'Google AI Studio',
  },
  // No fixed `url` here - Alibaba issues a deployment-specific Model Studio
  // host per account/region, so it comes from cfg.qwen.baseUrl instead (see
  // below and lib/config.js).
  qwen: {
    label: 'Qwen (Alibaba Model Studio)',
  },
  // DeepSeek's own base URL genuinely doesn't need a /v1 segment (unlike the
  // other OpenAI-compatible hosts above) - they document both /v1/... and
  // the bare path as equivalent, since /v1 exists there only for client-SDK
  // compatibility, not real API versioning.
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    label: 'DeepSeek',
  },
};

/**
 * 402 is the one status in this family that must never be retried: it means
 * the key authenticated fine and the account simply has no balance to spend
 * (OpenRouter's paid models, once the free allowance is gone). Retrying that
 * three times just makes the user wait three times as long for the same
 * answer, and the provider's own message - "Insufficient credits" - matches
 * none of the fatal patterns below, so it needs saying explicitly.
 */
const OUT_OF_CREDIT_HINT = {
  openrouter: 'your OpenRouter account is out of credit. Top it up at ' +
    'https://openrouter.ai/credits - the key itself is valid, it just has no ' +
    'balance to spend. Free models (ids ending in :free, and the stealth ones) ' +
    'keep working without a balance.',
};

async function chatViaOpenAICompatible(messages, opts, providerName, cfg) {
  const { url: fixedUrl, label, extraHeaders } = OPENAI_COMPATIBLE[providerName];
  const { apiKey, model, baseUrl } = cfg[providerName];
  if (!apiKey) {
    return { success: false, error: `No ${label} API key set. Run \`codeply provider ${providerName} --key <key>\`.` };
  }
  const url = fixedUrl || (baseUrl && `${baseUrl.replace(/\/+$/, '')}/chat/completions`);
  if (!url) {
    return { success: false, error: `No ${label} base URL set. Run \`codeply provider ${providerName} --base-url <url>\`.` };
  }

  return withRetries(async () => {
    let res, body;
    const { signal, isTimeout, cleanup } = withTimeout(opts.signal);
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...extraHeaders,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal,
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      if (isTimeout()) return { retryable: true, error: `${label} timed out with no response - retrying.` };
      if (isAbortError(e)) return { aborted: true };
      return { retryable: true, error: e.message };
    } finally {
      cleanup();
    }

    if (res.ok && body.choices?.[0]) {
      return { done: true, value: { success: true, data: body, modelUsed: body.model || model } };
    }

    if (res.status === 402) {
      const hint = OUT_OF_CREDIT_HINT[providerName] || 'this account is out of credit.';
      return { done: true, value: { success: false, error: `${label}: ${hint}` } };
    }

    const apiError = body?.error?.message || body?.error;
    if (apiError) {
      const msg = typeof apiError === 'string' ? apiError : JSON.stringify(apiError);
      const fatal = /not found|does not exist|unknown model|unauthor|invalid.*key|forbidden/i.test(msg);
      if (fatal) return { done: true, value: { success: false, error: `${label}: ${msg}` } };
      return { retryable: isTransientStatus(res.status), error: `${label}: ${msg}` };
    }

    return { retryable: isTransientStatus(res.status), error: describeStatus(res.status) };
  });
}

// Below this many characters a block essentially never clears Anthropic's
// minimum-token floor for caching (1024 tokens on Sonnet-class models, higher
// on Haiku) - offering cache_control on it just adds a cache-write surcharge
// for a block that will never actually be served from cache. ~4 chars/token is
// a deliberately conservative floor, not a precise count.
const ANTHROPIC_CACHEABLE_MIN_CHARS = 4000;

/**
 * Anthropic's Messages API isn't OpenAI-shaped: system prompt is a top-level
 * field (not a message with role "system"), and the reply comes back as a
 * `content` block array rather than `choices[0].message`. Converted both ways
 * here so the rest of the codebase never has to know Anthropic is different.
 *
 * Prompt caching (`cache_control: {type:'ephemeral'}`) is applied at two
 * breakpoints, because of how the agent loop in lib/agent.mjs actually calls
 * this: one user turn can take up to 24 steps, and EVERY step resends the
 * ENTIRE message array built up so far - there is no other way to talk to a
 * stateless chat completions API. Without caching, a 20-step turn re-bills the
 * system prompt and the whole growing transcript from scratch 20 times over.
 * With it:
 *   1. The system prompt (mode instructions + tool reference + skill index +
 *      project context) is byte-identical across every step of a turn, and
 *      usually across the whole session - cached at ~10% of its input-token
 *      cost after the first call.
 *   2. Everything except the newest message is marked as a second breakpoint,
 *      so step N's request reuses step N-1's cache instead of re-billing the
 *      whole transcript-so-far - turning per-step cost from O(conversation
 *      length) into roughly O(what's new since the last step).
 * Anthropic allows the read side of a cache hit to apply automatically for any
 * request sharing a cached prefix, so these two breakpoints are enough; more
 * would just spend the (4/hr) breakpoint limit for no further benefit here.
 */
/**
 * Message content is either a plain string (the overwhelming majority of
 * calls - every tool result, every system prompt) or, when the user pasted
 * an image, an OpenAI-shaped array: [{type:'text',text}, {type:'image_url',
 * image_url:{url:'data:...;base64,...'}}]. That array format is what
 * agent.mjs builds and what OpenAI-compatible endpoints (Ollama, OpenRouter,
 * Groq, OpenAI, the codeply proxy) all speak natively, so those backends
 * need no conversion at all - messages just flow through as-is. Anthropic's
 * Messages API is the one exception: it wants {type:'image', source:
 * {type:'base64', media_type, data}}, not an image_url. This is the only
 * place that translation has to happen.
 */
function toAnthropicContent(content) {
  if (typeof content === 'string' || !Array.isArray(content)) return content;
  return content
    .map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image_url') {
        const m = /^data:([^;]+);base64,(.+)$/.exec(part.image_url?.url || '');
        if (!m) return null;
        return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
      }
      return null;
    })
    .filter(Boolean);
}

async function chatViaAnthropic(messages, opts, cfg) {
  const { apiKey, model } = cfg.anthropic;
  if (!apiKey) {
    return { success: false, error: 'No Anthropic API key set. Run `codeply provider anthropic --key <key>`.' };
  }

  const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(m.content) }));

  // Anthropic has no json_object response mode - ask for it in plain English instead.
  const systemText2 = opts.json
    ? `${systemText}\n\nRespond with ONLY a single valid JSON object. No prose, no markdown fences, nothing before or after it.`
    : systemText;

  const cacheControl = { type: 'ephemeral' };
  const system = systemText2.length >= ANTHROPIC_CACHEABLE_MIN_CHARS
    ? [{ type: 'text', text: systemText2, cache_control: cacheControl }]
    : systemText2;

  // Breakpoint 2: everything but the newest message. A single-message request
  // (the very first call of a brand-new turn) has nothing "so far" to cache.
  if (turns.length >= 2) {
    const idx = turns.length - 2;
    if (turns[idx].content.length >= ANTHROPIC_CACHEABLE_MIN_CHARS) {
      turns[idx] = {
        role: turns[idx].role,
        content: [{ type: 'text', text: turns[idx].content, cache_control: cacheControl }],
      };
    }
  }

  return withRetries(async () => {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system,
          messages: turns,
          max_tokens: opts.maxTokens || 8192,
          temperature: opts.temperature ?? 0,
        }),
        signal: opts.signal,
      });
    } catch (e) {
      if (isAbortError(e)) return { aborted: true };
      return { retryable: true, error: e.message };
    }

    const body = await res.json().catch(() => ({}));

    if (res.ok && Array.isArray(body.content)) {
      const text = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const data = {
        choices: [{ message: { role: 'assistant', content: text }, finish_reason: body.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
        usage: {
          prompt_tokens: body.usage?.input_tokens || 0,
          completion_tokens: body.usage?.output_tokens || 0,
          total_tokens: (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0),
          // Surfaced for anyone instrumenting cost later - not read anywhere yet.
          cache_read_tokens: body.usage?.cache_read_input_tokens || 0,
          cache_write_tokens: body.usage?.cache_creation_input_tokens || 0,
        },
      };
      return { done: true, value: { success: true, data, modelUsed: model } };
    }

    const apiError = body?.error?.message || body?.error;
    if (apiError) {
      const msg = typeof apiError === 'string' ? apiError : JSON.stringify(apiError);
      const fatal = /not_found_error|authentication_error|permission_error|invalid.*key/i.test(JSON.stringify(body.error || {})) || res.status === 401 || res.status === 403 || res.status === 404;
      if (fatal) return { done: true, value: { success: false, error: `Anthropic: ${msg}` } };
      return { retryable: isTransientStatus(res.status), error: `Anthropic: ${msg}` };
    }

    return { retryable: isTransientStatus(res.status), error: describeStatus(res.status) };
  });
}

/**
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ json?: boolean, maxTokens?: number, temperature?: number }} opts
 * @returns {Promise<{success:boolean, data?:object, error?:string, modelUsed?:string}>}
 */
/**
 * Apply a per-request routing override (see lib/model-router.js) on top of the
 * stored config, without persisting anything.
 *
 * Falls back to the unrouted config whenever the target provider isn't
 * actually usable - no API key for a BYOK provider, no key for remote Ollama.
 * A route that can't authenticate would otherwise turn a working setup into a
 * hard "No API key set" error purely because of which words were in the user's
 * message, which is a far worse outcome than answering on the model they
 * already had configured.
 */
function applyRoute(cfg, route) {
  if (!route || !route.provider || !route.model) return cfg;
  if (!PROVIDERS.includes(route.provider)) return cfg;

  const section = { ...(cfg[route.provider] || {}), model: route.model };
  if (route.provider === 'ollama') {
    const isLocal = /localhost|127\.0\.0\.1/.test(section.host || '');
    if (!section.apiKey && !isLocal) return cfg;
  } else if (route.provider !== 'codeply' && !section.apiKey) {
    return cfg;
  }
  return { ...cfg, provider: route.provider, [route.provider]: section };
}

// ─── User-added models (desktop model picker) ───────────────────────────────

const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u || '');

/**
 * People paste base URLs in every shape: ".../v1", ".../openai", the full
 * ".../chat/completions", or a bare host. Normalize to the completions URL.
 */
function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+[a-z]*$/i.test(base) || /\/openai$/i.test(base) || /\/compatible-mode\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Ollama's native API lives at the host root - strip an /api or /v1 suffix someone pasted. */
function ollamaHost(baseUrl) {
  return String(baseUrl || 'http://localhost:11434').trim().replace(/\/+$/, '').replace(/\/(api|v1)$/i, '');
}

// Local models can take a while to load into memory before the first byte -
// a longer stall window than the hosted providers get.
const LOCAL_IDLE_TIMEOUT_MS = 300_000;
// Ollama's default context window (2-4K tokens) is far too small for an agent
// system prompt plus history; without raising it the model silently loses the
// start of the conversation. 32K fits comfortably on most machines.
const OLLAMA_NUM_CTX = 32768;

/** OpenAI-shaped content array → Ollama native { content, images } fields. */
function toOllamaMessage(m) {
  if (typeof m.content === 'string' || !Array.isArray(m.content)) return { role: m.role, content: m.content || '' };
  const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const images = m.content
    .filter((p) => p.type === 'image_url')
    .map((p) => /^data:[^;]+;base64,(.+)$/.exec(p.image_url?.url || '')?.[1])
    .filter(Boolean);
  return images.length ? { role: m.role, content: text, images } : { role: m.role, content: text };
}

/**
 * Ollama's native /api/chat, not its OpenAI shim: only the native endpoint
 * reliably honors options.num_ctx, which the agent needs (see above).
 * Streams NDJSON and reassembles it into the standard response shape.
 */
async function chatViaOllamaNative(messages, opts, m) {
  const host = ollamaHost(m.baseUrl);
  const local = isLocalUrl(host);
  const headers = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' };
  if (m.apiKey) headers.Authorization = `Bearer ${m.apiKey}`;

  return withRetries(async () => {
    let res;
    const { signal, poke, isTimeout, cleanup } = withIdleTimeout(opts.signal, local ? LOCAL_IDLE_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: m.model,
          messages: messages.map(toOllamaMessage),
          stream: true,
          ...(opts.json ? { format: 'json' } : {}),
          options: {
            num_ctx: OLLAMA_NUM_CTX,
            temperature: opts.temperature ?? 0,
            ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
          },
        }),
        signal,
      });
    } catch (e) {
      cleanup();
      if (isTimeout()) return { retryable: true, error: `Ollama at ${host} didn't respond in time. Large models can take a while to load - try again, or pick a smaller model.` };
      if (isAbortError(e)) return { aborted: true };
      return { retryable: false, error: local ? `Can't reach Ollama at ${host}. Is Ollama running? (Start it with \`ollama serve\` or open the Ollama app.)` : `Can't reach ${host}: ${e.message}` };
    }

    if (!res.ok) {
      cleanup();
      const body = await res.json().catch(() => ({}));
      const msg = body.error || describeStatus(res.status);
      const fatal = res.status === 404 || /not found|pull/i.test(String(msg));
      if (fatal) return { done: true, value: { success: false, error: `Ollama: ${msg}${/not found/i.test(String(msg)) ? ` - run \`ollama pull ${m.model}\` first.` : ''}` } };
      return { retryable: isTransientStatus(res.status), error: `Ollama: ${msg}` };
    }

    let content = '';
    let reasoning = '';
    let buffer = '';
    let streamError = null;
    try {
      for await (const chunk of res.body) {
        poke();
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.error) streamError = evt.error;
          if (evt.message?.content) content += evt.message.content;
          if (evt.message?.thinking) reasoning += evt.message.thinking;
        }
      }
    } catch (e) {
      if (isTimeout()) return { retryable: true, error: 'Ollama stopped sending data mid-response - retrying.' };
      if (isAbortError(e)) return { aborted: true };
      return { retryable: true, error: `Ollama stream interrupted: ${e.message}` };
    } finally {
      cleanup();
    }
    if (streamError && !content) return { done: true, value: { success: false, error: `Ollama: ${streamError}` } };

    const message = { role: 'assistant', content };
    if (reasoning) message.reasoning = reasoning;
    return { done: true, value: { success: true, data: { choices: [{ message }], model: m.model }, modelUsed: m.model } };
  });
}

function chatViaCustom(messages, opts, m) {
  if (m.kind === 'ollama') return chatViaOllamaNative(messages, opts, m);
  const url = chatCompletionsUrl(m.baseUrl);
  const local = isLocalUrl(url);
  return streamingChatRequest({
    url, label: m.name || m.model, model: m.model, apiKey: m.apiKey, isLocal: local,
    messages, opts, hasSpare: false, idleMs: local ? LOCAL_IDLE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  });
}

/** Lists the models an Ollama host has pulled - powers "Connect Ollama". */
async function listOllamaModels(baseUrl) {
  const host = ollamaHost(baseUrl);
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, host, error: `Ollama at ${host} answered HTTP ${res.status}.` };
    const body = await res.json();
    const models = (body.models || []).map((x) => ({ name: x.name, size: x.size || 0, family: x.details?.family || '', params: x.details?.parameter_size || '' }));
    return { ok: true, host, models };
  } catch {
    return { ok: false, host, error: `Couldn't find Ollama at ${host}. Install it from ollama.com and make sure it's running.` };
  }
}

/** A tiny real request against a model entry, so "Save" can confirm it actually works. */
async function testModel(m) {
  const started = Date.now();
  const r = await chatViaCustom(
    [{ role: 'user', content: 'Reply with exactly: OK' }],
    { maxTokens: 16, signal: AbortSignal.timeout(90_000) },
    m,
  );
  if (!r.success) return { ok: false, error: r.aborted ? 'The model took longer than 90 seconds to answer.' : r.error };
  return { ok: true, ms: Date.now() - started, reply: (r.data.choices?.[0]?.message?.content || '').trim().slice(0, 80) };
}

async function chat(messages, opts = {}) {
  // A user-added model (desktop model picker) always wins when routed.
  if (opts.route && opts.route.custom) return chatViaCustom(messages, opts, opts.route.custom);
  // Auto in the desktop app = the hosted Codeply model, regardless of what
  // the CLI's own `codeply provider` setting says.
  if (opts.route && opts.route.auto) return chatViaProxy(messages, opts);
  const cfg = applyRoute(getConfig(), opts.route);
  switch (cfg.provider) {
    case 'ollama': return chatViaOllama(messages, opts, cfg);
    case 'anthropic': return chatViaAnthropic(messages, opts, cfg);
    case 'openrouter':
    case 'groq':
    case 'openai':
    case 'google':
    case 'qwen':
    case 'deepseek':
      return chatViaOpenAICompatible(messages, opts, cfg.provider, cfg);
    default: return chatViaProxy(messages, opts);
  }
}

function tryParseJson(s) {
  try { return { ok: true, value: JSON.parse(s) }; }
  catch { return { ok: false }; }
}

/**
 * `{ json: true }` asks the provider for a strict JSON response, but that's
 * only ever a hint - response_format: json_object is a best-effort request,
 * not a guarantee, and plenty of models (especially smaller/self-hosted
 * ones) still answer with a markdown code fence around the object, or a
 * sentence of prose before/after it, even when told not to. A single strict
 * JSON.parse on the raw content turned every one of those into a hard
 * failure - "AI returned an unreadable response" - even though the actual
 * JSON was sitting right there. Three attempts, each a superset of what the
 * last one handles:
 *   1. The raw content, as-is (the common, well-behaved case).
 *   2. The content inside a ```json ... ``` / ``` ... ``` fence, if present.
 *   3. The first '{' to the last '}' in the whole reply - covers stray
 *      leading/trailing prose the model added despite being asked not to.
 */
function extractJsonObject(text) {
  const direct = tryParseJson(text);
  if (direct.ok) return direct.value;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = tryParseJson(fenced[1].trim());
    if (inner.ok) return inner.value;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = tryParseJson(text.slice(start, end + 1));
    if (sliced.ok) return sliced.value;
  }

  return undefined;
}

/** Chat helper that expects a JSON object back and parses it. */
async function chatJson(messages, opts = {}) {
  const r = await chat(messages, { ...opts, json: true });
  if (!r.success) return { success: false, error: r.error };
  const raw = r.data.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(raw);
  if (parsed === undefined) return { success: false, error: 'AI returned an unreadable response.' };
  return { success: true, json: parsed, usage: r.data.usage || {}, modelUsed: r.modelUsed };
}

module.exports = { chat, chatJson, isRateLimitError, listOllamaModels, testModel, chatCompletionsUrl };
