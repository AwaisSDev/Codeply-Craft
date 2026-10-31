// Deterministic time handling for Decide-then-Write: find time expressions
// in event text (English and Roman Urdu) and resolve them against "now" in
// the user's time zone. Rules match the product prompt (context-prompt.js v2)
// and the benchmark guide: "Saturday" = the next Saturday after today,
// "till 5" = the next 17:00, "this week" = Sunday 23:59, "today" = 23:59.

const WD = {
  sunday: 0, sun: 0, itwar: 0, monday: 1, mon: 1, peer: 1, pir: 1, somwar: 1, tuesday: 2, tue: 2, tues: 2, mangal: 2,
  wednesday: 3, wed: 3, budh: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, jumeraat: 4, jumerat: 4,
  friday: 5, fri: 5, jumma: 5, juma: 5, jummah: 5, saturday: 6, sat: 6, hafta: 6, hafte: 6,
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WD_RE = Object.keys(WD).sort((a, b) => b.length - a.length).join('|');
const DAY_WORDS = 'day after tomorrow|tomorrow|tmrw|tmrow|tmr|tomoz|today|tonight|aaj raat|aaj|kal|parsoon|parson|parsun|parso|this weekend|weekend|all week|the whole week|whole week|this week|(?:is|iss|agle|agly)\\s+(?:hafte|hafta|haftay)';
// Durations: "3 weeks", "for two months", "2 more months", "do hafte", "ek mahina".
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, few: 3, couple: 2, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5 };
const DUR = `(?:\\d{1,2}|${Object.keys(NUMW).join('|')})\\s+(?:more\\s+|aur\\s+)?(?:days?|weeks?|months?|din|hafte|haftay|mahine|mahina|mahinay)`;
const PART = '(?:subah|dopahar|dopehar|shaam|sham|raat|morning|evening|night|afternoon)';
const TIME = `(?:(?:${PART}\\s+)?\\d{1,2}(?::\\d{2}|\\.\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.|baje|bje|o'?clock)?|noon|midday|midnight)`;
// One expression: optional lead word, then any mix of day / date / time pieces.
const PIECE = `(?:(?:for|approx\\.?|about|around|another)\\s+)?${DUR}\\b|(?:(?:next|this|coming|agle|is)\\s+)?(?:${WD_RE})\\b|${DAY_WORDS}|(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)(?:\\s+(?:of\\s+)?${MONTH_RE})?|${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}\\s+${MONTH_RE}|\\d{1,2}\\s+ko|(?:at|@|by|till|until|til|before|around|from)?\\s*${TIME}`;
const EXPR = new RegExp(`(?<![\\w:])(?:(?:till|until|til|back by|by|before|on|at|for|tak|se pehle)\\s+(?:about|around|like|approx\\.?|roughly)?\\s*)?(?:${PIECE})(?:[\\s,]+(?:at\\s+|@\\s*|ko\\s+|,\\s*)?(?:${PIECE}))*(?![\\w])`, 'gi');

/** Local calendar parts of a UTC instant in a time zone. */
export function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour, M: +p.minute, wd };
}
const pad = (n) => String(n).padStart(2, '0');
function addDays(p, n) {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}
const ymd = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
function addMonths(p, n) {
  const last = new Date(Date.UTC(p.y, p.m - 1 + n + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(p.y, p.m - 1 + n, Math.min(p.d, last)));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}

/** Every time expression in a text: [{ start, end, text }]. Bare numbers ("3", "2024") are not times. */
export function findTimes(text) {
  const out = [];
  for (const m of String(text || '').matchAll(EXPR)) {
    const t = m[0];
    const s = t.toLowerCase().trim();
    if (/^(?:at|by|on|for|from|till|until)?\s*\d{1,2}$/.test(s) && !/^(?:till|until|by|at)\s/.test(s)) continue; // "3 people", "2 times"
    if (/^\d{1,2}(?::\d{2})?$/.test(s)) continue;
    if (/^(?:on|for|at)\s*$/.test(s)) continue;
    out.push({ start: m.index, end: m.index + t.length, text: t });
  }
  return out;
}

/** Parse an expression into { dayOffset | date, hour, minute, untilish, week } relative to now. */
function parse(expr, now, opts = {}) {
  const s = ` ${expr.toLowerCase().replace(/\s+/g, ' ')} `;
  const r = { day: null, hour: null, minute: 0, part: null, week: false, untilish: /\b(till|until|til|back by|tak|by)\b/.test(s) };
  const dur = s.match(new RegExp(`\\b${DUR}\\b`));
  if (dur) {
    const w = dur[0].trim().split(/\s+/); const n = /^\d+$/.test(w[0]) ? +w[0] : NUMW[w[0]];
    const unit = w[w.length - 1];
    r.dur = /^(day|days|din)$/.test(unit) ? { days: n } : /^(week|weeks|hafte|haftay)$/.test(unit) ? { days: 7 * n } : { months: n };
    return r;
  }
  if (/\b(all week|the whole week|whole week)\b|\b(is|iss)\s+(hafte|hafta|haftay)\b/.test(s)) r.week = true;
  else if (/\b(agle|agly)\s+(hafte|hafta|haftay)\b/.test(s)) { r.week = true; r.nextWeek = true; }
  if (/day after tomorrow|\bpars(on|o|oon|un)\b/.test(s)) r.day = addDays(now, 2);
  else if (/\b(tomorrow|tmrw|tmrow|tmr|tomoz|kal)\b/.test(s)) r.day = addDays(now, 1);
  else if (/\b(today|tonight|aaj)\b/.test(s)) r.day = addDays(now, 0);
  else if (/\bthis week\b/.test(s)) r.week = true;
  else if (/\bweekend\b/.test(s)) r.day = addDays(now, (6 - now.wd + 7) % 7);
  // "aaj se friday tak" / "from today until Friday": the end is the weekday after se / until.
  const sWd = s.match(new RegExp(`\\b(?:se|until|till|tak|to)\\s+(?:next\\s+|this\\s+)?(${WD_RE})\\b|\\b(${WD_RE})\\s+tak\\b`));
  if (opts.end && sWd && r.day && !/(hafta|hafte)/.test(sWd[1] || sWd[2] || '')) r.day = null;  // an END time takes the end of the range; a plan keeps its start
  const wdm = s.replace(/\b(is|iss|agle|agly)\s+(hafte|hafta|haftay)\b/g, ' ').match(new RegExp(`\\b(${WD_RE})\\b`));
  if (!r.day && wdm) {
    const want = WD[wdm[1]];
    let n = (want - now.wd + 7) % 7;
    if (n === 0) n = 7;
    r.day = addDays(now, n);
  }
  let dm = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b`)) || null;
  let dd = null; let mm = null;
  if (dm) { dd = +dm[1]; mm = MONTHS[dm[2].slice(0, 3) === 'sep' ? 'sep' : dm[2].slice(0, 3)]; }
  dm = !dd && s.match(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (dm) { mm = MONTHS[dm[1].slice(0, 3)]; dd = +dm[2]; }
  dm = !dd && s.match(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b|\b(\d{1,2})\s+ko\b/);
  if (dm) dd = +(dm[1] || dm[2]);
  if (dd && !r.day) {
    let y = now.y; let m = mm || now.m;
    if (!mm && dd < now.d) { m += 1; if (m > 12) { m = 1; y += 1; } }
    if (mm && (mm < now.m || (mm === now.m && dd < now.d))) y += 1;
    r.day = addDays({ y, m, d: dd }, 0);
  }
  const part = s.match(new RegExp(`\\b${PART}\\b`));
  r.part = part ? part[0] : (/\btonight\b|aaj raat/.test(s) ? 'night' : null);
  if (/\bnoon|midday\b/.test(s)) { r.hour = 12; r.minute = 0; }
  else if (/\bmidnight\b/.test(s)) { r.hour = 23; r.minute = 59; }
  const tm = s.match(/(?<![\d/])(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?!\s*(?:st|nd|rd|th|ko|people|times|min|hours?|days?|%))(?![\d/])/);
  if (tm && r.hour == null) {
    const isDate = dd && +tm[1] === dd && !tm[2] && !tm[3];
    if (!isDate) {
      let h = +tm[1]; const ap = (tm[3] || '').replace(/\./g, '');
      if (h <= 24) {
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (!ap) {
          if (/raat|night|evening|shaam|sham|dopahar|dopehar|afternoon/.test(r.part || '') && h < 12) h += h === 12 ? 0 : 12;
          else if (!/subah|morning/.test(r.part || '') && h >= 1 && h <= 7) h += 12;
        }
        r.hour = h % 24; r.minute = tm[2] ? +tm[2] : 0;
      }
    }
  }
  return r;
}

/** A plan's `when`: "YYYY-MM-DDTHH:MM", "YYYY-MM-DD", or "" when the expression has no day and no time. */
export function resolvePlan(expr, nowMs, tz) {
  const now = localParts(nowMs, tz);
  const r = parse(expr, now);
  if (r.dur) return ymd(r.dur.days != null ? addDays(now, r.dur.days) : addMonths(now, r.dur.months));
  let day = r.day;
  if (!day && r.week) day = addDays(now, (7 - now.wd) % 7);
  if (!day && r.hour == null) return '';
  if (!day) {
    // A time alone: today if still ahead, else tomorrow.
    day = (r.hour > now.H || (r.hour === now.H && r.minute > now.M)) ? addDays(now, 0) : addDays(now, 1);
  }
  return r.hour == null ? ymd(day) : `${ymd(day)}T${pad(r.hour)}:${pad(r.minute)}`;
}

/** Live context's `until`: "HH:MM" today or "YYYY-MM-DDTHH:MM"; defaults to 23:59 today. */
export function resolveUntil(expr, nowMs, tz) {
  const now = localParts(nowMs, tz);
  const r = expr ? parse(expr, now, { end: true }) : { day: null, hour: null, week: false };
  let day = r.day; let H = r.hour; let M = r.minute || 0;
  if (r.week && !r.day) { day = addDays(now, (7 - now.wd) % 7 + (r.nextWeek ? 7 : 0)); H = 23; M = 59; }
  // A duration ("3 weeks", "for two months"): that long from today, end of day.
  if (r.dur) { day = r.dur.days != null ? addDays(now, r.dur.days) : addMonths(now, r.dur.months); H = 23; M = 59; }
  // "till the weekend" / "is weekend tak": the end of the weekend (Sunday 23:59); a weekend PLAN stays Saturday.
  if (/weekend/i.test(expr || '') && !r.dur && r.hour == null) { day = addDays(now, (7 - now.wd) % 7); H = 23; M = 59; }
  if (H == null) { H = 23; M = 59; }
  if (!day) {
    // "till 5": the next 17:00 (or 05:00) after now.
    const ahead = (h) => h > now.H || (h === now.H && M > now.M);
    if (r.hour != null && r.hour < 12 && !ahead(r.hour) && ahead(r.hour + 12)) H = r.hour + 12;
    day = ahead(H) ? addDays(now, 0) : addDays(now, 1);
  }
  if (day.y === now.y && day.m === now.m && day.d === now.d) return `${pad(H)}:${pad(M)}`;
  return `${ymd(day)}T${pad(H)}:${pad(M)}`;
}

const hasDay = (t) => new RegExp(`\\b(${WD_RE}|${DAY_WORDS})\\b|\\d(?:st|nd|rd|th)\\b|\\d{1,2}\\s+ko\\b|${MONTH_RE}`, 'i').test(t);
const hasHour = (t) => /\d\s*(?:am|pm|a\.m\.|p\.m\.|baje|bje)|\d[:.]\d{2}|noon|midday|midnight|(?:till|until|til|by|at|around|about)\s+\d/i.test(t);
const gapOf = (t, a, b) => (t.start >= b ? t.start - b : (t.end <= a ? (a - t.end) * 1.5 : 0));

/**
 * The time expression for the item at characters [a, b): within maxGap, the most specific one
 * (day and hour > one of them), then the nearest (after the item before before it).
 */
export function nearestTime(times, a, b, maxGap = 80) {
  let best = null;
  for (const t of times) {
    const gap = gapOf(t, a, b);
    if (gap > maxGap) continue;
    const spec = (hasDay(t.text) ? 1 : 0) + (hasHour(t.text) ? 1 : 0);
    if (!best || spec > best.spec || (spec === best.spec && gap < best.gap)) best = { ...t, gap, spec };
  }
  return best;
}

/** A plan's `when` from the expressions around it: the best one, completed by a nearby day or hour it lacks. */
export function planWhen(times, a, b, nowMs, tz, maxGap = 120) {
  const t = nearestTime(times, a, b, maxGap);
  if (!t) return { when: '', text: '' };
  let expr = t.text;
  const near = times.filter((x) => x !== t && Math.min(Math.abs(x.start - t.end), Math.abs(t.start - x.end)) <= 60);
  if (!hasHour(expr)) { const h = near.find((x) => hasHour(x.text)); if (h) expr = `${expr} ${h.text}`; }
  if (!hasDay(expr)) { const d = near.find((x) => hasDay(x.text)); if (d) expr = `${d.text} ${expr}`; }
  return { when: resolvePlan(expr, nowMs, tz), text: expr };
}
