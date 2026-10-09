/**
 * Web access for the agent: fetch a page as readable text, and search the web.
 *
 * Search uses Exa's public MCP endpoint (the same one opencode's websearch tool
 * talks to; no key needed) and falls back to DuckDuckGo's HTML results when
 * Exa is unreachable. Fetching converts HTML to plain markdown-ish text so the
 * model gets the content, not the markup.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Codeply';
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const SEARCH_TIMEOUT_MS = 25000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: '(c)' };

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] ?? m));
}

/** HTML -> readable text: headings, links, lists, code and paragraphs survive; the rest goes. */
function htmlToText(html, baseUrl) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => '\n```\n' + code.replace(/<[^>]+>/g, '') + '\n```\n');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => '`' + c.replace(/<[^>]+>/g, '') + '`');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
    const label = t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!label) return '';
    if (!href || href.startsWith('#') || /^(javascript|mailto):/i.test(href)) return label;
    let abs = href;
    try { abs = new URL(href, baseUrl).href; } catch {}
    return `[${label}](${abs})`;
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|header|footer|main|nav|ul|ol|table|tr|blockquote|figure)>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * @param {string} url
 * @param {{format?:'text'|'html'|'raw', signal?:AbortSignal, maxChars?:number}} [opts]
 * @returns {Promise<{ok:boolean, text?:string, error?:string, status?:number, contentType?:string, finalUrl?:string}>}
 */
async function fetchPage(url, opts = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: `Not a valid URL: ${url}` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'web_fetch only supports http:// and https:// URLs.' };
  const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  let res;
  try {
    res = await fetch(parsed.href, {
      redirect: 'follow',
      signal: AbortSignal.any(signals),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json,text/plain,text/markdown;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' },
    });
  } catch (e) {
    return { ok: false, error: `Could not reach ${parsed.href}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}` };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `${parsed.href} returned HTTP ${res.status}.` };
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return { ok: false, error: `The page is ${(declared / 1e6).toFixed(1)}MB, over the ${MAX_BYTES / 1e6}MB limit.` };
  if (/^(image|video|audio)\//.test(contentType) || /^application\/(zip|octet-stream|pdf|gzip)/.test(contentType)) {
    return { ok: false, contentType, error: `${parsed.href} is ${contentType}, not text. Use fetch_image for images or run curl to download a file.` };
  }
  let buf;
  try { buf = Buffer.from(await res.arrayBuffer()); } catch (e) { return { ok: false, error: `Failed reading ${parsed.href}: ${e.message}` }; }
  if (buf.length > MAX_BYTES) return { ok: false, error: `The page is over the ${MAX_BYTES / 1e6}MB limit.` };
  const body = buf.toString('utf8');
  const format = opts.format || 'text';
  const isHtml = contentType.includes('html') || (!contentType && /^\s*<(!doctype|html)/i.test(body));
  let text = body;
  if (isHtml && format === 'text') text = htmlToText(body, res.url || parsed.href);
  else if (contentType.includes('json') && format !== 'raw') {
    try { text = JSON.stringify(JSON.parse(body), null, 2); } catch {}
  }
  return { ok: true, text, contentType, finalUrl: res.url || parsed.href, status: res.status };
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function exaSearch(query, num, signal) {
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const res = await fetch('https://mcp.exa.ai/mcp', {
    method: 'POST',
    signal: AbortSignal.any(signals),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query, numResults: num, type: 'auto', livecrawl: 'fallback' } },
    }),
  });
  if (!res.ok) throw new Error(`Exa returned HTTP ${res.status}`);
  const raw = await res.text();
  // The reply is either plain JSON or an SSE stream of "data: {...}" lines.
  const payloads = [];
  if (raw.trimStart().startsWith('{')) payloads.push(raw);
  else for (const line of raw.split('\n')) if (line.startsWith('data:')) payloads.push(line.slice(5).trim());
  for (const p of payloads) {
    let j;
    try { j = JSON.parse(p); } catch { continue; }
    if (j.error) throw new Error(j.error.message || 'Exa error');
    const text = (j.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (text) return text;
  }
  throw new Error('Exa returned no results');
}

async function ddgSearch(query, num, signal) {
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    signal: AbortSignal.any(signals),
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let m;
  while ((m = re.exec(html)) && out.length < num) {
    let href = decodeEntities(m[1]);
    const u = /[?&]uddg=([^&]+)/.exec(href);
    if (u) { try { href = decodeURIComponent(u[1]); } catch {} }
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
    const snippet = decodeEntities((m[3] || '').replace(/<[^>]+>/g, '')).trim();
    if (title && /^https?:/.test(href)) out.push(`Title: ${title}\nURL: ${href}${snippet ? `\n${snippet}` : ''}`);
  }
  if (!out.length) throw new Error('DuckDuckGo returned no results');
  return out.join('\n\n');
}

// ─── Image search ───────────────────────────────────────────────────────────
// Real photos from across the web, like a Google image search: DuckDuckGo's
// image results (no key), with Wikimedia Commons (free to use) as a fallback.

// Stock sites whose previews carry a watermark: never useful on a real page.
const WATERMARKED = /(dreamstime|shutterstock|alamy|istockphoto|gettyimages|depositphotos|123rf|stock\.adobe|bigstockphoto|canstockphoto|agefotostock|vectorstock|pond5|featurepics)\./i;

async function ddgImages(query, num, signal) {
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const page = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, { signal: AbortSignal.any(signals), headers: { 'User-Agent': UA } });
  const vqd = (/vqd=["']?([\d-]+)/.exec(await page.text()) || [])[1];
  if (!vqd) throw new Error('DuckDuckGo images did not answer');
  const res = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=1`, {
    signal: AbortSignal.any(signals), headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo images returned HTTP ${res.status}`);
  const j = await res.json();
  const out = (j.results || [])
    .filter((r) => /^https:\/\//.test(r.image || '') && (r.width || 0) >= 600 && !WATERMARKED.test(`${r.image} ${r.url || ''}`))
    .slice(0, num)
    .map((r) => ({ title: String(r.title || '').slice(0, 120), url: r.image, width: r.width, height: r.height, page: r.url || '' }));
  if (!out.length) throw new Error('DuckDuckGo images found nothing');
  return out;
}

async function commonsImages(query, num, signal) {
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=${num * 2}` +
    `&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|size&iiurlwidth=1600`;
  const res = await fetch(u, { signal: AbortSignal.any(signals), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Wikimedia returned HTTP ${res.status}`);
  const pages = Object.values((await res.json()).query?.pages || {});
  const out = pages.map((p) => ({ p, i: (p.imageinfo || [])[0] })).filter(({ i }) => i && i.width >= 600)
    .slice(0, num)
    .map(({ p, i }) => ({ title: String(p.title || '').replace(/^File:/, '').slice(0, 120), url: i.thumburl || i.url, width: i.thumbwidth || i.width, height: i.thumbheight || i.height, page: i.descriptionurl || '' }));
  if (!out.length) throw new Error('Wikimedia Commons found nothing');
  return out;
}

/** @returns {Promise<{ok:boolean, images?:object[], error?:string, via?:string}>} */
async function imageSearch(query, opts = {}) {
  const num = Math.min(Math.max(Number(opts.num) || 8, 1), 16);
  const errors = [];
  try { return { ok: true, images: await ddgImages(query, num, opts.signal), via: 'web' }; } catch (e) { errors.push(e.message); }
  if (opts.signal?.aborted) return { ok: false, error: 'Search cancelled.' };
  try { return { ok: true, images: await commonsImages(query, num, opts.signal), via: 'wikimedia' }; } catch (e) { errors.push(e.message); }
  return { ok: false, error: `Image search failed (${errors.join('; ')}).` };
}

/** @returns {Promise<{ok:boolean, text?:string, error?:string, via?:string}>} */
async function webSearch(query, opts = {}) {
  const num = Math.min(Math.max(Number(opts.num) || 8, 1), 20);
  const errors = [];
  try { return { ok: true, text: await exaSearch(query, num, opts.signal), via: 'exa' }; } catch (e) { errors.push(e.message); }
  if (opts.signal?.aborted) return { ok: false, error: 'Search cancelled.' };
  try { return { ok: true, text: await ddgSearch(query, num, opts.signal), via: 'duckduckgo' }; } catch (e) { errors.push(e.message); }
  return { ok: false, error: `Web search failed (${errors.join('; ')}).` };
}

module.exports = { fetchPage, webSearch, imageSearch, htmlToText };
