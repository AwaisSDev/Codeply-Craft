// Text on the screen for the life context (Life source "screen"), free and on
// this PC: Electron grabs the screen as an image, Windows' own OCR
// (Windows.Media.Ocr, no download, no cloud) reads it, and the image is
// deleted at once. Only the text is kept, and only in the local life store.
//
// One small PowerShell process for the life of the app: Node writes a file
// path, it answers with {"text"} or {"error"}.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { desktopCapturer, screen } = require('electron');

const OCR_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $out = $null
  try {
    if ($engine -eq $null) { throw 'Windows has no OCR language installed.' }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($line)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      # Each line with its box, so Node can put a table row back on one line.
      $lines = New-Object System.Collections.ArrayList
      foreach ($l in $result.Lines) {
        $x1 = 1e9; $y1 = 1e9; $x2 = 0; $y2 = 0
        foreach ($w in $l.Words) {
          $r = $w.BoundingRect
          if ($r.X -lt $x1) { $x1 = $r.X }; if ($r.Y -lt $y1) { $y1 = $r.Y }
          if ($r.X + $r.Width -gt $x2) { $x2 = $r.X + $r.Width }; if ($r.Y + $r.Height -gt $y2) { $y2 = $r.Y + $r.Height }
        }
        [void]$lines.Add(@{ t = $l.Text; x = [int]$x1; y = [int]$y1; w = [int]($x2 - $x1); h = [int]($y2 - $y1) })
      }
      $out = @{ lines = $lines.ToArray() } | ConvertTo-Json -Compress -Depth 4
    } finally { $stream.Dispose() }
  } catch { $out = @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }
  [Console]::Out.WriteLine($out)
}
`;

let proc = null;
let waiting = null;
let dir = '';
function helper() {
  if (proc) return proc;
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'craft-screen-'));
  const file = path.join(dir, 'ocr.ps1');
  fs.writeFileSync(file, OCR_HELPER);
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, cwd: dir });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line || !waiting) continue;
      const w = waiting; waiting = null;
      try { w(JSON.parse(line)); } catch { w({ error: 'bad answer' }); }
    }
  });
  proc.on('exit', () => { proc = null; if (waiting) { const w = waiting; waiting = null; w({ error: 'stopped' }); } });
  proc.stderr.on('data', () => {});
  return proc;
}
function ocr(file) {
  return new Promise((resolve) => {
    if (waiting) { resolve({ error: 'busy' }); return; }
    const t = setTimeout(() => { if (waiting) { waiting = null; resolve({ error: 'timeout' }); } }, 20000);
    waiting = (r) => { clearTimeout(t); resolve(r); };
    try { helper().stdin.write(`${file}\n`); } catch (e) { clearTimeout(t); waiting = null; resolve({ error: e.message }); }
  });
}

/**
 * The text on the screen the user is working on (the one with the mouse).
 * One capture of that screen, not of every window, so it stays cheap. '' when
 * there is nothing to read.
 */
async function read() {
  const r = await readWithImage();
  return r.text;
}

/** One picture of the screen with the mouse (an Electron NativeImage), or null. */
async function capture() {
  if (process.platform !== 'win32') return null;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = d.size.width * d.scaleFactor; const h = d.size.height * d.scaleFactor;
  const k = Math.min(1, 2560 / Math.max(w, h)); // the OCR reads images up to 2600 px a side
  const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(w * k), height: Math.round(h * k) } });
  const src = list.find((s) => String(s.display_id) === String(d.id)) || list[0] || null;
  return src && !src.thumbnail.isEmpty() ? src.thumbnail : null;
}

/** The picture and its text, from one capture (Life keeps both: the text in its store, the picture in memory). */
async function readWithImage() {
  const img = await capture();
  return { img, text: img ? await ocrImage(img) : '' };
}

/** The text in a picture (an Electron NativeImage), read by the OCR built into Windows. */
async function ocrImage(img) {
  if (process.platform !== 'win32' || !img || img.isEmpty()) return '';
  helper();
  const file = path.join(dir, `shot-${Date.now()}.png`);
  fs.writeFileSync(file, img.toPNG());
  try {
    const r = await ocr(file);
    if (r.error) throw new Error(r.error);
    return r.lines ? layout(r.lines) : String(r.text || '').replace(/[ \t]+/g, ' ').trim();
  } finally { fs.rm(file, { force: true }, () => {}); }
}

/**
 * The OCR's lines put back the way the screen shows them. The OCR reads a
 * table cell by cell, so a name and its numbers end up far apart; here every
 * line at the same height becomes one row, left to right, with " | " where
 * there is a gap between columns. "Marwa Gamal | Egypt | Craft 100% | 532k".
 */
function layout(lines) {
  const ls = (Array.isArray(lines) ? lines : lines ? [lines] : [])
    .filter((l) => l && String(l.t || '').trim() && l.h > 0)
    .map((l) => ({ t: String(l.t).replace(/[ \t]+/g, ' ').trim(), x: l.x, y: l.y, w: l.w, h: l.h }))
    .sort((a, b) => a.y - b.y);
  // One row = lines whose heights overlap, so a two-line cell (a name over an
  // email) stays with the numbers next to it that sit between the two.
  const rows = [];
  for (const l of ls) {
    const row = rows[rows.length - 1];
    const pad = l.h * 0.1;
    if (row && l.y - pad <= row.bottom) { row.items.push(l); row.bottom = Math.max(row.bottom, l.y + l.h + pad); }
    else rows.push({ bottom: l.y + l.h + pad, items: [l] });
  }
  return rows.map((r) => {
    // Left to right; lines in the same column keep their top-to-bottom order.
    r.items.sort((a, b) => (Math.abs(a.x - b.x) < Math.min(a.h, b.h) ? a.y - b.y : a.x - b.x));
    let s = ''; let end = -1;
    for (const it of r.items) {
      s += end < 0 ? it.t : (it.x - end > it.h * 1.5 ? ' | ' : ' ') + it.t;
      end = Math.max(end, it.x + it.w);
    }
    return s;
  }).join('\n');
}

function stop() { try { if (proc) proc.kill(); } catch {} proc = null; }

module.exports = { read, readWithImage, capture, ocrImage, layout, stop, OCR_HELPER };
