// Your own Claude and ChatGPT plans (Settings > Models > Your plans): signed in on this computer,
// so subagents can run on them and the agent can keep going once your Codeply limit is used up.
//
//   GET  /ext/linked                       { claude: { connected, plan, email, error }, chatgpt: {...} }
//   POST /ext/linked/connect    { which }  signs in through the browser; answers when it's done
//   POST /ext/linked/disconnect { which }
// Claude signs in through Claude Code's own `claude auth login` (lib/claude-code.js); ChatGPT
// through OpenAI's sign-in for local apps (lib/chatgpt.js). Emits `linked_changed` after a change.

const PLAN_NAMES = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' };

let busy = { claude: null, chatgpt: null };

const lib = (ctx, name) => { try { return ctx.need(name); } catch { return null; } };

async function claudeView(ctx) {
  const cc = lib(ctx, 'claude-code.js');
  if (!cc) return { connected: false, plan: '', email: '', error: 'Not available in this engine.' };
  const st = await cc.status({ refresh: true }).catch(() => null);
  if (!st || !st.installed) return { connected: false, plan: '', email: '', error: '', installed: false, installCommand: cc.installCommand() };
  const plan = String(st.plan || '').toLowerCase();
  return { connected: !!st.loggedIn, plan: st.loggedIn ? PLAN_NAMES[plan] || (plan ? `Claude ${plan[0].toUpperCase()}${plan.slice(1)}` : 'Claude') : '', email: st.loggedIn ? st.email || '' : '', error: '', installed: true };
}

function chatgptView(ctx) {
  const g = lib(ctx, 'chatgpt.js');
  if (!g) return { connected: false, plan: '', email: '', error: 'Not available in this engine.' };
  const st = g.status();
  return { connected: !!st.signedIn, plan: st.signedIn ? 'ChatGPT' : '', email: st.email || '', error: '' };
}

async function view(ctx) {
  return { claude: await claudeView(ctx), chatgpt: chatgptView(ctx) };
}

async function connect(ctx, which) {
  if (which === 'claude') {
    const cc = lib(ctx, 'claude-code.js');
    if (!cc) throw new Error('Not available in this engine.');
    if (!cc.findClaude({ refresh: true })) throw new Error(`Claude Code isn't installed on this computer. Install it with: ${cc.installCommand()}`);
    // Claude Code opens the browser itself; the address goes to the app too, in case it can't.
    const run = cc.login({ onUrl: (u) => ctx.emit(null, { type: 'open_url', url: u }) });
    busy.claude = run;
    const r = await run.done;
    busy.claude = null;
    if (!r.ok && !r.cancelled) throw new Error(r.error || 'The Claude sign-in stopped.');
    return;
  }
  const g = lib(ctx, 'chatgpt.js');
  if (!g) throw new Error('Not available in this engine.');
  busy.chatgpt = true;
  try {
    await g.signIn({ openBrowser: async (u) => ctx.emit(null, { type: 'open_url', url: u }) });
  } finally {
    busy.chatgpt = null;
  }
}

export async function route(ctx, req, res, url, p, reply) {
  if (!p.startsWith('/ext/linked')) return false;
  if (req.method === 'GET' && p === '/ext/linked') { reply(200, await view(ctx)); return true; }
  if (req.method !== 'POST') return false;
  const body = await ctx.readJson(req).catch(() => ({}));
  const which = body.which === 'chatgpt' ? 'chatgpt' : 'claude';
  if (p === '/ext/linked/connect') {
    if (busy[which]) { reply(200, { ...(await view(ctx)), which, error: 'A sign-in is already open in your browser.' }); return true; }
    try {
      await connect(ctx, which);
      ctx.emit(null, { type: 'linked_changed' });
      reply(200, { ...(await view(ctx)), which });
    } catch (e) {
      reply(200, { ...(await view(ctx)), which, error: e && e.message ? e.message : String(e) });
    }
    return true;
  }
  if (p === '/ext/linked/disconnect') {
    try {
      if (which === 'claude') {
        if (busy.claude) busy.claude.cancel();
        await lib(ctx, 'claude-code.js')?.logout();
      } else {
        lib(ctx, 'chatgpt.js')?.signOut();
      }
    } catch {}
    ctx.emit(null, { type: 'linked_changed' });
    reply(200, { ...(await view(ctx)), which });
    return true;
  }
  return false;
}
