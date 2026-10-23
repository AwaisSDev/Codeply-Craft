// Voice mode's hands: real mouse moves, clicks, scrolls, typing and key presses,
// for "click the Instagram tab" or "open my taskbar".
//
// Windows: one PowerShell helper stays open and sends input with SendInput
// (per-monitor DPI aware, so a point lands where it should on any screen).
// macOS: CoreGraphics events through JavaScript for Automation, and System
// Events for typing (both need the Accessibility permission voice mode already
// asks for). Coordinates come in as Electron screen points (DIP).
const { screen, app } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// ─── Windows: a long-lived helper ──────────────────────────────────────────
const WIN_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CraftInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  // 1 = Alt held, 2 = C held: voice mode asks this while listening, as a second opinion on the key hook.
  public static int Held() { return (GetAsyncKeyState(0x12) < 0 ? 1 : 0) | (GetAsyncKeyState(0x43) < 0 ? 2 : 0); }
  static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(uint flags, int data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Dpi() { try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch {} }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Click(int x, int y, string button, int count, int[] mods) {
    SetCursorPos(x, y);
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; }
    if (mods != null) foreach (int m in mods) Key((ushort)m, false);
    for (int n = 0; n < count; n++) { Send(new INPUT[] { M(down, 0), M(up, 0) }); System.Threading.Thread.Sleep(60); }
    if (mods != null) foreach (int m in mods) Key((ushort)m, true);
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); System.Threading.Thread.Sleep(60);
    Send(new INPUT[] { M(0x0002, 0) }); System.Threading.Thread.Sleep(150);
    for (int i = 1; i <= 16; i++) { SetCursorPos(x1 + (x2 - x1) * i / 16, y1 + (y2 - y1) * i / 16); System.Threading.Thread.Sleep(25); }
    System.Threading.Thread.Sleep(150);
    Send(new INPUT[] { M(0x0004, 0) });
  }
  public static void Scroll(int x, int y, int clicks) { SetCursorPos(x, y); Send(new INPUT[] { M(0x0800, -clicks * 120) }); }
  public static void Key(ushort vk, bool up) { Send(new INPUT[] { K(vk, 0, up ? 2u : 0u) }); }
  // Windows: which one is in front, and bringing one forward by its title or app name.
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  static string TitleOf(IntPtr h) { var s = new System.Text.StringBuilder(512); GetWindowText(h, s, 512); return s.ToString().Replace("\t", " "); }
  static string ProcOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
  // "left,top,right,bottom<TAB>process<TAB>title", in physical pixels.
  static string Describe(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.L + "," + r.T + "," + r.R + "," + r.B + "\t" + ProcOf(h) + "\t" + TitleOf(h); }
  public static string Front() { return Describe(GetForegroundWindow()); }
  public static string Focus(string want) {
    want = want.ToLowerInvariant();
    IntPtr found = IntPtr.Zero;
    // Front to back, so the most recently used match wins.
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      string t = TitleOf(h);
      if (t.Length == 0) return true;
      if (t.ToLowerInvariant().Contains(want) || ProcOf(h).ToLowerInvariant().Contains(want)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return "";
    if (IsIconic(found)) ShowWindow(found, 9);
    // Windows only lets the process that has the foreground hand it on: borrow its input queue for a moment.
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid); uint me = GetCurrentThreadId();
    if (fg != me) AttachThreadInput(me, fg, true);
    SetForegroundWindow(found); BringWindowToTop(found);
    if (fg != me) AttachThreadInput(me, fg, false);
    System.Threading.Thread.Sleep(200);
    if (GetForegroundWindow() != found) { Key(0x12, false); Key(0x12, true); SetForegroundWindow(found); System.Threading.Thread.Sleep(200); }
    return Describe(found) + "\t" + (GetForegroundWindow() == found ? "front" : "behind");
  }
  public static void Text(string s) {
    foreach (char c in s) {
      if (c == '\n') { Key(0x0D, false); Key(0x0D, true); continue; }
      Send(new INPUT[] { K(0, c, 0x0004), K(0, c, 0x0004 | 0x0002) });
      System.Threading.Thread.Sleep(6);
    }
  }
}
'@
[CraftInput]::Dpi()
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $c = $null
  $extra = ''
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.op) {
      'move'   { [CraftInput]::Move([int]$c.x, [int]$c.y) }
      'click'  { $mods = @(); if ($c.mods) { $mods = [int[]]$c.mods }; [CraftInput]::Click([int]$c.x, [int]$c.y, [string]$c.button, [int]$c.count, [int[]]$mods) }
      'drag'   { [CraftInput]::Drag([int]$c.x1, [int]$c.y1, [int]$c.x2, [int]$c.y2) }
      'scroll' { [CraftInput]::Scroll([int]$c.x, [int]$c.y, [int]$c.clicks) }
      'keys'   { foreach ($k in $c.down) { [CraftInput]::Key([uint16]$k, $false) }; foreach ($k in $c.up) { [CraftInput]::Key([uint16]$k, $true) } }
      'text'   { [CraftInput]::Text([string]$c.text) }
      'held'   { $extra = ' ' + [CraftInput]::Held() }
      'front'  { $extra = ' ' + [CraftInput]::Front() }
      'focus'  { $extra = ' ' + [CraftInput]::Focus([string]$c.want) }
    }
    [Console]::Out.WriteLine('ok ' + $c.id + $extra)
  } catch {
    $id = ''; if ($c) { $id = $c.id }
    [Console]::Out.WriteLine('err ' + $id + ' ' + ($_.Exception.Message -replace '\s+', ' '))
  }
}
`;

let helper = null;
let helperReady = null;
const waiting = new Map();
let seq = 0;

function startWinHelper() {
  if (helperReady) return helperReady;
  helperReady = new Promise((resolve, reject) => {
    const file = path.join(app.getPath('userData'), 'craft-input.ps1');
    try { fs.writeFileSync(file, WIN_HELPER); } catch (e) { reject(e); return; }
    helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    let buf = '';
    const t = setTimeout(() => reject(new Error('the input helper did not start')), 15000);
    helper.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line === 'ready') { clearTimeout(t); resolve(); continue; }
        const m = /^(ok|err) (\S*) ?(.*)$/.exec(line);
        if (!m) continue;
        const w = waiting.get(m[2]);
        if (w) { waiting.delete(m[2]); m[1] === 'ok' ? w.resolve(m[3]) : w.reject(new Error(m[3] || 'input failed')); }
      }
    });
    helper.stderr.on('data', (d) => console.warn('[voice input]', d.toString().trim().slice(0, 300)));
    helper.on('exit', () => {
      helper = null; helperReady = null;
      for (const w of waiting.values()) w.reject(new Error('the input helper stopped'));
      waiting.clear();
    });
  }).catch((e) => { helperReady = null; throw e; });
  return helperReady;
}

async function winSend(cmd) {
  await startWinHelper();
  const id = String(++seq);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('input timed out')); }, 10000);
    waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    helper.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
  });
}

// Electron points -> physical pixels (what SetCursorPos wants).
function px(x, y) {
  const p = screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) });
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

// ─── macOS ──────────────────────────────────────────────────────────────────
function jxa(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 10000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out)));
  });
}
function macMouse(kind, x, y, extra = '') {
  return jxa(`ObjC.import('CoreGraphics');
const p = $.CGPointMake(${Number(x)}, ${Number(y)});
${extra}
function ev(type, btn) { const e = $.CGEventCreateMouseEvent($(), type, p, btn); $.CGEventPost($.kCGHIDEventTap, e); }
${kind}`);
}
const MAC_KEYS = { enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 117, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121 };

// ─── Keys ───────────────────────────────────────────────────────────────────
const WIN_VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, option: 0x12, win: 0x5B, windows: 0x5B, meta: 0x5B, cmd: 0x5B, command: 0x5B, super: 0x5B,
  enter: 0x0D, return: 0x0D, tab: 0x09, escape: 0x1B, esc: 0x1B, space: 0x20, backspace: 0x08, delete: 0x2E, del: 0x2E, insert: 0x2D,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, printscreen: 0x2C,
};
function vkOf(name) {
  const k = String(name).toLowerCase().trim();
  if (WIN_VK[k]) return WIN_VK[k];
  if (/^f([1-9]|1[0-2])$/.test(k)) return 0x6F + Number(k.slice(1));
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  const punct = { ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0, '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE };
  return punct[k] || 0;
}

// ─── Public ─────────────────────────────────────────────────────────────────
const supported = () => isWin || isMac;

/** Start the helper early, so the first click isn't the slow one. */
function warm() { if (isWin) startWinHelper().catch((e) => console.warn('[voice input]', e.message)); }

async function move(x, y) {
  if (isWin) { const p = px(x, y); return winSend({ op: 'move', ...p }); }
  if (isMac) return macMouse('ev($.kCGEventMouseMoved, $.kCGMouseButtonLeft);', x, y);
  throw new Error('not supported here');
}

/** mods: ['ctrl'] for Ctrl+click (pick several files), ['shift'] for a range. */
async function click(x, y, { button = 'left', count = 1, mods = [] } = {}) {
  if (isWin) { const p = px(x, y); return winSend({ op: 'click', ...p, button, count, mods: mods.map(vkOf).filter(Boolean) }); }
  if (isMac) {
    const [down, up, btn] = button === 'right' ? ['$.kCGEventRightMouseDown', '$.kCGEventRightMouseUp', '$.kCGMouseButtonRight'] : ['$.kCGEventLeftMouseDown', '$.kCGEventLeftMouseUp', '$.kCGMouseButtonLeft'];
    // Cmd (1<<20), Shift (1<<17) and Ctrl (1<<18) held during the click.
    const flags = mods.reduce((f, m) => f | ({ cmd: 1 << 20, command: 1 << 20, ctrl: 1 << 18, control: 1 << 18, shift: 1 << 17 }[m] || 0), 0);
    const flag = (v) => (flags ? ` $.CGEventSetFlags(${v}, ${flags});` : '');
    let body = 'ev($.kCGEventMouseMoved, $.kCGMouseButtonLeft);\n';
    for (let n = 1; n <= count; n++) {
      body += `{ const d = $.CGEventCreateMouseEvent($(), ${down}, p, ${btn}); $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, ${n});${flag('d')} $.CGEventPost($.kCGHIDEventTap, d);
const u = $.CGEventCreateMouseEvent($(), ${up}, p, ${btn}); $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, ${n});${flag('u')} $.CGEventPost($.kCGHIDEventTap, u); delay(0.05); }\n`;
    }
    return macMouse(body, x, y);
  }
  throw new Error('not supported here');
}

/** Press at one spot, glide to another, let go: drop a file on a folder, move a slider. */
async function drag(x1, y1, x2, y2) {
  if (isWin) { const a = px(x1, y1); const b = px(x2, y2); return winSend({ op: 'drag', x1: a.x, y1: a.y, x2: b.x, y2: b.y }); }
  if (isMac) {
    return jxa(`ObjC.import('CoreGraphics');
const a = $.CGPointMake(${Number(x1)}, ${Number(y1)}); const b = $.CGPointMake(${Number(x2)}, ${Number(y2)});
function post(type, p) { $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), type, p, $.kCGMouseButtonLeft)); }
post($.kCGEventMouseMoved, a); post($.kCGEventLeftMouseDown, a); delay(0.15);
for (let i = 1; i <= 16; i++) { post($.kCGEventLeftMouseDragged, $.CGPointMake(${Number(x1)} + (${Number(x2)} - ${Number(x1)}) * i / 16, ${Number(y1)} + (${Number(y2)} - ${Number(y1)}) * i / 16)); delay(0.025); }
delay(0.15); post($.kCGEventLeftMouseUp, b);`);
  }
  throw new Error('not supported here');
}

async function scroll(x, y, clicks) {
  clicks = Math.max(-30, Math.min(30, Math.round(Number(clicks) || 3)));
  if (isWin) { const p = px(x, y); return winSend({ op: 'scroll', ...p, clicks }); }
  if (isMac) return macMouse(`ev($.kCGEventMouseMoved, $.kCGMouseButtonLeft);
const s = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, ${-clicks * 3}); $.CGEventPost($.kCGHIDEventTap, s);`, x, y);
  throw new Error('not supported here');
}

async function type(text) {
  text = String(text || '').slice(0, 2000);
  if (!text) return;
  if (isWin) return winSend({ op: 'text', text });
  if (isMac) return jxa(`Application('System Events').keystroke(${JSON.stringify(text)});`);
  throw new Error('not supported here');
}

/** "ctrl+shift+t", "enter", "win", "cmd+space". */
async function keys(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  if (isWin) {
    const vks = parts.map(vkOf);
    if (vks.some((v) => !v)) throw new Error(`unknown key in "${combo}"`);
    return winSend({ op: 'keys', down: vks, up: [...vks].reverse() });
  }
  if (isMac) {
    const mods = { cmd: 'command down', command: 'command down', meta: 'command down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' };
    const using = parts.filter((p) => mods[p]).map((p) => mods[p]);
    const key = parts.filter((p) => !mods[p])[0];
    if (!key) throw new Error(`no key in "${combo}"`);
    const opts = using.length ? `, { using: ${JSON.stringify(using)} }` : '';
    const call = MAC_KEYS[key] != null ? `keyCode(${MAC_KEYS[key]}${opts})` : `keystroke(${JSON.stringify(key)}${opts})`;
    return jxa(`Application('System Events').${call};`);
  }
  throw new Error('not supported here');
}

/** Windows only: are Alt and C held right now? { alt, c }, or null when it can't tell (yet). */
async function held() {
  if (!isWin || !helperReady) return null;
  const v = Number(await winSend({ op: 'held' }));
  return Number.isFinite(v) ? { alt: !!(v & 1), c: !!(v & 2) } : null;
}

// ─── Windows: which is in front, and bringing one forward ──────────────────
// A window: { app, title, bounds (Electron screen points), front }.
function parseWindow(line, physical) {
  const [rect, app = '', title = '', where = 'front'] = String(line || '').split('\t');
  const n = String(rect || '').split(',').map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
  let bounds = { x: n[0], y: n[1], width: n[2] - n[0], height: n[3] - n[1] };
  if (physical) { try { bounds = screen.screenToDipRect(null, bounds); } catch {} }
  return { app: app.trim(), title: title.trim(), bounds, front: where.trim() !== 'behind' };
}
const MAC_DESCRIBE = `function describe(p) {
  let t = '', b = [0, 0, 0, 0];
  try { const w = p.windows()[0]; t = String(w.name() || ''); const pos = w.position(); const sz = w.size(); b = [pos[0], pos[1], pos[0] + sz[0], pos[1] + sz[1]]; } catch (e) {}
  return b.join(',') + '\\t' + p.name() + '\\t' + t.replace(/\\t/g, ' ');
}
const se = Application('System Events');`;

/** The window in front right now, or null. */
async function frontWindow() {
  if (isWin) return parseWindow(await winSend({ op: 'front' }), true);
  if (isMac) return parseWindow(await jxa(`${MAC_DESCRIBE}\ndescribe(se.applicationProcesses.whose({ frontmost: true })()[0]);`), false);
  throw new Error('not supported here');
}

/** Bring the newest window whose title or app name contains `want` to the front. null when none is open. */
async function focusWindow(want) {
  want = String(want || '').trim().slice(0, 120);
  if (!want) return null;
  if (isWin) { const r = await winSend({ op: 'focus', want }); return String(r || '').trim() ? parseWindow(r, true) : null; }
  if (isMac) {
    const out = await jxa(`${MAC_DESCRIBE}
const want = ${JSON.stringify(want.toLowerCase())};
let hit = null;
for (const p of se.applicationProcesses.whose({ backgroundOnly: false })()) {
  let n = ''; try { n = String(p.name()); } catch (e) {}
  let titles = []; try { titles = p.windows().map((w) => String(w.name() || '')); } catch (e) {}
  if (n.toLowerCase().includes(want) || titles.some((t) => t.toLowerCase().includes(want))) { hit = p; break; }
}
if (!hit) { ''; } else { hit.frontmost = true; delay(0.3); describe(hit) + '\\t' + (hit.frontmost() ? 'front' : 'behind'); }`);
    return String(out || '').trim() ? parseWindow(out.trim(), false) : null;
  }
  throw new Error('not supported here');
}

function dispose() { try { if (helper) helper.kill(); } catch {} }

module.exports = { supported, warm, move, click, drag, scroll, type, keys, held, frontWindow, focusWindow, dispose };
