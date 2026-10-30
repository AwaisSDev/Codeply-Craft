// Codeply's icon set: one outline family drawn for this app on a 24 grid,
// 2-unit stroke with round caps and joins, about 2 units of air on every side,
// 3-unit corners on boxes, no fills but the odd dot. Every main window icon
// comes from here: icon(name, cls) returns the <svg> markup for JS strings,
// window.CraftIcons[name] the same with no extra class, and <i data-icon="name">
// in index.html is swapped for the real <svg> as soon as this script runs
// (it loads before app.js, so app.js only ever sees finished icons).
// styles.css (.ico) sets the size, stroke and colour; ico-xs/sm/md/lg resize.
(() => {
  // Shared shapes: the same box, circle and triangle reused across icons.
  const RING = '<circle cx="12" cy="12" r="8.5"/>';
  const FILE = '<path d="M13.5 3.5H8a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V9Z"/><path d="M13.5 3.5V7a2 2 0 0 0 2 2H19"/>';
  const SHIELD = '<path d="M12 3.25l6.4 2.45a1 1 0 0 1 .6.93V11c0 4.5-2.95 8.3-7 9.75C7.95 19.3 5 15.5 5 11V6.63a1 1 0 0 1 .6-.93Z"/>';
  const TRIANGLE = '<path d="M10.27 5a2 2 0 0 1 3.46 0l6.93 12a2 2 0 0 1-1.73 3H5.07a2 2 0 0 1-1.73-3Z"/>';
  const WINDOW = '<rect x="3" y="4.5" width="18" height="15" rx="3"/>';
  const DOTS = (y) => `<g fill="currentColor" stroke="none"><circle cx="5.5" cy="${y}" r="1.5"/><circle cx="12" cy="${y}" r="1.5"/><circle cx="18.5" cy="${y}" r="1.5"/></g>`;

  const PATHS = {
    // Basics
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    more: DOTS(12),
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    circle: '<circle cx="12" cy="12" r="7"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-up': '<path d="M6 15l6-6 6 6"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    'arrow-up': '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
    'arrow-down': '<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5"/>',
    'arrow-left': '<path d="M19 12H5M11.5 5.5 5 12l6.5 6.5"/>',
    'arrow-right': '<path d="M5 12h14M12.5 5.5 19 12l-6.5 6.5"/>',
    'arrow-up-right': '<path d="M7 17 17 7M8.5 7H17v8.5"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',

    // Writing and files
    'new-chat': '<path d="M11 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4"/><path d="M17.8 4.2a1.9 1.9 0 0 1 2.7 2.7l-7.6 7.6-3.4.9.9-3.4Z"/>',
    edit: '<path d="M4 20l1-4.5L16 4.5a2.47 2.47 0 0 1 3.5 3.5L8.5 19Z"/><path d="M14 6.5l3.5 3.5"/>',
    copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="3"/><path d="M15.5 8.5V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v5.5a3 3 0 0 0 3 3h1.5"/>',
    trash: '<path d="M4 6.5h16M9.5 6.5V5A1.5 1.5 0 0 1 11 3.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="M6 6.5l.8 11.7a2.5 2.5 0 0 0 2.5 2.3h5.4a2.5 2.5 0 0 0 2.5-2.3L18 6.5"/><path d="M10 10.5v6M14 10.5v6"/>',
    file: FILE,
    'file-text': FILE + '<path d="M9 13h6M9 16.5h4"/>',
    'file-pdf': FILE + '<text x="12" y="17.4" text-anchor="middle" font-size="5.4" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor" stroke="none">PDF</text>',
    folder: '<path d="M3 8a3 3 0 0 1 3-3h2.7a2 2 0 0 1 1.6.8l1.2 1.4a2 2 0 0 0 1.6.8H18a3 3 0 0 1 3 3V16a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z"/>',
    'folder-open': '<path d="M3 16V8a3 3 0 0 1 3-3h2.7a2 2 0 0 1 1.6.8l1.2 1.4a2 2 0 0 0 1.6.8H16a2 2 0 0 1 2 2"/><path d="M3 16l2.3-4.7A2.4 2.4 0 0 1 7.5 10H20a1 1 0 0 1 .9 1.4l-2.3 5.8A2.8 2.8 0 0 1 16 19H6a3 3 0 0 1-3-3Z"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="9.5" r="1.5"/><path d="M20.5 15l-3.94-3.94a1.5 1.5 0 0 0-2.12 0L6 19.5"/>',
    paperclip: '<path d="M18.85 12.31l-6.01 6.01a4.5 4.5 0 0 1-6.36-6.36l6.72-6.72a3 3 0 0 1 4.24 4.24l-6.36 6.36a1.5 1.5 0 0 1-2.12-2.12l5.3-5.3"/>',
    book: '<path d="M5 18.75V6a3 3 0 0 1 3-3h11v13.5H7.25a2.25 2.25 0 0 0 0 4.5H19"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',

    // Places and things
    search: '<circle cx="10.75" cy="10.75" r="6.75"/><path d="M15.75 15.75 20 20"/>',
    home: '<path d="M4 10.2 12 3.8l8 6.4V18a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18Z"/><path d="M9.5 20.5v-5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v5"/>',
    sidebar: WINDOW + '<path d="M9.5 4.5v15"/>',
    'panel-right': WINDOW + '<path d="M14.5 4.5v15"/>',
    terminal: WINDOW + '<path d="M7.5 9.5 10.5 12l-3 2.5M13 14.5h3.5"/>',
    prompt: '<path d="M5 7.5 9.5 12 5 16.5M12 17h7"/>',
    code: '<path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5"/>',
    laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="2.5"/><path d="M2.5 19h19"/>',
    monitor: '<rect x="3" y="4" width="18" height="12.5" rx="3"/><path d="M12 16.5V20M8.5 20h7"/>',
    phone: '<rect x="6.5" y="3" width="11" height="18" rx="3"/><path d="M11 17.5h2"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
    database: '<ellipse cx="12" cy="6" rx="7.5" ry="2.75"/><path d="M4.5 6v12c0 1.5 3.4 2.75 7.5 2.75s7.5-1.25 7.5-2.75V6"/><path d="M4.5 12c0 1.5 3.4 2.75 7.5 2.75s7.5-1.25 7.5-2.75"/>',
    cloud: '<path d="M7 18.5h10.25a3.5 3.5 0 0 0 .15-7A5.25 5.25 0 1 0 7.02 11 3.75 3.75 0 1 0 7 18.5Z"/>',
    globe: RING + '<path d="M3.5 12h17M12 3.5c2.25 2.3 3.5 5.25 3.5 8.5s-1.25 6.2-3.5 8.5c-2.25-2.3-3.5-5.25-3.5-8.5S9.75 5.8 12 3.5Z"/>',
    link: '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1 1"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1-1"/>',
    external: '<path d="M13.5 4.5h6v6M19.5 4.5 11 13"/><path d="M18 14v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h3"/>',
    expand: '<path d="M14.5 4H20v5.5M20 4l-6 6M9.5 20H4v-5.5M4 20l6-6"/>',
    pick: '<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M4 15.5V18a2 2 0 0 0 2 2h2.5"/><path d="M12.5 12.5l8 3.2-3.3 1.4-1.4 3.3Z"/>',
    branch: '<circle cx="7" cy="5.5" r="2.25"/><circle cx="7" cy="18.5" r="2.25"/><circle cx="17" cy="5.5" r="2.25"/><path d="M7 7.75v8.5M17 7.75v.75a4 4 0 0 1-4 4h-2a4 4 0 0 0-4 4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3.5 7.5l7.4 5.1a2 2 0 0 0 2.2 0l7.4-5.1"/>',
    hash: '<path d="M9.5 4 8 20M16 4l-1.5 16M4.5 9h15M4 15h15"/>',
    triangle: TRIANGLE,
    briefcase: '<rect x="3.5" y="7" width="17" height="13" rx="3"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17"/>',
    lock: '<rect x="5" y="10" width="14" height="10.5" rx="3"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/>',

    // People and talk
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    users: '<circle cx="9.5" cy="8" r="3.75"/><path d="M3 20a6.5 6.5 0 0 1 13 0M15.5 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2A6.5 6.5 0 0 1 21 20"/>',
    chat: '<path d="M20 11.5a8 8 0 0 1-11.8 7L4 19.5l1-4A8 8 0 1 1 20 11.5Z"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    bell: '<path d="M5.5 16.5h13l-1.2-1.8a2 2 0 0 1-.3-1.1V9.5a5 5 0 0 0-10 0v4.1a2 2 0 0 1-.3 1.1Z"/><path d="M10 20h4"/>',
    logout: '<path d="M9.5 20H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h2.5M15.5 16.5 20 12l-4.5-4.5M20 12H10"/>',

    // Work and modes
    hammer: '<path d="M4.93 10.87l5.3-5.3c2.12-2.13 4.95-2.83 7.43-1.77-1.63.49-3.4 1.55-5.52 3.67l1.98 1.98-5.3 5.31a1.5 1.5 0 0 1-2.12 0l-1.77-1.77a1.5 1.5 0 0 1 0-2.12Z"/><path d="M11.65 11.93l8.48 8.48"/>',
    flask: '<path d="M9 3.5h6M10 3.5V9l-4.6 8.1A2.25 2.25 0 0 0 7.36 20.5h9.28a2.25 2.25 0 0 0 1.96-3.4L14 9V3.5M6.9 14.5h10.2"/>',
    sparkle: '<path d="M12 4c.5 4.5 3.5 7.5 8 8-4.5.5-7.5 3.5-8 8-.5-4.5-3.5-7.5-8-8 4.5-.5 7.5-3.5 8-8Z"/>',
    tasks: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 12.25 11 14.75l4.5-5"/>',
    list: '<path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20"/><g fill="currentColor" stroke="none"><circle cx="4.75" cy="6.5" r="1.25"/><circle cx="4.75" cy="12" r="1.25"/><circle cx="4.75" cy="17.5" r="1.25"/></g>',
    target: RING + '<circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    bulb: '<path d="M12 3a6 6 0 0 0-3.6 10.8c.4.3.6.8.6 1.3v.4h6v-.4c0-.5.2-1 .6-1.3A6 6 0 0 0 12 3Z"/><path d="M9.5 18h5M10.5 20.5h3"/>',
    gauge: '<path d="M4.6 18.2a8.5 8.5 0 1 1 14.8 0M12 14l3.5-3.5"/><circle cx="12" cy="14" r="1.25" fill="currentColor" stroke="none"/>',
    settings: '<path d="M10.19 5.24l.09-2.07a9 9 0 0 1 3.44 0l.09 2.07a7 7 0 0 1 1.69.7l1.53-1.4a9 9 0 0 1 2.43 2.43l-1.4 1.53a7 7 0 0 1 .7 1.69l2.07.09a9 9 0 0 1 0 3.44l-2.07.09a7 7 0 0 1-.7 1.69l1.4 1.53a9 9 0 0 1-2.43 2.43l-1.53-1.4a7 7 0 0 1-1.69.7l-.09 2.07a9 9 0 0 1-3.44 0l-.09-2.07a7 7 0 0 1-1.69-.7l-1.53 1.4a9 9 0 0 1-2.43-2.43l1.4-1.53a7 7 0 0 1-.7-1.69l-2.07-.09a9 9 0 0 1 0-3.44l2.07-.09a7 7 0 0 1 .7-1.69l-1.4-1.53a9 9 0 0 1 2.43-2.43l1.53 1.4a7 7 0 0 1 1.69-.7Z"/><circle cx="12" cy="12" r="3"/>',

    // Safety and status
    shield: SHIELD,
    'shield-check': SHIELD + '<path d="M9 12l2 2 4-4"/>',
    'shield-alert': SHIELD + '<path d="M12 8v4.25M12 15.5h.01"/>',
    warning: TRIANGLE + '<path d="M12 10v3.5M12 16.5h.01"/>',
    alert: RING + '<path d="M12 8v4.5M12 15.75h.01"/>',
    help: RING + '<path d="M9.75 9.5a2.25 2.25 0 1 1 3.2 2.05c-.55.25-.95.75-.95 1.35v.35M12 16.25h.01"/>',

    // Time and motion
    clock: RING + '<path d="M12 7.5V12l3 2"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.5M4 4v4.5h4.5"/><path d="M12 8v4l2.75 2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5M20 4v4.5h-4.5"/>',
    undo: '<path d="M9 14 4.5 9.5 9 5M4.5 9.5h10a5 5 0 0 1 0 10H12"/>',
    redo: '<path d="M15 14l4.5-4.5L15 5M19.5 9.5h-10a5 5 0 0 0 0 10H12"/>',
    sun: '<circle cx="12" cy="12" r="3.75"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.64 5.64l1.06 1.06M17.3 17.3l1.06 1.06M5.64 18.36l1.06-1.06M17.3 6.7l1.06-1.06"/>',
    moon: '<path d="M20 14.5A8.2 8.2 0 1 1 9.5 4a7.6 7.6 0 0 0 10.5 10.5Z"/>',
  };

  /** The <svg> markup for one icon. cls adds classes (a size like "ico-sm", or a hook); attrs is raw extra attributes. */
  function icon(name, cls, attrs) {
    const label = attrs && /aria-label=/.test(attrs);
    return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24"${label ? '' : ' aria-hidden="true"'}${attrs ? ' ' + attrs : ''}>${PATHS[name] || ''}</svg>`;
  }

  /** Swaps every <i data-icon="name"> under root for its <svg>, keeping the placeholder's classes and attributes. */
  function fill(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.tagName.toLowerCase() === 'svg') return;
      const tpl = document.createElement('template');
      tpl.innerHTML = icon(el.dataset.icon, el.getAttribute('class') || '');
      const svg = tpl.content.firstChild;
      for (const a of el.attributes) {
        if (a.name === 'class' || a.name === 'data-icon') continue;
        svg.setAttribute(a.name, a.value);
      }
      if (el.hasAttribute('aria-label')) svg.removeAttribute('aria-hidden');
      el.replaceWith(svg);
    });
  }

  const CraftIcons = {};
  for (const name of Object.keys(PATHS)) CraftIcons[name] = icon(name);
  window.CraftIcons = Object.freeze(CraftIcons);
  window.icon = icon;
  window.fillIcons = fill;
  fill(document);
})();
