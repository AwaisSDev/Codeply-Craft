/**
 * Codeply agent loop.
 *
 * The ai-proxy exposes a plain chat completion — no native function calling —
 * so tool use rides on a tag protocol the model writes into its reply and we
 * parse back out. Tags are used rather than JSON because file content goes in
 * verbatim: no escaping pass to get wrong, and models corrupt long JSON strings
 * far more often than they corrupt a closing tag.
 *
 * runAgent() is an async generator so the TUI can render each step as it lands
 * instead of freezing until the whole task finishes.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { executeTool, TOOL_NEEDS_APPROVAL, walkFiles, resolvePath } from './tools.mjs';

const require = createRequire(import.meta.url);
const ai = require('./ai.js');
const skills = require('./skills.js');
const subagentsLib = require('./subagents.js');

const MAX_STEPS = 24;
const MAX_MALFORMED_RETRIES = 3;
// Deliberately conservative. The proxy is a Supabase Edge Function with its own
// memory/CPU ceiling — it returns 546 when it blows through it — so keeping each
// request small matters more here than squeezing in extra history.
const CONTEXT_CHAR_BUDGET = 48000;

const FORMAT_CORRECTION =
  '[system] Your action block was not in the required form. Do not invent wrappers like <toolcall> or ' +
  '<|tool_call>, do not drop the "codeply:" prefix, and keep the underscore in the name. There is no native ' +
  'function-calling channel here — even if you have one, it is not connected, so anything you write there is ' +
  'silently discarded and never runs. Write it exactly like this, as literal text in your reply, opening and ' +
  'closing tags complete:\n\n' +
  '<codeply:read_file>\n<path>run.html</path>\n</codeply:read_file>\n\n' +
  'Valid names: list_dir, read_file, write_file, edit_file, search, run, use_skill, list_skills, fetch_image, ' +
  'browser_check, gmail_send, gmail_search, slack_post_message, vercel_deploy, supabase_create_project, ' +
  'supabase_delete_project, github_create_repo, design_reference_search, view_images, subagent, dispatch_agent, stop_agent.';

const TRUNCATION_CORRECTION =
  '[system] That reply got cut off partway through the action block — the tag syntax was fine, it simply ran out of ' +
  'room before the block closed. This happens when write_file or edit_file tries to carry too much content in one reply. ' +
  "Don't re-explain or apologize for the format, just write less this time: for a new or rewritten file, write_file only " +
  'the first section now and use edit_file to add the rest over one or two more steps; for an edit, split it into smaller ' +
  'search/replace pairs. Try again with a smaller block.';

const MAX_TRUNCATED_RETRIES = 3;

// A reply that CLAIMS a file was written/edited/fixed, in the past tense,
// while itself containing no action block at all — and with no real
// write_file/edit_file success anywhere earlier in this same turn — is not
// "finished", it's a confabulated result. This is a real, observed failure
// mode on weaker models: they narrate "I have now applied the change" as
// filler text instead of actually emitting the tag, and the user is left
// with a chat that describes progress that never happened on disk. Matches
// only completion language (past tense / "successfully" / "has been"), not
// forward-looking intent ("I will now update...") — a plan is not a lie.
// The adverb list between "have" and the verb is deliberately a closed set
// (now/already/actually/just/finally), not "any word" — "I have TO update"
// is a statement of necessity, not a completion claim, and must not match.
const HC_VERB = '(?:applied|updated|written|wrote|edited|fixed|changed|added|created|modified)';
const HC_ADVERB = '(?:now|already|actually|just|finally)';
const HALLUCINATED_COMPLETION = new RegExp(
  `\\bi(?:'ve|\\s+have)\\s+(?:${HC_ADVERB}\\s+){0,2}${HC_VERB}\\b` +      // "I have now already applied..."
  `|\\bsuccessfully\\s+${HC_VERB}\\b` +                                  // "successfully applied..."
  `|\\b${HC_VERB}\\b[^.!?\\n]{0,20}\\bsuccessfully\\b` +                 // "...applied this successfully"
  `|\\b(?:has|have)\\s+been\\s+${HC_VERB}\\b`,                           // "...has been applied"
  'i',
);

const HALLUCINATED_ACTION_CORRECTION =
  "[system] Your last reply describes a file as already changed, but it contained no action block, and nothing has actually " +
  "been written or edited yet this turn. Do not narrate work as done that you have not done — that leaves the user's " +
  "request unfulfilled while the chat claims otherwise. Write the real <codeply:edit_file> or <codeply:write_file> action " +
  "block now (search text copied verbatim from a file you have actually read), or if you genuinely cannot proceed, say so " +
  "plainly instead of claiming success.";

// Filename-shaped tokens mentioned in the completion sentence(s), used to catch
// the narrower case: a turn where a REAL edit did happen, so the check above
// (gated on !madeAnyEdit) never fires, but the reply's completion claim lists
// more files than were actually touched this turn — "I've created index.html,
// styles.css, and app.js" after only index.html was actually write_file'd.
const FILENAME_TOKEN = /\b[\w-]+\.(?:html|htm|css|js|jsx|ts|tsx|mjs|cjs|py|json|md|yml|yaml|txt|svg|vue|svelte)\b/gi;

function extractClaimedFilenames(prose) {
  const m = prose.match(FILENAME_TOKEN);
  return m ? [...new Set(m.map((f) => f.toLowerCase()))] : [];
}

const overclaimCorrection = (missing) =>
  `[system] Your last reply claims ${missing.length === 1 ? 'this file was' : 'these files were'} changed, but ` +
  `${missing.length === 1 ? 'it was' : 'they were'} never actually written or edited this turn: ${missing.join(', ')}. ` +
  "Only claim what you actually did. Either write the real <codeply:write_file> or <codeply:edit_file> action block for " +
  `${missing.length === 1 ? 'it' : 'each of them'} now, or correct your summary to describe only the file(s) you truly changed.`;

// Same failure mode as HALLUCINATED_COMPLETION above, but for the coordinator
// specifically: a reply that says it handed a task off, with no action block
// at all, means dispatch_agent never actually ran — the user is told a
// specialist is on it while nothing is really happening. Kept to a narrow,
// distinctly dispatch-shaped verb set (not "sent"/"assigned" — too generic,
// e.g. "I've sent the email" from an unrelated gmail_send narration) to
// avoid flagging ordinary prose that just happens to use a similar word.
const HD_VERB = "(?:dispatched|delegated|handed\\s+(?:this\\s+)?off)";
const HALLUCINATED_DISPATCH = new RegExp(
  `\\bi(?:'ve|\\s+have)\\s+(?:${HC_ADVERB}\\s+){0,2}${HD_VERB}\\b` +
  `|\\b(?:has|have)\\s+been\\s+${HD_VERB}\\b`,
  'i',
);
const HALLUCINATED_DISPATCH_CORRECTION =
  "[system] Your last reply says you dispatched or handed this off to a specialist, but it contained no action block — " +
  "dispatch_agent was never actually called this turn, so nothing is really running. Do not narrate a dispatch as done " +
  "that you have not done. Either write the real <codeply:dispatch_agent> action block now, or say plainly that you " +
  "haven't dispatched it yet.";

const MAX_HALLUCINATION_RETRIES = 3;

// ─── Protocol ───────────────────────────────────────────────────────────────

const TOOL_TAG = /<codeply:([a-z_]+)>([\s\S]*?)<\/codeply:\1>/g;

// Params whose value is a raw payload (file content, code blocks) and may
// legitimately contain angle-bracket tags of its own.
const CONTAINER_PARAMS = new Set(['content', 'search', 'replace', 'body', 'text']);

/** Tag payloads are written on their own lines; drop only that framing. */
function trimFraming(value) {
  return value.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

/**
 * Pull the parameters out of a tool block.
 *
 * Container params are read first-open to last-close, so writing an HTML file
 * that itself contains `</content>` does not truncate the payload. Their spans
 * are then masked out before the scalar params are matched — otherwise a
 * `<path>` appearing inside that same HTML payload would be picked up as the
 * tool's path. (That is not hypothetical; it is what the test caught.)
 */
function extractParams(block, spec) {
  const args = {};
  const masked = [...block];

  for (const name of spec) {
    if (!CONTAINER_PARAMS.has(name)) continue;
    const open = `<${name}>`;
    const close = `</${name}>`;
    const start = block.indexOf(open);
    if (start === -1) continue;
    const end = block.lastIndexOf(close);
    if (end === -1 || end < start + open.length) continue;
    args[name] = trimFraming(block.slice(start + open.length, end));
    for (let i = start; i < end + close.length; i++) masked[i] = ' ';
  }

  const scalarRegion = masked.join('');
  for (const name of spec) {
    if (CONTAINER_PARAMS.has(name)) continue;
    const m = scalarRegion.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    if (m) args[name] = trimFraming(m[1]);
  }

  return args;
}

const PARAMS = {
  list_dir: ['path'],
  read_file: ['path', 'offset', 'limit'],
  write_file: ['path', 'content'],
  edit_file: ['path', 'search', 'replace'],
  search: ['pattern', 'glob', 'path'],
  run: ['command'],
  use_skill: ['name'],
  list_skills: ['query'],
  fetch_image: ['url', 'path'],
  browser_check: ['url', 'wait'],
  gmail_send: ['to', 'subject', 'body'],
  gmail_search: ['query'],
  slack_post_message: ['channel', 'text'],
  vercel_deploy: ['path'],
  supabase_create_project: ['name'],
  supabase_delete_project: ['name', 'ref'],
  github_create_repo: ['path', 'name'],
  design_reference_search: ['term', 'category'],
  view_images: ['urls'],
  subagent: ['name', 'task'],
  dispatch_agent: ['name', 'task'],
  stop_agent: ['name', 'index'],
};

// Names the model actually reaches for when it paraphrases the format.
// Deliberately excludes `search`, `replace`, `content`, `path` and `command`:
// those are parameter names, and treating them as action names would misread
// an edit_file block as a search.
const NAME_ALIASES = {
  read_file: 'read_file', readfile: 'read_file', read: 'read_file',
  open: 'read_file', cat: 'read_file', view: 'read_file', openfile: 'read_file',
  list_dir: 'list_dir', listdir: 'list_dir', list: 'list_dir',
  ls: 'list_dir', dir: 'list_dir', listfiles: 'list_dir',
  write_file: 'write_file', writefile: 'write_file', write: 'write_file',
  create: 'write_file', createfile: 'write_file',
  edit_file: 'edit_file', editfile: 'edit_file', edit: 'edit_file',
  grep: 'search', findtext: 'search',
  run: 'run', bash: 'run', shell: 'run', exec: 'run', runcommand: 'run',
  use_skill: 'use_skill', useskill: 'use_skill', skill: 'use_skill', loadskill: 'use_skill',
  list_skills: 'list_skills', listskills: 'list_skills', skills: 'list_skills', findskill: 'list_skills',
  fetch_image: 'fetch_image', fetchimage: 'fetch_image', downloadimage: 'fetch_image',
  download_image: 'fetch_image', getimage: 'fetch_image',
  browser_check: 'browser_check', browsercheck: 'browser_check', checkbrowser: 'browser_check',
  previewcheck: 'browser_check', browserpreview: 'browser_check', check: 'browser_check',
  gmail_send: 'gmail_send', gmailsend: 'gmail_send', sendemail: 'gmail_send', email: 'gmail_send', sendmail: 'gmail_send',
  gmail_search: 'gmail_search', gmailsearch: 'gmail_search', searchemail: 'gmail_search', searchgmail: 'gmail_search',
  slack_post_message: 'slack_post_message', slackpostmessage: 'slack_post_message',
  slackmessage: 'slack_post_message', slackpost: 'slack_post_message', postmessage: 'slack_post_message',
  vercel_deploy: 'vercel_deploy', vercel: 'vercel_deploy', deploy: 'vercel_deploy', publish: 'vercel_deploy', vercelpublish: 'vercel_deploy',
  supabase_create_project: 'supabase_create_project', supabase: 'supabase_create_project', createproject: 'supabase_create_project',
  createdatabase: 'supabase_create_project', makedatabase: 'supabase_create_project', create_database: 'supabase_create_project',
  supabase_delete_project: 'supabase_delete_project', deletesupabaseproject: 'supabase_delete_project',
  deletedatabase: 'supabase_delete_project', removedatabase: 'supabase_delete_project', delete_database: 'supabase_delete_project',
  github_create_repo: 'github_create_repo', github: 'github_create_repo', creategithubrepo: 'github_create_repo',
  createrepo: 'github_create_repo', pushtogithub: 'github_create_repo',
  design_reference_search: 'design_reference_search', designreferencesearch: 'design_reference_search',
  designreference: 'design_reference_search', referencesearch: 'design_reference_search',
  designlibrary: 'design_reference_search', searchdesignlibrary: 'design_reference_search',
  view_images: 'view_images', viewimages: 'view_images', viewimage: 'view_images',
  lookatimages: 'view_images', lookatimage: 'view_images', seeimages: 'view_images',
  subagent: 'subagent', subtask: 'subagent', spawnagent: 'subagent',
  spawn_agent: 'subagent', taskagent: 'subagent',
  dispatch_agent: 'dispatch_agent', dispatchagent: 'dispatch_agent', delegate: 'dispatch_agent',
  stop_agent: 'stop_agent', stopagent: 'stop_agent', killagent: 'stop_agent', kill: 'stop_agent',
};

// Any tag whose name resolves to an action, with or without the codeply: prefix.
const LOOSE_NAME_TAG = new RegExp(
  `</?\\s*(?:codeply[:_-])?(${Object.keys(NAME_ALIASES).join('|')})\\s*/?>`, 'i'
);

// Does this reply look like it was *trying* to act, even though nothing parsed?
// The `<\|?` (not just `<\/?`) matters: some models — Gemma via OpenRouter in
// particular — reach for their own native tool-call channel and it leaks out
// as literal Harmony-style text, "<|tool_call>call:codeply:edit_file", instead
// of the "<codeply:edit_file>" tag this protocol needs. Without the `\|`
// alternative that text doesn't match, so it falls through as a "reply is
// finished" and gets shown to the user verbatim as raw protocol debris (or
// worse, ends up as literal content inside a write_file/edit_file the model
// attempts right after). Catching it here routes it into the normal malformed
// retry instead, which corrects the model back onto the real tag format.
const LOOKS_LIKE_ATTEMPT =
  /<\|?\/?\s*(?:codeply[:_-])?(?:tool_?call|action|function_?call|invoke)\b|<(?:path|command|pattern|content|name|term)>/i;

/**
 * A reply that opens an action block but never closes it almost always means
 * the model hit its response length limit mid-write (a full-file write_file
 * on anything but a small file is the usual trigger) rather than that it
 * wrote a malformed tag. That distinction matters: the generic format
 * correction tells the model its *syntax* was wrong, which it wasn't, and
 * the model then apologizes for a mistake it didn't make and repeats the
 * same oversized write. Detecting this case lets the correction instead say
 * "you ran out of room, write less at once" — the thing that actually fixes it.
 */
function looksTruncated(text) {
  return /<codeply:([a-z_]+)>(?![\s\S]*<\/codeply:\1>)/i.test(text);
}

/**
 * Best-effort recovery when the strict protocol did not match.
 *
 * gpt-oss-120b paraphrases the format — inventing a <toolcall> wrapper,
 * dropping the codeply: prefix, writing "readfile" for "read_file", even
 * dropping a bracket. Rejecting those wastes the user's turn, so the intent is
 * reconstructed from whatever survived. Checks run most-specific first: the
 * parameter tags are stronger evidence than the action name, because the name
 * is what gets mangled.
 */
function recoverCall(text) {
  const has = (tag) => new RegExp(`<${tag}>`, 'i').test(text);

  let name = null;
  if (has('content')) name = 'write_file';
  else if (has('search') && has('replace')) name = 'edit_file';
  else if (has('to') && has('subject')) name = 'gmail_send';
  else if (has('channel') && has('text')) name = 'slack_post_message';
  else {
    const m = text.match(LOOSE_NAME_TAG);
    if (m) name = NAME_ALIASES[m[1].toLowerCase().replace(/[_-]/g, '')] ?? NAME_ALIASES[m[1].toLowerCase()];
    if (!name && has('command')) name = 'run';
    else if (!name && has('pattern')) name = 'search';
    // fetch_image and browser_check both take <url> now — <wait> only appears on browser_check.
    else if (!name && has('url') && has('wait')) name = 'browser_check';
    else if (!name && has('urls')) name = 'view_images'; // <urls> (plural) only appears on view_images
    else if (!name && has('url')) name = 'fetch_image';
    else if (!name && has('path')) name = 'read_file';
    else if (!name && has('task')) name = 'subagent'; // only subagent's params include <task>
    else if (!name && has('name')) name = 'use_skill'; // only use_skill's params include <name>
    else if (!name && has('query')) name = 'list_skills'; // only list_skills' params include <query>
    else if (!name && has('term')) name = 'design_reference_search';
  }
  if (!name || !PARAMS[name]) return null;

  const args = extractParams(text, PARAMS[name]);
  if (Object.keys(args).length === 0) return null;
  return { name, args, recovered: true };
}

/**
 * poolside/laguna's own native tool-calling convention leaks through as
 * literal text here — same root cause as the Harmony `<|tool_call>` leak
 * above (a different model reaching for its own trained tool-call format
 * because the proxy declares no tools), just a different shape:
 *   <tool_call>read_file<arg_key>path</arg_key><arg_value>drop.html</arg_value></tool_call>
 * The previous approach — reject it and ask for the real tags via
 * FORMAT_CORRECTION — turned out not to work on this model: it kept writing
 * this exact shape through all 3 retries and the whole turn errored out with
 * nothing done. Since the shape is completely consistent, parsing it
 * directly as a first-class input is far more reliable than hoping a
 * deeply-trained habit reforms on request.
 */
const POOLSIDE_CALL_RE = /<tool_call>\s*([a-zA-Z_]+)\s*([\s\S]*?)<\/tool_call>/gi;
const POOLSIDE_ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;

function parsePoolsideCalls(text) {
  const calls = [];
  let prose = '';
  let lastIndex = 0;
  POOLSIDE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = POOLSIDE_CALL_RE.exec(text)) !== null) {
    prose += text.slice(lastIndex, m.index);
    lastIndex = m.index + m[0].length;
    const rawName = m[1].toLowerCase();
    const name = NAME_ALIASES[rawName] ?? (PARAMS[rawName] ? rawName : null);
    if (!name) continue; // an unrecognized name in this shape isn't worth guessing at
    const args = {};
    POOLSIDE_ARG_RE.lastIndex = 0;
    let am;
    while ((am = POOLSIDE_ARG_RE.exec(m[2])) !== null) {
      args[am[1].trim()] = am[2].trim();
    }
    calls.push({ name, args });
  }
  prose += text.slice(lastIndex);
  return { prose, calls };
}

/**
 * Split a model reply into prose and the actions embedded in it.
 * @returns {{prose:string, calls:Array, recovered:boolean, malformed:boolean}}
 */
export function parseReply(text) {
  const calls = [];
  let prose = '';
  let lastIndex = 0;
  TOOL_TAG.lastIndex = 0;
  let m;
  while ((m = TOOL_TAG.exec(text)) !== null) {
    prose += text.slice(lastIndex, m.index);
    lastIndex = m.index + m[0].length;
    const name = m[1];
    const block = m[2];
    const spec = PARAMS[name];
    if (!spec) { calls.push({ name, args: {}, unknown: true }); continue; }
    const args = extractParams(block, spec);
    // Single-param actions tolerate a bare body: <codeply:read_file>x.js</...>
    if (spec.length && Object.keys(args).length === 0 && block.trim()) {
      args[spec[0]] = block.trim();
    }
    calls.push({ name, args });
  }
  prose += text.slice(lastIndex);

  if (calls.length > 0) {
    return { prose: prose.trim(), calls, recovered: false, malformed: false, truncated: false };
  }

  const poolside = parsePoolsideCalls(text);
  if (poolside.calls.length > 0) {
    return { prose: poolside.prose.trim(), calls: poolside.calls, recovered: false, malformed: false, truncated: false };
  }

  const truncated = looksTruncated(text);

  // Don't let the salvage path guess at a call built from a truncated block —
  // it would be missing content/search/replace and either fail oddly or write
  // a partial file. Truncation gets its own, more accurate correction instead.
  if (!truncated) {
    const salvaged = recoverCall(text);
    if (salvaged) {
      // Strip the mangled markup so the user reads the intent, not the debris.
      const cleaned = text
        .replace(/<\/?[a-z_:]+>/gi, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return { prose: cleaned, calls: [salvaged], recovered: true, malformed: false, truncated: false };
    }
  }

  return {
    prose: prose.trim(),
    calls: [],
    recovered: false,
    malformed: !truncated && LOOKS_LIKE_ATTEMPT.test(text),
    truncated,
  };
}

// ─── Project context ────────────────────────────────────────────────────────

function gitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).toString().trim();
  } catch { return null; }
}

/** A compact snapshot of the project, so the agent starts oriented. */
export function buildProjectContext(cwd) {
  const lines = [`Working directory: ${cwd}`, `Platform: ${process.platform}`];

  const branch = gitBranch(cwd);
  if (branch) lines.push(`Git branch: ${branch}`);

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      lines.push(`Package: ${pkg.name || '(unnamed)'}${pkg.version ? ' v' + pkg.version : ''}`);
      if (pkg.scripts) lines.push(`npm scripts: ${Object.keys(pkg.scripts).join(', ')}`);
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      if (deps.length) lines.push(`Dependencies: ${deps.slice(0, 25).join(', ')}${deps.length > 25 ? ', …' : ''}`);
    } catch {}
  }

  const files = walkFiles(cwd, { maxFiles: 300, maxDepth: 4 })
    .map((f) => path.relative(cwd, f).replace(/\\/g, '/'))
    .sort();
  if (files.length) {
    lines.push('', `Files (${files.length}${files.length >= 300 ? '+' : ''}):`);
    lines.push(files.slice(0, 200).join('\n'));
  }

  return lines.join('\n');
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

// NOTE ON WORDING: this reference deliberately avoids the words "tool",
// "call" and "function". The proxy runs openai/gpt-oss-120b, whose harmony
// training has a dedicated channel for function calls — phrasing this as tool
// calling made it reach for the *native* mechanism, and Groq then rejected the
// whole response with "Tool choice is none, but model called a tool" because
// the proxy declares no tools. Framing it as an output format keeps the model
// writing plain text. Keep it that way.
const TOOL_REFERENCE = `OUTPUT FORMAT

You have no function-calling ability here. You act purely by writing text.
When you need something done, write an ACTION BLOCK as literal text in your
reply, exactly like the examples below, and stop. The program reads your text,
performs the action, and writes the result back to you as your next message.

Never emit a structured/native function invocation. Write the tags as text.

<codeply:list_dir>
<path>src</path>
</codeply:list_dir>

<codeply:read_file>
<path>src/app.js</path>
<offset>0</offset>
<limit>400</limit>
</codeply:read_file>

<codeply:search>
<pattern>createServer</pattern>
<glob>**/*.js</glob>
</codeply:search>

<codeply:write_file>
<path>index.html</path>
<content>
...the complete new file content, verbatim, no escaping...
</content>
</codeply:write_file>

<codeply:edit_file>
<path>src/app.js</path>
<search>
the exact existing lines, copied character for character
</search>
<replace>
those lines with the change applied
</replace>
</codeply:edit_file>

<codeply:run>
<command>node --check index.js</command>
</codeply:run>

<codeply:use_skill>
<name>deep-research</name>
</codeply:use_skill>

<codeply:list_skills>
<query>testing</query>
</codeply:list_skills>

<codeply:fetch_image>
<url>https://loremflickr.com/1600/900/tea,leaves</url>
<path>assets/hero.jpg</path>
</codeply:fetch_image>

<codeply:browser_check>
<url>file:///absolute/path/to/index.html</url>
</codeply:browser_check>

<codeply:gmail_send>
<to>someone@example.com</to>
<subject>Subject line</subject>
<body>
The email body, plain text.
</body>
</codeply:gmail_send>

<codeply:gmail_search>
<query>from:someone@example.com is:unread</query>
</codeply:gmail_search>

<codeply:slack_post_message>
<channel>general</channel>
<text>
The message to post.
</text>
</codeply:slack_post_message>

<codeply:vercel_deploy>
<path>.</path>
</codeply:vercel_deploy>

<codeply:supabase_create_project>
<name>my-project</name>
</codeply:supabase_create_project>

<codeply:supabase_delete_project>
<name>my-project</name>
</codeply:supabase_delete_project>

<codeply:github_create_repo>
<path>.</path>
<name>my-project</name>
</codeply:github_create_repo>

<codeply:stop_agent>
<name>Pixel</name>
<index>1</index>
</codeply:stop_agent>

<codeply:design_reference_search>
<term>to-do list</term>
<category>productivity</category>
</codeply:design_reference_search>

<codeply:view_images>
<urls>https://example.com/screenshot1.jpg,https://example.com/screenshot2.jpg</urls>
</codeply:view_images>

<codeply:subagent>
<name>rename audit</name>
<task>
Search the codebase for every remaining reference to the old function name
"legacyFetch" and report each file:line. Do not edit anything — just report
back what you found.
</task>
</codeply:subagent>

<codeply:dispatch_agent>
<name>Pixel</name>
<task>
Build a responsive pricing page at pricing.html matching the site's existing
design system, with three tiers (Free/Pro/Team) and a FAQ section.
</task>
</codeply:dispatch_agent>

RULES
- Write at most ONE action block per reply, then stop and wait for its result.
- Do not waste steps. Every action block costs the user several seconds, so never
  perform one whose answer you already have:
  · If the user gave a full path, read it directly — do not list_dir first.
  · After a successful edit_file or write_file, do NOT read the file back. The
    result already confirms it applied. Only re-read a part you have not seen.
  · Do not re-read a file that is already earlier in this conversation.
- When the result comes back, keep going on your own. Do not ask the user what to do next while you still have obvious work left.
- If an action fails, do not apologize or re-explain what you were trying to do — that wastes a whole reply and fixes nothing. Look at the actual error, and on your very next reply either fix the real cause or try something genuinely different. If the same action has now failed more than once for the same reason, that reason is not going to change on a third identical attempt — stop and re-read the file, or the error, or rethink the approach instead of repeating it.
- read_file before you edit_file. "search" must be copied verbatim from what you just read — never from memory, never with the line-number prefixes the reader adds.
- Keep "search" as narrow as the change actually is. When removing something, search should span exactly the thing being removed — not "from here to the end of the file" just because that was easy to copy. A wider span deletes whatever sits between your intended target and wherever you stopped, silently, even when it renders fine and reports no errors. If two things need removing and something unrelated sits between them, that is two edit_file calls, not one wide one.
- edit_file for changes to an existing file. write_file only for new files or a genuine full rewrite.
- Prefer run for anything you can check mechanically.
- run executes a real shell command on the user's own machine, in their own project directory, with their own git/gh credentials already configured — the exact same terminal they'd get typing it themselves. That includes git add, git commit, git push, gh pr create, npm install, or anything else. Never tell the user you don't have terminal or network access, or that you can't run a command — if it's a shell command, write a <codeply:run> action block and run it for real. Do not just describe what the command would do.
- If a task needs a CLI that turns out not to be installed, install it yourself with the platform's own package manager (winget on Windows, brew on macOS, apt/apt-get on Linux) via run before falling back to a manual workaround — do not immediately hand the user a "go do this in a browser" set of steps just because a binary is missing; installing it is itself a shell command. The one thing you genuinely cannot do unattended is an interactive auth step a CLI requires after installing (e.g. gh auth login opening a browser for a device code) — if the install succeeds but the tool then reports it isn't authenticated, that specific login step is the only part to ask the user for, not the whole task.
- Deploying to Vercel, creating a Supabase project, or creating a new GitHub repo and pushing to it are NOT CLI tasks here — do not install or shell out to the vercel CLI, the supabase CLI, or gh repo create for these. Use vercel_deploy, supabase_create_project, and github_create_repo instead: they call the connected account directly (once the user has connected it from the Integrations panel), with no separate CLI login step and no "go create an empty repo on github.com first." If one reports its integration isn't connected, say so plainly and point the user to the Integrations panel — do not fall back to the CLI/manual route as a workaround, and do not install the vercel/supabase CLI to route around a missing connection.
- Creating a remote repo, pushing code, enabling Pages, or deploying anything are exactly the kind of claim covered by "never report success you did not verify" above — and the easiest one to get wrong, because each step's own command can silently no-op or partially fail while a LATER step still appears to succeed. Concretely: run whoami equivalents (gh api user, gh auth status) to get the real signed-in username BEFORE building any URL with it — never guess a username from the OS account name, the folder name, or anything the user said earlier that could be stale; after gh repo create or git push, treat the command's own exit code and printed output as the only source of truth for whether it worked, not your prior turn's summary of what you intended to do — a command you ran two turns ago having succeeded is not evidence this turn's retry did too; and never hand the user a repository/deployment URL you have not just confirmed resolves (curl -I it, or read it back from the command's own output) — a plausible-looking URL built from a guessed username/slug is a fabrication even if the pattern is usually right.
- gmail_send and slack_post_message send a real email or a real Slack message the moment they run — there is no draft state, no "preview" mode. Only use them when the user actually asked for that email/message to go out, never speculatively, never as a way to "show" them what it would say. If gmail_search or a prior message makes clear Gmail/Slack isn't connected, say so plainly and stop — do not retry hoping it connects itself, and do not claim you sent something when the tool reported it wasn't connected.
- vercel_deploy, supabase_create_project, supabase_delete_project, and github_create_repo are the same category as gmail_send/slack_post_message above: real, immediate action the moment they run — a live production deployment, a newly provisioned cloud database with its own bill, a brand-new repository pushed with the user's code. Only use them when the user actually asked for that outcome, never speculatively "to check if it would work." If one reports its integration isn't connected, say so plainly and stop rather than retrying or working around it. supabase_delete_project is the sharpest of these — it permanently destroys a database with no undo — so only reach for it when the user has clearly asked to delete or remove a specific project, never as cleanup for something that merely looks unused.
- Every image in generated markup must be a local file, downloaded with fetch_image. NEVER write an <img> or CSS background-image pointing straight at loremflickr.com, picsum.photos, or any other live generator URL — those are redirect services that return a DIFFERENT random photo on every single request, so the page shows a different (sometimes completely unrelated) image on every reload, every redeploy, every visitor. Always fetch_image the URL to a real path under assets/ first, then reference that local path in the markup. If the user hasn't given you specific photos and the site needs placeholder imagery, fetch_image from https://loremflickr.com/<width>/<height>/<keyword1>,<keyword2> — it pulls a real tagged photo matching those keywords, no API key needed. Pick keywords that actually describe THAT section's subject (a tea shop's hero: 'tea,leaves' or 'matcha,ceremony', not generic filler) — never use a source that returns fully random, unrelated stock photos (e.g. picsum.photos) on a themed site; a beach or a crowd photo under a tea brand's "Our Heritage" section is worse than no image. If a downloaded placeholder turns out to be a broken/static-noise "no match" image or is visibly unrelated to its section once you look at the page, delete it and fetch_image again with more specific keywords — do not leave a wrong or corrupted image in place.
- If a SKILLS entry below is a clear match for the task, use_skill it before starting — its instructions take priority over your own default approach for that kind of work. Do not use_skill speculatively; only when a listed skill actually matches what you are about to do. A name under LIKELY RELEVANT TO THIS REQUEST, if that section is present, was matched against your actual request from the full library — treat it exactly the same way: use_skill it before starting unless it's obviously a false match, do not silently ignore it in favor of guessing your own approach.
- EXCEPTION — this one is not speculative: if the task is to build or restyle any page a human will look at in a browser (a landing page, a small-business site, a portfolio, a dashboard, any HTML/CSS/UI), use_skill 'premium-web-design' before writing markup, even if the brief sounds tiny or mundane ("a site for a tea shop"). A plain-sounding brief is not permission for a flat, default-Bootstrap-looking result — Codeply's bar is that every generated page reads as deliberately designed. Skip this only if the user explicitly asked for something minimal/utilitarian/no-frills.
- EXCEPTION — this one is MANDATORY, not speculative, and comes before you write any markup for that same kind of task (a page or app screen a human will look at): call design_reference_search on the core screen(s) the app needs (an onboarding flow, a checkout, a settings screen, a to-do list's main view — whatever the brief actually calls for) before designing it from memory. It is a local library (no external account, no login, no network dependency) so it is always available — do not skip this step, and do not substitute your own guess at what that kind of screen "usually" looks like. Real shipped apps solve layout/hierarchy/empty-state problems in ways worth matching, not just imitating the vibe of. Only if it reports the library itself is missing on this machine should you say that plainly to the user once and continue from your own judgment.
- CALLING design_reference_search IS NOT THE SAME AS USING IT. It returns a list of screenshot URLs — that is raw material, not a design brief, and the search result text alone tells you nothing about what those screens actually look like. fetch_image does NOT show you the image either — it only downloads it to disk, silently, no vision, so calling it on a reference screenshot accomplishes nothing here. Before you write markup, call view_images with 2-4 of the returned screenshot URLs (from different apps, not all from result #1) — that is the only tool that actually attaches the image for you to look at: the real layout structure, spacing, type scale, color choices, empty states, and component patterns those apps ship with. Build FROM specific things you saw in those images, not from a generic idea of what that kind of app "usually" looks like. If you searched but did not view_images any of the results, you did not reference real apps this turn — say that plainly in your summary ("I designed this from my own judgment, not a specific reference") rather than claiming you drew from real app patterns. This applies retroactively too: if the user later asks what reference you used, answer from what you actually did in this conversation (did you view_images any screenshots, and which apps), never from a guess or a vague assumption that you probably did — being wrong about your own prior actions is worse than admitting you skipped the step.
- design_reference_search searches a private library built ahead of time (914 real apps, 6,433 screenshots from official App Store listings, covering productivity/finance/shopping/social/travel/food_delivery/health_fitness/education/entertainment/real_estate). A category filter narrows results; term alone searches across all categories. Same fetch_image requirement applies — see the rule above.
- EXCEPTION — also not speculative, and it is the LAST thing you do before replying, not something you might get to: if you wrote or edited any HTML/CSS/JS/frontend file this turn, browser_check the actual page that changed (not just the file you touched — file:///<absolute path> for a static file, or http://localhost:<port> if the project needs a server, start one with run first if nothing is serving yet) BEFORE telling the user it's done. A page you have not opened is a page you do not know works. When it's available, the result includes an actual screenshot of the page as it just rendered, not only a text extraction — look at that image before judging the page correct; a layout that's visually broken, a section that's misaligned, or an image that rendered as a broken-icon placeholder won't always show up as a console error or missing text, so text-only reasoning is not enough. Read the report like a bug filed against you: an error names a file and often a line, and the screenshot shows you what a user would actually see — go fix whichever is wrong, then browser_check the same page again, and repeat until both the report and the screenshot come back clean. Do not call two checks "the same" or "different" from memory or assumption — judge each one from what that check actually returned. A fix in a shared file (a stylesheet, a component several pages import) can affect pages you did not start from — browser_check those too before you finish. Skip this only if browser_check reports itself unavailable (say so once, then continue from the source) or the task has no page to render (a CLI script, a backend-only route).
- subagent hands a self-contained task to a second, independent copy of you, with its own fresh context and its own step budget, running inside this same session. Reach for it to parallelize genuinely independent chunks of a bigger job (e.g. "audit these three unrelated modules" as three subagent calls, or "research X while I keep editing Y") or to keep a long investigation's exploratory reads/searches out of YOUR context so you stay focused on the main thread. A subagent can read, search, run commands, and — if the task calls for it — write or edit files; every write/edit/run it performs still goes through the same approval prompt the user sees for your own actions, so it has no more authority than you do. Give it a short <name> and a <task> that is fully self-contained: it cannot see this conversation, so state everything it needs to know (paths, the exact goal, what "done" looks like) inside the task text itself. It reports back a summary as this tool's result — read that summary and continue; do not re-do the work it already did. Subagents cannot themselves spawn further subagents. Do not use it for small one-step lookups you could just do yourself in the next action block — the overhead of a whole nested run only pays off for real, multi-step, delegable chunks of work.
- Seven named specialists exist for this — pass one as <name> exactly and the subagent actually takes on that persona (not just the label): frontend/Pixel (UI, components, CSS, accessibility, motion, visual hierarchy), backend/Circuit (API design, business logic, auth, concurrency), database/Index (schema, migrations, query performance, data integrity), devops/Rocket (CI/CD, deploys, infra, observability), security/Warden (vulnerability review, auth/authz, secrets, dependency risk), testing/Scout (test strategy, edge cases, regression tests, manual verification), docs/Scribe (README/API docs/comments written for a real reader). Reach for one by name when a chunk of the task is squarely that specialist's domain and would benefit from its specific standards and instincts, not just extra hands — e.g. "have Warden review this auth change" or "delegate the schema migration to Index" — rather than a generic unnamed subagent call.
- The SKILLS list below is a subset. If the task is a specific kind of specialized work (a particular framework, a particular deliverable type) that doesn't clearly match anything listed, try list_skills with a one- or two-word query before assuming there's no skill for it — there are 281 in total, not just the ones shown.
- STACK CHOICE — when the user asks you to build a new app/tool/site from scratch and does not say what to build it with (no "in React", "as an Electron app", "using Vite", etc.), do not silently default to a multi-file React project or an Electron shell — those add a build step, a node_modules install, and a packaging story the user did not ask for. Instead, reply with prose only (no action block) asking one short question: whether they want a single self-contained HTML file (open it straight in a browser, nothing to install) or a specific framework/Electron/React setup instead, and briefly say why a single file is the lighter default. Wait for their answer before writing any code. Skip this ask only when the user already named a stack, is clearly extending/matching an existing project's stack (react/electron files already in the folder), or explicitly said to just decide for them.
- When the task is finished, reply with prose only and NO action block. That ends your turn. If you were dispatched to this task rather than talking with the user directly (you're a specialist working independently, not the coordinator), that final reply is the ONLY thing anyone sees of your work unless they go dig through this session — end it with a short, plain-English close: what you actually did, whether it matches what was asked, and what (if anything) should happen next. Not a recap of every step, just the part someone deciding what to do next actually needs.`;

const VERIFY_RULES = `VERIFYING YOUR WORK
You are not done when the code is written. You are done when it is checked.
- After editing JS/TS, run a syntax check (e.g. node --check <file>).
- If the project has a test/lint/build script, run the relevant one.
- After editing any HTML/CSS/frontend file, browser_check the page it changed. This is not optional when the capability is available — console errors, broken images, and a blank render are exactly as real a failure as a failing test, and reading source code does not catch them; only opening the page does. When the check returns a screenshot, actually look at it — that is the real verification, not the text report around it. Never guess or assume what the page looks like from having generated the markup; judge it from what you were just shown.
- If a command fails, read the error, fix the cause, and run it again. Repeat until it passes or you have a specific reason it cannot.
- Never report success for something you did not verify. If you could not verify it, say exactly that.`;

const MODE_PROMPT = {
  Build: `You are Codeply, an autonomous coding agent working in the user's terminal.

Do the work the user asked for, end to end. Explore the project before assuming anything about it — read the actual files, do not guess at their contents or invent APIs. Make the change, then verify it.

${VERIFY_RULES}

LARGE REWRITES
One enormous reply can exceed the service's limits and fail outright. For a big
redesign or a file over ~200 lines, work in stages instead: write_file once with
the full structure and the main sections, then use edit_file to flesh out or
restyle one section per step. Each reply stays a manageable size and you keep a
working file at every point.

Keep prose short. A sentence about what you are about to do, then the action block. At the end, a two or three line summary of what changed. No filler, no restating the request back.`,

  Plan: `You are Codeply, working in Plan mode in the user's terminal.

Investigate and produce a concrete plan. You MAY read, list, search, and run read-only commands to ground the plan in what is actually there. You MUST NOT write or edit files in this mode — if the user wants the change applied, tell them to switch to Build mode with tab.

Deliver: what you found, the specific files and functions involved, then numbered steps. Be concrete about file paths and names. Flag anything genuinely ambiguous instead of picking silently.`,

  Ask: `You are Codeply, working in Ask mode in the user's terminal.

Answer the user's question. Read files, search, and list to ground your answer in this specific codebase rather than in generalities. Do not write or edit files in this mode.

Be concise and concrete. Quote the relevant code and cite it as path:line. If the answer is not in the codebase, say so plainly rather than inventing one.`,
};

const READ_ONLY_MODES = new Set(['Plan', 'Ask']);

/**
 * Skills add capability without adding weight proportional to the whole
 * library: only a curated subset's name + capped description goes in here —
 * see lib/skills.js for why the bundled set (281 skills, ~3.4MB) can't be
 * injected in full on every request without the skill library itself becoming
 * the majority of the token cost. The rest is one list_skills query away.
 */
function buildSkillIndex(userMessage) {
  const all = skills.listSkills();
  const daily = skills.formatSkillIndex(all);
  if (!daily) return null;
  const rest = all.length - all.filter((s) => s.daily).length;
  let out = `SKILLS\nOptional playbooks for specific kinds of work. Load one with use_skill ` +
    `when its description clearly matches the current task. This is a subset — ` +
    `${rest} more exist; search them with list_skills if nothing here fits:\n${daily}`;

  // Computed fresh from the actual request, not a fixed list — this is what
  // lets one of the other ~244 skills get reached without the model having to
  // guess a good list_skills query first. Excludes daily skills: they're
  // already shown above, no need to say the same name twice.
  const relevant = skills.findRelevantSkills(userMessage, all, { limit: 6, excludeDaily: true });
  if (relevant.length) {
    const lines = relevant.map((s) => `- ${s.name}: ${s.description.length > 140 ? s.description.slice(0, 139).trim() + '…' : s.description}`).join('\n');
    out += `\n\nLIKELY RELEVANT TO THIS REQUEST (matched from the full ${all.length}-skill library):\n${lines}\n` +
      `Treat a name here exactly like a SKILLS match above: use_skill it before starting unless it's clearly a false match for what you're about to do.`;
  }

  return out;
}

// Injected instead of a specialist persona whenever no specialist is pinned
// for this turn (persona is null — see main.js's effectiveSubagentId: only a
// manual pin from the picker chip ever exempts a turn from this). Turns the
// top-level "Codeply" identity into a coordinator: it talks to the user and
// hands real work to the right specialist via dispatch_agent, rather than doing it
// itself. This is prompt-level steering, not a hard tool restriction — same
// as every other rule in this file — so it's a real limit, not a guarantee.
const COORDINATOR_RULES = `COORDINATOR ROLE
You are Codeply, talking directly with the user right now. You are not one of the seven specialists (Pixel, Circuit, Index, Rocket, Warden, Scout, Scribe) — you coordinate them and report back; you do not do their work yourself.
Read-only tools stay yours to use directly, freely, whenever they help you understand a request or check on work already done: list_dir, read_file, search, gmail_search, browser_check, list_skills, view_images, design_reference_search.
Anything that changes something is not yours to call directly: write_file, edit_file, run, fetch_image, gmail_send, slack_post_message, vercel_deploy, supabase_create_project, supabase_delete_project, github_create_repo. For those, use dispatch_agent to hand the task to whichever specialist's expertise actually matches — frontend/UI to Pixel, backend/API to Circuit, database to Index, deployment/infra to Rocket, security to Warden, testing/QA to Scout, docs/writing to Scribe — even when the task looks small. If nothing fits cleanly, dispatch to whichever is the closest match rather than doing it yourself.
dispatch_agent is fire-and-forget: it returns as soon as the specialist's own run has started, not once it's finished. Tell the user you've handed it off and to whom, then stop — don't wait around narrating steps you can no longer see. The specialist's own chat (and the Agent View tab) is where its real progress and approval prompts show up from here on.
The subagent tool (not dispatch_agent) is still fine for a quick synchronous consultation you need an answer from before continuing — "does this look risky to Warden" — since that blocks and returns an answer instead of starting independent background work.
If the user asks to stop, kill, or cancel a specialist that's currently working ("kill the pixel agent", "stop warden 1"), use stop_agent — name the specialist, and an index if they gave one (1 = the first/oldest active session for that specialist, the default when they didn't say a number). Confirm what you stopped; don't just go quiet.
When a dispatched specialist finishes, you'll see its own summary arrive as a new message in this chat on its own — you don't need to go check on it or ask the user to.`;

export function buildSystemPrompt(mode, cwd, userMessage, persona, subagentDepth) {
  const parts = [MODE_PROMPT[mode] || MODE_PROMPT.Build];
  // A pinned specialist persona (see lib/subagents.js) goes in right after the
  // base mode framing and before the tool reference — it should color *how*
  // every tool gets used (what Circuit reaches for vs. what Pixel reaches
  // for), not compete with the tool reference for the model's attention by
  // sitting after it. No persona at all means no specialist is active for
  // this turn — the coordinator rules take that same slot instead, but ONLY
  // at the top level (subagentDepth falsy/0): a nested subagent/dispatch run
  // with no named specialist is still a worker that must actually do the
  // task, not a second coordinator that just delegates again — dispatch_agent
  // has no depth cap of its own, so without this guard an unnamed subagent
  // told to write a file would just dispatch yet another run and never
  // return real work to whoever is synchronously awaiting it.
  if (persona) parts.push('', 'SPECIALIST PERSONA — this defines who you are for this conversation:', persona);
  else if (!subagentDepth) parts.push('', COORDINATOR_RULES);
  parts.push('', TOOL_REFERENCE);
  if (READ_ONLY_MODES.has(mode)) {
    parts.push('', 'MODE RESTRICTION: write_file and edit_file are disabled. Using them returns an error. run is limited to read-only commands.');
  }
  const skillIndex = buildSkillIndex(userMessage);
  if (skillIndex) parts.push('', skillIndex);
  parts.push('', 'PROJECT CONTEXT', buildProjectContext(cwd));
  return parts.join('\n');
}

// ─── Context budget ─────────────────────────────────────────────────────────

/**
 * Keep the transcript under budget by dropping the oldest tool exchanges.
 * The system prompt and the most recent turns always survive.
 */
// A message's content is a plain string for every ordinary turn, but an
// OpenAI-shaped array (text + image_url parts) whenever the user pasted an
// image — .length and .startsWith exist on arrays too, just meaning
// something completely different (part count, not a function), so treating
// content as "always a string" here would either miscount the budget or
// throw outright the first time an image-bearing message reached this
// function. contentLength() and isToolResult() are what keep this safe.
function contentLength(content) {
  return typeof content === 'string' ? content.length : JSON.stringify(content).length;
}
// Text of a tool-result message, whether it's a plain string or the
// image-bearing [{type:'text',...}, {type:'image_url',...}] array a
// browser_check-with-screenshot result now produces (see the tool_result
// push above). Screenshots are large — a single one in base64 can outweigh
// the whole char budget on its own — so they must be just as trimmable as
// any other aging tool result, not permanently exempt because the shape
// changed from a plain string.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find((p) => p.type === 'text')?.text || '';
  return '';
}
function isToolResult(content) {
  return toolResultText(content).startsWith('[tool result');
}

function trimTranscript(messages) {
  let total = messages.reduce((n, m) => n + contentLength(m.content), 0);
  if (total <= CONTEXT_CHAR_BUDGET) return messages;

  const kept = [...messages];
  // index 0 is the system prompt; never touch the last 6 messages.
  for (let i = 1; i < kept.length - 6 && total > CONTEXT_CHAR_BUDGET; i++) {
    if (kept[i].role === 'user' && isToolResult(kept[i].content)) {
      total -= contentLength(kept[i].content);
      const head = toolResultText(kept[i].content).slice(0, 200);
      kept[i] = { role: 'user', content: `${head}\n[… older tool output dropped to save context]` };
      total += contentLength(kept[i].content);
    }
  }
  return kept;
}

// ─── Model call ─────────────────────────────────────────────────────────────

/**
 * gpt-oss-120b occasionally reaches for its native function-calling channel
 * despite the prompt. The proxy declares no tools, so Groq rejects the whole
 * response and we get back nothing usable. Detect that specific failure and
 * retry with a correction rather than killing the user's turn.
 */
function isNativeToolCallError(error) {
  const s = String(error || '').toLowerCase();
  return s.includes('tool choice is none') ||
    (s.includes('called a tool') && s.includes('tool choice')) ||
    s.includes('tool_choice');
}

const NO_NATIVE_TOOLS_REMINDER =
  '[system] Your last reply tried to invoke a function through the API. That is not available here and the response was discarded. ' +
  'Write the action block as literal text in your message — the tags exactly as shown in the OUTPUT FORMAT section — and nothing else.';

async function callModel(messages, promptText, signal, route) {
  const meta = promptText ? { promptText } : undefined;
  let result = await ai.chat(messages, { meta, signal, route });
  if (result.success || !isNativeToolCallError(result.error)) return { result, messages };

  const corrected = [...messages, { role: 'user', content: NO_NATIVE_TOOLS_REMINDER }];
  result = await ai.chat(corrected, { meta, signal, route });
  return { result, messages: corrected };
}

// ─── Loop ───────────────────────────────────────────────────────────────────

/**
 * Run one user turn to completion.
 *
 * @param {object}   o
 * @param {string}   o.userMessage
 * @param {Array}    o.history      prior [{role,content}] turns
 * @param {string}   o.mode         Build | Plan | Ask
 * @param {string}   o.cwd
 * @param {Function} o.approve      async ({tool,title,detail,danger}) => 'once'|'always'|'reject'
 * @param {Function} [o.browser]    async (url, {wait}) => report — optional; only a host with a
 *                                  real browser (the Codeply Craft desktop app) provides this.
 *                                  Its absence (plain CLI) is what makes browser_check gracefully
 *                                  report itself unavailable rather than erroring the whole turn.
 * @param {{provider:string,model:string}} [o.route]  per-turn model override from
 *                                  lib/model-router.js. Decided once by the caller and held for
 *                                  every step of the turn; omitted entirely when the user has
 *                                  pinned a specific model, in which case stored config wins.
 * @param {string[]} [o.images]     data: URLs of images pasted alongside this message — only sent
 *                                  on THIS turn (not replayed into history on later turns); silently
 *                                  ignored by any model/provider that doesn't accept vision input.
 * @param {AbortSignal} o.signal    a real AbortSignal — it is handed straight to fetch()
 *                                  in ai.js, which requires an actual instance, not a
 *                                  look-alike {aborted} object.
 * @param {number}   [o.subagentDepth]    0 for a top-level run, 1 inside a subagent — caps
 *                                  recursion, since a subagent is not allowed to spawn its own.
 * @param {Function} [o.onSubagentEvent]  ({type:'start'|'progress'|'end', id, label, event}) => void
 *                                  fired as nested subagent runs start, step, and finish, so a host
 *                                  UI can show how many agents are active right now.
 * @param {string}   [o.subagentId]  id of a named specialist from lib/subagents.js (e.g. 'frontend',
 *                                  'security') pinned to this whole run — its AGENT.md persona is
 *                                  injected into the system prompt for every turn. Unknown/omitted
 *                                  ids are silently ignored (falls back to the plain base prompt).
 * @yields {{type:string, ...}} text | tool_start | tool_end | done | error
 */
export async function* runAgent({ userMessage, history, mode, cwd, approve, browser, images, signal, route, subagentDepth, onSubagentEvent, subagentId, dispatchAgent, stopAgent }) {
  const readOnly = READ_ONLY_MODES.has(mode);
  const persona = subagentsLib.getSubagent(subagentId)?.persona || null;
  // OpenAI-shaped content array only when there's actually an image to carry —
  // every ordinary turn keeps the plain string content every other code path
  // (trimTranscript, prompt caching, dedup keys) already assumes.
  const userContent = images && images.length
    ? [{ type: 'text', text: userMessage }, ...images.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } }))]
    : userMessage;
  const messages = [
    { role: 'system', content: buildSystemPrompt(mode, cwd, userMessage, persona, subagentDepth) },
    ...history,
    { role: 'user', content: userContent },
  ];

  // True only for the top-level coordinator turn (no specialist persona,
  // not itself running inside a subagent/dispatch) — see COORDINATOR_RULES
  // above. Enforced in tools.mjs's executeTool, not just prompted: a prompt
  // alone wasn't reliable enough to stop the model reaching for write_file/
  // run/etc. directly instead of dispatch_agent.
  const coordinatorOnly = !persona && !(subagentDepth || 0);
  const ctx = { cwd, approve, browser, signal, mode, route, subagentDepth: subagentDepth || 0, onSubagentEvent, dispatchAgent, stopAgent, coordinatorOnly };
  const transcript = [{ role: 'user', content: userMessage }];
  let malformedRetries = 0;
  let truncatedRetries = 0;
  let hallucinationRetries = 0;
  let madeAnyEdit = false; // true once a write_file/edit_file actually succeeds this turn — gates the check below
  const writtenBasenames = new Set(); // basenames of files actually write_file'd/edit_file'd this turn — feeds the overclaim check below

  // A prompt instruction alone ("call view_images before designing") was not
  // reliable enough — real runs showed the model calling
  // design_reference_search, getting real hits back, and then
  // going straight to write_file without ever looking at a single screenshot
  // (see the incident that led to this: it cited "productivity app
  // references" in its summary for a design it never actually viewed). This
  // turns that into a hard code-level gate instead of a suggestion: once a
  // reference search returns real hits, writing/editing a UI file is blocked
  // until view_images has actually run at least once this turn.
  let referenceSearchPending = false;
  const UI_FILE_EXT = /\.(html?|css|jsx?|tsx|vue|svelte)$/i;

  // Two mechanisms that cut the actual token COUNT sent, not just its billed
  // price (prompt caching, elsewhere in ai.js, only does the latter):
  //
  //  - servedCalls: a repeat read_file/list_dir/search/use_skill/list_skills
  //    call within one turn — same tool, same arguments — is a real, common
  //    pattern (the model re-checks something it already has). Re-running it
  //    would resend the exact same content a second time for zero new
  //    information; a short pointer back to the earlier result carries the
  //    same information in a fraction of the tokens.
  //  - readIndexByPath: once a file is edited, any EARLIER read_file result
  //    for that same path in the transcript no longer describes what's on
  //    disk. Besides being a real correctness hazard (the model reasoning off
  //    stale content), keeping it around costs tokens for information that is
  //    now wrong. It gets collapsed to a pointer the moment the edit lands,
  //    not deferred to trimTranscript()'s budget-driven pass.
  const DEDUPABLE = new Set(['read_file', 'list_dir', 'search', 'use_skill', 'list_skills']);
  const servedCalls = new Map();     // callKey -> message index of its result
  const readIndexByPath = new Map(); // resolved path -> message index of its read_file result
  // Consecutive edit_file failures per path — a weak model that keeps
  // guessing at search text instead of re-reading will otherwise loop
  // through several apologetic retries in a row without ever converging.
  // Cleared the moment that path gets a real read_file or a successful edit.
  const failedEditsByPath = new Map();
  const MAX_EDIT_FAILURES_BEFORE_FORCE_READ = 2;
  // resolved path -> next unseen line offset, once a read_file call comes back
  // with more of the file left. A model re-requesting "the rest of this file"
  // doesn't reliably track and restate the right offset itself — left to that,
  // a long file often just gets re-shown from the top every time instead of
  // actually advancing. Consulted (and rewritten) right before a read_file
  // call executes, below; cleared once a path's edited, same as readIndexByPath.
  const readProgressByPath = new Map();

  // A model that keeps investigating without ever committing to an action —
  // reading file after file, re-checking things it already looked at, never
  // reaching write_file/edit_file/run — otherwise burns the whole MAX_STEPS
  // budget on research alone and fails with nothing to show for it (the
  // observed failure this guards against: several read_file calls in a row,
  // no edit, straight into "Stopped after 24 steps"). DEDUPABLE's own
  // "unchanged, reusing that result" nudge above only catches an EXACT
  // repeat of the same call; this also has to count a DEDUPED call's own
  // "step" toward the streak (it costs nothing extra, but still, correctly,
  // is a step spent with nothing new to show) or a model that keeps
  // blindly re-requesting the same thing would burn the whole loop that way
  // without ever tripping this guard. Any tool not in this set — including a
  // failed write/edit attempt, which is still a real attempt to act —
  // resets the streak; only read-only, no-side-effect calls extend it.
  const NON_PROGRESS_TOOLS = new Set(['read_file', 'list_dir', 'search', 'use_skill', 'list_skills', 'view_images', 'design_reference_search', 'browser_check']);
  const MAX_READ_ONLY_STREAK = 5;
  let readOnlyStreak = 0;
  function readOnlyStreakNote() {
    readOnlyStreak++;
    if (readOnlyStreak < MAX_READ_ONLY_STREAK) return '';
    readOnlyStreak = 0;
    return ` [system] That's ${MAX_READ_ONLY_STREAK} read-only calls in a row with nothing written or run. Stop investigating — either make the actual change now (write_file/edit_file) based on what you've already seen, or state plainly what's blocking you. Do not call another read-only tool this step.`;
  }

  const callKey = (name, args) => `${name}:${JSON.stringify(args)}`;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) { yield { type: 'aborted' }; return; }

    const stepStarted = Date.now();
    const attempt = await callModel(trimTranscript(messages), userMessage, signal, route);
    const stepMs = Date.now() - stepStarted;
    // A real fetch abort (see the signal wiring in ai.js) lands here as a
    // failed result, not a thrown exception — check the abort flag itself
    // before treating it as an error worth showing the user, otherwise a
    // stop mid-generation would flash "AbortError" instead of just stopping.
    if (signal.aborted) { yield { type: 'aborted' }; return; }
    const result = attempt.result;
    if (!result.success) {
      yield {
        type: 'error',
        error: isNativeToolCallError(result.error)
          ? `The model kept trying to use the provider's function-calling API, which this proxy does not enable (${result.error}). Try rephrasing, or switch modes with tab.`
          : result.error,
      };
      return;
    }
    // The correction message, if one was needed, has to stay in the transcript.
    if (attempt.messages.length > messages.length) {
      messages.push(attempt.messages[attempt.messages.length - 1]);
    }

    // gpt-oss/Laguna put chain-of-thought in a separate field; content can be
    // null while it's populated. Surfaced as its own event — not appended to
    // `reply` and not shown inline — so the UI can offer it as an optional,
    // collapsed "thought for Xs" the user opens on demand instead of dumping
    // raw reasoning into the chat unconditionally.
    const reasoning = result.data?.choices?.[0]?.message?.reasoning || '';
    if (reasoning.trim()) {
      yield { type: 'reasoning', text: reasoning.trim(), ms: stepMs };
    }

    const reply = result.data?.choices?.[0]?.message?.content ?? '';
    if (!reply.trim()) {
      messages.push({
        role: 'user',
        content: '[system] Your last reply was empty. Either write one action block as text, or give your final answer.',
      });
      continue;
    }
    messages.push({ role: 'assistant', content: reply });

    const { prose, calls, recovered, malformed, truncated } = parseReply(reply);

    // Checked BEFORE yielding anything: a reply that claims a change is
    // already made, while containing no action block, is not shown to the
    // user at all until it's been checked against what actually happened —
    // it's a confabulated result, not progress, and correcting it silently
    // (rather than after the false claim is already on screen) is the whole
    // point of catching it here instead of downstream.
    //
    // Two shapes, not one: nothing was written this turn at all (the
    // original case — !madeAnyEdit), OR something WAS written, but the
    // reply's completion claim names more files than were actually touched
    // ("I've created index.html, styles.css, and app.js" after only
    // index.html was really write_file'd). The first used to fully disable
    // this check the moment any edit landed, which was the gap: one real
    // edit gave the model a free pass to claim arbitrary extra work in the
    // same breath.
    if (calls.length === 0 && HALLUCINATED_COMPLETION.test(prose)) {
      const overclaimed = madeAnyEdit
        ? extractClaimedFilenames(prose).filter((f) => !writtenBasenames.has(f))
        : [];
      const isHallucination = !madeAnyEdit || overclaimed.length > 0;
      if (isHallucination) {
        if (hallucinationRetries < MAX_HALLUCINATION_RETRIES) {
          hallucinationRetries++;
          messages.push({
            role: 'user',
            content: madeAnyEdit ? overclaimCorrection(overclaimed) : HALLUCINATED_ACTION_CORRECTION,
          });
          continue;
        }
        // Retries exhausted — surface that plainly rather than quietly showing
        // the user a claim that still isn't backed by a real file change.
        yield {
          type: 'error',
          error: 'The model kept describing a change as already made without actually writing it, even after being corrected. Try a narrower or more specific request.',
        };
        return { transcript };
      }
    }

    // Coordinator-only: dispatch_agent is that role's mechanism, not a
    // specialist's own — see coordinatorOnly above.
    if (coordinatorOnly && calls.length === 0 && HALLUCINATED_DISPATCH.test(prose)) {
      if (hallucinationRetries < MAX_HALLUCINATION_RETRIES) {
        hallucinationRetries++;
        messages.push({ role: 'user', content: HALLUCINATED_DISPATCH_CORRECTION });
        continue;
      }
      yield {
        type: 'error',
        error: 'The model kept claiming it dispatched a specialist without actually doing so, even after being corrected. Try again or rephrase your request.',
      };
      return { transcript };
    }

    if (calls.length === 0) {
      // Checked BEFORE the prose yield below, same principle as the
      // hallucination check above: a truncated or malformed reply's raw text
      // is protocol debris — literal tag syntax the model fumbled, like
      // "<tool_call>read_file<arg_key>path</arg_key>..." — not a real answer,
      // and must never reach the user even for the one step where it happens.
      // The previous ordering yielded prose unconditionally and only THEN
      // checked malformed/truncated to decide whether to retry, so a model
      // that flailed at the format three times in a row left three garbled
      // "replies" sitting in the chat before it ever got corrected.
      if (truncated) {
        if (truncatedRetries < MAX_TRUNCATED_RETRIES) {
          truncatedRetries++;
          messages.push({ role: 'user', content: TRUNCATION_CORRECTION });
          continue;
        }
        yield {
          type: 'error',
          error: 'The model kept running out of room mid-write, even after being told to write less at once. Try a narrower request.',
        };
        return { transcript };
      }
      if (malformed) {
        if (malformedRetries < MAX_MALFORMED_RETRIES) {
          malformedRetries++;
          messages.push({ role: 'user', content: FORMAT_CORRECTION });
          continue;
        }
        yield {
          type: 'error',
          error: 'The model kept writing its action in the wrong format, even after being corrected. Try rephrasing the request.',
        };
        return { transcript };
      }
    }

    if (prose) {
      yield { type: 'text', text: prose };
      transcript.push({ role: 'assistant', content: prose });
    }

    if (calls.length === 0) {
      // No action block, and not malformed/truncated: the model considers
      // the turn genuinely finished.
      yield { type: 'done', steps: step + 1, madeAnyEdit, writtenFiles: [...writtenBasenames] };
      return { transcript };
    }

    if (signal.aborted) { yield { type: 'aborted' }; return; }

    const call = calls[0];
    if (calls.length > 1) {
      messages.push({
        role: 'user',
        content: '[note] You wrote several action blocks at once. Only the first was performed. Write one per reply.',
      });
    }

    // A read_file with no <offset> on a path already partway read continues
    // from where the last call left off, instead of silently restarting at
    // line 1 — see readProgressByPath above. Only fills in what the model
    // left unspecified; an explicit offset (including a deliberate 0, to
    // recheck the top again) always wins.
    if (call.name === 'read_file' && call.args.path && (call.args.offset === undefined || call.args.offset === null || call.args.offset === '')) {
      const abs = resolvePath(call.args.path, cwd).abs;
      if (readProgressByPath.has(abs)) call.args.offset = String(readProgressByPath.get(abs));
    }
    if (recovered) {
      // It worked this time, but only because we guessed. Nudge it back on
      // format so the next step does not depend on the same guess.
      messages.push({ role: 'user', content: FORMAT_CORRECTION });
    }

    if (readOnly && (call.name === 'write_file' || call.name === 'edit_file')) {
      messages.push({
        role: 'user',
        content: `[tool result: ${call.name}] Blocked — ${mode} mode cannot modify files. Describe the change instead, or tell the user to press tab for Build mode.`,
      });
      yield { type: 'tool_end', name: call.name, args: call.args, ok: false, summary: `blocked in ${mode} mode` };
      continue;
    }

    if (referenceSearchPending && (call.name === 'write_file' || call.name === 'edit_file') && UI_FILE_EXT.test(call.args.path || '')) {
      messages.push({
        role: 'user',
        content: `[tool result: ${call.name}] Blocked — you searched for real-app references and got real hits back, but never called view_images ` +
          `to actually look at any of the screenshot URLs. Call view_images now with 2-4 of those URLs (from different apps), THEN write ${call.args.path || 'the file'}.`,
      });
      yield { type: 'tool_end', name: call.name, args: call.args, ok: false, summary: 'blocked — reference screenshots not viewed yet' };
      continue;
    }

    // A repeat of an earlier read-only call, same tool and same arguments,
    // carries zero new information — reuse the earlier result instead of
    // spending tokens to resend it. This is skipped for read_file specifically
    // when the file was edited since (see the invalidation below): the whole
    // point there is to force a fresh read, not to serve stale content.
    if (DEDUPABLE.has(call.name) && servedCalls.has(callKey(call.name, call.args))) {
      messages.push({
        role: 'user',
        content: `[tool result: ${call.name}] Unchanged since your earlier identical call — reusing that result, not re-run. Nothing new to see; move on.${readOnlyStreakNote()}`,
      });
      yield {
        type: 'tool_end', name: call.name, args: call.args, ok: true,
        meta: { deduped: true }, summary: 'unchanged — reused earlier result',
      };
      continue;
    }

    yield { type: 'tool_start', name: call.name, args: call.args };

    const needsApproval = TOOL_NEEDS_APPROVAL.has(call.name);
    const started = Date.now();
    const out = await executeTool(call.name, call.args, ctx);
    const ms = Date.now() - started;

    yield {
      type: 'tool_end',
      name: call.name,
      args: call.args,
      ok: out.ok,
      meta: out.meta,
      summary: out.meta?.label,
      ms,
      needsApproval,
    };

    // browser_check with a real screenshot attached, or view_images with one
    // or more fetched images, gets the OpenAI-shaped image content array
    // (same shape used for pasted user images above) so the model actually
    // looks at the rendered page / reference screenshots instead of judging
    // them solely from a text description — that blind verification was
    // exactly why the same page could get called "the same" or "different"
    // inconsistently, and why a reference-search result could get cited
    // without ever actually being looked at. Every other tool, and any
    // provider that can't take image input, keeps the plain string content
    // unchanged.
    const resultText = `[tool result: ${call.name}]\n${out.output}`;
    const imageUrls = out.meta?.screenshotDataUrl
      ? [out.meta.screenshotDataUrl]
      : Array.isArray(out.meta?.imageDataUrls) ? out.meta.imageDataUrls : null;
    messages.push({
      role: 'user',
      content: imageUrls
        ? [{ type: 'text', text: resultText }, ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))]
        : resultText,
    });

    if (out.ok) {
      if (call.name === 'design_reference_search' && out.meta?.count > 0) {
        referenceSearchPending = true;
      }
      if (call.name === 'view_images') {
        referenceSearchPending = false;
      }
      if (DEDUPABLE.has(call.name)) {
        servedCalls.set(callKey(call.name, call.args), messages.length - 1);
      }
      if (call.name === 'read_file' && call.args.path) {
        const abs = resolvePath(call.args.path, cwd).abs;
        readIndexByPath.set(abs, { msgIndex: messages.length - 1, key: callKey(call.name, call.args) });
        // A fresh read is exactly the course-correction we'd otherwise force —
        // no need to keep counting failures against this path anymore.
        failedEditsByPath.delete(abs);
        if (out.meta?.hasMore) readProgressByPath.set(abs, (out.meta.offset || 0) + (out.meta.linesShown || 0));
        else readProgressByPath.delete(abs); // the whole file has now been seen at least once
      }
      if (call.name === 'edit_file' || call.name === 'write_file') {
        madeAnyEdit = true;
        if (call.args.path) writtenBasenames.add(path.basename(call.args.path).toLowerCase());
      }
      if ((call.name === 'edit_file' || call.name === 'write_file') && call.args.path) {
        failedEditsByPath.delete(resolvePath(call.args.path, cwd).abs);
      }
      if ((call.name === 'edit_file' || call.name === 'write_file') && call.args.path) {
        // The file just changed, so any earlier read_file result for it is now
        // wrong, not just old — collapse it in place rather than leaving
        // outdated content sitting in the transcript for the model to
        // (mis)reason from, and drop it from the dedup cache so a genuinely
        // fresh read_file after this point is not short-circuited by it.
        const abs = resolvePath(call.args.path, cwd).abs;
        const stale = readIndexByPath.get(abs);
        if (stale) {
          messages[stale.msgIndex] = {
            role: 'user',
            content: `[tool result: read_file] ${call.args.path} — superseded by the ${call.name} below; that earlier content no longer matches the file. Re-read if you need to see it again.`,
          };
          servedCalls.delete(stale.key);
          readIndexByPath.delete(abs);
        }
        readProgressByPath.delete(abs);
      }
    } else if (call.name === 'edit_file' && call.args.path) {
      // A model that keeps guessing at search text instead of re-reading the
      // file will otherwise spiral through several apologetic retries in a
      // row without ever converging on the actual current content. After
      // enough consecutive failures on the *same* path, stop it from trying
      // again blind and force a real read_file first.
      const abs = resolvePath(call.args.path, cwd).abs;
      const failures = (failedEditsByPath.get(abs) || 0) + 1;
      failedEditsByPath.set(abs, failures);
      if (failures >= MAX_EDIT_FAILURES_BEFORE_FORCE_READ) {
        failedEditsByPath.set(abs, 0);
        messages.push({
          role: 'user',
          content: `[note] That edit_file call on ${call.args.path} has now failed ${failures} times in a row — the search text you're guessing at does not match the file. Do not apologize or re-explain what you were trying to do. Call read_file on ${call.args.path} right now, look at its actual current content, then make the edit with search text copied exactly from it.`,
        });
      }
    }

    // A declined action is the user's answer, not a retry prompt.
    if (out.meta?.rejected) {
      messages.push({
        role: 'user',
        content: '[note] The user declined that action. Do not retry it. Either continue without it or stop and explain what you would have done.',
      });
    }

    if (NON_PROGRESS_TOOLS.has(call.name)) {
      const note = readOnlyStreakNote().trim();
      if (note) messages.push({ role: 'user', content: note });
    } else {
      readOnlyStreak = 0;
    }
  }

  yield { type: 'error', error: `Stopped after ${MAX_STEPS} steps without finishing. Narrow the request and try again.` };
}

export { MAX_STEPS };
