/**
 * Reaching the user on their phone, for bots: a text (a push notification) or
 * a call (the phone rings with the bot's voice), now or at a set time, and
 * "tell me when an email from X arrives" alerts for the inbox watcher.
 *
 * The engine only knows the tools. The host (Craft's main process) registers
 * the handler, since it holds the Codeply sign-in that Codeply's reminders
 * function needs. With no handler (the plain CLI), the tools are not offered.
 */

let handler = null;

/** h: { reach({ botId, how, message, at }), watchEmail({ botId, from, how, note, repeat }) }, each resolving to { ok, output } */
function setHandler(h) { handler = h && typeof h.reach === 'function' ? h : null; }
function available() { return !!handler; }

const HOW = { call: 'call', ring: 'call', phone: 'call', text: 'text', message: 'text', push: 'text', notify: 'text', notification: 'text' };

/** "17:30", "5pm", an ISO time, or "in 20 minutes" to a Date in the future, or null for now. */
function parseWhen(v, now = new Date()) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || s === 'now') return null;
  const rel = /^in\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(s);
  if (rel) return new Date(now.getTime() + Number(rel[1]) * (rel[2].startsWith('h') ? 3600e3 : 60e3));
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (clock) {
    let h = Number(clock[1]) % 24;
    const m = Number(clock[2] || 0);
    if (clock[3] === 'pm' && h < 12) h += 12;
    if (clock[3] === 'am' && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function reachMe(args, ctx) {
  if (!handler) return { ok: false, output: 'Reaching the phone is only available in the Craft app.' };
  const how = HOW[String(args.how || 'text').trim().toLowerCase()];
  if (!how) return { ok: false, output: 'reach_me needs <how> set to call or text.' };
  const message = String(args.message || '').trim().slice(0, 480);
  if (!message) return { ok: false, output: 'reach_me needs a <message>: what to tell the user.' };
  const at = parseWhen(args.at);
  if (at === undefined) return { ok: false, output: `Could not read the time "${args.at}". Use 17:30, 5pm, "in 20 minutes" or an ISO time.` };
  const r = await handler.reach({ botId: ctx.botId || null, how, message, at });
  const when = at ? ` at ${at.toLocaleString()}` : '';
  return r.ok
    ? { ok: true, output: `${how === 'call' ? 'Call' : 'Text'} scheduled to the user's phone${when || ' now'}. It arrives within about a minute of that time.`, meta: { label: `${how === 'call' ? 'Call' : 'Text'}${when}: ${message.slice(0, 60)}` } }
    : { ok: false, output: r.output || 'Could not reach the phone.', meta: { label: 'phone not reached' } };
}

async function watchEmail(args, ctx) {
  if (!handler || typeof handler.watchEmail !== 'function') return { ok: false, output: 'Email alerts are only available in the Craft app.' };
  const from = String(args.from || '').trim().toLowerCase().replace(/^mailto:/, '');
  if (!/^[^\s@]*@?[^\s@]+\.[^\s@]+$/.test(from)) return { ok: false, output: 'watch_email needs <from>: an email address or a domain like example.com.' };
  const how = HOW[String(args.how || 'text').trim().toLowerCase()] || 'text';
  const r = await handler.watchEmail({ botId: ctx.botId || null, from, how, note: String(args.note || '').slice(0, 200), repeat: /^(1|true|yes|always|every)/i.test(String(args.repeat || '')) });
  return r.ok
    ? { ok: true, output: r.output, meta: { label: `Watching for ${from}` } }
    : { ok: false, output: r.output || 'Could not set the alert.' };
}

module.exports = { setHandler, available, parseWhen, reachMe, watchEmail };
