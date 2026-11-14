// Apps: the whole catalogue, searchable, and really connectable.
//
// The catalogue is the official MCP Registry (registry.modelcontextprotocol.io), the same one
// the Electron app searches (codeply-cli/lib/apps.js). The registry has no category, count or
// ranking, so this crawls all of it in the background (100 apps a page, ~30 s), keeps what
// Codeply can connect to (a remote streamable-HTTP server, with or without an API key), sorts
// each app into a category, and caches it in DATA/apps-catalog.json.gz. Browsing and search
// then run on that index in memory, so they are instant and the count is real.
//
//   GET  /ext/apps?q=&cat=&offset=&limit=   one page, plus the counts and the connected apps
//   POST /ext/apps/connect {id, apiKey?}     sign in (browser) or save the key; progress is
//                                            streamed as `apps_progress` events
//   POST /ext/apps/add {url, title?, headerName?, apiKey?}   an app by its MCP server URL
//   POST /ext/apps/cancel                    stop the sign-in in progress
//   POST /ext/apps/disconnect {id}
//   GET  /ext/apps/tools?id=                 a connected app's tools
//   POST /ext/apps/refresh                   crawl the registry again
//
// A connected app is one more MCP server for lib/mcp.js, which reads ~/.codeply/apps.json on
// every call, so agents see it (use_app) on the next step without a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const REGISTRY = (process.env.CODEPLY_MCP_REGISTRY || 'https://registry.modelcontextprotocol.io').replace(/\/+$/, '');
const UA = 'Codeply (+https://codeply.app)';
const MAX_AGE_MS = 12 * 3600_000;
const PAGE_MAX = 120;

// ---------- categories ----------
// The registry carries none, so each app is sorted by what its name and description say. The
// first rule with the most hits wins; Featured apps keep the category Codeply gave them.
const CATEGORIES = [
  ['Developer', /\b(github|gitlab|bitbucket|git|code|coding|repo|repository|ide|debug\w*|lint\w*|compiler|sdk|npm|pypi|package|testing|unit test|pull request|commit|programming|developer|devtools|typescript|python|rust|golang|refactor|stack ?overflow|sentry|swagger|openapi|graphql)\b/gi],
  ['Cloud & DevOps', /\b(aws|azure|gcp|google cloud|cloudflare|kubernetes|k8s|docker|terraform|devops|deploy\w*|infrastructure|serverless|vercel|netlify|heroku|ci\/cd|pipeline|monitoring|observability|datadog|grafana|prometheus|server logs?|hosting|dns)\b/gi],
  ['Data & Analytics', /\b(database|sql|postgres\w*|mysql|sqlite|mongodb|redis|supabase|neon|snowflake|bigquery|analytics|dataset|data warehouse|etl|spreadsheet|csv|dashboard|metrics|vector|embeddings?|clickhouse|duckdb|query|elasticsearch|bi)\b/gi],
  ['AI & Agents', /\b(llm|agents?|agentic|ai model|openai|anthropic|claude|gemini|prompts?|rag|memory|inference|machine learning|ml|hugging ?face|model context protocol|mcp gateway|orchestrat\w*|image generation|text-to-|speech|transcri\w*)\b/gi],
  ['Research', /\b(search|research|web search|scrape|scraping|crawl\w*|documentation|docs|wikipedia|arxiv|papers?|academic|news|knowledge|browse|fetch|reference|library|librar\w+|encyclopedia)\b/gi],
  ['Productivity', /\b(notion|calendar|notes?|tasks?|todo|to-do|project management|kanban|jira|asana|trello|linear|confluence|obsidian|documents?|google drive|dropbox|files?|schedul\w*|reminders?|productivity|workspace|wiki|issues?|tickets?)\b/gi],
  ['Communication', /\b(email|e-?mail|gmail|slack|discord|telegram|whatsapp|sms|chat|messag\w*|teams|zoom|meetings?|calls?|inbox|outlook|newsletter|voice|twilio|mail)\b/gi],
  ['Business', /\b(crm|sales|marketing|hubspot|salesforce|customers?|leads?|support|helpdesk|zendesk|hr|recruit\w*|invoice\w*|erp|business|seo|ads?|advertis\w*|contacts?|campaigns?)\b/gi],
  ['Finance', /\b(finance|financial|payments?|stripe|bank\w*|crypto\w*|bitcoin|ethereum|blockchain|wallet|trading|stocks?|market data|accounting|quickbooks|tax|defi|token|invoice|billing|forex|solana)\b/gi],
  ['Commerce', /\b(shop\w*|e-?commerce|store|products?|orders?|inventory|retail|shopify|marketplace|travel|flights?|hotels?|booking|restaurants?|food|delivery|real estate|maps?|location|weather)\b/gi],
  ['Design & Media', /\b(design|figma|canva|image\w*|photos?|video\w*|audio|music|spotify|youtube|podcast|3d|blender|illustration|icons?|fonts?|ui|ux|css|animation|webflow|wix|creative|art)\b/gi],
  ['Security', /\b(security|vulnerabilit\w*|cve|pentest|malware|threat|auth\w*|secrets?|password|encryption|compliance|firewall|forensic\w*|osint|scan\w*)\b/gi],
  ['Social & Fun', /\b(twitter|x\.com|reddit|linkedin|instagram|facebook|tiktok|social|game\w*|gaming|minecraft|steam|fun|entertainment|movies?|anime|trivia|jokes?|chess)\b/gi],
];
const FEATURED_CATEGORY = { Design: 'Design & Media' };
const OTHER = 'Other';

function categorize(title, desc) {
  const t = String(title || '');
  const text = `${t} ${t} ${desc || ''}`;
  let best = OTHER;
  let bestHits = 0;
  for (const [name, re] of CATEGORIES) {
    re.lastIndex = 0;
    const hits = (text.match(re) || []).length;
    if (hits > bestHits) { best = name; bestHits = hits; }
  }
  return best;
}

// ---------- domains, for logos ----------
const SHARED_HOSTS = /(^|\.)(vercel\.app|netlify\.app|workers\.dev|pages\.dev|github\.io|herokuapp\.com|onrender\.com|railway\.app|fly\.dev|run\.app|azurewebsites\.net|ngrok[\w-]*\.\w+|trycloudflare\.com|glitch\.me|replit\.app|repl\.co|deno\.dev|supabase\.co|lambda-url\.[\w.-]+|amazonaws\.com|cloudfunctions\.net|web\.app|firebaseapp\.com|smithery\.ai|composio\.dev|mcp\.so|zapier\.com|localhost)$/i;
const TWO_PART = /^(co|com|org|net|gov|ac|edu)$/;

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }

/** "mcp.notion.com" -> "notion.com", "api.x.co.uk" -> "x.co.uk"; '' for hosts shared by many apps (their icon isn't the app's). */
function brandDomain(host) {
  if (!host || !host.includes('.') || SHARED_HOSTS.test(host)) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const n = parts.length >= 3 && TWO_PART.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** Reverse-DNS registry names ("com.notion/mcp") say whose server it is: notion.com. */
function nameDomain(name) {
  const ns = String(name).split('/')[0];
  if (/^io\.github\.|^io\.gitlab\.|^app\.|^dev\.|^me\.|^ai\.|^tech\./.test(ns) === false) {
    const labels = ns.split('.');
    if (labels.length >= 2) return brandDomain(labels.slice().reverse().join('.'));
  }
  return '';
}

function pickDomain(server, remoteUrl) {
  const site = hostOf(server.websiteUrl || '');
  if (site && !/^(github\.com|gitlab\.com|npmjs\.com|pypi\.org|huggingface\.co)$/.test(site)) { const d = brandDomain(site); if (d) return d; }
  return brandDomain(hostOf(remoteUrl)) || nameDomain(server.name) || '';
}

function prettyName(name) {
  const last = String(name).split('/').pop() || name;
  return last.replace(/[-_.]+/g, ' ').replace(/\b(mcp|server)\b/gi, '').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || last;
}

// ---------- the index ----------
// Entry: { id (registry name), title, desc, url, domain, icon, cat, rank, header, tmpl, feat, s }
let index = [];
let byId = new Map();
let state = { phase: 'idle', loaded: 0, at: 0, error: '' }; // phase: idle | crawling | error
let crawling = null;
let cachePath = '';

function entryFromServer(row) {
  const s = row.server || {};
  if (!s.name) return null;
  const status = row._meta?.['io.modelcontextprotocol.registry/official']?.status;
  if (status && status !== 'active') return null;
  for (const r of s.remotes || []) {
    if (r.type !== 'streamable-http' || !r.url || /[{}]/.test(r.url)) continue;
    if (r.variables && Object.keys(r.variables).length) continue;
    if (!/^https:\/\//.test(r.url)) continue;
    const need = (r.headers || []).filter((h) => h.isRequired);
    if (need.length > 1) continue; // one key is a form; several are a project
    const header = need[0] ? String(need[0].name || '') : '';
    if (need[0] && !/^[A-Za-z0-9-]{1,64}$/.test(header)) continue;
    const title = String(s.title || '').trim().slice(0, 60) || prettyName(s.name);
    const desc = String(s.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const icons = Array.isArray(s.icons) ? s.icons : [];
    const icon = (icons.find((i) => /^https:\/\//.test(i.src || '') && /png|jpe?g|webp/.test(i.mimeType || i.src)) || icons.find((i) => /^https:\/\//.test(i.src || '')))?.src || '';
    const domain = pickDomain(s, r.url);
    const own = domain && brandDomain(hostOf(r.url)) === domain;
    let rank = (icon ? 3 : 0) + (domain ? 2 : 0) + (own ? 3 : 0) + (desc.length >= 60 ? 1 : 0) + (s.websiteUrl ? 1 : 0) - (header ? 1 : 0);
    if (!/^[a-z]/i.test(title)) rank -= 1;
    if (/\b(test|demo|example|hello|sample|playground)\b/i.test(`${title} ${s.name}`)) rank -= 5;
    return { id: s.name, title, desc, url: r.url, domain, icon, cat: categorize(title, desc), rank, header, tmpl: need[0]?.value || '', feat: false };
  }
  return null;
}

function finish(e) {
  e.s = `${e.title} ${e.id} ${e.desc} ${e.domain}`.toLowerCase();
  e.tl = e.title.toLowerCase();
  return e;
}

function featuredEntries(apps) {
  return apps.FEATURED.map((f, i) => finish({
    id: f.id, title: f.title, desc: f.description, url: f.url, domain: f.domain, icon: '',
    cat: FEATURED_CATEGORY[f.category] || f.category || OTHER, rank: 1000 - i, header: '', tmpl: '', feat: true, registry: f.registry,
  }));
}

/** Featured first, then by rank; one entry per server URL. */
function build(feat, found) {
  const seen = new Set(feat.map((f) => f.url));
  const rest = [];
  for (const e of found) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    rest.push(finish(e));
  }
  rest.sort((a, b) => b.rank - a.rank || a.tl.localeCompare(b.tl));
  return [...feat, ...rest];
}

function install(list) {
  index = list;
  byId = new Map(list.map((e) => [e.id, e]));
}

function save() {
  try {
    const rows = index.filter((e) => !e.feat).map((e) => [e.id, e.title, e.desc, e.url, e.domain, e.icon, e.cat, e.rank, e.header, e.tmpl]);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ at: state.at, rows })));
    fs.renameSync(tmp, cachePath);
  } catch {}
}

function loadCache(apps) {
  try {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath)).toString('utf8'));
    const found = j.rows.map(([id, title, desc, url, domain, icon, cat, rank, header, tmpl]) => ({ id, title, desc, url, domain, icon, cat, rank, header, tmpl, feat: false }));
    install(build(featuredEntries(apps), found));
    state = { phase: 'idle', loaded: found.length, at: j.at || 0, error: '' };
    return true;
  } catch { return false; }
}

async function getPage(cursor) {
  const params = new URLSearchParams({ version: 'latest', limit: '100' });
  if (cursor) params.set('cursor', cursor);
  let err;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${REGISTRY}/v0.1/servers?${params}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status >= 500) { err = new Error(`The MCP Registry answered HTTP ${res.status}.`); await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`The MCP Registry answered HTTP ${res.status}.`);
      return await res.json();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new Error(`Couldn't reach the MCP Registry: ${err?.cause?.code || err?.message || err}`);
}

/** Crawl the whole registry. While there is no cache yet, the index grows as pages land. */
function crawl(ctx) {
  if (crawling) return crawling;
  const apps = ctx.need('apps.js');
  const feat = featuredEntries(apps);
  const hadIndex = index.length > feat.length;
  state = { ...state, phase: 'crawling', loaded: 0, error: '' };
  crawling = (async () => {
    const found = [];
    let cursor = '';
    let pages = 0;
    try {
      do {
        const j = await getPage(cursor);
        for (const row of j.servers || []) { const e = entryFromServer(row); if (e) found.push(e); }
        cursor = j.metadata?.nextCursor || '';
        pages++;
        state.loaded = found.length;
        if (!hadIndex && pages % 15 === 0) { install(build(feat, found)); ctx.emit(null, { type: 'apps_catalog' }); }
      } while (cursor && pages < 1500);
      install(build(feat, found));
      state = { phase: 'idle', loaded: found.length, at: Date.now(), error: '' };
      save();
    } catch (e) {
      state = { ...state, phase: 'error', error: e.message };
      if (!hadIndex && found.length) install(build(feat, found));
    } finally {
      crawling = null;
      ctx.emit(null, { type: 'apps_catalog' });
    }
  })();
  return crawling;
}

// ---------- query ----------
function connectedMap(apps) {
  const list = apps.listConnected();
  return { list, byUrl: new Map(list.map((a) => [a.url, a])) };
}

function row(e, c) {
  const k = c.byUrl.get(e.url);
  return {
    id: k ? k.id : e.id, name: e.title, note: e.desc, category: e.cat, connected: !!k, domain: e.domain, icon: e.icon,
    verified: e.feat, needsKey: !!e.header, keyHeader: e.header, ...(k ? { needsReconnect: !!k.needsReconnect, tools: k.toolCount, account: k.account, auth: k.auth } : {}),
  };
}

function search(q, cat) {
  const tokens = String(q || '').toLowerCase().split(/[^a-z0-9.+#]+/).filter(Boolean).slice(0, 6);
  const out = [];
  const counts = new Map();
  const phrase = tokens.join(' ');
  for (const e of index) {
    let score = 0;
    if (tokens.length) {
      let ok = true;
      for (const t of tokens) if (!e.s.includes(t)) { ok = false; break; }
      if (!ok) continue;
      if (e.tl === phrase) score += 100;
      else if (e.tl.startsWith(phrase)) score += 50;
      for (const t of tokens) if (e.tl.includes(t)) score += 10;
      if (e.feat) score += 20;
      const ns = e.id.split('/')[0].split('.');
      for (const t of tokens) if (ns.includes(t)) score += 25; // the vendor's own namespace: com.notion/...
    }
    counts.set(e.cat, (counts.get(e.cat) || 0) + 1);
    if (cat && e.cat !== cat) continue;
    out.push(tokens.length ? [score, e] : [0, e]);
  }
  if (tokens.length) out.sort((a, b) => b[0] - a[0] || b[1].rank - a[1].rank);
  return { hits: out.map((x) => x[1]), counts };
}

function categoriesOf(counts) {
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name === OTHER) - (b.name === OTHER) || b.count - a.count);
}

// ---------- connecting ----------
let active = null; // { id, name, ctl }

function view(a) { return a ? { id: a.id, name: a.title, note: a.description || '', category: a.category || '', connected: true, domain: a.domain || '', icon: a.icon || '', needsReconnect: !!a.needsReconnect, tools: a.toolCount || 0, account: a.account || '', auth: a.auth || '' } : null; }

async function toolsOf(ctx, id) {
  const mcp = ctx.need('mcp.js');
  const list = await mcp.listServers(os.homedir());
  const mine = list.find((s) => s.name === id);
  if (!mine) return { error: 'That app is not connected.' };
  const tools = (mine.tools || []).map((t) => ({ name: t.name, title: t.title || t.annotations?.title || '', description: String(t.description || '').slice(0, 240), readOnly: !!t.annotations?.readOnlyHint }));
  return { tools, error: mine.error || '' };
}

function progress(ctx, id, name, st, message) {
  ctx.emit(null, { type: 'apps_progress', id, name, state: st, message });
}

/** After sign-in: connect to the app now, so a broken server shows here and not in the middle of a chat. */
async function verify(ctx, apps, id) {
  const mcp = ctx.need('mcp.js');
  mcp.forget(id);
  const r = await toolsOf(ctx, id).catch((e) => ({ error: e.message, tools: [] }));
  if (!r.error) apps.noteStatus(id, { toolCount: r.tools.length });
  return r;
}

async function run(ctx, id, name, job) {
  if (active) return { error: `${active.name} is signing in right now. Finish or cancel that one first.` };
  const ctl = new AbortController();
  active = { id, name, ctl };
  progress(ctx, id, name, 'start', `Connecting ${name}...`);
  (async () => {
    try {
      const app = await job(ctl.signal);
      const r = await verify(ctx, ctx.need('apps.js'), app.id);
      if (r.error) progress(ctx, id, name, 'warn', `Connected, but ${name} did not answer: ${r.error}`);
      else progress(ctx, id, name, 'done', `${name} is connected${r.tools.length ? ` with ${r.tools.length} tools` : ''}.`);
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      if (/cancelled/i.test(m)) progress(ctx, id, name, 'cancelled', `Sign-in to ${name} cancelled.`);
      else progress(ctx, id, name, 'error', `Couldn't connect ${name}: ${m}`);
    } finally {
      active = null;
      ctx.emit(null, { type: 'apps_changed' });
    }
  })();
  return { ok: true };
}

function openBrowser(ctx, id, name) {
  return (u) => {
    if (!/^https:\/\//i.test(String(u))) throw new Error('That app\'s sign-in page is not https, so Codeply will not open it.');
    ctx.emit(null, { type: 'open_url', url: u });
    progress(ctx, id, name, 'waiting', `Finish signing in to ${name} in your browser...`);
  };
}

function keyValue(entry, key) {
  const t = entry.tmpl || '';
  return t.includes('{') ? t.replace(/\{[^}]*\}/g, key) : key;
}

/** Save an app that takes an API key, then check it works; a key that doesn't is removed again. */
async function addWithKey(ctx, apps, entry, header, key) {
  const app = apps.addWithHeader({ url: entry.url, title: entry.title }, header, key);
  const st = apps._internal.readStore();
  const saved = st.apps[app.id];
  if (saved) {
    Object.assign(saved, { description: entry.desc || '', domain: entry.domain || saved.domain, icon: entry.icon || '', category: entry.cat || '', registry: entry.registry || (entry.feat ? '' : entry.id), source: entry.feat || entry.registry ? 'registry' : 'custom' });
    apps._internal.writeStore(st);
  }
  const r = await verify(ctx, apps, app.id);
  if (r.error) {
    apps.removeApp(app.id);
    ctx.need('mcp.js').forget(app.id);
    throw new Error(/fetch failed/.test(r.error) ? "couldn't reach that server" : `the server refused it (${r.error})`);
  }
  return app;
}

export function start(ctx) {
  cachePath = path.join(ctx.DATA, 'apps-catalog.json.gz');
  let apps;
  try { apps = ctx.need('apps.js'); } catch (e) { ctx.missing['ext-apps.mjs'] = e.message; return; }
  install(featuredEntries(apps));
  const warm = loadCache(apps);
  ctx.shared.apps = { index: () => index };
  if (!warm || Date.now() - state.at > MAX_AGE_MS) setTimeout(() => crawl(ctx), 1500).unref?.();
}

export async function route(ctx, req, res, url, p, reply) {
  if (!p.startsWith('/ext/apps')) return false;
  const apps = ctx.need('apps.js');
  const q = url.searchParams;

  if (req.method === 'GET' && p === '/ext/apps') {
    const query = (q.get('q') || '').trim().slice(0, 80);
    const cat = (q.get('cat') || '').trim();
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    const limit = Math.min(PAGE_MAX, Math.max(1, Number(q.get('limit')) || 60));
    const c = connectedMap(apps);
    const { hits, counts } = search(query, cat);
    let error = state.phase === 'error' && !index.some((e) => !e.feat) ? state.error : '';
    let page = hits.slice(offset, offset + limit).map((e) => row(e, c));
    let total = hits.length;
    // No catalogue yet (first launch, offline): ask the registry directly for what was typed.
    if (query && !index.some((e) => !e.feat) && !crawling) {
      try {
        const r = await apps.searchRegistry(query);
        error = r.error || '';
        const seen = new Set(page.map((x) => x.name));
        for (const a of r.apps || []) if (!seen.has(a.title)) page.push({ id: a.connectedId || a.id || a.registry, name: a.title, note: a.description, category: categorize(a.title, a.description), connected: !!a.connectedId, domain: brandDomain(a.domain) || '', icon: a.icon || '', verified: !!a.verified, needsKey: false, keyHeader: '' });
        total = page.length;
      } catch (e) { error = e.message; }
    }
    return reply(200, {
      apps: page, total, offset, catalog: index.length, categories: categoriesOf(counts),
      connected: c.list.map(view), indexing: { phase: state.phase, loaded: state.loaded, at: state.at, error: state.error }, ...(error ? { error } : {}),
    }), true;
  }

  if (req.method === 'GET' && p === '/ext/apps/status') {
    return reply(200, { catalog: index.length, ...state, signingIn: active ? { id: active.id, name: active.name } : null }), true;
  }

  if (req.method === 'POST' && p === '/ext/apps/refresh') {
    crawl(ctx);
    return reply(202, { ok: true }), true;
  }

  if (req.method === 'POST' && p === '/ext/apps/cancel') {
    if (active) active.ctl.abort();
    return reply(200, { ok: true }), true;
  }

  if (req.method === 'POST' && p === '/ext/apps/connect') {
    const body = await ctx.readJson(req);
    const id = String(body.id || '');
    const stored = apps.getApp(id);
    // A connected app signs in again in place; otherwise the catalogue entry has what to connect to.
    const entry = stored
      ? { id: stored.id, title: stored.title, desc: stored.description, url: stored.url, domain: stored.domain, icon: stored.icon, cat: stored.category, registry: stored.registry, header: stored.auth?.type === 'header' ? Object.keys(stored.auth.headers || {})[0] || '' : '', tmpl: '', feat: stored.source === 'featured' }
      : byId.get(id);
    if (!entry) return reply(404, { error: 'Unknown app. Search the catalogue and connect it from the list.' }), true;
    const apiKey = String(body.apiKey || '').trim();
    if (entry.header) {
      if (!apiKey) return reply(400, { error: `${entry.title} needs an API key. Paste it to connect.` }), true;
      const r = await run(ctx, id, entry.title, async () => addWithKey(ctx, apps, entry, entry.header, keyValue(entry, apiKey)));
      return reply(r.error ? 409 : 202, r), true;
    }
    const r = await run(ctx, id, entry.title, (signal) => apps.connect(
      { id: entry.feat ? entry.id : '', url: entry.url, title: entry.title, description: entry.desc, domain: entry.domain, category: entry.cat, registry: entry.registry || (entry.feat ? '' : entry.id), icon: entry.icon },
      { openBrowser: openBrowser(ctx, id, entry.title), signal },
    ));
    return reply(r.error ? 409 : 202, r), true;
  }

  if (req.method === 'POST' && p === '/ext/apps/add') {
    const body = await ctx.readJson(req);
    let u;
    try { u = new URL(String(body.url || '').trim()); } catch { return reply(400, { error: 'That is not a valid URL.' }), true; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return reply(400, { error: 'An app\'s server must be an https:// URL.' }), true;
    const title = String(body.title || '').trim().slice(0, 60) || prettyName(u.hostname.replace(/^(mcp|api)\./, '').split('.')[0]);
    const entry = { id: '', title, desc: '', url: u.href, domain: brandDomain(u.hostname), icon: '', cat: '', header: '', feat: false };
    const header = String(body.headerName || '').trim();
    const apiKey = String(body.apiKey || '').trim();
    if (header || apiKey) {
      if (!header || !apiKey) return reply(400, { error: 'Give both the header name and the key.' }), true;
      const r = await run(ctx, u.href, title, async () => addWithKey(ctx, apps, entry, header, apiKey));
      return reply(r.error ? 409 : 202, r), true;
    }
    const r = await run(ctx, u.href, title, (signal) => apps.connect({ url: u.href, title }, { openBrowser: openBrowser(ctx, u.href, title), signal }));
    return reply(r.error ? 409 : 202, r), true;
  }

  if (req.method === 'POST' && p === '/ext/apps/disconnect') {
    const body = await ctx.readJson(req);
    const id = String(body.id || '');
    const ok = apps.removeApp(id);
    ctx.need('mcp.js').forget(id);
    ctx.emit(null, { type: 'apps_changed' });
    return reply(ok ? 200 : 404, ok ? { ok: true } : { error: 'That app is not connected.' }), true;
  }

  if (req.method === 'GET' && p === '/ext/apps/tools') {
    const r = await toolsOf(ctx, String(q.get('id') || '')).catch((e) => ({ error: e.message }));
    if (r.tools && !r.error) apps.noteStatus(String(q.get('id')), { toolCount: r.tools.length });
    return reply(200, r), true;
  }

  return false;
}

export const _test = { categorize, brandDomain, entryFromServer, search: (q, cat) => search(q, cat), install, build, finish };
