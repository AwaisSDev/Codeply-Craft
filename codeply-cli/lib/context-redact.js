/**
 * Secrets out of event text BEFORE any model reads it (local or cloud). The
 * brain refuses to store secrets (brain.SECRET_RE), but until now the words
 * still reached the extraction call: an ATM PIN typed in a chat went to the
 * model (CONTINUE.md). Each secret is replaced by a marker the model can see
 * ("[secret removed]") so it knows not to ask about it.
 *
 * Deliberately not removed: names, email addresses and phone numbers. People
 * are context the brain is for, and the event store keeps them on this PC.
 */

const MARK = '[secret removed]';

// [name, pattern] — order matters: specific token formats first.
const PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['api key', /\b(?:sk|pk|rk)-(?:live-|test-|proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['google key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack token', /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['bearer token', /\b(bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi],
  // "password is hunter2", "my pin: 4821", "otp 552190", "cvv 123"
  ['password', /\b(pass(?:word|wd|code|phrase)|wifi key)\b(\s*(?:is|was|=|:|-)?\s*)(["'`]?)([^\s"'`,;]{3,64})\3/gi],
  ['pin', /\b(pin(?:\s*code)?|otp|cvv|cvc|security code|one[- ]time code|verification code)\b(\s*(?:is|was|=|:|-)?\s*)(["'`]?)(\d{3,12})\3/gi],
  ['iban', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g],
  ['card number', /\b(?:\d[ -]?){13,19}\b/g],
  ['long secret', /\b(?=[A-Za-z0-9+/_-]{32,}\b)(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g],
];

/** Luhn check, so an order number or a phone number is not taken for a card. */
function luhn(digits) {
  let sum = 0; let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * @param {string} text
 * @returns {{ text: string, found: string[] }} found: the kinds removed (never the values)
 */
function redact(text) {
  let out = String(text == null ? '' : text);
  const found = [];
  for (const [name, re] of PATTERNS) {
    out = out.replace(re, (...m) => {
      const whole = m[0];
      if (name === 'card number') {
        const digits = whole.replace(/\D/g, '');
        if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return whole;
      }
      if (name === 'password' || name === 'pin') {
        // Keep the label so the model knows a password existed, drop the value.
        const value = m[4];
        // "I reset my password yesterday": a plain word with no "is", ":" or "=" is not a password.
        const explicit = /(is|was|=|:|-)/i.test(m[2] || '') || m[3];
        if (!explicit && /^[a-z]+$/.test(value)) return whole;
        if (/^(is|was|for|the|a|an|to|of|and|or|reset|change|changed|manager|again|please|protected)$/i.test(value)) return whole;
        found.push(name);
        return `${m[1]}${m[2] || ' '}${MARK}`;
      }
      if (name === 'bearer token') { found.push(name); return `${m[1]} ${MARK}`; }
      found.push(name);
      return MARK;
    });
  }
  return { text: out, found };
}

module.exports = { redact, MARK };
