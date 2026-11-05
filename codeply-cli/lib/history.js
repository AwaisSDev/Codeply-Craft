/**
 * Model-facing history built from a stored session (shared by the desktop app
 * and `codeply serve`): alternating prose turns. Each assistant turn carries a
 * short, factual list of the actions it really performed, so on a follow-up the
 * model knows what it changed last time instead of reconstructing it from its own
 * (possibly wrong) summary. Also carries forward a bounded number of the most
 * recent pasted images.
 */
const MAX_HISTORY_IMAGES = 4;
const HISTORY_TURNS = 20;
const HISTORY_STEP = 20;

const ACTION_VERBS = {
  write_file: 'wrote', edit_file: 'edited', apply_patch: 'patched', web_fetch: 'fetched', web_search: 'searched the web for', image_search: 'searched images for', reach_me: 'reached the phone:', watch_email: 'set an email alert for',
  run: 'ran', fetch_image: 'downloaded', browser_check: 'checked in browser', vercel_deploy: 'deployed', supabase_sql: 'ran SQL',
  supabase_api: 'called Supabase API', vercel_api: 'called Vercel API', github_create_repo: 'pushed to GitHub',
  supabase_create_project: 'created Supabase project', gmail_send: 'emailed', slack_post_message: 'posted to Slack',
  use_computer: 'on the computer:', look_at_screen: 'looked at the screen', life_context: 'looked up', calendar_add: 'added to the calendar',
  calendar_update: 'changed the calendar:', gmail_search: 'searched email for', gmail_read: 'read the email', remember: 'remembered', hand_off: 'handed off',
  schedule: 'scheduled', create_specialist: 'set up the specialist',
};

/** One line per tool call the agent really made, for grounding later turns. */
function describeAction(m) {
  const verb = ACTION_VERBS[m.name];
  if (!verb) return null;
  const exit = typeof m.exitCode === 'number' ? ` (exit ${m.exitCode})` : '';
  const what = m.name === 'run' && m.command ? String(m.command).slice(0, 600) : (m.label || '');
  return `${verb} ${what}${exit}${m.ok === false ? ' - FAILED' : ''}`.trim();
}

function buildHistory(session) {
  const turns = [];
  let pendingActions = [];
  const flushActions = () => {
    if (!pendingActions.length) return;
    const last = turns[turns.length - 1];
    const note = `[Actions actually performed: ${pendingActions.slice(0, 12).join('; ')}${pendingActions.length > 12 ? `; +${pendingActions.length - 12} more` : ''}]`;
    if (last && last.role === 'assistant') last.content += `\n\n${note}`;
    else turns.push({ role: 'assistant', content: note });
    pendingActions = [];
  };
  for (const m of session.messages) {
    if (m.kind === 'user') {
      flushActions();
      turns.push({ role: 'user', content: m.expanded || m.text, images: m.images || null });
    } else if (m.kind === 'wisp_agent' && m.agent) {
      // Wisp's specialists: never shown as their own voice, but Wisp knows whom it brought in.
      if (m.agent.kind === 'claude') {
        // Claude Code (claude-code-desktop.js): what it was asked, and whether it finished.
        if (m.phase === 'start') pendingActions.push(`asked Claude Code${m.agent.round > 1 ? ` (round ${m.agent.round})` : ''} to: ${String(m.task || '').replace(/\s+/g, ' ').slice(0, 160)}`);
        else if (m.phase === 'report') pendingActions.push(m.ok ? `Claude Code finished${Array.isArray(m.files) && m.files.length ? `, changed ${m.files.slice(0, 6).join(', ')}` : ''}` : 'Claude Code could not finish');
        continue;
      }
      if (m.phase === 'start') pendingActions.push(`brought in the ${m.agent.name} specialist for: ${String(m.task || '').replace(/\s+/g, ' ').slice(0, 160)}`);
      else if (m.phase === 'report' && !m.ok) pendingActions.push(`the ${m.agent.name} specialist could not finish`);
      else if (m.phase === 'created') pendingActions.push(`created a new specialist, ${m.agent.name} (${m.agent.focus || ''})`);
    } else if (m.kind === 'assistant' && m.text && m.agent) {
      // A specialist's narration while it worked: not part of the conversation.
    } else if (m.kind === 'assistant' && m.text) {
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') last.content += '\n\n' + m.text;
      else turns.push({ role: 'assistant', content: m.text });
    } else if (m.kind === 'tool') {
      const line = describeAction(m);
      if (line) pendingActions.push(line);
    } else if (m.kind === 'question') {
      pendingActions.push(m.answer
        ? `asked the user "${String(m.question).slice(0, 160)}" and they answered "${String(m.answer).slice(0, 200)}"`
        : `asked the user "${String(m.question).slice(0, 160)}" but they left it to you`);
    } else if (m.kind === 'checkpoint' && m.undone) {
      // Otherwise the model believes its earlier edits are still on disk.
      pendingActions.push(`LATER UNDONE BY THE USER: every file change from this message was reverted (${m.files.slice(0, 6).map((f) => f.file).join(', ')}${m.total > 6 ? ', ...' : ''}); those files are back to how they were before it`);
    }
  }
  flushActions();
  // The last 20 to 39 messages. The window's start moves 20 at a time, not
  // one per turn: a start that moved every turn changed the first message of
  // the history on every turn, and the whole history missed the prompt cache.
  const start = turns.length > HISTORY_TURNS ? Math.floor((turns.length - HISTORY_TURNS) / HISTORY_STEP) * HISTORY_STEP : 0;
  const kept = turns.slice(start);
  // A history must start with a user turn for most providers.
  while (kept.length && kept[0].role !== 'user') kept.shift();

  let imageBudget = MAX_HISTORY_IMAGES;
  for (let i = kept.length - 1; i >= 0; i--) {
    const t = kept[i];
    if (t.role !== 'user' || !t.images || !t.images.length || imageBudget <= 0) { delete t.images; continue; }
    const take = t.images.slice(0, imageBudget);
    imageBudget -= take.length;
    t.content = [{ type: 'text', text: t.content }, ...take.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } }))];
    delete t.images;
  }

  return kept;
}

module.exports = { buildHistory, describeAction };
