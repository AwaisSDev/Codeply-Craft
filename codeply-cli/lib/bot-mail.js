/**
 * A bot's own email (shella@codeply.app): the engine side of bot_email_send.
 *
 * The engine only knows the tool. The host (Craft's bots-mail.js) registers
 * the handler, since it holds the Codeply sign-in that the bot-mail function
 * needs; the Resend key never leaves Codeply's server. With no handler (the
 * plain CLI) the tool is not offered.
 */

let handler = null;

/** h: { send({ botId, to, subject, text, replyTo }), thread(id) } each resolving to { ok, ... } */
function setHandler(h) { handler = h && typeof h.send === 'function' ? h : null; }
function available() { return !!handler; }

/** The bot's address, or '' (the bot file is the truth: bots.js normalizeEmail). */
function addressOf(botId) {
  if (!botId) return '';
  try { const b = require('./bots.js').getBot(botId); return (b && b.email && b.email.on && b.email.address) || ''; } catch { return ''; }
}

/** What a reply to a received bot email needs: who, the subject, and the thread headers. */
async function threadOf(id) {
  if (!handler || typeof handler.thread !== 'function' || !id) return null;
  try { return await handler.thread(String(id)); } catch { return null; }
}

async function send(o) {
  if (!handler) return { ok: false, output: 'Bot email is only available in the Craft app.' };
  return handler.send(o);
}

const RULES = (address, native) => `YOUR OWN EMAIL
You have your own address: ${address}. Use bot_email_send to email as yourself; every email you send ends with a line saying you are the user's AI assistant, and replies come back to you. Use gmail_send only when the user wants mail to come from their own Gmail. Never sign as the user or write as if you were them. The user's whole crew shares 50 emails a month and 10 a day (sent and received together), so write only when it matters.${native ? '' : `

To email as yourself, write:
<codeply:bot_email_send>
<to>someone@example.com</to>
<subject>Friday</subject>
<body>
Hi Sara, ...
</body>
<reply_to>(optional: the id of the email you are answering)</reply_to>
</codeply:bot_email_send>`}`;

module.exports = { setHandler, available, addressOf, threadOf, send, RULES };
