// Codeply's browser as hands for Claude agents (a swarm working on one page).
//
// Each agent that may use the browser gets the codeply-browser MCP tools
// (codeply-cli/lib/browser-mcp.js, started by Claude Code). Those call this
// file over a local HTTP endpoint (127.0.0.1, a secret token, one key per
// agent), and this file drives the browser panel's tabs: open a page, look at
// it (a screenshot and the clickable things on it), click, type, press keys,
// scroll. The user's own mouse is never touched: clicks and keys go into the
// page as synthetic input.
//
// Every agent has its own cursor in its own colour with its name, drawn on the
// page, gliding to each spot before it clicks, so the user watches the swarm
// work. A swarm shares one tab unless an agent opens its own. Actions on one
// tab run one at a time, so two agents never interleave mid-click.
const http = require('http');
const crypto = require('crypto');

let deps = null; // { openTab(url) -> tab, selectTab(id), getTab(id), activeTabId(), showPanel() }
let server = null;
let ready = null;
const token = crypto.randomBytes(24).toString('hex');
const agents = new Map(); // key -> { name, color, swarmId, tabId, x, y, elements }
const swarmTabs = new Map(); // swarmId -> tabId
const queues = new Map(); // tabId -> Promise (actions on a tab run in turn)

function init(d) { deps = d; }

/** The local endpoint, started on first use. Resolves to { url, token }. */
function start() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/act' || req.headers['x-codeply-token'] !== token) { res.writeHead(403); res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        let out;
        try {
          const j = JSON.parse(body || '{}');
          out = await act(String(j.key || ''), String(j.action || ''), j.args || {});
        } catch (e) { out = { ok: false, text: e.message || String(e) }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/act`, token }));
  });
  return ready;
}

/** An agent may use the browser from now on. Returns its key for the MCP server's env. */
function register({ name, color, swarmId }) {
  const key = crypto.randomBytes(12).toString('hex');
  // Its place in the swarm: agents clicking the same spot get their name tags stacked, not hidden.
  const slot = [...agents.values()].filter((x) => swarmId && x.swarmId === swarmId).length;
  agents.set(key, { slot, name: String(name || 'Agent').slice(0, 24), color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#7f9cf5', swarmId: swarmId || '', tabId: null, x: null, y: null, elements: [] });
  return key;
}
function unregister(key) { agents.delete(key); }

// ─── Tabs ───────────────────────────────────────────────────────────────────

function tabFor(a, { fresh = false, url = '' } = {}) {
  let tab = a.tabId != null ? deps.getTab(a.tabId) : null;
  if (tab && !fresh) return tab;
  const shared = a.swarmId && swarmTabs.has(a.swarmId) ? deps.getTab(swarmTabs.get(a.swarmId)) : null;
  if (shared && !fresh) { a.tabId = shared.id; return shared; }
  tab = deps.openTab(url || 'about:blank');
  tab.swarm = a.swarmId || true;
  if (!fresh && a.swarmId) swarmTabs.set(a.swarmId, tab.id);
  a.tabId = tab.id;
  return tab;
}

/** Runs fn on a tab after the actions queued before it, with the tab in front. */
function onTab(tab, fn) {
  const prev = queues.get(tab.id) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    deps.showPanel();
    if (deps.activeTabId() !== tab.id) { deps.selectTab(tab.id); await sleep(120); }
    return fn(tab.view.webContents);
  });
  queues.set(tab.id, next.catch(() => {}));
  return next;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (wc, code) => wc.executeJavaScript(code, true);

async function settle(wc, ms = 600) {
  const t0 = Date.now();
  while (wc.isLoading() && Date.now() - t0 < 15000) await sleep(150);
  await sleep(ms);
}

// ─── The cursor ─────────────────────────────────────────────────────────────

/** Moves this agent's cursor (made on first use) to x,y; with click, a ripple there. */
async function cursor(wc, a, x, y, click) {
  const from = a.x == null ? null : [a.x, a.y];
  const code = `(function(id,name,color,x,y,click,from,slot){
    var root=document.getElementById('__codeply_cursors');
    if(!root){root=document.createElement('div');root.id='__codeply_cursors';root.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden';document.documentElement.appendChild(root);}
    var c=root.querySelector('[data-a="'+id+'"]');
    if(!c){c=document.createElement('div');c.setAttribute('data-a',id);c.style.cssText='position:absolute;left:0;top:0;transition:transform .24s cubic-bezier(.22,.9,.24,1);will-change:transform';
      c.innerHTML='<svg width="22" height="24" viewBox="0 0 22 24" style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))"><path d="M3 2l15.5 9.2-6.9 1.5-3.4 6.9z" fill="'+color+'" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg><span style="position:absolute;left:15px;top:'+(19+slot*20)+'px;padding:2px 8px;border-radius:999px;background:'+color+';color:#fff;font:600 11px/16px -apple-system,Segoe UI,system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.28)"></span>';
      c.querySelector('span').textContent=name;
      var s=from||[innerWidth/2,innerHeight/2];c.style.transform='translate('+s[0]+'px,'+s[1]+'px)';root.appendChild(c);c.getBoundingClientRect();}
    c.style.transform='translate('+x+'px,'+y+'px)';
    if(click){setTimeout(function(){var r=document.createElement('div');r.style.cssText='position:absolute;left:'+(x-15)+'px;top:'+(y-15)+'px;width:30px;height:30px;border-radius:50%;border:2.5px solid '+color+';transform:scale(.35);opacity:.95;transition:transform .5s ease-out,opacity .5s ease-out';root.appendChild(r);requestAnimationFrame(function(){r.style.transform='scale(1.7)';r.style.opacity='0';});setTimeout(function(){r.remove();},520);},200);}
  })(${JSON.stringify(a.key)},${JSON.stringify(a.name)},${JSON.stringify(a.color)},${Math.round(x)},${Math.round(y)},${click ? 'true' : 'false'},${JSON.stringify(from)},${Number(a.slot) % 4 || 0})`;
  try { await js(wc, code); } catch {}
  a.x = x; a.y = y;
  await sleep(click ? 250 : 240);
}

// ─── Reading the page ───────────────────────────────────────────────────────

const ELEMENTS = `(function(){
  var sel='a[href],button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  var out=[],seen=new Set();
  document.querySelectorAll(sel).forEach(function(el){
    if(out.length>=90||seen.has(el))return;seen.add(el);
    if(el.closest('#__codeply_cursors'))return;
    var r=el.getBoundingClientRect();
    if(r.width<4||r.height<4||r.bottom<0||r.right<0||r.top>innerHeight||r.left>innerWidth)return;
    var st=getComputedStyle(el);if(st.visibility==='hidden'||st.display==='none'||+st.opacity===0)return;
    var x=Math.round(Math.max(1,Math.min(innerWidth-2,r.left+r.width/2))),y=Math.round(Math.max(1,Math.min(innerHeight-2,r.top+r.height/2)));
    var hit=document.elementFromPoint(x,y);if(hit&&hit!==el&&!el.contains(hit)&&!hit.contains(el))return;
    var t=(el.getAttribute('aria-label')||el.innerText||el.value||el.placeholder||el.title||el.alt||'').replace(/\\s+/g,' ').trim().slice(0,70);
    var kind=el.tagName.toLowerCase();if(kind==='input')kind='input:'+(el.type||'text');
    out.push({kind:kind,text:t,x:x,y:y});
  });
  return {title:document.title,url:location.href,w:innerWidth,h:innerHeight,scrollY:Math.round(scrollY),scrollH:document.documentElement.scrollHeight,elements:out,
    text:(document.body?document.body.innerText:'').replace(/\\n{3,}/g,'\\n\\n').slice(0,6000)};
})()`;

async function readPage(wc, a) {
  let page = null;
  try { page = await js(wc, ELEMENTS); } catch {}
  if (!page) return { info: 'The page could not be read.', page: null };
  a.elements = page.elements || [];
  const list = a.elements.map((e, i) => `[${i}] ${e.kind}${e.text ? ` "${e.text}"` : ''} at ${e.x},${e.y}`).join('\n');
  const info = `${page.title || '(no title)'}\n${page.url}\nViewport ${page.w}x${page.h}, scrolled ${page.scrollY} of ${page.scrollH}.\n\nClickable (click by number, or by x,y in the screenshot):\n${list || '(none visible)'}`;
  return { info, page };
}

async function shot(wc) {
  try {
    const img = await wc.capturePage();
    if (!img || img.isEmpty()) return null;
    const size = img.getSize();
    const k = Math.min(1, 1100 / size.width);
    const small = k < 1 ? img.resize({ width: Math.round(size.width * k), quality: 'good' }) : img;
    return { data: small.toJPEG(72).toString('base64'), k };
  } catch { return null; }
}

/** What the agent sees after a step: the page's clickable things, and a screenshot. */
async function seeing(wc, a, said, picture = true) {
  await settle(wc, picture ? 300 : 150);
  const { info, page } = await readPage(wc, a);
  // After a click or keystroke the page's text and clickable things are enough and much
  // faster to read; a screenshot comes with open, look and wait (or with look: true).
  const img = picture ? await shot(wc) : null;
  const note = img && img.k < 1 ? `\n(The screenshot is scaled to ${Math.round(img.k * 100)}%. Click by element number, or by x,y in page pixels: picture pixels / ${img.k.toFixed(2)}.)` : '';
  return { ok: true, text: `${said}\n\n${info}${note}${page && page.text ? `\n\nText on the page (start):\n${page.text.slice(0, 2500)}` : ''}`, image: img ? img.data : null };
}

// ─── Actions ────────────────────────────────────────────────────────────────

const KEYMAP = { enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', space: 'Space', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };

async function act(key, action, args) {
  const a = agents.get(key);
  if (!a) return { ok: false, text: 'This agent may not use the browser.' };
  a.key = key;
  if (action === 'open') {
    let url = String(args.url || '').trim();
    if (!url) return { ok: false, text: 'browser_open needs a url.' };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url) ? `http://${url}` : `https://${url}`;
    if (!/^(https?|file):/i.test(url)) return { ok: false, text: 'Only http, https and file pages.' };
    const tab = tabFor(a, { fresh: !!args.new_tab, url });
    return onTab(tab, async (wc) => {
      // The shared tab already shows that page: look, don't reload (a reload wipes what teammates did on it).
      const same = (u) => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
      if (!args.new_tab && same(wc.getURL()) === same(url) && !wc.isLoading()) {
        return seeing(wc, a, `${url} is already open in the swarm's shared tab, so it was not reloaded (that would undo what teammates did on it). Here it is now.`);
      }
      a.x = null;
      try { await wc.loadURL(url); } catch (e) { if (!/ERR_ABORTED/.test(String(e.message))) return { ok: false, text: `Could not open ${url}: ${e.message}` }; }
      await settle(wc, 700);
      return seeing(wc, a, `Opened ${wc.getURL()}${args.new_tab ? ' in a tab of your own' : a.swarmId ? ' in the swarm\'s shared tab' : ''}.`);
    });
  }
  const tab = a.tabId != null ? deps.getTab(a.tabId) : (a.swarmId && swarmTabs.has(a.swarmId) ? deps.getTab(swarmTabs.get(a.swarmId)) : null);
  if (!tab) return { ok: false, text: 'No page yet: call browser_open with a url first.' };
  a.tabId = tab.id;
  // Typing holds the shared page for that agent until it clicks or presses a key (5 s at most),
  // so two agents never type into the same field at once.
  const t0 = Date.now();
  while (tab.hold && tab.hold.key !== key && Date.now() < tab.hold.until && Date.now() - t0 < 8000) await sleep(80);
  return onTab(tab, async (wc) => {
    if (action === 'type') tab.hold = args.enter ? null : { key, until: Date.now() + 5000 };
    else if (tab.hold && tab.hold.key === key && (action === 'click' || action === 'keys' || action === 'back')) tab.hold = null;
    if (action === 'look') return seeing(wc, a, 'Here is the page now.');
    if (action === 'click') {
      let x = Number(args.x); let y = Number(args.y);
      if (args.element != null && args.element !== '') {
        const e = a.elements[Number(args.element)];
        if (!e) return { ok: false, text: `No element ${args.element} in your last look. Call browser_look again.` };
        x = e.x; y = e.y;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, text: 'browser_click needs element (a number from browser_look) or x and y.' };
      await cursor(wc, a, x, y, true);
      const button = args.button === 'right' ? 'right' : 'left';
      const clickCount = args.double ? 2 : 1;
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
      return seeing(wc, a, `Clicked at ${Math.round(x)},${Math.round(y)}.`, !!args.look);
    }
    if (action === 'type') {
      if (args.element != null && args.element !== '') {
        const e = a.elements[Number(args.element)];
        if (e) { await cursor(wc, a, e.x, e.y, true); wc.sendInputEvent({ type: 'mouseDown', x: e.x, y: e.y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: e.x, y: e.y, button: 'left', clickCount: 1 }); await sleep(120); }
      }
      const text = String(args.text || '');
      if (args.clear) { wc.selectAll(); await sleep(40); }
      wc.insertText(text);
      if (args.enter) { await sleep(60); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); }
      return seeing(wc, a, `Typed ${JSON.stringify(text.slice(0, 80))}${args.enter ? ' and pressed Enter' : ''}.`, !!args.look);
    }
    if (action === 'keys') {
      const parts = String(args.keys || '').split('+').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return { ok: false, text: 'browser_keys needs keys, like Enter or Ctrl+A.' };
      const mods = parts.slice(0, -1).map((m) => ({ ctrl: 'control', control: 'control', shift: 'shift', alt: 'alt', cmd: 'meta', meta: 'meta' }[m.toLowerCase()])).filter(Boolean);
      const last = parts[parts.length - 1];
      const keyCode = KEYMAP[last.toLowerCase()] || (last.length === 1 ? last : last);
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
      if (keyCode === 'Return' && !mods.length) wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      else if (last.length === 1 && !mods.some((m) => m === 'control' || m === 'meta' || m === 'alt')) wc.sendInputEvent({ type: 'char', keyCode: last, modifiers: mods });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
      return seeing(wc, a, `Pressed ${parts.join('+')}.`, !!args.look);
    }
    if (action === 'scroll') {
      const dy = Number(args.dy) || (String(args.direction || 'down').toLowerCase() === 'up' ? -600 : 600);
      const x = Number.isFinite(Number(args.x)) ? Number(args.x) : (a.x != null ? a.x : 400);
      const y = Number.isFinite(Number(args.y)) ? Number(args.y) : (a.y != null ? a.y : 300);
      await cursor(wc, a, x, y, false);
      try { await js(wc, `(function(x,y,dy){var el=document.elementFromPoint(x,y);while(el&&el!==document.body&&!(el.scrollHeight>el.clientHeight+4&&/(auto|scroll)/.test(getComputedStyle(el).overflowY)))el=el.parentElement;(el&&el!==document.body?el:window).scrollBy({top:dy,behavior:'smooth'});})(${x},${y},${dy})`); } catch {}
      await sleep(250);
      return seeing(wc, a, `Scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)} px.`, !!args.look);
    }
    if (action === 'back') { if (wc.canGoBack()) wc.goBack(); await settle(wc, 600); return seeing(wc, a, 'Went back.'); }
    if (action === 'wait') { await sleep(Math.max(200, Math.min(10000, Number(args.ms) || 1500))); return seeing(wc, a, 'Waited.'); }
    return { ok: false, text: `Unknown browser action ${action}.` };
  });
}

/** Writes the MCP config Claude Code is started with for one agent. Returns its path. */
async function mcpConfigFor(key, { cliDir, dir }) {
  const fs = require('fs');
  const path = require('path');
  const { url } = await start();
  const file = path.join(dir, `browser-mcp-${key.slice(0, 10)}.json`);
  const cfg = { mcpServers: { 'codeply-browser': {
    type: 'stdio', command: process.execPath, args: [path.join(cliDir, 'lib', 'browser-mcp.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', CODEPLY_BROWSER_URL: url, CODEPLY_BROWSER_TOKEN: token, CODEPLY_BROWSER_KEY: key },
  } } };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg), 'utf8');
  return file;
}

module.exports = { init, start, register, unregister, mcpConfigFor, act };
