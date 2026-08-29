/**
 * Codeply CLI — subscription tier + trial caps
 *
 * Reads the `subscriptions` table (user_id, plan, status, whop_membership_id,
 * current_period_end, canceled_at) that already exists in the same Supabase
 * project as auth.js/apply-limit.js, and that Codeply's Whop webhook
 * (Codeply/api/whop-webhook.js, deployed separately) upserts into on
 * payment/membership events. No row, or a row that isn't currently active,
 * means the account is on the free trial.
 *
 * TIERS is the single source of truth for daily caps by plan — apply-limit.js
 * and ai.js both read it instead of hardcoding a number, so retuning a cap is
 * a one-line change here.
 */
const { getClient, getSession } = require('./auth');

// Model names verified against each vendor's actual naming as of Aug 2026 —
// this is the single source of truth both the paywall cards (app.js) and the
// model picker (main.js's namedModelEntries) read from: Claude Sonnet 5 /
// Claude Opus 5 (anthropic.com/news), GPT-5.6 Terra (OpenAI's mid tier, not
// "ChatGPT Terra" — Sol/Terra/Luna are the tier names within the GPT-5.6
// generation), Kimi K3 (Moonshot AI, name as-is), Claude Fable 5 (Anthropic's
// Mythos-class tier above Opus). Free trial deliberately promises no named
// model — Auto is the only thing it actually gets.
const TIERS = {
  free:  { label: 'Free trial', dailyApplyLimit: 5,   dailyAiLimit: 8,   models: [] },
  plus:  { label: 'Plus',       dailyApplyLimit: 100,  dailyAiLimit: 400, models: ['Claude Sonnet 5', 'Claude Opus 5', 'GPT-5.6 Terra'] },
  pro:   { label: 'Pro',        dailyApplyLimit: 250,  dailyAiLimit: 1000, models: ['Claude Sonnet 5', 'Claude Opus 5', 'GPT-5.6 Terra', 'Kimi K3'] },
  max:   { label: 'Max',        dailyApplyLimit: 500,  dailyAiLimit: 2500, models: ['Claude Sonnet 5', 'Claude Opus 5', 'GPT-5.6 Terra', 'Kimi K3', 'Claude Fable 5'] },
};

function isRowActive(row) {
  if (!row || row.status !== 'active') return false;
  if (row.current_period_end && new Date(row.current_period_end).getTime() < Date.now()) return false;
  return true;
}

/**
 * Returns { tier, plan, status, row }. `tier` is always a valid TIERS key
 * (falls back to 'free' for signed-out, no-row, inactive, or unrecognized
 * plan values) so callers never need their own fallback logic.
 */
async function getSubscription() {
  const session = await getSession();
  if (!session) return { tier: 'free', plan: null, status: null, row: null };

  const supabase = getClient();
  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('plan, status, current_period_end, canceled_at')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) throw error;

    const active = isRowActive(data);
    const tier = active && TIERS[data.plan] ? data.plan : 'free';
    return { tier, plan: data?.plan || null, status: data?.status || null, row: data || null };
  } catch (e) {
    console.warn('[subscription] check failed, defaulting to free tier:', e.message);
    return { tier: 'free', plan: null, status: null, row: null };
  }
}

/** Today's ai_request_log row count for the caller, UTC day boundary (matches
 * get_daily_ai_request_count()'s own convention). RLS already scopes this to
 * the caller's own rows (ai_request_log_select_own), so no RPC is needed. */
async function dailyAiCountToday() {
  const session = await getSession();
  if (!session) return 0;
  const supabase = getClient();
  try {
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
      .from('ai_request_log')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
      .gte('created_at', startOfDayUtc.toISOString());
    if (error) throw error;
    return count || 0;
  } catch (e) {
    console.warn('[subscription] daily AI count failed, treating as 0:', e.message);
    return 0;
  }
}

module.exports = { TIERS, getSubscription, dailyAiCountToday };
