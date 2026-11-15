// A background agent's hands in its own browser tab (src/browser.rs runs this in the tab's web
// view). `__codeplyAgent.run(action, args, who)` does one thing and returns what the agent sees
// next, as plain text: the address, the title, the clickable things numbered, and the visible
// text. The agent's cursor (its colour, its name) glides to whatever it clicks or types in, so
// the user can watch it work. Clicks and keys go into the page; the user's own mouse is untouched.
(() => {
  if (window.__codeplyAgent) return;
  const PICK = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  let els = [];
  let cursor = null;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const words = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const what = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const name = words(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || (el.querySelector('img') && el.querySelector('img').alt) || (el.tagName === 'BUTTON' || el.type === 'submit' ? el.value : '') || '', 80);
    const kind = tag === 'a' ? 'link' : tag === 'input' ? `${type || 'text'} field` : tag === 'textarea' ? 'text box' : tag === 'select' ? 'list' : el.getAttribute('role') || tag;
    const extra = tag === 'a' ? ` → ${words(el.getAttribute('href'), 80)}` : tag === 'input' && el.value && type !== 'password' ? ` (now: "${words(el.value, 40)}")` : '';
    return `${kind} "${name}"${extra}`;
  };

  function look() {
    els = [...document.querySelectorAll(PICK)].filter(visible);
    // The ones on screen first, then the rest, at most 120.
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
    els.sort((a, b) => Number(inView(b)) - Number(inView(a)));
    els = els.slice(0, 120);
    const list = els.map((el, i) => `[${i + 1}] ${what(el)}${inView(el) ? '' : ' (scroll to see)'}`).join('\n');
    const body = words(document.body ? document.body.innerText : '', 6000);
    const at = `${Math.round(scrollY)} of ${Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight))} px scrolled`;
    return `ADDRESS ${location.href}\nTITLE ${document.title}\n(${at})\n\nCLICKABLE\n${list || '(nothing clickable)'}\n\nTEXT\n${body || '(no text)'}`;
  }

  function moveCursor(el, who) {
    if (!who || !who.name) return;
    if (!cursor || !cursor.isConnected) {
      cursor = document.createElement('div');
      cursor.setAttribute('data-codeply-cursor', '');
      cursor.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;pointer-events:none;transition:left .35s cubic-bezier(.2,0,0,1),top .35s cubic-bezier(.2,0,0,1);font:600 12px system-ui,sans-serif';
      cursor.innerHTML = '<svg width="18" height="20" viewBox="0 0 18 20" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))"><path d="M2 1.5l13 9.2-6.2 1.1-3.6 5.6z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span style="position:absolute;left:14px;top:16px;padding:2px 7px;border-radius:9px;color:#fff;white-space:nowrap"></span>';
      document.documentElement.appendChild(cursor);
    }
    cursor.querySelector('path').setAttribute('fill', who.color || '#3d8bfd');
    const label = cursor.querySelector('span');
    label.textContent = who.name;
    label.style.background = who.color || '#3d8bfd';
    if (el) {
      const r = el.getBoundingClientRect();
      cursor.style.left = `${Math.round(r.left + Math.min(r.width / 2, 40))}px`;
      cursor.style.top = `${Math.round(r.top + r.height / 2)}px`;
    }
  }

  const pick = (n) => {
    const el = els[Math.round(Number(n)) - 1];
    if (!el || !el.isConnected) throw new Error(`No element ${n} on the page now. Look again first.`);
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return el;
  };
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value');
    if (set && set.set && 'value' in el) set.set.call(el, value); else el.textContent = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const KEYS = { enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', space: ' ', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
  function press(name, target) {
    const parts = String(name || '').split('+').map((p) => p.trim()).filter(Boolean);
    const key = KEYS[(parts.pop() || '').toLowerCase()] || name;
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    const el = target || document.activeElement || document.body;
    const init = { key, bubbles: true, cancelable: true, ctrlKey: mods.has('ctrl') || mods.has('control'), shiftKey: mods.has('shift'), altKey: mods.has('alt'), metaKey: mods.has('meta') || mods.has('cmd') };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (!go) return;
    // What the browser would do itself, which synthetic keys don't trigger.
    if (key === 'Enter' && el.form && el.tagName === 'INPUT') { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
    else if (key === 'Enter' && (el.tagName === 'A' || el.tagName === 'BUTTON')) el.click();
    else if (key === 'Tab') {
      const all = [...document.querySelectorAll(PICK)].filter(visible);
      const i = all.indexOf(el);
      const next = all[(i + (init.shiftKey ? -1 : 1) + all.length) % all.length];
      if (next) next.focus();
    }
  }

  window.__codeplyAgent = {
    look,
    run(action, args, who) {
      args = args || {};
      try {
        switch (action) {
          case 'look': moveCursor(null, who); return look();
          case 'click': {
            const el = pick(args.element);
            moveCursor(el, who);
            el.focus({ preventScroll: true });
            el.click();
            if (args.double) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            return `Clicked ${what(el)}.\n\n${look()}`;
          }
          case 'type': {
            const el = args.element != null ? pick(args.element) : document.activeElement;
            if (!el || el === document.body) throw new Error('Nothing to type in: give the field\'s element number.');
            moveCursor(el, who);
            el.focus({ preventScroll: true });
            const before = args.clear ? '' : ('value' in el ? el.value : el.textContent) || '';
            setValue(el, before + String(args.text || ''));
            if (args.enter) press('Enter', el);
            return `Typed into ${what(el)}.\n\n${look()}`;
          }
          case 'keys': press(args.keys); return `Pressed ${args.keys}.\n\n${look()}`;
          case 'scroll': {
            const dy = Number(args.dy) || (args.direction === 'up' ? -0.8 : 0.8) * innerHeight;
            scrollBy({ top: dy, behavior: 'instant' });
            return look();
          }
          default: return `Unknown action ${action}.`;
        }
      } catch (e) {
        return `ERROR ${e && e.message ? e.message : e}`;
      }
    },
  };
})();
