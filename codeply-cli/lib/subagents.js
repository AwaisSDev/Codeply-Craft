/**
 * Named specialist subagents.
 *
 * Distinct from the generic `subagent` tool in tools.mjs (which delegates an
 * arbitrary self-contained task to a fresh, anonymous copy of the agent loop).
 * These are fixed personas — Frontend, Backend, Database, DevOps, Security,
 * Testing, Docs, Design — each with its own AGENT.md describing how it
 * should think and work. A session can be pinned to one for its whole
 * lifetime (its persona text gets injected into every turn's system prompt,
 * see buildSystemPrompt() in agent.mjs), and the `subagent` tool itself also
 * checks this registry: if the model names one of these eight in a subagent
 * call's <name>, the nested run inherits that specialist's persona too —
 * so "delegate the security review to the security specialist" actually
 * changes how the delegated run thinks, not just its label.
 *
 * Same convention as skills.js's SKILL.md: YAML frontmatter + a markdown
 * body. Kept as its own tiny module rather than folded into skills.js
 * because a persona replaces/frames the whole system prompt for a run,
 * where a skill is an opt-in reference doc fetched mid-run — different
 * lifecycle, different injection point.
 */
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

/** Same minimal frontmatter reader as skills.js — kept local so this module has no cross-dependency. */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

let cache = null;

/** Every specialist, sorted by their declared `order`. Cached — the set is fixed at build time, not user-editable. */
function listSubagents() {
  if (cache) return cache;
  let files;
  try { files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')); }
  catch { cache = []; return cache; }

  cache = files.map((f) => {
    const text = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
    const { meta, body } = parseFrontmatter(text);
    return {
      id: meta.id || f.replace(/\.md$/, ''),
      name: meta.name || f.replace(/\.md$/, ''),
      tagline: meta.tagline || '',
      color: meta.color || '#888888',
      mascot: meta.mascot || `${meta.id || f.replace(/\.md$/, '')}.png`,
      order: Number(meta.order) || 0,
      persona: body,
    };
  }).sort((a, b) => a.order - b.order);

  return cache;
}

/** Metadata only, no persona body — what the UI's picker needs, nothing it doesn't. */
function listSubagentsMeta() {
  return listSubagents().map(({ persona, ...meta }) => meta);
}

function getSubagent(id) {
  if (!id) return null;
  return listSubagents().find((a) => a.id === id) || null;
}

/**
 * Loose match against a free-text name (what the model writes into a
 * <name> tag, e.g. "frontend", "the Frontend specialist", "Backend Bot") —
 * exact id match first, then a substring check either direction so a
 * reasonably-named delegation call still resolves.
 */
function findSubagentByName(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  const all = listSubagents();
  return all.find((a) => a.id === q) ||
    all.find((a) => a.name.toLowerCase() === q) ||
    all.find((a) => q.includes(a.id) || a.name.toLowerCase().includes(q) || q.includes(a.name.toLowerCase())) ||
    null;
}

// Auto-routing: picks a specialist FOR ONE MESSAGE from its own text, no
// manual pin required — the same specialist can get picked again on a later,
// unrelated message, or a different one each time, since this runs fresh per
// call. Pure keyword classification (no I/O, no model call) so it costs
// nothing and never blocks a send. Ordered most-specific-and-safety-critical
// first: a message that mentions both "security" and "css" should route to
// Warden, not Pixel, so security/data-integrity concerns are checked before
// the broader, easier-to-accidentally-match categories (frontend/design).
// Deliberately conservative — every pattern requires a real technical term,
// not a generic word ("test" alone doesn't match; "unit test"/"write a test"
// does) — a false match hands the whole turn a persona/tone that doesn't fit
// the actual request, which is worse than staying General for an ambiguous one.
// Every bare noun below is written with its plural covered (`issues?`,
// `bugs?`, `endpoints?`, ...) — an earlier version required the exact
// singular form, so "security issues" (plural) silently missed the
// security route entirely and fell through to a much broader, wrong
// category. Getting plurals right matters more here than almost anywhere
// else in this file: a missed match doesn't just fail quietly, it falls
// back to whatever an unrelated EARLIER message in the conversation was
// about (see effectiveSubagentId in main.js), which can point at a
// completely wrong specialist instead of just staying General.
const AUTO_ROUTES = [
  { id: 'security', re: /\b(vulnerabilit(?:y|ies)|xss|csrf|sql\s?injections?|penetration\s?tests?|pentest|exploits?|security\b|auth(?:entication|orization)?\s?(?:bugs?|bypass(?:es)?|checks?|flows?|tokens?)|hash(?:ing)?\s?passwords?|encrypt(?:ion|ed)?|secrets?\s?(?:leak(?:ed)?|expos(?:ed|ure))|credentials?(?:\s?leak(?:ed)?)?|rate\s?limit(?:ing)?|owasp|csp\b|cors\b|jwt\b|sanitiz(?:e|ing|ation)|injection\s?attacks?)\b/i },
  { id: 'database', re: /\b(databases?|db\s?schemas?|schemas?\s?(?:change|design|migration)|migrat(?:ion|ions|e|ing)|sql\s?quer(?:y|ies)|quer(?:y|ies)\s?(?:plan|slow|performance)|add(?:ing)?\s?an?\s?index|indexes?|foreign\s?keys?|primary\s?keys?|postgres(?:ql)?|mysql|sqlite|mongo(?:db)?|n\+1\s?quer|tables?\s?(?:column|row|schema)|orm\b|prisma\b|supabase\s?tables?)\b/i },
  { id: 'devops', re: /\b(ci\/cd|ci\s?pipelines?|github\s?actions|deploy(?:ment|ments|ing|ed)?|rollbacks?|dockerfiles?|docker\s?compose|kubernetes|k8s|zero[- ]downtime|infra(?:structure)?(?:\s?as\s?code)?|env(?:ironment)?\s?variables?|secrets?\s?manager|build\s?pipelines?|hosting|vercel|netlify|render\.com|health\s?checks?|uptime|logging\s?(?:setup|infra)|monitoring|observability)\b/i },
  { id: 'testing', re: /\b(unit\s?tests?|write\s?(?:a\s?|some\s?)?tests?|regression\s?tests?|e2e\s?tests?|end[- ]to[- ]end\s?tests?|test\s?coverage|flaky\s?tests?|reproduce\s?(?:this|the)\s?bugs?|test\s?suites?|qa\s?pass|edge\s?cases?|testing\s?strategy|test\s?(?:the|this|my|it|out)\b|does\s?(?:it|this)\s?works?|check\s?if\s?(?:it|this)\s?works?)\b/i },
  { id: 'backend', re: /\b(api\s?(?:endpoints?|routes?|integrations?)|rest\s?api|backend\s?(?:logic|routes?|bugs?|code)|business\s?logic|server[- ]side|race\s?conditions?|idempotent|webhooks?|graphql|endpoints?\s?(?:for|to)|route\s?handlers?|server\s?errors?)\b/i },
  { id: 'frontend', re: /\b(css\b|styles?\s?(?:sheet)?|responsive(?:\s?layout)?|react\s?components?|vue\s?components?|components?\b|flexbox|grid\s?layout|accessib(?:le|ility)|aria[- ]|keyboard\s?nav|hover\s?states?|animations?|transitions?|dark\s?mode\b|light\s?mode\b|frontend\b|ui\s?(?:bugs?|fix|elements?|components?)?|buttons?\b|layouts?\b|typography|fonts?(?:-family)?|padding|margins?|spacing|glassmorphism|sections?\b|footers?\b|headers?\b|navbar|sidebars?|modals?\b|breakpoints?|visual\s?hierarchy|design\s?systems?|information\s?architecture|user\s?flows?|wireframes?|mockups?|color\s?palettes?|type\s?scale|ux\s?review|luxury|aesthetics?|polish(?:ed)?|brand(?:ing)?|design\s?(?:direction|refinement|feedback|advice)|make\s?it\s?(?:look|feel)|world[- ]class|premium\s?feel|(?:landing|collection|product|pricing|contact|about|home)\s?pages?|new\s?pages?|web\s?pages?|html\s?pages?|(?:the\s+)?website\b|images?\b|photos?\b|pictures?\b)\b/i },
  { id: 'docs', re: /\b(write\s?(?:a\s?)?readme|api\s?docs?|documentation|doc[- ]?comments?|changelog|release\s?notes|write\s?a\s?(?:guide|tutorial)|code\s?comments?)\b/i },
];

// Alternate ways someone actually types a niche's name in a sentence — not
// just the single-word form AUTO_ROUTES already matches as a topic keyword,
// but explicitly asking FOR that specialist ("use front end agent", "have
// the security specialist look at this"). "front end agent" (two words,
// space) was silently missing before this existed — AUTO_ROUTES only had
// the one-word "frontend" as a keyword, so a request naming the specialist
// by its actual two-word name never matched anything.
const NICHE_ALIASES = {
  frontend: ['frontend', 'front[- ]end'],
  backend: ['backend', 'back[- ]end'],
  database: ['database', 'db'],
  devops: ['dev\\s?ops'],
  security: ['security'],
  testing: ['testing', 'qa'],
  docs: ['docs', 'documentation'],
};

/**
 * Catches a request that names a specialist directly — by its mascot name
 * ("have Pixel look at this") or by its niche plus an agent/specialist/bot
 * word ("use the front end agent", "security specialist please review").
 * Checked before the topic-keyword routes below so an explicit ask always
 * wins over guessing from subject matter.
 */
function detectExplicitMention(message) {
  const text = String(message || '');
  for (const a of listSubagents()) {
    if (new RegExp(`\\b${a.name}\\b`, 'i').test(text)) return a.id;
    for (const alias of NICHE_ALIASES[a.id] || []) {
      if (new RegExp(`\\b${alias}\\s+(?:agent|specialist|bot)\\b`, 'i').test(text)) return a.id;
    }
  }
  return null;
}

function detectSpecialist(message) {
  const text = String(message || '');
  const explicit = detectExplicitMention(text);
  if (explicit) return explicit;
  for (const route of AUTO_ROUTES) {
    if (route.re.test(text)) return route.id;
  }
  return null;
}

module.exports = { listSubagents, listSubagentsMeta, getSubagent, findSubagentByName, detectSpecialist };
