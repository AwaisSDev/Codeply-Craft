/**
 * Turn a chat into something you can hand to someone else: a Markdown file, a
 * self-contained HTML page, or a secret GitHub gist. Everything is cleaned
 * first: keys and tokens are masked and your home folder and project path are
 * replaced, so a shared chat does not leak the machine it came from.
 */
const os = require('os');
const path = require('path');

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi,
  /((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Cleans one string for sharing. `cwd` is the project folder, if known. */
function scrub(text, cwd) {
  let s = String(text == null ? '' : text);
  for (const re of SECRET_PATTERNS) s = s.replace(re, (m, pre) => (typeof pre === 'string' ? `${pre}[hidden]` : '[hidden]'));
  const paths = [];
  if (cwd) paths.push([cwd, '<project>']);
  const home = os.homedir();
  if (home && home.length > 3) paths.push([home, '~']);
  for (const [from, to] of paths) {
    for (const v of new Set([from, from.replace(/\\/g, '/')])) s = s.replace(new RegExp(escapeRe(v), 'gi'), to);
  }
  return s;
}

/** The parts of a stored chat that belong in a shared copy. */
function collect(session, opts = {}) {
  const cwd = session.cwd || '';
  const clean = (t) => scrub(t, cwd);
  const items = [];
  for (const m of session.messages || []) {
    if (m.kind === 'user') items.push({ type: 'user', text: clean(m.text), images: (m.images || []).length });
    else if (m.kind === 'assistant' && m.text && !m.interim) items.push({ type: 'assistant', text: clean(m.text) });
    else if (m.kind === 'assistant' && m.text && opts.includeNarration) items.push({ type: 'narration', text: clean(m.text) });
    else if (m.kind === 'reasoning' && m.text && opts.includeThinking) items.push({ type: 'thinking', text: clean(m.text) });
    else if (m.kind === 'tool') items.push({ type: 'tool', name: m.name, label: clean(m.label || ''), ok: m.ok !== false });
    else if (m.kind === 'question') items.push({ type: 'question', question: clean(m.question), answer: m.answer ? clean(m.answer) : '' });
    else if (m.kind === 'notice' && m.level === 'error') items.push({ type: 'error', text: clean(m.text) });
  }
  return { title: clean(session.title || 'Chat'), project: cwd ? path.basename(cwd) : '', when: session.updatedAt || session.createdAt || null, items };
}

function toMarkdown(session, opts) {
  const c = collect(session, opts);
  const out = [`# ${c.title}`, ''];
  const meta = [c.project && `Project: ${c.project}`, c.when && new Date(c.when).toISOString().slice(0, 10), 'Made with Codeply Craft'].filter(Boolean);
  out.push(`_${meta.join(' - ')}_`, '');
  let tools = [];
  const flush = () => { if (tools.length) { out.push(...tools, ''); tools = []; } };
  for (const it of c.items) {
    if (it.type === 'tool') { tools.push(`- \`${it.name}\` ${it.label}${it.ok ? '' : ' (failed)'}`.trimEnd()); continue; }
    flush();
    if (it.type === 'user') out.push('## You', '', it.text + (it.images ? `\n\n_(${it.images} image${it.images === 1 ? '' : 's'} not included)_` : ''), '');
    else if (it.type === 'assistant') out.push('## Codeply', '', it.text, '');
    else if (it.type === 'narration') out.push(`> ${it.text.replace(/\n/g, '\n> ')}`, '');
    else if (it.type === 'thinking') out.push('<details><summary>Thinking</summary>', '', it.text, '', '</details>', '');
    else if (it.type === 'question') out.push(`> Asked: ${it.question}${it.answer ? ` - answered: ${it.answer}` : ''}`, '');
    else if (it.type === 'error') out.push(`> Error: ${it.text}`, '');
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A small, safe Markdown subset: everything is escaped first, then fences, code, bold, links, lists. */
function inline(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer nofollow">$1</a>');
}

function mdBlock(text) {
  const parts = String(text).split(/```/);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const lang = nl === -1 ? '' : part.slice(0, nl).trim();
      const code = nl === -1 ? part : part.slice(nl + 1);
      html += `<pre${lang ? ` data-lang="${esc(lang.slice(0, 20))}"` : ''}><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      return;
    }
    let list = null;
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const line of part.split('\n')) {
      const e = esc(line);
      let m;
      if ((m = /^\s*[-*]\s+(.*)$/.exec(e))) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(e))) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = /^#{1,6}\s+(.*)$/.exec(e))) { closeList(); html += `<p><strong>${inline(m[1])}</strong></p>`; }
      else if (e.trim()) { closeList(); html += `<p>${inline(e)}</p>`; }
      else closeList();
    }
    closeList();
  });
  return html;
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--card:#f5f5f7;--line:#e5e5ea;--acc:#5b5bd6}
@media(prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--mut:#9a9aa3;--card:#1f1f23;--line:#2c2c31;--acc:#8b8bf0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 20px 64px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--mut);font-size:13px;margin-bottom:28px}
.turn{margin:18px 0}.who{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);margin-bottom:4px}
.user .body{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px}.assistant .who{color:var(--acc)}
.body p{margin:.5em 0}.body ul,.body ol{margin:.5em 0;padding-left:1.4em}code{font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--card);border-radius:4px;padding:1px 5px}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow:auto;margin:.7em 0}pre code{background:none;padding:0}
.tools{margin:6px 0;padding:0;list-style:none;color:var(--mut);font-size:13px}.tools li{padding:1px 0}.tools .bad{color:#d1453b}.note{color:var(--mut);font-size:14px;border-left:3px solid var(--line);padding-left:10px;margin:10px 0}
.err{color:#d1453b}footer{margin-top:40px;color:var(--mut);font-size:12px}a{color:var(--acc)}details{color:var(--mut);font-size:13px}`;

function toHtml(session, opts) {
  const c = collect(session, opts);
  const meta = [c.project && esc(c.project), c.when && new Date(c.when).toISOString().slice(0, 10)].filter(Boolean).join(' &middot; ');
  let body = '';
  let tools = [];
  const flush = () => { if (tools.length) { body += `<ul class="tools">${tools.join('')}</ul>`; tools = []; } };
  for (const it of c.items) {
    if (it.type === 'tool') { tools.push(`<li${it.ok ? '' : ' class="bad"'}><code>${esc(it.name)}</code> ${esc(it.label)}${it.ok ? '' : ' (failed)'}</li>`); continue; }
    flush();
    if (it.type === 'user') body += `<div class="turn user"><div class="who">You</div><div class="body">${mdBlock(it.text)}${it.images ? `<p class="note">${it.images} image${it.images === 1 ? '' : 's'} not included</p>` : ''}</div></div>`;
    else if (it.type === 'assistant') body += `<div class="turn assistant"><div class="who">Codeply</div><div class="body">${mdBlock(it.text)}</div></div>`;
    else if (it.type === 'narration') body += `<div class="note">${mdBlock(it.text)}</div>`;
    else if (it.type === 'thinking') body += `<details><summary>Thinking</summary>${mdBlock(it.text)}</details>`;
    else if (it.type === 'question') body += `<div class="note">Asked: ${esc(it.question)}${it.answer ? ` &middot; answered: ${esc(it.answer)}` : ''}</div>`;
    else if (it.type === 'error') body += `<div class="note err">${esc(it.text)}</div>`;
  }
  flush();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(c.title)}</title><style>${CSS}</style></head><body><main><h1>${esc(c.title)}</h1><div class="meta">${meta}</div>${body}<footer>Made with Codeply Craft</footer></main></body></html>`;
}

/** Uploads the chat as a secret gist. Returns {ok, url} or {ok:false, error}. */
async function createGist(session, token, { fetchImpl = fetch, apiUrl = 'https://api.github.com', isPublic = false, ...opts } = {}) {
  if (!token) return { ok: false, error: 'No GitHub token.' };
  const c = collect(session, opts);
  const base = (c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'chat';
  let res;
  try {
    res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/gists`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'codeply-craft' },
      body: JSON.stringify({ description: `${c.title} (Codeply Craft)`.slice(0, 200), public: !!isPublic, files: { [`${base}.md`]: { content: toMarkdown(session, opts) } } }),
    });
  } catch (e) { return { ok: false, error: `Could not reach GitHub: ${e.message}` }; }
  let json = null;
  try { json = JSON.parse(await res.text()); } catch {}
  if (!res.ok) {
    const scopeHint = res.status === 404 || res.status === 403 ? ' Reconnect GitHub in Connect Apps so Craft can create gists.' : '';
    return { ok: false, error: `GitHub said ${res.status}${json && json.message ? `: ${json.message}` : ''}.${scopeHint}` };
  }
  return { ok: true, url: json.html_url, public: !!isPublic };
}

module.exports = { scrub, collect, toMarkdown, toHtml, createGist };
