/**
 * Craft Cloud: the agent keeps working while this PC is off, on GitHub's
 * machines, in the user's own account. Nothing runs on Codeply servers.
 *
 *   mirror     A private repo (craft-workspace-<project>) that holds snapshots
 *              of the project. It is separate from the user's real repo, so a
 *              cloud run never touches production code.
 *   snapshot   The working tree, pushed to the mirror's main branch through a
 *              git folder of Craft's own (~/.codeply/cloud/<id>.git). The
 *              project's own .git is never read or written. .gitignore is
 *              respected, .env files and keys are always left out, and files
 *              holding key-like strings are skipped.
 *   run        A workflow_dispatch of craft-cloud.yml. The runner reports
 *              progress in a check run, pushes code changes to craft/task-<id>,
 *              and keeps the chat on the craft-sessions branch so the next run
 *              continues the same conversation.
 *   pull       The task branch's changes, applied back onto the local project
 *              with a 3-way merge, so edits made meanwhile survive.
 *
 * The model key lives only in the mirror's encrypted Actions secrets.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { runAgent } from './agent.mjs';
import { git, ciApprove, routeFromEnv } from './github-agent.mjs';
import { takeStateFile, continuationPrompt, recordEvent as recordHandoff, wipBranch, newRunState, pushRunnerWip, RUNNER_WIP_EVERY_MS, HANDBACK, STATE_FILE } from './handoff.mjs';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');
const blake = require('blakejs');

export const WORKFLOW_FILE = 'craft-cloud.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
export const MIRROR_PREFIX = 'craft-workspace-';
export const MIRROR_DESCRIPTION = 'Craft workspace mirror: a private backup that Craft cloud runs work in.';
export const SESSIONS_BRANCH = 'craft-sessions';
/** craft-sessions' vercel.json: Vercel never deploys that branch (each task writes to it many times). */
export const NO_DEPLOY = { git: { deploymentEnabled: false } };
export const ENGINE = 'codeply-cli@0.5';
export const taskBranch = (id) => `craft/task-${id}`;
export const checkName = (id) => `craft ${id}`;

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT = 20000;
const MAX_BOT_PROMPT = 30000;
const MAX_OUTPUT = 60000;
const HISTORY_TURNS = 40;

export const CLOUD_WORKFLOW = `# Written by Codeply Craft. Starts only from Craft (workflow_dispatch), which
# needs write access to this repo, so nobody else can spend its minutes.
name: craft-cloud
run-name: craft \${{ inputs.task_id }}

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What to do
        required: true
        type: string
      mode:
        description: Build, Plan or Ask
        required: false
        default: Build
        type: string
      task_id:
        required: true
        type: string
      session_id:
        required: false
        default: ''
        type: string
      handoff:
        description: resume = carry on a run from the PC (craft/wip-<chat>)
        required: false
        default: ''
        type: string
      attempt:
        description: Which try this is (1 = the first; a run that died is started again, twice at most)
        required: false
        default: '1'
        type: string
      wip:
        description: A branch with the saved work of a run that died (craft/wip-task-<id>)
        required: false
        default: ''
        type: string
      lease:
        description: Lets the run renew its handoff lease (set by the Codeply watchdog)
        required: false
        default: ''
        type: string

permissions:
  contents: write
  checks: write
  actions: write

concurrency:
  group: craft-\${{ inputs.handoff }}\${{ inputs.session_id || inputs.task_id }}
  cancel-in-progress: false

jobs:
  craft:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.wip || (inputs.handoff == 'resume' && format('craft/wip-{0}', inputs.session_id)) || '' }}
          fetch-depth: 1
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run Craft
        run: npx -y --package="\${CRAFT_ENGINE:-${ENGINE}}" codeply cloud runner
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          CODEPLY_API_KEY: \${{ secrets.CODEPLY_API_KEY }}
          CODEPLY_TRACK_KEY: \${{ secrets.CODEPLY_TRACK_KEY }}
          CODEPLY_MODEL_KIND: \${{ vars.CODEPLY_MODEL_KIND }}
          CODEPLY_MODEL: \${{ vars.CODEPLY_MODEL }}
          CODEPLY_BASE_URL: \${{ vars.CODEPLY_BASE_URL }}
          CRAFT_ENGINE: \${{ vars.CRAFT_ENGINE }}
          CRAFT_ENV: \${{ secrets.CRAFT_ENV }}
          CRAFT_MERGE: \${{ vars.CRAFT_MERGE }}
          CRAFT_PERMISSIONS: \${{ vars.CRAFT_PERMISSIONS }}
          CRAFT_BASE: \${{ github.ref_name }}
          CRAFT_PROMPT: \${{ inputs.prompt }}
          CRAFT_MODE: \${{ inputs.mode }}
          CRAFT_TASK_ID: \${{ inputs.task_id }}
          CRAFT_SESSION_ID: \${{ inputs.session_id }}
          CRAFT_HANDOFF: \${{ inputs.handoff }}
          CRAFT_ATTEMPT: \${{ inputs.attempt }}
          CRAFT_WIP: \${{ inputs.wip }}
          CRAFT_LEASE: \${{ inputs.lease }}
      # The runner stops its agent about 8 minutes before the 60 minute limit and starts the
      # task again from its last save. This covers what it cannot: a crash, a killed machine
      # or the hard timeout. It reads the task's status file, so a run that already reported
      # (done, failed for good, or already restarted) or that you cancelled is left alone.
      - name: Start again if the run died
        if: failure() || cancelled()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          TASK_ID: \${{ inputs.task_id }}
          SESSION_ID: \${{ inputs.session_id }}
          ATTEMPT: \${{ inputs.attempt }}
          PROMPT: \${{ inputs.prompt }}
          MODE: \${{ inputs.mode }}
          HANDOFF: \${{ inputs.handoff }}
          LEASE: \${{ inputs.lease }}
          BASE: \${{ github.ref_name }}
        run: |
          attempt="\${ATTEMPT:-1}"
          case "$attempt" in ''|*[!0-9]*) attempt=1 ;; esac
          raw() { gh api -H "Accept: application/vnd.github.raw" "repos/$GITHUB_REPOSITORY/contents/$1?ref=craft-sessions" 2>/dev/null || echo '{}'; }
          doc="$(raw "tasks/$TASK_ID.json")"
          status="$(echo "$doc" | jq -r '.status // "none"' 2>/dev/null || echo none)"
          if [ -n "$(raw "cancel/$TASK_ID.json" | jq -r '.at // empty' 2>/dev/null)" ]; then echo "Cancelled on purpose, not starting again."; exit 0; fi
          case "$status" in done|failed|retrying) echo "The run already reported ($status)."; exit 0 ;; esac
          now_ms="$(( $(date +%s) * 1000 ))"
          next="$((attempt + 1))"
          sha="$(gh api "repos/$GITHUB_REPOSITORY/contents/tasks/$TASK_ID.json?ref=craft-sessions" --jq .sha 2>/dev/null || true)"
          save() {
            body="$(echo "$doc" | jq -c --arg id "$TASK_ID" --argjson at "$now_ms" --argjson next "$next" "$1" | base64 -w0)"
            if [ -n "$sha" ]; then gh api -X PUT "repos/$GITHUB_REPOSITORY/contents/tasks/$TASK_ID.json" -f message="Craft task $TASK_ID: $2" -f branch=craft-sessions -f content="$body" -f sha="$sha" >/dev/null || true
            else gh api -X PUT "repos/$GITHUB_REPOSITORY/contents/tasks/$TASK_ID.json" -f message="Craft task $TASK_ID: $2" -f branch=craft-sessions -f content="$body" >/dev/null || true; fi
          }
          wip="craft/wip-task-$TASK_ID"
          if ! gh api "repos/$GITHUB_REPOSITORY/branches/$wip" >/dev/null 2>&1; then wip=""; fi
          if [ "$attempt" -ge 3 ]; then
            save '. + {id:$id, status:"failed", error:"The cloud run stopped before it finished, and starting it again twice did not help.", updatedAt:$at, notify:{kind:"failed", title:"Your cloud task did not finish", body:"It stopped before it finished, and starting it again twice did not help. Your work so far is saved on a craft/wip- branch.", at:$at}}' "failed"
            exit 0
          fi
          save '. + {id:$id, status:"retrying", attempt:$next, retry:{attempt:$next, of:3, reason:"The run stopped before it finished.", at:$at}, updatedAt:$at}' "retrying"
          gh workflow run craft-cloud.yml --ref "$BASE" -f prompt="$PROMPT" -f mode="$MODE" -f task_id="$TASK_ID" -f session_id="$SESSION_ID" -f handoff="$HANDOFF" -f attempt="$next" -f wip="$wip" -f lease="$LEASE"
`;

// Never mirrored, whatever .gitignore says.
export const ALWAYS_EXCLUDE = [
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', '*.mobileprovision',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.netrc', '.pgpass',
  'node_modules/', '.codeply/', '*.log',
];

// High-confidence key formats only: a false alarm leaves a real source file out of the mirror.
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Groq key', /\bgsk_[A-Za-z0-9]{40,}/],
  ['OpenRouter key', /\bsk-or-v1-[a-f0-9]{40,}/],
];

/** The first key-like string in a file's text, or null. Supabase anon keys are public; service_role keys are not. */
export function findSecret(text) {
  for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) return label;
  const jwts = text.match(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) || [];
  for (const t of jwts) {
    try { if (/service_role/.test(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'))) return 'Supabase service_role key'; } catch {}
  }
  return null;
}

// ─── Encrypted secrets (libsodium sealed box, what GitHub expects) ─────────

export function sealSecret(publicKeyB64, value) {
  const pk = new Uint8Array(Buffer.from(publicKeyB64, 'base64'));
  const eph = nacl.box.keyPair();
  const nonceIn = new Uint8Array(eph.publicKey.length + pk.length);
  nonceIn.set(eph.publicKey); nonceIn.set(pk, eph.publicKey.length);
  const nonce = blake.blake2b(nonceIn, undefined, nacl.box.nonceLength);
  const boxed = nacl.box(new Uint8Array(Buffer.from(String(value), 'utf8')), nonce, pk, eph.secretKey);
  return Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(boxed)]).toString('base64');
}

/** Inverse of sealSecret, for tests. */
export function openSealed(sealedB64, publicKey, secretKey) {
  const all = new Uint8Array(Buffer.from(sealedB64, 'base64'));
  const epk = all.slice(0, 32);
  const nonceIn = new Uint8Array(64); nonceIn.set(epk); nonceIn.set(publicKey, 32);
  const nonce = blake.blake2b(nonceIn, undefined, nacl.box.nonceLength);
  const out = nacl.box.open(all.slice(32), nonce, epk, secretKey);
  return out ? Buffer.from(out).toString('utf8') : null;
}

// ─── GitHub API ──────────────────────────────────────────────────────────

export function githubApi({ token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  const call = async (method, route, body, { allow = [] } = {}) => {
    const res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'codeply-craft', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok && !allow.includes(res.status)) {
      const e = new Error(`GitHub ${method} ${route.split('?')[0]}: ${res.status} ${(json && json.message) || text.slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    return { status: res.status, json, text, scopes: res.headers && res.headers.get ? res.headers.get('x-oauth-scopes') : null };
  };
  return call;
}

/**
 * Why a run died before Craft could report back (install failed, time limit,
 * permissions), from the job's steps and log. Plain words, or null.
 */
export async function diagnoseRun(api, repo, runId) {
  try {
    const jobs = ((await api('GET', `/repos/${repo}/actions/runs/${runId}/jobs`)).json || {}).jobs || [];
    const job = jobs.find((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out') || jobs[0];
    if (!job) return null;
    if (job.conclusion === 'timed_out') return 'The run hit its 60-minute limit and was stopped.';
    const step = (job.steps || []).find((s) => s.conclusion === 'failure');
    let log = '';
    try { log = (await api('GET', `/repos/${repo}/actions/jobs/${job.id}/logs`)).text || ''; } catch {}
    if (/No matching version found for codeply-cli|notarget[\s\S]{0,200}codeply-cli/i.test(log)) {
      return `GitHub couldn't install Codeply's cloud engine (${ENGINE}): that version isn't on npm yet. Publish it, then run again.`;
    }
    if (/Resource not accessible by integration/i.test(log)) return 'GitHub refused the run permission to save its work. Check Settings > Actions > General > Workflow permissions on the mirror repo.';
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(log) && /npm (error|ERR)/i.test(log)) return 'GitHub\'s runner could not download Codeply\'s engine (a network hiccup on GitHub\'s side). Run it again.';
    const lastError = log.split('\n').map((l) => l.replace(/^\S+Z\s/, '').replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter((l) => /error|failed|fatal/i.test(l) && !/^##\[group\]/.test(l)).slice(-1)[0];
    if (step && step.name === 'Run Craft') return `Codeply stopped before it could report back${lastError ? `: ${lastError.replace(/^##\[error\]/, '').slice(0, 240)}` : '.'}`;
    if (step) return `The "${step.name}" step failed on GitHub${lastError ? `: ${lastError.replace(/^##\[error\]/, '').slice(0, 240)}` : '.'}`;
    return null;
  } catch { return null; }
}

// ─── Local state ─────────────────────────────────────────────────────────

const defaultHome = () => path.join(os.homedir(), '.codeply');
const projectKey = (cwd) => path.resolve(cwd).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const projectId = (cwd) => crypto.createHash('sha1').update(projectKey(cwd)).digest('hex').slice(0, 16);

function stateFile(home) { return path.join(home, 'cloud.json'); }
export function readState(home = defaultHome()) {
  try { const s = JSON.parse(fs.readFileSync(stateFile(home), 'utf8')); return s && typeof s === 'object' && s.projects ? s : { projects: {} }; } catch { return { projects: {} }; }
}
function writeState(home, state) {
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${stateFile(home)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile(home));
}
export function getProject(cwd, home = defaultHome()) { return readState(home).projects[projectKey(cwd)] || null; }
function updateProject(cwd, home, fn) {
  const state = readState(home);
  const key = projectKey(cwd);
  state.projects[key] = fn(state.projects[key] || { cwd: path.resolve(cwd), tasks: [] });
  writeState(home, state);
  return state.projects[key];
}
/** Remember a task this PC did not start (a handoff run the server dispatched), so status and replay work. */
export function rememberTask(cwd, task, home = defaultHome()) { return saveTask(cwd, home, task); }
function saveTask(cwd, home, task) {
  return updateProject(cwd, home, (p) => {
    const tasks = (p.tasks || []).filter((t) => t.id !== task.id);
    tasks.unshift(task);
    return { ...p, tasks: tasks.slice(0, 100) };
  });
}
/** Per-project switches the app keeps: cloudOn (send new messages to the cloud), autoBackup, handoff (carry on in the cloud if the PC drops; on unless turned off). */
export function setProjectOptions(cwd, opts, home = defaultHome()) {
  const allowed = {};
  for (const k of ['cloudOn', 'autoBackup', 'handoff']) if (typeof opts[k] === 'boolean') allowed[k] = opts[k];
  return updateProject(cwd, home, (p) => ({ ...p, ...allowed }));
}

export function getTask(cwd, id, home = defaultHome()) {
  const p = getProject(cwd, home);
  return p && (p.tasks || []).find((t) => t.id === id) || null;
}

// ─── Snapshots ───────────────────────────────────────────────────────────

export const BOT = ['-c', 'user.name=Codeply', '-c', 'user.email=craft-bot@users.noreply.github.com'];

function mirrorGit(cwd, home) {
  const gitDir = path.join(home, 'cloud', `${projectId(cwd)}.git`);
  const G = (args, opts) => git(cwd, ['--git-dir', gitDir, '--work-tree', cwd, ...args], opts);
  return { gitDir, G };
}

export async function initMirrorGit(cwd, home) {
  const m = mirrorGit(cwd, home);
  if (!fs.existsSync(path.join(m.gitDir, 'HEAD'))) {
    fs.mkdirSync(m.gitDir, { recursive: true });
    await git(cwd, ['init', '-q', '--bare', m.gitDir]);
    await m.G(['config', 'core.bare', 'false']);
    await m.G(['config', 'core.autocrlf', 'false']);
    await m.G(['config', 'core.quotepath', 'false']);
    await m.G(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  fs.mkdirSync(path.join(m.gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(m.gitDir, 'info', 'exclude'), `${ALWAYS_EXCLUDE.join('\n')}\n`);
  return m;
}

/**
 * Stage the working tree into Craft's own index: .gitignore and ALWAYS_EXCLUDE
 * respected, the project's own workflows left out (they must not run on the
 * mirror), big files and files holding keys dropped, craft-cloud.yml added.
 */
export async function stageWorkingTree(cwd, home) {
  const m = await initMirrorGit(cwd, home);
  const { G } = m;
  await G(['add', '-A', '--', '.']);
  await G(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.github/workflows']);
  const hasHead = await G(['rev-parse', '-q', '--verify', 'refs/heads/main']).then(() => true, () => false);
  const listed = hasHead
    ? await G(['diff', '--cached', '--name-only', '--diff-filter=AM', '-z', 'refs/heads/main'])
    : await G(['ls-files', '-z', '--cached']);
  const skipped = [];
  for (const rel of listed.split('\0').filter(Boolean)) {
    const full = path.join(cwd, rel);
    let reason = null;
    try {
      const st = fs.statSync(full);
      if (st.size > MAX_FILE_BYTES) reason = 'over 50 MB';
      else if (st.size <= MAX_SCAN_BYTES) {
        const buf = fs.readFileSync(full);
        if (!buf.subarray(0, 8000).includes(0)) {
          const found = findSecret(buf.toString('utf8'));
          if (found) reason = `holds a ${found}`;
        }
      }
    } catch { continue; }
    if (reason) {
      await G(['rm', '-q', '--cached', '--', rel]);
      skipped.push({ path: rel.replace(/\\/g, '/'), reason });
    }
  }
  const blob = await git(cwd, ['--git-dir', m.gitDir, 'hash-object', '-w', '--stdin'], { input: CLOUD_WORKFLOW });
  await G(['update-index', '--add', '--cacheinfo', `100644,${blob},${WORKFLOW_PATH}`]);
  return { ...m, hasHead, skipped };
}

/** Commit the working tree to the local mirror git (no network). */
export async function snapshot({ cwd, home = defaultHome() }) {
  const s = await stageWorkingTree(cwd, home);
  const tree = await s.G(['write-tree']);
  const head = s.hasHead ? await s.G(['rev-parse', 'refs/heads/main']) : null;
  if (head && (await s.G(['rev-parse', `${head}^{tree}`])) === tree) return { gitDir: s.gitDir, sha: head, changed: false, skipped: s.skipped };
  const sha = await git(cwd, ['--git-dir', s.gitDir, ...BOT, 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `Snapshot from ${os.hostname()} at ${new Date().toISOString()}`]);
  await s.G(['update-ref', 'refs/heads/main', sha]);
  return { gitDir: s.gitDir, sha, changed: true, skipped: s.skipped };
}

export const authFor = (token, serverUrl = 'https://github.com') => ({ token, server: serverUrl.replace(/\/$/, '') });

/** Snapshot, then push it to the mirror. The mirror's main is Craft's, so it is force-pushed. */
export async function pushSnapshot({ cwd, token, home = defaultHome(), serverUrl = 'https://github.com', remoteUrl }) {
  const p = getProject(cwd, home);
  if (!p || !p.repo) throw new Error('Cloud is not set up for this project yet.');
  // A project that works in its own GitHub repo is never snapshotted: that would overwrite its real main.
  if (p.kind === 'repo') throw new Error(`${p.repo} is this project's own repo; Codeply does not back up over it.`);
  const snap = await snapshot({ cwd, home });
  if (snap.changed || !p.lastPush || p.lastPush.sha !== snap.sha) {
    const url = remoteUrl || `${serverUrl.replace(/\/$/, '')}/${p.repo}.git`;
    await git(cwd, ['--git-dir', snap.gitDir, 'push', '-q', '--force', url, 'refs/heads/main:refs/heads/main'], { auth: authFor(token, serverUrl) });
    updateProject(cwd, home, (q) => ({ ...q, lastPush: { sha: snap.sha, at: Date.now(), skipped: snap.skipped } }));
    return { ...snap, pushed: true };
  }
  return { ...snap, pushed: false };
}

// ─── Setup ───────────────────────────────────────────────────────────────

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'project';

/** Find or create the private mirror repo for a project. */
export async function ensureMirror({ api, cwd, home = defaultHome() }) {
  const existing = getProject(cwd, home);
  if (existing && existing.repo) {
    const r = await api('GET', `/repos/${existing.repo}`, null, { allow: [404] });
    if (r.status === 200) return { repo: existing.repo, created: false };
  }
  const me = (await api('GET', '/user')).json;
  const base = `${MIRROR_PREFIX}${slug(path.basename(path.resolve(cwd)))}`;
  for (let i = 1; i <= 9; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    const r = await api('GET', `/repos/${me.login}/${name}`, null, { allow: [404] });
    if (r.status === 200 && r.json.description === MIRROR_DESCRIPTION && r.json.private) {
      updateProject(cwd, home, (p) => ({ ...p, repo: r.json.full_name }));
      return { repo: r.json.full_name, created: false };
    }
    if (r.status === 404) {
      const made = await api('POST', '/user/repos', { name, private: true, description: MIRROR_DESCRIPTION, auto_init: false, has_issues: false, has_wiki: false, has_projects: false });
      updateProject(cwd, home, (p) => ({ ...p, repo: made.json.full_name, createdAt: Date.now() }));
      return { repo: made.json.full_name, created: true };
    }
  }
  throw new Error(`Could not find a free name for the mirror (tried ${base} to ${base}-9).`);
}

/**
 * Which model a cloud run uses. Auto (Codeply's router, through the run's usage
 * key, counted in the person's allowance) unless they picked one of their own
 * models that GitHub can reach; a model on this PC (or with no key) uses Auto.
 */
export const AUTO_CLOUD = { kind: 'auto', model: 'Auto', sig: 'auto' };
export function cloudModelConfig(model) {
  if (!model || !model.model) return AUTO_CLOUD;
  const kind = model.kind === 'ollama' ? 'ollama' : 'openai';
  const baseUrl = kind === 'ollama' ? String(model.baseUrl || 'https://ollama.com').replace(/\/+$/, '').replace(/\/(api|v1)$/i, '') : String(model.baseUrl || '').trim();
  if (!baseUrl || !model.apiKey) return AUTO_CLOUD;
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(baseUrl)) return AUTO_CLOUD;
  return { kind, baseUrl, model: model.model, apiKey: model.apiKey, sig: crypto.createHash('sha256').update([kind, baseUrl, model.model, model.apiKey].join('\n')).digest('hex').slice(0, 16) };
}

async function setVariable(api, repo, name, value) {
  const r = await api('PATCH', `/repos/${repo}/actions/variables/${name}`, { name, value }, { allow: [404] });
  if (r.status === 404) await api('POST', `/repos/${repo}/actions/variables`, { name, value });
}

/** Put the model key in the mirror's encrypted secrets and the rest in variables. */
export async function configureModel({ api, repo, model }) {
  const cfg = cloudModelConfig(model);
  if (cfg.kind === 'auto') {
    // Auto: no model key in the repo at all; the runner reaches Codeply's router with its usage key
    await api('DELETE', `/repos/${repo}/actions/secrets/CODEPLY_API_KEY`, null, { allow: [404] });
    for (const name of ['CODEPLY_BASE_URL', 'CODEPLY_MODEL']) await api('DELETE', `/repos/${repo}/actions/variables/${name}`, null, { allow: [404] });
    await setVariable(api, repo, 'CODEPLY_MODEL_KIND', 'auto');
    return cfg;
  }
  const pk = (await api('GET', `/repos/${repo}/actions/secrets/public-key`)).json;
  await api('PUT', `/repos/${repo}/actions/secrets/CODEPLY_API_KEY`, { encrypted_value: sealSecret(pk.key, cfg.apiKey), key_id: pk.key_id });
  await setVariable(api, repo, 'CODEPLY_MODEL_KIND', cfg.kind);
  await setVariable(api, repo, 'CODEPLY_BASE_URL', cfg.baseUrl);
  await setVariable(api, repo, 'CODEPLY_MODEL', cfg.model);
  return cfg;
}

/** Check the token can create repos and push workflow files. */
export async function checkToken(api) {
  const r = await api('GET', '/user');
  const scopes = String(r.scopes || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Fine-grained and app tokens send no scope header; let GitHub decide on those.
  if (r.scopes != null && scopes.length && !(scopes.includes('repo') && scopes.includes('workflow'))) {
    return { ok: false, login: r.json.login, error: 'GitHub needs to be reconnected so Codeply may create private repos and workflow files (repo and workflow access).' };
  }
  return { ok: true, login: r.json.login };
}

// ─── Targets: the project's own GitHub repo, or a private mirror ─────────

/** owner/name of the project's GitHub `origin`, or null. */
export async function githubOrigin(cwd) {
  try {
    const url = await git(cwd, ['remote', 'get-url', 'origin']);
    const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

/** The repos this login can push to (for the phone's and the app's repo picker). */
export async function listMyRepos(api) {
  const r = await api('GET', '/user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100');
  return (r.json || []).filter((x) => x.permissions && x.permissions.push)
    .map((x) => ({ repo: x.full_name, private: x.private, base: x.default_branch, mirror: x.description === MIRROR_DESCRIPTION, pushedAt: x.pushed_at }));
}

/** Commit craft-cloud.yml to the repo's default branch (only when missing or out of date). */
export async function installWorkflowInRepo({ api, repo, base }) {
  const files = branchFiles(api, repo, base);
  const cur = await api('GET', `/repos/${repo}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(base)}`, null, { allow: [404] });
  const want = Buffer.from(CLOUD_WORKFLOW).toString('base64');
  if (cur.status === 200 && String(cur.json.content || '').replace(/\s/g, '') === want) return false;
  const ok = await files.writeBytes(WORKFLOW_PATH, Buffer.from(CLOUD_WORKFLOW), 'Add the Codeply cloud workflow');
  if (!ok) throw new Error(`Could not add ${WORKFLOW_PATH} to ${repo}. GitHub needs the workflow permission for that.`);
  return true;
}

/** The project's environment for running and testing (KEY=value lines), as the CRAFT_ENV secret. */
export async function setProjectEnv({ api, repo, envText }) {
  const text = String(envText || '').trim();
  if (!text) { await api('DELETE', `/repos/${repo}/actions/secrets/CRAFT_ENV`, null, { allow: [404] }); return 0; }
  const pk = (await api('GET', `/repos/${repo}/actions/secrets/public-key`)).json;
  await api('PUT', `/repos/${repo}/actions/secrets/CRAFT_ENV`, { encrypted_value: sealSecret(pk.key, text), key_id: pk.key_id });
  return text.split('\n').filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length;
}

/**
 * Usage counts for the admin dashboard from cloud runs: a run has no Codeply
 * sign-in, so Craft asks Codeply for a usage key for the signed-in user and puts
 * it in the repo's encrypted secrets (CODEPLY_TRACK_KEY). Counts only, like the
 * desktop apps. Never fails a setup or a run: without a sign-in, or with
 * telemetry off, it does nothing.
 */
export async function ensureTrackKey({ api, repo, cwd, home = defaultHome(), fetchImpl = fetch }) {
  try {
    const p = getProject(cwd, home) || {};
    if (p.trackKeyRepo === repo) return false;
    // Needed whatever the usage-stats setting: the run reaches Auto and the connected
    // apps with it (telemetry.js still sends no stats when they're switched off).
    const auth = require('./auth.js');
    const token = await auth.getAccessToken().catch(() => null);
    if (!token) return false;
    const r = await fetchImpl(auth.SUPABASE_URL + '/functions/v1/track', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mint', label: 'cloud ' + repo }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.key) return false;
    const pk = (await api('GET', '/repos/' + repo + '/actions/secrets/public-key')).json;
    await api('PUT', '/repos/' + repo + '/actions/secrets/CODEPLY_TRACK_KEY', { encrypted_value: sealSecret(pk.key, j.key), key_id: pk.key_id });
    updateProject(cwd, home, (q) => ({ ...q, trackKeyRepo: repo }));
    return true;
  } catch { return false; }
}

/**
 * Connected apps (Gmail, Slack, Vercel, Supabase, GitHub) for cloud runs. A run
 * happens on GitHub's servers, which don't have the sign-ins saved on this PC,
 * so Craft keeps an encrypted copy on Codeply's server for the signed-in user
 * (the connections function) and the runner loads it at start with the usage
 * key. Sent only when something changed. Off with "cloudConnections": false in
 * ~/.codeply/config.json. Never fails a setup or a run.
 */
export const CONNECTION_APPS = ['gmail', 'slack', 'vercel', 'supabase', 'github'];
export async function syncCloudConnections({ home = defaultHome(), fetchImpl = fetch } = {}) {
  try {
    const config = require('./config.js');
    if (config.getConfig().cloudConnections === false) return false;
    const connections = {};
    for (const name of CONNECTION_APPS) {
      const c = config.getIntegration(name); // includes the app's OAuth client, which token refresh needs
      if (c.accessToken) connections[name] = c;
    }
    const sig = crypto.createHash('sha256').update(JSON.stringify(connections)).digest('hex');
    const state = readState(home);
    if (state.connectionsSig === sig) return false;
    const auth = require('./auth.js');
    const token = await auth.getAccessToken().catch(() => null);
    if (!token) return false;
    // An app connected from the phone (a token pasted there) lives only in the account's copy: keep it, unless
    // this PC disconnected that app itself (then it's gone everywhere).
    try {
      const cur = await fetchImpl(auth.SUPABASE_URL + '/functions/v1/connections', { method: 'POST', headers: { Authorization: 'Bearer ' + token, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get' }), signal: AbortSignal.timeout(15_000) });
      const j = await cur.json().catch(() => ({}));
      const dropped = new Set(config.disconnectedApps ? config.disconnectedApps() : []);
      for (const name of CONNECTION_APPS) if (!connections[name] && !dropped.has(name) && j && j.connections && j.connections[name] && j.connections[name].accessToken) connections[name] = j.connections[name];
    } catch {}
    const r = await fetchImpl(auth.SUPABASE_URL + '/functions/v1/connections', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', connections }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return false;
    writeState(home, { ...readState(home), connectionsSig: sig });
    return true;
  } catch { return false; }
}

/** In the runner: put the user's connected apps into this machine's config, so the agent's tools can use them. */
export async function loadCloudConnections({ env = process.env, fetchImpl = fetch, log = () => {} } = {}) {
  const key = String(env.CODEPLY_TRACK_KEY || '').trim();
  if (!key) return [];
  try {
    const auth = require('./auth.js');
    const r = await fetchImpl(auth.SUPABASE_URL + '/functions/v1/connections', {
      method: 'POST',
      headers: { 'x-codeply-track-key': key, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get' }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.connections) return [];
    const config = require('./config.js');
    const loaded = [];
    for (const name of CONNECTION_APPS) {
      const c = j.connections[name];
      if (c && c.accessToken) { config.saveIntegration(name, c); loaded.push(name); }
    }
    if (loaded.length) log('Connected apps: ' + loaded.join(', '));
    return loaded;
  } catch (e) { log('Could not load connected apps: ' + e.message); return []; }
}

// Bumped when CLOUD_WORKFLOW changes, so repos set up earlier get the new file once.
export const WORKFLOW_REV = 5;

/**
 * One-click setup. With `target: 'repo'` (default when the project has a GitHub
 * origin) the cloud works in that repo: new branch per task, merged into the
 * default branch, and the PC pulls. Otherwise a private mirror holds snapshots.
 */
export async function setupCloud({ cwd, token, model, target, envText, home = defaultHome(), apiUrl, serverUrl, fetchImpl, remoteUrl }) {
  const api = githubApi({ token, apiUrl, fetchImpl });
  const t = await checkToken(api);
  if (!t.ok) throw new Error(t.error);
  const cfg = cloudModelConfig(model);
  if (cfg.error) throw new Error(cfg.error);
  const origin = target === 'mirror' ? null : await githubOrigin(cwd);
  let repo; let created = false; let skipped = []; let base = 'main'; let kind = 'mirror';
  if (origin) {
    const r = await api('GET', `/repos/${origin}`, null, { allow: [404] });
    if (r.status !== 200) throw new Error(`Codeply can't open ${origin} with this GitHub login.`);
    if (!r.json.permissions || !r.json.permissions.push) throw new Error(`This GitHub login can't push to ${origin}.`);
    repo = origin; base = r.json.default_branch || 'main'; kind = 'repo';
    updateProject(cwd, home, (p) => ({ ...p, repo, base, kind }));
    await installWorkflowInRepo({ api, repo, base });
  } else {
    ({ repo, created } = await ensureMirror({ api, cwd, home }));
    updateProject(cwd, home, (p) => ({ ...p, base: 'main', kind: 'mirror' }));
    skipped = (await pushSnapshot({ cwd, token, home, serverUrl, remoteUrl })).skipped;
  }
  await configureModel({ api, repo, model });
  if (envText != null) await setProjectEnv({ api, repo, envText });
  updateProject(cwd, home, (p) => ({ ...p, modelSig: cfg.sig, modelName: cfg.kind === 'auto' ? 'Auto' : (model.name || model.model), enabled: true, workflowRev: WORKFLOW_REV }));
  await ensureTrackKey({ api, repo, cwd, home, fetchImpl });
  await syncCloudConnections({ home, fetchImpl });
  return { repo, created, kind, base, url: `${(serverUrl || 'https://github.com').replace(/\/$/, '')}/${repo}`, skipped };
}

/** Before a PC run is protected (handoff.mjs): the repo's craft-cloud.yml must know handoff runs. */
export async function ensureHandoffReady({ cwd, token, home = defaultHome(), apiUrl, fetchImpl, serverUrl, remoteUrl }) {
  const p = getProject(cwd, home);
  if (!p || !p.repo) throw new Error('Set up cloud runs for this project first.');
  if (p.workflowRev === WORKFLOW_REV) return p;
  if (p.kind === 'repo') await installWorkflowInRepo({ api: githubApi({ token, apiUrl, fetchImpl }), repo: p.repo, base: p.base || 'main' });
  else await pushSnapshot({ cwd, token, home, serverUrl, remoteUrl }); // the mirror gets the workflow with every snapshot
  return updateProject(cwd, home, (q) => ({ ...q, workflowRev: WORKFLOW_REV }));
}

// ─── Runs ────────────────────────────────────────────────────────────────

const newTaskId = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIVE_FRESH_MS = 60000;

/** Is a runner up for this chat right now (idle and waiting, or busy and will get to it)? */
export async function liveRunner(api, repo, sessionId) {
  if (!sessionId) return null;
  const f = await branchFiles(api, repo).read(SESSION_PATHS.live(sessionId)).catch(() => null);
  const live = f && f.json;
  if (!live || Date.now() - (live.at || 0) > LIVE_FRESH_MS) return null;
  if (!live.busy && (live.until || 0) < Date.now() + 8000) return null;
  return live;
}

async function dispatch(api, repo, base, task, retryMs) {
  let lastErr = null;
  // Right after the workflow file first lands, GitHub can take a few seconds to know it.
  for (let i = 0; i < 10; i++) {
    try {
      await api('POST', `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref: base || 'main', inputs: { prompt: task.prompt, mode: task.mode, task_id: task.id, session_id: task.sessionId } });
      return;
    } catch (e) {
      lastErr = e;
      if (e.status !== 404 && e.status !== 422) break;
      await sleep(retryMs);
    }
  }
  throw lastErr;
}

/**
 * Start a cloud task. A runner already up for this chat gets it through the
 * queue at once; otherwise a new runner is dispatched. Mirror projects push
 * the latest snapshot first.
 */
export async function startCloudRun({ cwd, token, prompt, mode = 'Build', sessionId = '', bot = null, kind = 'code', model, home = defaultHome(), apiUrl, serverUrl, fetchImpl, remoteUrl, retryMs = 3000, startedAt }) {
  const p = getProject(cwd, home);
  if (!p || !p.repo) throw new Error('Set up cloud runs for this project first.');
  prompt = String(prompt || '').trim();
  if (!prompt) throw new Error('Write a task first.');
  if (prompt.length > MAX_PROMPT) throw new Error(`That task is too long for a cloud run (${prompt.length} characters, the limit is ${MAX_PROMPT}).`);
  mode = ['Build', 'Plan', 'Ask'].includes(mode) ? mode : 'Build';
  const api = githubApi({ token, apiUrl, fetchImpl });
  // model: undefined leaves the repo's model as it is; null (Auto selected) or a model sets it
  if (model !== undefined) {
    const cfg = cloudModelConfig(model);
    if (cfg.sig !== p.modelSig) {
      await configureModel({ api, repo: p.repo, model });
      updateProject(cwd, home, (q) => ({ ...q, modelSig: cfg.sig, modelName: cfg.kind === 'auto' ? 'Auto' : (model.name || model.model) }));
    }
  }
  const base = p.base || 'main';
  // repos set up before a workflow change get the new file once (mirrors get it with every snapshot)
  if (p.kind === 'repo' && p.workflowRev !== WORKFLOW_REV) {
    await installWorkflowInRepo({ api, repo: p.repo, base });
    updateProject(cwd, home, (q) => ({ ...q, workflowRev: WORKFLOW_REV }));
  }
  await ensureTrackKey({ api, repo: p.repo, cwd, home, fetchImpl });
  await syncCloudConnections({ home, fetchImpl });
  let baseSha;
  if (p.kind === 'repo') {
    const ref = await api('GET', `/repos/${p.repo}/git/ref/heads/${encodeURIComponent(base)}`, null, { allow: [404] });
    baseSha = ref.status === 200 ? ref.json.object.sha : null;
  } else {
    baseSha = (await pushSnapshot({ cwd, token, home, serverUrl, remoteUrl })).sha;
  }
  const task = { id: newTaskId(), prompt, mode, sessionId: String(sessionId || ''), baseSha, repo: p.repo, status: 'starting', attempt: 1, startedAt: startedAt || Date.now() };
  const b = cleanBot(bot);
  const extra = { ...(b ? { bot: b } : {}), ...(cleanKind(kind) === 'task' ? { kind: 'task' } : {}) };
  if (b) task.bot = { name: b.name };
  if (extra.kind) task.kind = 'task';
  const files = branchFiles(api, p.repo);
  if (baseSha) await files.ensure(baseSha).catch(() => {}); // craft-sessions, with Vercel told not to deploy it
  const live = await liveRunner(api, p.repo, task.sessionId);
  if (live) {
    await files.write(`${SESSION_PATHS.queue(task.sessionId)}/${Date.now()}-${task.id}.json`, { id: task.id, prompt, mode, ...extra }, `Craft queue ${task.id}`);
    Object.assign(task, { queued: true, enqueuedAt: Date.now() });
  } else {
    // A bot's prompt is too big for a workflow input: the runner reads it from craft-sessions.
    if (Object.keys(extra).length) {
      if (baseSha) await files.ensure(baseSha).catch(() => {});
      if (!(await files.write(SESSION_PATHS.request(task.id), extra, `Craft request ${task.id}`))) throw new Error('Could not hand the bot to the cloud. Try again.');
    }
    await dispatch(api, p.repo, base, task, retryMs);
  }
  saveTask(cwd, home, task);
  return task;
}

/** A task's live status document (tasks/<id>.json), or null before the runner has written it. */
export async function readTaskDoc(api, repo, taskId) {
  const f = await branchFiles(api, repo).read(SESSION_PATHS.task(taskId)).catch(() => null);
  return f && f.json ? f.json : null;
}

/** Where a cloud task is: its status file first, then the workflow run (for starts and failed starts). */
/** The person's answer to a cloud run's question (allow or not), picked up by the runner within seconds. */
export async function answerCloudAsk({ cwd, token, taskId, askId, approve, home = defaultHome(), apiUrl, fetchImpl }) {
  const task = getTask(cwd, taskId, home);
  if (!task) throw new Error('Unknown cloud task.');
  if (!/^[\w.-]+$/.test(String(askId || ''))) throw new Error('Unknown question.');
  const api = githubApi({ token, apiUrl, fetchImpl });
  const ok = await branchFiles(api, task.repo).write(SESSION_PATHS.answer(askId), { verdict: approve ? 'approve' : 'reject', at: Date.now() }, `Craft answer ${askId}`);
  if (!ok) throw new Error('Could not send your answer to GitHub. Try again.');
  saveTask(cwd, home, { ...task, ask: null });
  return true;
}

/** "ask" (risky actions wait for an OK) or "full" (they just run), kept as the repo variable CRAFT_PERMISSIONS. */
export async function setCloudPermission({ cwd, token, permission, home = defaultHome(), apiUrl, fetchImpl }) {
  const p = getProject(cwd, home);
  if (!p || !p.repo) throw new Error('Set up cloud runs for this project first.');
  const value = permission === 'full' ? 'full' : 'ask';
  await setVariable(githubApi({ token, apiUrl, fetchImpl }), p.repo, 'CRAFT_PERMISSIONS', value);
  updateProject(cwd, home, (q) => ({ ...q, permission: value }));
  return value;
}

/** A running task's status file untouched this long, with its workflow run over: the runner died. */
const STALE_DOC_MS = 4 * 60 * 1000;
/** A task marked "retrying" that the new run never picked up. */
const STALE_RETRY_MS = 15 * 60 * 1000;

/** Start a task's workflow again (a poller's fallback for a runner that died without leaving a verdict). */
async function redispatch(api, task, base, attempt, wip) {
  await api('POST', `/repos/${task.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref: base || 'main', inputs: {
    prompt: task.prompt, mode: task.mode, task_id: task.id, session_id: task.sessionId || '', attempt: String(attempt), handoff: '', wip: wip || '', lease: '',
  } });
}

const retryText = (attempt) => `Retrying (attempt ${attempt})`;

export async function cloudRunStatus({ cwd, taskId, token, home = defaultHome(), apiUrl, fetchImpl, retryMs = 3000, notifyImpl }) {
  const task = getTask(cwd, taskId, home);
  if (!task) throw new Error('Unknown cloud task.');
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return task;
  const api = githubApi({ token, apiUrl, fetchImpl });
  const next = { ...task };
  const base = (getProject(cwd, home) || {}).base || 'main';
  const doc = await readTaskDoc(api, task.repo, task.id);
  if (doc) {
    const { events = [], status, ...rest } = doc;
    if (doc.runId) { next.runId = doc.runId; next.runUrl = `https://github.com/${task.repo}/actions/runs/${doc.runId}`; }
    if (doc.attempt) next.attempt = doc.attempt;
    next.needsYou = Array.isArray(doc.needsYou) ? doc.needsYou : [];
    next.health = doc.health || null;
    next.parked = doc.parked || null;
    next.wip = doc.wip || null;
    let dead = null;
    if (status === 'done' || status === 'failed') {
      const { id: _i, startedAt: _s, updatedAt: _u, runId: _r, attempt: _a, maxAttempts: _m, needsYou: _n, health: _h, parked: _p, wip: _w, notify: _y, retry: _t, ...result } = rest;
      Object.assign(next, { status, result, error: result.error || null, finishedAt: Date.now(), queued: false, retry: null, progress: '' });
      // The runner's push may not have gone out (no usage key): this PC raises it, once.
      if (doc.notify) {
        next.notify = doc.notify;
        if (!doc.notify.pushed && !task.notifiedAt) {
          next.notifiedAt = Date.now();
          const sent = await (notifyImpl || ((n) => deliverNotice({ notice: n, fetchImpl })))(doc.notify).catch(() => false);
          if (!sent) next.notifiedAt = null; // signed out: nothing was sent, and a finished task is not polled again
        } else if (doc.notify.pushed) next.notifiedAt = task.notifiedAt || Date.now();
      }
    } else if (status === 'retrying') {
      // Not failed: a new run is taking over from the saved work.
      const n = (doc.retry && doc.retry.attempt) || doc.attempt || 2;
      next.status = 'running';
      next.retry = { attempt: n, of: (doc.retry && doc.retry.of) || MAX_RETRIES + 1, reason: (doc.retry && doc.retry.reason) || '' };
      next.progress = retryText(n);
      if (Date.now() - (doc.updatedAt || Date.now()) > STALE_RETRY_MS) {
        Object.assign(next, { status: 'failed', retry: null, progress: '', error: 'The task stopped and could not be started again. Open the run on GitHub to see why.', finishedAt: Date.now() });
      }
    } else {
      next.status = 'running';
      next.retry = null;
      next.progress = next.health ? 'Waiting for the model' : '';
      // A runner that died leaves a "running" file that nobody touches. The workflow run tells dead from slow.
      if (Date.now() - (doc.updatedAt || Date.now()) > STALE_DOC_MS && doc.runId) {
        const run = (await api('GET', `/repos/${task.repo}/actions/runs/${doc.runId}`, null, { allow: [404] }).catch(() => ({ json: null }))).json;
        if (run && run.status === 'completed') dead = doc;
      }
    }
    // A next.ask is a risky action waiting for the person's OK (answerCloudAsk)
    next.ask = next.status === 'running' && doc.ask && doc.ask.id ? doc.ask : null;
    if (dead && !(await branchFiles(api, task.repo).read(SESSION_PATHS.cancel(task.id)).catch(() => null))) {
      const n = doc.attempt || 1;
      if (n <= MAX_RETRIES) {
        const wip = (await api('GET', `/repos/${task.repo}/branches/${encodeURIComponent(wipBranch(`task-${task.id}`))}`, null, { allow: [404] }).catch(() => ({ status: 404 }))).status === 200 ? wipBranch(`task-${task.id}`) : '';
        await redispatch(api, task, base, n + 1, wip);
        const retry = { attempt: n + 1, of: MAX_RETRIES + 1, reason: 'The run stopped before it finished.', at: Date.now() };
        await branchFiles(api, task.repo).write(SESSION_PATHS.task(task.id), { ...doc, status: 'retrying', attempt: n + 1, retry, updatedAt: Date.now() }, `Craft task ${task.id}: retrying`);
        Object.assign(next, { status: 'running', retry, attempt: n + 1, progress: retryText(n + 1) });
      } else {
        Object.assign(next, { status: 'failed', retry: null, progress: '', error: 'The cloud run stopped before it finished, and starting it again twice did not help.', finishedAt: Date.now() });
      }
    }
    saveTask(cwd, home, next);
    return { ...next, events };
  }
  if (task.queued) {
    // Handed to a runner that went away before taking it: start a new one.
    if (Date.now() - task.enqueuedAt > 30000 && !(await liveRunner(api, task.repo, task.sessionId))) {
      const p = getProject(cwd, home) || {};
      await dispatch(api, task.repo, p.base || 'main', task, retryMs);
      Object.assign(next, { queued: false, status: 'starting', redispatchedAt: Date.now() });
    } else next.status = 'queued';
    saveTask(cwd, home, next);
    return { ...next, events: [] };
  }
  // Started again a moment ago: the old run is over, the new one may not be listed yet.
  if (task.retriedAt && Date.now() - task.retriedAt < 90000) {
    Object.assign(next, { status: 'running', progress: retryText(task.attempt || 2) });
    saveTask(cwd, home, next);
    return { ...next, events: [] };
  }
  let run = null;
  if (task.runId) run = (await api('GET', `/repos/${task.repo}/actions/runs/${task.runId}`)).json;
  else {
    const list = (await api('GET', `/repos/${task.repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=30`)).json;
    run = (list.workflow_runs || []).find((r) => r.display_title === checkName(task.id)) || null;
  }
  if (!run) {
    // GitHub drops a dispatch it can't start; don't wait forever.
    if (Date.now() - task.startedAt > 5 * 60 * 1000) Object.assign(next, { status: 'failed', error: 'GitHub never started the run. Check that Actions is enabled on the repo.' });
    saveTask(cwd, home, next);
    return { ...next, events: [] };
  }
  next.runId = run.id;
  next.runUrl = run.html_url;
  if (run.status === 'completed') {
    // Finished without a status file: it died before Craft could report (or an older engine ran).
    const checks = (await api('GET', `/repos/${task.repo}/commits/${run.head_sha}/check-runs?check_name=${encodeURIComponent(checkName(task.id))}`)).json;
    const check = (checks.check_runs || [])[0];
    let data = {};
    try { data = JSON.parse((check && check.output && check.output.text) || '{}'); } catch {}
    if (check && check.status === 'completed' && data.mode) {
      const { events = [], ...result } = data;
      Object.assign(next, { status: check.conclusion === 'success' ? 'done' : 'failed', result, error: result.error || null, finishedAt: Date.now() });
      saveTask(cwd, home, next);
      return { ...next, events };
    }
    const cancelled = run.conclusion === 'cancelled';
    const n = task.attempt || 1;
    const onPurpose = cancelled && (await branchFiles(api, task.repo).read(SESSION_PATHS.cancel(task.id)).catch(() => null));
    // It never said how it ended and nobody stopped it: start it again, twice at most.
    if (!onPurpose && !(run.conclusion === 'success') && n <= MAX_RETRIES) {
      await redispatch(api, task, base, n + 1, '');
      Object.assign(next, { status: 'running', attempt: n + 1, retriedAt: Date.now(), runId: null, runUrl: null, retry: { attempt: n + 1, of: MAX_RETRIES + 1, reason: 'The run stopped before it finished.' }, progress: retryText(n + 1) });
      saveTask(cwd, home, next);
      return { ...next, events: [] };
    }
    const why = cancelled ? 'The run was cancelled.' : (await diagnoseRun(api, task.repo, run.id)) || `The run ended (${run.conclusion}) before Codeply could report back. The run log has details.`;
    Object.assign(next, { status: cancelled ? 'cancelled' : 'failed', error: why, finishedAt: Date.now(), retry: null, progress: '' });
  } else {
    next.status = run.status === 'queued' || run.status === 'waiting' || run.status === 'pending' ? 'queued' : 'running';
  }
  saveTask(cwd, home, next);
  return { ...next, events: [] };
}

/** Download a cloud screenshot (shots/<task>/<n>.png on craft-sessions) to `dest`. */
export async function downloadShot({ token, repo, path: rel, dest, apiUrl, fetchImpl }) {
  const api = githubApi({ token, apiUrl, fetchImpl });
  const r = await api('GET', `/repos/${repo}/contents/${rel.split('/').map(encodeURIComponent).join('/')}?ref=${SESSIONS_BRANCH}`, null, { allow: [404] });
  if (r.status !== 200 || !r.json || !r.json.content) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(r.json.content, 'base64'));
  return dest;
}

/**
 * Before coding: is the local branch behind GitHub (a cloud run merged work
 * into it)? Only for projects whose cloud target is their own repo.
 */
/**
 * Background git talks to GitHub with Craft's own GitHub login (when given),
 * never through Windows' credential manager, which would pop up a sign-in
 * window every time Craft checks for new commits.
 */
const QUIET_GIT = ['-c', 'credential.helper='];
const quietAuth = (token) => (token ? { server: 'https://github.com', token } : undefined);

export async function checkBehind(cwd, { token } = {}) {
  try {
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => null);
    if (!upstream) return { ok: false, reason: 'no upstream' };
    await git(cwd, [...QUIET_GIT, 'fetch', '-q', '--no-tags', upstream.split('/')[0]], { auth: quietAuth(token) });
    const [behind, ahead] = (await git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).split(/\s+/).map(Number);
    const dirty = !!(await git(cwd, ['status', '--porcelain', '--untracked-files=no']));
    const latest = behind ? (await git(cwd, ['log', '-1', '--format=%s', upstream]).catch(() => '')) : '';
    return { ok: true, branch, upstream, behind, ahead, dirty, latest };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** Pull what GitHub has (a fast-forward when possible, else a merge; stashes local edits around it). */
export async function pullLatest(cwd, { token } = {}) {
  const st = await checkBehind(cwd, { token });
  if (!st.ok) throw new Error(`Can't pull: ${st.reason}.`);
  if (!st.behind) return { pulled: 0 };
  let stashed = false;
  if (st.dirty) { await git(cwd, ['stash', 'push', '-q', '-m', 'craft: before pulling cloud changes']); stashed = true; }
  try {
    await git(cwd, [...QUIET_GIT, '-c', 'user.name=Codeply', '-c', 'user.email=craft-bot@users.noreply.github.com', 'pull', '-q', '--no-rebase', '--no-edit'], { auth: quietAuth(token) });
  } catch (e) {
    // A conflicting pull is undone, so the project is never left half-merged.
    const conflicted = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
    await git(cwd, ['merge', '--abort']).catch(() => {});
    throw new Error(conflicted.length
      ? `GitHub's changes clash with your commits in ${conflicted.join(', ')}, so nothing was pulled. Commit or undo those, then pull again.`
      : `Could not pull: ${e.message}`);
  } finally {
    if (stashed) await git(cwd, ['stash', 'pop', '-q']).catch(() => { throw new Error('Pulled, but your own edits clashed with them. They are saved in git stash.'); });
  }
  return { pulled: st.behind };
}


/**
 * Runs started somewhere else (the phone, while this PC was off) become local
 * tasks, so their changes can be pulled here. Only finished runs are imported.
 */
export async function importRemoteTasks({ cwd, token, home = defaultHome(), apiUrl, fetchImpl, limit = 20 }) {
  const p = getProject(cwd, home);
  if (!p || !p.repo) return [];
  const api = githubApi({ token, apiUrl, fetchImpl });
  const known = new Set((p.tasks || []).map((t) => t.id));
  const list = (await api('GET', `/repos/${p.repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&status=completed&per_page=${limit}`, null, { allow: [404] })).json;
  const added = [];
  for (const run of (list && list.workflow_runs) || []) {
    const id = String(run.display_title || '').replace(/^craft /, '');
    if (!/^[A-Za-z0-9_-]+$/.test(id) || known.has(id)) continue;
    const checks = (await api('GET', `/repos/${p.repo}/commits/${run.head_sha}/check-runs?check_name=${encodeURIComponent(checkName(id))}`)).json;
    const check = (checks.check_runs || [])[0];
    if (!check || check.status !== 'completed') continue;
    let result = {};
    try { result = JSON.parse(check.output.text || '{}'); } catch {}
    delete result.events;
    const task = {
      id, prompt: result.prompt || '(started elsewhere)', mode: result.mode || 'Build', sessionId: result.sessionId || '', baseSha: result.baseSha || run.head_sha,
      repo: p.repo, runId: run.id, runUrl: run.html_url, status: check.conclusion === 'success' ? 'done' : 'failed', result, error: result.error || null,
      startedAt: Date.parse(run.created_at) || Date.now(), finishedAt: Date.parse(run.updated_at) || Date.now(), remote: true,
    };
    saveTask(cwd, home, task);
    added.push(task);
  }
  return added;
}

/** Stop a cloud run. */
export async function cancelCloudRun({ cwd, taskId, token, home = defaultHome(), apiUrl, fetchImpl }) {
  const task = await cloudRunStatus({ cwd, taskId, token, home, apiUrl, fetchImpl });
  if (!task.runId || ['done', 'failed', 'cancelled'].includes(task.status)) return task;
  const api = githubApi({ token, apiUrl, fetchImpl });
  // First say it is on purpose: a run that dies is started again, a cancelled one must not be.
  await branchFiles(api, task.repo).write(SESSION_PATHS.cancel(task.id), { at: Date.now() }, `Craft cancel ${task.id}`).catch(() => {});
  await api('POST', `/repos/${task.repo}/actions/runs/${task.runId}/cancel`, null, { allow: [409] });
  return task;
}

/**
 * Bring a finished run's code changes into the local project. Stages the
 * current working tree first, so the 3-way merge keeps edits made since the
 * run started; overlapping edits come back as conflict markers.
 */
export async function pullCloudRun({ cwd, taskId, token, home = defaultHome(), serverUrl = 'https://github.com', remoteUrl }) {
  const task = getTask(cwd, taskId, home);
  if (!task) throw new Error('Unknown cloud task.');
  if (task.status !== 'done') throw new Error('That cloud run has not finished.');
  if (!task.result || !task.result.branch) return { files: [], conflicts: [], applied: false, message: 'That run did not change any files.' };
  if (task.pulledAt) return { files: task.result.files || [], conflicts: [], applied: false, message: 'Already applied.' };
  const m = await initMirrorGit(cwd, home);
  const url = remoteUrl || `${serverUrl.replace(/\/$/, '')}/${task.repo}.git`;
  const ref = `refs/craft/tasks/${task.id}`;
  await git(cwd, ['--git-dir', m.gitDir, 'fetch', '-q', '--no-tags', url, `+refs/heads/${task.result.branch}:${ref}`], { auth: authFor(token, serverUrl) });
  const patch = await git(cwd, ['--git-dir', m.gitDir, 'diff', '--binary', '--full-index', task.baseSha, ref, '--', '.', `:(exclude)${WORKFLOW_PATH}`, ':(exclude).codeply']);
  if (!patch.trim()) return { files: [], conflicts: [], applied: false, message: 'That run did not change any files.' };
  const files = (await git(cwd, ['--git-dir', m.gitDir, 'diff', '--name-only', task.baseSha, ref, '--', '.', `:(exclude)${WORKFLOW_PATH}`, ':(exclude).codeply'])).split('\n').filter(Boolean);
  await stageWorkingTree(cwd, home);
  let conflicts = [];
  try {
    await m.G(['apply', '--3way', '--whitespace=nowarn', '-'], { input: `${patch}\n` });
  } catch (e) {
    const unmerged = await m.G(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    conflicts = unmerged.split('\n').filter(Boolean);
    if (!conflicts.length) throw new Error(`Could not apply the changes: ${e.message}`);
  }
  saveTask(cwd, home, { ...task, pulledAt: Date.now(), conflicts });
  return { files, conflicts, applied: true };
}

// ─── The runner (inside GitHub Actions) ─────────────────────────────────

function describeTool(ev) {
  const a = ev.args || {};
  const what = a.path || a.file || a.command || a.pattern || a.query || a.url || '';
  return `- ${ev.ok === false ? '(failed) ' : ''}${ev.name}${what ? ` ${String(what).split('\n')[0].slice(0, 100)}` : ''}`;
}

function renderProgress(lines, note) {
  const shown = lines.length > 60 ? [`- ... ${lines.length - 60} earlier steps`, ...lines.slice(-60)] : lines;
  return `${note}\n\n${shown.join('\n')}`.slice(0, MAX_OUTPUT);
}

// ─── The run as a chat: every step the agent took, published live ─────────
// Cloud chats look like local ones (commands, edits with their + and - lines,
// narration, the "what actually happened" card), so the runner records the
// same events the desktop gets from a local run and puts them in the check
// run's text, where the PC and the phone read them while it works.

const EVENT_BUDGET = 58000;
const clipText = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n...` : s);

/** One agent event as a small record; tool arguments kept the way the chat shows them. */
export function recordEvent(ev) {
  if (ev.type === 'text') return { t: 'text', text: clipText(ev.text, 8000), interim: !!ev.interim };
  if (ev.type === 'reasoning') return { t: 'reasoning', text: clipText(ev.text, 2000), ms: ev.ms };
  if (ev.type === 'notice') return { t: 'notice', level: ev.level || 'info', text: clipText(ev.text, 1000) };
  if (ev.type === 'tool_end') {
    const a = ev.args || {};
    let args;
    if (ev.name === 'write_file') args = { path: a.path };
    else if (ev.name === 'apply_patch') args = { files: (ev.meta && ev.meta.files) || [] };
    else {
      args = {};
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'string') args[k] = clipText(v, k === 'search' || k === 'replace' ? 3000 : 1500);
        else if (typeof v === 'number' || typeof v === 'boolean') args[k] = v;
        else if (Array.isArray(v)) args[k] = v.slice(0, 50);
      }
    }
    const m = ev.meta || {};
    return {
      t: 'tool', name: ev.name, ok: ev.ok, summary: clipText(ev.summary || '', 300), args,
      ...(typeof m.exitCode === 'number' ? { exitCode: m.exitCode } : {}),
      ...(typeof m.added === 'number' ? { added: m.added } : {}),
      ...(typeof m.removed === 'number' ? { removed: m.removed } : {}),
    };
  }
  if (ev.type === 'done' && Array.isArray(ev.actions)) {
    const changed = ev.actions.filter((x) => x.ok && ['write_file', 'edit_file', 'apply_patch', 'fetch_image'].includes(x.tool))
      .flatMap((x) => (Array.isArray(x.files) && x.files.length ? x.files.map((f) => ({ ...x, label: f })) : [x]));
    const checks = ev.actions.filter((x) => ['run', 'browser_check'].includes(x.tool));
    if (!changed.length && !checks.length) return null;
    return {
      t: 'summary', files: [...new Set(changed.map((x) => x.label))].slice(0, 30),
      checks: [...new Map(checks.map((x) => [`${x.tool}|${x.label}`, x])).values()].slice(-8).map((x) => ({ tool: x.tool, label: x.label, ok: x.ok, exitCode: x.exitCode })),
      unverified: ev.unverifiedFiles || [],
    };
  }
  return null;
}

/** Fit the event list in the check run's text: shorten diffs, drop thinking, then the oldest steps. */
export function packEvents(events, budget = EVENT_BUDGET) {
  let list = events.map((e) => ({ ...e }));
  const size = () => JSON.stringify(list).length;
  if (size() <= budget) return list;
  list = list.map((e) => (e.t === 'reasoning' ? { ...e, text: clipText(e.text, 200) } : e));
  for (const n of [800, 200]) {
    if (size() <= budget) return list;
    list = list.map((e) => (e.t === 'tool' && e.args ? { ...e, args: Object.fromEntries(Object.entries(e.args).map(([k, v]) => [k, typeof v === 'string' ? clipText(v, n) : v])) } : e));
  }
  let dropped = 0;
  while (size() > budget && list.length > 1) { list.shift(); dropped++; }
  if (dropped) list.unshift({ t: 'notice', level: 'info', text: `${dropped} earlier step${dropped === 1 ? '' : 's'} are only in the run log.` });
  return list;
}

// ─── Files on the craft-sessions branch (chat memory, status, queue, shots) ──

export const SESSION_PATHS = {
  history: (sid) => `sessions/${sid}.json`,
  task: (id) => `tasks/${id}.json`,
  live: (sid) => `live/${sid}.json`,
  queue: (sid) => `queue/${sid}`,
  shot: (id, n) => `shots/${id}/${n}.png`,
  // A risky action waiting for the person: Craft or the phone writes the answer here.
  answer: (askId) => `answers/${askId}.json`,
  // What does not fit in the workflow's inputs (a bot's prompt), written before the dispatch.
  request: (id) => `requests/${id}.json`,
  // Written when the person stops a task: a run that dies afterwards is not started again.
  cancel: (id) => `cancel/${id}.json`,
};

/**
 * A task's optional bot: { name, prompt }, the full prompt the PC built
 * (bots.js buildBotPrompt). Anything else, or an empty prompt, is no bot.
 */
export function cleanBot(bot) {
  if (!bot || typeof bot !== 'object') return null;
  const prompt = String(bot.prompt || '').trim().slice(0, MAX_BOT_PROMPT);
  if (!prompt) return null;
  return { name: String(bot.name || 'Bot').trim().slice(0, 80) || 'Bot', prompt };
}
/** 'task' is a job for a bot (not about the repo): its final reply is what the user hears. */
const cleanKind = (k) => (k === 'task' ? 'task' : 'code');

/** Small read / write / delete / list helpers for one branch, with retries for concurrent writes. */
export function branchFiles(api, repo, branch = SESSIONS_BRANCH) {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const read = async (p) => {
    const r = await api('GET', `/repos/${repo}/contents/${enc(p)}?ref=${branch}`, null, { allow: [404] });
    if (r.status !== 200 || !r.json || Array.isArray(r.json)) return null;
    let json = null;
    try { json = JSON.parse(Buffer.from(r.json.content || '', 'base64').toString('utf8')); } catch {}
    return { json, sha: r.json.sha, size: r.json.size };
  };
  const list = async (p) => {
    const r = await api('GET', `/repos/${repo}/contents/${enc(p)}?ref=${branch}`, null, { allow: [404] });
    return r.status === 200 && Array.isArray(r.json) ? r.json.map((x) => ({ name: x.name, path: x.path, sha: x.sha })) : [];
  };
  const put = async (p, content, message) => {
    for (let i = 0; i < 4; i++) {
      const cur = await api('GET', `/repos/${repo}/contents/${enc(p)}?ref=${branch}`, null, { allow: [404] });
      const sha = cur.status === 200 && cur.json && !Array.isArray(cur.json) ? cur.json.sha : undefined;
      const r = await api('PUT', `/repos/${repo}/contents/${enc(p)}`, { message, branch, content, ...(sha ? { sha } : {}) }, { allow: [409, 422] });
      if (r.status < 300) return true;
      await sleep(300 + i * 400);
    }
    return false;
  };
  const write = (p, obj, message = `Craft ${p}`) => put(p, Buffer.from(JSON.stringify(obj)).toString('base64'), message);
  const writeBytes = (p, buf, message = `Craft ${p}`) => put(p, Buffer.from(buf).toString('base64'), message);
  const remove = async (p, sha) => {
    for (let i = 0; i < 3; i++) {
      const s = sha || (await read(p) || {}).sha;
      if (!s) return;
      const r = await api('DELETE', `/repos/${repo}/contents/${enc(p)}`, { message: `Craft ${p}`, branch, sha: s }, { allow: [404, 409, 422] });
      if (r.status < 300 || r.status === 404) return;
      sha = null;
      await sleep(300);
    }
  };
  const ensure = async (baseSha) => {
    const ref = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`, null, { allow: [404] });
    if (ref.status === 404) await api('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha }, { allow: [422] });
    // craft-sessions is only task state, written many times per task. Hosts that deploy every branch (Vercel)
    // would start a deployment for each write, so the branch tells them not to deploy it.
    if (branch === SESSIONS_BRANCH) {
      const cur = await read('vercel.json').catch(() => null);
      if (!(cur && cur.json && cur.json.git && cur.json.git.deploymentEnabled === false)) {
        await put('vercel.json', Buffer.from(`${JSON.stringify(NO_DEPLOY, null, 2)}\n`).toString('base64'), 'Craft: never deploy this branch').catch(() => {});
      }
    }
  };
  return { read, list, write, writeBytes, remove, ensure };
}

async function loadHistory(files, sessionId) {
  if (!sessionId) return { messages: [] };
  const f = await files.read(SESSION_PATHS.history(sessionId));
  return { messages: f && f.json && Array.isArray(f.json.messages) ? f.json.messages : [] };
}

async function saveHistory(files, sessionId, messages) {
  if (!sessionId) return;
  await files.write(SESSION_PATHS.history(sessionId), { sessionId, updatedAt: new Date().toISOString(), messages }, `Chat ${sessionId}`);
}

const branchSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 40) || 'change';
export const cloudBranchName = (prompt, id) => `craft/${branchSlug(prompt)}-${String(id).slice(-6)}`;

// ─── Surviving crashes: retries, the lease, the notice ────────────────────

/** A run that dies is started again from its last save, twice at most (3 tries in all). */
export const MAX_RETRIES = 2;
/** The agent is stopped this long into the run, 8 minutes before Actions' 60 minute limit, so there is time to save and start again. */
export const RUN_BUDGET_MS = 52 * 60 * 1000;
export const LEASE_BEAT_MS = 15000;
/** The task's status file is touched this often while the agent works, so a reader can tell "slow" from "dead". */
export const TOUCH_MS = 45000;
/** Failures that starting again cannot fix (keys, sign-in, billing). */
const NO_RETRY = /api key|usage key|unauthori[sz]ed|\b40[13]\b|not signed in|invalid key|billing|quota exceeded/i;

/** An error that says whether a new run could do better. */
class RunError extends Error {
  constructor(message, { retryable = true, reason = '' } = {}) { super(message); this.retryable = retryable; this.reason = reason; }
}

/**
 * The runner's side of the handoff lease (the watchdog's "cloud_beat" action,
 * checked with the token it put in the dispatch). beat(finish) resolves to
 * 'running', 'finished', 'lost' (a replacement took over, or the PC took the
 * chat back: stop at once) or 'error' (offline: carry on, the next beat may work).
 * Null without a token: a run that is not under a lease.
 */
export function cloudLeaseClient({ env, sessionId, taskId, fetchImpl = fetch }) {
  const token = String(env.CRAFT_LEASE || '').trim();
  if (!token || !sessionId) return null;
  let auth = null;
  try { auth = require('./auth.js'); } catch { return null; }
  const url = env.CRAFT_LEASE_URL || `${auth.SUPABASE_URL}/functions/v1/handoff-watchdog`;
  return {
    async beat(finish = false) {
      try {
        const r = await fetchImpl(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', apikey: auth.SUPABASE_ANON_KEY },
          body: JSON.stringify({ action: 'cloud_beat', session_id: sessionId, task_id: taskId, token, finish: !!finish }),
          signal: AbortSignal.timeout(15_000),
        });
        const j = await r.json().catch(() => ({}));
        if (j && j.lost) return 'lost';
        return r.ok && j && j.ok ? (finish ? 'finished' : 'running') : 'error';
      } catch { return 'error'; }
    },
  };
}

/**
 * Tell the person the result as a phone/desktop push, with the plumbing the
 * run already has: the usage key (CODEPLY_TRACK_KEY) it sends to Codeply's
 * functions, calling the same `reminders` function the apps use to schedule a
 * reminder for "now". Best effort and never fatal: true only when Codeply
 * accepted it. When it is not accepted the notice stays in the task's status
 * file (`notify`), and the app that polls the task raises it (see deliverNotice).
 */
export async function pushNotice({ env, notice, fetchImpl = fetch }) {
  const key = String(env.CODEPLY_TRACK_KEY || '').trim();
  if (!key || String(env.CRAFT_NOTIFY || '') === 'off') return false;
  try {
    const auth = require('./auth.js');
    const r = await fetchImpl(`${auth.SUPABASE_URL}/functions/v1/reminders`, {
      method: 'POST',
      headers: { 'x-codeply-track-key': key, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', reminder: { text: noticeText(notice), due_at: new Date().toISOString(), kind: 'remind', tz: 'UTC', bot_id: null, bot_name: 'Codeply', bot_voice: null } }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    return !!(r.ok && j && j.success);
  } catch { return false; }
}

const noticeText = (n) => `${n.title}. ${n.body}`.slice(0, 480);

/**
 * The PC's half: a finished task whose notice the runner could not push (no usage
 * key, or Codeply refused it) is sent now with the person's own sign-in, once.
 */
export async function deliverNotice({ notice, fetchImpl = fetch }) {
  try {
    const auth = require('./auth.js');
    const token = await auth.getAccessToken().catch(() => null);
    if (!token) return false;
    const r = await fetchImpl(`${auth.SUPABASE_URL}/functions/v1/reminders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', reminder: { text: noticeText(notice), due_at: new Date().toISOString(), kind: 'remind', tz: 'UTC', bot_id: null, bot_name: 'Codeply', bot_voice: null } }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    return !!(r.ok && j && j.success);
  } catch { return false; }
}

/** What to tell the person when a task ends: done, done but something waits for them, or failed for good. */
export function buildNotice({ ok, taskId, answer = '', error = '', needsYou = [] }) {
  const at = Date.now();
  const clip = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (!ok) return { id: `${taskId}:failed`, kind: 'failed', title: 'Your cloud task did not finish', body: clip(error, 180) || 'It stopped before it finished.', at };
  if (needsYou.length) {
    const what = needsYou.slice(0, 3).map((n) => n.title).join('; ');
    return { id: `${taskId}:needs_you`, kind: 'needs_you', title: 'Your cloud task needs you', body: `It finished, but ${needsYou.length === 1 ? 'one action was' : `${needsYou.length} actions were`} skipped because nobody could approve ${needsYou.length === 1 ? 'it' : 'them'}: ${clip(what, 150)}.`, at };
  }
  return { id: `${taskId}:done`, kind: 'done', title: 'Your cloud task is done', body: clip(answer, 180) || 'It finished.', at };
}

/**
 * `codeply cloud runner`, inside GitHub Actions. Runs the dispatched task, then
 * (for a chat) stays up to CRAFT_IDLE_MS (2 minutes) waiting for the next
 * message in queue/<session>, so a follow-up starts at once instead of waiting
 * for a new runner. Each task:
 *   - runs like a local run, with a real browser (screenshots) when Chrome is there
 *   - publishes its steps live to tasks/<id>.json (and the first one's check run)
 *   - saves its work to craft/wip-task-<id> about every minute and when it fails
 *   - commits Build work to craft/<what-it-did>-<id>, pushes it, and merges it
 *     into the base branch (CRAFT_MERGE=false keeps it as a branch only)
 *   - if it crashes, fails or runs out of time (RUN_BUDGET_MS), starts the workflow
 *     again from the saved work (status 'retrying', twice at most)
 *   - tells the person when it is done, needs them, or failed for good
 * Under a handoff lease (CRAFT_LEASE) it renews the lease every 15 s, and stops
 * at once when the lease is lost.
 * @returns {Promise<{status:'done'|'failed'|'retrying'|'stopped', result:object, results:object[]}>}
 */
export async function runCloudRunner({ env = process.env, cwd = process.cwd(), token, route, setupError = null, fetchImpl = fetch, runAgentImpl = runAgent, log = () => {}, maxSteps = 80, updateMs = 4000, idleMs, pollMs = 3000, browserImpl, leaseImpl, notifyImpl, wipEveryMs = RUNNER_WIP_EVERY_MS, beatMs = LEASE_BEAT_MS, touchMs = TOUCH_MS, deadlineAt }) {
  const repo = env.GITHUB_REPOSITORY;
  const firstId = String(env.CRAFT_TASK_ID || '').replace(/[^A-Za-z0-9_-]/g, '');
  const sessionId = String(env.CRAFT_SESSION_ID || '').replace(/[^A-Za-z0-9_-]/g, '');
  const headSha = env.GITHUB_SHA;
  if (!repo || !token || !firstId || !headSha) return { status: 'failed', result: { error: 'Missing GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_SHA or CRAFT_TASK_ID.' }, results: [] };
  const apiUrl = env.GITHUB_API_URL || 'https://api.github.com';
  const serverUrl = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
  const api = githubApi({ token, apiUrl, fetchImpl });
  const files = branchFiles(api, repo);
  const idle = idleMs != null ? idleMs : Number(env.CRAFT_IDLE_MS || 120000);
  const base = env.CRAFT_BASE || env.GITHUB_REF_NAME || 'main';
  const merge = String(env.CRAFT_MERGE || 'true') !== 'false';
  const attempt = Math.max(1, Math.floor(Number(env.CRAFT_ATTEMPT) || 1));
  const deadline = deadlineAt != null ? deadlineAt : Date.now() + (Number(env.CRAFT_BUDGET_MS) || RUN_BUDGET_MS);
  await files.ensure(headSha).catch((e) => log(`Could not create ${SESSIONS_BRANCH}: ${e.message}`));

  // A retry that was dispatched just before the person pressed Stop must not run.
  if (attempt > 1 && await files.read(SESSION_PATHS.cancel(firstId)).catch(() => null)) {
    return { status: 'stopped', result: { error: 'This task was cancelled.' }, results: [] };
  }
  // Under a handoff lease: this run must still own it (a replacement may have been dispatched while this one queued).
  const lease = leaseImpl !== undefined ? leaseImpl : cloudLeaseClient({ env, sessionId, taskId: firstId, fetchImpl });
  const fence = { lost: false, abort: null };
  if (lease && (await lease.beat(false)) === 'lost') return { status: 'stopped', result: { error: 'A newer cloud run took over this task.' }, results: [] };
  const beatTimer = lease ? setInterval(async () => {
    if ((await lease.beat(false).catch(() => 'error')) === 'lost' && !fence.lost) { fence.lost = true; if (fence.abort) fence.abort(); }
  }, beatMs) : null;
  if (beatTimer && beatTimer.unref) beatTimer.unref();

  await loadCloudConnections({ env, log });

  // The project's environment for running and testing: never committed.
  const envFile = path.join(cwd, '.env');
  if (env.CRAFT_ENV && String(env.CRAFT_ENV).trim()) {
    try { if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, `${String(env.CRAFT_ENV).trim()}\n`); } catch (e) { log(`Could not write .env: ${e.message}`); }
  }
  const browser = browserImpl !== undefined ? browserImpl : (await import('./cloud-browser.mjs')).makeCloudBrowser();

  const heartbeat = (busy, until) => files.write(SESSION_PATHS.live(sessionId), { runId: env.GITHUB_RUN_ID || null, busy, at: Date.now(), until }, `Craft live ${sessionId}`).catch(() => {});

  let task = { id: firstId, prompt: String(env.CRAFT_PROMPT || ''), mode: env.CRAFT_MODE, sessionId, dispatched: true };
  // A run carried on from the PC: the checked-out craft/wip-<chat> holds its state.
  if (String(env.CRAFT_HANDOFF || '') === 'resume' && sessionId) {
    const state = takeStateFile(cwd);
    if (state) task = { ...task, prompt: state.userMessage || task.prompt, mode: state.mode || task.mode, handoff: state };
    else setupError = setupError || 'The run from the PC left no saved state on its WIP branch.';
  } else if (env.CRAFT_WIP) {
    // A cloud run that died and was started again: its own WIP branch holds the work and the state.
    const state = takeStateFile(cwd);
    if (state) task = { ...task, prompt: state.userMessage || task.prompt, mode: state.mode || task.mode, resume: state, resumeSha: await git(cwd, ['rev-parse', 'HEAD']).catch(() => null) };
    else log('The saved work had no state file, so this run starts from the task as it was asked.');
  }
  // A bot (and the task kind) comes next to the dispatch, on craft-sessions.
  const req = await files.read(SESSION_PATHS.request(firstId)).catch(() => null);
  if (req && req.json) {
    task = { ...task, bot: req.json.bot, kind: req.json.kind };
    await files.remove(SESSION_PATHS.request(firstId), req.sha).catch(() => {});
  }
  const notify = notifyImpl || ((notice) => pushNotice({ env, notice, fetchImpl }));
  const ctl = { attempt, deadline, wipEveryMs, touchMs, fence, notify, lease };
  const results = [];
  const isHandoff = !!task.handoff;
  try {
    while (task) {
      // A handoff run is not a chat runner: new messages for this chat get their own run.
      const live = sessionId && !task.handoff;
      if (live) await heartbeat(true, Date.now() + 60 * 60 * 1000);
      const r = await runOneTask({ task, env, cwd, api, files, repo, token, serverUrl, headSha, route, setupError, runAgentImpl, log, maxSteps, updateMs, browser, base, merge, heartbeat: live ? () => heartbeat(true, Date.now() + 60 * 60 * 1000) : null, handbackPollMs: pollMs, ctl });
      results.push(r);
      // Retrying: a new runner takes the task over, so this one must not wait for the chat's next message.
      if (r.status === 'retrying' || r.status === 'stopped' || fence.lost) break;
      if (!live || idle <= 0 || setupError) break;
      task = await waitForNext({ files, sessionId, idle, pollMs, heartbeat });
    }
  } finally {
    if (beatTimer) clearInterval(beatTimer);
    if (sessionId && !isHandoff) await files.remove(SESSION_PATHS.live(sessionId)).catch(() => {});
    if (browser && browser.close) await browser.close().catch(() => {});
    // Done with the lease (the PC picks the work up from here), unless a retry carries it on.
    const end = results[results.length - 1];
    if (lease && !fence.lost && end && (end.status === 'done' || end.status === 'failed')) await lease.beat(true).catch(() => {});
  }
  const last = results[results.length - 1] || { status: 'failed', result: { error: 'Nothing ran.' } };
  return { ...last, results };
}

/** Idle: the next queued message for this chat, or null after `idle` ms of nothing. */
async function waitForNext({ files, sessionId, idle, pollMs, heartbeat }) {
  const deadline = Date.now() + idle;
  let beat = 0;
  while (Date.now() < deadline) {
    if (Date.now() - beat > 20000) { await heartbeat(false, deadline); beat = Date.now(); }
    const items = (await files.list(SESSION_PATHS.queue(sessionId)).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      const f = await files.read(it.path).catch(() => null);
      await files.remove(it.path, f && f.sha).catch(() => {});
      const t = f && f.json;
      if (!t || !t.id) continue;
      // Picked up by another runner already (it was re-dispatched): skip.
      if (await files.read(SESSION_PATHS.task(t.id)).catch(() => null)) continue;
      return { ...t, sessionId, dispatched: false };
    }
    await sleep(pollMs);
  }
  return null;
}

// What every unattended run is told. The skip rule is here because the declined-action note the
// agent adds itself says "stop and explain"; nobody is there to read an explanation mid-run.
const UNATTENDED = "Nobody can answer questions mid-run, so make sensible choices and say what you assumed. If an action is skipped because it needs an approval nobody can give (a deploy, deleting data), take a safe alternative and keep going: prepare the change but leave the risky step undone, and say in your final reply what still needs the user's OK.";

async function runOneTask({ task, env, cwd, api, files, repo, token, serverUrl, headSha, route, setupError, runAgentImpl, log, maxSteps, updateMs, browser, base, merge, heartbeat, handbackPollMs = 3000, ctl }) {
  const taskId = String(task.id).replace(/[^A-Za-z0-9_-]/g, '');
  const mode = ['Build', 'Plan', 'Ask'].includes(task.mode) ? task.mode : 'Build';
  const prompt = String(task.prompt || '').slice(0, MAX_PROMPT);
  const sessionId = task.sessionId || '';
  const bot = cleanBot(task.bot);
  const kind = cleanKind(task.kind);
  const attempt = task.dispatched ? ctl.attempt : 1; // a follow-up taken from the queue is always a first try
  const resume = task.resume || null;                // a plain run started again from its own WIP
  // A new try carries on the same task: same id, same steps so far.
  const prevDoc = attempt > 1 ? ((await files.read(SESSION_PATHS.task(taskId)).catch(() => null)) || {}).json || null : null;
  const startedAt = (prevDoc && prevDoc.startedAt) || Date.now();
  const events = prevDoc && Array.isArray(prevDoc.events) ? [...prevDoc.events] : [];
  const needsYou = prevDoc && Array.isArray(prevDoc.needsYou) ? [...prevDoc.needsYou] : [];
  const lines = [];
  let healthInfo = null; let parkedInfo = null; let wipInfo = null;

  // The dispatched task also gets a check run: it is how a failed start is diagnosed.
  const check = task.dispatched ? (await api('POST', `/repos/${repo}/check-runs`, {
    name: checkName(taskId), head_sha: headSha, status: 'in_progress', started_at: new Date().toISOString(),
    output: { title: 'Starting', summary: 'Starting...' },
  }).catch(() => ({ json: null }))).json : null;

  let pendingAsk = null; let asks = 0;
  const statusDoc = (status, extra = {}) => ({
    ...(pendingAsk && status === 'running' ? { ask: pendingAsk } : {}), id: taskId, status, mode, prompt: prompt.slice(0, 4000), sessionId,
    ...(kind === 'task' ? { kind } : {}), ...(bot ? { bot: { name: bot.name } } : {}),
    attempt, maxAttempts: MAX_RETRIES + 1,
    ...(needsYou.length ? { needsYou } : {}), ...(healthInfo ? { health: healthInfo } : {}), ...(parkedInfo ? { parked: parkedInfo } : {}), ...(wipInfo ? { wip: wipInfo } : {}),
    startedAt, updatedAt: Date.now(), runId: env.GITHUB_RUN_ID || null, ...extra,
  });
  const state = task.handoff || null; // a run carried on from the PC
  const finish = async (ok, title, summary, result, { retry = null } = {}) => {
    const baseLen = JSON.stringify(result).length;
    const packed = packEvents(events, Math.max(4000, MAX_OUTPUT - baseLen - 200));
    // The notice goes in the status file whether or not the push worked: an app that polls can still raise it.
    let notice = retry ? null : buildNotice({ ok, taskId, answer: result.answer, error: result.error, needsYou });
    if (notice) notice = { ...notice, pushed: await ctl.notify(notice).catch(() => false) };
    const doc = statusDoc(retry ? 'retrying' : ok ? 'done' : 'failed', {
      ...result, ...(retry ? { retry, attempt: retry.attempt } : {}), ...(notice ? { notify: notice } : {}), events: packEvents(events, 400000),
    });
    await files.write(SESSION_PATHS.task(taskId), doc, `Craft task ${taskId}: ${retry ? 'retrying' : title}`).catch(() => {});
    if (check) {
      await api('PATCH', `/repos/${repo}/check-runs/${check.id}`, {
        status: 'completed', conclusion: retry ? 'neutral' : ok ? 'success' : 'failure', completed_at: new Date().toISOString(),
        output: { title: retry ? 'Starting again' : title, summary: String(summary || title).slice(0, MAX_OUTPUT), text: JSON.stringify({ ...result, events: packed }).slice(0, MAX_OUTPUT) },
      }).catch((e) => log(`Could not finish the check run: ${e.message}`));
    }
    return { status: retry ? 'retrying' : ok ? 'done' : 'failed', result: { ...result, events: packed }, ...(retry ? { retry } : {}), ...(state ? { handoff: true } : {}) };
  };

  // Handoff: the work goes on craft/wip-<chat> with the state next to it, never merged.
  // done.json tells the PC where it ended: 'paused' (it asked for the chat back),
  // 'done' or 'failed'.
  const commitWip = async (status) => {
    if (!state) return null;
    state.side = 'cloud';
    fs.writeFileSync(path.join(cwd, STATE_FILE), JSON.stringify({ ...state, savedAt: Date.now() }));
    await git(cwd, ['add', '-A', '--', '.', ':(exclude).codeply', `:(exclude)${WORKFLOW_PATH}`, ':(exclude).env']);
    await git(cwd, [...BOT, 'commit', '-q', '--allow-empty', '-m', `Craft WIP ${sessionId} (cloud, ${state.steps.length} steps)`]);
    try { fs.unlinkSync(path.join(cwd, STATE_FILE)); } catch {}
    const sha = await git(cwd, ['rev-parse', 'HEAD']);
    // Not forced: if anything else moved the branch, this side lost the lease.
    await git(cwd, ['push', '-q', 'origin', `HEAD:refs/heads/${wipBranch(sessionId)}`], { auth: authFor(token, serverUrl) });
    if (status) {
      await files.write(HANDBACK.done(sessionId), { sha, status, taskId, at: Date.now() }, `Craft handback ${sessionId}`);
      const want = await files.read(HANDBACK.want(sessionId)).catch(() => null);
      if (want) await files.remove(HANDBACK.want(sessionId), want.sha).catch(() => {});
    }
    return sha;
  };

  if (setupError) return finish(false, 'Could not start', setupError, { error: setupError, mode });
  if (!prompt) return finish(false, 'Could not start', 'The task was empty.', { error: 'The task was empty.', mode });

  // Every run that is not a handoff keeps its own WIP, through a throwaway index so HEAD and the
  // final commit stay as they are: the files plus the steps so far, pushed to craft/wip-task-<id>.
  const wipKey = `task-${taskId}`;
  let wipState = null; let wipSha = null; let wipMark = null; let wipBusy = false;
  let originUrl;
  const checkpoint = async (final = false) => {
    if (state || !wipState) return wipSha;
    if (wipBusy && !final) return wipSha;
    while (wipBusy) await sleep(50); // the final save waits for one already on its way
    wipBusy = true;
    try {
      if (originUrl === undefined) originUrl = (await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '')) || null;
      const r = await pushRunnerWip({ cwd, token, repo, key: wipKey, state: wipState, parent: wipSha, last: wipMark, force: !wipSha, serverUrl, remoteUrl: originUrl || undefined });
      wipMark = r.key;
      if (r.pushed) { wipSha = r.sha; wipInfo = { branch: wipBranch(wipKey), sha: r.sha.slice(0, 12), at: Date.now() }; }
    } catch (e) { log(`WIP save failed: ${e.message}`); }
    finally { wipBusy = false; }
    return wipSha;
  };

  let lastPush = 0; let pending = null;
  const pushProgress = async (note, force = false) => {
    if (!force && Date.now() - lastPush < updateMs) return;
    lastPush = Date.now();
    const packed = packEvents(events);
    pending = Promise.all([
      files.write(SESSION_PATHS.task(taskId), statusDoc('running', { events: packEvents(events, 400000) }), `Craft task ${taskId}`).catch(() => {}),
      check ? api('PATCH', `/repos/${repo}/check-runs/${check.id}`, { output: { title: 'Working', summary: renderProgress(lines, note), text: JSON.stringify({ running: true, events: packed }) } }).catch(() => {}) : null,
      heartbeat ? heartbeat() : null,
    ]);
    await pending;
  };

  // Screenshots go next to the status, where the PC and the phone read them.
  let shots = 0; let pendingShot = null;
  const agentBrowser = browser ? async (url, opts) => {
    const r = await browser(url, opts);
    if (r && r.ok && r.screenshotPath) {
      try {
        const rel = SESSION_PATHS.shot(taskId, ++shots);
        if (await files.writeBytes(rel, fs.readFileSync(r.screenshotPath), `Craft screenshot ${taskId}`)) pendingShot = rel;
      } catch {}
    }
    return r;
  } : undefined;

  const timers = [];
  try {
    // Where this task starts (a later message in the same runner starts after the earlier merge).
    const headNow = await git(cwd, ['rev-parse', 'HEAD']).catch(() => headSha);
    // A restarted run's own WIP commit is HEAD: what it changed is measured from where the task first began.
    const taskBase = resume && resume.baseSha ? resume.baseSha : headNow;
    if (!state) {
      wipState = resume ? { ...resume, side: 'cloud' } : newRunState({ sessionId: wipKey, mode, userMessage: prompt, history: [] });
      wipState.baseSha = taskBase;
      if (resume && task.resumeSha) wipSha = task.resumeSha;
    }
    const hist = state ? { messages: Array.isArray(state.history) ? state.history : [] }
      : resume ? { messages: Array.isArray(resume.history) ? resume.history : [] } : await loadHistory(files, sessionId);
    if (!state && !resume) wipState.history = hist.messages.slice(-HISTORY_TURNS);
    if (state) events.push({ t: 'notice', level: 'info', text: `Your PC went offline, so the cloud is carrying on from step ${state.steps.length + 1}.` });
    else if (attempt > 1) events.push({ t: 'notice', level: 'info', text: `The run stopped before it finished, so it started again (attempt ${attempt} of ${MAX_RETRIES + 1})${resume ? ` from its last save, after ${resume.steps.length} step${resume.steps.length === 1 ? '' : 's'}` : ''}.` });
    await pushProgress(state ? 'Carrying on from your PC.' : attempt > 1 ? `Starting again (attempt ${attempt}).` : hist.messages.length ? `Continuing the chat (${hist.messages.length / 2} earlier turns).` : 'Working on it.', true);
    // Risky actions (deploys...) ask the person unless the repo's Cloud permission is "full".
    const ASK_WAIT_MS = 15 * 60 * 1000;
    // The agent may push its own work to these branches and no others (never the base branch, never forced).
    const ownBranch = cloudBranchName(prompt, taskId);
    const pushBranches = [ownBranch, wipBranch(wipKey)];
    // Only a repo with the current workflow passes CRAFT_PERMISSIONS (empty when unset): its
    // Craft and phone can show the question. An older setup keeps the old rule (no) until updated.
    const rules = ciApprove(cwd, { permission: env.CRAFT_PERMISSIONS, canAsk: env.CRAFT_PERMISSIONS !== undefined, pushBranches });
    const wait = (req, why) => {
      // "Needs you": what was skipped, for the person to look at when they are back.
      needsYou.push({ id: `${taskId}-n${needsYou.length + 1}`, at: Date.now(), tool: req.tool, title: String(req.title || req.tool).slice(0, 300), detail: String(req.detail || '').slice(0, 2000), why });
    };
    const approve = async (req) => {
      const v = await rules(req);
      if (v === 'reject' && req.danger) wait(req, 'not_allowed'); // nobody can be asked on this setup
      if (v !== 'ask') return v;
      const askId = `${taskId}-${++asks}`;
      pendingAsk = { id: askId, tool: req.tool, title: String(req.title || req.tool).slice(0, 300), detail: String(req.detail || '').slice(0, 2000), at: Date.now() };
      events.push({ t: 'notice', level: 'info', text: `Waiting for your OK: ${pendingAsk.title}` });
      await pushProgress('Waiting for your OK.', true);
      const until = Date.now() + ASK_WAIT_MS;
      let verdict = null;
      while (Date.now() < until && !verdict) {
        await sleep(4000);
        const f = await files.read(SESSION_PATHS.answer(askId)).catch(() => null);
        if (f && f.json) { verdict = f.json.verdict === 'approve' ? 'once' : 'reject'; files.remove(SESSION_PATHS.answer(askId), f.sha).catch(() => {}); }
        else if (heartbeat) heartbeat(true).catch(() => {});
      }
      if (!verdict) wait(req, 'no_answer');
      events.push({ t: 'notice', level: 'info', text: verdict === 'once' ? 'Approved.' : verdict === 'reject' ? 'You said no, so it was skipped.' : `No answer in 15 minutes, so it was skipped and the task carried on without it. It is listed under "Needs you": ${pendingAsk.title}` });
      pendingAsk = null;
      await pushProgress('Working.', true);
      return verdict || 'reject';
    };
    // The agent may push to its own branch, so git needs a login. A credential helper (a file outside the
    // checkout, answering only for this GitHub host) keeps the token out of the environment, where a
    // stray `env` would print it into the chat's steps.
    if (mode === 'Build' && process.platform !== 'win32') {
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-git-'));
        const helper = path.join(dir, 'helper.sh');
        const host = new URL(serverUrl).host;
        fs.writeFileSync(helper, `#!/bin/sh\n[ "$1" = get ] || exit 0\nif grep -qx 'host=${host}'; then echo username=x-access-token; echo password=${token}; fi\n`, { mode: 0o700 });
        // Added after whatever git settings the machine already passes this way, and taken out again after.
        const n = Math.max(0, Math.floor(Number(process.env.GIT_CONFIG_COUNT) || 0));
        const before = process.env.GIT_CONFIG_COUNT;
        Object.assign(process.env, { GIT_CONFIG_COUNT: String(n + 2), [`GIT_CONFIG_KEY_${n}`]: 'credential.helper', [`GIT_CONFIG_VALUE_${n}`]: '', [`GIT_CONFIG_KEY_${n + 1}`]: 'credential.helper', [`GIT_CONFIG_VALUE_${n + 1}`]: `!sh ${helper}` });
        timers.push({ stop: () => {
          for (const k of [`GIT_CONFIG_KEY_${n}`, `GIT_CONFIG_VALUE_${n}`, `GIT_CONFIG_KEY_${n + 1}`, `GIT_CONFIG_VALUE_${n + 1}`]) delete process.env[k];
          if (before === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = before;
          fs.rmSync(dir, { recursive: true, force: true });
        } });
      } catch (e) { log(`Could not set up git login for the agent: ${e.message}`); }
    }
    let answer = ''; let steps = 0; let failure = '';
    const where = kind === 'task'
      ? "in the cloud on a Linux machine, not on the user's PC: you cannot reach their local files or desktop apps. Use the shell, the web and this repository."
      : 'in the cloud, in a fresh copy of the repository on a Linux machine. You can install dependencies, run the app and tests, and check pages with browser_check.';
    const closing = kind === 'task'
      ? "Your final reply is read out to the user: say plainly what you did or found, in a few short sentences, no markdown. Do not commit or push; Codeply does that when you finish."
      : mode === 'Build'
        ? `Codeply saves your work as you go and commits when you finish, so you do not need to commit or push. If you want to save it yourself, you may push to \`${ownBranch}\` only (git push origin HEAD:${ownBranch}); every other push is blocked.`
        : 'Do not commit or push; Codeply does that when you finish.';
    const userMessage = state
      ? `${continuationPrompt(state, 'cloud')}\n\n(You are now in the cloud, on a Linux machine with a copy of the project as the PC left it. ${UNATTENDED} Do not commit or push; Codeply does that.)`
      : resume
        ? `${continuationPrompt(resume, 'retry')}\n\n(You are running unattended in the cloud, in a fresh copy of the repository on a Linux machine with the saved work in it. ${UNATTENDED} ${closing})`
        : `${prompt}\n\n(You are running unattended ${where} ${UNATTENDED} ${closing})`;
    const ac = new AbortController();
    ctl.fence.abort = () => ac.abort();
    let handedBack = false; let lastWant = Date.now(); let lastWip = Date.now();
    let timedOut = false; let completed = false; let ledger = (resume || state || {}).ledger || null;
    // The agent stops with time to spare: a run that is cut off by Actions' own limit can only be started again from the last save.
    const stopTimer = setTimeout(() => { timedOut = true; ac.abort(); }, Math.max(0, ctl.deadline - Date.now()));
    timers.push({ stop: () => clearTimeout(stopTimer) });
    if (!state) {
      const wipTimer = setInterval(() => { checkpoint(); }, ctl.wipEveryMs);
      timers.push({ stop: () => clearInterval(wipTimer) });
      if (wipTimer.unref) wipTimer.unref();
    }
    // Writing the status file now and then lets a reader tell a slow run from a dead one.
    const touchTimer = setInterval(() => { pushProgress(`Working: ${steps} step${steps === 1 ? '' : 's'} so far.`, true).catch(() => {}); }, ctl.touchMs);
    timers.push({ stop: () => clearInterval(touchTimer) });
    if (touchTimer.unref) touchTimer.unref();

    for await (const ev of runAgentImpl({ userMessage, history: hist.messages.slice(-HISTORY_TURNS), mode, cwd, approve, browser: agentBrowser, signal: ac.signal, route, maxSteps, background: true, ...(ledger ? { resume: ledger } : {}), ...(bot ? { botPrompt: bot.prompt } : {}), ...(state ? { todos: state.todos } : resume ? { todos: resume.todos } : {}) })) {
      if (state) {
        recordHandoff(state, ev);
        // Between steps: has the PC asked for the chat back? Then stop here, never mid-tool.
        if (!handedBack && (ev.type === 'tool_end' || Date.now() - lastWant > handbackPollMs)) {
          lastWant = Date.now();
          if (await files.read(HANDBACK.want(sessionId)).catch(() => null)) { handedBack = true; ac.abort(); events.push({ t: 'notice', level: 'info', text: 'Your PC is back, so the task is going back to it.' }); }
        }
        // A WIP every minute, so a runner that dies still leaves its work.
        if (!handedBack && ev.type === 'tool_end' && Date.now() - lastWip > 60000) { lastWip = Date.now(); await commitWip(null).catch((e) => log(`WIP push failed: ${e.message}`)); }
      } else if (wipState) recordHandoff(wipState, ev);
      // The model is struggling or unavailable (the agent keeps retrying in the background): say so, in plain words.
      if (ev.type === 'health') {
        const was = healthInfo && healthInfo.state;
        healthInfo = ev.state === 'ok' || ev.state === 'healthy' ? null : { state: ev.state, attempt: ev.attempt || 0, until: ev.until || null, reason: String(ev.reason || '').slice(0, 300) };
        if (healthInfo && was !== healthInfo.state) events.push({ t: 'notice', level: 'warn', text: `The model is not answering well right now${healthInfo.reason ? ` (${healthInfo.reason})` : ''}. Codeply keeps trying${healthInfo.until ? ` until ${new Date(healthInfo.until).toISOString().slice(11, 16)} UTC` : ''}.` });
        await pushProgress('Waiting for the model.', true);
        continue;
      }
      if (ev.type === 'parked') {
        parkedInfo = { until: ev.until || null, reason: String(ev.reason || 'The model was not available.').slice(0, 300) };
        ledger = ev.ledger || ledger;
        if (ledger) (wipState || state).ledger = ledger;
        break;
      }
      const rec = recordEvent(ev);
      if (rec && rec.t === 'tool' && ev.name === 'browser_check' && pendingShot) { rec.screenshot = pendingShot; pendingShot = null; }
      // The final answer arrives as the reply; everything else is part of the chat's steps.
      if (rec && !(rec.t === 'text' && !rec.interim)) events.push(rec);
      if (ev.type === 'text' && !ev.interim) answer = ev.text;
      else if (ev.type === 'tool_end') { steps++; lines.push(describeTool(ev)); }
      else if (ev.type === 'error') failure = ev.error;
      if (rec) await pushProgress(`Working: ${steps} step${steps === 1 ? '' : 's'} so far.`);
      if (ev.type === 'done') completed = true;
      if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted') break;
      if (handedBack && ev.type === 'tool_end') break;
    }
    for (const t of timers.splice(0)) t.stop();
    if (pending) await pending;
    // Another runner owns the task now: leave everything to it.
    if (ctl.fence.lost) return { status: 'stopped', result: { error: 'A newer cloud run took over this task.' } };
    if (timedOut && !completed && !handedBack) throw new RunError(`The run used up its time (about ${Math.round(RUN_BUDGET_MS / 60000)} minutes) before it finished.`, { reason: 'timeout' });
    if (parkedInfo && !answer) throw new RunError(`The model was not available${parkedInfo.until ? ` until about ${new Date(parkedInfo.until).toISOString().slice(11, 16)} UTC` : ''}.`, { reason: 'parked' });
    if (state) {
      if (failure && !answer && !handedBack) throw new Error(failure);
      const wipSha2 = await commitWip(handedBack ? 'paused' : 'done');
      const changed = (await git(cwd, ['diff', '--name-only', headSha, 'HEAD', '--', '.', `:(exclude)${STATE_FILE}`, `:(exclude)${WORKFLOW_PATH}`]).catch(() => '')).split('\n').filter(Boolean);
      const result = { mode, prompt: prompt.slice(0, 4000), sessionId, answer: handedBack ? '' : answer.slice(0, 20000), branch: null, sha: wipSha2, files: changed, stats: [], merged: null, steps, baseSha: headSha, handoff: { wipSha: wipSha2, handedBack } };
      return finish(true, handedBack ? 'Handed back to the PC' : changed.length ? `Changed ${changed.length} file${changed.length === 1 ? '' : 's'}` : 'Done', answer || 'Handed back to the PC.', result);
    }
    if (failure && !answer) throw new Error(failure);

    // The bot's own last words, before a plan file replaces the answer: what the phone speaks.
    const reply = answer;
    if (mode === 'Plan') {
      const dir = path.join(cwd, '.codeply', 'plans');
      const plans = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t) : [];
      if (plans.length) answer = fs.readFileSync(path.join(dir, plans[0].f), 'utf8');
    }

    let branch = null; let sha = null; let changed = []; let stats = []; let merged = null;
    if (mode === 'Build') {
      // A restarted run sits on its WIP commit: put HEAD back on where the task began, so the branch is one clean commit on it.
      if (resume && resume.baseSha && resume.baseSha !== headNow) {
        try {
          await git(cwd, ['fetch', '-q', '--depth=1', 'origin', resume.baseSha], { auth: authFor(token, serverUrl) });
          await git(cwd, ['reset', '-q', '--soft', resume.baseSha]);
        } catch (e) { log(`Could not go back to the start of the task, so the branch keeps the saved work as a commit: ${e.message}`); }
      }
      const from = await git(cwd, ['cat-file', '-e', `${taskBase}^{commit}`]).then(() => taskBase, () => 'HEAD');
      await git(cwd, ['add', '-A', '--', '.', ':(exclude).codeply', `:(exclude)${WORKFLOW_PATH}`, ':(exclude).env']);
      // Measured from where the task began, so work the agent committed itself still counts.
      const staged = await git(cwd, ['diff', '--cached', '--name-only', from]);
      if (staged) {
        changed = staged.split('\n').filter(Boolean);
        // Per-file + and - lines, for the chat's record of what was pushed.
        stats = (await git(cwd, ['diff', '--cached', '--numstat', from])).split('\n').filter(Boolean).map((l) => {
          const [add, del, ...name] = l.split('\t');
          return { file: name.join('\t'), added: add === '-' ? null : Number(add), removed: del === '-' ? null : Number(del) };
        });
        branch = ownBranch;
        const subject = prompt.split('\n')[0].slice(0, 60);
        if (await git(cwd, ['diff', '--cached', '--name-only'])) await git(cwd, [...BOT, 'commit', '-q', '-m', `${subject}\n\nCraft cloud task ${taskId}.`]);
        sha = await git(cwd, ['rev-parse', 'HEAD']);
        await git(cwd, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { auth: authFor(token, serverUrl) });
        // Into the base branch too, so the next run (and the PC's pull) starts from it.
        if (merge) {
          const m = await api('POST', `/repos/${repo}/merges`, { base, head: branch, commit_message: `Merge ${branch}: ${subject}` }, { allow: [204, 404, 409] }).catch((e) => ({ status: 0, error: e.message }));
          merged = m.status === 201 || m.status === 204
            ? { ok: true, base, sha: m.json && m.json.sha ? m.json.sha : sha }
            : { ok: false, base, reason: m.status === 409 ? `it conflicts with newer changes on ${base}` : (m.error || `GitHub answered ${m.status}`) };
          if (merged.ok) {
            // Keep working from the merged base for the next message in this chat.
            await git(cwd, ['fetch', '-q', 'origin', base], { auth: authFor(token, serverUrl) }).catch(() => {});
            await git(cwd, ['reset', '-q', '--hard', 'FETCH_HEAD']).catch(() => {});
          }
        }
        const plus = stats.reduce((n, s) => n + (s.added || 0), 0);
        const minus = stats.reduce((n, s) => n + (s.removed || 0), 0);
        events.push({ t: 'pushed', branch, sha: sha.slice(0, 7), files: stats.slice(0, 50), added: plus, removed: minus, merged });
      }
    }

    await saveHistory(files, sessionId, [...hist.messages, { role: 'user', content: prompt }, { role: 'assistant', content: answer || '(no reply)' }].slice(-HISTORY_TURNS * 2))
      .catch((e) => log(`Could not save the chat: ${e.message}`));
    // The work is on its real branch now: the saved copy has done its job.
    if (wipInfo || resume) await api('DELETE', `/repos/${repo}/git/refs/heads/${wipBranch(wipKey)}`, null, { allow: [404, 422] }).catch(() => {});
    const result = { mode, prompt: prompt.slice(0, 4000), sessionId, answer: answer.slice(0, 20000), branch, sha, files: changed, stats: stats.slice(0, 100), merged, steps, baseSha: taskBase,
      ...(bot || kind === 'task' ? { reply: reply.slice(0, 20000) } : {}) };
    const title = changed.length ? `Changed ${changed.length} file${changed.length === 1 ? '' : 's'}` : mode === 'Build' ? 'No files changed' : 'Answered';
    return finish(true, title, answer || title, result);
  } catch (e) {
    for (const t of timers.splice(0)) t.stop();
    if (ctl.fence.lost) return { status: 'stopped', result: { error: 'A newer cloud run took over this task.' } };
    const message = String((e && e.message) || e);
    // Keep the work first: a handoff run leaves it for the PC, any other run on its own WIP branch.
    if (state) await commitWip(null).catch((err) => log(`WIP push failed: ${err.message}`));
    else await checkpoint(true);
    // Then start again from it, unless this cannot get better (a key problem) or the tries are used up.
    let retry = null;
    const canRetry = (e && e.retryable === false ? false : !NO_RETRY.test(message)) && attempt <= MAX_RETRIES;
    if (canRetry) {
      try {
        const next = attempt + 1;
        const extra = { ...(bot ? { bot } : {}), ...(kind === 'task' ? { kind } : {}) };
        if (Object.keys(extra).length) await files.write(SESSION_PATHS.request(taskId), extra, `Craft request ${taskId}`);
        await api('POST', `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref: base, inputs: {
          prompt, mode, task_id: taskId, session_id: sessionId, attempt: String(next),
          handoff: state ? 'resume' : '', wip: !state && wipSha ? wipBranch(wipKey) : '', lease: env.CRAFT_LEASE || '',
        } });
        retry = { attempt: next, of: MAX_RETRIES + 1, reason: message.slice(0, 300), at: Date.now() };
      } catch (err) { log(`Could not start the task again: ${err.message}`); }
    }
    const steps = state ? state.steps.length : lines.length;
    if (retry) return finish(false, 'Starting again', `Something went wrong, so it is starting again (attempt ${retry.attempt} of ${retry.of}): ${message}`, { error: message, mode, steps, ...(wipInfo ? { wip: wipInfo } : {}) }, { retry });
    // Out of tries: a handoff run says so to the PC, which carries on from the saved work.
    const wipFinal = state ? await commitWip('failed').catch(() => null) : null;
    const tried = attempt > 1 ? ` It was tried ${attempt} times.` : '';
    return finish(false, 'Failed', `Something went wrong: ${message}${tried}`, { error: `${message}${tried}`, mode, steps, ...(wipInfo ? { wip: wipInfo } : {}), ...(state ? { handoff: { wipSha: wipFinal, handedBack: false } } : {}) });
  }
}

/** Route and token from the runner environment, with secrets removed from process.env. */
export function runnerSetup(env = process.env) {
  const cfg = { ...env };
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'CODEPLY_API_KEY', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) delete env[k];
  const r = routeFromEnv(cfg);
  return { cfg, token: cfg.GITHUB_TOKEN || cfg.GH_TOKEN, route: r.route, setupError: r.error || null };
}
