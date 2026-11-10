/**
 * Collectors: Codeply activity the user allowed, as raw events for the Context
 * Engine. Nothing here reads a window, a mic or a mailbox: the sources that do
 * (Life: life-sources.js, life-listen.js, call-listen.js) already exist and
 * keep their own switches. This only reads what they already stored, and only
 * for the sources the user has on.
 *
 *   exchangeEvent()   a finished chat turn (Craft, a Crew bot): the user's words
 *                     and the reply; trust "user"
 *   lifeEvents()      Life items since a cursor:
 *                       heard   what Life kept from the mic (already filtered to
 *                               to-dos, decisions, people, ideas); trust "mixed"
 *                       calls   a call's summary (sensitive: local only); "mixed"
 *                       orbit   what the user asked Orbit or the drop; "user"
 *                       gmail   mail headers and the preview line: sent by the
 *                               user is "user", received is "external"
 *                     Calendar, plans, activity, screen and health are not
 *                     collected: they are already structured in Life, or too
 *                     noisy and private to become long-term memory.
 */

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
// "ok", "thanks", "continue": nothing to learn.
const TRIVIAL = /^\s*(continue|go on|ok|okay|k|yes|yep|no|nope|thanks|thank you|thx|retry|try again|do it|fix it|nice|great|cool|done|sure)\b[\s.!]*$/i;

/** A chat turn as an event (null when there is nothing to learn from). */
function exchangeEvent({ userText, replyText, project, product, botId, botName, at, id } = {}) {
  const user = String(userText || '').trim();
  if (user.length < 12 || TRIVIAL.test(user)) return null;
  return {
    source: 'chat', product: product || 'craft', trust: 'user', at: at || Date.now(), project: project || '',
    actor: botId ? { botId, botName } : null,
    externalId: id || undefined,
    text: `User: ${user.slice(0, 3500)}\nAssistant: ${clip(replyText, 1200) || '(no reply)'}`,
  };
}

/** Which Life item sources become events, and how far each is trusted. */
const LIFE_SOURCES = {
  heard: { trust: () => 'mixed', sensitive: () => false },
  calls: { trust: () => 'mixed', sensitive: () => true },
  orbit: { trust: () => 'user', sensitive: () => false },
  gmail: { trust: (it) => (it.kind === 'email_out' ? 'user' : 'external'), sensitive: () => false },
};
const SOURCE_FOR = { heard: 'heard', calls: 'call', orbit: 'orbit', gmail: 'email' };

/** One Life item as an event, or null. */
function lifeItemEvent(it) {
  const spec = LIFE_SOURCES[it && it.source];
  if (!spec) return null;
  let text = '';
  if (it.source === 'heard') text = `Heard around the user (${it.kind}): ${clip(it.title, 200)}${it.body ? `. ${clip(it.body, 600)}` : ''}${it.people && it.people.length ? ` People: ${it.people.join(', ')}.` : ''}`;
  else if (it.source === 'calls') {
    // The summary and to-dos, never the transcript (it stays sealed in Life).
    const d = it.data || {};
    const todo = Array.isArray(d.todo) && d.todo.length ? ` To-dos: ${d.todo.slice(0, 5).map((x) => clip(x, 120)).join('; ')}.` : '';
    text = `A call${it.people && it.people.length ? ` with ${it.people.join(', ')}` : ''}: ${clip(it.title, 200)}${d.summary ? `. Summary: ${clip(d.summary, 800)}` : ''}${todo}`;
  } else if (it.source === 'orbit') text = `The user asked: ${clip(it.title, 600)}${it.data && it.data.answer ? `\nAnswer: ${clip(it.data.answer, 300)}` : ''}`;
  else if (it.source === 'gmail') {
    const out = LIFE_SOURCES.gmail.trust(it) === 'user';
    const preview = it.data && it.data.snippet ? `. ${clip(it.data.snippet, 300)}` : '';
    text = `${out ? 'Email the user sent' : 'Email the user received'}${it.people && it.people.length ? ` (${out ? 'to' : 'from'} ${it.people.slice(0, 3).join(', ')})` : ''}: ${clip(it.title, 200)}${preview}`;
  }
  if (clip(text, 20).length < 12) return null;
  return {
    source: SOURCE_FOR[it.source], product: 'life', at: it.at, trust: spec.trust(it), sensitive: spec.sensitive(it) || !!it.sensitive,
    externalId: `${it.id}:${it.updatedAt || ''}`, text, meta: { lifeItem: it.id },
  };
}

/**
 * New Life items as events, for the sources that are on and the ones the user
 * allowed into long-term memory. The cursor is the last item's updatedAt.
 * @param {{ store: object, allowed: Set<string>, since: number, limit?: number }} o
 * @returns {{ events: object[], cursor: number }}
 */
function lifeEvents({ store, allowed, since = 0, limit = 100 }) {
  const sources = Object.keys(LIFE_SOURCES).filter((s) => allowed && allowed.has(s));
  if (!store || !sources.length) return { events: [], cursor: since };
  const items = store.items({ sources, from: since ? since - 7 * 86400000 : undefined, limit: 400, order: 'asc' })
    .filter((it) => (it.updatedAt || it.at) > since)
    .sort((a, b) => (a.updatedAt || a.at) - (b.updatedAt || b.at))
    .slice(0, limit);
  let cursor = since;
  const events = [];
  for (const it of items) {
    cursor = Math.max(cursor, it.updatedAt || it.at);
    const ev = lifeItemEvent(it);
    if (ev) events.push(ev);
  }
  return { events, cursor };
}

module.exports = { exchangeEvent, lifeItemEvent, lifeEvents, LIFE_SOURCES, TRIVIAL };
