// The user's own wallpapers (wallpaper.js draws them). A picked image is
// copied into this PC's app data folder, scaled down to at most 2560px on its
// long edge so it never costs more memory than a screen needs, and a small
// thumbnail is kept next to it for the Appearance picker. Nothing here is
// ever uploaded: the images stay in <userData>/wallpapers.
//
//   wallpaper:list            -> [{ id, name, thumb }]   thumb is a data: URL
//   wallpaper:add             -> { id, name, thumb } | null   opens a file picker
//   wallpaper:read   id       -> Uint8Array | null       the image's bytes
//   wallpaper:remove id       -> true | false
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_EDGE = 2560;
const THUMB_EDGE = 320;
const MAX_BYTES = 40 * 1024 * 1024;
const EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const ID = /^[a-f0-9]{16}\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function init({ ipcMain, app, dialog, nativeImage, getWindow }) {
  const dir = () => path.join(app.getPath('userData'), 'wallpapers');
  const thumbOf = (id) => path.join(dir(), id.replace(/\.[^.]+$/, '') + '.thumb.jpg');
  const nameOf = (id) => path.join(dir(), id.replace(/\.[^.]+$/, '') + '.name');

  function entry(id) {
    let thumb = '';
    try { thumb = 'data:image/jpeg;base64,' + fs.readFileSync(thumbOf(id)).toString('base64'); } catch {}
    if (!thumb) {
      // No thumbnail (a format nativeImage can't read, like webp): the picker shows the image itself.
      try {
        const buf = fs.readFileSync(path.join(dir(), id));
        if (buf.length < 4 * 1024 * 1024) thumb = `data:image/${path.extname(id).slice(1).replace('jpg', 'jpeg')};base64,` + buf.toString('base64');
      } catch {}
    }
    let name = '';
    try { name = fs.readFileSync(nameOf(id), 'utf8').slice(0, 120); } catch {}
    return { id, name: name || 'Your image', thumb };
  }

  ipcMain.handle('wallpaper:list', () => {
    let names = [];
    try { names = fs.readdirSync(dir()).filter((n) => ID.test(n)); } catch { return []; }
    return names
      .map((n) => ({ n, t: (() => { try { return fs.statSync(path.join(dir(), n)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => a.t - b.t)
      .map(({ n }) => entry(n));
  });

  ipcMain.handle('wallpaper:add', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose a background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
    });
    const src = !r.canceled && r.filePaths[0];
    if (!src || !EXT.test(src)) return null;
    let st;
    try { st = fs.statSync(src); } catch { return null; }
    if (!st.isFile() || st.size > MAX_BYTES) return { error: 'That image is too big. Pick one under 40 MB.' };

    fs.mkdirSync(dir(), { recursive: true });
    const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 16);
    const img = nativeImage.createFromPath(src);
    let id;
    if (!img.isEmpty()) {
      // Decodable here (png, jpeg, bmp): keep a screen-sized copy, not the original.
      const { width, height } = img.getSize();
      const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
      const big = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : img;
      id = hash + '.jpg';
      fs.writeFileSync(path.join(dir(), id), big.toJPEG(90));
      const ts = Math.min(1, THUMB_EDGE / Math.max(width, height));
      fs.writeFileSync(thumbOf(id), img.resize({ width: Math.max(1, Math.round(width * ts)), height: Math.max(1, Math.round(height * ts)), quality: 'good' }).toJPEG(80));
    } else {
      // webp, gif, avif: copied as they are; the window decodes them itself.
      id = hash + path.extname(src).toLowerCase().replace('.jpeg', '.jpg');
      fs.copyFileSync(src, path.join(dir(), id));
    }
    try { fs.writeFileSync(nameOf(id), path.basename(src).replace(/\.[^.]+$/, '')); } catch {}
    return entry(id);
  });

  ipcMain.handle('wallpaper:read', (e, id) => {
    if (!ID.test(String(id || ''))) return null;
    try { return new Uint8Array(fs.readFileSync(path.join(dir(), id))); } catch { return null; }
  });

  ipcMain.handle('wallpaper:remove', (e, id) => {
    if (!ID.test(String(id || ''))) return false;
    for (const p of [path.join(dir(), id), thumbOf(id), nameOf(id)]) { try { fs.unlinkSync(p); } catch {} }
    return true;
  });
}

module.exports = { init };
