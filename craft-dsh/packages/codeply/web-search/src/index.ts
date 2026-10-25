/**
 * Codeply add-on: a web search provider that needs no key, so `web_search`
 * works for every Craft user. Exa's free hosted search (its public MCP
 * endpoint) first, DuckDuckGo's HTML results when Exa fails.
 *
 * Ported from Classic Craft (codeply-cli/lib/web-tools.js). Selected with the
 * web seam's `searchProvider: codeply` in the Craft bundle.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

export const name = 'codeply-web-search'
export const inject = ['web']

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Codeply'
const SEARCH_TIMEOUT_MS = 25_000
const DEFAULT_RESULTS = 8

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: '\'', lsquo: '\'', rdquo: '"', ldquo: '"', copy: '(c)' }

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
}

const timeout = (signal?: AbortSignal) =>
  signal === undefined ? AbortSignal.timeout(SEARCH_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])

/**
 * Exa's hosted search answers in text blocks ("Title: ... URL: ... Text: ...").
 * @param text - the tool's text output.
 * @returns the sources it names.
 */
export function parseExaText(text: string): WebSearchSource[] {
  const out: WebSearchSource[] = []
  for (const block of text.split(/\n(?=Title:)/)) {
    const url = /^URL:\s*(\S+)/m.exec(block)?.[1]
    if (url === undefined || !/^https?:/.test(url)) continue
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim()
    const published = /^Published Date:\s*(\S+)/m.exec(block)?.[1]
    const body = /^(?:Text|Highlights|Summary):\s*([\s\S]*)$/m.exec(block)?.[1]?.trim()
    out.push({
      url,
      ...title ? { title } : {},
      ...body ? { snippet: body.slice(0, 300), summary: body.slice(0, 4000) } : {},
      ...published ? { publishedAt: published } : {},
    })
  }
  return out
}

async function exaSearch(query: string, num: number, signal?: AbortSignal): Promise<WebSearchSource[]> {
  const res = await fetch('https://mcp.exa.ai/mcp', {
    method: 'POST',
    signal: timeout(signal),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query, numResults: num, type: 'auto', livecrawl: 'fallback' } },
    }),
  })
  if (!res.ok) throw new Error(`Exa returned HTTP ${res.status}`)
  const raw = await res.text()
  // The reply is either plain JSON or an SSE stream of "data: {...}" lines.
  const payloads = raw.trimStart().startsWith('{') ? [raw] : raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
  for (const p of payloads) {
    let j: { error?: { message?: string }; result?: { content?: { type: string; text?: string }[] } }
    try { j = JSON.parse(p) as typeof j } catch { continue }
    if (j.error) throw new Error(j.error.message ?? 'Exa error')
    const text = (j.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n').trim()
    const sources = parseExaText(text)
    if (sources.length > 0) return sources
  }
  throw new Error('Exa returned no results')
}

async function ddgSearch(query: string, num: number, signal?: AbortSignal): Promise<WebSearchSource[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    signal: timeout(signal),
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
  })
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`)
  const html = await res.text()
  const out: WebSearchSource[] = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && out.length < num) {
    let href = decodeEntities(m[1]!)
    const u = /[?&]uddg=([^&]+)/.exec(href)
    if (u) { try { href = decodeURIComponent(u[1]!) } catch {} }
    const title = decodeEntities(m[2]!.replace(/<[^>]+>/g, '')).trim()
    const snippet = decodeEntities((m[3] ?? '').replace(/<[^>]+>/g, '')).trim()
    if (title.length > 0 && /^https?:/.test(href)) out.push({ url: href, title, ...snippet ? { snippet } : {} })
  }
  if (out.length === 0) throw new Error('DuckDuckGo returned no results')
  return out
}

class CodeplySearchProvider implements WebSearchProvider {
  readonly id = 'codeply'
  available(): boolean { return true }
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const num = Math.min(request.maxResults ?? DEFAULT_RESULTS, 20)
    const errors: string[] = []
    for (const run of [exaSearch, ddgSearch]) {
      try {
        return { sources: await run(request.query, num, signal), truncated: false }
      } catch (e) {
        if (signal?.aborted === true) throw e
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
    throw new Error(`Web search failed: ${errors.join('; ')}`)
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.web.registerSearchProvider(new CodeplySearchProvider()), 'codeply web search')
}
