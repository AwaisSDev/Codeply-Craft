// The look_at_screen tool: what is on the user's screen right now, as a
// picture and its text. Only a desktop host can take a screenshot, so the host
// attaches one function (Craft: main.js); in the terminal CLI the tool says it
// isn't available here.
//
//   look()  -> { image: 'data:image/jpeg;base64,...', text, app, title } | { error }
let host = null;

function attach(fn) { host = typeof fn === 'function' ? fn : null; }
function available() { return !!host; }

async function lookTool() {
  if (!host) return { ok: false, output: 'look_at_screen only works in the Codeply Craft app, which can see the screen. Ask the user to paste what they mean instead.' };
  let r;
  try { r = await host(); } catch (e) { r = { error: e.message }; }
  if (!r || r.error || !r.image) return { ok: false, output: `Could not see the screen: ${(r && r.error) || 'no picture'}. Ask the user to paste what they mean.` };
  const text = String(r.text || '').trim();
  const lines = [
    'A screenshot of the user\'s screen is attached below, taken just now. Look at it before answering.',
    r.app ? `Window in front: ${r.app}${r.title ? `, "${r.title}"` : ''}` : '',
    text ? `Text on the screen (read by OCR, may have small mistakes):\n${text.slice(0, 6000)}` : 'No text could be read from the screen.',
    'Answer about what the user means from this. Do not describe the whole screen unless they asked; never mention the Codeply chat window itself.',
  ].filter(Boolean);
  return { ok: true, output: lines.join('\n\n'), meta: { imageDataUrls: [r.image] } }; // the step already reads "Looked at your screen"
}

module.exports = { attach, available, lookTool };
