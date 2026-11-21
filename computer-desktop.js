// The desktop side of use_computer (codeply-cli/lib/computer.js): voice
// mode's hands (voice/act.js) plus a screenshot of the screen the target
// window is on, so the agent sees what its click or keystroke did.
const path = require('path');
const { screen, desktopCapturer } = require('electron');

let last = null; // the last capture: { bounds, kx, ky, w, h }, to turn picture pixels into screen points

function init({ cliDir, act, ocr }) {
  if (!act || !act.supported() || typeof act.focusWindow !== 'function') return;
  const own = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase();

  const host = {
    front: () => act.frontWindow(),
    focus: (want) => act.focusWindow(want),
    isOwn: (win) => !!win && (String(win.app || '').toLowerCase() === own || /^codeply( craft| crew| voice)?$/i.test(String(win.title || '').trim())),
    async capture(win) {
      const b = win && win.bounds && win.bounds.width > 0 ? win.bounds : null;
      const at = b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : screen.getCursorScreenPoint();
      const d = screen.getDisplayNearestPoint(at);
      const k = Math.min(1, 1600 / d.size.width);
      const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * k), height: Math.round(d.size.height * k) } });
      const src = list.find((s) => String(s.display_id) === String(d.id)) || list[0];
      if (!src || src.thumbnail.isEmpty()) return null;
      const size = src.thumbnail.getSize();
      last = { bounds: d.bounds, kx: size.width / d.bounds.width, ky: size.height / d.bounds.height, w: size.width, h: size.height };
      let text = '';
      if (ocr) { try { text = await Promise.race([ocr(src.thumbnail), new Promise((r) => setTimeout(() => r(''), 2500))]); } catch {} }
      return { image: `data:image/jpeg;base64,${src.thumbnail.toJPEG(78).toString('base64')}`, w: size.width, h: size.height, text };
    },
    point(x, y) {
      if (!last || x < 0 || y < 0 || x >= last.w || y >= last.h) return null;
      return { x: last.bounds.x + x / last.kx, y: last.bounds.y + y / last.ky };
    },
    click: (pt, o) => act.click(pt.x, pt.y, o),
    type: (text) => act.type(text),
    keys: (combo) => act.keys(combo),
    scroll: (pt, clicks) => act.scroll(pt.x, pt.y, clicks),
  };
  require(path.join(cliDir, 'lib', 'computer.js')).attach(host);
  try { act.warm(); } catch {}
}

module.exports = { init };
