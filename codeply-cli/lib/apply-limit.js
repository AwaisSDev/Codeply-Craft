/**
 * Codeply CLI — daily apply cap
 *
 * Reuses the EXACT same Supabase table/RPC the desktop app checks against
 * (apply_history + get_daily_apply_count(), see Codeply-App/supabase/
 * apply_limit.sql) — an apply from the CLI counts toward the same account's
 * daily cap as an apply from the desktop app, not a separate bucket. The
 * limit itself is tier-based (see subscription.js's TIERS) — free-trial
 * accounts get a much smaller cap than a paid plan.
 */
const { getClient, getSession } = require('./auth');
const { TIERS, getSubscription } = require('./subscription');

/** Returns { allowed, count, limit, tier }. Fails OPEN on a DB hiccup, same as the desktop app. */
async function checkApplyLimit() {
  const session = await getSession();
  const { tier } = await getSubscription();
  const limit = TIERS[tier].dailyApplyLimit;
  if (!session) return { allowed: false, count: 0, limit, tier, error: 'Not signed in. Run `codeply login` first.' };

  const supabase = getClient();
  try {
    const { data, error } = await supabase.rpc('get_daily_apply_count');
    if (error || typeof data !== 'number') throw error || new Error('unexpected response');
    return { allowed: data < limit, count: data, limit, tier };
  } catch (e) {
    console.warn('[apply-limit] check failed, allowing:', e.message);
    return { allowed: true, count: 0, limit, tier };
  }
}

/**
 * Records one successful file write toward the daily cap. Fire-and-forget.
 * `linesAdded`/`linesRemoved` are what the admin dashboard's per-user view
 * sums up to show how much someone actually changed, not just how often —
 * deliberately just counts, never the file content itself.
 */
async function recordApplyEvent(filePath, linesAdded = 0, linesRemoved = 0) {
  const session = await getSession();
  if (!session) return;
  const supabase = getClient();
  try {
    await supabase.from('apply_history').insert({
      user_id: session.user.id,
      file_path: filePath || '',
      lines_added: linesAdded || 0,
      lines_removed: linesRemoved || 0,
    });
  } catch (e) {
    console.warn('[apply-limit] record failed:', e.message);
  }
}

module.exports = { checkApplyLimit, recordApplyEvent };
