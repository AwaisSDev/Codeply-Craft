// Responsive mode for Codeply's browser, like the device toolbar in Chrome's
// DevTools: the page sits in a device frame you drag to any size (left, right,
// bottom or the corner; double-click a handle to fill the panel), or pick a
// device, or type the width and height. Ctrl+Shift+M turns it on and off.
//
// main.js places the page (a native view) and tells this file where the frame
// is (browserpanel:frame). While a handle is dragged the live page steps aside
// and a still of it stands in, as for the panel's own edge (a native view would
// swallow the mouse); on release the page lays out at the new size.
// Loaded after app.js; uses its globals bc, reportBrowserLayout and showToast.
(() => {
  const api = window.craft;
  if (!api || !api.onBrowserPanelFrame) return;
  const $ = (id) => document.getElementById(id);
  const row = $('bcDevice');
  const stage = $('bcStage');
  const frameEl = $('bcFrame');
  const ghost = frameEl && frameEl.querySelector('.bc-frame-ghost');
  const pill = $('bcSizePill');
  const preset = $('bcDevicePreset');
  const inW = $('bcDevW');
  const inH = $('bcDevH');
  if (!row || !stage || !frameEl) return;

  const DEVICES = [
    ['responsive', 'Responsive'],
    ['375x667', 'iPhone SE'], ['393x852', 'iPhone 15 Pro'], ['430x932', 'iPhone 15 Pro Max'],
    ['412x915', 'Pixel 8'], ['360x780', 'Galaxy S24'],
    ['768x1024', 'iPad mini'], ['820x1180', 'iPad Air'], ['1024x1366', 'iPad Pro'],
    ['1280x800', 'Laptop'], ['1440x900', 'Laptop L'],
  ];
  preset.innerHTML = DEVICES.map(([v, l]) => `<option value="${v}">${l}${v === 'responsive' ? '' : ` · ${v.replace('x', ' × ')}`}</option>`).join('');

  let info = null; // { frame, panel, size, gutter, top } in window pixels
  let drag = null;
  const scale = () => window.innerWidth / (document.documentElement.getBoundingClientRect().width || window.innerWidth);
  const css = (r) => { const k = scale(); return { x: r.x / k, y: r.y / k, width: r.width / k, height: r.height / k }; };
  const isOn = () => !!(info && info.size && typeof bc !== 'undefined' && bc.visible);
  const limits = () => ({
    maxW: Math.max(200, info.panel.width - 2 * info.gutter),
    maxH: Math.max(200, info.panel.height - info.top - info.gutter),
  });

  let rowShown = false;
  function paint() {
    const on = isOn();
    if (on !== rowShown) {
      rowShown = on;
      row.classList.toggle('hidden', !on);
      requestAnimationFrame(() => { if (typeof reportBrowserLayout === 'function') reportBrowserLayout(); });
    }
    const btn = $('bcDeviceBtn');
    if (btn) btn.classList.toggle('active', on);
    stage.classList.toggle('hidden', !on);
    if (!on) return;
    const p = css(info.panel);
    const f = css(drag ? drag.frame : info.frame);
    Object.assign(stage.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.width}px`, height: `${p.height}px` });
    Object.assign(frameEl.style, { left: `${f.x - p.x}px`, top: `${f.y - p.y}px`, width: `${f.width}px`, height: `${f.height}px` });
    const shownW = Math.round(drag ? drag.w : info.frame.width);
    const shownH = Math.round(drag ? drag.h : info.frame.height);
    pill.textContent = `${shownW} × ${shownH}`;
    if (document.activeElement !== inW) inW.value = String(drag ? shownW : info.size.width);
    if (document.activeElement !== inH) inH.value = String(drag ? shownH : info.size.height);
    const key = `${info.size.width}x${info.size.height}`;
    preset.value = DEVICES.some(([v]) => v === key) ? key : 'responsive';
    const clipped = !drag && (info.frame.width < info.size.width - 1 || info.frame.height < info.size.height - 1);
    $('bcDevNote').textContent = clipped ? `Shown at ${Math.round(info.frame.width)} × ${Math.round(info.frame.height)}: widen the panel for the full size` : info.size.width < 1024 ? 'Phone user agent' : '';
  }

  api.onBrowserPanelFrame((d) => { info = d; paint(); });
  if (api.onBrowserPanelViewport) api.onBrowserPanelViewport(() => requestAnimationFrame(paint));
  window.addEventListener('resize', () => requestAnimationFrame(paint));
  // The panel opening, closing or moving (bc.visible) arrives with the panel's state.
  if (api.onBrowserPanelState) api.onBrowserPanelState(() => requestAnimationFrame(paint));

  function setSize(w, hgt) {
    if (!info) return;
    const { maxW, maxH } = limits();
    const W = Math.round(Math.max(200, Math.min(4000, Number(w) || 0)));
    const H = Math.round(Math.max(200, Math.min(4000, Number(hgt) || maxH)));
    if (!W) return;
    api.browserPanelViewSize({ width: W, height: H });
    if (W > maxW || H > maxH) showHint();
  }
  let hinted = false;
  function showHint() {
    if (hinted || typeof showToast !== 'function') return;
    hinted = true;
    showToast('Bigger than the panel: it shows the top-left part. Drag the panel wider to see all of it.');
  }

  function enter() {
    if (!info) { api.browserPanelViewport('mobile'); return; }
    if (info.size) return;
    const { maxW, maxH } = limits();
    setSize(Math.min(390, maxW), maxH);
  }
  function leave() { api.browserPanelViewport('desktop'); }
  function toggle() { if (isOn()) leave(); else enter(); }
  window.CraftResponsive = { enter, leave, toggle };

  const devBtn = $('bcDeviceBtn');
  if (devBtn) devBtn.addEventListener('click', toggle);
  $('bcDevClose').addEventListener('click', leave);
  $('bcDevRotate').addEventListener('click', () => { if (info && info.size) setSize(info.size.height, info.size.width); });
  preset.addEventListener('change', () => {
    if (preset.value === 'responsive') return;
    const [w, hgt] = preset.value.split('x').map(Number);
    setSize(w, hgt);
  });
  for (const inp of [inW, inH]) {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      else if (e.key === 'Escape') { inp.value = ''; inp.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        inp.value = String(Math.max(200, (Number(inp.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)));
      }
    });
    inp.addEventListener('change', () => { if (info && info.size) setSize(inW.value || info.size.width, inH.value || info.size.height); });
    inp.addEventListener('blur', () => paint());
  }
  document.addEventListener('keydown', (e) => {
    if (typeof bc === 'undefined' || !bc.visible) return;
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); toggle(); }
  });

  // ── Dragging the frame's handles ──
  frameEl.addEventListener('dblclick', (e) => {
    const hnd = e.target.closest('[data-edge]');
    if (!hnd || !info) return;
    const { maxW, maxH } = limits();
    const edge = hnd.dataset.edge;
    setSize(edge.includes('r') || edge.includes('l') ? maxW : info.size.width, edge.includes('b') ? maxH : info.size.height);
  });
  frameEl.addEventListener('pointerdown', async (e) => {
    const hnd = e.target.closest('[data-edge]');
    if (!hnd || e.button !== 0 || !info || !info.size || drag) return;
    e.preventDefault();
    hnd.setPointerCapture(e.pointerId);
    const k = scale();
    drag = {
      edge: hnd.dataset.edge, x0: e.clientX, y0: e.clientY, k,
      w0: info.frame.width, h0: info.frame.height, w: info.frame.width, h: info.frame.height,
      frame: { ...info.frame }, raf: 0, ready: null, hnd,
    };
    document.body.classList.add('bc-sizing', `bc-sizing-${drag.edge}`);
    if (typeof bc !== 'undefined') bc.frozen = true;
    // The live page steps aside; a still of it stands in while the frame moves.
    drag.ready = api.browserPanelDrag(true).then((r) => {
      if (ghost) { ghost.style.backgroundImage = r && r.image ? `url("${r.image}")` : 'none'; ghost.style.backgroundSize = `${drag ? drag.w0 / k : 0}px auto`; }
      frameEl.classList.add('dragging');
    }).catch(() => {});
    paint();
  });
  frameEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { maxW, maxH } = limits();
    const dx = (e.clientX - drag.x0) * drag.k;
    const dy = (e.clientY - drag.y0) * drag.k;
    const ed = drag.edge;
    // Centered like Chrome's: a side handle grows the frame on both sides.
    let w = drag.w0 + (ed.includes('r') ? 2 * dx : ed.includes('l') ? -2 * dx : 0);
    let hgt = drag.h0 + (ed.includes('b') ? dy : 0);
    w = Math.round(Math.max(200, Math.min(maxW, w)));
    hgt = Math.round(Math.max(200, Math.min(maxH, hgt)));
    drag.w = w; drag.h = hgt;
    drag.frame = { x: info.panel.x + Math.floor((info.panel.width - w) / 2), y: info.frame.y, width: w, height: hgt };
    if (drag.raf) return;
    drag.raf = requestAnimationFrame(() => { if (drag) { drag.raf = 0; paint(); } });
  });
  const end = async () => {
    if (!drag) return;
    const d = drag;
    await d.ready;
    drag = null;
    document.body.classList.remove('bc-sizing', `bc-sizing-${d.edge}`);
    const moved = Math.abs(d.w - d.w0) > 0 || Math.abs(d.h - d.h0) > 0;
    if (moved) api.browserPanelViewSize({ width: d.w, height: d.h });
    await api.browserPanelDrag(false);
    frameEl.classList.remove('dragging');
    if (ghost) ghost.style.backgroundImage = 'none';
    if (typeof bc !== 'undefined') bc.frozen = false;
    paint();
  };
  frameEl.addEventListener('pointerup', end);
  frameEl.addEventListener('pointercancel', end);
})();
