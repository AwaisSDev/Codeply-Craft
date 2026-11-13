/**
 * Office and Apps views for the Codeply workspace.
 * index.html passes its helpers in: { ico, B, TEAM, bot, composer, side, view, me, go, $ }.
 *
 * Office: the agents' default page. A small top-down office where each agent's place and
 * motion say what it is doing: at a desk (working), at the coffee machine (thinking),
 * on the sofa (asleep), at the "Needs you" counter (waiting), or walking between rooms.
 * Click an agent to see its latest chat or live session.
 *
 * Apps: integrations. Mail, calendar, code hosts and the rest are apps the agents act
 * through (any of 34,000), always asking before they send.
 */
(function () {
  'use strict';

  // Scene coordinates are in a 1200 x 720 office; agents are placed by percent of that box.
  const at = (x, y) => `left:${(x / 1200 * 100).toFixed(2)}%;top:${(y / 720 * 100).toFixed(2)}%`;

  const PLACES = {
    wisp: { pos: [760, 214], state: 'idle', where: 'At the lead desk', action: 'Watching your day. Brief at 6:00' },
    frontend: { pos: [170, 214], state: 'working', where: 'Studio', action: 'Editing pricing.html, +42 lines' },
    backend: { pos: [1050, 124], state: 'thinking', where: 'Kitchen', action: 'Thinking about plan limits over coffee', extra: 'mug' },
    inbox: { pos: [300, 588], state: 'waiting', where: 'Needs you', action: 'Waiting for your OK on 1 reply', extra: 'bubble' },
    research: { pos: [780, 600], state: 'sleeping', where: 'Lounge', action: 'Asleep. Finished the venue search 1h ago', extra: 'zzz' },
    docs: { pos: [430, 340], state: 'walking', where: 'Hallway', action: 'Walking to the kitchen. Next: README after PR #44', walk: true },
  };

  // A potted plant seen from above: a pot and five leaves.
  const plant = (x, y, r) => `<g class="plant"><circle class="pot" cx="${x}" cy="${y}" r="${r * 0.62}"/>${[0, 72, 144, 216, 288].map((d, i) => `<ellipse class="leaf${i % 2 ? ' l2' : ''}" cx="${x}" cy="${y - r * 0.55}" rx="${r * 0.32}" ry="${r * 0.62}" transform="rotate(${d} ${x} ${y})"/>`).join('')}</g>`;

  function scene() {
    const desk = (x, y, on, lines) => `
      <rect class="desk" x="${x}" y="${y}" width="180" height="60" rx="10"/>
      <rect class="mon" x="${x + 50}" y="${y + 8}" width="80" height="30" rx="4"/>
      <rect class="screen${on ? ' on' : ''}" x="${x + 54}" y="${y + 12}" width="72" height="22" rx="2"/>
      ${lines ? `<rect class="code-line" x="${x + 59}" y="${y + 16}" width="34" height="3" rx="1.5"/><rect class="code-line b" x="${x + 59}" y="${y + 22}" width="52" height="3" rx="1.5"/><rect class="code-line c" x="${x + 59}" y="${y + 28}" width="24" height="3" rx="1.5"/>` : ''}
      <circle class="chair" cx="${x + 90}" cy="${y + 95}" r="20"/>`;
    return `<svg viewBox="0 0 1200 720" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs><pattern id="tiles" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#1d1d1d"/></pattern></defs>
      <rect x="0" y="0" width="1200" height="720" rx="18" fill="#101010"/>
      <rect x="0" y="0" width="1200" height="720" rx="18" fill="url(#tiles)"/>

      <rect class="room" x="20" y="20" width="560" height="420" rx="14"/>
      <text class="room-label" x="40" y="50">Studio</text>
      ${desk(80, 110, true, true)}${desk(320, 110, true, true)}${desk(80, 280)}${desk(320, 280)}

      <rect class="room" x="600" y="20" width="280" height="240" rx="14"/>
      <text class="room-label" x="620" y="50">Wisp</text>
      <rect class="desk" x="670" y="110" width="180" height="60" rx="10"/>
      <rect class="mon" x="720" y="118" width="80" height="30" rx="4"/><rect class="screen on" x="724" y="122" width="72" height="22" rx="2"/>
      ${plant(846, 64, 16)}

      <rect class="room" x="900" y="20" width="280" height="240" rx="14"/>
      <text class="room-label" x="920" y="50">Kitchen</text>
      <rect class="soft" x="920" y="64" width="240" height="30" rx="8"/>
      <rect class="mon" x="1096" y="62" width="40" height="26" rx="5"/><circle class="lamp" cx="1128" cy="70" r="3"/>
      <circle class="soft" cx="990" cy="190" r="34"/><circle class="chair" cx="940" cy="190" r="12"/><circle class="chair" cx="1040" cy="190" r="12"/>

      <rect class="room" x="600" y="280" width="580" height="420" rx="14"/>
      <text class="room-label" x="620" y="310">Lounge</text>
      <ellipse class="rug" cx="880" cy="480" rx="200" ry="82"/>
      <rect class="soft" x="840" y="456" width="90" height="44" rx="10"/>
      <rect class="soft" x="640" y="560" width="300" height="76" rx="22"/>
      <rect class="desk" x="640" y="630" width="300" height="24" rx="10"/>
      <circle class="soft" cx="1090" cy="430" r="40"/>
      ${plant(1148, 334, 18)}${plant(1148, 660, 18)}

      <rect class="room" x="20" y="460" width="560" height="240" rx="14"/>
      <text class="room-label" x="40" y="490">Needs you</text>
      <rect class="desk" x="60" y="626" width="480" height="40" rx="10"/>
      <rect class="soft" x="400" y="634" width="54" height="24" rx="4"/><rect class="soft" x="462" y="634" width="54" height="24" rx="4"/>
    </svg>`;
  }

  function agentEl(api, id) {
    const a = api.TEAM[id], p = PLACES[id];
    const extra = p.extra === 'zzz' ? '<span class="zzz"><i>z</i><i>z</i><i>z</i></span>'
      : p.extra === 'mug' ? '<span class="mug"></span><span class="steam"><i></i><i></i><i></i></span>'
        : p.extra === 'bubble' ? '<span class="bubble">Needs your OK</span>' : '';
    const botHtml = `<span class="bot" data-state="${p.state === 'walking' ? 'idle' : p.state}">${api.B.svg('wisp', { size: 56, color: a.color, gear: a.gear })}<i class="dots"><b></b><b></b><b></b></i></span>`;
    return `<div class="agent${p.walk ? ' walk' : ''}" data-agent="${id}" data-tip="${a.name}: ${p.action}" style="${at(...p.pos)}">${botHtml}${extra}<span class="tag">${a.name}</span></div>`;
  }

  // The latest chat or live session for each agent.
  function session(api, id) {
    const { ico } = api; const a = api.TEAM[id];
    const step = (t, now) => `<div class="stepx${now ? ' now' : ''}">${ico(now ? 'refresh' : 'check', 's16')}<span>${t}</span></div>`;
    const gmail = '<span class="via"><img src="https://cdn.jsdelivr.net/npm/simple-icons@13.0.0/icons/gmail.svg" alt="">via Gmail</span>';
    const S = {
      frontend: `<div class="label">Live session · 14 min</div>
        <div class="live"><div class="thumb" style="margin:0;height:100%;border:0"><div class="chrome"></div><div class="hero"></div><i class="l1"></i><i class="l2"></i><i class="l3"></i><svg class="cur" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="${a.color}" stroke="#fff" stroke-width="1.5"/></svg></div></div>
        ${step('Read <b>index.html</b> and the homepage styles')}${step('Asked Backend for the plan data')}${step('Created <b>plans.json</b>')}${step('<span class="shimmer">Editing <b>pricing.html</b>, +42 lines</span>', true)}
        <div style="display:flex;gap:8px"><button class="btn" data-go="code">${ico('code', 's16')}Open in Code</button><button class="btn" data-go="prs">${ico('branch', 's16')}PR #44</button></div>`,
      backend: `<div class="label">Live session · thinking</div>
        ${step('Read the pricing brief from Frontend')}${step('Wrote <b>plans.json</b> with Free, Plus and Team')}${step('<span class="shimmer">Deciding how strict the Team limits should be</span>', true)}
        <div class="draft" style="font-size:13px;color:var(--dim)">"Free: 3 projects. Plus: 20. Team: unlimited, with per-seat billing. Checking the API enforces it, not just the page."</div>`,
      inbox: `<div class="label">Needs your OK</div>
        <div><b>Re: lease renewal</b><div style="color:var(--faint);font-size:12.5px">to landlord@example.com · ${gmail}</div></div>
        <div class="draft">Hi Ana, thanks for the renewal. The 1st works for me, and I'll send the deposit by Friday.<br><br>Best,<br>Sam</div>
        <div style="display:flex;gap:8px"><button class="btn blue">${ico('arrow-up', 's16')}Send</button><button class="btn">Edit</button><button class="btn">Discard</button></div>`,
      research: `<div class="label">Latest chat · 1h ago</div>
        <div class="bub">Find a place for Friday drinks, 20 people, near the office.</div>
        <div class="rep">Found 4. The top pick holds 20, is 10 minutes away and costs $240 for the evening. Want me to book it?</div>
        <div style="display:flex;gap:8px"><button class="btn blue">Book it</button><button class="btn">See all 4</button></div>`,
      wisp: `<div class="label">Latest chat · 9:41</div>
        <div class="bub">Morning! Can you check in with the team for me?</div>
        <div class="rep">All on track. Frontend is checking the pricing page, Backend is on the plan limits, and Inbox has a reply for you to approve.</div>
        <div class="via">${ico('history', 's16')}Created routine: Morning check-in, every day at 9:00</div>`,
      docs: `<div class="label">On a short break</div>
        ${step('Updated the changelog for 4.0')}${step('<span class="shimmer">Next: the README, once PR #44 merges</span>', true)}`,
    };
    return S[id] || '';
  }

  function openDrawer(api, id) {
    const a = api.TEAM[id], p = PLACES[id];
    const d = document.getElementById('drawer');
    d.innerHTML = `<div class="dh"><span class="bot" data-state="${p.state === 'walking' ? 'idle' : p.state}">${api.B.svg('wisp', { size: 40, color: a.color, gear: a.gear })}<i class="dots"><b></b><b></b><b></b></i></span>
        <div class="grow"><b>${a.name}</b><small>${a.role} · ${p.where}</small></div>
        <button class="ibtn" data-close-drawer title="Close">${api.ico('close')}</button></div>
      <div class="db">${session(api, id)}</div>
      <div class="df">${api.composer(`Message ${a.name}`, false, true)}</div>`;
    d.classList.add('open');
    document.querySelectorAll('.agent').forEach((el) => el.classList.toggle('sel', el.dataset.agent === id));
  }

  function office(api) {
    api.TEAM.docs = api.TEAM.docs || { name: 'Docs', color: '#4fb3ff', gear: 'antennae', state: 'idle', role: 'Claude Code' };
    const ids = Object.keys(PLACES);
    const n = (s) => ids.filter((id) => PLACES[id].state === s).length;
    api.view(`<div class="office-wrap fade">
        <div class="office-top"><div><h1>Office</h1><div class="sub">${n('working')} working, ${n('thinking')} thinking, ${n('waiting')} needs you, ${n('sleeping')} asleep</div></div>
          <span class="grow"></span><div class="seg"><button class="on">Office</button><button data-go="board">Board</button></div>
          <button class="btn primary">${api.ico('plus', 's16')}New task</button></div>
        <div class="stage"><div class="office">${scene()}${ids.map((id) => agentEl(api, id)).join('')}</div></div>
        <div class="office-dock">${api.composer('Give Wisp a task, or ask how things are going', false)}</div>
        <aside class="drawer" id="drawer"></aside>
      </div>`);
  }

  // ---------- Apps ----------
  const LOGO = (slug, name) => `<span class="app-logo"><img src="https://cdn.jsdelivr.net/npm/simple-icons@13.0.0/icons/${slug}.svg" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${name[0]}'}))"></span>`;
  function apps(api) {
    const { ico } = api;
    const connected = [
      ['gmail', 'Gmail', 'Read, draft and send. Sends only after you OK it.', ['inbox', 'wisp']],
      ['googlecalendar', 'Google Calendar', 'Read and change events. Every change is read back.', ['wisp']],
      ['github', 'GitHub', 'Branches, pull requests and checks.', ['frontend', 'backend']],
      ['slack', 'Slack', 'Read channels, post updates you approve.', ['wisp']],
      ['notion', 'Notion', 'Read and write pages.', ['docs']],
      ['vercel', 'Vercel', 'Preview and production deploys.', ['frontend']],
    ];
    const popular = [['linear', 'Linear', 'Issues'], ['stripe', 'Stripe', 'Payments'], ['figma', 'Figma', 'Design'], ['googledrive', 'Google Drive', 'Files'], ['discord', 'Discord', 'Chat'], ['whatsapp', 'WhatsApp', 'Messages'], ['hubspot', 'HubSpot', 'CRM'], ['zoom', 'Zoom', 'Meetings']];
    api.side(`<div class="side-head"><h2>Apps</h2></div><div class="side-scroll">
        ${[['link', 'Connected', 6], ['mail', 'Communication', '1.2k'], ['code', 'Developer', '3.4k'], ['calendar', 'Productivity', '5.1k'], ['chart', 'Finance', '2.2k'], ['users', 'CRM and sales', '2.8k']]
          .map(([i, t, c], k) => `<div class="row${k ? '' : ' on'}">${ico(i)}<div class="nm">${t}</div><span class="meta">${c}</span></div>`).join('')}
      </div>${api.me()}`);
    api.view(`<div class="apps fade">
        <div class="head" style="padding-left:0;padding-right:0"><div><h1>Apps</h1></div></div>
        <p class="lead">Connect any of 34,000 apps. Your agents work through them and ask before anything goes out.</p>
        <label class="search">${ico('search')}<input placeholder="Search 34,000 apps"></label>
        <h3>Connected<span class="grow"></span><a href="#">Manage</a></h3>
        <div class="conn">${connected.map(([slug, name, sub, who]) => `<div class="r">${LOGO(slug, name)}<div class="nm"><b>${name}</b><small>${sub}</small></div><span class="who">${who.map((id) => api.bot(id, 22)).join('')}</span><button class="btn">Manage</button></div>`).join('')}</div>
        <h3>Popular<span class="grow"></span><a href="#">Browse all</a></h3>
        <div class="grid-apps">${popular.map(([slug, name, sub]) => `<div class="tile-app">${LOGO(slug, name)}<div class="nm">${name}<small>${sub}</small></div><button class="btn">Connect</button></div>`).join('')}</div>
        <h3>Recent actions through apps</h3>
        <div class="log">
          <div class="r">${LOGO('gmail', 'Gmail')}<div class="nm">Inbox drafted <b>Re: lease renewal</b> <small>· waiting for your OK</small></div><time>8:14</time></div>
          <div class="r">${LOGO('googlecalendar', 'Calendar')}<div class="nm">Wisp moved <b>Standup</b> to 9:30 <small>· read back, matches</small></div><time>7:52</time></div>
          <div class="r">${LOGO('github', 'GitHub')}<div class="nm">Frontend opened <b>PR #44</b> <small>· 3 checks passed</small></div><time>7:12</time></div>
          <div class="r">${LOGO('slack', 'Slack')}<div class="nm">Wisp posted the standup change in <b>#team</b> <small>· you approved</small></div><time>7:53</time></div>
        </div>
      </div>`);
  }

  window.CWViews = { office, apps, openDrawer };
})();
