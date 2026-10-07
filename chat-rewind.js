/**
 * Edit / retry a sent message: works out where a chat has to be cut so a
 * message can run again in place, and which files to put back first.
 *
 * Pure (no Electron, no disk), so it can be tested on its own; main.js does
 * the cutting, the file restore and the rerun.
 */

/**
 * @param {object[]} messages   a session's messages, oldest first
 * @param {number} userIndex    which user message (0 = the first one the chat shows)
 * @param {string} [expectText] what that message says, as a guard against a
 *                              chat that changed under the renderer (a phone
 *                              sent something in between)
 * @returns {null | {
 *   index: number,             // cut here: messages[index] and everything after go
 *   message: object,           // the user message being edited or retried
 *   restore: null | { cwd: string, tree: string, files: string[] }
 * }}
 */
function planRewind(messages, userIndex, expectText) {
  if (!Array.isArray(messages)) return null;
  const users = [];
  messages.forEach((m, i) => { if (m && m.kind === 'user') users.push(i); });
  let index = users[userIndex];
  const same = (i) => typeof expectText !== 'string' || (messages[i] && messages[i].text === expectText);
  if (index === undefined || !same(index)) {
    // The ordinal drifted: fall back to the latest user message with that text.
    index = undefined;
    for (let k = users.length - 1; k >= 0; k--) if (same(users[k]) && typeof expectText === 'string') { index = users[k]; break; }
  }
  if (index === undefined) return null;

  // Every message after this one that changed files left a checkpoint. The
  // earliest one's "before" tree is the project as it was right before this
  // message ran; every file any of them touched goes back to that.
  const later = messages.slice(index + 1).filter((m) => m && m.kind === 'checkpoint' && m.beforeTree && Array.isArray(m.files));
  let restore = null;
  if (later.length) {
    const files = [...new Set(later.flatMap((c) => c.files.map((f) => f.file)))];
    restore = { cwd: later[0].cwd, tree: later[0].beforeTree, files };
  }
  return { index, message: messages[index], restore };
}

module.exports = { planRewind };
