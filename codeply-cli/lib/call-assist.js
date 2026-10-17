/**
 * The call helper's thinking (the desktop side is Craft's call-listen.js).
 *
 * While the user is on a call on their PC, Whisper turns both sides into
 * text on the PC. From that transcript and the life context:
 *   assistPrompt()    cards with what is relevant (an email, an event, a
 *                     person) and one whispered suggestion of what to say
 *   offerHandover()   the other side is asking for the user and the user has
 *                     gone quiet: offer to take the call
 *   takeoverPrompt()  what the bot says when the user hands the call over: it
 *                     says who it is (the user's assistant, never the user), gives
 *                     one of the user's approved excuses in the bot's style, and
 *                     closes the call politely
 *   endCallKeys()     the keys that hang up in the app the call is in
 * Nothing here records audio or talks to a model; the host passes chat in.
 */

const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** The last few minutes, as lines a model can read. */
function transcriptLines(turns, { userName = 'User', limit = 40, sinceMs = 0 } = {}) {
  return (turns || []).filter((t) => !sinceMs || t.at >= sinceMs).slice(-limit)
    .map((t) => `${t.who === 'me' ? userName : t.who === 'bot' ? 'Assistant' : 'Them'}: ${short(t.text, 400)}`).join('\n');
}

const STOP = new Set(['The', 'And', 'But', 'Yes', 'Yeah', 'Okay', 'Ok', 'So', 'Well', 'Hi', 'Hello', 'Hey', 'Thanks', 'Thank', 'Sure', 'Right', 'What', 'When', 'Where', 'Who', 'How', 'Why', 'I', 'You', 'We', 'They', 'It', 'This', 'That', 'Is', 'Are', 'Do', 'Did', 'Can', 'Could', 'Would', 'Will', 'Let', 'Please', 'Sorry', 'Just', 'Maybe', 'Also', 'Now', 'Then', 'Good', 'Great', 'Nice', 'Cool', 'Alright', 'Actually', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Today', 'Tomorrow']);
/** Words worth looking up in the life context: names, emails, capitalized things, quoted bits. */
function lookupTerms(turns, max = 6, userName = '') {
  const text = (turns || []).slice(-8).map((t) => t.text).join(' ');
  const out = [];
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) out.push(m[0]);
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g)) if (!STOP.has(m[1].split(' ')[0]) && m[1].split(' ')[0] !== String(userName).split(/s+/)[0]) out.push(m[1]);
  for (const m of text.matchAll(/\b(invoice|contract|deadline|launch|proposal|meeting|deck|budget|demo|release)\b/gi)) out.push(m[1].toLowerCase());
  return [...new Set(out)].slice(-max);
}

function assistPrompt({ turns, nowBlock, hits, userName, botName }) {
  const found = (hits || []).slice(0, 8).map((h) => `- [${h.source}] ${short(h.title, 120)}${h.people && h.people.length ? ` (${h.people.slice(0, 2).join(', ')})` : ''}${h.data && (h.data.summary || h.data.snippet) ? `: ${short(h.data.summary || h.data.snippet, 160)}` : ''}`).join('\n');
  return `You are ${botName || 'the assistant'}, quietly helping ${userName || 'the user'} during a live call. Only ${userName || 'the user'} sees what you write; the other person never does.

${nowBlock || ''}

From their life context, maybe relevant:
${found || '(nothing found)'}

The call so far:
${transcriptLines(turns, { userName })}

Write at most 3 short cards with facts that help right now (an email, an event, a number, who someone is), only from what is above, never invented. And one suggestion of what ${userName || 'the user'} could say or ask next, in their own words, only if it really helps. Plain text, no long dash.
Respond with ONLY JSON: {"cards": [{"title": "...", "text": "..."}], "whisper": "or empty"}`;
}

function parseAssist(json) {
  const cards = (json && Array.isArray(json.cards) ? json.cards : []).filter((c) => c && (c.title || c.text)).slice(0, 3)
    .map((c) => ({ title: short(c.title, 80), text: short(String(c.text || '').replace(/\s*\u2014\s*/g, ', '), 300) }));
  return { cards, whisper: short(String((json && json.whisper) || '').replace(/\s*\u2014\s*/g, ', '), 240) };
}

/** The other side wants the user and the user has been quiet: time to offer a hand-over. */
function offerHandover(turns, { userName = '', now = Date.now(), quietMs = 15000 } = {}) {
  const list = turns || [];
  const lastMe = [...list].reverse().find((t) => t.who === 'me');
  if (lastMe && now - lastMe.at < quietMs) return false;
  const recent = list.filter((t) => t.who === 'them' && now - t.at < 20000);
  if (!recent.length) return false;
  const first = String(userName || '').split(/\s+/)[0];
  const asking = new RegExp(`\\b(are you there|can you hear me|hello\\?|you still there|did we lose you|you('re| are) on mute${first ? `|${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?` : ''})`, 'i');
  return recent.some((t) => asking.test(t.text));
}

const STYLE_TEXT = { friendly: 'warm and casual', formal: 'polite and formal', brief: 'short and to the point', playful: 'light and a bit funny' };

function takeoverPrompt({ bot, turns, userName, callStyle }) {
  const style = (callStyle && callStyle.style) || 'friendly';
  const excuses = (callStyle && callStyle.excuses) || [];
  return `${userName || 'The user'} has handed you a live call: they cannot continue it. You are ${bot.name}, their AI assistant. You speak out loud to the other person now.

The call so far:
${transcriptLines(turns, { userName, limit: 20 })}

Say, in two to four short spoken sentences, ${STYLE_TEXT[style] || STYLE_TEXT.friendly}:
1. Who you are: "${bot.name}, ${userName || 'their'}'s assistant". Never pretend to be ${userName || 'the user'} and never speak as them.
2. Why they had to go: ${excuses.length ? `use one of these excuses ${userName || 'they'} approved, the one that fits best: ${excuses.map((e) => `"${short(e, 160)}"`).join('; ')}` : `${userName || 'they'} had to step away`}.
3. That ${userName || 'they'} will get back to them, and anything you will pass on (only if they said something to pass on).
4. A polite goodbye.
No promises on ${userName || 'their'} behalf beyond getting back to them. Plain spoken words, no lists, no long dash.
Respond with ONLY JSON: {"say": "..."}`;
}

/** If the model fails: the same shape, without the model. */
function fallbackTakeover({ bot, userName, callStyle }) {
  const excuse = ((callStyle && callStyle.excuses) || [])[0] || `${userName || 'They'} had to step away for a moment`;
  return `Hi, this is ${bot.name}, ${userName ? `${userName}'s` : 'the'} assistant. ${excuse.replace(/[.!]?$/, '.')} ${userName || 'They'} will get back to you as soon as possible. Thanks for understanding, have a good one.`;
}

/**
 * The keys that hang up, by call app (life-sources.js classifyWindow labels).
 * null: no reliable key; the helper asks the user to hang up instead.
 */
function endCallKeys(app) {
  switch (String(app || '')) {
    case 'Zoom': return ['alt+q', 'enter'];
    case 'Teams': return ['ctrl+shift+h'];
    case 'Google Meet': return ['ctrl+w'];
    case 'Discord': return null;
    case 'WhatsApp': return null;
    case 'Phone Link': return null;
    default: return null;
  }
}

/** Mic picking up the speakers: a "me" line that repeats what "them" just said is an echo. */
function isEcho(text, turns, now = Date.now()) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const t = norm(text);
  if (t.length < 6) return false;
  return (turns || []).some((x) => x.who === 'them' && now - x.at < 6000 && (norm(x.text).includes(t) || t.includes(norm(x.text))));
}

module.exports = { transcriptLines, lookupTerms, assistPrompt, parseAssist, offerHandover, takeoverPrompt, fallbackTakeover, endCallKeys, isEcho };
