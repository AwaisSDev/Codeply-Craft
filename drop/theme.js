// Same light/dark choice as the main window (same origin, same localStorage key).
(() => {
  const apply = () => {
    let t = null;
    try { t = localStorage.getItem('craft-desktop-theme'); } catch {}
    if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  };
  apply();
  window.addEventListener('storage', (e) => { if (e.key === 'craft-desktop-theme') apply(); });
  window.applyDropTheme = apply;
})();
