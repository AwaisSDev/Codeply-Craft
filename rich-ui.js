// Rich replies for Craft's chat: the agent's Markdown drawn as real, readable
// UI instead of plain paragraphs, like ChatGPT and Claude do.
//
//  - Headings in six sizes, bold, italic, strike, highlight, links, quotes,
//    dividers, numbered / nested / task lists, aligned tables.
//  - Colour and pills: :green[text], :pill-amber[Pending], :kbd[Ctrl+K].
//  - Callouts: a quote that opens with [!NOTE] / [!TIP] / [!WARNING] ...
//  - ```doc Title     a document card with Copy and Expand.
//  - ```widget Title  a small interactive mini-app (sliders, playgrounds,
//    charts) that runs in a sandboxed, offline frame inside the chat.
//  - Code blocks with a Copy button.
//
// Everything is escaped before any markup is added, so model text can never
// inject HTML into the app. Widget HTML only ever runs inside an
// <iframe sandbox="allow-scripts"> with an opaque origin and a CSP that
// blocks every network request: it can't reach the app, its preload, the
// user's files or the internet.
//
// Also owns the reader's typography settings (text size, font, spacing,
// width), the "Aa" menu in the chat's top bar.
(function () {
  'use strict';

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ─── Inline ───────────────────────────────────────────────────────────────
  // Models occasionally slip LaTeX arrows into prose ("A $\rightarrow$ B").
  const LATEX_TOKEN = /\$?\\(rightarrow|Rightarrow|leftrightarrow|Leftrightarrow|leftarrow|Leftarrow|to|times|cdot|approx|neq|leq|geq|pm|infty)\$?/g;
  const LATEX_MAP = {
    rightarrow: '→', to: '→', Rightarrow: '⇒', leftarrow: '←', Leftarrow: '⇐',
    leftrightarrow: '↔', Leftrightarrow: '⇔', times: '×', cdot: '·', approx: '≈',
    neq: '≠', leq: '≤', geq: '≥', pm: '±', infty: '∞',
  };

  const COLORS = {
    green: 'green', success: 'green', red: 'red', danger: 'red', error: 'red',
    blue: 'blue', info: 'blue', amber: 'amber', orange: 'amber', yellow: 'amber', warning: 'amber', warn: 'amber',
    purple: 'purple', violet: 'purple', gray: 'gray', grey: 'gray', muted: 'gray',
  };

  function directive(name, text) {
    if (name === 'kbd') return `<kbd class="rx-kbd">${text}</kbd>`;
    if (name === 'pill' || name === 'badge') return `<span class="rx-pill">${text}</span>`;
    const pill = /^(?:pill|badge)-([a-z]+)$/.exec(name);
    if (pill && COLORS[pill[1]]) return `<span class="rx-pill rx-pill-${COLORS[pill[1]]}">${text}</span>`;
    if (COLORS[name]) return `<span class="rx-c-${COLORS[name]}">${text}</span>`;
    return null;
  }

  /** One line of already-escaped text to inline HTML. */
  function inline(src) {
    const keep = [];
    const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    let s = src
      .replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`))
      .replace(LATEX_TOKEN, (_, n) => LATEX_MAP[n] || '');
    // [text](url) and bare links. Only web and mail links become links.
    s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, t, u) => hold(`<a class="rx-link" href="${u}" data-rx="link">${t}</a>`));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)\u0000]+[^\s<).,;:!?'\u0000])/g, (_, pre, u) => pre + hold(`<a class="rx-link" href="${u}" data-rx="link">${u}</a>`));
    s = s.replace(/:([a-z]+(?:-[a-z]+)?)\[([^\]\n]+)\]/g, (m, name, text) => directive(name, text) ?? m);
    s = s
      .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([^_\n]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>')
      .replace(/==(?=\S)([^=\n]*?\S)==/g, '<mark class="rx-mark">$1</mark>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
  }

  // ─── Blocks ───────────────────────────────────────────────────────────────
  const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*(.*?)\s*$/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const LIST_ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;

  const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const unquote = (t) => t.replace(/^(["'])(.*)\1$/, '$2');

  function startsBlock(line, next) {
    return FENCE_OPEN.test(line) || HEADING.test(line) || HR.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) ||
      (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
  }

  function render(text, opts = {}) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    return blocks(lines, opts);
  }

  function blocks(lines, opts) {
    let out = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const f = FENCE_OPEN.exec(line);
      if (f) {
        const mark = f[1];
        const body = [];
        let closed = false;
        i++;
        while (i < lines.length) {
          const c = lines[i].trim();
          if (c[0] === mark[0] && /^(`{3,}|~{3,})$/.test(c) && c.length >= mark.length) { closed = true; i++; break; }
          body.push(lines[i]);
          i++;
        }
        out += fence(f[2].toLowerCase(), unquote(f[3]), body.join('\n'), opts, closed);
        continue;
      }

      const h = HEADING.exec(line);
      if (h) {
        const n = h[1].length;
        out += `<h${n} class="rx-h rx-h${n}">${inline(esc(h[2]))}</h${n}>`;
        i++;
        continue;
      }

      if (HR.test(line)) { out += '<hr class="rx-hr">'; i++; continue; }

      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
        out += quote(body, opts);
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const rows = [line];
        const sep = lines[i + 1];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(lines[i++]);
        out += table(rows, sep);
        continue;
      }

      if (LIST_ITEM.test(line)) {
        const start = i;
        const base = indentOf(line);
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            // A blank line continues the list only if more of it follows.
            const nx = lines[i + 1];
            if (nx !== undefined && nx.trim() && (indentOf(nx) > base || (LIST_ITEM.test(nx) && indentOf(nx) >= base))) { i++; continue; }
            break;
          }
          if (indentOf(l) > base) { i++; continue; }
          if (LIST_ITEM.test(l) && indentOf(l) >= base) { i++; continue; }
          break;
        }
        out += list(lines.slice(start, i), base, opts);
        continue;
      }

      // Paragraph: runs until a blank line or the start of another block.
      const para = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
      out += `<p>${para.map((p) => inline(esc(p))).join('<br>')}</p>`;
    }
    return out;
  }

  function list(lines, base, opts) {
    // Split into items at the base indent; deeper lines belong to the item above.
    const items = [];
    for (const l of lines) {
      const m = LIST_ITEM.exec(l);
      if (m && indentOf(l) === base) items.push({ marker: m[2], first: m[3], rest: [] });
      else if (items.length) items[items.length - 1].rest.push(l);
    }
    if (!items.length) return '';
    const ordered = /\d/.test(items[0].marker);
    const startNum = ordered ? parseInt(items[0].marker, 10) : 1;
    const isTask = (t) => /^\[( |x|X)\]\s+/.test(t);
    const tasks = items.some((it) => isTask(it.first));
    let html = '';
    for (const it of items) {
      let first = it.first;
      let check = '';
      if (isTask(first)) {
        const done = /^\[(x|X)\]/.test(first);
        check = `<input type="checkbox" class="rx-check" data-rx="check"${done ? ' checked' : ''} aria-label="Done">`;
        first = first.replace(/^\[( |x|X)\]\s+/, '');
      }
      const rest = it.rest.filter((l, k, a) => l.trim() || k < a.length - 1);
      let sub = '';
      if (rest.length) {
        const cut = Math.min(...rest.filter((l) => l.trim()).map(indentOf));
        // Lines that are only a deeper continuation of the text join it.
        const deeper = rest.map((l) => l.replace(/\t/g, '    ').slice(Math.min(cut, indentOf(l))));
        if (!LIST_ITEM.test(deeper[0]) && !FENCE_OPEN.test(deeper[0]) && deeper[0].trim()) {
          let k = 0;
          while (k < deeper.length && deeper[k].trim() && !startsBlock(deeper[k], deeper[k + 1])) first += '\n' + deeper[k++].trim();
          sub = blocks(deeper.slice(k), opts);
        } else sub = blocks(deeper, opts);
      }
      const text = first.split('\n').map((p) => inline(esc(p))).join('<br>');
      html += `<li${check ? ' class="rx-task"' : ''}>${check}${check ? `<span>${text}</span>` : text}${sub}</li>`;
    }
    const tag = ordered ? 'ol' : 'ul';
    const attrs = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
    return `<${tag} class="rx-list${tasks ? ' rx-tasks' : ''}"${attrs}>${html}</${tag}>`;
  }

  const CALLOUTS = {
    note: ['Note', 'blue', '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'],
    info: ['Info', 'blue', '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'],
    tip: ['Tip', 'green', '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/>'],
    success: ['Done', 'green', '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>'],
    important: ['Important', 'purple', '<path d="M4 5h16v11H9l-5 4Z"/><path d="M12 8v3"/><path d="M12 13.5h.01"/>'],
    warning: ['Warning', 'amber', '<path d="M12 3 2 20h20Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>'],
    caution: ['Caution', 'red', '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8Z"/><path d="M12 8v5"/><path d="M12 16h.01"/>'],
    danger: ['Danger', 'red', '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8Z"/><path d="M12 8v5"/><path d="M12 16h.01"/>'],
  };

  function callout(kind, title, bodyHtml) {
    const [label, color, icon] = CALLOUTS[kind] || CALLOUTS.note;
    return `<div class="rx-callout rx-callout-${color}" role="note"><div class="rx-callout-head"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${title ? inline(esc(title)) : label}</span></div>${bodyHtml ? `<div class="rx-callout-body">${bodyHtml}</div>` : ''}</div>`;
  }

  function quote(body, opts) {
    const m = /^\s*\[!(\w+)\]\s*(.*)$/.exec(body[0] || '');
    if (m && CALLOUTS[m[1].toLowerCase()]) return callout(m[1].toLowerCase(), m[2], blocks(body.slice(1), opts));
    return `<blockquote class="rx-quote">${blocks(body, opts)}</blockquote>`;
  }

  function table(rows, sep) {
    const cells = (l) => {
      let t = l.trim();
      if (t.startsWith('|')) t = t.slice(1);
      if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
      return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    };
    const align = cells(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
    const head = cells(rows[0]);
    // A column that is all numbers lines up on the right, like a spreadsheet.
    const body = rows.slice(1).map(cells);
    const numeric = head.map((_, k) => body.length > 0 && body.every((r) => /^[-+]?[$€£]?\d[\d,.]*\s*(%|x|ms|s|k|m|gb|mb)?$/i.test(r[k] || '')));
    const a = (k) => {
      const v = align[k] || (numeric[k] ? 'right' : '');
      return v ? ` style="text-align:${v}"` : '';
    };
    const th = head.map((c, k) => `<th${a(k)}>${inline(esc(c))}</th>`).join('');
    const tb = body.map((r) => `<tr>${head.map((_, k) => `<td${a(k)}>${inline(esc(r[k] || ''))}</td>`).join('')}</tr>`).join('');
    return `<div class="rx-table-wrap"><table class="rx-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
  }

  // ─── Fenced blocks: code, documents, callouts, widgets ───────────────────
  const ICON = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M20 4l-7 7"/><path d="M4 20l7-7"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/></svg>',
    reload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>',
    doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/></svg>',
  };
  const btn = (act, icon, label) => `<button class="rx-btn" type="button" data-rx="${act}" title="${label}" aria-label="${label}">${icon}</button>`;
  const raw = (text) => `<template class="rx-raw">${esc(text)}</template>`;

  function fence(lang, info, body, opts, closed) {
    if (lang === 'doc' || lang === 'document' || lang === 'writing') {
      const title = info || 'Document';
      return `<div class="rx-doc">${raw(body)}<div class="rx-doc-head"><span class="rx-doc-kind">${ICON.doc}Document</span><span class="rx-grow"></span>` +
        `${btn('copy-doc', ICON.copy, 'Copy')}${btn('expand-doc', ICON.expand, 'Expand')}</div>` +
        `<div class="rx-doc-body"><h2 class="rx-doc-title">${inline(esc(title))}</h2>${blocks(body.split('\n'), opts)}</div></div>`;
    }
    if (lang === 'callout' || lang === 'note' || lang === 'tip' || lang === 'warning' || lang === 'important' || lang === 'caution') {
      const words = info.split(/\s+/);
      let kind = lang === 'callout' ? (words[0] || 'note').toLowerCase() : lang;
      let title = lang === 'callout' ? words.slice(1).join(' ') : info;
      if (!CALLOUTS[kind]) { title = info; kind = 'note'; }
      return callout(kind, unquote(title), blocks(body.split('\n'), opts));
    }
    // A finished reply whose widget never closed is shown as its code.
    if ((lang === 'widget' || lang === 'ui' || lang === 'interactive') && (closed || opts.live)) {
      const title = info || 'Interactive';
      // While a reply is still arriving the widget isn't whole yet: a quiet
      // placeholder, not a frame that reloads on every new word.
      if (opts.live) {
        return `<div class="rx-widget rx-widget-pending"><div class="rx-widget-head"><span class="rx-widget-kind">${ICON.spark}${inline(esc(title))}</span></div><div class="rx-widget-wait"><span class="rx-dots"><i></i><i></i><i></i></span>Building the widget</div></div>`;
      }
      return `<div class="rx-widget">${raw(body)}<div class="rx-widget-head"><span class="rx-widget-kind">${ICON.spark}${inline(esc(title))}</span><span class="rx-grow"></span>` +
        `${btn('widget-source', ICON.code, 'Show code')}${btn('widget-reload', ICON.reload, 'Restart')}${btn('widget-expand', ICON.expand, 'Expand')}</div>` +
        `<iframe class="rx-frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" loading="lazy" title="${esc(title)}" srcdoc="${esc(widgetDoc(body))}"></iframe>` +
        `<pre class="rx-widget-src hidden"><code>${esc(body)}</code></pre></div>`;
    }
    const label = lang || 'code';
    return `<div class="code-card rx-code">${raw(body)}<div class="code-card-head"><span>${esc(label)}</span>${btn('copy-code', ICON.copy, 'Copy code')}</div><pre><code>${esc(body)}</code></pre></div>`;
  }

  // ─── Widget frames ────────────────────────────────────────────────────────
  // The widget's page: the app's colours as CSS variables, tidy defaults for
  // controls, a CSP that blocks every network request, and a tiny script that
  // reports the page's height so the frame grows to fit it.
  function themeVars() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    return {
      bg: v('--main-bg', '#191919'), surface: v('--card-bg', '#202020'), surface2: v('--surface-2', '#2b2b2b'),
      text: v('--text', '#ececec'), dim: v('--text-dim', '#ababab'), faint: v('--text-faint', '#8a8a8a'),
      border: v('--border', '#2a2a2a'), control: v('--control-bg', '#272727'), controlBorder: v('--control-border', '#363636'),
      accent: v('--accent', '#3d8bfd'), green: v('--green', '#4cc38a'), red: v('--red', '#ef6a5a'), amber: v('--warn', '#f0883e'),
      font: v('--font-ui', 'system-ui, sans-serif'), mono: v('--font-mono', 'ui-monospace, monospace'),
      scheme: document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    };
  }

  function widgetDoc(body) {
    const t = themeVars();
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; media-src data: blob:">';
    const base = `<style>
:root{color-scheme:${t.scheme};--bg:${t.bg};--surface:${t.surface};--surface-2:${t.surface2};--text:${t.text};--text-dim:${t.dim};--text-faint:${t.faint};--border:${t.border};--control:${t.control};--control-border:${t.controlBorder};--accent:${t.accent};--green:${t.green};--red:${t.red};--amber:${t.amber};--font:${t.font};--mono:${t.mono}}
*{box-sizing:border-box}
html{background:var(--surface)}html,body{margin:0;color:var(--text);font:14px/1.55 var(--font)}
body{background:var(--surface);padding:14px 16px 16px;overflow-x:hidden}
h1,h2,h3,h4{margin:0 0 .5em;line-height:1.25}
p{margin:0 0 .75em}
button{font:inherit;font-size:13px;color:var(--text);background:var(--control);border:1px solid var(--control-border);border-radius:999px;padding:6px 14px;cursor:pointer;transition:background .15s,border-color .15s,transform .1s}
button:hover{border-color:var(--text-faint)}button:active{transform:scale(.97)}
button.primary,button[data-primary]{background:var(--text);color:var(--bg);border-color:var(--text)}
button.on,button[aria-pressed="true"]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 16%,transparent)}
button:disabled{opacity:.45;cursor:default}
input,select,textarea{font:inherit;font-size:13px;color:var(--text);background:var(--control);border:1px solid var(--control-border);border-radius:8px;padding:6px 9px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
input[type=range]{-webkit-appearance:none;appearance:none;background:transparent;border:0;padding:0;height:22px;width:100%}
input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:4px;background:var(--control-border)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--text);margin-top:-6px;box-shadow:0 1px 3px rgba(0,0,0,.35)}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);width:15px;height:15px;padding:0}
label{color:var(--text-dim);font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:left}th{color:var(--text-dim);font-weight:600}
code,pre{font-family:var(--mono);font-size:12.5px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.muted{color:var(--text-dim)}
</style>`;
    const report = '<script>(function(){var last=0;function send(){var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h!==last){last=h;parent.postMessage({craftWidget:1,height:h},"*")}}' +
      'addEventListener("load",send);if(window.ResizeObserver)new ResizeObserver(send).observe(document.documentElement);setInterval(send,600);send();' +
      'addEventListener("error",function(e){var d=document.createElement("div");d.style.cssText="margin-top:10px;padding:8px 10px;border-radius:8px;font:12px var(--mono);color:var(--red);background:color-mix(in srgb,var(--red) 12%,transparent)";d.textContent="Widget error: "+e.message;document.body&&document.body.appendChild(d)})})();<\/script>';
    const head = csp + base + report;
    let src = String(body || '');
    if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => m + head);
    if (/<html[^>]*>/i.test(src)) return src.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${src}</body></html>`;
  }

  // Frames grow to fit what they show, within reason.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.craftWidget !== 1 || typeof d.height !== 'number') return;
    for (const f of document.querySelectorAll('iframe.rx-frame')) {
      if (f.contentWindow !== e.source) continue;
      const max = f.closest('.rx-modal') ? Math.max(200, innerHeight - 140) : 720;
      f.style.height = Math.max(48, Math.min(Math.ceil(d.height) + 2, max)) + 'px';
    }
  });

  // ─── Clicks inside replies ────────────────────────────────────────────────
  const rawOf = (el) => (el && el.querySelector(':scope > template.rx-raw') ? el.querySelector(':scope > template.rx-raw').content.textContent : '');
  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    const old = button.innerHTML;
    button.innerHTML = CHECK;
    button.classList.add('done');
    setTimeout(() => { button.innerHTML = old; button.classList.remove('done'); }, 1200);
  }

  let modal = null;
  function closeModal() {
    if (!modal) return;
    modal.remove();
    modal = null;
    document.removeEventListener('keydown', modalKey, true);
  }
  function modalKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeModal(); } }
  function openModal(kindHtml, actionsHtml, inner) {
    closeModal();
    modal = document.createElement('div');
    modal.className = 'rx-modal';
    modal.innerHTML = `<div class="rx-modal-card" role="dialog" aria-modal="true"><div class="rx-modal-head">${kindHtml}<span class="rx-grow"></span>${actionsHtml}${btn('modal-close', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>', 'Close')}</div><div class="rx-modal-body"></div></div>`;
    modal.querySelector('.rx-modal-body').appendChild(inner);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
    document.body.appendChild(modal);
    document.addEventListener('keydown', modalKey, true);
    return modal;
  }

  function onClick(e) {
    const t = e.target.closest('[data-rx]');
    if (!t) return;
    const act = t.dataset.rx;
    if (act === 'link') {
      e.preventDefault();
      const url = t.getAttribute('href');
      const api = window.craft;
      if (/^https?:\/\//.test(url) && api && api.browserPanelNewTab) api.browserPanelNewTab(url);
      else if (/^https?:\/\//.test(url) && !api) window.open(url, '_blank', 'noopener');
      return;
    }
    if (act === 'check') return; // a reader's own tick; nothing else to do
    if (act === 'copy-code') { copy(rawOf(t.closest('.rx-code')), t); return; }
    if (act === 'copy-doc') { copy(rawOf(t.closest('.rx-doc') || modal?.docSource), t); return; }
    if (act === 'expand-doc') {
      const doc = t.closest('.rx-doc');
      const inner = document.createElement('div');
      inner.className = 'rx-doc-full msg assistant';
      inner.innerHTML = doc.querySelector('.rx-doc-body').innerHTML;
      const m = openModal(`<span class="rx-doc-kind">${ICON.doc}Document</span>`, btn('copy-doc', ICON.copy, 'Copy'), inner);
      m.docSource = doc;
      return;
    }
    if (act === 'modal-close') { closeModal(); return; }
    const w = t.closest('.rx-widget');
    if (!w) return;
    if (act === 'widget-source') {
      const src = w.querySelector('.rx-widget-src');
      const open = src.classList.toggle('hidden') === false;
      t.classList.toggle('on', open);
      return;
    }
    if (act === 'widget-reload') {
      const f = w.querySelector('iframe.rx-frame');
      if (f) f.srcdoc = widgetDoc(rawOf(w));
      return;
    }
    if (act === 'widget-expand') {
      const f = document.createElement('iframe');
      f.className = 'rx-frame';
      f.setAttribute('sandbox', 'allow-scripts allow-forms');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.srcdoc = widgetDoc(rawOf(w));
      openModal(w.querySelector('.rx-widget-kind').outerHTML, '', f);
    }
  }
  document.addEventListener('click', onClick);

  // ─── Reader typography ("Aa") ─────────────────────────────────────────────
  const TYPE_KEY = 'craft-chat-type';
  const TYPE_DEFAULT = { size: 14, font: 'system', spacing: 'normal', width: 'normal' };
  const FONTS = {
    system: 'var(--font-ui)',
    serif: '"Iowan Old Style", "Charter", Georgia, Cambria, "Times New Roman", serif',
    mono: 'var(--font-mono)',
  };
  const SPACING = { compact: 1.5, normal: 1.65, relaxed: 1.85 };
  const WIDTH = { normal: '784px', wide: '980px', full: '100%' };

  function loadType() {
    try { return { ...TYPE_DEFAULT, ...(JSON.parse(localStorage.getItem(TYPE_KEY)) || {}) }; } catch { return { ...TYPE_DEFAULT }; }
  }
  function saveType(t) { try { localStorage.setItem(TYPE_KEY, JSON.stringify(t)); } catch {} }
  function applyType(t) {
    const r = document.documentElement.style;
    const size = Math.max(12, Math.min(22, Number(t.size) || 14));
    r.setProperty('--chat-font-size', size + 'px');
    r.setProperty('--chat-font', FONTS[t.font] || FONTS.system);
    r.setProperty('--chat-line', String(SPACING[t.spacing] || SPACING.normal));
    r.setProperty('--chat-width', WIDTH[t.width] || WIDTH.normal);
  }
  let type = loadType();
  applyType(type);

  let typePop = null;
  function closeTypePop() {
    if (!typePop) return;
    typePop.remove();
    typePop = null;
    document.querySelectorAll('.rx-type-btn.open').forEach((b) => b.classList.remove('open'));
  }
  function seg(name, options) {
    return `<div class="rx-seg" role="radiogroup" data-key="${name}">${options.map(([v, l, style]) => `<button type="button" role="radio" data-val="${v}" aria-checked="${type[name] === v}"${style ? ` style="${style}"` : ''}>${l}</button>`).join('')}</div>`;
  }
  function drawTypePop() {
    typePop.innerHTML =
      '<div class="rx-type-title">Text</div>' +
      `<div class="rx-type-row"><span>Size</span><span class="rx-type-val">${type.size}px</span></div>` +
      `<div class="rx-type-size"><span class="rx-a-sm">A</span><input type="range" min="12" max="22" step="1" value="${type.size}" aria-label="Text size"><span class="rx-a-lg">A</span></div>` +
      '<div class="rx-type-row"><span>Font</span></div>' +
      seg('font', [['system', 'Sans', 'font-family:var(--font-ui)'], ['serif', 'Serif', `font-family:${FONTS.serif}`], ['mono', 'Mono', 'font-family:var(--font-mono)']]) +
      '<div class="rx-type-row"><span>Line spacing</span></div>' +
      seg('spacing', [['compact', 'Compact'], ['normal', 'Normal'], ['relaxed', 'Relaxed']]) +
      '<div class="rx-type-row"><span>Width</span></div>' +
      seg('width', [['normal', 'Normal'], ['wide', 'Wide'], ['full', 'Full']]) +
      '<button type="button" class="rx-type-reset">Reset to default</button>';
    const range = typePop.querySelector('input[type=range]');
    range.addEventListener('input', () => {
      type.size = Number(range.value);
      typePop.querySelector('.rx-type-val').textContent = type.size + 'px';
      applyType(type);
      saveType(type);
    });
  }
  function openTypePop(anchor) {
    if (typePop) { closeTypePop(); return; }
    typePop = document.createElement('div');
    typePop.className = 'rx-type-pop';
    typePop.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('.rx-seg button');
      if (b) {
        type[b.parentElement.dataset.key] = b.dataset.val;
      } else if (e.target.closest('.rx-type-reset')) {
        type = { ...TYPE_DEFAULT };
      } else return;
      applyType(type);
      saveType(type);
      drawTypePop();
    });
    drawTypePop();
    document.body.appendChild(typePop);
    const r = anchor.getBoundingClientRect();
    const w = typePop.offsetWidth;
    typePop.style.top = (r.bottom + 6) + 'px';
    typePop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    anchor.classList.add('open');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.rx-type-btn');
    if (b) { e.stopPropagation(); openTypePop(b); return; }
    if (typePop && !typePop.contains(e.target)) closeTypePop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && typePop) closeTypePop(); });
  window.addEventListener('blur', closeTypePop);

  // The Settings page changes the same text settings (null: back to the defaults).
  function setType(patch) {
    type = patch ? { ...type, ...patch } : { ...TYPE_DEFAULT };
    applyType(type);
    saveType(type);
    if (typePop) drawTypePop();
  }
  window.CraftRich = { render, inline: (s) => inline(esc(s)), widgetDoc, applyType, getType: () => ({ ...type }), setType };
})();
