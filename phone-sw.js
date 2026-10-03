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
  if (d.kind === 'call') return text ? `Calling you about: ${text}` : 'Calling you';
  if (d.kind === 'task') return text ? `Time for: ${text}. Tap and I'll start on it.` : 'Time for your task. Tap and I will start on it.';
  return text || 'You have a reminder.';
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const title = String(d.title || 'Codeply').slice(0, 60);
  const opts = {
    body: bodyFor(d).slice(0, 240),
    icon: '/logo.png',
    badge: '/phone-favicon.png',
    tag: d.reminderId ? `reminder-${d.reminderId}` : 'codeply',
    renotify: true,
    requireInteraction: d.kind === 'call',
    vibrate: d.kind === 'call' ? [500, 250, 500, 250, 500, 250, 500] : [200, 100, 200],
    data: d,
    actions: d.reminderId ? [{ action: 'answer', title: d.kind === 'call' ? 'Answer' : 'Open' }, { action: 'snooze', title: 'Snooze 10 min' }] : [],
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    // The app is open on screen: it shows the incoming call right away.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { try { w.postMessage({ type: 'codeply-push', data: d }); } catch {} }
  })());
});

self.addEventListener('notificationclick', (e) => {
  const d = (e.notification && e.notification.data) || {};
  e.notification.close();
  if (e.action === 'snooze' && d.reminderId && d.key) {
    e.waitUntil(fetch(REMINDERS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze', id: d.reminderId, key: d.key, minutes: 10 }),
    }).catch(() => {}));
    return;
  }
  const url = d.reminderId ? `/?call=${encodeURIComponent(d.reminderId)}` : '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (!('focus' in w)) continue;
      try { w.postMessage({ type: 'codeply-reminder-open', id: d.reminderId, data: d }); } catch {}
      try { return await w.focus(); } catch {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  })());
});
