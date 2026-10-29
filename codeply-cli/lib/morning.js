/**
 * The morning message: the first thing Codeply says each day.
 *
 *   While you slept   what came in that matters
 *   What I did        side effects from the ledger, each saying whether it was checked
 *   Waiting on you    drafts and actions that need the user's OK
 *   Your day          today's calendar and plans, open to-dos, replies owed
 *   Anything to add?  the user answers in plain words; the agent puts it on
 *                     the calendar and reads each event back (tools.mjs)
 *
 * Built from the stores with no model call, so it never says Codeply did
 * something the ledger cannot back. The trigger engine sends it as written.
 */
const L = require('./life.js');
const spine = require('./spine.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX = { slept: 5, did: 6, waiting: 5, day: 8, todos: 3 };

const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const firstName = (p) => String(p || '').replace(/<.*>/, '').trim().split(/\s+/)[0] || String(p || '');

/** Since when "overnight" counts: the last morning message, else 20:00 yesterday, at most 16 hours back. */
function sinceFor({ store, now, tz }) {
  const start = L.startOfDay(now, tz);
  let since = start - 4 * HOUR;
  const last = store && store.getState ? store.getState('morning.lastAt', 0) : 0;
  if (last && last > since && last < now) since = last;
  return Math.max(since, now - 16 * HOUR);
}

function slept({ store, since, now }) {
  if (!store) return [];
  const mail = store.items({ sources: ['gmail'], kinds: ['email_in'], from: since, to: now, limit: 60 })
    .filter((x) => x.data && (x.data.level === 'very' || x.data.level === 'important'))
    .sort((a, b) => (b.data.score || 0) - (a.data.score || 0));
  const lines = mail.slice(0, MAX.slept).map((x) => `${x.data.level === 'very' ? 'Important: ' : ''}${firstName(x.people[0])} wrote "${short(x.title, 70)}"`);
  if (mail.length > MAX.slept) lines.push(`and ${mail.length - MAX.slept} more worth a look`);
  const cancelled = store.items({ sources: ['calendar'], kinds: ['cancelled'], from: now, to: now + 2 * DAY, limit: 20 })
    .filter((x) => x.updatedAt >= since);
  for (const x of cancelled.slice(0, 2)) lines.push(`"${short(x.title, 60)}" was cancelled`);
  return lines;
}

function did({ since }) {
  const lines = [];
  for (const t of spine.tasksSince(since)) {
    for (const a of t.actions) {
      if (a.status === 'rejected' || a.tool === 'gmail_draft') continue;
      lines.push(spine.actionLine(a));
    }
  }
  if (lines.length > MAX.did) return [...lines.slice(0, MAX.did), `and ${lines.length - MAX.did} more`];
  return lines;
}

function waiting({ store, since, drafts = [] }) {
  const lines = [];
  for (const t of spine.tasksSince(since)) {
    for (const a of t.actions) {
      if (a.tool !== 'gmail_draft' || a.status !== 'done') continue;
      lines.push(`Draft ready: ${short(a.summary.replace(/^draft[^:]*:\s*/i, ''), 70)}${a.verified === 'yes' ? '' : ' (not verified)'}`);
    }
  }
  for (const d of drafts) lines.push(`Draft reply to ${firstName(d.from)}: "${short(d.subject, 60)}"`);
  if (store && store.outboxByStatus) {
    for (const o of [...store.outboxByStatus('needs_you'), ...store.outboxByStatus('waiting')]) lines.push(`Needs your OK: ${short(o.title, 80)}`);
  }
  return lines.slice(0, MAX.waiting);
}

function day({ store, snap, now, todos = [] }) {
  const tz = snap.tz;
  const start = L.startOfDay(now, tz);
  const lines = [];
  if (store) {
    const today = store.items({ sources: ['calendar', 'plans'], from: start, to: start + DAY, limit: 30, order: 'asc' })
      .filter((x) => x.kind !== 'cancelled');
    for (const x of today.slice(0, MAX.day)) lines.push(`${x.data && x.data.allDay ? 'All day' : L.clock(x.at, tz)} ${short(x.title, 60)}${x.place ? `, ${short(x.place, 40)}` : ''}`);
    if (!today.length) lines.push('Nothing on the calendar yet');
  }
  const owed = (snap.waiting || []).slice(0, 3);
  if (owed.length) lines.push(`Replies you owe: ${owed.map((w) => firstName(w.from)).join(', ')}`);
  for (const t of todos.slice(0, MAX.todos)) lines.push(`To do: ${short(t.text, 80)}`);
  return lines;
}

/**
 * The message. o: { store, snap, now, todos ([{ text }] from the brain),
 * drafts ([{ from, subject }]; default: what the inbox watcher left in the store) }.
 * Returns { since, sections: [{ key, title, lines }], text }.
 */
function build(o = {}) {
  const now = o.now || Date.now();
  const snap = o.snap || { tz: 'UTC', waiting: [] };
  const since = o.since || sinceFor({ store: o.store, now, tz: snap.tz });
  const sections = [
    { key: 'slept', title: 'While you slept', lines: slept({ store: o.store, since, now }) },
    { key: 'did', title: 'What I did', lines: did({ since }) },
    { key: 'waiting', title: 'Waiting on you', lines: waiting({ store: o.store, since, drafts: o.drafts || (o.store && o.store.getState ? o.store.getState('morning.drafts', []) || [] : []) }) },
    { key: 'day', title: 'Your day', lines: day({ store: o.store, snap, now, todos: o.todos }) },
  ].filter((s) => s.lines.length);
  const ask = 'Anything to add? Tell me in plain words, like "gym at 6, call mom tonight", and I\'ll put it on your calendar and check each one is there.';
  const text = ['Good morning.', ...sections.map((s) => `${s.title}:\n${s.lines.map((l) => `- ${l}`).join('\n')}`), ask].join('\n\n');
  return { since, sections, ask, text, summary: summarize(sections) };
}

/** One line for a notification: what matters most, in words, no counts of sections. */
function summarize(sections) {
  const get = (k) => (sections.find((s) => s.key === k) || { lines: [] }).lines.filter((l) => !/^and \d+ more/.test(l));
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const parts = [];
  const slept = get('slept');
  if (slept.length) parts.push(slept.length === 1 ? slept[0].replace(/^Important: /, '') : `${n(slept.length, 'thing', 'things')} came in overnight`);
  const did = get('did');
  if (did.length) {
    const unsure = did.filter((l) => /not verified|not sure|check failed|failed/.test(l)).length;
    parts.push(`I did ${n(did.length, 'thing', 'things')}${unsure ? `, ${unsure} not confirmed` : did.length === 1 ? ', checked' : ', all checked'}`);
  }
  const waiting = get('waiting');
  if (waiting.length) parts.push(`${n(waiting.length, 'thing needs', 'things need')} your OK`);
  const day = get('day').filter((l) => !/^(Replies you owe|To do):/.test(l));
  if (day.length && /^Nothing on the calendar/.test(day[0])) parts.push('nothing on your calendar yet');
  else if (day.length) parts.push(`first up: ${day[0]}`);
  if (!parts.length) return 'Good morning. A quiet start: nothing new.';
  return `Good morning. ${parts.map((p) => `${p.charAt(0).toUpperCase()}${p.slice(1)}`).join('. ')}.`;
}

/** Call after the message went out, so tomorrow's "overnight" starts here. */
function markSent(store, at = Date.now()) {
  try { store.setState('morning.lastAt', at); store.setState('morning.drafts', []); } catch {}
}

module.exports = { build, markSent, sinceFor };
