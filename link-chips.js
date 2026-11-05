// Link chips for Craft and the phone app: a bare link in a chat message shows
// as a small pill, the site's icon and its name, instead of the raw URL.
//
//   https://codeply.app             ->  [icon] Codeply
//   https://codeply.app/changelog   ->  [icon] Codeply • changelog
//   https://github.com/vercel/next.js  ->  [icon] GitHub • vercel/next.js
//
// [text](url) keeps the author's text (with the site's icon before it). Each
// app's markdown renderer calls protect() on text that is not code: links are
// swapped for placeholders before the text is escaped and formatted, then put
// back as finished HTML. Only http and https links, built from the parsed URL
// and escaped here. The icon is Google's favicon service; if it fails a
// neutral globe takes its place. Nothing else is fetched.
//
// Loaded by index.html (Craft) and phone.html (phone app) as window.CodeplyLinks.
(function () {
  const FAVICON = 'https://www.google.com/s2/favicons?sz=64&domain=';
  // co.uk, com.au, co.jp...: the name is the label before these.
  const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'or', 'ne', 'go', 'ltd', 'plc', 'nhs', 'sch', 'mil', 'gob', 'nic']);
  const BRANDS = {
    github: 'GitHub', gitlab: 'GitLab', youtube: 'YouTube', youtu: 'YouTube', linkedin: 'LinkedIn', stackoverflow: 'Stack Overflow',
    openai: 'OpenAI', chatgpt: 'ChatGPT', npmjs: 'npm', paypal: 'PayPal', tiktok: 'TikTok', wordpress: 'WordPress', ycombinator: 'Y Combinator',
    huggingface: 'Hugging Face', mdn: 'MDN', pypi: 'PyPI', x: 'X',
  };
  // github.com/<these> are GitHub's own pages, not an owner.
  const GH_PAGES = new Set(['settings', 'orgs', 'features', 'marketplace', 'explore', 'topics', 'trending', 'collections', 'sponsors', 'pricing', 'about', 'login', 'join', 'notifications', 'pulls', 'issues', 'search', 'apps', 'new', 'enterprise', 'security', 'customer-stories', 'readme', 'codespaces']);
  const failed = new Set(); // hosts whose icon did not load: drawn as the globe without asking again

  const h = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');

  /** The site's name from its host: the main label, capitalised. */
  function siteName(u) {
    const host = u.hostname.replace(/\.$/, '').toLowerCase();
    if (isIp(host) || !host.includes('.')) return { name: u.host, main: '' }; // localhost:3000, 192.168.1.4
    const labels = host.split('.');
    const n = labels.length;
    let i = n - 2;
    if (n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL.has(labels[n - 2])) i = n - 3;
    const main = labels[Math.max(0, i)];
    const name = BRANDS[main] || (/^[a-z]{2,3}$/.test(main) ? main.toUpperCase() : cap(main.replace(/[-_]+/g, ' '))); // bbc -> BBC
    return { name, main };
  }

  /** The last meaningful bit of the path, readable: "changelog", "vercel/next.js", "getting started". */
  function pathLabel(u, main) {
    const segs = u.pathname.split('/').filter(Boolean).map(decode);
    if (!segs.length) return '';
    if (main === 'github' && !GH_PAGES.has(segs[0].toLowerCase())) {
      if (segs.length === 1) return cut(segs[0], 32);
      const repo = cut(`${segs[0]}/${segs[1].replace(/\.git$/, '')}`, 40);
      if (/^(issues|pull|pulls|discussions)$/.test(segs[2] || '') && /^\d+$/.test(segs[3] || '')) return `${repo} #${segs[3]}`;
      return repo;
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      let s = segs[i].replace(/\.[a-z][a-z0-9]{0,4}$/i, '') || segs[i];
      if (/^(index|default)$/i.test(s)) continue;
      s = s.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (s) return cut(s, 32);
    }
    return '';
  }

  /** { href, url, host, name, path } for an http(s) link, or null. */
  function parse(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null;
    const { name, main } = siteName(u);
    return { href: u.href, url: String(raw), host: u.hostname, name, path: pathLabel(u, main) };
  }

  function icon(host, cls) {
    if (failed.has(host) || isIp(host) || !host.includes('.')) return `<span class="${cls} link-globe" aria-hidden="true"></span>`;
    return `<img class="${cls}" src="${h(FAVICON + encodeURIComponent(host))}" alt="" width="16" height="16" decoding="async" referrerpolicy="no-referrer" data-host="${h(host)}" onerror="CodeplyLinks.iconFailed(this)">`;
  }
  function iconFailed(img) {
    failed.add(img.dataset.host);
    const s = document.createElement('span');
    s.className = `${img.className} link-globe`;
    s.setAttribute('aria-hidden', 'true');
    img.replaceWith(s);
  }

  const attrs = (p, cls) => `class="${cls}" href="${h(p.href)}" target="_blank" rel="noopener noreferrer" data-url="${h(p.url)}"`;
  /** A link chip's HTML, from a parsed link (or a URL string). */
  function chip(p) {
    if (typeof p === 'string') p = parse(p);
    if (!p) return '';
    const label = p.path ? `${p.name} • ${p.path}` : p.name;
    return `<a ${attrs(p, 'link-chip')} title="${h(p.url)}" aria-label="${h(`${label}: ${p.url}`)}">${icon(p.host, 'link-chip-icon')}`
      + `<span class="link-chip-name">${h(p.name)}</span>`
      + (p.path ? `<span class="link-chip-sep" aria-hidden="true">•</span><span class="link-chip-path">${h(p.path)}</span>` : '')
      + '</a>';
  }

  // Trailing punctuation belongs to the sentence, not the link: "see https://x.com." / "(https://x.com)".
  const count = (s, c) => s.split(c).length - 1;
  function splitTail(url) {
    let tail = '';
    for (;;) {
      const c = url.slice(-1);
      if (/[.,;:!?'"*~]/.test(c) || (c === ')' && count(url, '(') < count(url, ')')) || (c === ']' && count(url, '[') < count(url, ']'))) {
        tail = c + tail; url = url.slice(0, -1);
      } else return [url, tail];
    }
  }
  const sameLink = (text, url) => { const t = text.trim().replace(/\/$/, ''); const v = url.replace(/\/$/, ''); return t === v || t === v.replace(/^https?:\/\//i, ''); };

  // [text](url) | <url> | a bare url
  const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>"'`]+)/gi;

  /**
   * Swaps the links in raw (unescaped, non-code) text for placeholders. The
   * caller escapes and formats .text as usual, then calls restore() on the
   * HTML. A [text](url) keeps its text in the stream, so **bold** in it works.
   */
  function protect(raw) {
    const tokens = [];
    const put = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
    const text = String(raw == null ? '' : raw).replace(/\u0000/g, '').replace(LINK_RE, (m, label, mdUrl, angled, bare, at, str) => {
      if (mdUrl) {
        const p = parse(mdUrl);
        if (!p) return m;
        if (sameLink(label, mdUrl)) return put(chip(p)); // [https://x.com](https://x.com) is a bare link too
        // A short link stays on one line, so its icon never wraps away from its words.
        return put(`<a ${attrs(p, label.length <= 40 ? 'md-link md-link-short' : 'md-link')} title="${h(p.url)}">${icon(p.host, 'md-link-icon')}`) + label + put('</a>');
      }
      if (angled) { const c = chip(angled); return c ? put(c) : m; }
      if (at > 0 && /[\w/]/.test(str[at - 1])) return m; // part of a longer word
      const [url, tail] = splitTail(bare);
      const c = chip(url);
      return c ? put(c) + tail : m;
    });
    return { text, restore: (html) => String(html).replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[+i] || '') };
  }

  /** Plain text (a user's message) as HTML: escaped, with its links as chips. */
  function linkText(raw) {
    const p = protect(raw);
    return p.restore(h(p.text));
  }

  // The words of an element with each chip read as its URL, for Copy buttons.
  function textOf(el) {
    const chips = [...el.querySelectorAll('a.link-chip')];
    const kids = chips.map((c) => [...c.childNodes]);
    chips.forEach((c) => c.replaceChildren(c.dataset.url || c.href));
    const t = el.innerText;
    chips.forEach((c, i) => c.replaceChildren(...kids[i]));
    return t;
  }
  // Selecting text across a chip and copying it gives the URL, not "Codeply • changelog".
  if (typeof document !== 'undefined') {
    document.addEventListener('copy', (e) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
      const frag = sel.getRangeAt(0).cloneContents();
      if (!frag.querySelector || !frag.querySelector('a.link-chip')) return;
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:pre-wrap';
      box.append(frag);
      box.querySelectorAll('a.link-chip').forEach((c) => c.replaceWith(c.dataset.url || c.href));
      document.body.append(box);
      e.clipboardData.setData('text/plain', box.innerText);
      box.remove();
      e.preventDefault();
    });
  }

  const api = { parse, chip, protect, linkText, textOf, iconFailed };
  if (typeof window !== 'undefined') window.CodeplyLinks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
