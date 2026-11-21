// What is on the user's screen, for the agent: the look_at_screen tool (a
// picture and its text) and a short memory of the last read per chat, so a
// follow-up ("and Marwa?") can be answered from what was already seen.
//
// Only a desktop host can take a screenshot, so the host attaches one function
// (Craft: main.js); in the terminal CLI the tool says it isn't available here.
//
//   host()  -> { image: 'data:image/jpeg;base64,...', text, app, title } | { error }
let host = null;
const seen = new Map(); // chatId -> { text, app, title, at }

const FRESH_MS = 2 * 60000;   // read this recently: "right now"
const RECALL_MS = 30 * 60000; // after that the chat still remembers it, as "when you last looked"

function attach(fn) { host = typeof fn === 'function' ? fn : null; }
function available() { return !!host; }

/**
 * The screen's text was read for this chat (the drop reads it with every
 * message). earlier: screens from a few minutes ago that the message seems to
 * be about ([{ title, text, at }]), others: the other windows lately, and
 * pictures: what each picture attached to this message shows, in order.
 */
function remember(chatId, { text = '', app = '', title = '', earlier = [], others = [], pictures = [] } = {}) {
  if (!chatId || !(String(text).trim() || earlier.length)) return;
  // A follow-up ("try now") names nothing new: the earlier screens this chat was about stay with it.
  const prev = seen.get(chatId);
  const kept = earlier.length ? earlier : (prev && prev.earlier || []).filter((e) => Date.now() - e.at < RECALL_MS);
  seen.delete(chatId);
  seen.set(chatId, { text: String(text).slice(0, 6000), app, title, earlier: kept.slice(0, 2), others: others.slice(0, 8), pictures: pictures.slice(0, 4), at: Date.now() });
  if (seen.size > 200) seen.delete(seen.keys().next().value);
}

const ago = (ms) => (ms < 60000 ? 'just now' : `${Math.round(ms / 60000)} min ago`);

/** The block for this turn's context: what is on screen now, what was on it lately, or what this chat saw last. '' when nothing. */
function contextFor(chatId, now = Date.now()) {
  const s = chatId && seen.get(chatId);
  if (!s || now - s.at > RECALL_MS) return '';
  const age = now - s.at;
  const parts = [];
  if (s.text) {
    const where = s.app ? ` (${s.app}${s.title ? `, "${s.title}"` : ''})` : '';
    parts.push(`${age < FRESH_MS ? `ON THE USER'S SCREEN RIGHT NOW${where}, read by OCR just now` : `THE USER'S SCREEN WHEN YOU LAST LOOKED${where}, ${ago(age)}; it may have changed since`}:\n${s.text.slice(0, 4000)}`);
  }
  for (const e of s.earlier || []) parts.push(`EARLIER ON THE USER'S SCREEN, ${ago(now - e.at)}: ${e.title}\n${String(e.text).slice(0, 3000)}`);
  if ((s.pictures || []).length && age < FRESH_MS) parts.push(`Pictures attached to this message, in order: ${s.pictures.map((p, i) => `${i + 1}. ${p}`).join('; ')}. Look at them for anything the text above misses.`);
  if ((s.others || []).length) parts.push(`Other windows the user had in front lately: ${s.others.map((o) => `${o.title} (${ago(now - o.at)})`).join('; ')}. For what was on them, use life_context with a query.`);
  parts.push([
    'How to read this: each line is one row of the screen, left to right, with | between columns, so a number belongs to the words on its own line. Read every number with the word printed right next to it ("693m views" is a view count, "40.2m subscribers" is a channel\'s subscribers) and never swap or estimate them. OCR can misread a character (5 as s, 1 as l).',
    '"That video", "that page", "again": the user may mean something they saw a few minutes ago, so check the earlier screens before saying you can\'t see it. To see how an earlier window looked, call look_at_screen with <window> set to a few words of its title.',
    'Answer from this directly when the message is about what they are or were looking at. For a closer look at the screen now, call look_at_screen. If the answer is not here, say so plainly. Never say you looked something up, searched or checked unless you called a tool for it this turn, and never mention the Codeply chat window itself.',
  ].join(' '));
  return parts.join('\n\n');
}

async function lookTool(ctx = {}, args = {}) {
  if (!host) return { ok: false, output: 'look_at_screen only works in the Codeply app, which can see the screen. Ask the user to paste what they mean instead.' };
  // <window>: an earlier screen from the picture buffer (the last 12 windows), no new screenshot.
  const want = String(args.window || '').trim();
  let r;
  try { r = await host(want ? { window: want } : {}); } catch (e) { r = { error: e.message }; }
  if (!r || r.error || !r.image) return { ok: false, output: `Could not see the screen: ${(r && r.error) || 'no picture'}.${want ? '' : ' Ask the user to paste what they mean.'}` };
  const text = String(r.text || '').trim();
  if (!want) remember(ctx.chatId, r);
  const lines = [
    want
      ? `A picture of an earlier screen is attached below: ${r.title}, from ${ago(r.ago || 0)}. Look at it before answering.`
      : 'A screenshot of the user\'s screen is attached below, taken just now. Look at it before answering.',
    !want && r.app ? `Window in front: ${r.app}${r.title ? `, "${r.title}"` : ''}` : '',
    text ? `Text on the screen (read by OCR, one line per row of the screen with | between columns; may have small mistakes):\n${text.slice(0, 6000)}` : 'No text could be read from the screen.',
    'Answer about what the user means from this. Do not describe the whole screen unless they asked; never mention the Codeply chat window itself.',
  ].filter(Boolean);
  return { ok: true, output: lines.join('\n\n'), meta: { imageDataUrls: [r.image] } }; // the step already reads "Looked at your screen"
}

module.exports = { attach, available, remember, contextFor, lookTool };
