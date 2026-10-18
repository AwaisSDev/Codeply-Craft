// The converter's toast: "Converting...", then "Saved name.jpg" with Show in
// folder. It goes away by itself a few seconds after it's done, unless the
// mouse is on it.
(() => {
  const $ = (id) => document.getElementById(id);
  const box = $('toast');
  const ICONS = {
    working: '<div class="spin"></div>',
    done: '<svg class="ok" viewBox="0 0 22 22"><circle cx="11" cy="11" r="11"/><path d="M6.5 11.3l3 3 6-6.3"/></svg>',
    error: '<svg class="bad" viewBox="0 0 22 22"><circle cx="11" cy="11" r="11"/><path d="M11 6.5v5.5M11 15.3v.2"/></svg>',
  };
  let reveal = '';
  let timer = null;
  let hovering = false;
  let state = '';

  function hide() {
    clearTimeout(timer);
    box.classList.remove('show');
    setTimeout(() => { if (!box.classList.contains('show')) window.cw.toastDone(); }, 200);
  }
  function later() {
    clearTimeout(timer);
    if (state !== 'working' && !hovering) timer = setTimeout(hide, state === 'error' ? 8000 : 6000);
  }

  window.cw.onToast((d) => {
    if (window.applyDropTheme) window.applyDropTheme();
    state = d.state;
    $('icon').innerHTML = ICONS[d.state] || '';
    $('title').textContent = d.title || '';
    $('detail').textContent = d.detail || '';
    $('title').title = d.title || '';
    $('detail').title = d.detail || '';
    reveal = d.reveal || '';
    $('reveal').hidden = !reveal;
    requestAnimationFrame(() => box.classList.add('show'));
    later();
  });

  $('reveal').addEventListener('click', () => { if (reveal) window.cw.reveal(reveal); hide(); });
  $('close').addEventListener('click', hide);
  box.addEventListener('mouseenter', () => { hovering = true; clearTimeout(timer); });
  box.addEventListener('mouseleave', () => { hovering = false; later(); });
})();
