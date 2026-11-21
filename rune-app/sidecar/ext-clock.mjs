// The PC's local time zone, for the app's times (reminders, "paused until 10:20 PM"): Rust's std
// has no time zone, and Node knows it on every OS.
//
//   GET /ext/clock   { offsetMin, tz, now }   offsetMin: minutes ahead of UTC (Karachi: 300)
export function route(ctx, req, res, url, p, reply) {
  if (req.method === 'GET' && p === '/ext/clock') {
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* unknown */ }
    reply(200, { offsetMin: -new Date().getTimezoneOffset(), tz, now: Date.now() });
    return true;
  }
  return false;
}
