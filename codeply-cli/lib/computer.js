// use_computer: the agent drives other apps on this PC with the mouse and
// keyboard (the same hands voice mode uses, voice/act.js), and sees the result.
//
// Every action that changes something first makes sure the window it is meant
// for is really in front. If it is not, nothing is typed or clicked: a stray
// keystroke in the wrong window (the chat the user is reading, a terminal) is
// the worst thing this tool could do.
//
// Only the desktop app has hands, so it attaches a host (computer-desktop.js):
//   host.front()            -> { app, title, bounds, front } | null
//   host.focus(want)        -> the same for the window it brought forward | null
//   host.capture(win)       -> { image, w, h, text? } of the screen that window is on
//   host.point(x, y)        -> screen point for a spot on the last capture | null
//   host.click(pt, opts), host.type(text), host.keys(combo), host.scroll(pt, clicks)
//   host.isOwn(win)         -> true for Codeply's own windows
let host = null;

function attach(h) { host = h && typeof h === 'object' ? h : null; }
function available() { return !!host; }

const ACTIONS = new Set(['look', 'focus', 'click', 'double_click', 'right_click', 'type', 'keys', 'scroll', 'wait']);
const CHANGES = new Set(['click', 'double_click', 'right_click', 'type', 'keys', 'scroll']);
const ALIASES = { open: 'focus', activate: 'focus', switch: 'focus', screenshot: 'look', see: 'look', press: 'keys', key: 'keys', hotkey: 'keys', write: 'type', doubleclick: 'double_click', rightclick: 'right_click', sleep: 'wait' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const matches = (win, want) => !!win && `${win.app} ${win.title}`.toLowerCase().includes(String(want).toLowerCase());
const named = (win) => (win ? `${win.app || 'a window'}${win.title ? ` ("${clip(win.title, 80)}")` : ''}` : 'nothing');

/** A fresh picture of the screen the window is on, as the tool's result. */
async function seeing(win, said) {
  let shot = null;
  try { shot = await host.capture(win); } catch (e) { return { ok: true, output: `${said} (No screenshot: ${e.message}.)` }; }
  if (!shot || !shot.image) return { ok: true, output: `${said} (The screen could not be captured.)` };
  const lines = [
    said,
    `Screenshot attached, ${shot.w} x ${shot.h} pixels, window in front: ${named(win)}. Spots for click and scroll are x and y in this picture's pixels, measured from its top left.`,
    shot.text ? `Text on the screen (OCR, one row per line, may have small mistakes):\n${String(shot.text).slice(0, 4000)}` : '',
  ].filter(Boolean);
  return { ok: true, output: lines.join('\n\n'), meta: { imageDataUrls: [shot.image] } };
}

/**
 * <action> look | focus | click | double_click | right_click | type | keys | scroll | wait
 * <window> words from the app name or window title it is for (required to act)
 * <x> <y> a spot on the latest screenshot (click, scroll); <text> to type; <keys> "ctrl+n", "enter";
 * <amount> scroll clicks (negative is up); <seconds> to wait.
 */
async function tool(args = {}, ctx = {}) {
  if (!host) return { ok: false, output: 'use_computer only works in the Codeply desktop app on Windows or macOS.' };
  let action = String(args.action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  action = ALIASES[action.replace(/_/g, '')] || ALIASES[action] || action;
  if (!ACTIONS.has(action)) return { ok: false, output: `use_computer needs <action>: one of ${[...ACTIONS].join(', ')}.` };
  const want = String(args.window || args.app || '').trim();

  if (action === 'wait') {
    const secs = Math.max(1, Math.min(30, Number(args.seconds) || 3));
    if (ctx.signal && ctx.signal.aborted) return { ok: false, output: 'Stopped.' };
    await sleep(secs * 1000);
    let win = null; try { win = await host.front(); } catch {}
    return seeing(win, `Waited ${secs} s.`);
  }

  if (action === 'look' && !want) {
    let win = null; try { win = await host.front(); } catch {}
    return seeing(win, 'Looked at the screen.');
  }

  if (!want) return { ok: false, output: `use_computer ${action} needs <window>: a few words of the app name or window title it is for, so it never lands in the wrong window.` };

  // Bring it forward unless it already is.
  let win = null;
  try { win = await host.front(); } catch {}
  if (!matches(win, want) || (host.isOwn && host.isOwn(win))) {
    try { win = await host.focus(want); } catch (e) { return { ok: false, output: `Could not switch to "${want}": ${e.message}` }; }
    if (!win) return { ok: false, output: `No open window matches "${want}". Open the app first (on Windows: <codeply:run> start "" "shell:AppsFolder\\..." or the app's name; on a Mac: open -a "App"), then use_computer focus it.` };
    await sleep(250);
    // What is really in front now decides; the window it tried keeps its name for the messages below.
    try { const now = await host.front(); win = now && matches(now, want) ? { ...now, front: true } : { ...win, front: false }; } catch {}
  }
  if (host.isOwn && host.isOwn(win)) return { ok: false, output: `"${want}" is Codeply's own window. use_computer is for other apps; nothing was done.` };
  if (!win || !win.front || !matches(win, want)) {
    let front = null; try { front = await host.front(); } catch {}
    return { ok: false, output: `Could not bring "${want}" to the front (the window in front is ${named(front)}), so nothing was ${action === 'type' ? 'typed' : action === 'keys' ? 'pressed' : 'clicked'}. Try use_computer focus again, or a more exact <window>.` };
  }
  if (action === 'focus' || action === 'look') return seeing(win, `${named(win)} is in front.`);

  // What it will do, checked before asking.
  let pt = null;
  let what = '';
  if (action === 'type') {
    const text = String(args.text == null ? '' : args.text);
    if (!text) return { ok: false, output: 'use_computer type needs <text>.' };
    if (text.length > 2000) return { ok: false, output: 'use_computer type takes up to 2000 characters at a time.' };
    what = `Type "${clip(text, 120)}" into ${named(win)}`;
  } else if (action === 'keys') {
    const combo = String(args.keys || args.key || args.text || '').trim().toLowerCase();
    if (!combo) return { ok: false, output: 'use_computer keys needs <keys>, like enter, ctrl+n or cmd+shift+t.' };
    what = `Press ${combo} in ${named(win)}`;
  } else {
    const x = Number(args.x); const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, output: `use_computer ${action} needs <x> and <y>: a spot on the latest screenshot (use_computer look shows one).` };
    pt = host.point(x, y);
    if (!pt) return { ok: false, output: 'There is no screenshot to measure that spot on yet, or it is outside it. Call use_computer look (or focus) first, then give x and y on that picture.' };
    what = action === 'scroll' ? `Scroll ${Number(args.amount) < 0 ? 'up' : 'down'} in ${named(win)}` : `${action === 'double_click' ? 'Double-click' : action === 'right_click' ? 'Right-click' : 'Click'}${args.target ? ` "${clip(args.target, 60)}"` : ''} in ${named(win)}`;
  }

  if (CHANGES.has(action) && typeof ctx.approve === 'function') {
    const v = await ctx.approve({ tool: 'use_computer', title: what, detail: `Codeply will use your mouse and keyboard in ${named(win)}.`, danger: false });
    const verdict = v && typeof v === 'object' ? v.verdict : v;
    if (verdict === 'reject') return { ok: false, output: `The user said no to: ${what}.`, meta: { rejected: true } };
  }

  // Focus can drift while the user was asked: check once more right before acting.
  try {
    const now = await host.front();
    if (!matches(now, want)) {
      const again = await host.focus(want);
      if (!again || !again.front) return { ok: false, output: `${named(now)} came to the front before Codeply could act, so nothing was done. Try again.` };
    }
  } catch {}

  try {
    if (action === 'type') await host.type(String(args.text));
    else if (action === 'keys') await host.keys(String(args.keys || args.key || args.text).trim().toLowerCase());
    else if (action === 'scroll') await host.scroll(pt, Number(args.amount) || 3);
    else await host.click(pt, { button: action === 'right_click' ? 'right' : 'left', count: action === 'double_click' ? 2 : 1 });
  } catch (e) {
    return { ok: false, output: `${what} failed: ${e.message}` };
  }
  await sleep(action === 'type' || action === 'keys' ? 500 : 700);
  const r = await seeing(win, `Done: ${what}.`);
  return { ...r, meta: { ...(r.meta || {}), label: clip(what, 100) } };
}

module.exports = { attach, available, tool, ACTIONS };
