// GET /usage: your own token use per day, from every app and model, for the usage sheet: the
// Electron app's Usage page (main.js usage:get), from my_usage() in the database. It adds `today`
// ("YYYY-MM-DD" in this computer's time zone), which the app can't work out on its own.
const pad = (n) => String(n).padStart(2, '0');

export async function route(ctx, req, res, url, p, reply) {
  if (req.method !== 'GET' || p !== '/usage') return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').slice(0, 64);
  try {
    const auth = ctx.need('auth.js');
    const session = auth && await auth.getSession();
    if (!session || !session.user) { reply(200, { error: 'Sign in to see your usage.', today }); return true; }
    const { data, error } = await auth.getClient().rpc('my_usage', { tz });
    if (error) reply(200, { error: error.message, today });
    else reply(200, { ...(data || { error: 'No usage yet.' }), today });
  } catch (e) {
    reply(200, { error: e.message, today });
  }
  return true;
}
