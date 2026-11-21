/**
 * Codeply UI icons: the interface set (toolbars, sidebar, composer, menus).
 *
 * Rules, from the published guides of Meta (Horizon OS icons), OpenAI (ChatGPT UI guidelines)
 * and xAI (Grok Bot): interface icons are monochrome and outlined; colour and character
 * belong to illustrations and the bots, not to chrome.
 *
 *   grid       24 x 24, content inside the 20 x 20 live area (2 units of padding)
 *   keylines   circle r 9, square 18, portrait 16 x 20, landscape 20 x 16
 *   stroke     1.75, round caps and joins, one weight for every icon (never thinner)
 *   angles     45 degree steps only
 *   colour     currentColor, so icons follow the text colour and the theme
 *   one style  outlined everywhere; no filled twins mixed in
 *
 *   CodeplyUI.svg(name, { size })   -> SVG markup
 *   CodeplyUI.names                 -> the icon names
 */
(function (root) {
  'use strict';

  const ICONS = {
    // New chat: a square with a pencil leaving it.
    compose: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z"/>',
    inbox: '<path d="M4 13.5 6.4 6.3A2 2 0 0 1 8.3 5h7.4a2 2 0 0 1 1.9 1.3L20 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/>',
    routine: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    settings: '<path d="M12 3.5 13.6 5l2.2-.3.9 2 2 .9-.3 2.2L20 12l-1.5 1.6.3 2.2-2 .9-.9 2-2.2-.3L12 20.5 10.4 19l-2.2.3-.9-2-2-.9.3-2.2L4 12l1.5-1.6-.3-2.2 2-.9.9-2 2.2.3z"/><circle cx="12" cy="12" r="3"/>',
    folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    attach: '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7-7l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6 8.5-6"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    branch: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10a6 6 0 0 1-6 6H8"/>',
    cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 10z"/>',
    laptop: '<rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 19h19"/>',
    spark: '<path d="M12 3.5 13.8 10.2 20.5 12l-6.7 1.8L12 20.5l-1.8-6.7L3.5 12l6.7-1.8z"/>',
    more: '<circle cx="5.5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18.5" cy="12" r="1"/>',
  };

  function svg(name, o = {}) {
    const body = ICONS[name];
    if (!body) throw new Error(`No Codeply UI icon called "${name}".`);
    const size = o.size || 18;
    const sw = o.stroke || 1.75;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  const api = { svg, names: Object.keys(ICONS) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CodeplyUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
