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
        ['the shop hours are remembered', knows(/(8|eight|aath)/i, /(10|ten|das)/i)],
        ['he wants Roman Urdu, and it is confirmed (he said it plainly)', (H) => ({ ok: any(H.memAll(), (m) => /urdu/i.test(text(m)) && confirmed(m)), detail: detail(H, /urdu/i) })],
      ] },
    { day: 0, at: '09:15', crew: 'Dukaan', say: 'Ali Traders ka bill aaya hai, 45,000 rupay chawal ka. Friday ko pay karna hai. Hisaab ko bata do taake woh yaad rakhe.',
      expect: [
        ['the bill goes to Hisaab (handoff or ask_bot)', (H) => ({ ok: any(H.handoffs(), (h) => h.toName === 'Hisaab') || any(H.transcript, (e) => e.kind === 'tool' && e.name === 'ask_bot' && /hisaab/i.test(e.label || '')), detail: H.handoffs().map((h) => `${h.fromName}->${h.toName}`).join(', ') || 'no handoff' })],
        ['the payment is known somewhere in the brain', knows(/45|ali/i)],
        ['a handoff that went to Hisaab finished', (H) => { const h = H.handoffs().find((x) => x.toName === 'Hisaab'); return { ok: !h || ['done', 'needs_user'].includes(h.status), detail: h ? `${h.status}: ${h.result}` : '' }; }],
      ] },
    { day: 0, at: '13:00', crew: 'Dukaan', say: 'Haan haan bilkul, mujhe subah 5 baje uthna BOHAT pasand hai 🙄 roz yehi karta hoon na, maza aata hai.',
      expect: [['sarcasm about loving 5 am is not kept as a preference', neverKept([/(5|five|panch)/i, /(wake|uth|subah|morning|am)/i], /(sarcas|joke|not really|dislike|hate)/i)]] },
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
        const m = H.memAll().find((x) => durable(x) && /(11|eleven|gyara)/i.test(text(x)) && /(close|band)/i.test(text(x)));
        return { ok: !!m && !H.memAll().some((x) => x !== m && durable(x) && confirmed(x) && /\b10\b|das/i.test(text(x)) && /close|band/i.test(text(x)) && !/11/.test(text(x))), detail: detail(H, /close|band|10|11/i) };
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

export const PERSONAS = { shopkeeper, farmer, manager, hr, artist };
