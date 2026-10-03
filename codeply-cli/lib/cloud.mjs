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

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');
const blake = require('blakejs');

export const WORKFLOW_FILE = 'craft-cloud.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
export const MIRROR_PREFIX = 'craft-workspace-';
export const MIRROR_DESCRIPTION = 'Craft workspace mirror: a private backup that Craft cloud runs work in.';
export const SESSIONS_BRANCH = 'craft-sessions';
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

permissions:
  contents: write
  checks: write

concurrency:
  group: craft-\${{ inputs.session_id || inputs.task_id }}
  cancel-in-progress: false

jobs:
  craft:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
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
          CODEPLY_MODEL_KIND: \${{ vars.CODEPLY_MODEL_KIND }}
          CODEPLY_MODEL: \${{ vars.CODEPLY_MODEL }}
          CODEPLY_BASE_URL: \${{ vars.CODEPLY_BASE_URL }}
          CRAFT_ENGINE: \${{ vars.CRAFT_ENGINE }}
          CRAFT_ENV: \${{ secrets.CRAFT_ENV }}
          CRAFT_MERGE: \${{ vars.CRAFT_MERGE }}
          CRAFT_BASE: \${{ github.ref_name }}
          CRAFT_PROMPT: \${{ inputs.prompt }}
          CRAFT_MODE: \${{ inputs.mode }}
          CRAFT_TASK_ID: \${{ inputs.task_id }}
          CRAFT_SESSION_ID: \${{ inputs.session_id }}
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
      return `GitHub couldn't install Craft's cloud engine (${ENGINE}): that version isn't on npm yet. Publish it, then run again.`;
    }
    if (/Resource not accessible by integration/i.test(log)) return 'GitHub refused the run permission to save its work. Check Settings > Actions > General > Workflow permissions on the mirror repo.';
    if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(log) && /npm (error|ERR)/i.test(log)) return 'GitHub\'s runner could not download Craft\'s engine (a network hiccup on GitHub\'s side). Run it again.';
    const lastError = log.split('\n').map((l) => l.replace(/^\S+Z\s/, '').replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter((l) => /error|failed|fatal/i.test(l) && !/^##\[group\]/.test(l)).slice(-1)[0];
    if (step && step.name === 'Run Craft') return `Craft stopped before it could report back${lastError ? `: ${lastError.replace(/^##\[error\]/, '').slice(0, 240)}` : '.'}`;
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
function saveTask(cwd, home, task) {
  return updateProject(cwd, home, (p) => {
    const tasks = (p.tasks || []).filter((t) => t.id !== task.id);
    tasks.unshift(task);
    return { ...p, tasks: tasks.slice(0, 100) };
  });
}
/** Per-project switches the app keeps: cloudOn (send new messages to the cloud), autoBackup. */
export function setProjectOptions(cwd, opts, home = defaultHome()) {
  const allowed = {};
  for (const k of ['cloudOn', 'autoBackup']) if (typeof opts[k] === 'boolean') allowed[k] = opts[k];
  return updateProject(cwd, home, (p) => ({ ...p, ...allowed }));
}

export function getTask(cwd, id, home = defaultHome()) {
  const p = getProject(cwd, home);
  return p && (p.tasks || []).find((t) => t.id === id) || null;
}

// ─── Snapshots ───────────────────────────────────────────────────────────

const BOT = ['-c', 'user.name=Codeply Craft', '-c', 'user.email=craft-bot@users.noreply.github.com'];

function mirrorGit(cwd, home) {
  const gitDir = path.join(home, 'cloud', `${projectId(cwd)}.git`);
  const G = (args, opts) => git(cwd, ['--git-dir', gitDir, '--work-tree', cwd, ...args], opts);
  return { gitDir, G };
}

async function initMirrorGit(cwd, home) {
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
async function stageWorkingTree(cwd, home) {
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

const authFor = (token, serverUrl = 'https://github.com') => ({ token, server: serverUrl.replace(/\/$/, '') });

/** Snapshot, then push it to the mirror. The mirror's main is Craft's, so it is force-pushed. */
export async function pushSnapshot({ cwd, token, home = defaultHome(), serverUrl = 'https://github.com', remoteUrl }) {
  const p = getProject(cwd, home);
  if (!p || !p.repo) throw new Error('Cloud is not set up for this project yet.');
  // A project that works in its own GitHub repo is never snapshotted: that would overwrite its real main.
  if (p.kind === 'repo') throw new Error(`${p.repo} is this project's own repo; Craft does not back up over it.`);
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

/** Which model the runner uses. Local models can't be reached from GitHub. */
export function cloudModelConfig(model) {
  if (!model || !model.model) return { error: 'Pick one of your own models first. Cloud runs use your key, not Auto.' };
  const kind = model.kind === 'ollama' ? 'ollama' : 'openai';
  const baseUrl = kind === 'ollama' ? String(model.baseUrl || 'https://ollama.com').replace(/\/+$/, '').replace(/\/(api|v1)$/i, '') : String(model.baseUrl || '').trim();
  if (!baseUrl) return { error: 'That model has no base URL.' };
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(baseUrl)) return { error: `${model.name || model.model} runs on this PC, so GitHub can't reach it. Pick a cloud model for cloud runs.` };
  if (!model.apiKey) return { error: `${model.name || model.model} has no API key.` };
  return { kind, baseUrl, model: model.model, apiKey: model.apiKey, sig: crypto.createHash('sha256').update([kind, baseUrl, model.model, model.apiKey].join('\n')).digest('hex').slice(0, 16) };
}

async function setVariable(api, repo, name, value) {
  const r = await api('PATCH', `/repos/${repo}/actions/variables/${name}`, { name, value }, { allow: [404] });
  if (r.status === 404) await api('POST', `/repos/${repo}/actions/variables`, { name, value });
}

/** Put the model key in the mirror's encrypted secrets and the rest in variables. */
export async function configureModel({ api, repo, model }) {
  const cfg = cloudModelConfig(model);
  if (cfg.error) throw new Error(cfg.error);
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
    return { ok: false, login: r.json.login, error: 'GitHub needs to be reconnected so Craft may create private repos and workflow files (repo and workflow access).' };
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
  const ok = await files.writeBytes(WORKFLOW_PATH, Buffer.from(CLOUD_WORKFLOW), 'Add Craft Cloud workflow');
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
    if (r.status !== 200) throw new Error(`Craft can't open ${origin} with this GitHub login.`);
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
  updateProject(cwd, home, (p) => ({ ...p, modelSig: cfg.sig, modelName: model.name || model.model, enabled: true }));
  return { repo, created, kind, base, url: `${(serverUrl || 'https://github.com').replace(/\/$/, '')}/${repo}`, skipped };
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
  if (model) {
    const cfg = cloudModelConfig(model);
    if (cfg.error) throw new Error(cfg.error);
    if (cfg.sig !== p.modelSig) {
      await configureModel({ api, repo: p.repo, model });
      updateProject(cwd, home, (q) => ({ ...q, modelSig: cfg.sig, modelName: model.name || model.model }));
    }
  }
  const base = p.base || 'main';
  let baseSha;
  if (p.kind === 'repo') {
    const ref = await api('GET', `/repos/${p.repo}/git/ref/heads/${encodeURIComponent(base)}`, null, { allow: [404] });
    baseSha = ref.status === 200 ? ref.json.object.sha : null;
  } else {
    baseSha = (await pushSnapshot({ cwd, token, home, serverUrl, remoteUrl })).sha;
  }
  const task = { id: newTaskId(), prompt, mode, sessionId: String(sessionId || ''), baseSha, repo: p.repo, status: 'starting', startedAt: startedAt || Date.now() };
  const b = cleanBot(bot);
  const extra = { ...(b ? { bot: b } : {}), ...(cleanKind(kind) === 'task' ? { kind: 'task' } : {}) };
  if (b) task.bot = { name: b.name };
  if (extra.kind) task.kind = 'task';
  const files = branchFiles(api, p.repo);
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
export async function cloudRunStatus({ cwd, taskId, token, home = defaultHome(), apiUrl, fetchImpl, retryMs = 3000 }) {
  const task = getTask(cwd, taskId, home);
  if (!task) throw new Error('Unknown cloud task.');
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return task;
  const api = githubApi({ token, apiUrl, fetchImpl });
  const next = { ...task };
  const doc = await readTaskDoc(api, task.repo, task.id);
  if (doc) {
    const { events = [], status, ...rest } = doc;
    if (doc.runId) { next.runId = doc.runId; next.runUrl = `https://github.com/${task.repo}/actions/runs/${doc.runId}`; }
    if (status === 'done' || status === 'failed') {
      const { id: _i, startedAt: _s, updatedAt: _u, runId: _r, ...result } = rest;
      Object.assign(next, { status, result, error: result.error || null, finishedAt: Date.now(), queued: false });
    } else next.status = 'running';
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
    const why = run.conclusion === 'cancelled' ? 'The run was cancelled.' : (await diagnoseRun(api, task.repo, run.id)) || `The run ended (${run.conclusion}) before Craft could report back. The run log has details.`;
    Object.assign(next, { status: run.conclusion === 'cancelled' ? 'cancelled' : 'failed', error: why, finishedAt: Date.now() });
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
export async function checkBehind(cwd) {
  try {
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => null);
    if (!upstream) return { ok: false, reason: 'no upstream' };
    await git(cwd, ['fetch', '-q', '--no-tags', upstream.split('/')[0]]);
    const [behind, ahead] = (await git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).split(/\s+/).map(Number);
    const dirty = !!(await git(cwd, ['status', '--porcelain', '--untracked-files=no']));
    const latest = behind ? (await git(cwd, ['log', '-1', '--format=%s', upstream]).catch(() => '')) : '';
    return { ok: true, branch, upstream, behind, ahead, dirty, latest };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** Pull what GitHub has (a fast-forward when possible, else a merge; stashes local edits around it). */
export async function pullLatest(cwd) {
  const st = await checkBehind(cwd);
  if (!st.ok) throw new Error(`Can't pull: ${st.reason}.`);
  if (!st.behind) return { pulled: 0 };
  let stashed = false;
  if (st.dirty) { await git(cwd, ['stash', 'push', '-q', '-m', 'craft: before pulling cloud changes']); stashed = true; }
  try {
    await git(cwd, ['-c', 'user.name=Codeply Craft', '-c', 'user.email=craft-bot@users.noreply.github.com', 'pull', '-q', '--no-rebase', '--no-edit']);
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
  // What does not fit in the workflow's inputs (a bot's prompt), written before the dispatch.
  request: (id) => `requests/${id}.json`,
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

/**
 * `codeply cloud runner`, inside GitHub Actions. Runs the dispatched task, then
 * (for a chat) stays up to CRAFT_IDLE_MS (2 minutes) waiting for the next
 * message in queue/<session>, so a follow-up starts at once instead of waiting
 * for a new runner. Each task:
 *   - runs like a local run, with a real browser (screenshots) when Chrome is there
 *   - publishes its steps live to tasks/<id>.json (and the first one's check run)
 *   - commits Build work to craft/<what-it-did>-<id>, pushes it, and merges it
 *     into the base branch (CRAFT_MERGE=false keeps it as a branch only)
 * @returns {Promise<{status:'done'|'failed', result:object, results:object[]}>}
 */
export async function runCloudRunner({ env = process.env, cwd = process.cwd(), token, route, setupError = null, fetchImpl = fetch, runAgentImpl = runAgent, log = () => {}, maxSteps = 80, updateMs = 4000, idleMs, pollMs = 3000, browserImpl }) {
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
  await files.ensure(headSha).catch((e) => log(`Could not create ${SESSIONS_BRANCH}: ${e.message}`));

  // The project's environment for running and testing: never committed.
  const envFile = path.join(cwd, '.env');
  if (env.CRAFT_ENV && String(env.CRAFT_ENV).trim()) {
    try { if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, `${String(env.CRAFT_ENV).trim()}\n`); } catch (e) { log(`Could not write .env: ${e.message}`); }
  }
  const browser = browserImpl !== undefined ? browserImpl : (await import('./cloud-browser.mjs')).makeCloudBrowser();

  const heartbeat = (busy, until) => files.write(SESSION_PATHS.live(sessionId), { runId: env.GITHUB_RUN_ID || null, busy, at: Date.now(), until }, `Craft live ${sessionId}`).catch(() => {});

  let task = { id: firstId, prompt: String(env.CRAFT_PROMPT || ''), mode: env.CRAFT_MODE, sessionId, dispatched: true };
  // A bot (and the task kind) comes next to the dispatch, on craft-sessions.
  const req = await files.read(SESSION_PATHS.request(firstId)).catch(() => null);
  if (req && req.json) {
    task = { ...task, bot: req.json.bot, kind: req.json.kind };
    await files.remove(SESSION_PATHS.request(firstId), req.sha).catch(() => {});
  }
  const results = [];
  try {
    while (task) {
      if (sessionId) await heartbeat(true, Date.now() + 60 * 60 * 1000);
      results.push(await runOneTask({ task, env, cwd, api, files, repo, token, serverUrl, headSha, route, setupError, runAgentImpl, log, maxSteps, updateMs, browser, base, merge, heartbeat: sessionId ? () => heartbeat(true, Date.now() + 60 * 60 * 1000) : null }));
      if (!sessionId || idle <= 0 || setupError) break;
      task = await waitForNext({ files, sessionId, idle, pollMs, heartbeat });
    }
  } finally {
    if (sessionId) await files.remove(SESSION_PATHS.live(sessionId)).catch(() => {});
    if (browser && browser.close) await browser.close().catch(() => {});
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

async function runOneTask({ task, env, cwd, api, files, repo, token, serverUrl, headSha, route, setupError, runAgentImpl, log, maxSteps, updateMs, browser, base, merge, heartbeat }) {
  const taskId = String(task.id).replace(/[^A-Za-z0-9_-]/g, '');
  const mode = ['Build', 'Plan', 'Ask'].includes(task.mode) ? task.mode : 'Build';
  const prompt = String(task.prompt || '').slice(0, MAX_PROMPT);
  const sessionId = task.sessionId || '';
  const bot = cleanBot(task.bot);
  const kind = cleanKind(task.kind);
  const startedAt = Date.now();
  const events = [];
  const lines = [];

  // The dispatched task also gets a check run: it is how a failed start is diagnosed.
  const check = task.dispatched ? (await api('POST', `/repos/${repo}/check-runs`, {
    name: checkName(taskId), head_sha: headSha, status: 'in_progress', started_at: new Date().toISOString(),
    output: { title: 'Starting', summary: 'Starting...' },
  }).catch(() => ({ json: null }))).json : null;

  const statusDoc = (status, extra = {}) => ({ id: taskId, status, mode, prompt: prompt.slice(0, 4000), sessionId, ...(kind === 'task' ? { kind } : {}), ...(bot ? { bot: { name: bot.name } } : {}), startedAt, updatedAt: Date.now(), runId: env.GITHUB_RUN_ID || null, ...extra });
  const finish = async (ok, title, summary, result) => {
    const baseLen = JSON.stringify(result).length;
    const packed = packEvents(events, Math.max(4000, MAX_OUTPUT - baseLen - 200));
    await files.write(SESSION_PATHS.task(taskId), statusDoc(ok ? 'done' : 'failed', { ...result, events: packEvents(events, 400000) }), `Craft task ${taskId}: ${title}`).catch(() => {});
    if (check) {
      await api('PATCH', `/repos/${repo}/check-runs/${check.id}`, {
        status: 'completed', conclusion: ok ? 'success' : 'failure', completed_at: new Date().toISOString(),
        output: { title, summary: String(summary || title).slice(0, MAX_OUTPUT), text: JSON.stringify({ ...result, events: packed }).slice(0, MAX_OUTPUT) },
      }).catch((e) => log(`Could not finish the check run: ${e.message}`));
    }
    return { status: ok ? 'done' : 'failed', result: { ...result, events: packed } };
  };

  if (setupError) return finish(false, 'Could not start', setupError, { error: setupError, mode });
  if (!prompt) return finish(false, 'Could not start', 'The task was empty.', { error: 'The task was empty.', mode });

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

  try {
    // Where this task starts (a later message in the same runner starts after the earlier merge).
    const taskBase = await git(cwd, ['rev-parse', 'HEAD']).catch(() => headSha);
    const hist = await loadHistory(files, sessionId);
    await pushProgress(hist.messages.length ? `Continuing the chat (${hist.messages.length / 2} earlier turns).` : 'Working on it.', true);
    const approve = ciApprove(cwd);
    let answer = ''; let steps = 0; let failure = '';
    const userMessage = kind === 'task'
      ? `${prompt}\n\n(You are running unattended in Codeply Cloud on a Linux machine, not on the user's PC: you cannot reach their local files or desktop apps. Use the shell, the web and this repository. Nobody can answer questions mid-run, so make sensible choices and say what you assumed. Your final reply is read out to the user: say plainly what you did or found, in a few short sentences, no markdown. Do not commit or push; Craft does that when you finish.)`
      : `${prompt}\n\n(You are running unattended in Craft Cloud, in a fresh copy of the repository on a Linux machine. Nobody can answer questions mid-run, so make sensible choices and say what you assumed. You can install dependencies, run the app and tests, and check pages with browser_check. Do not commit or push; Craft does that when you finish.)`;
    for await (const ev of runAgentImpl({ userMessage, history: hist.messages.slice(-HISTORY_TURNS), mode, cwd, approve, browser: agentBrowser, signal: new AbortController().signal, route, maxSteps, ...(bot ? { botPrompt: bot.prompt } : {}) })) {
      const rec = recordEvent(ev);
      if (rec && rec.t === 'tool' && ev.name === 'browser_check' && pendingShot) { rec.screenshot = pendingShot; pendingShot = null; }
      // The final answer arrives as the reply; everything else is part of the chat's steps.
      if (rec && !(rec.t === 'text' && !rec.interim)) events.push(rec);
      if (ev.type === 'text' && !ev.interim) answer = ev.text;
      else if (ev.type === 'tool_end') { steps++; lines.push(describeTool(ev)); }
      else if (ev.type === 'error') failure = ev.error;
      if (rec) await pushProgress(`Working: ${steps} step${steps === 1 ? '' : 's'} so far.`);
      if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted') break;
    }
    if (pending) await pending;
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
      await git(cwd, ['add', '-A', '--', '.', ':(exclude).codeply', `:(exclude)${WORKFLOW_PATH}`, ':(exclude).env']);
      const staged = await git(cwd, ['diff', '--cached', '--name-only']);
      if (staged) {
        changed = staged.split('\n').filter(Boolean);
        // Per-file + and - lines, for the chat's record of what was pushed.
        stats = (await git(cwd, ['diff', '--cached', '--numstat'])).split('\n').filter(Boolean).map((l) => {
          const [add, del, ...name] = l.split('\t');
          return { file: name.join('\t'), added: add === '-' ? null : Number(add), removed: del === '-' ? null : Number(del) };
        });
        branch = cloudBranchName(prompt, taskId);
        const subject = prompt.split('\n')[0].slice(0, 60);
        await git(cwd, [...BOT, 'commit', '-q', '-m', `${subject}\n\nCraft cloud task ${taskId}.`]);
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
    const result = { mode, prompt: prompt.slice(0, 4000), sessionId, answer: answer.slice(0, 20000), branch, sha, files: changed, stats: stats.slice(0, 100), merged, steps, baseSha: taskBase,
      ...(bot || kind === 'task' ? { reply: reply.slice(0, 20000) } : {}) };
    const title = changed.length ? `Changed ${changed.length} file${changed.length === 1 ? '' : 's'}` : mode === 'Build' ? 'No files changed' : 'Answered';
    return finish(true, title, answer || title, result);
  } catch (e) {
    return finish(false, 'Failed', `Something went wrong: ${e.message}`, { error: e.message, mode, steps: lines.length });
  }
}

/** Route and token from the runner environment, with secrets removed from process.env. */
export function runnerSetup(env = process.env) {
  const cfg = { ...env };
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'CODEPLY_API_KEY', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) delete env[k];
  const r = routeFromEnv(cfg);
  return { cfg, token: cfg.GITHUB_TOKEN || cfg.GH_TOKEN, route: r.route, setupError: r.error || null };
}
