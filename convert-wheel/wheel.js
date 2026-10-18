// The drag + Shift wheel (see convert-wheel.js). The window sits under the mouse,
// invisible, until a file drag comes in. Then the formats that file can become
// pop in as a ring, the one under the mouse lights up, and a drop on it starts
// the conversion. A drop anywhere else is refused, so nothing happens.
(() => {
  const C = 180;              // the centre, in the 360 x 360 window
  const R_OUT = 150, R_IN = 74, HUB = 62;
  const ROUND = 9, GAP = 7;   // corner rounding and the space between segments
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('wheel');

  // What the drag says a file is, before it's dropped (the path comes only on drop).
  const MIME = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/pjpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif',
    'image/tiff': 'tiff', 'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp', 'image/gif': 'gif',
    'image/heic': 'heic', 'image/heif': 'heic', 'image/heic-sequence': 'heic', 'image/heif-sequence': 'heic',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
    'application/vnd.oasis.opendocument.text': 'odt',
  };
  const LABEL = { jpg: 'JPG', png: 'PNG', webp: 'WEBP', avif: 'AVIF', tiff: 'TIFF', bmp: 'BMP', gif: 'GIF', heic: 'HEIC', pdf: 'PDF', docx: 'DOCX', doc: 'DOC', rtf: 'RTF', odt: 'ODT' };

  let formats = {};
  let state = 'off';          // off | armed (invisible, waiting) | open | done
  let targets = [];
  let hot = -1;
  let leaveTimer = null;

  const polar = (r, deg) => { const a = (deg * Math.PI) / 180; return [C + r * Math.cos(a), C + r * Math.sin(a)]; };
  const pt = (p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  const el = (tag, attrs = {}, parent = null) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };

  // A ring segment with soft corners: drawn a little smaller, then stroked
  // with round joins as wide as the rounding, so the outline grows back out round.
  function segPath(a0, a1, inset = ROUND) {
    const ro = R_OUT - inset, ri = R_IN + inset, d = GAP / 2 + inset;
    const deg = (x) => (x * 180) / Math.PI;
    const o0 = a0 + deg(Math.asin(d / ro)), o1 = a1 - deg(Math.asin(d / ro));
    const i0 = a0 + deg(Math.asin(d / ri)), i1 = a1 - deg(Math.asin(d / ri));
    const big = o1 - o0 > 180 ? 1 : 0;
    return `M ${pt(polar(ro, o0))} A ${ro} ${ro} 0 ${big} 1 ${pt(polar(ro, o1))} L ${pt(polar(ri, i1))} A ${ri} ${ri} 0 ${i1 - i0 > 180 ? 1 : 0} 0 ${pt(polar(ri, i0))} Z`;
  }

  function build(list, ext, count) {
    svg.textContent = '';
    const span = 360 / list.length;
    list.forEach((t, i) => {
      const a0 = -90 - span / 2 + i * span, a1 = a0 + span;
      const g = el('g', { class: 'seg', 'data-i': i, style: `--i:${i}` }, svg);
      el('path', { d: segPath(a0, a1), 'stroke-width': ROUND * 2 }, g);
      el('path', { class: 'rim', d: segPath(a0, a1, 0) }, g);
      const mid = (a0 + a1) / 2;
      const [lx, ly] = polar((R_OUT + R_IN) / 2, mid);
      const label = el('text', { x: lx.toFixed(1), y: ly.toFixed(1) }, g);
      label.textContent = LABEL[t] || t.toUpperCase();
      // the little "+" that says "drop here to add this"
      const [bx, by] = polar(R_OUT - 8, mid + span / 2 - (GAP + 14) * (180 / Math.PI) / R_OUT);
      const b = el('g', { class: 'badge' }, g);
      el('circle', { cx: bx.toFixed(1), cy: by.toFixed(1), r: 10 }, b);
      el('path', { d: `M ${bx - 4.5} ${by} H ${bx + 4.5} M ${bx} ${by - 4.5} V ${by + 4.5}` }, b);
    });
    // the hub: the dragged file
    const hub = el('g', { class: 'hub' }, svg);
    el('circle', { class: 'disc', cx: C, cy: C, r: HUB }, hub);
    const w = 30, h = 38, x = C - w / 2, y = C - h / 2 - 9, f = 9;
    el('path', { class: 'doc', d: `M ${x + 4} ${y} H ${x + w - f} L ${x + w} ${y + f} V ${y + h - 4} Q ${x + w} ${y + h} ${x + w - 4} ${y + h} H ${x + 4} Q ${x} ${y + h} ${x} ${y + h - 4} V ${y + 4} Q ${x} ${y} ${x + 4} ${y} Z` }, hub);
    el('path', { class: 'fold', d: `M ${x + w - f} ${y} V ${y + f} H ${x + w}` }, hub);
    el('path', { class: 'lines', d: `M ${x + 7} ${y + 17} H ${x + w - 7} M ${x + 7} ${y + 23} H ${x + w - 7} M ${x + 7} ${y + 29} H ${x + w - 12}` }, hub);
    const label = el('text', { class: 'ext', x: C, y: C + 30 }, hub);
    label.textContent = ext ? (LABEL[ext] || ext.toUpperCase()) : count > 1 ? 'FILES' : 'FILE';
    if (count > 1) {
      const c = el('g', { class: 'count' }, hub);
      el('circle', { cx: x + w + 2, cy: y + 2, r: 9 }, c);
      el('text', { x: x + w + 2, y: y + 2.5 }, c).textContent = count > 99 ? '99+' : String(count);
    }
  }

  // What every dragged file can become (the formats they all share).
  function readDrag(dt) {
    const types = [...(dt.types || [])];
    if (!types.includes('Files')) return null;
    const kinds = [...(dt.items || [])].filter((it) => it.kind === 'file').map((it) => MIME[(it.type || '').toLowerCase()] || null);
    if (!kinds.length) return null;
    // Windows gives some files no type at all (HEIC photos, for one). Those get
    // the picture formats; if one isn't a picture after all, the toast says so.
    const guess = (k) => formats[k] || (k ? [] : formats.heic || []);
    let list = guess(kinds[0]);
    for (const k of kinds.slice(1)) list = list.filter((t) => guess(k).includes(t));
    const same = kinds[0] && kinds.every((k) => k === kinds[0]);
    return { list, ext: same ? kinds[0] : null, count: kinds.length };
  }

  function setHot(i) {
    if (i === hot) return;
    hot = i;
    svg.querySelectorAll('.seg').forEach((g) => g.classList.toggle('hot', Number(g.dataset.i) === i));
  }

  function hitTest(x, y) {
    const dx = x - C, dy = y - C;
    const r = Math.hypot(dx, dy);
    if (r < R_IN - 2 || r > R_OUT + 6 || !targets.length) return -1;
    const span = 360 / targets.length;
    const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + span / 2 + 720) % 360;
    return Math.floor(deg / span) % targets.length;
  }

  function reset() {
    clearTimeout(leaveTimer);
    document.body.className = '';
    targets = [];
    hot = -1;
    svg.textContent = '';
  }

  window.cw.onArm((d) => {
    reset();
    formats = d.formats || {};
    state = 'armed';
    if (window.applyDropTheme) window.applyDropTheme();
  });
  window.cw.onDisarm(() => {
    if (state === 'open') { document.body.className = 'closing'; setTimeout(() => { if (state === 'off') reset(); }, 180); }
    else if (state !== 'done') reset();
    state = 'off';
  });

  function open(e) {
    const drag = readDrag(e.dataTransfer);
    if (!drag || !drag.list.length) { state = 'off'; window.cw.notFiles(); return false; }
    targets = drag.list;
    build(targets, drag.ext, drag.count);
    state = 'open';
    // a frame later, so the pop-in animates from its starting size
    requestAnimationFrame(() => requestAnimationFrame(() => { if (state === 'open') document.body.className = 'open'; }));
    window.cw.open();
    return true;
  }

  function over(e) {
    clearTimeout(leaveTimer);
    if (state === 'armed' && !open(e)) return;
    if (state !== 'open') return;
    setHot(hitTest(e.clientX, e.clientY));
    if (hot >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    else e.dataTransfer.dropEffect = 'none';
  }
  document.addEventListener('dragenter', over);
  document.addEventListener('dragover', over);

  document.addEventListener('dragleave', () => {
    if (state !== 'open') return;
    clearTimeout(leaveTimer);
    // Moving between parts of the wheel fires this too; only a real exit stays quiet.
    leaveTimer = setTimeout(() => {
      if (state !== 'open') return;
      state = 'off';
      document.body.className = 'closing';
      window.cw.leave();
    }, 90);
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearTimeout(leaveTimer);
    if (state !== 'open') return;
    const i = hitTest(e.clientX, e.clientY);
    if (i < 0) return;
    const to = targets[i];
    state = 'done';
    setHot(i);
    document.body.className = 'open dropped';
    const files = [];
    for (const f of [...e.dataTransfer.files]) {
      const p = window.cw.pathFor(f);
      if (p) files.push({ path: p });
      else if (f.size < 300 * 1024 * 1024) files.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    }
    window.cw.drop(to, files);
  });
})();
