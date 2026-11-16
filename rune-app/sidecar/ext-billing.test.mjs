// Run: node sidecar/ext-billing.test.mjs (the upgrade flow with the network and the clock stubbed:
// nothing here reaches Whop or codeply.app).
import assert from 'node:assert';
import { createBilling, planOf, freeOf, clock, siteUrl, route } from './ext-billing.mjs';

assert.equal(siteUrl({}), 'https://codeply.app');
assert.equal(siteUrl({ CODEPLY_SITE_URL: 'http://127.0.0.1:3000/' }), 'http://127.0.0.1:3000');
assert.deepEqual(planOf({ plan: { key: 'starter', name: 'Starter', price: 20, models: [{ id: 'opus', label: 'Claude Opus 5.5' }] } }),
  { key: 'starter', name: 'Pro', price: 20, models: ['Claude Opus 5.5'] });
assert.equal(planOf({ plan: { key: 'pro', name: 'Pro' } }).name, 'Max');
assert.equal(planOf({}).key, 'free');
assert.equal(planOf({ plan: { key: 'team', name: 'Team' } }).name, 'Team');
assert.equal(clock(''), '');
assert.match(clock(new Date(2026, 10, 16, 16, 30).toISOString(), new Date(2026, 10, 16, 12, 0)), /4:30/);
assert.match(clock(new Date(2026, 10, 17, 16, 30).toISOString(), new Date(2026, 10, 16, 12, 0)), /4:30/);
const soon = new Date(Date.now() + 3600e3).toISOString();
assert.equal(freeOf({ used: 82, limit: 100, resetsAt: soon }).used, 82);
assert.equal(freeOf({ used: 82, limit: 100, resetsAt: new Date(Date.now() - 1000).toISOString() }).used, 0, 'past its reset, the window starts again');
assert.equal(freeOf(null), null);

// A stubbed site: records each request, answers from `site`.
function stub() {
  const calls = [];
  const site = { plan: { key: 'free', name: 'Free' }, checkout: { checkoutUrl: 'https://whop.com/checkout/plan_abc?session=1' }, status: 200, down: false };
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (site.down) throw new Error('getaddrinfo ENOTFOUND');
    const path = new URL(url).pathname;
    const body = path === '/api/account' ? { user: { id: 'u1' }, plan: site.plan } : path === '/api/create-checkout' ? site.checkout : { error: 'Not found' };
    return { ok: site.status < 400, status: site.status, text: async () => JSON.stringify(body) };
  };
  return { calls, site, fetch };
}

// Fake timers and clock.
function clockwork() {
  const c = { t: 1_000_000, pending: [] };
  c.now = () => c.t;
  c.setTimer = (f, ms) => { const h = { f, at: c.t + ms }; c.pending.push(h); return h; };
  c.clearTimer = (h) => { c.pending = c.pending.filter((x) => x !== h); };
  c.advance = async (ms) => {
    c.t += ms;
    const due = c.pending.filter((h) => h.at <= c.t);
    c.pending = c.pending.filter((h) => h.at > c.t);
    for (const h of due) await h.f();
    await new Promise((r) => setImmediate(r));
  };
  return c;
}

{
  // Not signed in: no request at all, and the sheet is told to sign in first.
  const { calls, fetch } = stub();
  const b = createBilling({ fetch, token: async () => null, site: 'https://codeply.test' });
  const r = await b.start('starter');
  assert.equal(r.ok, false);
  assert.equal(r.signedIn, false);
  assert.match(r.error, /Sign in/);
  assert.equal(calls.length, 0);
  assert.equal((await b.load()).signedIn, false);
}

{
  // The whole flow: a checkout for this account, then waiting until the plan changes.
  const { calls, site, fetch } = stub();
  const c = clockwork();
  const events = [];
  const b = createBilling({ fetch, token: async () => 'tok-123', site: 'https://codeply.test', emit: (v) => events.push(v), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    free: () => ({ used: 82, limit: 100, resetsAt: new Date(c.t + 3600e3).toISOString() }) });
  const loaded = await b.load();
  assert.equal(loaded.plan.key, 'free');
  assert.equal(loaded.free.used, 82);
  assert.equal(calls[0].url, 'https://codeply.test/api/account');
  assert.equal(calls[0].auth, 'Bearer tok-123');

  assert.equal((await b.start('enterprise')).ok, false, 'only the two plans');
  const r = await b.start('starter');
  assert.equal(r.ok, true);
  assert.equal(r.checkout.state, 'waiting');
  assert.equal(r.checkout.url, 'https://whop.com/checkout/plan_abc?session=1');
  const made = calls.find((x) => x.url.endsWith('/api/create-checkout'));
  assert.deepEqual([made.method, made.auth, made.body], ['POST', 'Bearer tok-123', { plan: 'starter' }]);

  // Still free: keeps asking every 5 s, quietly through a network hiccup.
  await c.advance(5000);
  assert.equal(b.checkout.state, 'waiting');
  site.down = true;
  await c.advance(5000);
  assert.equal(b.checkout.state, 'waiting');
  site.down = false;
  const asked = calls.filter((x) => x.url.endsWith('/api/account')).length;
  assert.equal(asked, 3);
  // Paid: the next look sees Pro and says so once.
  site.plan = { key: 'starter', name: 'Starter', models: [{ id: 'x', label: 'Claude Opus 5.5' }] };
  await c.advance(5000);
  assert.equal(b.checkout.state, 'done');
  assert.equal(events.length, 1);
  assert.equal(events[0].checkout.state, 'done');
  assert.equal(events[0].plan.name, 'Pro');
  assert.equal(c.pending.length, 0, 'stops asking');
}

{
  // Gives up after 15 minutes; Cancel stops at once.
  const { fetch } = stub();
  const c = clockwork();
  const events = [];
  const b = createBilling({ fetch, token: async () => 't', site: 'https://codeply.test', emit: (v) => events.push(v), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  await b.start('pro');
  for (let i = 0; i < 200 && b.checkout.state === 'waiting'; i++) await c.advance(5000);
  assert.equal(b.checkout.state, 'expired');
  assert.equal(events.at(-1).checkout.state, 'expired');
  assert.ok(c.t - 1_000_000 >= 15 * 60 * 1000);

  await b.start('pro');
  assert.equal(c.pending.length, 1);
  b.cancel();
  assert.equal(c.pending.length, 0);
  assert.equal(b.checkout, null);
}

{
  // Errors are answers, never a crash: the site's own message, a 401, no link, no network.
  const { site, fetch } = stub();
  const b = createBilling({ fetch, token: async () => 't', site: 'https://codeply.test', setTimer: () => 0, clearTimer: () => {} });
  site.status = 500; site.checkout = { error: 'Whop is down.' };
  assert.deepEqual(await b.start('starter'), { ok: false, error: 'Whop is down.' });
  site.status = 401;
  assert.match((await b.start('starter')).error, /sign-in ran out/);
  assert.match((await b.load()).error, /sign-in ran out/);
  site.status = 200; site.checkout = { checkoutUrl: 'javascript:alert(1)' };
  assert.match((await b.start('starter')).error, /checkout link/);
  site.down = true;
  assert.match((await b.start('starter')).error, /Couldn't reach Codeply/);
}

{
  // The routes, with auth.js stubbed.
  const { fetch, calls } = stub();
  const real = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const ctx = { shared: {}, emit: () => {}, readJson: async (req) => req.body, need: () => ({ getAccessToken: async () => 'tok' }) };
    let out;
    const reply = (s, b) => { out = [s, b]; };
    const go = (method, p, body) => route(ctx, { method, body }, {}, new URL(`http://x${p}`), p, reply);
    assert.equal(await go('GET', '/ext/models'), false);
    process.env.CODEPLY_SITE_URL = 'https://site.test';
    assert.equal(await go('GET', '/ext/billing'), true);
    assert.equal(out[1].plan.key, 'free');
    assert.equal(calls.at(-1).url, 'https://site.test/api/account');
    await go('POST', '/ext/billing/checkout', { plan: 'pro' });
    assert.equal(out[1].checkout.plan, 'pro');
    await go('POST', '/ext/billing/cancel');
    assert.deepEqual(out[1], { ok: true });
  } finally {
    globalThis.fetch = real;
    delete process.env.CODEPLY_SITE_URL;
  }
}
console.log('ext-billing ok');
