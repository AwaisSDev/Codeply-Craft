// Your own Claude and ChatGPT plans (Settings > Models > Your plans): signed in on this computer,
// so subagents can run on them and the agent can keep going once your Codeply limit is used up.
//
//   GET  /ext/linked                       { claude: { connected, plan, email, error }, chatgpt: {...} }
//   POST /ext/linked/connect    { which }  signs in through the browser; answers when it's done
//   POST /ext/linked/disconnect { which }
// Claude signs in through Claude Code's own `claude auth login` (lib/claude-code.js); ChatGPT
// through OpenAI's sign-in for local apps (lib/chatgpt.js). Emits `linked_changed` after a change,
// and at each step of a sign-in (each plan's `busy` and `stage`, so the card can say what's going on).
// On a computer without Claude Code, Connect downloads and installs it first (Anthropic's own
// installer, the same command the docs give), then signs in.

import { spawn } from 'node:child_process';

const PLAN_NAMES = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' };

let busy = { claude: null, chatgpt: null };
// What a sign-in in progress is doing ("Downloading Claude Code...", "Finish signing in in your browser").
let stage = { claude: '', chatgpt: '' };

function setStage(ctx, which, text) {
  stage[which] = text;
  ctx.emit(null, { type: 'linked_changed' });
}

// Runs Claude Code's installer (up to 10 minutes); resolves with its last lines of output on failure.
function installClaude(cc) {
  const win = process.platform === 'win32';
  const [cmd, args] = win
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cc.installCommand()]]
    : ['bash', ['-c', cc.installCommand()]];
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    const keep = (d) => { out = (out + d.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 300);
      resolve(code === 0 ? { ok: true } : { ok: false, error: tail || `the installer stopped (code ${code})` });
    });
  });
}

const lib = (ctx, name) => { try { return ctx.need(name); } catch { return null; } };

async function claudeView(ctx) {
  const cc = lib(ctx, 'claude-code.js');
  if (!cc) return { connected: false, plan: '', email: '', error: 'Not available in this engine.' };
  const st = await cc.status({ refresh: true }).catch(() => null);
  if (!st || !st.installed) return { connected: false, plan: '', email: '', error: '', installed: false, installCommand: cc.installCommand(), busy: !!busy.claude, stage: stage.claude };
  const plan = String(st.plan || '').toLowerCase();
  return { connected: !!st.loggedIn, plan: st.loggedIn ? PLAN_NAMES[plan] || (plan ? `Claude ${plan[0].toUpperCase()}${plan.slice(1)}` : 'Claude') : '', email: st.loggedIn ? st.email || '' : '', error: '', installed: true, busy: !!busy.claude, stage: stage.claude };
}

function chatgptView(ctx) {
  const g = lib(ctx, 'chatgpt.js');
  if (!g) return { connected: false, plan: '', email: '', error: 'Not available in this engine.' };
  const st = g.status();
  return { connected: !!st.signedIn, plan: st.signedIn ? 'ChatGPT' : '', email: st.email || '', error: '', busy: !!busy.chatgpt, stage: stage.chatgpt };
}

async function view(ctx) {
  return { claude: await claudeView(ctx), chatgpt: chatgptView(ctx) };
}

async function connect(ctx, which) {
  if (which === 'claude') {
    const cc = lib(ctx, 'claude-code.js');
    if (!cc) throw new Error('Not available in this engine.');
    busy.claude = { cancel() {} };
    try {
      // A new computer: download and install Claude Code first.
      if (!cc.findClaude({ refresh: true })) {
        setStage(ctx, 'claude', 'Downloading and installing Claude Code...');
        const r = await installClaude(cc);
        if (!r.ok || !cc.findClaude({ refresh: true })) {
          throw new Error(`Couldn't install Claude Code${r.error ? `: ${r.error}` : ''}. You can install it yourself with: ${cc.installCommand()}`);
        }
      }
      setStage(ctx, 'claude', 'Finish signing in to Claude in your browser...');
      // Claude Code opens the browser itself; the address goes to the app too, in case it can't.
      const run = cc.login({ onUrl: (u) => ctx.emit(null, { type: 'open_url', url: u }) });
      busy.claude = run;
      const r = await run.done;
      if (!r.ok && !r.cancelled) throw new Error(r.error || 'The Claude sign-in stopped.');
    } finally {
      busy.claude = null;
      stage.claude = '';
    }
    return;
  }
  const g = lib(ctx, 'chatgpt.js');
  if (!g) throw new Error('Not available in this engine.');
  busy.chatgpt = true;
  try {
    setStage(ctx, 'chatgpt', 'Finish signing in to ChatGPT in your browser...');
    await g.signIn({ openBrowser: async (u) => ctx.emit(null, { type: 'open_url', url: u }) });
  } finally {
    busy.chatgpt = null;
    stage.chatgpt = '';
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
