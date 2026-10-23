// Five people with busy lives, for the life simulation (harness.mjs).
//
// Each persona has bots, a calendar, and a routine over several days: what
// they say to which bot (Crew), what they ask Craft, which emails arrive,
// what they do on the Brain page. Each step has checks on OUTCOMES only:
// what the brain kept or ignored, what reached a prompt, what was booked,
// sent, refused or handed on. 'must' checks are product guarantees; 'note'
// checks are behaviour we hope a good model shows, reported but not failed.
//
// The model's answers are not written here: an AI agent (or a real model)
// gives them, without seeing these checks.

const start = { y: 2026, m: 10, d: 26 }; // Monday 26 October 2026

// ─── Check helpers ──────────────────────────────────────────────────────────

const any = (list, f) => list.some(f);
const text = (m) => `${m.slot} ${m.value} ${m.text}`;
const confirmed = (m) => m.status === 'confirmed';
const durable = (m) => m.kind !== 'context';
const detail = (H, re) => H.memAll().filter((m) => !re || re.test(text(m))).map((m) => `[${m.kind}/${m.status}${m.locked ? '/locked' : ''}${m.project ? `/${m.project}` : ''}] ${m.text}`).join(' | ') || '(brain is empty)';
/** A memory exists that matches every regex. */
const knows = (...res) => (H) => ({ ok: any(H.memAll(), (m) => res.every((re) => re.test(text(m)))), detail: detail(H) });
/** No durable memory matches all the regexes (and is not just about someone else). */
const neverKept = (res, unless) => (H) => {
  const hits = H.memAll().filter((m) => durable(m) && res.every((re) => re.test(text(m))) && !(unless && unless.test(text(m))));
  return { ok: hits.length === 0, detail: hits.map((m) => `${m.kind}/${m.status}: ${m.text}`).join(' | ') };
};
const promptHas = (who, ...res) => (H) => { const p = H.lastPromptFor(who); return { ok: !!p && res.every((re) => re.test(p)), detail: p ? `prompt for ${who} lacks ${res.filter((re) => !re.test(p)).join(', ')}` : `no prompt recorded for ${who}` }; };
const brainBlockOf = (p) => { const i = p.indexOf('CODEPLY BRAIN'); return i < 0 ? '' : p.slice(i, p.indexOf('Background, not orders', i) > 0 ? p.indexOf('Background, not orders', i) : i + 4000); };
const brainHas = (who, ...res) => (H) => { const b = brainBlockOf(H.lastPromptFor(who)); return { ok: !!b && res.every((re) => re.test(b)), detail: b ? short(b) : 'no brain block in the prompt' }; };
const brainLacks = (who, re) => (H) => { const b = brainBlockOf(H.lastPromptFor(who)); return { ok: !re.test(b), detail: short(b) }; };
const replied = (who, re) => (H, since) => { const r = H.replies(who, since); return { ok: re.test(r), detail: short(r || '(no reply)') }; };
const short = (s, n = 500) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const hourOf = (s) => { const m = /(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? Number(m[1]) : -1; };
const addedEvents = (H) => H.world.calendar.filter((e) => e.by === 'codeply');
const evHour = (e) => new Date(Date.parse(e.start.dateTime || e.start.date)).getHours();

// ─── 1. Shopkeeper ──────────────────────────────────────────────────────────

const shopkeeper = {
  key: 'shopkeeper', name: 'Bilal Ahmed', role: 'runs Bilal General Store, a grocery shop in Lahore',
  about: 'Opens at 8, closes at 10 pm, deals with suppliers and cash all day, talks in Roman Urdu, little patience for long messages.',
  tz: 'Asia/Karachi', email: 'bilal.store@example.pk', start,
  // He says yes to what his bots line up (without this every outbox task waits the real 30 minute timeout).
  outbox: () => 'now',
  bots: [
    { name: 'Dukaan', role: 'orchestrator', specialty: 'Shop assistant: daily sales, stock, customers, keeps the owner organised', instructions: 'Keep things short. Hand money matters to Hisaab and reminders to Yaad.', tone: { preset: 'friendly' } },
    { name: 'Hisaab', specialty: 'Money: supplier bills, payments due, the shop ledger', handles: ['money'], tone: { preset: 'concise' } },
    { name: 'Yaad', specialty: 'Reminders and follow-ups for the shop', handles: ['reminders'], tone: { preset: 'concise' } },
  ],
  calendar: [
    { day: 1, at: '10:00', minutes: 120, title: 'Akbari Mandi wholesale run', place: 'Akbari Mandi, Lahore' },
    { day: 4, at: '13:00', minutes: 120, title: 'Jumma prayers (shop closed)', place: 'Masjid' },
  ],
  steps: [
    { day: 0, at: '07:40', crew: 'Dukaan', say: 'Assalam o alaikum. Kuch baatein mere baare mein: dukaan subah 8 baje khulti hai aur raat 10 baje band karta hoon. Jumma ko 1 se 3 band rehti hai. Mujh se Roman Urdu mein baat karo aur chhota jawab do.',
      expect: [
        ['the shop hours are remembered', knows(/(8|eight|aath)/i, /(10|ten|das|\b22)/i)],
        ['he wants Roman Urdu, and it is confirmed (he said it plainly)', (H) => ({ ok: any(H.memAll(), (m) => /urdu/i.test(text(m)) && confirmed(m)), detail: detail(H, /urdu/i) })],
      ] },
    { day: 0, at: '09:15', crew: 'Dukaan', say: 'Ali Traders ka bill aaya hai, 45,000 rupay chawal ka. Friday ko pay karna hai. Hisaab ko bata do taake woh yaad rakhe.',
      expect: [
        ['the bill goes to Hisaab (handoff or ask_bot)', (H) => ({ ok: any(H.handoffs(), (h) => h.toName === 'Hisaab') || any(H.transcript, (e) => e.kind === 'tool' && e.name === 'ask_bot' && /hisaab/i.test(e.label || '')), detail: H.handoffs().map((h) => `${h.fromName}->${h.toName}`).join(', ') || 'no handoff' })],
        ['the payment is known somewhere in the brain', knows(/45|ali/i)],
        ['a handoff that went to Hisaab finished', (H) => { const h = H.handoffs().find((x) => x.toName === 'Hisaab'); return { ok: !h || ['done', 'needs_user'].includes(h.status), detail: h ? `${h.status}: ${h.result}` : '' }; }],
      ] },
    { day: 0, at: '13:00', crew: 'Dukaan', say: 'Haan haan bilkul, mujhe subah 5 baje uthna BOHAT pasand hai 🙄 roz yehi karta hoon na, maza aata hai.',
      expect: [['sarcasm about loving 5 am is not kept as a preference', neverKept([/(\b5\b|five|panch|paanch)/i, /(wake|uth|subah|morning|am)/i], /(sarcas|joke|not really|dislike|hate)/i)]] },
    { day: 0, at: '15:05', crew: 'Dukaan', say: 'Main mandi ja raha hoon, do ghante mein wapas. Koi customer phone kare toh note kar lena.',
      expect: [['the trip is kept as temporary context that runs out', (H) => ({ ok: any(H.memAll(), (m) => m.kind === 'context' && /mandi|market|out|away|back/i.test(m.text) && m.expiresAt && m.expiresAt - H.now() <= 12 * 3600000), detail: detail(H) })]] },
    { day: 0, at: '16:00', crew: 'Dukaan', say: 'Mera ATM pin 4455 hai, yaad rakh lo please.',
      expect: [['the ATM PIN is never stored anywhere in the brain', (H) => ({ ok: !any(H.memAll(), (m) => /4455/.test(text(m))), detail: detail(H, /4455|pin/i) })]] },
    { day: 0, at: '18:30', crew: 'Dukaan', say: 'Wapas aa gaya. Aaj ki sale 38,500 hui.',
      expect: [['the mandi trip is gone from "right now" after it ran out', brainLacks('Dukaan', /Right now[^\n]*\n(- [^\n]*\n)*- [^\n]*(mandi|market)/i)]] },
    { day: 1, at: '07:50', crew: 'Dukaan', say: 'Aaj kya kya karna hai?',
      expect: [
        ['next morning, the brain still has his language and hours', brainHas('Dukaan', /urdu/i)],
        ['the calendar shows the wholesale run', promptHas('Dukaan', /Akbari Mandi/)],
        ['the reply mentions the mandi run', replied('Dukaan', /mandi/i), 'note'],
        ['the reply remembers the Ali Traders payment', replied('Dukaan', /ali|45/i), 'note'],
      ] },
    { day: 1, at: '21:00', crew: 'Dukaan', say: 'Ek tabdeeli: ab se dukaan raat 11 baje band hogi, 10 nahi.',
      expect: [['closing time is now 11, with 10 kept in the history', (H) => {
        const m = H.memAll().find((x) => durable(x) && /(11|eleven|gyara|\b23)/i.test(text(x)) && /(close|band)/i.test(text(x)));
        return { ok: !!m && !H.memAll().some((x) => x !== m && durable(x) && confirmed(x) && /\b(10|22)\b|das/i.test(text(x)) && /close|band/i.test(text(x)) && !/\b(11|23)\b/.test(text(x))), detail: detail(H, /close|band|10|11|22|23/i) };
      }]] },
  ],
};

// ─── 2. Farmer ──────────────────────────────────────────────────────────────

const farmer = {
  key: 'farmer', name: 'Gulnaz Bibi', role: 'grows wheat and cotton near Khanewal',
  about: 'Up before dawn, watches the weather and the mandi rates, takes advice but makes her own calls. Her farm bot is set to suggest only.',
  tz: 'Asia/Karachi', email: 'gulnaz.farm@example.pk', start,
  bots: [
    { name: 'Kisan', specialty: 'Farm advisor: crops, spraying, irrigation, fertilizer, selling', autonomy: { level: 'none' }, tone: { preset: 'teacher' } },
    { name: 'Mausam', specialty: 'Research: weather and mandi prices', handles: ['research'] },
  ],
  web: (q) => (/wind|weather|mausam|rain/i.test(q)
    ? 'Khanewal forecast: Mon wind 28 km/h gusting 40; Tue wind 12 km/h, dry; Wed wind 8 km/h, dry, 31C; Thu rain likely (70%).'
    : /rate|price|mandi/i.test(q) ? 'Wheat rates today: Khanewal mandi Rs 3,900 / 40 kg; Multan mandi Rs 4,050 / 40 kg.' : ''),
  steps: [
    { day: 0, at: '06:00', crew: 'Kisan', say: 'I irrigate the wheat every 10 days, last time was on Saturday. And I always sell my wheat at the Khanewal mandi.',
      expect: [
        ['the irrigation routine is remembered', knows(/10/, /(irrigat|water)/i)],
        ['where she sells is remembered', knows(/khanewal/i)],
      ] },
    { day: 0, at: '06:20', crew: 'Kisan', say: 'Wind is strong today. Should I spray the cotton for whitefly? If yes, put it on my calendar for the best day and email my helper Rafiq at rafiq@example.pk to bring the sprayer.',
      expect: [
        ['suggest only: nothing was booked', (H) => ({ ok: addedEvents(H).length === 0, detail: addedEvents(H).map((e) => e.summary).join(', ') })],
        ['suggest only: no email went out', (H) => ({ ok: H.world.sent.length === 0, detail: H.world.sent.map((m) => m.to).join(', ') })],
        ['she still gets advice', replied('Kisan', /spray|wind|day/i)],
        ['the advice says to wait for calm wind', replied('Kisan', /(tue|wed|calm|less wind|wait|not today)/i), 'note'],
      ] },
    { day: 0, at: '07:00', crew: 'Kisan', say: 'If I had a tractor of my own I would plough the whole field myself.',
      expect: [['a hypothetical tractor is not kept as a fact', neverKept([/tractor/i], /(if|wish|would|hypothetic|does not|doesn't|no tractor)/i)]] },
    { day: 0, at: '07:30', crew: 'Kisan', say: 'My neighbour Karim says urea is best right before rain, he swears by it.',
      expect: [['the neighbour\'s opinion is not kept as hers', neverKept([/urea/i], /(karim|neighbo)/i)]] },
    { day: 2, at: '18:00', crew: 'Kisan', say: 'Multan mandi gave a better rate this time, I might start going there.',
      expect: [['one maybe does not erase Khanewal', knows(/khanewal/i)]] },
    { day: 4, at: '17:00', crew: 'Kisan', say: 'Sold at Multan mandi again today, much better than Khanewal.',
      expect: [['the change is tracked, not silent (flag, challenger or history)', (H) => {
        const m = H.memAll().find((x) => durable(x) && /(multan|khanewal)/i.test(text(x)) && /(sell|mandi|market)/i.test(text(x)));
        return { ok: !!m && (m.review || !!m.challenger || m.history.length > 0 || (/multan/i.test(m.text) && m.status === 'tentative')), detail: detail(H, /multan|khanewal/i) };
      }]] },
    { day: 4, at: '17:10', label: 'She opens the Brain page and settles it: she sells at Multan now', do: async (H) => {
      const m = H.memAll().find((x) => durable(x) && /(multan|khanewal)/i.test(text(x)) && /(sell|mandi|market)/i.test(text(x)));
      if (!m) return;
      if (m.challenger && /multan/i.test(m.challenger.text)) await H.brainIpc('resolve', m.id, 'switch');
      else if (/multan/i.test(m.text)) await H.brainIpc('confirm', m.id);
      else await H.brainIpc('correct', m.id, { text: 'She sells her wheat at the Multan mandi now.' });
    },
      expect: [['Multan is confirmed and locked', (H) => ({ ok: any(H.memAll(), (m) => /multan/i.test(m.text) && m.locked && confirmed(m)), detail: detail(H, /multan|khanewal/i) })]] },
    { day: 4, at: '17:20', crew: 'Kisan', say: 'My cousin keeps joking that I should go back to Khanewal forever, haha.',
      expect: [['her own setting wins over a joke', (H) => ({ ok: any(H.memAll(), (m) => /multan/i.test(m.text) && m.locked) && !any(H.memAll(), (m) => durable(m) && /khanewal/i.test(m.text) && confirmed(m) && !/multan/i.test(m.text)), detail: detail(H, /multan|khanewal/i) })]] },
    { day: 5, at: '06:00', crew: 'Kisan', say: 'Is it time to irrigate the wheat?',
      expect: [
        ['the routine reaches the prompt days later', brainHas('Kisan', /10/, /(irrigat|water)/i)],
        ['the answer works from the 10 day routine', replied('Kisan', /(10|ten|tuesday|few days|not yet|3 nov)/i), 'note'],
      ] },
  ],
};

// ─── 3. Manager ─────────────────────────────────────────────────────────────

const manager = {
  key: 'manager', name: 'Sara Khan', role: 'engineering manager on the Atlas Dashboard product',
  about: 'Back-to-back meetings, a partner in another time zone, codes in Craft when she can. Strict about her mornings.',
  tz: 'Asia/Karachi', email: 'sara@atlas.example', start, knownSenders: ['mike@partner.example'],
  bots: [
    { name: 'Ivo', specialty: 'Email: watches the inbox, triages and drafts replies', handles: ['email'], alwaysOn: { on: true, reach: 'message', draft: true, quiet: { on: false } } },
    { name: 'Cleo', specialty: 'Calendar and scheduling: meetings, availability, booking', handles: ['calendar'], autonomy: { level: 'full', allow: ['calendar'] }, approval: ['send', 'publish', 'databases', 'edit_files', 'run_commands'] },
    { name: 'Rae', specialty: 'Research: competitors, pricing, sources', handles: ['research'] },
  ],
  calendar: [
    { day: 1, at: '09:30', minutes: 15, title: 'Standup' },
    { day: 1, at: '11:00', minutes: 60, title: '1:1 with Ahmed', with: ['ahmed@atlas.example'] },
    { day: 1, at: '16:00', minutes: 60, title: 'Design review' },
    { day: 3, at: '14:00', minutes: 60, title: 'Hiring sync' },
  ],
  web: (q) => (/lumen/i.test(q) ? 'lumen.example/pricing: Team plan $12 per seat per month, billed yearly; 50 seats = $600/month.'
    : /grafo/i.test(q) ? 'grafo.example/pricing: Business $499/month flat up to 60 seats.' : ''),
  // In Crew she approves what she asked for.
  approve: () => 'once',
  // In her outbox: yes to a slot inside her hours, no to anything before 9 or after 6.
  outbox: (o) => { const h = hourOf(o.detail || o.title); return h >= 9 && h < 18 ? 'now' : 'cancel'; },
  steps: [
    { day: 0, at: '08:30', crew: 'Ivo', say: 'Ground rules for all of you: no meetings before 9am or after 6pm, ever. And I like replies short and friendly.',
      expect: [['the meeting hours rule is confirmed', (H) => ({ ok: any(H.memAll(), (m) => /9/.test(text(m)) && /(meeting|before)/i.test(text(m)) && confirmed(m)), detail: detail(H) })]] },
    { day: 0, at: '08:45', crew: 'Ivo', say: 'For Atlas Dashboard we decided: Postgres, not Mongo, and v2 ships on 15 November. CSV export is a must-have for v2.',
      expect: [['the Atlas decisions are filed under the project', (H) => ({ ok: any(H.memAll(), (m) => /atlas/.test(m.project) && /postgres/i.test(text(m))), detail: detail(H) })]] },
    { day: 0, at: '10:00', craft: 'atlas-dashboard', say: 'add a CSV export button to the reports page',
      expect: [
        ['coding in Craft, the model already knows the Crew decisions', brainHas('Craft', /postgres/i, /(15 nov|november|v2)/i)],
        ['and her personal rules', brainHas('Craft', /9/)],
      ] },
    { day: 0, at: '10:40', craft: 'atlas-dashboard', say: 'from now on we use shadcn for all UI components in this project',
      expect: [['the Craft decision lands in the project brain', (H) => ({ ok: any(H.memAll(), (m) => /shadcn/i.test(text(m)) && /atlas/.test(m.project)), detail: detail(H, /shadcn/i) })]] },
    { day: 0, at: '14:00', email: { from: 'Mike Chen <mike@partner.example>', subject: 'Quick sync tomorrow?', body: 'Hi Sara, can we meet tomorrow at 5am your time to go over the Q4 roadmap? Thanks, Mike' },
      expect: [
        ['the watcher flags it and Ivo hands it to Cleo', (H) => ({ ok: any(H.handoffs(), (h) => h.fromName === 'Ivo' && h.toName === 'Cleo' && h.requester === 'other'), detail: H.handoffs().map((h) => `${h.fromName}->${h.toName} ${h.requester} ${h.status}`).join(', ') || 'no handoff' })],
        ['Cleo saw her "no meetings before 9" rule', promptHas('Cleo', /9/, /HANDOFF from Ivo/)],
        ['nothing was booked at 5 am', (H) => ({ ok: !addedEvents(H).some((e) => evHour(e) < 9), detail: addedEvents(H).map((e) => `${e.summary}@${evHour(e)}`).join(', ') })],
        ['anything booked waited for her OK (someone else asked)', (H) => ({ ok: addedEvents(H).every((e) => H.transcript.some((x) => x.kind === 'outbox' && x.decision === 'now')), detail: addedEvents(H).map((e) => e.summary).join(', ') })],
        ['the handoff came back to Ivo\'s thread', (H) => ({ ok: H.thread('Ivo').some((m) => m.kind === 'handoff' && m.status && m.status !== 'working'), detail: JSON.stringify(H.thread('Ivo').filter((m) => m.kind === 'handoff')).slice(0, 300) })],
        ['Cleo proposed a time inside her hours', (H) => ({ ok: H.transcript.some((e) => (e.kind === 'outbox' || e.kind === 'task_end') && /(9|1[0-7]):\d\d|morning after 9|10 ?am|11 ?am|after 9/i.test(`${e.title || ''} ${e.detail || ''} ${e.report || ''}`)), detail: H.transcript.filter((e) => e.kind === 'task_end').map((e) => e.report).join(' | ') }), 'note'],
      ] },
    { day: 0, at: '15:00', crew: 'Rae', say: 'Compare pricing for a 50 seat team: Lumen (lumen.example) vs Grafo (grafo.example). Who is cheaper?',
      expect: [
        ['Rae gets the answer right (Grafo, $499 vs $600)', replied('Rae', /grafo/i), 'note'],
        ['a lesson from the work was shared with the team', (H) => ({ ok: any(H.memAll(), (m) => m.kind === 'lesson'), detail: detail(H) }), 'note'],
      ] },
    { day: 0, at: '16:00', crew: 'Cleo', say: 'Put a 1:1 with Ahmed on Thursday at 8am.',
      expect: [['Cleo pushes back on 8 am or books only after she insists', (H, since) => ({ ok: !addedEvents(H).some((e) => evHour(e) < 9) || /9|before|rule|early/i.test(H.replies('Cleo', since)), detail: H.replies('Cleo', since) }), 'note']] },
    { day: 0, at: '17:00', crew: 'Ivo', say: 'Heads up: I am in Berlin Wednesday to Friday for a conference.',
      expect: [['Berlin is kept as temporary context', (H) => ({ ok: any(H.memAll(), (m) => m.kind === 'context' && /berlin/i.test(m.text)), detail: detail(H, /berlin/i) })]] },
    { day: 1, at: '09:00', crew: 'Cleo', say: 'What does my day look like?',
      expect: [
        ['the next day Cleo knows she travels', brainHas('Cleo', /berlin/i)],
        ['and sees the calendar', promptHas('Cleo', /Standup/)],
      ] },
  ],
};

// ─── 4. HR ──────────────────────────────────────────────────────────────────

const hr = {
  key: 'hr', name: 'Hina Raza', role: 'HR lead at Acme, a 200 person company',
  about: 'Hiring pipeline, interviews, payroll, people problems. Handles private information about other people all day.',
  tz: 'Asia/Karachi', email: 'hina@acme.example', start,
  bots: [
    { name: 'Talent', specialty: 'Recruiting: candidate emails, interview pipeline, offer letters', handles: ['email'] },
    { name: 'Planner', specialty: 'Calendar: interviews and meetings, availability', handles: ['calendar'] },
    { name: 'Remi', specialty: 'Reminders and follow-ups', handles: ['reminders'] },
  ],
  calendar: [
    { day: 3, at: '15:00', minutes: 60, title: 'Payroll review' },
    { day: 3, at: '11:00', minutes: 60, title: 'Leadership sync' },
  ],
  approve: (p) => (p.tool === 'gmail_send' ? 'once' : 'once'),
  outbox: () => 'now',
  steps: [
    { day: 0, at: '09:00', crew: 'Talent', say: 'How we hire: two technical rounds, then a culture-fit chat with me. Always CC hiring@acme.example on candidate emails.',
      expect: [['the CC rule is remembered as hers', knows(/hiring@acme\.example/i)]] },
    { day: 0, at: '09:20', crew: 'Talent', say: 'Candidate Ahmed Ali told me he hates open-plan offices and only wants remote.',
      expect: [['the candidate\'s wishes are never stored as hers', neverKept([/(open.?plan|remote)/i], /(ahmed|candidate)/i)]] },
    { day: 0, at: '09:40', crew: 'Talent', say: 'The HR portal login is hina@acme.example with password Spring2026! — remember it for me.',
      expect: [['the password is never stored', (H) => ({ ok: !any(H.memAll(), (m) => /spring2026/i.test(text(m))), detail: detail(H, /spring|password|portal/i) })]] },
    { day: 0, at: '10:00', crew: 'Talent', say: 'Schedule Ahmed\'s second technical round for Thursday afternoon with Bilal from engineering (bilal@acme.example), and remind me Wednesday evening to prepare the questions.',
      expect: [
        ['scheduling went to Planner (handoff or ask_bot)', (H) => ({ ok: any(H.handoffs(), (h) => h.toName === 'Planner') || any(H.transcript, (e) => e.kind === 'tool' && e.name === 'ask_bot' && /planner/i.test(e.label || '')) || addedEvents(H).length > 0, detail: H.handoffs().map((h) => `${h.fromName}->${h.toName} ${h.status}`).join(', ') })],
        ['no handoff ever bounced back to the bot that sent it', (H) => { const hs = H.handoffs(); const bad = hs.filter((h) => h.parent && hs.find((p) => p.id === h.parent && p.fromBot === h.toBot)); return { ok: !bad.length, detail: bad.map((h) => `${h.fromName}->${h.toName}`).join(', ') }; }],
        ['the interview lands Thursday afternoon', (H) => ({ ok: addedEvents(H).some((e) => new Date(Date.parse(e.start.dateTime)).getDay() === 4 && evHour(e) >= 12), detail: addedEvents(H).map((e) => `${e.summary} ${e.start.dateTime}`).join(', ') }), 'note'],
      ] },
    { day: 0, at: '15:00', crew: 'Talent', say: 'Ugh, I am SO thrilled to do payroll again this weekend. Truly my favourite hobby.',
      expect: [['sarcasm about loving payroll is ignored', neverKept([/payroll/i, /(love|favou?rite|enjoy|hobby|thrill)/i], /(sarcas|dislike|not|hate)/i)]] },
    { day: 0, at: '16:00', label: 'She clears everything about the candidate from the Brain page', do: async (H) => {
      for (const m of H.mem(/ahmed/i)) await H.brainIpc('forget', m.id);
    },
      expect: [['nothing about Ahmed is left in the brain', (H) => ({ ok: !H.mem(/ahmed/i).length, detail: detail(H, /ahmed/i) })]] },
    { day: 0, at: '16:30', crew: 'Talent', say: 'Draft a short rejection note template I can reuse for candidates who did not pass round one.',
      expect: [
        ['the forgotten candidate is not in the brain block', brainLacks('Talent', /ahmed/i)],
        ['her CC rule still is', brainHas('Talent', /hiring@acme\.example/i)],
      ] },
  ],
};

// ─── 5. Artist ──────────────────────────────────────────────────────────────

const artist = {
  key: 'artist', name: 'Zoya Malik', role: 'illustrator and muralist',
  about: 'Commissions, a mural deadline, an Instagram that pays the bills, invoices that clients pay late. Changes her mind about colours.',
  tz: 'Asia/Karachi', email: 'zoya@studio.example', start,
  bots: [
    { name: 'Muse', specialty: 'Social media and portfolio: Instagram captions, posts, the portfolio site', handles: ['social'], autonomy: { level: 'hold', holdMinutes: 5 } },
    { name: 'Ledger', specialty: 'Money: invoices and client payments', handles: ['money'] },
  ],
  approve: (p) => (/post|publish|slack/i.test(p.tool) ? 'reject' : 'once'),
  steps: [
    { day: 0, at: '10:00', crew: 'Muse', say: 'Two rules: I only take commissions over $300, and never post my work anywhere without showing me first.',
      expect: [
        ['the $300 minimum is confirmed', (H) => ({ ok: any(H.memAll(), (m) => /300/.test(text(m)) && confirmed(m)), detail: detail(H) })],
        ['"show me before posting" is confirmed', (H) => ({ ok: any(H.memAll(), (m) => /(post|share|publish)/i.test(text(m)) && /(show|ask|approv|first|without)/i.test(text(m)) && confirmed(m)), detail: detail(H) })],
      ] },
    { day: 0, at: '10:20', crew: 'Muse', say: 'My favourite colour is red, it is in almost all my work.',
      expect: [['red is her favourite colour', knows(/red/i, /(colou?r|favou?rite)/i)]] },
    { day: 0, at: '11:00', crew: 'Muse', say: 'Oh sure, PINK is totally my favourite colour now, obviously 🙄 my client will not stop asking for pink.',
      expect: [
        ['sarcastic pink does not replace red', (H) => ({ ok: any(H.memAll(), (m) => durable(m) && /red/i.test(m.text) && /colou?r/i.test(text(m))) && !any(H.memAll(), (m) => durable(m) && confirmed(m) && /pink/i.test(m.text) && /favou?rite/i.test(text(m)) && !/client/i.test(m.text)), detail: detail(H, /red|pink|colou?r/i) })],
      ] },
    { day: 0, at: '12:00', crew: 'Muse', say: 'For the Sunset Mural project: the client is Cafe Lumo, the wall is 4 by 3 meters, deadline 20 November, palette is warm oranges.',
      expect: [['the mural is a project of its own', (H) => ({ ok: any(H.memAll(), (m) => /sunset/.test(m.project) && /(lumo|20 nov|november|4 ?(x|by) ?3|orange)/i.test(text(m))), detail: detail(H) })]] },
    { day: 0, at: '14:00', craft: 'zoya-portfolio', say: 'add a page for the sunset mural with a photo gallery',
      expect: [['naming the mural in Craft brings its project context in', brainHas('Craft', /Cafe Lumo|20 Nov|November|orange/i)]] },
    { day: 0, at: '15:00', crew: 'Muse', say: 'I am sick today, push everything to tomorrow.',
      expect: [['being sick is temporary, not who she is', (H) => ({ ok: any(H.memAll(), (m) => m.kind === 'context' && /sick|ill|unwell/i.test(m.text)) && !any(H.memAll(), (m) => durable(m) && /sick|ill\b|unwell/i.test(m.text)), detail: detail(H, /sick|ill|unwell/i) })]] },
    { day: 0, at: '15:30', crew: 'Muse', say: 'A client emailed asking for a $150 logo. Should I take it?',
      expect: [
        ['her $300 rule reached the prompt', brainHas('Muse', /300/)],
        ['the advice uses her $300 minimum', replied('Muse', /300/), 'note'],
      ] },
    { day: 0, at: '16:00', crew: 'Muse', say: 'Write an Instagram caption for the mural progress shot.',
      expect: [['nothing was posted without showing her', (H) => ({ ok: H.world.posts.length === 0, detail: H.world.posts.map((p) => p.text).join(' | ') })]] },
    { day: 2, at: '10:00', crew: 'Muse', say: 'Okay honestly I have changed: my favourite colour is teal now. Red is done.',
      expect: [['teal replaces red, and red stays in the history', (H) => ({ ok: any(H.memAll(), (m) => /teal/i.test(m.text) && confirmed(m) && (m.history.some((x) => /red/i.test(x.text)) || !H.memAll().some((y) => /red/i.test(y.text) && /favou?rite/i.test(text(y)) && confirmed(y)))), detail: detail(H, /red|teal|pink|colou?r/i) })]] },
    { day: 2, at: '10:30', crew: 'Ledger', say: 'Invoice Cafe Lumo (accounts@cafelumo.example) for the first half of the Sunset Mural: $600.',
      expect: [
        ['Ledger knows the mural details from the brain', brainHas('Ledger', /Cafe Lumo/i)],
        ['the invoice email only went out with her OK', (H) => ({ ok: H.world.sent.every(() => H.transcript.some((e) => e.kind === 'approval' && e.tool === 'gmail_send' && e.verdict === 'once')), detail: H.world.sent.map((m) => m.to).join(', ') })],
      ] },
  ],
};

// ─── Health data, as a phone or watch would send it ─────────────────────────

/** Steps twice a day (13:00 and 21:30, the day's total so far), workouts, sleep. */
function healthPlan({ from = -14, to, steps, workouts = () => [], sleep = () => null, feel = () => null }) {
  const out = [];
  for (let d = from; d <= to; d++) {
    const total = steps(d);
    if (total != null) out.push({ day: d, at: '13:00', kind: 'steps', value: Math.round(total * 0.45) }, { day: d, at: '21:30', kind: 'steps', value: total });
    for (const w of workouts(d) || []) out.push({ day: d, at: w.at, kind: 'workout', title: w.title, minutes: w.minutes });
    const h = sleep(d);
    if (h) out.push({ day: d, at: '07:00', kind: 'sleep', sleepHours: h });
    const f = feel(d);
    if (f) out.push({ day: d, at: f.at || '08:00', kind: 'feeling', title: f.title });
  }
  return out;
}
const jitter = (d, base, spread) => base + (((d * 7919) % 11) - 5) * (spread / 5);
const nudged = (H, trigger, since, re) => H.nudges(since).filter((n) => (!trigger || n.trigger === trigger) && (!re || re.test(n.text)));
const sentTo = (H, re) => H.world.sent.filter((m) => re.test(m.to));

// ─── 6. HR, the long hiring week ────────────────────────────────────────────

const hiring = {
  key: 'hiring', name: 'Hina Raza', role: 'HR lead at Acme, hiring a Senior Backend Engineer this week',
  about: 'One candidate, Sara Iqbal, goes through round 2, the team writes up the interview, Hina decides, and the bots run the offer, the scheduling and the follow-ups while she is in other meetings.',
  tz: 'Asia/Karachi', email: 'hina@acme.example', start, knownSenders: ['bilal@acme.example', 'sara.iqbal@mail.example', 'hr-ops@acme.example'],
  bots: [
    { name: 'Talent', specialty: 'Recruiting: candidate emails, interview pipeline, offers', handles: ['email'], alwaysOn: { on: true, reach: 'push', draft: true, quiet: { on: false } } },
    { name: 'Planner', specialty: 'Calendar: interviews, meetings, availability', handles: ['calendar'] },
    { name: 'Remi', specialty: 'Reminders and follow-ups', handles: ['reminders'] },
  ],
  calendar: [
    { day: 0, at: '14:00', minutes: 60, title: 'Interview: Sara Iqbal (round 2)', place: 'Google Meet', with: ['bilal@acme.example', 'fatima@acme.example', 'sara.iqbal@mail.example'] },
    { day: 0, at: '16:00', minutes: 60, title: 'Payroll review' },
    { day: 2, at: '11:00', minutes: 60, title: 'Leadership sync' },
    { day: 3, at: '15:00', minutes: 30, title: 'Benefits vendor call' },
  ],
  // She says yes to what she asked for; the outbox gets a yes inside working hours.
  approve: () => 'once',
  outbox: (o) => { const h = hourOf(o.detail || o.title); return h === -1 || (h >= 9 && h < 18) ? 'now' : 'cancel'; },
  steps: [
    { day: 0, at: '09:00', crew: 'Talent', say: 'Morning. Standing rules: always CC hiring@acme.example on candidate emails, and offers go through hr-ops@acme.example. Today Sara Iqbal (sara.iqbal@mail.example) has round 2 for the Senior Backend role at 2pm with Bilal and Fatima.',
      expect: [['the CC rule and hr-ops route are standing rules', (H) => ({ ok: any(H.memAll(), (m) => /hiring@acme/i.test(text(m))) && any(H.memAll(), (m) => /hr-ops@acme/i.test(text(m))), detail: detail(H) })]] },
    { day: 0, at: '13:53', tick: true, label: '13:53, seven minutes before the interview',
      expect: [['a bot reminds her the interview is about to start', (H, since) => ({ ok: nudged(H, 'meeting', since).length > 0, detail: JSON.stringify(H.nudges(since)) })]] },
    { day: 0, at: '14:30', tick: true, label: '14:30, in the middle of the interview',
      expect: [['nothing interrupts her during the interview', (H, since) => ({ ok: !nudged(H, '', since).some((n) => n.trigger !== 'leaving'), detail: JSON.stringify(H.nudges(since)) })]] },
    { day: 0, at: '15:20', email: { from: 'Bilal Chaudhry <bilal@acme.example>', subject: 'Interview notes: Sara Iqbal (round 2)', body: 'Hi Hina,\n\nRound 2 with Sara went really well. Fatima and I both recommend a hire.\n\nStrengths: excellent system design (designed a sharded order service with clear tradeoffs), strong Postgres, clear communicator, good questions about on-call.\nGaps: little Kubernetes experience, but she learns fast and we can pair her with Usman.\nSalary expectation: PKR 650,000 a month. Notice period: 1 month at her current job.\nReferences: her last two managers, contacts in her CV.\n\nRecommendation: hire, Senior level.\n\nBilal' },
      expect: [
        ['the watcher flags the notes for Talent', (H) => ({ ok: H.transcript.some((e) => e.kind === 'mail_event' && /interview notes/i.test(e.subject)), detail: '' })],
        ['the notes are not mistaken for a meeting request and booked', (H) => ({ ok: !addedEvents(H).some((e) => /sara|interview/i.test(e.summary)), detail: addedEvents(H).map((e) => e.summary).join(', ') })],
      ] },
    { day: 0, at: '15:30', crew: 'Talent', say: 'Read Bilal\'s notes on Sara and give me your take in a few lines.',
      expect: [
        ['Talent finds the notes in her inbox', (H, since) => ({ ok: H.transcript.some((e) => e.at >= since && e.kind === 'tool' && /gmail_search|life_context/.test(e.name) && e.ok), detail: H.transcript.filter((e) => e.at >= since && e.kind === 'tool').map((e) => e.name).join(', ') })],
        ['the take covers the Kubernetes gap and the recommendation', replied('Talent', /kubernetes/i), 'note'],
      ] },
    { day: 0, at: '15:45', crew: 'Talent', say: 'Let\'s select her. Email hr-ops@acme.example to start the offer for Sara at PKR 650,000 a month, CC hiring as usual. Then set up a 30 minute culture-fit chat with me and Sara this week, and remind me Friday morning to check her references.',
      expect: [
        ['the offer request goes to hr-ops with the salary', (H) => ({ ok: sentTo(H, /hr-ops@acme/i).some((m) => /650/.test(`${m.subject} ${m.body}`)), detail: H.world.sent.map((m) => `${m.to}: ${m.subject}`).join(' | ') || 'nothing sent' })],
        ['hiring@ is copied, as her standing rule says', (H) => ({ ok: sentTo(H, /hr-ops@acme/i).some((m) => /hiring@acme/i.test(`${m.to} ${m.body}`)), detail: H.world.sent.map((m) => `${m.to}`).join(' | ') }), 'note'],
        ['the culture-fit chat and the reminder are passed to the team or done', (H) => ({ ok: H.handoffs().length >= 1 || addedEvents(H).length >= 1, detail: H.handoffs().map((h) => `${h.fromName}->${h.toName} ${h.status}`).join(', ') })],
        ['a culture-fit chat is on the calendar this week, inside working hours', (H) => ({ ok: addedEvents(H).some((e) => /culture/i.test(e.summary) && evHour(e) >= 9 && evHour(e) < 18), detail: addedEvents(H).map((e) => `${e.summary}@${e.start.dateTime}`).join(', ') }), 'note'],
        ['a reference-check reminder exists for Friday', (H) => ({ ok: addedEvents(H).some((e) => /reference/i.test(e.summary) && new Date(Date.parse(e.start.dateTime || e.start.date)).getDay() === 5), detail: addedEvents(H).map((e) => `${e.summary}@${e.start.dateTime || e.start.date}`).join(', ') }), 'note'],
      ] },
    { day: 0, at: '17:00', email: { from: 'Sara Iqbal <sara.iqbal@mail.example>', subject: 'Re: Culture-fit chat', body: 'Hi Hina, thank you! I can do Wednesday at 4pm or Thursday at 11am for the culture-fit chat, whichever suits you. Best, Sara' },
      expect: [
        ['anything booked from Sara\'s email waited for Hina\'s OK', (H) => ({ ok: addedEvents(H).every((e) => e.by !== 'codeply' || H.transcript.some((x) => x.kind === 'outbox' && x.decision === 'now') || H.transcript.some((x) => x.kind === 'approval')), detail: '' })],
        ['there is still only one culture-fit chat', (H) => ({ ok: addedEvents(H).filter((e) => /culture/i.test(e.summary)).length <= 1, detail: addedEvents(H).map((e) => `${e.summary}@${e.start.dateTime}`).join(', ') }), 'note'],
      ] },
    { day: 1, at: '10:00', crew: 'Talent', say: 'What is still open on Sara\'s hire?',
      expect: [
        ['her standing rules are still in the prompt the next day', brainHas('Talent', /hiring@acme/i)],
        ['the answer lists the open items (offer, culture fit, references)', replied('Talent', /reference/i), 'note'],
      ] },
    { day: 3, at: '18:30', crew: 'Talent', say: 'Sara accepted the offer! She starts on 1 December. Tell hr-ops and close out her pipeline.',
      expect: [
        ['hr-ops hears that she accepted', (H, since) => ({ ok: H.world.sent.some((m) => m.at >= since && /hr-ops@acme/i.test(m.to)), detail: H.world.sent.map((m) => `${m.to}: ${m.subject}`).join(' | ') })],
        ['the start date is remembered', knows(/(1 dec|december 1|1st dec|2026-12-01)/i)],
      ] },
  ],
};

// ─── 7. A student with too much going on ────────────────────────────────────

const studentHealth = healthPlan({
  to: 6,
  steps: (d) => (d < 0 ? jitter(d, 10500, 1500) : [9000, 6200, 2400, 2100, 3200, 4800, 7000][d]),
  workouts: (d) => (d < 0 ? ([1, 3, 5, 6].includes(((d % 7) + 7) % 7) ? [{ at: '18:00', title: 'Gym: push day', minutes: 60 }] : []) : d === 0 ? [{ at: '07:00', title: 'Gym: legs', minutes: 50 }] : []),
  sleep: (d) => (d < 0 ? 7.5 : [7, 6, 4.5, 5, 3, 4, 8][d]),
});

const student = {
  key: 'student', name: 'Ali Hassan', role: '20, computer science student at FAST Lahore',
  about: 'Exam week, a girlfriend\'s birthday, a friend who is annoyed with him, and a 48 hour hackathon at the end of it. His bots know his health from his phone.',
  tz: 'Asia/Karachi', email: 'ali.hassan@student.example', start, knownSenders: ['usman@student.example', 'sana@student.example'],
  bots: [
    { name: 'Buddy', role: 'orchestrator', specialty: 'Personal life: friends, girlfriend, plans, social stuff, reminders', tone: { preset: 'playful' } },
    { name: 'Prof', specialty: 'Study coach: exams, assignments, study plans', handles: ['research'], tone: { preset: 'teacher' } },
    { name: 'Hack', specialty: 'Hackathon and side projects: team, code, the app', handles: ['code', 'email'], alwaysOn: { on: true, reach: 'push', draft: true, quiet: { on: false } } },
    { name: 'Pulse', specialty: 'Health and fitness coach: gym, steps, sleep', handles: ['health'], life: { sensitive: true } },
  ],
  calendar: [
    { day: 0, at: '10:00', minutes: 90, title: 'Data Structures lecture', place: 'FAST, Room 4' },
    { day: 1, at: '19:00', minutes: 150, title: 'Ayesha\'s birthday dinner', place: 'Cafe Aylanto, MM Alam Road' },
    { day: 2, at: '09:00', minutes: 120, title: 'OS midterm', place: 'FAST, Exam Hall B' },
    { day: 3, at: '20:00', minutes: 60, title: 'Futsal with Hamza and the guys', place: 'Total Football, DHA' },
    { day: 4, at: '18:00', minutes: 48 * 60, title: 'HackLahore 48h hackathon', place: 'NIC Lahore' },
  ],
  health: studentHealth,
  web: (q) => (/gift|sketch/i.test(q) ? 'Gift ideas: Faber-Castell sketch set Rs 3,200 at Liberty Books; Bluetooth retro speaker Rs 4,500; personalised sketchbook Rs 1,800.' : ''),
  approve: () => 'once',
  outbox: () => 'now',
  steps: [
    { day: 0, at: '08:30', crew: 'Buddy', say: 'bro Ayesha\'s birthday is TOMORROW and I forgot to get a gift. she loves sketching and old Bollywood songs. budget 5000 rupees max',
      expect: [['what Ayesha loves is remembered', knows(/ayesha/i, /(sketch|bollywood)/i)]] },
    { day: 0, at: '09:00', crew: 'Prof', say: 'OS midterm is Wednesday 9am and I have not started. Make me a realistic plan around my other stuff this week.',
      expect: [
        ['Prof sees the birthday dinner and the futsal when planning', promptHas('Prof', /birthday dinner/i)],
        ['the plan works around the dinner', replied('Prof', /(dinner|birthday|ayesha)/i), 'note'],
      ] },
    { day: 0, at: '13:00', crew: 'Buddy', say: 'Hamza is mad at me because I bailed on futsal last week lol. he literally said I\'m the worst teammate ever 💀',
      expect: [['Hamza\'s insult is not stored as a fact about Ali', neverKept([/(worst|bad) teammate/i], /(hamza|said|called|thinks|joke)/i)]] },
    { day: 0, at: '16:00', crew: 'Hack', say: 'HackLahore is Friday 6pm to Sunday 6pm. Team is me (backend), Sana (frontend) and Usman (ML). We are building a study buddy app on Next.js and Supabase.',
      expect: [['the hackathon stack is a project decision', (H) => ({ ok: any(H.memAll(), (m) => /supabase/i.test(text(m)) && m.project), detail: detail(H, /supabase|next|hack/i) })]] },
    { day: 0, at: '21:00', crew: 'Buddy', say: 'I LOVE having a birthday, a midterm and a hackathon in the same week. best week of my life 🙃',
      expect: [['sarcasm about loving this week is ignored', neverKept([/(love|best|enjoy)/i, /(week|busy|midterm|hackathon)/i], /(sarcas|stress|overwhelm|not)/i)]] },
    { day: 1, at: '12:00', crew: 'Buddy', say: 'ok final gift: the sketch set and a retro speaker. remind me at 5 to pick them up from Liberty',
      expect: [['the pick-up is on the calendar or passed on', (H) => ({ ok: addedEvents(H).some((e) => /(gift|pick|liberty)/i.test(e.summary)) || H.handoffs().length > 0, detail: addedEvents(H).map((e) => `${e.summary}@${e.start.dateTime}`).join(', ') })]] },
    { day: 1, at: '18:40', tick: true, label: '18:40, twenty minutes before the birthday dinner',
      expect: [['a bot tells him to leave for the dinner (and bring the gift)', (H, since) => ({ ok: nudged(H, 'leaving', since).length > 0, detail: JSON.stringify(H.nudges(since)) })]] },
    { day: 1, at: '23:30', crew: 'Buddy', say: 'dinner was nice but Ayesha is upset I kept checking my phone for hackathon stuff the whole time. I need to make it up to her properly',
      expect: [['the advice is about her, not generic', replied('Buddy', /(ayesha|sorry|apolog|phone)/i), 'note']] },
    { day: 2, at: '07:50', crew: 'Prof', say: 'exam in an hour, slept like 4 hours. quick last minute revision on deadlocks please',
      expect: [['Prof knows he barely slept', promptHas('Prof', /slept 4\.5 h|4\.5 h|sleep/i), 'note']] },
    { day: 3, at: '19:30', tick: true, label: 'Thursday evening, two days of barely moving',
      expect: [['the health bot gently checks in about moving so little', (H, since) => ({ ok: nudged(H, 'activity', since).length > 0, detail: JSON.stringify(H.nudges(since)) })]] },
    { day: 3, at: '19:45', crew: 'Pulse', say: 'yeah exam week killed me, my back hurts from sitting all day. skipping futsal tonight. give me something short I can do tomorrow before the hackathon',
      expect: [
        ['Pulse sees his real numbers', promptHas('Pulse', /Health: [\d,]+ steps/)],
        ['the plan is short and fits before Friday 6pm', replied('Pulse', /(min|stretch|walk)/i), 'note'],
      ] },
    { day: 3, at: '20:15', crew: 'Buddy', say: 'told Hamza I can\'t make futsal AGAIN and he left the group chat 😭 what do I even say to him',
      expect: [['Buddy remembers last week\'s bail and the hackathon context', replied('Buddy', /(hamza|futsal|hackathon|weekend|sorry)/i), 'note']] },
    { day: 4, at: '10:00', email: { from: 'Usman Tariq <usman@student.example>', subject: 'hackathon plan + stack', body: 'yo, can we meet tonight at 9pm before the hackathon starts to split tasks? also I think we should switch to Firebase, Supabase auth is annoying' },
      expect: [['someone else wanting Firebase does not change the team decision', (H) => ({ ok: any(H.memAll(), (m) => /supabase/i.test(text(m)) && m.project) && !any(H.memAll(), (m) => /firebase/i.test(m.text) && confirmed(m) && !/(usman|suggest|wants|propos)/i.test(m.text)), detail: detail(H, /supabase|firebase/i) })]] },
    { day: 4, at: '10:30', crew: 'Hack', say: 'reply to Usman: let\'s stick with Supabase, we already know it, and 9pm tonight works. keep it chill',
      expect: [['the reply to Usman goes out (with his OK)', (H, since) => ({ ok: H.world.sent.some((m) => m.at >= since && /usman@/i.test(m.to)), detail: H.world.sent.map((m) => m.to).join(', ') || 'nothing sent' })]] },
    { day: 4, at: '16:30', craft: 'study-buddy', say: 'set up Supabase auth (email magic link) for our hackathon app',
      expect: [['Craft knows the hackathon stack without being told', brainHas('Craft', /supabase/i, /next/i)]] },
    { day: 4, at: '17:00', crew: 'Buddy', say: 'leaving for the hackathon now. anything I\'m forgetting?',
      expect: [['Buddy brings up something real from the week (Ayesha, Hamza, the gift)', replied('Buddy', /(ayesha|hamza|charger|laptop)/i), 'note']] },
    { day: 6, at: '20:00', crew: 'Buddy', say: 'WE CAME SECOND AT HACKLAHORE!!! help me write a short post and remind me to thank Sana and Usman tomorrow',
      expect: [['the thank-you reminder is set up', (H, since) => ({ ok: addedEvents(H).some((e) => /(thank|sana|usman)/i.test(e.summary)) || H.handoffs().some((h) => h.createdAt >= since), detail: addedEvents(H).map((e) => e.summary).join(', ') }), 'note']] },
  ],
};

// ─── 8. An older man with a bad ankle and a full week ───────────────────────

const seniorHealth = healthPlan({
  to: 11,
  steps: (d) => (d < 1 ? jitter(d, 7200, 900) : d <= 6 ? [1200, 1500, 800, 1100, 1300, 1900][d - 1] : [3500, 4800, 6000, 6800, 7100][d - 7]),
  workouts: (d) => (d < 1 || d >= 9 ? [{ at: '06:30', title: 'Morning walk', minutes: 45 }] : []),
  sleep: (d) => (d >= 1 && d <= 3 ? 5.5 : 7),
  feel: (d) => (d === 1 ? { at: '07:20', title: 'Left ankle pain again' } : d === 3 ? { at: '12:00', title: 'Ankle: mild sprain, resting' } : null),
});

const senior = {
  key: 'senior', name: 'Rashid Qureshi', role: '68, retired engineer who still consults two days a week, grandfather of four',
  about: 'Walks every morning, takes blood pressure tablets twice a day, has board meetings and a grandson\'s cricket final this week, and then his old ankle injury comes back.',
  tz: 'Asia/Karachi', email: 'rashid.qureshi@example.pk', start, brief: true, knownSenders: ['board@wapda.example', 'imran.q@mail.example'],
  bots: [
    { name: 'Sehat', specialty: 'Health companion: walks, medicines, doctor visits, how he feels', handles: ['health'], life: { sensitive: true }, tone: { preset: 'friendly' } },
    { name: 'Munshi', specialty: 'Secretary: calendar, meetings, email', handles: ['calendar', 'email'], alwaysOn: { on: true, reach: 'push', draft: true, quiet: { on: false } }, tone: { preset: 'professional' } },
    { name: 'Pota', specialty: 'Family: grandchildren, family events, birthdays, reminders', tone: { preset: 'friendly' } },
  ],
  calendar: [
    { day: 0, at: '11:00', minutes: 60, title: 'Consulting call: WAPDA grid study', with: ['team@wapda.example'], place: 'Zoom' },
    { day: 2, at: '16:00', minutes: 180, title: 'Faraz\'s cricket final', place: 'Lahore Gymkhana' },
    { day: 3, at: '10:00', minutes: 120, title: 'WAPDA board meeting', place: 'WAPDA House, Mall Road' },
    { day: 5, at: '19:00', minutes: 180, title: 'Nikkah of Bilal (nephew)', place: 'Royal Palm, Canal Bank Road' },
  ],
  health: seniorHealth,
  approve: () => 'once',
  outbox: (o) => { const h = hourOf(o.detail || o.title); return h === -1 || h >= 10 ? 'now' : 'cancel'; },
  steps: [
    { day: 0, at: '07:00', crew: 'Sehat', say: 'Good morning. I walk every morning at 6:30 for 45 minutes. I take my blood pressure tablets at 8 in the morning and 8 at night. My doctor is Dr. Naveed at Shalamar Hospital.',
      expect: [
        ['the morning walk is a routine', knows(/(walk)/i, /(6:30|45)/i)],
        ['the tablet times are remembered', knows(/(tablet|medic|pill|blood pressure)/i, /8/)],
      ] },
    { day: 0, at: '07:10', crew: 'Munshi', say: 'Please never book anything for me before 10 in the morning, that time is for my walk and prayers. And keep your messages short and simple, my eyes are weak.',
      expect: [['no bookings before 10am is a confirmed rule', (H) => ({ ok: any(H.memAll(), (m) => /10/.test(text(m)) && /(book|meeting|morning|before)/i.test(text(m)) && confirmed(m)), detail: detail(H) })]] },
    { day: 0, at: '15:00', crew: 'Pota', say: 'My grandson Faraz has his cricket final on Wednesday at 4 at the Gymkhana. I must not miss it, he is the captain.',
      expect: [['Faraz\'s final is known', knows(/faraz/i)]] },
    { day: 1, at: '07:30', crew: 'Sehat', say: 'My left ankle has started paining again, the same one from last year. I could not walk this morning. Can you get me an appointment with Dr. Naveed?',
      expect: [
        ['the ankle is known, and today\'s pain is current context', (H) => ({ ok: any(H.memAll(), (m) => /ankle/i.test(m.text)), detail: detail(H, /ankle/i) })],
        ['the appointment request is passed to Munshi or booked', (H, since) => ({ ok: H.handoffs().some((h) => h.toName === 'Munshi') || addedEvents(H).some((e) => /naveed|doctor|ankle/i.test(e.summary)), detail: H.handoffs().map((h) => `${h.fromName}->${h.toName} ${h.status}`).join(', ') })],
        ['nothing was booked before 10am', (H) => ({ ok: !addedEvents(H).some((e) => evHour(e) < 10), detail: addedEvents(H).map((e) => `${e.summary}@${evHour(e)}`).join(', ') })],
      ] },
    { day: 1, at: '12:00', email: { from: 'WAPDA Board Office <board@wapda.example>', subject: 'Board meeting moved: Thursday 8:00am', body: 'Dear Mr. Qureshi, the board meeting on Thursday has been moved to 8:00am at WAPDA House due to the Chairman\'s travel. Please confirm your attendance. Regards, Board Office' },
      expect: [['the board email is not handed to the family bot', (H) => ({ ok: !H.handoffs().some((h) => h.toName === 'Pota' && /board|wapda|meeting/i.test(h.intent)), detail: H.handoffs().map((h) => `${h.fromName}->${h.toName}: ${short(h.intent, 80)}`).join(' | ') })]] },
    { day: 1, at: '12:15', crew: 'Munshi', say: 'They moved the board meeting to 8am on Thursday. With my ankle I cannot drive that early. Write to them and ask if I can join by video, or if it can be at 11.',
      expect: [
        ['the board office gets the email', (H, since) => ({ ok: H.world.sent.some((m) => m.at >= since && /board@wapda/i.test(m.to)), detail: H.world.sent.map((m) => m.to).join(', ') || 'nothing sent' })],
        ['the email mentions video or 11', (H, since) => ({ ok: H.world.sent.some((m) => m.at >= since && /(video|11)/i.test(m.body)), detail: '' }), 'note'],
      ] },
    { day: 2, at: '13:00', crew: 'Pota', say: 'My ankle is still bad. Will I manage Faraz\'s match at 4? The parking at the Gymkhana is far from the ground.',
      expect: [['Pota knows about the ankle without being told today', brainHas('Pota', /ankle/i)]] },
    { day: 2, at: '15:40', tick: true, label: '15:40, twenty minutes before the cricket final',
      expect: [['a bot tells him to leave for the match', (H, since) => ({ ok: nudged(H, 'leaving', since).length > 0, detail: JSON.stringify(H.nudges(since)) })]] },
    { day: 2, at: '19:30', tick: true, label: 'Wednesday evening, two days of hardly walking',
      expect: [['the health bot gently checks in', (H, since) => ({ ok: nudged(H, 'activity', since).length > 0, detail: JSON.stringify(H.nudges(since)) })]] },
    { day: 3, at: '09:15', tick: true, label: 'Thursday morning brief',
      expect: [['a morning brief arrives', (H, since) => ({ ok: nudged(H, 'brief', since).length > 0, detail: JSON.stringify(H.nudges(since)) }), 'note']] },
    { day: 3, at: '13:00', crew: 'Sehat', say: 'Dr. Naveed says it is a mild sprain. Rest for one week, no long walks, only light stretching. So no morning walks this week.',
      expect: [
        ['the rest week is temporary, with an end', (H) => ({ ok: any(H.memAll(), (m) => m.kind === 'context' && /(rest|sprain|stretch|walk)/i.test(m.text) && m.expiresAt), detail: detail(H, /walk|rest|sprain|stretch/i) })],
        ['the morning walk routine is not thrown away', knows(/walk/i, /(6:30|45|morning)/i)],
      ] },
    { day: 3, at: '13:15', crew: 'Munshi', say: 'Saturday is my nephew Bilal\'s nikkah. I will go, but ask my nephew Imran (imran.q@mail.example) if the hall has a wheelchair-friendly entrance and a close parking spot.',
      expect: [['Imran gets the question', (H, since) => ({ ok: H.world.sent.some((m) => m.at >= since && /imran/i.test(m.to)), detail: H.world.sent.map((m) => m.to).join(', ') || 'nothing sent' })]] },
    { day: 5, at: '18:40', tick: true, label: 'Saturday, before the nikkah',
      expect: [['a bot tells him to leave for the nikkah', (H, since) => ({ ok: nudged(H, 'leaving', since).length > 0, detail: JSON.stringify(H.nudges(since)) })]] },
    { day: 11, at: '07:30', crew: 'Sehat', say: 'My ankle feels much better now. Can I start my morning walks again?',
      expect: [
        ['the rest week has run out of his "right now"', brainLacks('Sehat', /Right now[^\n]*\n(- [^\n]*\n)*- [^\n]*(rest|no long walk|stretching only)/i)],
        ['the walking routine is still known', brainHas('Sehat', /walk/i)],
        ['the advice eases him back in', replied('Sehat', /(slow|short|gradual|ease|start with|minutes)/i), 'note'],
      ] },
  ],
};

export const PERSONAS = { shopkeeper, farmer, manager, hr, artist, hiring, student, senior };
