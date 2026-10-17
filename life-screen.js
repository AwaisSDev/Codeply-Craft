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
      $text = ($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine
      $out = @{ text = $text } | ConvertTo-Json -Compress
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
  if (process.platform !== 'win32') return '';
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = d.size.width * d.scaleFactor; const h = d.size.height * d.scaleFactor;
  const k = Math.min(1, 2560 / Math.max(w, h)); // the OCR reads images up to 2600 px a side
  const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(w * k), height: Math.round(h * k) } });
  const src = list.find((s) => String(s.display_id) === String(d.id)) || list[0] || null;
  if (!src || src.thumbnail.isEmpty()) return '';
  helper();
  const file = path.join(dir, `shot-${Date.now()}.png`);
  fs.writeFileSync(file, src.thumbnail.toPNG());
  try {
    const r = await ocr(file);
    if (r.error) throw new Error(r.error);
    return String(r.text || '').replace(/[ \t]+/g, ' ').trim();
  } finally { fs.rm(file, { force: true }, () => {}); }
}

function stop() { try { if (proc) proc.kill(); } catch {} proc = null; }

module.exports = { read, stop, OCR_HELPER };
