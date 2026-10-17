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

/** The screen's text was read for this chat (the drop reads it with every message). */
function remember(chatId, { text = '', app = '', title = '' } = {}) {
  if (!chatId || !String(text).trim()) return;
  seen.delete(chatId);
  seen.set(chatId, { text: String(text).slice(0, 6000), app, title, at: Date.now() });
  if (seen.size > 200) seen.delete(seen.keys().next().value);
}

/** The block for this turn's context: what is on screen now, or what this chat saw last. '' when nothing. */
function contextFor(chatId, now = Date.now()) {
  const s = chatId && seen.get(chatId);
  if (!s || now - s.at > RECALL_MS) return '';
  const age = now - s.at;
  const where = s.app ? ` (${s.app}${s.title ? `, "${s.title}"` : ''})` : '';
  const head = age < FRESH_MS
    ? `ON THE USER'S SCREEN RIGHT NOW${where}, read by OCR just now`
    : `THE USER'S SCREEN WHEN YOU LAST LOOKED${where}, ${Math.round(age / 60000)} min ago; it may have changed since`;
  return `${head}:\n${s.text.slice(0, 4000)}\n\nUse this when the message is about what they are looking at (names, numbers, a message, an error on screen), and answer from it directly. For a picture, or if it looks out of date, call look_at_screen. Never mention the Codeply chat window itself.`;
}

async function lookTool(ctx = {}) {
  if (!host) return { ok: false, output: 'look_at_screen only works in the Codeply Craft app, which can see the screen. Ask the user to paste what they mean instead.' };
  let r;
  try { r = await host(); } catch (e) { r = { error: e.message }; }
  if (!r || r.error || !r.image) return { ok: false, output: `Could not see the screen: ${(r && r.error) || 'no picture'}. Ask the user to paste what they mean.` };
  const text = String(r.text || '').trim();
  remember(ctx.chatId, r);
  const lines = [
    'A screenshot of the user\'s screen is attached below, taken just now. Look at it before answering.',
    r.app ? `Window in front: ${r.app}${r.title ? `, "${r.title}"` : ''}` : '',
    text ? `Text on the screen (read by OCR, may have small mistakes):\n${text.slice(0, 6000)}` : 'No text could be read from the screen.',
    'Answer about what the user means from this. Do not describe the whole screen unless they asked; never mention the Codeply chat window itself.',
  ].filter(Boolean);
  return { ok: true, output: lines.join('\n\n'), meta: { imageDataUrls: [r.image] } }; // the step already reads "Looked at your screen"
}

module.exports = { attach, available, remember, contextFor, lookTool };
