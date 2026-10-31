/**
 * Secrets out of event text BEFORE any model reads it (local or cloud). The
 * brain refuses to store secrets, but until now the words still reached the
 * extraction call: an ATM PIN typed in a chat went to the model
 * (CONTINUE.md). Each secret is replaced by a marker the model can see
 * ("[secret removed]") so it knows not to ask about it.
 *
 * What counts as a secret is secret-scan.js: known token formats, and since
 * SECURITY-SECRETS.md also secrets with no known format, by shape (a random
 * key "owm-…", a keypad code "58#14", backup codes "7731-0042") or by a cue
 * word next to them ("locker code 2207", "mera pin 4432 hai").
 *
 * Deliberately not removed: names, email addresses and phone numbers. People
 * are context the brain is for, and the event store keeps them on this PC.
 */
const { MARK, spans } = require('./secret-scan.js');

/**
 * @param {string} text
 * @returns {{ text: string, found: string[], values: string[] }}
 *   found:  the kinds removed (safe to log and store)
 *   values: the removed strings themselves, so the guard can make sure a
 *           model never writes one back; keep them in memory only, NEVER
 *           store, log or send them anywhere
 */
function redact(text) {
  const s = String(text == null ? '' : text);
  const found = []; const values = [];
  let out = ''; let at = 0;
  for (const sp of spans(s)) {
    out += s.slice(at, sp.start) + MARK;
    found.push(sp.why);
    values.push(s.slice(sp.start, sp.end).trim());
    at = sp.end;
  }
  out += s.slice(at);
  return { text: out, found, values };
}

module.exports = { redact, MARK };
