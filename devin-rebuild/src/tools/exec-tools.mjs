/**
 * Shell tools: exec, get_output, kill_shell.
 *
 * exec waits up to `wait_ms` (default 120 s). A command still running then is
 * not killed: it moves to the background and the agent gets its shell id,
 * like Devin's "moved to the background after Ns" behaviour. Background
 * output is read later with get_output and stopped with kill_shell.
 */
import { spawn } from 'node:child_process';

const DEFAULT_WAIT_MS = 120_000;
const MAX_OUTPUT = 30_000;

let nextId = 1;
const shells = new Map();

function truncate(s) {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n\n… [${s.length - MAX_OUTPUT} characters truncated] …\n\n${s.slice(-half)}`;
}

function startShell(command, cwd, env, sandboxWrap) {
  const [cmd, args] = sandboxWrap ? sandboxWrap(command, cwd) : ['bash', ['-c', command]];
  const child = spawn(cmd, args, { cwd, env: { AI_AGENT: 'dvn_0.1.0_agent', ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const shell = { id: `shell_${nextId++}`, command, child, output: '', readFrom: 0, exitCode: null, signal: null, started: Date.now(), done: null };
  const onData = (d) => { shell.output += d.toString('utf8'); if (shell.output.length > 5_000_000) shell.output = shell.output.slice(-2_000_000); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  shell.done = new Promise((resolve) => {
    child.on('error', (e) => { shell.output += `\n${e.message}`; shell.exitCode = 127; resolve(); });
    child.on('close', (code, signal) => { shell.exitCode = code; shell.signal = signal; resolve(); });
  });
  shells.set(shell.id, shell);
  return shell;
}

function killShell(shell) {
  if (shell.exitCode !== null || shell.signal) return;
  try { process.kill(-shell.child.pid, 'SIGTERM'); } catch { try { shell.child.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-shell.child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
}

export function killAllShells() { for (const s of shells.values()) killShell(s); }

function status(shell) {
  if (shell.signal) return `killed by ${shell.signal}`;
  if (shell.exitCode !== null) return `exit code ${shell.exitCode}`;
  return 'running';
}

export const execTool = {
  name: 'exec',
  kind: 'exec',
  description: 'Run a shell command with bash in the working directory. Output (stdout and stderr combined) is returned when the command finishes. A command still running after wait_ms (default 120000) keeps running in the background and you get a shell id to check later with get_output. Set run_in_background for servers and watchers. Prefer the read/grep/glob tools over cat/grep/find.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'Five to ten words on what the command does' },
      wait_ms: { type: 'integer', description: 'How long to wait before backgrounding (max 600000)' },
      run_in_background: { type: 'boolean' },
    },
    required: ['command'],
  },
  target: (input) => input.command,
  async run(input, ctx) {
    if (!input.command || !String(input.command).trim()) return { isError: true, content: 'command is empty.' };
    const shell = startShell(input.command, ctx.cwd, ctx.env, ctx.sandboxWrap);
    if (input.run_in_background) return { content: `Started in the background as ${shell.id}. Read its output with get_output.` };
    const wait = Math.min(Math.max(input.wait_ms ?? DEFAULT_WAIT_MS, 1000), 600_000);
    let timer;
    const onAbort = () => killShell(shell);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const finished = await Promise.race([shell.done.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), wait); })]);
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    if (ctx.signal?.aborted) return { isError: true, content: 'Command cancelled by the user.' };
    if (!finished) {
      shell.readFrom = shell.output.length;
      return { content: `${truncate(shell.output)}\n\n[Still running after ${Math.round(wait / 1000)}s; moved to the background as ${shell.id}. Use get_output to check it.]` };
    }
    shells.delete(shell.id);
    const out = truncate(shell.output.trimEnd());
    const isError = shell.exitCode !== 0;
    return { isError, content: `${out || '(no output)'}${isError ? `\n\n[${status(shell)}]` : ''}` };
  },
};

export const getOutputTool = {
  name: 'get_output',
  kind: 'read',
  description: 'Get new output from a background shell started by exec, and whether it is still running.',
  input_schema: { type: 'object', properties: { shell_id: { type: 'string' } }, required: ['shell_id'] },
  target: () => null,
  async run(input) {
    const shell = shells.get(input.shell_id);
    if (!shell) return { isError: true, content: `No background shell ${input.shell_id}.` };
    const fresh = shell.output.slice(shell.readFrom);
    shell.readFrom = shell.output.length;
    return { content: `[${shell.id}: ${status(shell)}, ${Math.round((Date.now() - shell.started) / 1000)}s]\n${truncate(fresh) || '(no new output)'}` };
  },
};

export const killShellTool = {
  name: 'kill_shell',
  kind: 'read',
  description: 'Stop a background shell started by exec.',
  input_schema: { type: 'object', properties: { shell_id: { type: 'string' } }, required: ['shell_id'] },
  target: () => null,
  async run(input) {
    const shell = shells.get(input.shell_id);
    if (!shell) return { isError: true, content: `No background shell ${input.shell_id}.` };
    killShell(shell);
    await Promise.race([shell.done, new Promise((r) => setTimeout(r, 3000))]);
    shells.delete(shell.id);
    return { content: `Stopped ${shell.id} (${status(shell)}).` };
  },
};

export function listShells() {
  return [...shells.values()].map((s) => ({ id: s.id, command: s.command, status: status(s), seconds: Math.round((Date.now() - s.started) / 1000) }));
}
