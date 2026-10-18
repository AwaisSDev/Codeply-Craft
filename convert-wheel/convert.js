// The drag + Shift converter's conversions (see convert-wheel.js).
//
// Everything runs on this PC and nothing is uploaded: sharp for pictures (it
// came with transformers), libheif-js for iPhone HEIC photos, a small BMP
// codec and a small PDF writer below, pdf.js in a hidden window for PDF pages,
// and Word for documents when it's installed (docx-preview when it isn't).
// The result is written next to the original as "name.ext", or "name (2).ext".
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');

let sharpLib = null;
const sharp = () => sharpLib || (sharpLib = require('sharp'));

const IMAGE_IN = ['png', 'jpg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'heic'];
const IMAGE_OUT = ['png', 'jpg', 'webp', 'avif', 'tiff', 'bmp'];
const DOC_IN = ['docx', 'doc', 'rtf', 'odt'];
const LABEL = { jpg: 'JPG', png: 'PNG', webp: 'WEBP', avif: 'AVIF', tiff: 'TIFF', bmp: 'BMP', gif: 'GIF', heic: 'HEIC', pdf: 'PDF', docx: 'DOCX', doc: 'DOC', rtf: 'RTF', odt: 'ODT' };

/** "photo.JPEG" -> "jpg": one name per format. */
function extOf(file) {
  const e = path.extname(file).slice(1).toLowerCase();
  return { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', tif: 'tiff', heif: 'heic', hif: 'heic' }[e] || e;
}

/** What a file of this kind can become. `word`: Microsoft Word is installed. */
function targetsFor(ext, { word = false } = {}) {
  if (IMAGE_IN.includes(ext)) return [...IMAGE_OUT, 'pdf'].filter((t) => t !== ext);
  if (ext === 'pdf') return [...IMAGE_OUT, ...(word ? ['docx'] : [])];
  if (ext === 'docx') return ['pdf', 'png', 'jpg'];
  if (DOC_IN.includes(ext)) return word ? ['pdf', 'docx', 'png', 'jpg'] : [];
  return [];
}

/** Every input format and what it can become, for the wheel. */
function formatTable(caps) {
  const table = {};
  for (const ext of [...IMAGE_IN, 'pdf', ...DOC_IN]) {
    const t = targetsFor(ext, caps);
    if (t.length) table[ext] = t;
  }
  return table;
}

/** "name.ext" in dir, or "name (2).ext" and up when that's taken. */
function freePath(dir, base, ext) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}${n > 1 ? ` (${n})` : ''}${ext ? `.${ext}` : ''}`);
    if (!fs.existsSync(p)) return p;
  }
}

// ─── BMP: sharp's build can't read or write it, and it's simple enough ──────

function decodeBmp(buf) {
  if (buf.toString('latin1', 0, 2) !== 'BM') throw new Error('not a BMP file');
  const off = buf.readUInt32LE(10);
  const hdr = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const rawH = buf.readInt32LE(22);
  const height = Math.abs(rawH);
  const bpp = buf.readUInt16LE(28);
  const comp = hdr >= 40 ? buf.readUInt32LE(30) : 0;
  if (comp !== 0 && comp !== 3 && comp !== 6) throw new Error('compressed BMP files are not supported');
  if (width <= 0 || !height || width * height > 2.7e8) throw new Error('BMP size looks wrong');
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const out = Buffer.alloc(width * height * 4);
  // palette for 1, 4 and 8 bit images
  const colors = hdr >= 40 ? buf.readUInt32LE(46) || (1 << bpp) : (1 << bpp);
  const palOff = 14 + hdr;
  // channel masks for 16 and 32 bit images
  let masks = null;
  if (comp === 3 || comp === 6) {
    const at = hdr >= 52 ? 54 : 14 + hdr; // masks sit in the header (v4/v5) or right after it
    masks = [buf.readUInt32LE(at), buf.readUInt32LE(at + 4), buf.readUInt32LE(at + 8), hdr >= 56 || comp === 6 ? buf.readUInt32LE(at + 12) : 0];
  } else if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f, 0];
  else if (bpp === 32) masks = [0xff0000, 0xff00, 0xff, 0];
  const take = (v, m) => {
    if (!m) return 255;
    let shift = 0; while (!((m >>> shift) & 1)) shift++;
    const max = m >>> shift;
    return Math.round((((v & m) >>> shift) * 255) / max);
  };
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = off + (rawH > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (bpp <= 8) {
        const bit = x * bpp;
        const idx = (buf[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const p = palOff + Math.min(idx, colors - 1) * 4;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else if (bpp === 24) {
        const p = row + x * 3; b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else if (bpp === 16 || bpp === 32) {
        const v = bpp === 16 ? buf.readUInt16LE(row + x * 2) : buf.readUInt32LE(row + x * 4);
        r = take(v, masks[0]); g = take(v, masks[1]); b = take(v, masks[2]);
        if (masks[3]) { a = take(v, masks[3]); if (a !== 255) anyAlpha = true; }
      } else throw new Error(`${bpp} bit BMP files are not supported`);
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  // A 32 bit BMP whose alpha is all zero means "no alpha", not "invisible".
  if (masks && masks[3] && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { data: out, width, height, channels: 4 };
}

/** 24 bit BMP, or 32 bit when `alpha` (the picture has see-through parts). */
function encodeBmp({ data, width, height, channels, alpha = channels === 4 }) {
  const bpp = alpha ? 32 : 24;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const hdr = alpha ? 108 : 40;
  const off = 14 + hdr;
  const buf = Buffer.alloc(off + stride * height);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(off, 10);
  buf.writeUInt32LE(hdr, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(alpha ? 3 : 0, 30);
  buf.writeUInt32LE(stride * height, 34);
  buf.writeInt32LE(3780, 38); buf.writeInt32LE(3780, 42); // 96 dpi
  if (alpha) {
    buf.writeUInt32LE(0x00ff0000, 54); buf.writeUInt32LE(0x0000ff00, 58); buf.writeUInt32LE(0x000000ff, 62); buf.writeUInt32LE(0xff000000, 66);
    buf.write('BGRs', 70, 'latin1'); // LCS_sRGB, stored backwards
  }
  for (let y = 0; y < height; y++) {
    const row = off + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const o = row + x * (bpp / 8);
      buf[o] = data[i + 2]; buf[o + 1] = data[i + 1]; buf[o + 2] = data[i];
      if (alpha) buf[o + 3] = data[i + 3];
    }
  }
  return buf;
}

// ─── HEIC: libheif-js (WebAssembly) when sharp can't read it ────────────────

let heifLib = null;
async function decodeHeic(buf) {
  if (!heifLib) heifLib = require('libheif-js/wasm-bundle');
  const images = new heifLib.HeifDecoder().decode(buf);
  if (!images || !images.length) throw new Error('could not read this HEIC photo');
  const img = images[0]; // the primary image; the rest are thumbnails or depth maps
  const width = img.get_width(), height = img.get_height();
  const pixels = await new Promise((resolve, reject) => {
    img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (r) => (r ? resolve(r.data) : reject(new Error('could not read this HEIC photo'))));
  });
  for (const i of images) { try { i.free(); } catch {} }
  return { data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height, channels: 4 };
}

/** A sharp pipeline for page `page` of a picture, upright. */
async function openImage(src, { page = 0, animated = false } = {}) {
  const ext = extOf(src);
  if (ext === 'bmp') {
    const raw = decodeBmp(await fs.promises.readFile(src));
    return sharp()(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } });
  }
  if (ext === 'heic') {
    // AV1 HEIF files open in sharp; iPhone (HEVC) ones need libheif.
    let raw;
    try {
      const { data, info } = await sharp()(src).rotate().raw().toBuffer({ resolveWithObject: true });
      raw = { data, width: info.width, height: info.height, channels: info.channels };
    } catch { raw = await decodeHeic(await fs.promises.readFile(src)); }
    return sharp()(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
  }
  return sharp()(src, { page, animated, limitInputPixels: 2.7e8 }).rotate();
}

/** Writes a sharp pipeline as `to` (an image format) to `out`. */
async function saveImage(img, to, out) {
  if (to === 'bmp') {
    const { data, info } = await img.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let alpha = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = true; break; }
    await fs.promises.writeFile(out, encodeBmp({ data, width: info.width, height: info.height, channels: 4, alpha }));
    return;
  }
  if (to === 'jpg') img = img.flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true });
  else if (to === 'png') img = img.png();
  else if (to === 'webp') img = img.webp({ quality: 90 });
  else if (to === 'avif') img = img.avif({ quality: 60 });
  else if (to === 'tiff') img = img.tiff({ compression: 'lzw' });
  else if (to === 'gif') img = img.gif();
  else throw new Error(`can't save as ${to}`);
  await img.toFile(out);
}

// ─── PDF: one picture per page ──────────────────────────────────────────────

/** A PDF of `pages`: [{ width, height (points), image: { w, h, gray, jpeg?, data } }]. */
function writePdf(pages) {
  const chunks = [];
  const offsets = [];
  let size = 0;
  const put = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); chunks.push(buf); size += buf.length; };
  const obj = (n, body, stream) => {
    offsets[n] = size;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const n = 3 + i * 3;
    const w = p.width.toFixed(2), h = p.height.toFixed(2);
    const content = Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`, 'latin1');
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${content.length} >>`, content);
    const im = p.image;
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /${im.jpeg ? 'DCTDecode' : 'FlateDecode'} /Length ${im.data.length} >>`, im.data);
  });
  const count = 3 + pages.length * 3;
  const xref = size;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** One PDF page from a sharp pipeline, at the picture's own size (its dpi, or 96). */
async function pdfPage(img, { jpegBytes = null } = {}) {
  const meta = await img.clone().metadata();
  const dpi = meta.density && meta.density >= 50 && meta.density <= 1200 ? meta.density : 96;
  let image;
  if (jpegBytes) {
    image = { w: meta.width, h: meta.height, gray: meta.channels === 1, jpeg: true, data: jpegBytes };
  } else {
    const gray = meta.channels <= 2 && meta.space === 'b-w';
    const flat = img.flatten({ background: '#ffffff' }).toColourspace(gray ? 'b-w' : 'srgb');
    const { data, info } = await (gray ? flat.extractChannel(0) : flat.removeAlpha()).raw().toBuffer({ resolveWithObject: true });
    image = { w: info.width, h: info.height, gray: info.channels === 1, data: zlib.deflateSync(data, { level: 6 }) };
  }
  // PDF pages stop at 200 inches; scale the page (not the picture) down past that.
  const scale = Math.min(72 / dpi, 14400 / Math.max(image.w, image.h));
  return { width: image.w * scale, height: image.h * scale, image };
}

async function imageToPdf(src, out) {
  const ext = extOf(src);
  const pages = [];
  if (ext === 'jpg') {
    // A plain RGB or gray JPEG goes in as it is: no quality lost, no size gained.
    const meta = await sharp()(src).metadata();
    if ((meta.channels === 3 || meta.channels === 1) && (!meta.orientation || meta.orientation === 1)) {
      pages.push(await pdfPage(sharp()(src), { jpegBytes: await fs.promises.readFile(src) }));
    }
  }
  if (!pages.length) {
    let count = 1;
    if (ext === 'tiff') { try { count = (await sharp()(src).metadata()).pages || 1; } catch {} }
    for (let i = 0; i < count; i++) pages.push(await pdfPage(await openImage(src, { page: i })));
  }
  await fs.promises.writeFile(out, writePdf(pages));
}

// ─── Word, through its COM interface (only when it's installed) ─────────────

// "16.0" when Word 2016 or later is installed, else ''.
let wordCheck = null;
function wordVersion() {
  if (process.platform !== 'win32') return Promise.resolve('');
  if (!wordCheck) {
    wordCheck = new Promise((resolve) => {
      let out = '';
      const p = spawn('reg', ['query', 'HKCR\\Word.Application\\CurVer', '/ve'], { windowsHide: true });
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve(''));
      p.on('exit', (code) => { const m = /Word\.Application\.(\d+)/i.exec(out); resolve(code === 0 && m ? `${m[1]}.0` : ''); });
    });
  }
  return wordCheck;
}
const hasWord = async () => !!(await wordVersion());

// Paths go in through the environment, so no quoting can break the script.
// Opening a PDF makes Word ask "Word will now convert your PDF..." even with
// alerts off, so its "don't ask" option is set for the moment and put back after.
// The new Word's process id goes to stdout, so a stuck one can be ended.
const WORD_SCRIPT = `
$ErrorActionPreference = 'Stop'
$opts = 'HKCU:\\Software\\Microsoft\\Office\\' + $env:CW_WORDVER + '\\Word\\Options'
$isPdf = $env:CW_IN.ToLower().EndsWith('.pdf')
$had = $null
$w = $null
try {
  if ($isPdf) {
    if (-not (Test-Path $opts)) { New-Item $opts -Force | Out-Null }
    $had = (Get-ItemProperty $opts -Name DisableConvertPdfWarning -ErrorAction SilentlyContinue).DisableConvertPdfWarning
    Set-ItemProperty $opts -Name DisableConvertPdfWarning -Value 1 -Type DWord
  }
  $before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $w = New-Object -ComObject Word.Application
  Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { [Console]::Out.WriteLine('PID ' + $_.Id); [Console]::Out.Flush() }
  $w.Visible = $false
  $w.DisplayAlerts = 0
  # Read-only for documents; a PDF opened read-only stalls Word's conversion.
  # Either way the original is closed without saving.
  $d = $w.Documents.Open($env:CW_IN, $false, (-not $isPdf), $false)
  try {
    if ($env:CW_TO -eq 'pdf') { $d.ExportAsFixedFormat($env:CW_OUT, 17) }
    else { $d.SaveAs2($env:CW_OUT, 16) }
  } finally { try { $d.Close([ref]0) } catch {} }
} finally {
  if ($w) {
    try { $w.Quit([ref]0) } catch {}
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w)
  }
  if ($isPdf) {
    if ($null -eq $had) { Remove-ItemProperty $opts -Name DisableConvertPdfWarning -ErrorAction SilentlyContinue }
    else { Set-ItemProperty $opts -Name DisableConvertPdfWarning -Value $had -Type DWord }
  }
}
`;

async function withWord(src, to, out) {
  const ver = await wordVersion();
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WORD_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true, env: { ...process.env, CW_IN: src, CW_OUT: out, CW_TO: to, CW_WORDVER: ver || '16.0' },
    });
    let err = '';
    let wordPid = 0;
    p.stdout.on('data', (d) => { const m = /PID (\d+)/.exec(String(d)); if (m) wordPid = Number(m[1]); });
    p.stderr.on('data', (d) => { err += d; });
    // A Word that hangs (a prompt nobody can see) is ended, with the script.
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      if (wordPid) { try { process.kill(wordPid); } catch {} }
    }, 120000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(out)) resolve();
      else reject(new Error(/password/i.test(err) ? 'this document has a password' : 'Word could not convert this file'));
    });
  });
}

// ─── The conversions ────────────────────────────────────────────────────────

/**
 * Converts `src` to `to` next to it (or into `outDir`). `host` gives the hidden
 * render window: renderPdf(bytes, { all }, onPage) and docxToPdf(bytes).
 * `pdfAllPages`: a PDF becomes one picture per page (else just page one).
 * Returns { outputs: [paths], reveal: the path to show in its folder }.
 */
async function convert(src, to, { host, outDir = null, pdfAllPages = true } = {}) {
  const from = extOf(src);
  const caps = { word: await hasWord() };
  if (!targetsFor(from, caps).includes(to)) throw new Error(`can't turn ${LABEL[from] || from.toUpperCase() || 'this file'} into ${LABEL[to] || to}`);
  const dir = outDir || path.dirname(src);
  const base = path.basename(src, path.extname(src));

  if (IMAGE_IN.includes(from)) {
    const out = freePath(dir, base, to);
    if (to === 'pdf') await imageToPdf(src, out);
    else {
      const moving = (from === 'gif' || from === 'webp') && to === 'webp';
      await saveImage(await openImage(src, { animated: moving }), to, out);
    }
    return { outputs: [out], reveal: out };
  }

  if (from === 'pdf' && to === 'docx') {
    const out = freePath(dir, base, 'docx');
    await withWord(src, 'docx', out);
    return { outputs: [out], reveal: out };
  }

  if (from === 'pdf') return pdfToImages(src, to, { host, dir, base, all: pdfAllPages });

  // Documents
  if (to === 'pdf' || to === 'docx') {
    const out = freePath(dir, base, to);
    if (caps.word) await withWord(src, to, out);
    else await fs.promises.writeFile(out, await host.docxToPdf(await fs.promises.readFile(src)));
    return { outputs: [out], reveal: out };
  }
  // A document as pictures: through a PDF in the temp folder.
  const tmp = path.join(os.tmpdir(), `codeply-convert-${process.pid}-${Date.now()}.pdf`);
  try {
    if (caps.word) await withWord(src, 'pdf', tmp);
    else await fs.promises.writeFile(tmp, await host.docxToPdf(await fs.promises.readFile(src)));
    return await pdfToImages(tmp, to, { host, dir, base, all: pdfAllPages });
  } finally { fs.promises.unlink(tmp).catch(() => {}); }
}

async function pdfToImages(src, to, { host, dir, base, all }) {
  const bytes = await fs.promises.readFile(src);
  const outputs = [];
  let folder = null;
  await host.renderPdf(bytes, { all }, async (png, index, total) => {
    let out;
    if (total === 1) out = freePath(dir, base, to);
    else {
      // Many pages go in their own folder, so they don't spill over the original's.
      if (!folder) { folder = freePath(dir, `${base} (${LABEL[to]})`, ''); await fs.promises.mkdir(folder); }
      out = path.join(folder, `${base} ${String(index + 1).padStart(String(total).length, '0')}.${to}`);
    }
    await saveImage(sharp()(png), to, out);
    outputs.push(out);
  });
  if (!outputs.length) throw new Error('this PDF has no pages');
  return { outputs, reveal: folder || outputs[0] };
}

module.exports = { convert, targetsFor, formatTable, hasWord, extOf, freePath, LABEL, decodeBmp, encodeBmp, writePdf };
