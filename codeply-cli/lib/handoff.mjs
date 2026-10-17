/**
 * Local <-> cloud handoff: a run on the PC carries on in Craft Cloud when the
 * PC goes away (power cut, crash, lost connection), and comes back to the PC
 * when it returns. Only one side edits at a time.
 *
 *   lease      A row in Supabase (run_leases, see supabase/handoff.sql). The PC
 *              renews it every 15 s with the server's clock. A watchdog on the
 *              server starts a cloud run once it is 60 s stale. The PC stops
 *              its own run after 40 s without a renewal, so the two never
 *              overlap (self-fencing).
 *   WIP        The working tree plus the run's state (.craft-handoff.json),
 *              committed together through Craft's own git folder (never the
 *              project's .git) and pushed to craft/wip-<chat>. Pushed a moment
 *              after every step that can change files, and on a timer.
 *   resume     The new side gets the chat so far, the steps already done and
 *              the todo list, and continues from the first unfinished item.
 *   hand-back  The PC asks for the chat back (handback/<chat>/want.json on
 *              craft-sessions). The runner stops between steps, pushes, and
 *              answers with handback/<chat>/done.json. The PC applies the
 *              cloud's changes with a 3-way merge and carries on.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { git } from './github-agent.mjs';
import { stageWorkingTree, initMirrorGit, WORKFLOW_PATH, BOT, authFor } from './cloud.mjs';

export const STATE_FILE = '.craft-handoff.json';
export const wipBranch = (sid) => `craft/wip-${String(sid).replace(/[^A-Za-z0-9_-]/g, '')}`;
export const HANDBACK = {
  want: (sid) => `handback/${sid}/want.json`,
  done: (sid) => `handback/${sid}/done.json`,
};
export const BEAT_MS = 15000;      // the PC renews its lease this often
export const FENCE_MS = 40000;     // and stops its run after this long without a renewal
export const STALE_MS = 60000;     // the watchdog takes over after this long (server clock)
export const WIP_DEBOUNCE_MS = 2000;
export const WIP_EVERY_MS = 20000;

const MAX_STEPS = 80;
const MAX_NOTES = 3;
// Tools whose step can change files: a WIP push follows each of them.
export const MUTATING = new Set(['write_file', 'edit_file', 'apply_patch', 'run', 'fetch_image', 'supabase_sql', 'github_create_repo']);

const VERBS = {
  write_file: 'wrote', edit_file: 'edited', apply_patch: 'patched', run: 'ran', fetch_image: 'downloaded',
  read_file: 'read', list_dir: 'listed', search: 'searched', web_fetch: 'fetched', web_search: 'searched the web for',
  browser_check: 'checked in the browser', todo: 'updated the todo list',
};

/** One line per finished step, for the side that carries on. */
export function stepLine(ev) {
  if (!ev || !ev.name) return null;
  const label = String(ev.summary || (ev.args && (ev.args.path || ev.args.command || ev.args.pattern || ev.args.url || ev.args.query)) || '').slice(0, 160);
  const exit = ev.meta && typeof ev.meta.exitCode === 'number' ? ` (exit ${ev.meta.exitCode})` : '';
  const verb = VERBS[ev.name] || ev.name;
  if (ev.name === 'todo') return null; // the list itself travels as todos
  return `${verb} ${label}${exit}${ev.ok === false ? ' - FAILED' : ''}`.trim();
}

/** The model-facing chat before this turn, without pasted images (they stay on the PC). */
export function cleanHistory(history) {
  return (Array.isArray(history) ? history : []).slice(-40).map((t) => ({ role: t.role, content: typeof t.content === 'string' ? t.content : String(t.content || '') }));
}

/** A run's state at the start of a turn. */
export function newRunState({ sessionId, mode = 'Build', userMessage, history, roleId = null, startedAt = Date.now() }) {
  return { v: 1, sessionId, mode, userMessage: String(userMessage || ''), history: cleanHistory(history), roleId, startedAt, steps: [], todos: [], notes: [], side: 'pc', legs: [] };
}

/** Fold one agent event into the state. Returns true when the step may have changed files. */
export function recordEvent(state, ev) {
  if (!state || !ev) return false;
  if (ev.type === 'tool_end') {
    if (ev.meta && Array.isArray(ev.meta.todos)) state.todos = ev.meta.todos.map((t) => ({ text: String(t.text || ''), status: t.status || 'pending' }));
    const line = stepLine(ev);
    if (line) { state.steps.push(line); if (state.steps.length > MAX_STEPS) state.steps.splice(0, state.steps.length - MAX_STEPS); }
    return MUTATING.has(ev.name);
  }
  if (ev.type === 'text' && ev.interim && ev.text) {
    state.notes.push(String(ev.text).slice(0, 600));
    if (state.notes.length > MAX_NOTES) state.notes.shift();
  }
  return false;
}

const TODO_MARK = { done: '[x]', in_progress: '[~]', dropped: '[-]', pending: '[ ]' };

/**
 * The message the side that carries on is given: the original request, what is
 * already done, and the todo list. `to`: 'cloud' (the PC went away), 'pc'
 * (back from the cloud) or 'self' (the PC carries on after its own pause or crash).
 */
export function continuationPrompt(state, to = 'cloud') {
  const why = to === 'cloud'
    ? "This task was already running on the user's PC, which went offline (power cut, crash or lost connection). You are carrying on from where it stopped."
    : to === 'pc'
      ? 'This task carried on in Craft Cloud while the PC was offline. The PC is back and you are carrying on from where the cloud stopped.'
      : 'This task was cut off on this PC (lost connection, or Craft closed). You are carrying on from the last save.';
  const lines = [state.userMessage, '', '---', `[Handoff] ${why}`, 'The files on disk already include every change from the steps below.'];
  if (state.steps.length) lines.push('', 'Steps already done (do not redo them):', ...state.steps.map((s, i) => `${i + 1}. ${s}`));
  else lines.push('', 'No steps had finished yet.');
  if (state.todos.length) lines.push('', 'Todo list (keep it up to date with the todo tool):', ...state.todos.map((t) => `${TODO_MARK[t.status] || '[ ]'} ${t.text}`));
  if (state.notes.length) lines.push('', 'Your last notes before the switch:', ...state.notes.map((n) => `- ${n}`));
  lines.push('', 'Continue from the first unfinished item. The last step may have been cut off part way, so check its result before relying on it.');
  return lines.join('\n');
}

// ─── WIP commits ─────────────────────────────────────────────────────────

/**
 * Commit the working tree and the state together, on top of `parent` (the
 * last WIP commit, or none), and push it to craft/wip-<chat>. `force` only on
 * the first push of a run, when this side holds the lease. Returns the sha,
 * or the parent when nothing changed.
 */
export async function pushWip({ cwd, home, token, repo, sessionId, state, parent = null, force = false, serverUrl = 'https://github.com', remoteUrl }) {
  const s = await stageWorkingTree(cwd, home);
  const blob = await git(cwd, ['--git-dir', s.gitDir, 'hash-object', '-w', '--stdin'], { input: JSON.stringify({ ...state, savedAt: Date.now() }) });
  await s.G(['update-index', '--add', '--cacheinfo', `100644,${blob},${STATE_FILE}`]);
  const tree = await s.G(['write-tree']);
  if (parent && !force) {
    const prevTree = await s.G(['rev-parse', `${parent}^{tree}`]).catch(() => null);
    // Only the state's savedAt differs: compare without it.
    if (prevTree && (await sameButState(s, parent, tree))) return { sha: parent, pushed: false };
  }
  const sha = await git(cwd, ['--git-dir', s.gitDir, ...BOT, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Craft WIP ${sessionId} (${state.steps.length} steps)`]);
  await s.G(['update-ref', `refs/craft/wip/${sessionId}`, sha]);
  const url = remoteUrl || `${serverUrl.replace(/\/$/, '')}/${repo}.git`;
  await git(cwd, ['--git-dir', s.gitDir, 'push', '-q', ...(force ? ['--force'] : []), url, `${sha}:refs/heads/${wipBranch(sessionId)}`], { auth: token ? authFor(token, serverUrl) : undefined });
  return { sha, pushed: true };
}

/** True when `tree` matches `parent`'s tree apart from the state file's savedAt. */
async function sameButState(s, parent, tree) {
  const diff = await s.G(['diff', '--name-only', parent, tree]).catch(() => 'x');
  const names = diff.split('\n').filter(Boolean);
  if (!names.length) return true;
  if (names.length !== 1 || names[0] !== STATE_FILE) return false;
  try {
    const a = JSON.parse(await s.G(['show', `${parent}:${STATE_FILE}`]));
    const b = JSON.parse(await s.G(['show', `${tree}:${STATE_FILE}`]));
    delete a.savedAt; delete b.savedAt;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}

/**
 * Bring the cloud's WIP back: the change from `fromSha` (where the cloud
 * started) to the branch head, applied onto the working tree with a 3-way
 * merge, so edits made here after the last push survive. Returns the files,
 * any conflicts, the new head and the state the cloud left.
 */
export async function applyWip({ cwd, home, token, repo, sessionId, fromSha, serverUrl = 'https://github.com', remoteUrl }) {
  const m = await initMirrorGit(cwd, home);
  const url = remoteUrl || `${serverUrl.replace(/\/$/, '')}/${repo}.git`;
  const ref = `refs/craft/wip-remote/${sessionId}`;
  await git(cwd, ['--git-dir', m.gitDir, 'fetch', '-q', '--no-tags', url, `+refs/heads/${wipBranch(sessionId)}:${ref}`], { auth: token ? authFor(token, serverUrl) : undefined });
  const toSha = await m.G(['rev-parse', ref]);
  let state = null;
  try { state = JSON.parse(await m.G(['show', `${toSha}:${STATE_FILE}`])); } catch {}
  const spec = ['--', '.', `:(exclude)${WORKFLOW_PATH}`, ':(exclude).codeply', `:(exclude)${STATE_FILE}`];
  if (!fromSha || fromSha === toSha) return { files: [], conflicts: [], toSha, state, applied: false };
  const patch = await git(cwd, ['--git-dir', m.gitDir, 'diff', '--binary', '--full-index', fromSha, toSha, ...spec]);
  const files = (await git(cwd, ['--git-dir', m.gitDir, 'diff', '--name-only', fromSha, toSha, ...spec])).split('\n').filter(Boolean);
  if (!patch.trim()) return { files: [], conflicts: [], toSha, state, applied: false };
  await stageWorkingTree(cwd, home);
  let conflicts = [];
  try {
    await m.G(['apply', '--3way', '--whitespace=nowarn', '-'], { input: `${patch}\n` });
  } catch (e) {
    const unmerged = await m.G(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    conflicts = unmerged.split('\n').filter(Boolean);
    if (!conflicts.length) throw new Error(`Could not apply the cloud's changes: ${e.message}`);
  }
  await m.G(['update-ref', `refs/craft/wip/${sessionId}`, toSha]);
  return { files, conflicts, toSha, state, applied: true };
}

/** The state inside a checked-out WIP tree (the runner), removed from disk so the agent never sees it. */
export function takeStateFile(cwd) {
  const file = path.join(cwd, STATE_FILE);
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return state;
  } catch { return null; }
}

// ─── The PC's side of the lease ──────────────────────────────────────────

/**
 * Keeps the lease for one run. `store` talks to run_leases (Supabase RPCs in
 * the app, an in-memory table in tests):
 *   begin(row) -> { epoch } | { error }   beat({ sessionId, epoch, wipSha }) -> { ok, row }   end({ sessionId, epoch, state })
 * onFence(reason) is called once when this side must stop editing: 'offline'
 * (no renewal for FENCE_MS) or 'taken' (the cloud holds the lease now).
 * With keepGoingOffline (a local model that works without internet) an
 * offline spell only calls onOffline(true/false), and the run keeps going.
 */
export function makeLease({ store, sessionId, now = Date.now, beatMs = BEAT_MS, fenceMs = FENCE_MS, onFence = () => {}, onOffline = () => {}, keepGoingOffline = false, setTimer = setInterval, clearTimer = clearInterval }) {
  let epoch = null; let lastOk = now(); let timer = null; let fenced = null; let offline = false; let wipSha = null; let beating = false;
  const fence = (why) => { if (fenced) return; fenced = why; stopTimer(); onFence(why); };
  const stopTimer = () => { if (timer) { clearTimer(timer); timer = null; } };
  const beat = async () => {
    if (fenced || epoch == null || beating) return;
    beating = true;
    try {
      const r = await store.beat({ sessionId, epoch, wipSha });
      if (r && r.ok) {
        lastOk = now();
        if (offline) { offline = false; onOffline(false); }
      } else if (r && r.row) {
        fence('taken');
      }
    } catch {
      if (!offline) { offline = true; onOffline(true); }
      if (!keepGoingOffline && now() - lastOk > fenceMs) fence('offline');
    } finally { beating = false; }
    if (!fenced && !keepGoingOffline && now() - lastOk > fenceMs) fence('offline');
  };
  return {
    async start(row) {
      const r = await store.begin({ ...row, sessionId });
      if (!r || r.error) throw new Error((r && r.error) || 'Could not start the cloud backup.');
      epoch = r.epoch; lastOk = now(); wipSha = row.wipSha || null;
      timer = setTimer(beat, beatMs);
      return epoch;
    },
    beat,
    saved(sha) { wipSha = sha; },
    get epoch() { return epoch; },
    get fenced() { return fenced; },
    get offline() { return offline; },
    get lastOk() { return lastOk; },
    async end(state = 'done') {
      stopTimer();
      if (fenced || epoch == null) return;
      try { await store.end({ sessionId, epoch, state }); } catch {}
    },
    stop: stopTimer,
  };
}

export const hostname = () => os.hostname();
