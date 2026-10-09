/**
 * Model-facing history built from a stored session (shared by the desktop app
 * and `codeply serve`): alternating prose turns. Each assistant turn carries a
 * short, factual list of the actions it really performed, so on a follow-up the
 * model knows what it changed last time instead of reconstructing it from its own
 * (possibly wrong) summary. Also carries forward a bounded number of the most
 * recent pasted images.
 */
const MAX_HISTORY_IMAGES = 4;

const ACTION_VERBS = {
  write_file: 'wrote', edit_file: 'edited', apply_patch: 'patched', web_fetch: 'fetched', web_search: 'searched the web for', image_search: 'searched images for',
  run: 'ran', fetch_image: 'downloaded', browser_check: 'checked in browser', vercel_deploy: 'deployed', supabase_sql: 'ran SQL',
  supabase_api: 'called Supabase API', vercel_api: 'called Vercel API', github_create_repo: 'pushed to GitHub',
  supabase_create_project: 'created Supabase project', gmail_send: 'emailed', slack_post_message: 'posted to Slack',
};

/** One line per tool call the agent really made, for grounding later turns. */
function describeAction(m) {
  const verb = ACTION_VERBS[m.name];
  if (!verb) return null;
  const exit = typeof m.exitCode === 'number' ? ` (exit ${m.exitCode})` : '';
  return `${verb} ${m.label || ''}${exit}${m.ok === false ? ' - FAILED' : ''}`.trim();
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
  const kept = turns.slice(-20);
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
