// Billing: upgrading from inside the app (the upgrade sheet, the free-limit card in a chat,
// Settings > Usage & billing). Only the payment itself happens on Whop.
//
// The plan comes from the Codeply site, signed in as the rest of the app is (auth.js
// getAccessToken: the account's Supabase access token, sent as a Bearer token):
//   GET  <SITE>/api/account          { user, profile, subscription, plan: { key, name, price, models, comingSoon, limits }, ... }
//   POST <SITE>/api/create-checkout  { plan: 'starter' | 'pro' } -> { checkoutUrl }
// The checkout is made for this account, so Whop knows who paid: never a fixed whop.com link.
// <SITE> is https://codeply.app, or CODEPLY_SITE_URL. Plan keys: 'starter' is shown as Pro,
// 'pro' as Max.
//
//   GET  /ext/billing            { ok, signedIn, plan, free, checkout, error? }
//   POST /ext/billing/checkout   { plan } -> { ok, checkout } | { ok: false, signedIn?, error }
//   POST /ext/billing/cancel     -> { ok }
//
// `checkout` is { plan, url, state, error }: 'waiting' while you pay, then 'done' (the account's
// plan is no longer free; `plan` holds the new one) or 'expired'. While one waits, the account is
// asked every 5 s for up to 15 min, and each change is sent to the app as a `billing` event.
// `free` is Haze 2's free 5-hour amount as the router last reported it ({ used, limit, resetsAt,
// resets }), kept by the engine's bridge in ctx.shared.hazeFree; null until a chat has run.

export const PLANS = { starter: 'Pro', pro: 'Max' };
const EVERY_MS = 5000;
const MAX_MS = 15 * 60 * 1000;

export const siteUrl = (env = process.env) => String(env.CODEPLY_SITE_URL || 'https://codeply.app').trim().replace(/\/+$/, '');

/** "4:30 PM" in this computer's time zone, or "Tue 4:30 PM" when it isn't today. */
export function clock(iso, now = new Date()) {
  const d = new Date(iso || '');
  if (!iso || Number.isNaN(d.getTime())) return '';
  const today = d.toDateString() === now.toDateString();
  try {
    return today
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

/** The account's plan as the app shows it: its key, the name it goes by in the app, its price. */
export function planOf(account) {
  const p = (account && account.plan) || {};
  const key = String(p.key || 'free').toLowerCase();
  const name = key === 'free' ? 'Free' : PLANS[key] || String(p.name || key);
  const models = Array.isArray(p.models) ? p.models.map((m) => String((m && (m.label || m.id)) || '')).filter(Boolean) : [];
  return { key, name, price: p.price ?? null, models };
}

/** The free amount for the app: the share used, and when it resets, in local time. */
export function freeOf(f, now = Date.now()) {
  if (!f || !Number.isFinite(Number(f.limit)) || Number(f.limit) <= 0) return null;
  const reset = f.resetsAt ? new Date(f.resetsAt).getTime() : NaN;
  // Past its reset, the window started again.
  if (Number.isFinite(reset) && reset <= now) return { used: 0, limit: Number(f.limit), resetsAt: null, resets: '' };
  return { used: Math.max(0, Number(f.used) || 0), limit: Number(f.limit), resetsAt: f.resetsAt || null, resets: clock(f.resetsAt, new Date(now)) };
}

/**
 * The billing state and its requests, with everything it reaches passed in (so the tests stub
 * the network): fetch, token() (the access token or null), emit(view), free() (the router's
 * last `route.free`), and the clock and timers.
 */
export function createBilling({ fetch: doFetch = globalThis.fetch, token, emit = () => {}, free = () => null, site = siteUrl, every = EVERY_MS, maxMs = MAX_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let checkout = null; // { plan, url, state, error, started }
  let timer = null;
  let plan = null; // the account's plan, as last read
  let signedIn = null;

  async function call(method, path, body) {
    const t = await token();
    if (!t) { signedIn = false; return { signedIn: false }; }
    signedIn = true;
    let res;
    try {
      res = await doFetch(`${typeof site === 'function' ? site() : site}${path}`, {
        method,
        headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(`Couldn't reach Codeply (${e && e.message ? e.message : e}). Check your connection and try again.`);
    }
    let data = {};
    try { data = JSON.parse((await res.text()) || '{}'); } catch { data = {}; }
    if (res.status === 401) throw new Error('Your sign-in ran out. Sign in again in Settings > Profile, then try again.');
    if (!res.ok) throw new Error((data && typeof data.error === 'string' && data.error) || `Codeply answered ${res.status}. Try again in a moment.`);
    return { signedIn: true, data };
  }

  const view = () => ({
    ok: true,
    signedIn: signedIn !== false,
    plan,
    free: freeOf(free(), now()),
    checkout: checkout && { plan: checkout.plan, url: checkout.url, state: checkout.state, error: checkout.error || '' },
  });

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  /** Reads the account's plan. */
  async function load() {
    try {
      const r = await call('GET', '/api/account');
      if (!r.signedIn) { plan = null; return { ...view(), signedIn: false }; }
      plan = planOf(r.data);
      return view();
    } catch (e) {
      return { ...view(), ok: false, error: e.message };
    }
  }

  function settle(state, error = '') {
    stop();
    if (!checkout) return;
    checkout.state = state;
    checkout.error = error;
    emit(view());
  }

  /** One look at the account while a checkout waits: done once the plan isn't free any more. */
  async function tick(mine) {
    timer = null;
    if (checkout !== mine || mine.state !== 'waiting') return;
    try {
      const r = await call('GET', '/api/account');
      if (checkout !== mine || mine.state !== 'waiting') return;
      if (r.signedIn) {
        plan = planOf(r.data);
        if (plan.key !== 'free') return settle('done');
      }
    } catch { /* a hiccup: keep asking */ }
    if (checkout !== mine || mine.state !== 'waiting') return;
    if (now() - mine.started >= maxMs) return settle('expired', "We didn't hear back from Whop. If you finished paying, it can take a minute: open Usage & billing to check.");
    timer = setTimer(() => { tick(mine); }, every);
  }

  /** Makes a checkout for `key` ('starter' or 'pro') and starts waiting for it to be paid. */
  async function start(key) {
    if (!Object.hasOwn(PLANS, key)) return { ok: false, error: 'Pick Pro or Max.' };
    stop();
    checkout = null;
    let r;
    try {
      r = await call('POST', '/api/create-checkout', { plan: key });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (!r.signedIn) return { ok: false, signedIn: false, error: 'Sign in to Codeply first, so your plan lands on your account.' };
    const url = String((r.data && r.data.checkoutUrl) || '');
    if (!/^https:\/\//i.test(url)) return { ok: false, error: "Codeply didn't send a checkout link. Try again in a moment." };
    const mine = { plan: key, url, state: 'waiting', error: '', started: now() };
    checkout = mine;
    timer = setTimer(() => { tick(mine); }, every);
    return { ...view(), ok: true };
  }

  function cancel() {
    stop();
    if (checkout && checkout.state === 'waiting') checkout.state = 'cancelled';
    checkout = null;
    return { ok: true };
  }

  return { load, start, cancel, view, tick: () => checkout && tick(checkout), get checkout() { return checkout; } };
}

function billingOf(ctx) {
  if (!ctx.shared.billing) {
    ctx.shared.billing = createBilling({
      token: async () => {
        const auth = ctx.need('auth.js');
        return (await auth.getAccessToken()) || null;
      },
      emit: (v) => ctx.emit(null, { type: 'billing', ...v }),
      free: () => ctx.shared.hazeFree || null,
    });
  }
  return ctx.shared.billing;
}

export async function route(ctx, req, res, url, p, reply) {
  if (!p.startsWith('/ext/billing')) return false;
  const b = billingOf(ctx);
  if (req.method === 'GET' && p === '/ext/billing') { reply(200, await b.load()); return true; }
  if (req.method === 'POST' && p === '/ext/billing/checkout') {
    const body = await ctx.readJson(req).catch(() => ({}));
    reply(200, await b.start(String((body && body.plan) || '')));
    return true;
  }
  if (req.method === 'POST' && p === '/ext/billing/cancel') { reply(200, b.cancel()); return true; }
  return false;
}
