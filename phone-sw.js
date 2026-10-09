// Codeply phone app service worker: reminders and "calls" from your bots.
//
// reminders-tick (Codeply's server) sends a Web Push when a reminder is due:
//   { title: bot name, body: text, reminderId, kind: 'remind'|'call'|'task', botId, botVoice, key, url }
// This shows it as a notification. Tapping it opens (or focuses) the app on
// an incoming call from that bot (/?call=<reminderId>); "Snooze 10 min"
// (where the phone shows action buttons, e.g. Android) snoozes it on the
// server with the reminder's own key, no sign-in needed.
//
// It has no fetch handler: the app always loads from the network as before.
const REMINDERS_URL = 'https://zswkhfkfseclgadhvobg.supabase.co/functions/v1/reminders';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function bodyFor(d) {
  const text = String(d.body || '').trim();
  // An always-on bot found an important email: the line, then the summary.
  if (d.mail && d.kind !== 'call') return [text, d.mail.summary].filter(Boolean).join('\n');
  if (d.kind === 'call') return text ? `Calling you about: ${text}` : 'Calling you';
  if (d.kind === 'task') return text ? `Time for: ${text}. Tap and I'll start on it.` : 'Time for your task. Tap and I will start on it.';
  return text || 'You have a reminder.';
}

// A call keeps ringing: the notification comes back (sound and vibration)
// every few seconds for about half a minute, until it is answered, declined
// or swiped away.
const RING_EVERY_MS = 4500;
const RING_FOR_MS = 32000;
const stopped = new Set(); // tags answered, declined or dismissed

async function ringCall(title, opts) {
  const until = Date.now() + RING_FOR_MS;
  for (let first = true; Date.now() < until; first = false) {
    if (stopped.has(opts.tag)) return;
    if (!first) {
      // Gone from the shade (answered elsewhere, or swiped): stop.
      const open = await self.registration.getNotifications({ tag: opts.tag });
      if (!open.length) return;
    }
    await self.registration.showNotification(title, opts);
    await new Promise((r) => setTimeout(r, RING_EVERY_MS));
  }
  // Not answered: leave it as a missed call.
  if (!stopped.has(opts.tag)) {
    await self.registration.showNotification(`Missed call from ${title}`, { ...opts, body: opts.data && opts.data.body ? `About: ${opts.data.body}` : 'Tap to call back.', renotify: false, requireInteraction: false, silent: true, vibrate: [], actions: [{ action: 'answer', title: 'Call back' }] });
  }
}

self.addEventListener('notificationclose', (e) => { if (e.notification && e.notification.tag) stopped.add(e.notification.tag); });

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const title = String(d.title || 'Codeply').slice(0, 60);
  const opts = {
    body: bodyFor(d).slice(0, 240),
    icon: '/logo.png',
    // The small status-bar icon: Android draws only its shape, so it is the knot alone on transparent.
    badge: '/notify-badge.png',
    tag: d.reminderId ? `reminder-${d.reminderId}` : 'codeply',
    renotify: true,
    requireInteraction: d.kind === 'call',
    vibrate: d.kind === 'call' ? [500, 250, 500, 250, 500, 250, 500] : [200, 100, 200],
    data: d,
    actions: d.reminderId ? [{ action: 'answer', title: d.kind === 'call' ? 'Answer' : 'Open' }, { action: 'snooze', title: 'Snooze 10 min' }] : [],
  };
  if (d.kind === 'call') {
    // Like a phone call: the bot's name, "Incoming call", Answer and Decline.
    opts.body = `Incoming call${String(d.body || '').trim() ? ` · ${String(d.body).trim()}` : ''}`.slice(0, 240);
    opts.tag = `call-${d.reminderId || Date.now()}`;
    opts.vibrate = [900, 500, 900, 500, 900];
    opts.actions = [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }];
  }
  e.waitUntil((async () => {
    // The app is open on screen: it shows the incoming call (and rings) right away.
    const wins0 = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins0) { try { w.postMessage({ type: 'codeply-push', data: d }); } catch {} }
    if (d.kind === 'call') {
      const visible = wins0.some((w) => w.visibilityState === 'visible');
      if (!visible) await ringCall(title, opts);
      return;
    }
    await self.registration.showNotification(title, opts);
  })());
});

self.addEventListener('notificationclick', (e) => {
  const d = (e.notification && e.notification.data) || {};
  if (e.notification && e.notification.tag) stopped.add(e.notification.tag);
  e.notification.close();
  if (e.action === 'decline') return;
  if (e.action === 'snooze' && d.reminderId && d.key) {
    e.waitUntil(fetch(REMINDERS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze', id: d.reminderId, key: d.key, minutes: 10 }),
    }).catch(() => {}));
    return;
  }
  // An email (not a call): open it, or the draft, in Gmail.
  const mailUrl = d.mail && d.kind !== 'call' ? String(d.mail.draftUrl || d.mail.gmailUrl || '') : '';
  if (/^https:\/\/mail\.google\.com\//.test(mailUrl) && self.clients.openWindow) {
    e.waitUntil(self.clients.openWindow(mailUrl));
    return;
  }
  const answer = e.action === 'answer' && d.kind === 'call';
  const url = d.reminderId ? `/?call=${encodeURIComponent(d.reminderId)}${answer ? '&answer=1' : ''}` : '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (!('focus' in w)) continue;
      try { w.postMessage({ type: 'codeply-reminder-open', id: d.reminderId, data: d, answer }); } catch {}
      try { return await w.focus(); } catch {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  })());
});
