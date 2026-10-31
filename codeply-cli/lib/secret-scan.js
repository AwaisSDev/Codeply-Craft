/**
 * One secret detector for everything that can reach the brain
 * (SECURITY-SECRETS.md). Used by:
 *
 *   context-redact.js   secrets out of event text before any model reads it
 *   context-schema.js   the guard: a model's observation or plan that holds a
 *                       secret is dropped (fail closed)
 *   brain.js            observe() and correct() refuse it; contextBlock(),
 *                       recall and every other read skip a stored memory that
 *                       looks like one; sweepSecrets() cleans an existing brain
 *
 * Regexes for known token formats are not enough: an API key in a format no
 * one listed ("owm-Kt9F3cQe7Xb24dRw46ZpLm") or a door code ("58#14") has no
 * pattern. So several signals are combined, and any one of them is enough:
 *
 *   pattern   a known secret format (private keys, sk-…, ghp_…, AKIA…, JWTs,
 *             bearer tokens, card numbers with a valid Luhn check, IBANs, …)
 *   topic     the text talks about a secret ("password", "PIN", "OTP",
 *             "door code", "backup codes", "API key", …): a memory about a
 *             secret is never needed, so it is not kept even without a value
 *   strong    a token that is a secret by its shape alone: a long random
 *             string, prefix-plus-random ("owm-…"), digits with # or *
 *             ("58#14", "*1234#"), equal groups of digits ("7731-0042"), a
 *             word with digits and symbols ("Sameer@786")
 *   cue       an ordinary-looking token (2207, 4432, TigerNoodle99) right
 *             after (or, as Roman Urdu puts it, right before) a cue word in
 *             the same sentence: "locker code 2207", "mera pin 4432 hai",
 *             "482913 ye OTP aya hai"
 *   source    the observation repeats a value that the source events marked
 *             as secret, or that the redactor removed from them
 *   mark      it repeats the redactor's "[secret removed]" marker
 *
 * When unsure, the answer is "secret": a missed memory can be said again, a
 * stored secret cannot be unsaid. Ordinary numbers (prices, times, dates,
 * ages, room numbers, years, versions, scores) are not secrets on their own;
 * scripts/secret-test.mjs and ml/eval measure how many such memories are lost.
 *
 * Nothing here returns or logs a secret's value except spans()/secretValues(),
 * which the redactor and the guard use in memory and never store.
 */

const MARK = '[secret removed]';
const MARK_RE = /\[?\s*secret[\s_-]*removed\s*\]?/i;

// ─── Known formats ──────────────────────────────────────────────────────────

// [name, pattern]; order matters: specific token formats first.
const PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['api key', /\b(?:sk|pk|rk)-(?:live-|test-|proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['aws key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack token', /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g],
  ['stripe key', /\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{10,}\b/g],
  ['gitlab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['url credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi],
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

const NOT_A_PASSWORD = /^(is|was|for|the|a|an|to|of|and|or|reset|change|changed|manager|again|please|protected|removed|secret)$/i;

/**
 * Every known-format match: [{ name, start, end, keep }] where keep is a
 * prefix of the match to leave in place ("password is ", "Bearer ").
 */
function patternMatches(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      const whole = m[0];
      let keep = 0;
      if (name === 'card number') {
        const digits = whole.replace(/\D/g, '');
        if (digits.length < 13 || digits.length > 19 || !luhn(digits)) continue;
      }
      if (name === 'password' || name === 'pin') {
        const value = m[4];
        // "I reset my password yesterday": a plain word with no "is", ":" or "=" is not a password.
        const explicit = /(is|was|=|:|-)/i.test(m[2] || '') || m[3];
        if (!explicit && /^[a-z]+[.!?]*$/.test(value)) continue; // "password rotation." is not a password
        if (NOT_A_PASSWORD.test(value) || value.startsWith('[')) continue;
        keep = m[1].length + (m[2] || '').length;
      }
      if (name === 'bearer token') keep = m[1].length + 1;
      out.push({ name, start: m.index, end: m.index + whole.length, keep });
    }
  }
  return out;
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

const LEAD = /^[("'`<{[]+/;
const TRAIL = /[)"'`>}\],.;:!?]+$/;

/** Words with their place: { word (as written, trimmed), lc, start, end, stop (sentence ends after), pause (any punctuation after) }. */
function tokenize(text) {
  const s = String(text == null ? '' : text);
  const marks = [];
  const mr = new RegExp(MARK_RE.source, 'gi');
  let mm;
  while ((mm = mr.exec(s))) marks.push([mm.index, mm.index + mm[0].length]);
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s))) {
    const raw = m[0];
    const lead = (raw.match(LEAD) || [''])[0].length;
    let core = raw.slice(lead);
    const trail = (core.match(TRAIL) || [''])[0];
    core = core.slice(0, core.length - trail.length);
    const start = m.index + lead;
    const after = s.slice(m.index + raw.length, m.index + raw.length + 3);
    out.push({
      word: core, lc: core.toLowerCase(), start, end: start + core.length,
      stop: /[.!?;]/.test(trail) || /^\s*\n/.test(after) || /^\s*$/.test(s.slice(m.index + raw.length)),
      pause: !!trail || /^\s*\n/.test(after),
      colon: /[:=]/.test(trail) || /^\s*[:=]/.test(after),
      mark: marks.some(([a, b]) => m.index < b && m.index + raw.length > a),
    });
  }
  return out;
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

const TIME_RE = /^\d{1,2}(?::\d{2})?(?:am|pm|a\.m|p\.m)?$|^\d{1,2}:\d{2}(?::\d{2})?$/i;
const ORDINAL_RE = /^\d+(?:st|nd|rd|th)$/i;
const UNIT_RE = /^[$£€₹]?\d+(?:[.,]\d+)?(?:k|m|b|bn|kg|g|mg|km|cm|mm|ml|l|gb|mb|kb|tb|hz|khz|mhz|ghz|mp|px|pt|x|h|hr|hrs|min|mins|s|sec|secs|ms|d|yo|yrs|lb|lbs|ft|in|%|°c|°f|c|f|w|kw|mah|v|fps|p)$/i;
const VERSION_RE = /^v?\d+(?:\.\d+)+[a-z]?$|^v\d+$/i;
const DECIMAL_RE = /^[$£€₹]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^[$£€₹]?\d+\.\d+$/;
const MONEY_RE = /^(?:[$£€₹]|rs\.?|pkr|usd|aed|gbp|eur|inr|sar)\d/i;
const DATE_RE = /^\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{1,4})?$/;
const SCORE_RE = /^\d{1,3}[-–:]\d{1,3}$/;
const EXPIRY_RE = /^(?:0[1-9]|1[0-2])\/(?:\d{2}|20\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?$/i;

/** Ordinary numbers and number-words: never a secret by shape, and not after a cue either. */
function ordinaryNumber(w) {
  return ISO_RE.test(w) || TIME_RE.test(w) || ORDINAL_RE.test(w) || UNIT_RE.test(w) || VERSION_RE.test(w) || DECIMAL_RE.test(w) || MONEY_RE.test(w) || SCORE_RE.test(w);
}

/** Runs of the same character class (lower, upper, digit): random strings switch class often. */
function classRuns(s) {
  let runs = 0; let prev = ''; let len = 0; let maxLetters = 0;
  for (const ch of s) {
    const c = /[a-z]/.test(ch) ? 'l' : /[A-Z]/.test(ch) ? 'u' : /[0-9]/.test(ch) ? 'd' : '';
    if (!c) continue;
    if (c !== prev) { runs++; len = 0; }
    len++;
    if (c !== 'd') maxLetters = Math.max(maxLetters, len);
    prev = c;
  }
  return { runs, maxLetters };
}
/**
 * Random-looking: one unbroken stretch of letters and digits that switches
 * between lower case, upper case and digits often, with no run of letters
 * long enough to be a word ("Kt9F3cQe7Xb24dRw46ZpLm" yes; "MyProject2024Final",
 * "Qwen3-1.7B-Instruct-Q4_K_M" and "src/components/Header2.tsx" no).
 */
function randomish(s, minLen) {
  const seg = String(s).split(/[^A-Za-z0-9]+/).sort((a, b) => b.length - a.length)[0] || '';
  if (seg.length < minLen || !/\d/.test(seg) || !/[A-Za-z]/.test(seg)) return false;
  const { runs, maxLetters } = classRuns(seg);
  return runs >= 6 && runs / seg.length >= 0.3 && maxLetters <= 5;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const URLISH_RE = /:\/\/|^www\.|\.(?:com|org|net|io|dev|app|pk|ae|uk)(?:\/|$)/i;

/** A token that is a secret by its shape alone, or ''. */
function strongShape(w) {
  if (!w || w.length < 4 || !/\d/.test(w)) return '';
  if (EMAIL_RE.test(w) || URLISH_RE.test(w)) return '';
  // 58#14, *1234#, 1234#: a keypad code (not "#123", an issue number)
  if (/^[*#\d]+$/.test(w) && (w.match(/\d/g) || []).length >= 3 && /[*#]/.test(w.replace(/^#+/, ''))) return 'keypad code';
  // 7731-0042, ab12-cd34-ef56: equal groups (backup and recovery codes)
  if (/^[A-Za-z0-9]{4,6}(?:-[A-Za-z0-9]{4,6})+$/.test(w)) {
    const g = w.split('-');
    if (g.every((x) => x.length === g[0].length && /\d/.test(x)) && !ordinaryGroups(g)) return 'grouped code';
  }
  // owm-Kt9F3cQe7Xb24dRw46ZpLm: a short prefix and a random tail
  const pre = /^[A-Za-z][A-Za-z0-9]{0,15}[-_.]([A-Za-z0-9_.-]{12,})$/.exec(w);
  if (pre && randomish(pre[1], 12)) return 'prefixed key';
  if (/^[A-Za-z0-9+/_=.-]{16,}$/.test(w) && randomish(w, 16)) return 'random string';
  // Sameer@786, Kh@1ber_2026!: letters, digits and symbols together
  if (w.length >= 6 && /[A-Za-z]/.test(w) && /[@$%^&!~?*]/.test(w.slice(1)) && !/^[@#]/.test(w) && !/^[A-Za-z]{0,3}[$£€₹]\d/.test(w)) return 'password-like';
  return '';
}

const YEAR = (x) => /^\d{4}$/.test(x) && +x >= 1900 && +x <= 2099;
const HHMM = (x) => /^\d{4}$/.test(x) && +x.slice(0, 2) <= 23 && +x.slice(2) <= 59;
/** 2019-2023, 0900-1700, 5000-8000: ranges of years, times or round numbers. */
function ordinaryGroups(g) {
  if (!g.every((x) => /^\d+$/.test(x))) return false;
  return g.every(YEAR) || g.every(HHMM) || g.every((x) => /00$/.test(x));
}

/** A token that is a secret when a cue word points at it. */
function weakShape(w, cue) {
  if (!w || !/\d/.test(w)) {
    // Letters only: a secret only right after "password is" (handled by the caller).
    return false;
  }
  if (cue === 'expiry') return EXPIRY_RE.test(w);
  if (ordinaryNumber(w) || DATE_RE.test(w)) return false;
  if (HARD.has(bare(w.toLowerCase()))) return false;
  const digits = (w.match(/\d/g) || []).length;
  if (/^\d+$/.test(w)) return cue !== 'soft' && digits >= 3 && digits <= 19;
  if (cue === 'soft') return w.length >= 6 && /[A-Za-z]/.test(w);
  return w.length >= 3;
}

// ─── Cues ───────────────────────────────────────────────────────────────────

// Always a cue: whatever code-like value follows is a secret.
const HARD = new Set(('password passwords passwd pwd passcode passcodes passphrase pasword paswrd paswd pin pins pincode otp otps ' +
  'cvv cvc cvv2 cvn 2fa mfa totp combination combo secret secrets khufia token tokens apikey api-key ssn cnic iban puk').split(' '));
// Before "code(s)": the kinds of codes that open something.
const CODE_QUAL = new Set(('door gate locker lock alarm access entry entrance building garage safe security verification verify confirmation ' +
  'auth authentication login backup recovery otp pin pass unlock wifi wi-fi parking lift elevator keypad combination reset 2fa mfa sms bank atm ' +
  'card sort one-time time darwaze darwaza darwazay tala taala ghar apartment flat house home main front back office cabinet bike cycle padlock ' +
  'vault khufia secret private personal master admin root device phone screen sim puk voicemail gift voucher redeem redemption activation ' +
  'license licence serial account portal app').split(' '));
// Codes that are not secrets.
const CODE_NOT = new Set(('zip postal post postcode area country dial dialing dialling source dress qr bar colour color error status exit morse ' +
  'iata airport language hs tax product discount promo coupon referral invite invitation course class subject flight train booking html css ' +
  'python js javascript java the my your our his her their this that clean legacy sample example vs visual studio claude xcode opencode unicode ' +
  'barcode modern old new production prod test tests').split(' '));
// Before "key(s)": secret keys (an API key) as opposed to key points.
const KEY_QUAL = new Set(('api access secret license licence product private ssh gpg pgp encryption wifi wi-fi activation serial recovery auth ' +
  'master root admin signing deploy client server stripe openai anthropic aws google firebase supabase maps weather openweather twilio sendgrid ' +
  'mapbox github gitlab slack discord telegram bot app').split(' '));
const KEY_NOT_AFTER = new Set(('decision decisions point points takeaway takeaways feature features metric metrics part parts factor factors person ' +
  'people player players role roles insight insights idea ideas date dates moment moments word words stakeholder stakeholders result results ' +
  'reason reasons requirement requirements benefit benefits issue issues question questions step steps area areas skill skills component ' +
  'components task tasks goal goals change changes difference differences figure figures topic topics of lime').split(' '));
// Need a password-like value (letters and digits), not a plain number: "login rate limit 100" is not a secret.
const SOFT = new Set('login logins credentials creds signin sign-in'.split(' '));
const NUMBER_WORDS = new Set(['number', 'no', 'num', '#']);
const NUMBER_QUAL = new Set('account acct card routing iban cnic ssn passport'.split(' '));
const EXPIRY = new Set('exp expiry expires expiration valid'.split(' '));
const COPULA = new Set('is was are were = : - => -> hai hy he ha hain tha thi'.split(' '));
const FILLER = new Set(('a an the my our your his her their its this that it it\'s its is was are were = : - hai hy he ha hain tha thi ka ki ke ' +
  'mera meri mere apna apni for of on at to and now still new old here').split(' '));
const NOT_VALUE = /^(a|an|the|not|too|very|same|different|changed|reset|expired|weak|strong|long|short|saved|stored|in|on|at|with|and|or|but|also|still|now|removed|secret|hidden|private|safe|wrong|right|correct|incorrect|required|needed|missing|set|written|somewhere|there|here|what|which|on|off|known|unknown)$/i;

const bare = (w) => w.replace(/^[^a-z0-9#*]+|[^a-z0-9#*]+$/gi, '').toLowerCase();

/** The cue at token i, if any: 'hard' | 'soft' | 'expiry' | ''. */
function cueAt(toks, i) {
  const w = bare(toks[i].lc);
  const prev = i > 0 ? bare(toks[i - 1].lc) : '';
  const prev2 = i > 1 ? bare(toks[i - 2].lc) : '';
  const next = i + 1 < toks.length ? toks[i + 1] : null;
  const nextW = next ? bare(next.lc) : '';
  const nextLooksValue = next && (COPULA.has(nextW) || COPULA.has(next.lc) || /\d/.test(next.word) || toks[i].colon);
  if (toks[i].mark) return '';
  if (HARD.has(w)) return 'hard';
  if (w === 'code' || w === 'codes' || w === 'kod') {
    if (CODE_NOT.has(prev) && !CODE_QUAL.has(prev)) return '';
    if (CODE_QUAL.has(prev) || (CODE_QUAL.has(prev2) && /^(ka|ki|ke|of|for|the|my|our)$/.test(prev))) return 'hard';
    if (nextLooksValue && !CODE_NOT.has(prev)) return 'hard';
    return '';
  }
  if (w === 'key' || w === 'keys') {
    if (KEY_NOT_AFTER.has(nextW)) return '';
    if (KEY_QUAL.has(prev)) return 'hard';
    if (nextLooksValue) return 'soft';
    return '';
  }
  if (SOFT.has(w)) return 'soft';
  if (NUMBER_WORDS.has(w) && NUMBER_QUAL.has(prev)) return 'hard';
  if (EXPIRY.has(w)) return 'expiry';
  return '';
}

/**
 * Secret spans in a text by shape and cue: [{ start, end, why }]. Known
 * formats (patternMatches) are separate.
 */
function shapeSpans(text) {
  const s = String(text == null ? '' : text);
  const toks = tokenize(s);
  const out = [];
  const add = (t, why) => { if (t.word && !t.mark) out.push({ start: t.start, end: t.end, why }); };
  // Strong shapes anywhere.
  toks.forEach((t) => { const why = strongShape(t.word); if (why) add(t, why); });
  // Equal groups of digits split by spaces: "7731 0042".
  const grp = /(?<![\d+][ -]?)(?<![\d+])\b(\d{4,6})((?: \d{4,6})+)\b(?![ -]?\d)/g;
  let m;
  while ((m = grp.exec(s))) {
    const g = m[0].split(' ');
    if (g.every((x) => x.length === g[0].length) && !ordinaryGroups(g)) out.push({ start: m.index, end: m.index + m[0].length, why: 'grouped code' });
  }
  // Cue words and what they point at.
  for (let i = 0; i < toks.length; i++) {
    const cue = cueAt(toks, i);
    if (!cue) continue;
    // After the cue, in the same sentence, up to 6 words on. Right after a
    // copula ("password is …", "pin: …", "code hai …") even a plain word is the value.
    // "password is sunflower", "pin: sunflower"; not "OTP aya hai daraz se" (a word came between).
    let afterCopula = false; let clean = true;
    for (let j = i + 1; j < toks.length && j - i <= 6; j++) {
      if (toks[j - 1].stop) break;
      const t = toks[j];
      if (t.mark) break; // the redactor already took the value
      if (weakShape(t.word, cue)) add(t, cue === 'expiry' ? 'expiry date' : 'value after a cue');
      else if (cue === 'hard' && clean && (afterCopula || (j === i + 1 && toks[i].colon)) && t.word.length >= 4 && !NOT_VALUE.test(t.word) && !FILLER.has(t.lc) && /^[A-Za-z][A-Za-z'-]*$/.test(t.word)) add(t, 'value after a cue');
      if (COPULA.has(t.lc) || COPULA.has(bare(t.lc))) afterCopula = true;
      else if (!FILLER.has(t.lc)) { afterCopula = false; clean = false; }
    }
    // Before the cue (Roman Urdu: "482913 ye OTP aya hai"), up to 3 words back, no punctuation between.
    if (cue !== 'expiry') {
      for (let j = i - 1; j >= 0 && i - j <= 3; j--) {
        if (toks[j].pause || toks[j].mark) break;
        if (weakShape(toks[j].word, cue)) add(toks[j], 'value before a cue');
      }
    }
  }
  return mergeSpans(out);
}

function mergeSpans(spans) {
  const sorted = spans.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const sp of sorted) {
    const last = out[out.length - 1];
    if (last && sp.start < last.end) { last.end = Math.max(last.end, sp.end); continue; }
    out.push({ ...sp });
  }
  return out;
}

// ─── Topic ──────────────────────────────────────────────────────────────────

// brain.SECRET_RE as it was: text that names one of these is refused even with no value in it
// (unchanged on purpose, so nothing the brain refused before is kept now).
const TOPIC_RE = /(?:api[_ -]?key|password|passwd|passcode|secret|token|bearer|private key|pin code|cvv|card number|iban|ssn)\b|\bsk-[a-z0-9]{8,}/i;
// What the Benchmark-520 leaks showed was missing. These are refused when the text also holds a
// code-like value anywhere ("locker code location: 2207 at the gym"), but not on their own:
// "sign-in is phone OTP only now" is a real project decision, and it holds no secret.
const TOPIC_VALUE_RE = new RegExp([
  String.raw`\b(?:pin|pin number|otps?|totp|cvc|passphrases?|passcodes?|2fa codes?|mfa codes?|one[- ]time (?:code|password|pin)s?|seed phrases?|recovery phrases?|mnemonic phrases?)\b`,
  String.raw`\b(?:door|gate|locker|lock|alarm|access|entry|entrance|building|garage|safe|security|verification|confirmation|auth|authentication|login|backup|recovery|unlock|wi-?fi|parking|lift|elevator|keypad|reset|sms|bank|atm|card|sort|padlock|vault|screen|sim|puk|voicemail|master|admin|root|activation)[ -]codes?\b`,
  String.raw`\b(?:darwaz[ae]y?|tal?aa?|ghar|locker|lock) k[aie] (?:code|pin|password)\b`,
  String.raw`\b(?:${[...KEY_QUAL].join('|')})[ -]keys?\b(?! (?:${[...KEY_NOT_AFTER].join('|')})\b)`,
  String.raw`\b(?:login|sign[- ]?in) (?:details|credentials|info)\b|\bcredentials\b|\bkhufia\b`,
  String.raw`\b(?:lock|safe) combination\b|\bcombination (?:lock|code)\b`,
  String.raw`\b(?:account|acct|routing|card|cnic|ssn) (?:number|no\.?|#)`,
].join('|'), 'i');

/** Tokens in the text that could be a code or a key (any shape a cue would accept). */
function codeLikeTokens(text) {
  return tokenize(text).filter((t) => !t.mark && (strongShape(t.word) || weakShape(t.word, 'hard') || EXPIRY_RE.test(t.word))).map((t) => t.word);
}
const hasCodeLikeValue = (text) => codeLikeTokens(text).length > 0;
/** Placeholders this code writes itself (change log, hidden memories): never counted as secrets. */
const PLACEHOLDERS = new Set(['(hidden: it looked like a secret)', 'something that looked like a secret', '(hidden: looked sensitive)', 'something that looked sensitive (not kept)']);

// ─── Public ─────────────────────────────────────────────────────────────────

/**
 * Every secret span in a text (known formats, shapes, cues): [{ start, end, why, keep }].
 * keep: a leading part to leave in place ("password is ").
 */
function spans(text) {
  const s = String(text == null ? '' : text);
  const all = [
    ...patternMatches(s).map((p) => ({ start: p.start + p.keep, end: p.end, why: p.name })),
    ...shapeSpans(s),
  ].filter((x) => x.end > x.start);
  return mergeSpans(all);
}

/** The secret values in some texts, for comparing against a model's output (in memory only; never store these). */
function secretValues(texts) {
  const out = new Set();
  for (const t of [].concat(texts || [])) {
    const s = String(t == null ? '' : t);
    for (const sp of spans(s)) {
      const v = s.slice(sp.start, sp.end).trim();
      if (v.length >= 3 && !MARK_RE.test(v)) out.add(v);
    }
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does text contain this value (as a whole token; digits also compared without separators)? */
function containsValue(text, value) {
  const t = String(text || ''); const v = String(value || '').trim();
  if (!v) return false;
  if (new RegExp(`(?<![A-Za-z0-9])${esc(v)}(?![A-Za-z0-9])`, 'i').test(t)) return true;
  const dv = v.replace(/[\s-]/g, '');
  if (/^\d{6,}$/.test(dv)) return t.replace(/(?<=\d)[\s-](?=\d)/g, '').includes(dv);
  return false;
}

/**
 * Why a piece of text looks like (or is about) a secret, or '' if it does not.
 * @param {string|string[]} texts
 * @param {{ secrets?: Iterable<string>, topic?: boolean }} [o]
 *   secrets: values the source marked as secret (secretValues of the events, the redactor's removed values)
 *   topic:   false to look only for secret values, not for text about secrets (bot tool tips may say "refresh the token")
 */
function why(texts, o = {}) {
  const list = [].concat(texts || []).map((x) => String(x == null ? '' : x)).filter((x) => x && !PLACEHOLDERS.has(x.trim()));
  if (!list.length) return '';
  const joined = list.join(' \n ');
  if (MARK_RE.test(joined)) return 'mark';
  if (o.topic !== false && TOPIC_RE.test(joined)) return 'topic';
  if (patternMatches(joined).length) return 'pattern';
  for (const s of list) {
    for (const sp of shapeSpans(s)) return /cue/.test(sp.why) || sp.why === 'expiry date' ? 'cue' : 'strong';
  }
  if (o.topic !== false && TOPIC_VALUE_RE.test(joined) && hasCodeLikeValue(joined)) return 'topic+value';
  if (o.secrets) for (const v of o.secrets) if (containsValue(joined, v)) return 'source';
  return '';
}

/** An observation (or anything with slot, value, text): why it holds a secret, or ''. */
function observationWhy(o, opts = {}) {
  if (!o || typeof o !== 'object') return '';
  const parts = [o.slot, o.value, o.text, o.fact, o.what, o.where, ...(Array.isArray(o.who) ? o.who : [])].filter((x) => x != null && x !== '');
  // The slot names what the value is: "locker code" + "2207 at the gym".
  const labelled = o.slot && o.value ? [`${o.slot} is ${o.value}`] : [];
  return why([...parts.map(String), ...labelled], opts);
}

/** A stored memory, including what it used to say and what challenged it. */
function memoryWhy(m) {
  if (!m) return '';
  const own = observationWhy(m);
  if (own) return own;
  if (m.challenger) { const c = observationWhy(m.challenger); if (c) return `challenger: ${c}`; }
  for (const h of m.history || []) { const x = observationWhy(h); if (x) return `history: ${x}`; }
  return '';
}

module.exports = { MARK, MARK_RE, PATTERNS, TOPIC_RE, TOPIC_VALUE_RE, codeLikeTokens, containsToken: (t, v) => containsValue(t, v), luhn, patternMatches, spans, secretValues, containsValue, why, observationWhy, memoryWhy, strongShape, tokenize };
