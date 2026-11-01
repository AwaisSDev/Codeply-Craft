// Codeply phone: the app around the conversation (phone.js).
//
//   Tabs   Home (what needs you, what is running, recent work), Chats
//          (search, filter, grouped by state), Calls (phone-calls.js), You
//          (account, usage, your PC, permissions, settings).
//   Chat   a conversation opens over the tabs, with Back.
//   Panels Usage, Permissions.
//   Auth   sign in or create an account, then onboarding.
//
// Native and quiet: grouped lists, large titles with the date above, one
// accent, monochrome icons. Every screen is drawn from plain data, so real
// data (CraftPhone) and the preview (?preview=<screen>) share the code.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const P = () => window.CraftPhone || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const W = () => window.CraftWisp;
  const svg = (d, w = 18) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    check: '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    code: svg('<path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4"/>'),
    chat: svg('<path d="M5 18.5V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8.5L5 18.5Z"/>'),
    cloud: svg('<path d="M7 18a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 9.5a4 4 0 0 1 0 8.5Z"/>'),
    design: svg('<path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10Z"/><path d="M13.5 7.5l3 3"/>'),
    pc: svg('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>'),
    shield: svg('<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6Z"/>'),
    spark: svg('<path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>'),
    bell: svg('<path d="M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
    chart: svg('<path d="M5 19V11M12 19V5M19 19v-6"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 20),
    up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>', 18),
    x: svg('<path d="M7 7l10 10M17 7 7 17"/>', 14),
    warn: svg('<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4.5M12 17.5v.2"/>', 14),
    phone: svg('<path d="M5.5 4h3.2l1.8 4.5-2.2 1.4a11 11 0 0 0 5.8 5.8l1.4-2.2 4.5 1.8v3.2a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 4 5.6 1.5 1.5 0 0 1 5.5 4Z"/>'),
  };
  const MARK = '<svg class="signin-brand" viewBox="560 540 3200 3200" aria-hidden="true"><path transform="translate(446.2 415.6)" fill-rule="evenodd" d="M 1678.618 161.001 C 1513.270 173.860, 1361.809 346.904, 1279.057 617.500 C 1274.011 634, 1267.620 654.925, 1264.855 664 C 1249.516 714.339, 1229.366 737.485, 1195.500 743.667 C 1176.163 747.196, 1162.631 743.554, 1110.552 720.802 C 1022.739 682.440, 971.671 664, 888.500 640.621 C 862.965 633.443, 796.420 619.707, 772 616.573 C 713.658 609.085, 593.780 610.737, 551.641 619.609 C 332.720 665.703, 243.351 832.965, 314.976 1062.546 C 353.997 1187.622, 433.071 1316.880, 553.531 1452.500 C 623.139 1530.869, 661.709 1532.912, 733.080 1462.011 C 772.514 1422.836, 780.747 1391.220, 761.479 1352.958 C 754.288 1338.678, 740.993 1320.496, 698.991 1267.500 C 608.528 1153.357, 538.933 1033.300, 526.096 969.244 C 508.440 881.134, 552.031 833.575, 650.500 833.517 C 684.922 833.497, 695.220 834.936, 769.390 850.128 C 888.325 874.489, 1086.233 953.898, 1267.500 1049.990 C 1344.206 1090.653, 1372.719 1106.795, 1461.500 1159.816 C 1608.121 1247.380, 1755.866 1358.262, 1861.500 1460.014 C 1921.219 1517.539, 1951.774 1524.352, 1997.213 1490.277 C 2057.039 1445.413, 2074.206 1391.642, 2043.179 1346.309 C 2033.397 1332.016, 2001.765 1301.543, 1934.541 1241.650 C 1874.053 1187.757, 1792.899 1122.849, 1720.500 1070.456 C 1642.140 1013.750, 1607.593 990.197, 1545.770 951.333 C 1444.460 887.645, 1440.775 876.828, 1477.514 751 C 1554.913 485.915, 1639.597 355.942, 1721.242 376.924 C 1792.586 395.260, 1843.427 482.519, 1903.944 690.500 C 1922.645 754.772, 1931.223 772.623, 1951.366 789.193 C 1979.980 812.729, 2004.596 813.361, 2073.962 792.338 C 2129.084 775.633, 2151.559 737.105, 2138.619 681.500 C 2096.957 502.479, 2034.714 369.918, 1948.588 276.785 C 1867.542 189.146, 1782.992 152.884, 1678.618 161.001 M 2651 826.525 C 2636.425 827.220, 2610.775 828.309, 2594 828.947 C 2547.771 830.703, 2538.279 831.726, 2500.500 839.021 C 2486.750 841.676, 2465.600 845.252, 2453.500 846.968 C 2317.824 866.210, 2285.604 904.119, 2316.087 1008.641 C 2337.385 1081.667, 2374.061 1095.532, 2487.753 1073.537 C 2517.351 1067.811, 2526.614 1066.506, 2555.451 1064.003 C 2580.486 1061.831, 2593.838 1060.071, 2623 1055.100 C 2674.441 1046.332, 2761.094 1044.363, 2803.500 1050.999 C 2919.711 1069.183, 2946.817 1114.190, 2903.478 1217 C 2845.944 1353.482, 2724.242 1482.607, 2533 1610.074 C 2379.093 1712.656, 2141.479 1829.058, 1924.625 1908.104 C 1912.456 1912.540, 1890.432 1920.651, 1875.682 1926.128 C 1850.956 1935.310, 1816.781 1947.333, 1750.760 1970.078 C 1695.022 1989.279, 1679.399 1999.437, 1665.959 2025.213 C 1653.383 2049.332, 1654.682 2087.531, 1669.522 2129.971 C 1691.542 2192.948, 1730.404 2209.667, 1804.386 2187.990 C 1976.971 2137.422, 2183.921 2052.417, 2353.500 1962.440 C 2455.001 1908.585, 2473.561 1910.724, 2546.003 1984.625 C 2709.559 2151.475, 2793.184 2302.385, 2762.458 2375.239 C 2737.105 2435.354, 2659.411 2458.576, 2547.500 2439.488 C 2533.200 2437.049, 2512.157 2433.680, 2500.739 2432.002 C 2470.016 2427.486, 2429.336 2418.321, 2378.085 2404.369 C 2283.654 2378.663, 2250.338 2399.382, 2224.311 2500 C 2211.121 2550.990, 2228.931 2586.687, 2278.053 2607.714 C 2311.029 2621.830, 2394.875 2642.821, 2446.688 2649.932 C 2455.042 2651.079, 2473.042 2654.046, 2486.688 2656.526 C 2531.128 2664.603, 2529.166 2664.462, 2597 2664.482 C 2666.633 2664.503, 2661.731 2664.930, 2712.968 2654.375 C 2793.081 2637.871, 2839.358 2618.554, 2885 2582.566 C 2975.643 2511.096, 3006.471 2421.809, 2989.432 2280.095 C 2981.902 2217.467, 2941.621 2124.094, 2886.934 2042.500 C 2844.667 1979.438, 2814.783 1942.700, 2753.527 1878.500 C 2711.108 1834.043, 2701.792 1818.416, 2701.664 1791.500 C 2701.509 1759.031, 2716.582 1739.248, 2771 1700.491 C 2877.964 1624.312, 2979.014 1528.767, 3039.190 1446.911 C 3127.138 1327.276, 3159.569 1234.123, 3154.045 1117 C 3148.683 1003.324, 3072.370 911.830, 2942.369 863.217 C 2915.206 853.060, 2857.026 837.930, 2824.500 832.566 C 2791.651 827.148, 2702.834 824.056, 2651 826.525 M 1221 1480.554 C 1185.814 1488.106, 1164.806 1513.094, 1153.370 1561 C 1151.466 1568.975, 1147.468 1585.625, 1144.487 1598 C 1141.505 1610.375, 1137.227 1630.850, 1134.980 1643.500 C 1132.732 1656.150, 1128.698 1676.850, 1126.013 1689.500 C 1123.329 1702.150, 1119.707 1721.950, 1117.965 1733.500 C 1114.579 1755.950, 1113.091 1764.073, 1107.617 1790 C 1103.206 1810.891, 1101.591 1822.086, 1099.032 1849.500 C 1096.638 1875.144, 1094.993 1887.946, 1091 1912 C 1084.635 1950.349, 1083.594 1961.542, 1081.521 2014 C 1079.670 2060.833, 1078.662 2076.859, 1075.451 2110.500 C 1073.097 2135.166, 1072.499 2143.857, 1069.981 2190 C 1065.137 2278.770, 1046.459 2294.011, 902.500 2326.667 C 853.941 2337.682, 844.423 2339.535, 818.775 2342.971 C 805.974 2344.686, 786.275 2347.628, 775 2349.510 C 670.265 2366.986, 578.382 2357.052, 530.217 2323.044 C 447.360 2264.540, 489.788 2150.492, 658.069 1979.376 C 701.290 1935.427, 713.158 1921.198, 720.567 1904.445 C 737.226 1866.775, 725.209 1831.984, 679.971 1786.916 C 643.652 1750.733, 611.184 1740.532, 576.802 1754.502 C 536.975 1770.685, 432.342 1880.046, 374.269 1966.185 C 291.116 2089.526, 261.131 2183.962, 268.924 2297.971 C 278.346 2435.833, 391.245 2541.176, 563 2572.366 C 627.602 2584.098, 785.970 2581.139, 852.500 2566.957 C 865.150 2564.261, 884.050 2560.457, 894.500 2558.504 C 904.950 2556.552, 927 2551.636, 943.500 2547.581 C 984.354 2537.540, 984.644 2537.493, 1005.500 2537.543 C 1045.793 2537.641, 1071.124 2557.231, 1081.535 2596.347 C 1085.400 2610.867, 1095.186 2680.902, 1098.534 2718 C 1100.530 2740.113, 1102.307 2752.129, 1106.001 2768.500 C 1107.614 2775.650, 1110.055 2786.450, 1111.425 2792.500 C 1112.796 2798.550, 1115.526 2812.275, 1117.492 2823 C 1135.496 2921.202, 1182.799 3041.222, 1234.744 3120.500 C 1322.370 3254.236, 1425.576 3311.227, 1556.500 3298.177 C 1716.141 3282.265, 1881.913 3095.902, 1981.844 2820 C 2021.370 2710.873, 2024.915 2690.720, 2009.872 2660.701 C 1995.846 2632.714, 1981.433 2623.761, 1914.032 2601.170 C 1837.474 2575.509, 1827.569 2579.467, 1803.046 2645.514 C 1695.736 2934.533, 1604.354 3080.592, 1534.615 3074.557 C 1458.122 3067.937, 1353.237 2893.564, 1315.637 2710.500 C 1313.152 2698.400, 1309.321 2680.400, 1307.124 2670.500 C 1301.618 2645.694, 1300.423 2638.161, 1297.523 2610 C 1294.774 2583.293, 1294.324 2579.619, 1289.992 2548.500 C 1277.686 2460.097, 1277.946 2268.554, 1290.509 2168 C 1294.349 2137.262, 1295.857 2120.182, 1297.501 2088.762 C 1299.997 2041.094, 1300.894 2033.182, 1308.473 1992 C 1312.545 1969.874, 1314.372 1955.875, 1316.500 1930.500 C 1318.625 1905.160, 1320.210 1894.149, 1326.002 1864.500 C 1328.688 1850.750, 1332.488 1827.980, 1334.447 1813.899 C 1336.406 1799.819, 1340.451 1776.194, 1343.436 1761.399 C 1346.420 1746.605, 1350.031 1726.625, 1351.459 1717 C 1355.384 1690.557, 1355.798 1688.343, 1361.654 1662.583 C 1384.615 1561.577, 1376.855 1524.810, 1327.368 1500.125 C 1296.022 1484.489, 1245.756 1475.241, 1221 1480.554"/></svg>';

  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'now'; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${Math.round(s / 3600)}h`;
    if (s < 7 * 86400) return new Date(t).toLocaleDateString([], { weekday: 'short' });
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const clock = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
  const short = (n) => { n = Number(n) || 0; const f = (x) => (x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')); return n >= 1e9 ? f(n / 1e9) + 'B' : n >= 1e6 ? f(n / 1e6) + 'M' : n >= 1e3 ? f(n / 1e3) + 'K' : String(Math.round(n)); };
  const today = () => new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const head = (title, { date = false, right = '' } = {}) => `<header class="tv-head"><div class="tv-titles">${date ? `<small>${esc(today())}</small>` : ''}<h1>${esc(title)}</h1></div>${right}</header>`;
  const sec = (title, end = '') => `<div class="sec"><h2>${esc(title)}</h2>${end}</div>`;
  const KIND_ICO = { code: I.code, chat: I.chat, cloud: I.cloud, design: I.design };

  // ─── Views ────────────────────────────────────────────────────────────────
  let view = 'home';
  function setView(v) {
    view = v;
    document.body.dataset.view = v;
    document.querySelectorAll('#tabbar [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === v));
  }

  // ─── Home ─────────────────────────────────────────────────────────────────
  /**
   * data: { initials, pc: { name, online }, cloud, approvals: [{ id, kind, where, cmd, isCmd, danger, always, at }],
   *         running: [{ id, title, step, since }], recent: [{ id, title, kind, sub, at, unread }] }
   */
  function renderHome(data) {
    const v = $('homeView');
    if (!v) return;
    const aps = data.approvals || [];
    const run = data.running || [];
    const rec = data.recent || [];
    let h = head('Home', { date: true, right: `<button type="button" class="nav-add" data-q="new" aria-label="New chat">${I.plus}</button><button type="button" class="nav-me" data-q="you" aria-label="You">${esc(data.initials || 'C')}</button>` });
    h += `<button type="button" class="ask-field" data-q="new"><span>Ask Codeply anything</span><i>${I.up}</i></button>`;
    h += `<div class="home-status"><span class="status${data.pc && data.pc.online ? ' on' : ''}"><i></i>${esc((data.pc && data.pc.name) || 'Your PC')} ${data.pc && data.pc.online ? 'online' : 'offline'}</span>${data.cloud ? '<span class="status on"><i></i>Cloud ready</span>' : ''}</div>`;
    if (aps.length) {
      h += sec('Needs you', `<span>${aps.length}</span>`);
      h += aps.map((a) => `<div class="ap" data-ap="${esc(a.id)}">
        <div class="ap-head"><b>${esc(a.kind)}</b><time>${esc(ago(a.at))}</time></div>
        <span class="ap-where">${esc(a.where)}</span>
        ${a.cmd ? `<pre class="ap-cmd">${a.isCmd ? '<span>$ </span>' : ''}${esc(a.cmd)}</pre>` : ''}
        ${a.danger ? `<div class="ap-risk">${I.warn}Outside the project or hard to undo</div>` : ''}
        <div class="ap-btns"><button type="button" class="btn btn-quiet" data-v="reject">Deny</button><button type="button" class="btn btn-blue" data-v="once">Allow</button></div>
        ${a.always ? `<button type="button" class="ap-always" data-v="always">${esc(a.always)}</button>` : ''}
      </div>`).join('');
    }
    if (run.length) {
      h += sec('Running', `<span>${run.length}</span>`);
      h += `<div class="list">${run.map((r) => `<button type="button" class="li" data-open="${esc(r.id)}"><span class="li-ico"><span class="spinner"></span></span><span class="li-main"><b>${esc(r.title)}</b><small>${r.step ? `<code>${esc(r.step)}</code>` : 'Working'}</small></span><span class="li-end"><span data-since="${r.since || ''}">${r.since ? clock(Date.now() - r.since) : ''}</span></span></button>`).join('')}</div>`;
    }
    if (rec.length) {
      h += sec('Recent', '<button type="button" data-q="all">See all</button>');
      h += `<div class="list">${rec.map(rowHtml).join('')}</div>`;
    }
    v.innerHTML = h;
  }
  function rowHtml(r) {
    const k = r.kind === 'cloud' ? 'cloud' : r.kind === 'chat' ? 'chat' : r.kind === 'design' ? 'design' : 'code';
    const end = r.flag === 'needs' ? `<span>${esc(r.at ? ago(r.at) : '')}</span><span class="dot" aria-label="Needs you"></span>`
      : r.flag === 'running' ? '<span class="spinner" aria-label="Working"></span>'
      : `<span>${esc(r.at ? ago(r.at) : '')}</span>`;
    return `<button type="button" class="li" data-open="${esc(r.id)}"><span class="li-ico">${KIND_ICO[k]}</span><span class="li-main"><b>${esc(r.title)}</b><small>${esc(r.sub || '')}</small></span><span class="li-end">${end}</span></button>`;
  }

  // ─── Chats ────────────────────────────────────────────────────────────────
  /** data: { groups: [{ title, rows: [...] }] } */
  function renderChats(data) {
    const slot = $('chatsListSlot');
    if (!slot) return;
    slot.innerHTML = (data.groups || []).map((g) => `${sec(g.title, g.count ? `<span>${g.count}</span>` : '')}<div class="list">${g.rows.map(rowHtml).join('')}</div>`).join('');
  }

  // ─── You ──────────────────────────────────────────────────────────────────
  const PERM_TITLE = { ask: 'Ask first', edits: 'Accept edits', full: 'Full access' };
  /** data: { name, email, usage: { today, yesterday, days }, pc: { name, online, projects }, perm, model, theme, notifications } */
  function renderYou(data) {
    const v = $('youView');
    if (!v) return;
    const u = data.usage || {};
    const days = u.days || [];
    const peak = Math.max(1, ...days);
    const change = u.yesterday ? Math.round((u.today - u.yesterday) / u.yesterday * 100) : null;
    const li = (act, ico, title, val = '', sub = '') => `<button type="button" class="li" data-act="${act}"><span class="li-ico">${ico}</span><span class="li-main"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${val ? `<span class="val">${val}</span>` : ''}${I.chev}</button>`;
    v.innerHTML = `${head('You')}
      <button type="button" class="me" data-act="account"><span class="me-av">${esc((data.name || data.email || 'C')[0].toUpperCase())}</span><span class="li-main"><b>${esc(data.name || 'You')}</b><small>${esc(data.email || '')}</small></span>${I.chev}</button>

      ${sec('Usage', '<button type="button" data-act="usage">Details</button>')}
      <div class="usage" data-act="usage">
        <small>Tokens today</small>
        <div class="big">${short(u.today)}</div>
        <div class="delta">${change == null ? '' : `<b class="${change < 0 ? 'down' : ''}">${change < 0 ? '▼' : '▲'} ${Math.abs(change)}%</b>`}<span>vs yesterday · one shared daily limit</span></div>
        <div class="bars">${days.map((n, i) => `<i class="${i === days.length - 1 ? 'today' : ''}" style="height:${Math.max(4, Math.round(n / peak * 100))}%"></i>`).join('')}</div>
        <div class="axis"><span>${days.length} days ago</span><span>Today</span></div>
      </div>

      ${sec('Your agent')}
      <div class="list">
        ${li('pc', I.pc, (data.pc && data.pc.name) || 'Your PC', `<span class="status${data.pc && data.pc.online ? ' on' : ''}"><i></i>${data.pc && data.pc.online ? 'Online' : 'Offline'}</span>`, data.pc && data.pc.online ? `${data.pc.projects || 0} projects` : 'Open Codeply on your computer')}
        ${li('perm', I.shield, 'Permissions', esc(PERM_TITLE[data.perm] || 'Ask first'))}
        ${li('model', I.spark, 'Model', esc(data.model || 'Haze 2'))}
        ${li('cloud', I.cloud, 'Cloud', '', 'Keeps working with your PC off')}
        ${li('design', I.design, 'Design', '', 'Screens, sites and decks')}
      </div>

      ${sec('This phone')}
      <div class="list">
        ${li('bell', I.bell, 'Notifications', esc(data.notifications || 'Off'))}
        <div class="li"><span class="li-ico">${I.sun}</span><span class="li-main"><b>Appearance</b></span></div>
        <div style="padding:0 16px 12px"><div class="seg wide" id="youTheme" style="margin:0">${['system', 'light', 'dark'].map((t) => `<button type="button" data-theme="${t}" class="${data.theme === t ? 'on' : ''}">${t === 'system' ? 'Automatic' : t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      </div>

      <div class="list" style="margin-top:26px"><button type="button" class="li danger" data-act="signout">Sign out</button></div>
      <div class="list" style="margin-top:12px"><button type="button" class="li danger" data-act="delete">Delete account</button></div>
      <p class="note" style="text-align:center;margin-top:16px">Codeply for phone</p>`;
  }

  // ─── Usage panel ──────────────────────────────────────────────────────────
  /** data: { today, week, month, total, days: [n...30], models: [{ name, tokens, calls }] } */
  function renderUsage(data) {
    const body = $('usageBody');
    if (!body) return;
    const days = data.days || [];
    const peak = Math.max(1, ...days);
    const models = data.models || [];
    const top = Math.max(1, ...models.map((m) => m.tokens));
    body.innerHTML = `
      <div class="usage" style="margin-top:12px"><small>Last 30 days</small><div class="big">${short(data.month)} tokens</div>
        <div class="delta"><span>${short(data.today)} today · ${short(data.week)} this week · ${short(data.total)} all time</span></div>
        <div class="bars" style="height:120px">${days.map((n, i) => `<i class="${i === days.length - 1 ? 'today' : ''}" style="height:${Math.max(3, Math.round(n / peak * 100))}%"></i>`).join('')}</div>
        <div class="axis"><span>30 days ago</span><span>Today</span></div>
        <div class="seg wide"><button type="button">7D</button><button type="button">14D</button><button type="button" class="on">30D</button><button type="button">1Y</button></div></div>
      ${sec('By model', '<span>30 days</span>')}
      <div class="list flat">${models.map((m) => `<div class="li" style="flex-direction:column;align-items:stretch;gap:0"><div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:16px;font-weight:600">${esc(m.name)}</b><span style="color:var(--muted);font-size:15px">${short(m.tokens)}</span></div><small style="color:var(--muted);font-size:14px">${short(m.calls)} calls</small><div class="meter"><i style="width:${Math.round(m.tokens / top * 100)}%"></i></div></div>`).join('') || '<div class="li plain" style="color:var(--muted)">No usage yet.</div>'}</div>
      <p class="note">Counts from Craft, Crew, the CLI, Cloud and this phone. Counts only, never what you wrote. Chat and Code share one daily limit; your own models use your own keys.</p>`;
  }

  // ─── Permissions panel ────────────────────────────────────────────────────
  const MODES = [
    ['ask', 'Ask first', 'You approve every edit and command.', false],
    ['edits', 'Accept edits', 'File edits in the project run on their own. Commands, deploys and messages still ask.', true],
    ['full', 'Full access', 'Nothing asks. Your blocked rules still hold.', false],
  ];
  const modeList = (on) => `<div class="list">${MODES.map(([v, t, s, rec]) => `<button type="button" class="li${on === v ? ' on' : ''}" data-mode="${v}"><span class="li-main"><b>${t}${rec ? '<span class="rec">Recommended</span>' : ''}</b><small class="wrap">${s}</small></span>${I.check}</button>`).join('')}</div>`;
  function ruleLabel(r) {
    const i = r.indexOf(':');
    const tool = i < 0 ? r : r.slice(0, i);
    return [{ run: 'Command', edit_file: 'Edit', write_file: 'Create', apply_patch: 'Patch' }[tool] || tool.replace(/_/g, ' '), i < 0 ? 'everything' : r.slice(i + 1)];
  }
  /** data: { perm, online, allow: [rule], deny: [rule] } */
  function renderPerms(data) {
    const body = $('permsBody');
    if (!body) return;
    const rules = (list, which) => list.map((r) => { const [k, w] = ruleLabel(r); return `<div class="li" style="min-height:48px"><span class="rule-kind">${esc(k)}</span><span class="rule-pat">${esc(w)}</span><button type="button" class="rule-x" data-rm="${esc(which)}|${esc(r)}" aria-label="Remove ${esc(r)}">${I.x}</button></div>`; }).join('');
    const add = (which, ph) => `<div class="rule-add"><select aria-label="Kind"><option value="run">Command</option><option value="edit_file">Edit</option><option value="write_file">Create</option></select><input placeholder="${ph}" aria-label="Pattern" autocapitalize="off" spellcheck="false"><button type="button" data-add="${which}">Add</button></div>`;
    body.innerHTML = `
      ${sec('On your PC')}${modeList(data.perm)}
      <p class="note">Risky commands always ask, whatever you pick.</p>
      ${sec('Always allowed', `<span>${(data.allow || []).length}</span>`)}
      <div class="list flat">${rules(data.allow || [], 'allow')}${add('allow', 'npm test')}</div>
      ${sec('Blocked', `<span>${(data.deny || []).length}</span>`)}
      <div class="list flat">${rules(data.deny || [], 'deny')}${add('deny', 'git push*')}</div>
      <p class="note">${data.online ? 'Rules live on your PC and cover every project. Blocked wins over everything. "Always allow" on an approval only covers that chat.' : 'Your PC is offline. Its rules show here once it is online.'}</p>`;
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────
  function renderOnboard(step, data = {}) {
    const box = $('onboard');
    if (!box) return;
    const dots = `<div class="ob-dots">${[0, 1, 2, 3].map((i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>`;
    let body = ''; let actions = '';
    if (step === 0) {
      body = `<span class="ob-wisp"></span><h1>Hi${data.name ? ` ${esc(data.name)}` : ''}. I'm Codeply.</h1><p>Ask me anything, or give me real work. I build on your PC, keep going in the cloud when it's off, and ask before anything risky.</p>`;
      actions = '<button type="button" class="btn btn-primary" data-ob="next">Continue</button>';
    } else if (step === 1) {
      body = `<h1>Connect your PC</h1><p>Your agent works on your own computer, with your files and tools.</p>
        <div class="list flat">
          <div class="li"><span class="ob-num">1</span><span class="li-main"><b>Get Codeply for your computer</b><small>codeply.app/download</small></span></div>
          <div class="li"><span class="ob-num">2</span><span class="li-main"><b>Sign in with this account</b><small>${esc(data.email || 'The email you just used')}</small></span></div>
          <div class="li"><span class="ob-num">3</span><span class="li-main"><b>Leave it open</b><small>This phone finds it on any network</small></span></div>
        </div>
        <div class="ob-found${data.pcOnline ? ' ok' : ''}">${data.pcOnline ? `${I.check.replace('class="check"', 'width="16" height="16"')} Found ${esc(data.pcName || 'your PC')}` : '<span class="spinner"></span> Looking for your PC'}</div>`;
      actions = `<button type="button" class="btn btn-primary" data-ob="next">${data.pcOnline ? 'Continue' : 'Continue without it'}</button><button type="button" class="btn btn-ghost" data-ob="cloud">Use the cloud instead</button>`;
    } else if (step === 2) {
      body = `<h1>How should I ask?</h1><p>You can change this any time in You, Permissions.</p>${modeList(data.perm || 'edits')}`;
      actions = '<button type="button" class="btn btn-primary" data-ob="next">Continue</button>';
    } else {
      body = '<h1>Get a tap when I need you</h1><p>A notification when a task needs your OK or finishes, and the reminders you ask for. Nothing else.</p>';
      actions = '<button type="button" class="btn btn-primary" data-ob="notify">Allow notifications</button><button type="button" class="btn btn-ghost" data-ob="done">Not now</button>';
    }
    box.innerHTML = `<div class="ob-top">${dots}<button type="button" class="ob-skip" data-ob="done">Skip</button></div><div class="ob-body">${body}</div><div class="ob-actions">${actions}</div>`;
    const face = box.querySelector('.ob-wisp');
    if (face && W()) W().mount(face, { size: 'lg' });
    box.classList.remove('hidden');
  }

  // ─── Sign in / create account ─────────────────────────────────────────────
  function setAuthTab(t) {
    document.querySelectorAll('#authTabs [data-auth]').forEach((b) => { const on = b.dataset.auth === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    $('loginForm').classList.toggle('hidden', t !== 'in');
    $('signupForm').classList.toggle('hidden', t !== 'up');
    $('authTitle').textContent = t === 'up' ? 'Create your account' : 'Sign in to Codeply';
    $('authSub').textContent = t === 'up' ? 'One account for your phone, your PC and the CLI.' : 'Use the same account as Codeply on your computer.';
  }

  // ─── Shell ────────────────────────────────────────────────────────────────
  function shell() {
    const mb = $('menuBtn');
    if (mb && !mb.querySelector('.ico-back')) {
      mb.querySelector('svg').classList.add('ico-menu');
      mb.insertAdjacentHTML('beforeend', '<svg class="ico-back" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>');
    }
    const mark = document.querySelector('#signin .signin-mark');
    if (mark && !document.querySelector('#signin .signin-brand')) mark.insertAdjacentHTML('afterend', MARK);
    const slot = $('chatsSearchSlot');
    const si = $('searchInput');
    if (slot && si && !slot.contains(si)) { slot.replaceWith(si); si.placeholder = 'Search'; }
    const sb = document.querySelector('#chatsView .tv-search');
    if (sb) sb.className = 'searchbar';
    const filt = $('chatsFilter');
    if (filt) filt.classList.add('wide');
    document.querySelectorAll('#authTabs [data-auth]').forEach((b) => b.addEventListener('click', () => setAuthTab(b.dataset.auth)));
    document.querySelectorAll('#tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.tab === 'calls' ? view : b.dataset.tab)));
    document.querySelectorAll('[data-close-panel]').forEach((b) => b.addEventListener('click', () => b.closest('.panel').classList.add('hidden')));
    document.querySelectorAll('#chatsFilter [data-f]').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('#chatsFilter [data-f]').forEach((x) => x.classList.toggle('on', x === b)); }));
    setView('home');
  }

  // ─── Preview: every screen with sample data (?preview=<screen>) ───────────
  const now = Date.now();
  const SAMPLE = {
    home: {
      initials: 'A', pc: { name: 'Awais-PC', online: true }, cloud: true,
      approvals: [
        { id: 'a1', kind: 'Run a command', where: 'Fix checkout total · shop-web', cmd: 'npm install stripe@14 && npm test', isCmd: true, always: 'Always allow npm install and npm test here', at: now - 120e3 },
        { id: 'a2', kind: 'Push to GitHub', where: 'Landing page · lumen-site', cmd: 'git push origin main', isCmd: true, danger: true, at: now - 9 * 60e3 },
      ],
      running: [{ id: 'c4', title: 'Add dark mode to settings', step: 'npm run build', since: now - 94e3 }],
      recent: [
        { id: 'c1', title: 'Fix checkout total', kind: 'code', sub: 'shop-web · on Awais-PC', at: now - 3600e3 },
        { id: 'c2', title: 'Hero line for the tea shop', kind: 'chat', sub: 'Chat', at: now - 5 * 3600e3 },
        { id: 'c3', title: 'Nightly tests', kind: 'cloud', sub: 'lumen-site · cloud', at: now - 26 * 3600e3 },
      ],
    },
    chats: { groups: [
      { title: 'Needs you', count: 2, rows: [{ id: 'c1', title: 'Fix checkout total', kind: 'code', sub: 'Wants to run npm install', flag: 'needs', at: now - 120e3 }, { id: 'c5', title: 'Landing page', kind: 'code', sub: 'Wants to push to GitHub', flag: 'needs', at: now - 9 * 60e3 }] },
      { title: 'Running', count: 1, rows: [{ id: 'c4', title: 'Add dark mode to settings', kind: 'cloud', sub: 'npm run build', flag: 'running' }] },
      { title: 'Today', rows: [{ id: 'c2', title: 'Hero line for the tea shop', kind: 'chat', sub: '"Steep slow. Sip slower."', at: now - 5 * 3600e3 }, { id: 'c6', title: 'Plan my day', kind: 'chat', sub: 'Design review at 3, call Ali at 5', at: now - 7 * 3600e3 }] },
      { title: 'Earlier', rows: [{ id: 'c3', title: 'Nightly tests', kind: 'cloud', sub: '24 of 24 passed', at: now - 26 * 3600e3 }, { id: 'c7', title: 'Pricing page redesign', kind: 'design', sub: '3 screens', at: now - 3 * 86400e3 }] },
    ] },
    you: { name: 'Awais Siddique', email: 'awais@codeply.app', perm: 'edits', model: 'Haze 2', theme: 'system', notifications: 'On', pc: { name: 'Awais-PC', online: true, projects: 6 },
      usage: { today: 182400, yesterday: 162000, days: [120, 340, 80, 0, 260, 510, 420, 300, 610, 220, 90, 480, 162, 182].map((x) => x * 1000) } },
    usage: { today: 182400, week: 1240000, month: 5320000, total: 48600000,
      days: [90, 120, 60, 0, 30, 210, 340, 80, 0, 260, 510, 420, 300, 120, 0, 40, 610, 220, 90, 480, 700, 182, 330, 410, 150, 0, 260, 390, 520, 182].map((x) => x * 1000),
      models: [{ name: 'Haze 2', tokens: 3900000, calls: 412 }, { name: 'Qwen Coder · your key', tokens: 960000, calls: 88 }, { name: 'Gemma 4 31B', tokens: 460000, calls: 51 }] },
    perms: { perm: 'edits', online: true, allow: ['run:npm test', 'run:npm run *', 'run:git status', 'edit_file:src/**'], deny: ['run:git push*', 'write_file:*.env'] },
  };
  function preview(screen) {
    document.body.classList.add('previewing');
    if (screen === 'signin' || screen === 'signup') {
      $('app').classList.add('hidden'); $('signin').classList.remove('hidden');
      if (P().signinStep) P().signinStep('login');
      setAuthTab(screen === 'signup' ? 'up' : 'in');
      return;
    }
    if (screen.startsWith('onboard')) { renderOnboard(Number(screen.slice(7)) || 0, { name: 'Awais', email: 'awais@codeply.app', pcOnline: true, pcName: 'Awais-PC', perm: 'edits' }); return; }
    $('tabAvatar').textContent = 'A';
    if (screen === 'home') { setView('home'); renderHome(SAMPLE.home); $('homeBadge').textContent = '2'; $('homeBadge').classList.remove('hidden'); return; }
    if (screen === 'chats') { setView('chats'); renderChats(SAMPLE.chats); return; }
    if (screen === 'you') { setView('you'); renderYou(SAMPLE.you); return; }
    if (screen === 'usage') { setView('you'); renderYou(SAMPLE.you); renderUsage(SAMPLE.usage); $('usagePanel').classList.remove('hidden'); return; }
    if (screen === 'perms') { setView('you'); renderYou(SAMPLE.you); renderPerms(SAMPLE.perms); $('permsPanel').classList.remove('hidden'); }
  }

  window.CraftApp = { setView, renderHome, renderChats, renderYou, renderUsage, renderPerms, renderOnboard, setAuthTab, preview, SAMPLE };

  function start() {
    shell();
    const m = /[?&#]preview=([a-z0-9]+)/.exec(location.search + location.hash);
    if (m) setTimeout(() => preview(m[1]), 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
