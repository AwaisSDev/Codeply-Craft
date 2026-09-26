/**
 * Codeply CLI - apply accounting
 *
 * There are no paid plans or daily apply caps any more: checkApplyLimit()
 * always allows the write. recordApplyEvent() still logs a successful write
 * to the shared apply_history table (counts only, never file content) so the
 * admin dashboard keeps its usage numbers. It is fire-and-forget - a slow or
 * failing insert never holds up the agent.
 */
const { getClient, getSession } = require('./auth');

/** Kept for API compatibility with older callers. Always allowed. */
async function checkApplyLimit() {
  return { allowed: true, count: 0, limit: Infinity };
}

async function recordApplyEvent(filePath, linesAdded = 0, linesRemoved = 0) {
  try {
    const session = await getSession();
    if (!session) return;
    const { error } = await getClient().from('apply_history').insert({
      user_id: session.user.id,
      file_path: filePath || '',
      lines_added: linesAdded || 0,
      lines_removed: linesRemoved || 0,
    });
    if (error) console.warn('[apply-limit] record failed:', error.message);
  } catch (e) {
    console.warn('[apply-limit] record failed:', e.message);
  }
}

module.exports = { checkApplyLimit, recordApplyEvent };
