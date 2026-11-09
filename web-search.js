// Web search for the phone and web apps (window.CodeplyWeb), used by phone.js and phone-calls.js.
//
// Searches go to Codeply's own /api/search first (the server searches Exa, Brave when keyed, and DuckDuckGo,
// and reads the top pages). If that is down, the browser asks Exa's keyless MCP and then Wikipedia directly.
// Exa's keyless endpoint alone used to be the only source, and it now rate-limits after a few calls, which is
// why searches on the phone kept failing.
//
// It also decides when to search before the model is asked (needsSearch): a question about the news, prices,
// the weather or anything "latest" is searched at once, instead of waiting for the model to ask for it.
(function () {
  const API = 'https://www.codeply.app/api/search'; // www: the bare domain redirects, and a CORS preflight cannot follow that
  const EXA_MCP = 'https://mcp.exa.ai/mcp';
  const cache = new Map();
  const CACHE_MS = 10 * 60 * 1000;

  function timeoutSignal(ms, parent) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    if (parent) { if (parent.aborted) ctl.abort(); else parent.addEventListener('abort', () => ctl.abort(), { once: true }); }
    ctl.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
    return ctl.signal;
  }
  const stopped = () => Object.assign(new Error('Stopped.'), { name: 'AbortError' });

  async function viaApi(payload, token, signal, ms) {
    if (!token) throw new Error('not signed in');
    const res = await fetch(API, {
      method: 'POST', signal: timeoutSignal(ms, signal),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok || !j.text) throw new Error(j.message || `search returned ${res.status}`);
    return j;
  }

  async function exaCall(name, args, signal) {
    const res = await fetch(EXA_MCP, {
      method: 'POST', signal: timeoutSignal(15000, signal),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) throw new Error(`Exa returned ${res.status}`);
    const raw = await res.text();
    const payloads = raw.trimStart().startsWith('{') ? [raw] : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const p of payloads) {
      let j; try { j = JSON.parse(p); } catch { continue; }
      if (j.error) throw new Error(/rate limit/i.test(j.error.message || '') ? 'Exa is rate limited' : (j.error.message || 'Exa error'));
      const text = ((j.result && j.result.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) return text;
    }
    throw new Error('no results');
  }

  async function wikipedia(query, signal) {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=3&prop=extracts|info&inprop=url&exintro=1&explaintext=1&format=json&origin=*`, { signal: timeoutSignal(10000, signal) });
    if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
    const pages = Object.values(((await res.json()).query || {}).pages || {}).sort((a, b) => a.index - b.index);
    if (!pages.length) throw new Error('no results');
    return pages.map((p, i) => `[${i + 1}] ${p.title}\nURL: ${p.fullurl}\n${String(p.extract || '').slice(0, 2500)}`).join('\n\n---\n\n');
  }

  /** Links in the results, for the "Searched the web" sources row. */
  function sourcesOf(text) {
    const out = []; const seen = new Set();
    const re = /^(?:\[\d+\]\s*(.+)\n)?URL:\s*(https?:\/\/\S+)/gm;
    let m;
    while ((m = re.exec(text)) && out.length < 8) {
      let host = ''; try { host = new URL(m[2]).hostname.replace(/^www\./, ''); } catch { continue; }
      if (seen.has(m[2])) continue;
      seen.add(m[2]);
      out.push({ url: m[2], title: (m[1] || '').trim() || host, host });
    }
    if (!out.length) { // Exa's own format: "Title: ...\nURL: ..."
      const re2 = /^Title:\s*(.+)\nURL:\s*(https?:\/\/\S+)/gm;
      while ((m = re2.exec(text)) && out.length < 8) {
        let host = ''; try { host = new URL(m[2]).hostname.replace(/^www\./, ''); } catch { continue; }
        if (!seen.has(m[2])) { seen.add(m[2]); out.push({ url: m[2], title: m[1].trim(), host }); }
      }
    }
    return out;
  }

  /**
   * Search the web. Resolves { text, via, sources }: the results as text (titles, links and page extracts).
   * opts.token: the Supabase access token (for /api/search). Throws when every source failed.
   */
  async function search(query, { num = 6, signal, token } = {}) {
    query = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!query) throw new Error('Nothing to search for.');
    const key = `${num}:${query.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const errors = [];
    const done = (text, via) => {
      const value = { text: String(text).slice(0, 16000), via, sources: sourcesOf(text) };
      cache.set(key, { at: Date.now(), value });
      return value;
    };
    try { const j = await viaApi({ query, num }, token, signal, 25000); return done(j.text, j.via); } catch (e) { if (signal && signal.aborted) throw stopped(); errors.push(e.message); }
    try { return done(await exaCall('web_search_exa', { query, numResults: num, objective: `Find current, reliable pages that answer: ${query}` }, signal), 'exa'); } catch (e) { if (signal && signal.aborted) throw stopped(); errors.push(e.message); }
    try { return done(await wikipedia(query, signal), 'wikipedia'); } catch (e) { if (signal && signal.aborted) throw stopped(); errors.push(e.message); }
    throw new Error(`the search did not work (${errors.join('; ')})`);
  }

  /** Read pages the user linked. Resolves { text, sources }. */
  async function read(urls, { signal, token } = {}) {
    urls = [...new Set((urls || []).map(String))].slice(0, 3);
    if (!urls.length) throw new Error('No links to read.');
    const errors = [];
    try { const j = await viaApi({ urls }, token, signal, 25000); return { text: j.text.slice(0, 20000), sources: sourcesOf(j.text) }; } catch (e) { if (signal && signal.aborted) throw stopped(); errors.push(e.message); }
    try { const t = await exaCall('web_fetch_exa', { urls, maxCharacters: 8000 }, signal); return { text: t.slice(0, 20000), sources: urls.map((url) => ({ url, title: url, host: new URL(url).hostname.replace(/^www\./, '') })) }; } catch (e) { if (signal && signal.aborted) throw stopped(); errors.push(e.message); }
    // Jina's reader: keyless, open to browsers
    const parts = await Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(`https://r.jina.ai/${url}`, { signal: timeoutSignal(20000, signal), headers: { Accept: 'text/plain' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return `URL: ${url}\n${(await res.text()).slice(0, 8000)}`;
      } catch (e) { errors.push(e.message); return ''; }
    }));
    const text = parts.filter(Boolean).join('\n\n---\n\n');
    if (!text) throw new Error(`could not read the link (${errors.join('; ')})`);
    return { text, sources: urls.map((url) => ({ url, title: url, host: new URL(url).hostname.replace(/^www\./, '') })) };
  }

  // ─── When to search ───────────────────────────────────────────────────────
  const ASKED = /\b(search|google|look\s*(it|this|that|them)?\s*up|look\s+online|check\s+(online|the\s+web|the\s+internet)|browse|find\s+(me\s+)?(online|on\s+the\s+web|sources?|links?|articles?|reviews?)|on\s+the\s+(web|internet)|web\s*search|sources?\s+for)\b/i;
  const CURRENT = /\b(trend(s|ing)?|rn|what'?s\s+(new|happening|going\s+on|hot|up\s+with)|whats\s+(new|happening|going\s+on|hot)|new\s+(ai|models?|startups?|releases?|features?|products?|phones?|games?|movies?|songs?|updates?|tools?|launch(es)?|laws?|rules?)|updates?|on\s+(x|twitter|reddit|tiktok|youtube|instagram|linkedin|hacker\s*news)|viral|buzz|latest|newest|recent(ly)?|current(ly)?|today|tonight|tomorrow|yesterday|this\s+(week|month|year|season|weekend)|right\s+now|nowadays|up\s*-?\s*to\s*-?\s*date|news|headlines?|breaking|announced?|released?|launch(ed|es)?|price|prices|cost|costs|how\s+much|stock|share\s+price|exchange\s+rate|rate\s+of|weather|forecast|temperature|score|scores|result|results|won|winner|wins?|standings|fixtures?|schedule|when\s+(is|does|will)|open(ing)?\s+hours|still\s+(alive|open|available)|who\s+is\s+the\s+(current\s+)?(ceo|president|prime\s+minister|owner|head|leader|captain|coach)|20(2[5-9]|3\d))\b/i;
  const NOT_WEB = /\b(write|rewrite|draft|compose|translate|summari[sz]e\s+(this|the\s+following)|fix\s+(my|this)|code|function|regex|debug|poem|story|essay|joke|calculate|solve)\b/i;

  /** Should the app search before asking the model? Asked outright, or the answer depends on something current. */
  function needsSearch(text) {
    const t = String(text || '').replace(/(^|\s)@[\w.-]+/g, ' ').trim();
    if (t.length < 4 || t.length > 1500) return false;
    if (ASKED.test(t)) return true;
    if (NOT_WEB.test(t) && !/\?\s*$/.test(t)) return false;
    return CURRENT.test(t);
  }

  /** The search query for a message: the question without "can you search for" and the like. */
  function queryFor(text, previous) {
    let q = String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/(^|\s)@[\w.-]+/g, ' ').replace(/\s+/g, ' ').trim();
    q = q.replace(/^(hey|hi|ok(ay)?|so|please|pls|yo)[,!\s]+/i, '')
      .replace(/^(can|could|would|will)\s+(you\s+)?(please\s+)?/i, '')
      .replace(/^(just\s+)?(see|tell\s+me|show\s+me|give\s+me|check|find\s+out)\s+/i, '')
      .replace(/\brn\b/gi, 'right now').replace(/\bon\s+x\b/gi, 'on X (Twitter)').replace(/\bin\s+the\s+field\s+(of|on)\s+/gi, 'in ')
      .replace(/^in\s+(the\s+)?/i, '')
      .replace(/^(please\s+)?(do\s+a\s+)?(quick\s+)?(web\s+)?(search|google|look\s+up|lookup|find|check|browse)(\s+(the\s+)?(web|internet|online))?(\s+(for|about|on|if|whether|what|to\s+see))?\s+/i, '')
      .replace(/\s+(on|from)\s+the\s+(web|internet)\b/i, '')
      .replace(/\b(for me|please|pls|asap)\b/gi, '')
      .replace(/[?!.\s]+$/, '').trim();
    // a short follow-up ("and the price?", "what about tomorrow") leans on the earlier question
    if (previous && q.split(' ').length <= 4 && /^(and|what about|how about|also|it|its|their|that|this)\b/i.test(q)) q = `${String(previous).slice(0, 160)} ${q}`;
    q = q.slice(0, 280) || String(text || '').slice(0, 280);
    // About something current: say when, so the search finds this month's pages, not old ones
    if (CURRENT.test(q) && !/\b(19|20)\d\d\b/.test(q)) q += ` ${new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })}`;
    return q;
  }

  /** Links in a message, to read before answering. */
  function linksIn(text) {
    return [...new Set((String(text || '').match(/https?:\/\/[^\s<>()"'\]]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 3);
  }

  /** The model said it cannot browse or only knows up to its training: search and ask again. */
  const REFUSED = /\b(I\s+(can(no|')t|am\s+(not\s+)?(un)?able\s+to|do(n'|\s+no)t\s+have\s+(the\s+ability\s+to|access\s+to))\s+(browse|search|access|look\s+up|check)\s+(the\s+)?(web|internet|online|real[- ]time|live|current)|(do(n'|\s+no)t|don't)\s+have\s+(real[- ]time|live|current|internet)\s+(access|data|information|info)|as\s+of\s+my\s+(last\s+)?(knowledge|training)|my\s+(knowledge|training)\s+(cut-?\s*off|only\s+goes)|knowledge\s+cut-?\s*off)/i;
  function refused(reply) { return REFUSED.test(String(reply || '')); }

  /** "do it", "yes go ahead": the user said yes to something the assistant offered. */
  function goAhead(text) { return /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|k|go(\s+ahead)?|do\s+it|go\s+for\s+it|proceed|please\s+do|pls\s+do|run\s+it|search|fetch\s+it|ya|haan|han|ji)\b[\s\w!.,]{0,24}$/i.test(String(text || '')); }
  /** The assistant's last message offered to search, look up or fetch something. */
  function offeredSearch(reply) { return /\b(search|look\s*(it\s*)?up|pull|fetch|grab|check|run\s+(a|the)?\s*(quick\s+)?search|find)\b/i.test(String(reply || '')); }

  /**
   * Research mode: several searches at once (the question, its news and its analysis), merged.
   * Resolves { text, sources }.
   */
  async function research(query, opts = {}) {
    const date = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const base = query.replace(new RegExp(`\\s*${date}$`), '');
    const queries = [query, `${base} latest news ${date}`, `${base} analysis and key players ${date}`];
    const all = await Promise.all(queries.map((q) => search(q, { ...opts, num: 8 }).catch(() => null)));
    const ok = all.filter(Boolean);
    if (!ok.length) throw new Error('the search did not work');
    const seen = new Set(); const sources = [];
    for (const r of ok) for (const x of r.sources) if (!seen.has(x.url)) { seen.add(x.url); sources.push(x); }
    return { text: ok.map((r, i) => `### Search ${i + 1}: "${queries[i]}"\n\n${r.text.slice(0, 9000)}`).join('\n\n'), sources: sources.slice(0, 16) };
  }

  /** How to answer from what was searched: short by default, a full report in Research mode. */
  function style(researchMode) {
    const today = new Date().toDateString();
    const truth = `Use only facts from these results. Never invent names, numbers, posts, quotes or links, and never present a model, product or version you remember as new or latest: your training data is older than today (${today}). If the results do not cover part of the question, say so in one line.`;
    if (researchMode) return `RESEARCH MODE: write a thorough, well-organised report: two lines of summary first, then ## sections with short bullets, a table only for a real comparison (every cell filled), and every fact linked to its source. ${truth}`;
    return `Reply SHORT: say what you found in 2 to 5 plain bullets (one line each, each with its source as a markdown link) or a few sentences. No tables, no headings, no plans, no "next steps", no offers or questions at the end. ${truth} The user will ask if they want more detail.`;
  }

  window.CodeplyWeb = { search, read, research, needsSearch, queryFor, linksIn, refused, sourcesOf, goAhead, offeredSearch, style };
})();
