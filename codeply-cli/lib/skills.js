/**
 * Codeply skills.
 *
 * A skill is a directory with a SKILL.md: YAML frontmatter (`name`,
 * `description`) followed by a markdown body of instructions. This is the same
 * convention Claude Code and affaan-m/ECC use - see skills/SOURCE.md for where
 * the bundled set came from and why the format was copied rather than invented.
 *
 * Two-level progressive disclosure - this matters at 281 skills:
 *
 *   1. Per-skill: buildSystemPrompt() only ever injects a skill's NAME and a
 *      capped one-line description. The full body - which can run to several
 *      KB with reference files - loads on demand via <codeply:use_skill>. The
 *      alternative, concatenating every skill's full body into the system
 *      prompt always, would resend ~3.4MB per request for the bundled set
 *      alone.
 *
 *   2. Across the library: even name+description for all 281 is ~44KB
 *      (~11,000 tokens) - resent on every step of every turn, that alone would
 *      make the skill library cost more than it saves. So the system prompt by
 *      default only lists a curated subset (DAILY_SKILLS below, ~2KB) covering
 *      general coding work; the complete 281 are still fully installed and
 *      usable, just one cheap `list_skills` action away instead of force-fed
 *      into every request. DAILY_SKILLS is not a cut Codeply invented - it's
 *      ECC's own `.agents/skills/` curation of its 281-skill `skills/`
 *      library (see skills/SOURCE.md), reused rather than re-decided.
 *
 * Three sources, later wins on a name collision:
 *   plugin     <plugin>/skills/<name>/SKILL.md    - `codeply plugin install`
 *   built-in   <repo>/skills/<name>/SKILL.md      - vendored, ships with Codeply
 *   user       ~/.codeply/skills/<name>/SKILL.md  - `codeply skill install`
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const plugins = require('./plugins.js');

const BUILTIN_DIR = path.join(__dirname, '..', 'skills');
const USER_DIR = path.join(os.homedir(), '.codeply', 'skills');

const MAX_BODY_CHARS = 8000; // fed to the model on demand; keep one skill from eating the whole budget

// ECC's own curated subset of its full library - see skills/SOURCE.md. Kept as
// a name list rather than a directory so a user-installed skill with one of
// these names (or a future re-vendor that drops/renames one) degrades
// gracefully instead of erroring.
const DAILY_SKILLS = new Set([
  'agent-introspection-debugging', 'agent-sort', 'api-design', 'article-writing',
  'backend-patterns', 'benchmark-methodology', 'brand-discovery', 'brand-voice',
  'bun-runtime', 'coding-standards', 'competitive-platform-analysis',
  'competitive-report-structure', 'content-engine', 'crosspost', 'deep-research',
  'dmux-workflows', 'documentation-lookup', 'e2e-testing', 'eval-harness',
  'exa-search', 'fal-ai-media', 'frontend-patterns', 'frontend-slides',
  'investor-materials', 'investor-outreach', 'market-research', 'mcp-server-patterns',
  'mle-workflow', 'nextjs-turbopack', 'plan-canvas', 'product-capability',
  'security-review', 'strategic-compact', 'tdd-workflow', 'unified-memory',
  'verification-loop', 'video-editing', 'x-api',
  // Codeply's own visual-quality bar - see the note above use_skill in
  // lib/agent.mjs's TOOL_REFERENCE for why these are non-speculative triggers.
  'premium-web-design', 'frontend-design-direction', 'motion-ui', 'frontend-a11y',
  // The end-to-end publish flow (lib/publish.js).
  'publish-website',
]);

function listSkillDirs(root, source) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }

  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, dir: path.join(root, e.name), source }))
    .filter((s) => fs.existsSync(path.join(s.dir, 'SKILL.md')));
}

/**
 * Minimal YAML frontmatter reader for exactly the two keys skills use.
 * Handles plain `key: value` and folded/literal block scalars (`key: >-` /
 * `key: |-` etc.) since real skills in the wild use both - a naive
 * single-line regex silently truncates ~10% of the bundled set's descriptions.
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { name: null, description: null, body: text };

  const fmLines = m[1].split(/\r?\n/);
  const values = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rest] = kv;

    const block = rest.match(/^([|>])(-|\+)?\s*$/);
    if (block) {
      const folded = block[1] === '>';
      const collected = [];
      let j = i + 1;
      let indent = null;
      while (j < fmLines.length) {
        const l = fmLines[j];
        if (l.trim() === '') { collected.push(''); j++; continue; }
        const lineIndent = l.match(/^\s*/)[0].length;
        if (indent === null) indent = lineIndent;
        if (lineIndent < indent) break;
        collected.push(l.slice(indent));
        j++;
      }
      i = j - 1;
      values[key] = folded
        ? collected.join(' ').replace(/\s+/g, ' ').trim()
        : collected.join('\n').replace(/\n+$/, '');
      continue;
    }

    // Strip a matching pair of quotes, nothing fancier - these are simple labels.
    values[key] = rest.replace(/^["'](.*)["']$/, '$1').trim();
  }

  return {
    name: values.name || null,
    description: values.description || null,
    body: text.slice(m[0].length),
  };
}

/** Every skill available right now, built-in and user, deduped by name. */
function listSkills(cwd) {
  const found = new Map();
  for (const s of listSkillDirs(BUILTIN_DIR, 'built-in')) found.set(s.name, s);
  // Plugin skills were installed on purpose, so they are shown like the daily set.
  for (const { plugin, dir } of plugins.skillDirs(cwd)) {
    for (const s of listSkillDirs(dir, 'plugin')) found.set(s.name, { ...s, plugin });
  }
  // User skills are installed deliberately, so a same-named one wins.
  for (const s of listSkillDirs(USER_DIR, 'user')) found.set(s.name, s);

  const skills = [];
  for (const s of found.values()) {
    let raw;
    try { raw = fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'); }
    catch { continue; }
    const { name, description } = parseFrontmatter(raw);
    const finalName = name || s.name;
    skills.push({
      name: finalName,
      description: description || '(no description)',
      source: s.source,
      dir: s.dir,
      // A user-installed skill overriding a daily one keeps its daily status -
      // the name is still what buildSystemPrompt filters on, not the source.
      daily: DAILY_SKILLS.has(finalName) || s.source === 'plugin',
      plugin: s.plugin || null,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

const INDEX_DESC_MAX = 140; // per-skill cap in the always-injected index; use_skill has the rest

/**
 * Compact index of skill name + a capped description, one per line.
 *
 * `daily` (default) is what goes in the system prompt on every request - see
 * the module doc for why the full 281 is too large to inject unconditionally.
 * `all` is for the list_skills action and `/skill list`, where the cost is
 * paid once, on demand, instead of on every step.
 */
function formatSkillIndex(skills = listSkills(), { all = false } = {}) {
  const shown = all ? skills : skills.filter((s) => s.daily);
  if (shown.length === 0) return null;
  return shown
    .map((s) => {
      const d = s.description.length > INDEX_DESC_MAX
        ? s.description.slice(0, INDEX_DESC_MAX - 1).trim() + '…'
        : s.description;
      return `- ${s.name}: ${d}`;
    })
    .join('\n');
}

/** The full body of one skill, truncated to a sane size, or null if unknown. */
function loadSkillBody(name, cwd) {
  const skill = listSkills(cwd).find((s) => s.name === name);
  if (!skill) return null;

  let raw;
  try { raw = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8'); }
  catch { return null; }
  const { body } = parseFrontmatter(raw);
  const trimmed = body.trim();

  if (trimmed.length <= MAX_BODY_CHARS) return trimmed;
  return trimmed.slice(0, MAX_BODY_CHARS) +
    `\n\n[… truncated. The rest is at ${path.join(skill.dir, 'SKILL.md')} if you need it via read_file.]`;
}

/**
 * Copy a local directory containing a SKILL.md into the user skill store.
 * Named separately from the GitHub path below because it never touches the
 * network - used by both `codeply skill install <local-dir>` and as the last
 * step after a GitHub download lands in a temp directory.
 */
function installFromLocalDir(sourceDir, name) {
  const skillMd = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    return { ok: false, error: `No SKILL.md found in ${sourceDir}` };
  }
  const raw = fs.readFileSync(skillMd, 'utf8');
  const { name: fmName } = parseFrontmatter(raw);
  const finalName = name || fmName || path.basename(sourceDir);

  const dest = path.join(USER_DIR, finalName);
  fs.mkdirSync(dest, { recursive: true });
  copyRecursive(sourceDir, dest);
  return { ok: true, name: finalName, dest };
}

function copyRecursive(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

// ─── Installing from GitHub ─────────────────────────────────────────────────

/**
 * Parse anything a user might paste for a GitHub skill source:
 *   owner/repo
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<branch>/<subpath...>
 *   https://github.com/owner/repo/blob/<branch>/<subpath...>/SKILL.md
 */
function parseGitHubSource(source) {
  const s = source.trim().replace(/\/+$/, '');

  let m = s.match(/^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/i);
  if (m) {
    const [, owner, repo, , branch, subpath] = m;
    return { owner, repo: repo.replace(/\.git$/, ''), branch: branch || null, subpath: subpath || '' };
  }

  m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) return { owner: m[1], repo: m[2], branch: null, subpath: '' };

  return null;
}

async function githubJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `GitHub API returned HTTP ${res.status}`);
  return body;
}

/**
 * Install one or more skills from a GitHub repo.
 *
 * If `subpath` points directly at a skill (a directory whose own SKILL.md
 * lives there), that one skill is installed under `name` (or its own frontmatter
 * name). Otherwise every SKILL.md found anywhere under `subpath` (the whole
 * repo, if none was given) is installed - this is what makes a bare repo URL
 * like affaan-m/ECC pull in its entire skill library in one command, and also
 * what lets a single-skill link install just that one.
 */
async function installFromGitHub(source, explicitName) {
  const parsed = parseGitHubSource(source);
  if (!parsed) return { ok: false, error: `Not a recognizable GitHub source: "${source}"` };
  const { owner, repo, subpath } = parsed;

  let branch = parsed.branch;
  if (!branch) {
    try {
      const repoInfo = await githubJson(`https://api.github.com/repos/${owner}/${repo}`);
      branch = repoInfo.default_branch || 'main';
    } catch (e) {
      return { ok: false, error: `Could not reach ${owner}/${repo}: ${e.message}` };
    }
  }

  let tree;
  try {
    const treeData = await githubJson(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    if (treeData.truncated) {
      // GitHub's own recursion cap (huge monorepos) - rare, but better to say
      // so than to silently install an incomplete skill.
      return { ok: false, error: `${owner}/${repo}@${branch} is too large to list in one call. Point --install at a narrower subpath.` };
    }
    tree = treeData.tree || [];
  } catch (e) {
    return { ok: false, error: `Could not read ${owner}/${repo}@${branch}: ${e.message}` };
  }

  const cleanSubpath = subpath.replace(/\/SKILL\.md$/i, '').replace(/\/+$/, '');
  const scoped = cleanSubpath
    ? tree.filter((t) => t.path === cleanSubpath || t.path.startsWith(cleanSubpath + '/'))
    : tree;

  const skillMdFiles = scoped.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path));
  if (skillMdFiles.length === 0) {
    return { ok: false, error: `No SKILL.md found under ${owner}/${repo}${cleanSubpath ? '/' + cleanSubpath : ''}.` };
  }

  const skillDirs = skillMdFiles.map((f) => f.path.replace(/\/SKILL\.md$/i, ''));
  const singleSkill = skillDirs.length === 1;

  const installed = [];
  const failed = [];

  for (const dir of skillDirs) {
    const filesInDir = tree.filter((t) =>
      t.type === 'blob' && (t.path === `${dir}/SKILL.md` || t.path.startsWith(`${dir}/references/`))
    );
    const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;

    const fetched = [];
    let ok = true;
    for (const f of filesInDir) {
      try {
        const res = await fetch(`${rawBase}/${f.path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fetched.push({ relPath: f.path.slice(dir.length + 1), content: await res.text() });
      } catch (e) {
        ok = false;
        failed.push({ dir, error: e.message });
        break;
      }
    }
    if (!ok) continue;

    const skillMd = fetched.find((f) => f.relPath === 'SKILL.md');
    const { name: fmName } = parseFrontmatter(skillMd.content);
    const finalName = (singleSkill && explicitName) || fmName || path.basename(dir);

    const dest = path.join(USER_DIR, finalName);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fetched) {
      const target = path.join(dest, f.relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content, 'utf8');
    }
    installed.push({ name: finalName, fileCount: fetched.length, dest });
  }

  return { ok: installed.length > 0, installed, failed, source: `${owner}/${repo}@${branch}` };
}

// Words too common in both task descriptions and skill blurbs to carry any
// matching signal ("a page for the app" would otherwise match nearly everything).
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'to', 'of', 'in', 'on',
  'at', 'is', 'are', 'be', 'this', 'that', 'it', 'as', 'from', 'into', 'about',
  'i', 'you', 'we', 'my', 'me', 'do', 'does', 'make', 'makes', 'get', 'gets',
  'up', 'out', 'not', 'need', 'want', 'please', 'can', 'app', 'page', 'file',
  'code', 'using', 'use', 'so', 'now',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Cheap keyword-overlap search over the full skill library, run fresh per
 * turn against the user's actual request - no extra model call. This is what
 * lets a niche skill (say, cisco-ios-patterns or blender-motion-state-inspection)
 * get surfaced automatically instead of depending on the model guessing the
 * right list_skills query, or on it being one of the ~37 always-shown daily
 * skills. Scored on token overlap between the query and each skill's
 * `name + description`, with name hits weighted higher than description hits
 * since a skill named for exactly the thing being asked is strong signal.
 */
function findRelevantSkills(query, skillList = listSkills(), { limit = 6, excludeDaily = false } = {}) {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];

  const scored = [];
  for (const s of skillList) {
    if (excludeDaily && s.daily) continue;
    const nameTokens = tokenize(s.name.replace(/-/g, ' '));
    const descTokens = tokenize(s.description);
    let score = 0;
    for (const t of qTokens) {
      if (nameTokens.includes(t)) score += 3;
      else if (descTokens.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ skill: s, score });
  }

  scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return scored.slice(0, limit).map((x) => x.skill);
}

function removeSkill(name) {
  const dest = path.join(USER_DIR, name);
  if (!fs.existsSync(dest)) {
    return { ok: false, error: `No user-installed skill named "${name}" (built-in skills can't be removed this way).` };
  }
  fs.rmSync(dest, { recursive: true, force: true });
  return { ok: true };
}

module.exports = {
  BUILTIN_DIR, USER_DIR, MAX_BODY_CHARS, DAILY_SKILLS,
  parseFrontmatter, listSkills, formatSkillIndex, loadSkillBody, findRelevantSkills,
  installFromLocalDir, installFromGitHub, parseGitHubSource, removeSkill,
};
