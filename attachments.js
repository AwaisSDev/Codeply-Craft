// Attached files for Craft and the phone app: PDFs, text and code files.
//
// The file's text is read here, on the person's device, and sent with the
// message wrapped in an <attachment> tag, so it works with every model:
//
//   <attachment name="report.pdf" type="pdf" pages="12">
//   ...the text...
//   </attachment>
//
// PDFs are read with Mozilla's pdf.js (vendor/pdfjs, Apache 2.0). Images are
// handled by each app as before. When a message is shown, split() takes the
// tags back out so the bubble shows a small chip per file, not the whole text.
(function () {
  const TEXT_EXT = ['txt', 'md', 'markdown', 'mdx', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log',
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'astro', 'py', 'ipynb', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
    'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r', 'dart', 'scala', 'sql', 'graphql', 'gql', 'proto', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'dockerfile', 'gradle', 'tf', 'hcl', 'tex', 'bib', 'srt', 'vtt', 'svg', 'gitignore', 'editorconfig', 'prisma'];
  const MAX_BYTES = 25 * 1024 * 1024;   // a file bigger than this is refused
  const MAX_CHARS = 120000;             // per file, what goes to the model
  const MAX_PAGES = 300;
  const ACCEPT = ['.pdf', ...TEXT_EXT.map((e) => '.' + e), 'text/*', 'application/json', 'application/pdf'].join(',');

  const ext = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : String(name || '').toLowerCase(); };
  function kindOf(file) {
    const e = ext(file.name); const t = file.type || '';
    if (t.startsWith('image/')) return 'image';
    if (t === 'application/pdf' || e === 'pdf') return 'pdf';
    if (t.startsWith('text/') || t === 'application/json' || t === 'application/xml' || TEXT_EXT.includes(e) || /^(Dockerfile|Makefile|README|LICENSE)$/i.test(file.name)) return 'text';
    return null;
  }
  const sizeLabel = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  let pdfjsPromise = null;
  function pdfjs(base) {
    if (!pdfjsPromise) {
      // import() needs a full URL, not a bare relative path
      const abs = (f) => new URL(base + f, (typeof document !== 'undefined' && document.baseURI) || location.href).href;
      pdfjsPromise = import(abs('pdf.min.mjs')).then((lib) => { lib.GlobalWorkerOptions.workerSrc = abs('pdf.worker.min.mjs'); return lib; });
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }
  async function pdfText(file, base) {
    const lib = await pdfjs(base);
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const pages = doc.numPages; const out = []; let chars = 0;
    for (let i = 1; i <= Math.min(pages, MAX_PAGES) && chars < MAX_CHARS; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = ''; const lines = [];
      for (const it of tc.items) { line += it.str; if (it.hasEOL) { lines.push(line); line = ''; } }
      if (line) lines.push(line);
      const t = lines.join('\n').replace(/[ \t]+\n/g, '\n').trim();
      out.push(`[page ${i}]\n${t}`); chars += t.length;
    }
    await doc.destroy().catch(() => {});
    return { text: out.join('\n\n'), pages };
  }

  /**
   * Reads one file: { name, kind: 'pdf'|'text', size, text, pages?, truncated }
   * or { name, error }. Images are not read here (kind 'image', the app handles them).
   * opts.pdfBase: where vendor/pdfjs is served from (ends with '/').
   */
  async function read(file, opts = {}) {
    const name = file.name || 'file';
    const kind = kindOf(file);
    if (kind === 'image') return { name, kind, size: file.size };
    if (!kind) return { name, error: `${name}: this kind of file can't be read. PDFs, text and code files work.` };
    if (file.size > MAX_BYTES) return { name, error: `${name} is ${sizeLabel(file.size)}; files up to ${sizeLabel(MAX_BYTES)} work.` };
    try {
      let text; let pages;
      if (kind === 'pdf') {
        ({ text, pages } = await pdfText(file, opts.pdfBase || 'vendor/pdfjs/'));
        if (!text.replace(/\[page \d+\]/g, '').trim()) return { name, error: `${name} has no readable text (it may be scanned images).` };
      } else {
        text = await file.text();
        if (/\u0000/.test(text.slice(0, 2000))) return { name, error: `${name} looks like a binary file, not text.` };
      }
      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS);
      return { name, kind, size: file.size, text, pages, truncated };
    } catch (e) {
      return { name, error: `Couldn't read ${name}: ${e && e.message ? e.message : e}` };
    }
  }

  const attr = (s) => String(s).replace(/[\r\n"<>]/g, ' ').slice(0, 200);
  /** The block that goes into the message for one read file. */
  function block(a) {
    const meta = [`name="${attr(a.name)}"`, `type="${a.kind}"`];
    if (a.pages) meta.push(`pages="${a.pages}"`);
    if (a.truncated) meta.push('truncated="true"');
    return `<attachment ${meta.join(' ')}>\n${a.text.replace(/<\/attachment>/gi, '</ attachment>')}\n</attachment>`;
  }
  /** The message to send: what was typed, then each file. */
  function compose(text, files) {
    const blocks = (files || []).filter((f) => f && f.text != null).map(block);
    return [String(text || '').trim(), ...blocks].filter(Boolean).join('\n\n');
  }
  /** For showing a sent message: { text (without the files), files: [{ name, type, pages, chars, truncated }] }. */
  function split(message) {
    const files = [];
    const text = String(message || '').replace(/<attachment\s+([^>]*)>\n?([\s\S]*?)\n?<\/attachment>/g, (m, meta, body) => {
      const get = (k) => { const x = new RegExp(`${k}="([^"]*)"`).exec(meta); return x ? x[1] : ''; };
      files.push({ name: get('name') || 'file', type: get('type') || 'text', pages: Number(get('pages')) || 0, chars: body.length, truncated: get('truncated') === 'true' });
      return '';
    }).trim();
    return { text, files };
  }
  /** A short line under the file name: "PDF · 12 pages" or "Text · 4 KB". */
  function meta(f) {
    const kb = (n) => n < 1000 ? `${n} characters` : `${Math.max(1, Math.round(n / 1000))}k characters`;
    const base = f.type === 'pdf' ? `PDF${f.pages ? ` · ${f.pages} page${f.pages === 1 ? '' : 's'}` : ''}` : `${(ext(f.name) || 'text').toUpperCase()} · ${f.size != null ? sizeLabel(f.size) : kb(f.chars || 0)}`;
    return f.truncated ? `${base} · first part` : base;
  }
  const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>';
  const PDF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><text x="7.2" y="17.5" font-size="5.6" font-weight="700" fill="currentColor" stroke="none" font-family="sans-serif">PDF</text></svg>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** One file chip (sent or about to be sent). */
  function chipHtml(f, { removable = false } = {}) {
    const isPdf = (f.type || f.kind) === 'pdf';
    return `<div class="att-chip${isPdf ? ' pdf' : ''}" title="${esc(f.name)}"><span class="att-ico">${isPdf ? PDF_ICON : FILE_ICON}</span><span class="att-txt"><span class="att-name">${esc(f.name)}</span><span class="att-meta">${esc(meta({ ...f, type: f.type || f.kind }))}</span></span>${removable ? '<button type="button" class="att-x" aria-label="Remove">×</button>' : ''}</div>`;
  }

  const api = { ACCEPT, kindOf, read, block, compose, split, chipHtml, meta, sizeLabel };
  if (typeof window !== 'undefined') window.CodeplyAttach = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
