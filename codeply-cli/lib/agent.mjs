/**
 * Codeply agent loop.
 *
 * The ai-proxy exposes a plain chat completion - no native function calling -
 * so tool use rides on a tag protocol the model writes into its reply and we
 * parse back out. Tags are used rather than JSON because file content goes in
 * verbatim: no escaping pass to get wrong, and models corrupt long JSON strings
 * far more often than they corrupt a closing tag.
 *
 * runAgent() is an async generator so the TUI can render each step as it lands
 * instead of freezing until the whole task finishes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { executeTool, TOOL_NEEDS_APPROVAL, walkFiles, resolvePath, formatTodos, isPlanPath } from './tools.mjs';
import { buildToolSchemas, toNativeMessages, toolCallsToTags, NATIVE_FORMAT, TOOLS_UNSUPPORTED } from './native-tools.mjs';

const require = createRequire(import.meta.url);
const ai = require('./ai.js');
const mcpLib = require('./mcp.js');
const skills = require('./skills.js');
const plugins = require('./plugins.js');
const rolesLib = require('./subagents.js');
const config = require('./config.js');

// Enough room for a real task plus its verification pass. /goal runs pass a
// larger budget per iteration (see main.js).
const MAX_STEPS = 40;
const MAX_MALFORMED_RETRIES = 3;
// How much transcript (system prompt included) is sent per step before older
// tool results get collapsed. The hosted proxy is a Supabase Edge Function
// with its own memory ceiling (it returns 546 past it), so Auto stays modest;
// the system prompt alone is ~40K chars, so this has to leave real room for
// the conversation or the model loses track of what it already did. User
// models usually have far larger windows; local Ollama runs at 32K tokens.
const CONTEXT_CHAR_BUDGET = 64000;
function contextBudgetFor(route) {
  if (route && route.custom) return route.custom.kind === 'ollama' ? 100000 : 200000;
  if (route && route.auto) return 160000; // Gemma 4 31B on Ollama Cloud has a large window
  return CONTEXT_CHAR_BUDGET;
}

const FORMAT_CORRECTION =
  '[system] Your action block was not in the required form. Do not invent wrappers like <toolcall> or ' +
  '<|tool_call>, do not drop the "codeply:" prefix, and keep the underscore in the name. There is no native ' +
  'function-calling channel here - even if you have one, it is not connected, so anything you write there is ' +
  'silently discarded and never runs. Write it exactly like this, as literal text in your reply, opening and ' +
  'closing tags complete:\n\n' +
  '<codeply:read_file>\n<path>run.html</path>\n</codeply:read_file>\n\n' +
  'Valid names: todo, ask_user, mcp, list_dir, read_file, write_file, edit_file, search, run, use_skill, list_skills, fetch_image, ' +
  'browser_check, gmail_send, gmail_search, slack_post_message, vercel_deploy, supabase_create_project, ' +
  'supabase_delete_project, github_create_repo, design_reference_search, view_images, supabase_api, supabase_sql, vercel_api, ' +
  'web_fetch, web_search, apply_patch, plan_exit, plan_enter, lsp.';

const TRUNCATION_CORRECTION =
  '[system] That reply got cut off partway through the action block - the tag syntax was fine, it simply ran out of ' +
  'room before the block closed. This happens when write_file or edit_file tries to carry too much content in one reply. ' +
  "Don't re-explain or apologize for the format, just write less this time: for a new or rewritten file, write_file only " +
  'the first section now and use edit_file to add the rest over one or two more steps; for an edit, split it into smaller ' +
  'search/replace pairs. Try again with a smaller block.';

const MAX_TRUNCATED_RETRIES = 3;

// A reply that CLAIMS a file was written/edited/fixed, in the past tense,
// while itself containing no action block at all - and with no real
// write_file/edit_file success anywhere earlier in this same turn - is not
// "finished", it's a confabulated result. This is a real, observed failure
// mode on weaker models: they narrate "I have now applied the change" as
// filler text instead of actually emitting the tag, and the user is left
// with a chat that describes progress that never happened on disk. Matches
// only completion language (past tense / "successfully" / "has been"), not
// forward-looking intent ("I will now update...") - a plan is not a lie.
// The adverb list between "have" and the verb is deliberately a closed set
// (now/already/actually/just/finally), not "any word" - "I have TO update"
// is a statement of necessity, not a completion claim, and must not match.
const HC_VERB = '(?:applied|updated|written|wrote|edited|fixed|changed|added|created|modified|implemented|built|removed|deleted|replaced|refactored|renamed|rewritten|rewrote|moved|made)';
const HC_ADVERB = '(?:now|already|actually|just|finally)';
const HALLUCINATED_COMPLETION = new RegExp(
  `\\bi(?:'ve|\\s+have)\\s+(?:${HC_ADVERB}\\s+){0,2}${HC_VERB}\\b` +      // "I have now already applied..."
  `|\\bsuccessfully\\s+${HC_VERB}\\b` +                                  // "successfully applied..."
  `|\\b${HC_VERB}\\b[^.!?\\n]{0,20}\\bsuccessfully\\b` +                 // "...applied this successfully"
  `|\\b(?:has|have)\\s+been\\s+${HC_VERB}\\b` +                          // "...has been applied"
  `|\\bi\\s+(?:${HC_ADVERB}\\s+)?(?:updated|edited|fixed|changed|added|created|modified|implemented|removed|replaced|refactored|rewrote|wrote)\\s+(?:the|your|a|an|it|this|that|all|each|every)\\b`, // "I updated the header"
  'i',
);

// The model writing a tool result itself instead of waiting for the program's
// real one. Results only ever arrive as a separate message, so this text in
// the model's own reply is always invented.
const FABRICATED_RESULT = /\[tool result\b|^\s*(?:exit code|exited with code)\s*[:=]?\s*\d+\s*$/im;

const FABRICATED_RESULT_CORRECTION =
  '[system] Your last reply contains a tool result you wrote yourself. Tool results only come from the program, in a ' +
  'separate message after you write an action block, and you have not received one for that. Nothing you described there ' +
  'actually ran. Write the real action block and stop, then wait for its result.';

const HALLUCINATED_ACTION_CORRECTION =
  "[system] Your last reply describes a file as already changed, but it contained no action block, and nothing has actually " +
  "been written or edited yet this turn. Do not narrate work as done that you have not done - that leaves the user's " +
  "request unfulfilled while the chat claims otherwise. Write the real <codeply:edit_file> or <codeply:write_file> action " +
  "block now (search text copied verbatim from a file you have actually read), or if you genuinely cannot proceed, say so " +
  "plainly instead of claiming success.";

// Filename-shaped tokens mentioned in the completion sentence(s), used to catch
// the narrower case: a turn where a REAL edit did happen, so the check above
// (gated on !madeAnyEdit) never fires, but the reply's completion claim lists
// more files than were actually touched this turn - "I've created index.html,
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

// Claims about CHECKING work ("I ran the tests", "tests pass", "I verified it
// in the browser") and about SHIPPING it ("I've deployed", "pushed to
// GitHub") are the other common confabulations. Each is only accepted if a
// tool that could actually have done it ran successfully this turn. First-
// person / result phrasing only, so advice like "you should run the tests" or
// "it's not deployed yet" never trips it.
const CLAIM_VERIFIED = new RegExp(
  `\\bi(?:'ve|\\s+have)\\s+(?:${HC_ADVERB}\\s+|also\\s+|successfully\\s+){0,2}(?:run|ran|tested|verified|executed|confirmed|checked)\\b` +
  `|\\ball\\s+(?:the\\s+)?tests\\s+(?:now\\s+)?pass` +
  `|\\btests?\\s+(?:now\\s+)?(?:pass(?:ed|es)?|succeed(?:ed|s)?)\\b` +
  `|\\bbuild\\s+(?:now\\s+)?(?:passes|succeeded|is\\s+successful)\\b` +
  `|\\bverified\\s+(?:that\\s+)?(?:it|the\\s+(?:page|app|site|fix|change))\\s+works`,
  'i',
);
const VERIFY_TOOLS = new Set(['run', 'browser_check']);

const CLAIM_SHIPPED = new RegExp(
  `\\bi(?:'ve|\\s+have)\\s+(?:${HC_ADVERB}\\s+|also\\s+|successfully\\s+){0,2}(?:deployed|pushed|committed|published)\\b` +
  `|\\bsuccessfully\\s+(?:deployed|pushed|committed|published)\\b` +
  `|\\b(?:is|are)\\s+now\\s+live\\s+(?:at|on)\\b`,
  'i',
);
const SHIP_TOOLS = new Set(['run', 'vercel_deploy', 'vercel_api', 'github_create_repo', 'supabase_api']);

const unbackedClaimCorrection = (what) =>
  `[system] Your last reply says you ${what}, but no tool that could have done that ran successfully this turn. ` +
  'Never report an action or a result you did not actually get from a tool. Either do it now with a real action block ' +
  '(for checks: <codeply:run> a test/build/syntax command, or <codeply:browser_check> the page), or rewrite your summary ' +
  'so it only states what you truly did and says plainly what you did not verify.';

// A file-changing turn is not finished until it's been checked. When the model
// tries to wrap up after editing code or pages without running anything
// against them since the last edit, it gets sent back once to verify.
const VERIFIABLE_EXT = /\.(html?|css|scss|less|jsx?|tsx?|mjs|cjs|vue|svelte|py|go|rs|rb|php|java|kt|cs|c|cc|cpp|h|hpp|swift|json|ya?ml|toml|sql|sh)$/i;
const verifyBeforeDoneCorrection = (files) =>
  `[system] Before you finish: you changed ${files.join(', ')} but haven't checked the result since your last edit. ` +
  'Verify it now - run a syntax check, the relevant test/lint/build script, or start the app; for a page, browser_check it ' +
  'and look at the screenshot. Fix anything that fails and check again. If there is genuinely nothing you can run for this ' +
  'change, say so explicitly in your final summary instead of implying it was tested.';

const failedCommandCorrection = (cmd, code) =>
  `[system] The last command you ran (\`${cmd}\`) exited with code ${code}, so it failed. Do not describe the work as ` +
  'working or complete while that is unresolved. Read the error output, fix the cause and run it again - or, if the ' +
  'failure is unrelated to this task or can\'t be fixed here, say that plainly in your summary.';

// In Build mode, pasting a large code block into chat instead of writing it to
// a file usually means the user's requested change never happened.
const CODE_INSTEAD_OF_EDIT_CORRECTION =
  '[system] You put a large code block in your reply but did not write any file this turn. If the user asked for a ' +
  'change to their project, apply it with write_file or edit_file instead of pasting code into chat. If they only ' +
  'wanted to see code (an explanation or a snippet to copy), you may finish as is.';

const MAX_HALLUCINATION_RETRIES = 3;
const MAX_VERIFY_NUDGES = 2;

// Look-around blocks that may share one reply (see the loop).
const BATCHABLE_TOOLS = new Set(['read_file', 'list_dir', 'search', 'web_fetch', 'web_search', 'lsp']);
const MAX_BATCH = 4;

// Identical call, identical arguments, this many times in a row = stuck.
const STUCK_REPEATS = 3;

function stuckCorrection(name, last) {
  const failed = last && !last.ok;
  const head = `[system] That is the same ${name} call ${STUCK_REPEATS} times in a row${failed ? ', and it failed every time' : ''}. ` +
    'It was not run again, because the same input gives the same result. Change your approach instead of repeating it:';
  const ways = {
    run: [
      'Read the error output of the last attempt word by word and fix what it actually names.',
      'If a command or package is missing, check with `where <cmd>` (Windows) or `command -v <cmd>`, then install it or use one that exists.',
      'Try a different way to reach the same goal: another tool, a script file instead of a long one-liner, or a smaller step first.',
      'Check you are in the right folder and the paths in the command exist (list_dir).',
    ],
    edit_file: [
      'read_file the exact region you are editing and copy the search text from that result.',
      'Make the search block smaller: 2-5 distinctive lines are enough.',
      'If the change is large, write_file the whole file instead.',
    ],
  }[name] || [
    'Use what that call already returned, or try a different tool or different arguments.',
    'If you are blocked, say plainly what is blocking you instead of retrying.',
  ];
  return `${head}\n${ways.map((w) => `- ${w}`).join('\n')}`;
}

// A reply with no action block that ends by announcing the next action ("Let
// me now update the header.") is not a final answer: the model meant to act
// and forgot the block. Seen from Hermes Agent's stall nudges (MIT, Nous
// Research). Questions to the user are excluded; those are real stops.
const ANNOUNCED_INTENT = /(?:^|[.!\n]\s*)(?:(?:ok(?:ay)?|now|next|so|great|alright|first|then),?\s+)*(?:let me|let's|i'll|i will|i'm going to|i am going to|i need to|now i(?:'ll| will)?)\s+(?:now\s+|also\s+|first\s+|go ahead and\s+)?(?:check|read|look|open|update|edit|fix|add|create|write|run|test|verify|search|find|install|implement|change|remove|apply|make|build|start|try|inspect|review|examine)\b[^?]{0,200}[.:!]?\s*$/i;
const STALL_CORRECTION =
  '[system] Your reply announces what you are about to do but has no action block, so nothing ran and the task is ' +
  'not done. Write that action block now. If you are actually finished, give the final summary instead; if you ' +
  'need the user, ask them a direct question.';
const MAX_STALL_NUDGES = 2;

// Same tool failing again and again with DIFFERENT arguments is the other
// kind of stuck (the identical-call guard above doesn't see it). Warn, with
// ways around it, instead of letting it spiral. Threshold idea from Hermes
// Agent's tool_guardrails (MIT, Nous Research).
const FAILURE_STREAK_WARN = 3;
const failureStreakNote = (name, n) =>
  `[system] ${name} has failed ${n} times in a row this turn. This looks like a loop. Stop and diagnose before the ` +
  'next attempt: what exactly did the last error say, and what assumption does it break? ' +
  (name === 'run'
    ? 'Check where you are and what exists (list_dir, or `cd` / `dir` / `ls`), try an absolute path, a simpler command, or a different tool for the same goal.'
    : name === 'edit_file'
      ? 'read_file the exact region first, or write_file the whole file if the edit is large.'
      : 'Try a different tool or a genuinely different approach.') +
  ' If nothing works, say plainly what is blocking you.';

// A,B,A,B (or A,B,C,A,B,C) with nothing changing in between: going in circles.
function findCycle(keys) {
  for (const period of [2, 3]) {
    if (keys.length < period * 2) continue;
    const tail = keys.slice(-period * 2);
    const a = tail.slice(0, period), b = tail.slice(period);
    if (a.every((k, i) => k === b[i]) && new Set(a).size > 1) return period;
  }
  return 0;
}
const cycleNote = (period) =>
  `[system] Your last ${period * 2} actions repeat the same ${period}-step pattern with the same inputs, and none of ` +
  'them changed anything. You are going in circles. Use what those results already told you and do something different.';

// Late in the step budget, one checkpoint so a long task wraps up properly
// instead of being cut off mid-edit. Idea from Hermes Agent / opencode.
const budgetCheckpointNote = (used, max) =>
  `[system] You have used ${used} of ${max} steps for this turn. Finish the change you are in the middle of, check it, ` +
  'and wrap up with your summary. If the whole task cannot fit, get the current part to a working state and list what is left.';

const FINAL_SUMMARY_PROMPT =
  '[system] The step budget for this turn is used up, so actions are switched off: do not write any action block, it ' +
  'would be ignored. Reply with a short summary for the user: what you actually changed (only files a tool result ' +
  'confirms), what you checked and the result, and what is left to do. Do not claim anything the tool results do not show.';

// ─── Protocol ───────────────────────────────────────────────────────────────

const TOOL_TAG = /<codeply:([a-z_]+)>([\s\S]*?)<\/codeply:\1>/g;

// Params whose value is a raw payload (file content, code blocks) and may
// legitimately contain angle-bracket tags of its own.
const CONTAINER_PARAMS = new Set(['content', 'search', 'replace', 'body', 'text', 'patch']);

/** Tag payloads are written on their own lines; drop only that framing. */
function trimFraming(value) {
  return value.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

/**
 * Pull the parameters out of a tool block.
 *
 * Container params are read first-open to last-close, so writing an HTML file
 * that itself contains `</content>` does not truncate the payload. Their spans
 * are then masked out before the scalar params are matched - otherwise a
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
  todo: ['items'],
  ask_user: ['question', 'options'],
  mcp: ['server', 'tool', 'args'],
  list_dir: ['path'],
  read_file: ['path', 'offset', 'limit'],
  write_file: ['path', 'content'],
  edit_file: ['path', 'search', 'replace', 'all'],
  search: ['pattern', 'glob', 'path', 'context', 'files_only'],
  run: ['command'],
  use_skill: ['name'],
  list_skills: ['query'],
  fetch_image: ['url', 'path'],
  browser_check: ['url', 'wait', 'viewport'],
  gmail_send: ['to', 'subject', 'body'],
  gmail_search: ['query'],
  slack_post_message: ['channel', 'text'],
  vercel_deploy: ['path'],
  supabase_create_project: ['name'],
  supabase_delete_project: ['name', 'ref'],
  github_create_repo: ['path', 'name'],
  design_reference_search: ['term', 'category'],
  view_images: ['urls'],
  supabase_api: ['method', 'path', 'body'],
  supabase_sql: ['ref', 'query'],
  vercel_api: ['method', 'path', 'body'],
  web_fetch: ['url', 'format'],
  web_search: ['query', 'num'],
  apply_patch: ['patch'],
  plan_exit: ['path'],
  plan_enter: ['reason'],
  lsp: ['operation', 'path', 'line', 'character', 'symbol', 'query'],
};

// Names the model actually reaches for when it paraphrases the format.
// Deliberately excludes `search`, `replace`, `content`, `path` and `command`:
// those are parameter names, and treating them as action names would misread
// an edit_file block as a search.
const NAME_ALIASES = {
  ask_user: 'ask_user', askuser: 'ask_user', ask: 'ask_user', question: 'ask_user', askquestion: 'ask_user',
  todo: 'todo', todos: 'todo', todowrite: 'todo', todo_write: 'todo', tasklist: 'todo', task_list: 'todo',
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
  supabase_api: 'supabase_api', supabaseapi: 'supabase_api',
  supabase_sql: 'supabase_sql', supabasesql: 'supabase_sql', sql: 'supabase_sql', runsql: 'supabase_sql',
  vercel_api: 'vercel_api', vercelapi: 'vercel_api',
  web_fetch: 'web_fetch', webfetch: 'web_fetch', fetchurl: 'web_fetch', fetch_url: 'web_fetch', fetchpage: 'web_fetch', openurl: 'web_fetch', readurl: 'web_fetch',
  web_search: 'web_search', websearch: 'web_search', searchweb: 'web_search', search_web: 'web_search', googlesearch: 'web_search',
  apply_patch: 'apply_patch', applypatch: 'apply_patch', patch: 'apply_patch',
  plan_exit: 'plan_exit', planexit: 'plan_exit', exitplan: 'plan_exit', exit_plan: 'plan_exit',
  plan_enter: 'plan_enter', planenter: 'plan_enter', enterplan: 'plan_enter', enter_plan: 'plan_enter',
  lsp: 'lsp', codenav: 'lsp', gotodefinition: 'lsp', findreferences: 'lsp', go_to_definition: 'lsp', find_references: 'lsp',
};

// Any tag whose name resolves to an action, with or without the codeply: prefix.
const LOOSE_NAME_TAG = new RegExp(
  `</?\\s*(?:codeply[:_-])?(${Object.keys(NAME_ALIASES).join('|')})\\s*/?>`, 'i'
);

// Does this reply look like it was *trying* to act, even though nothing parsed?
// The `<\|?` (not just `<\/?`) matters: some models - Gemma via OpenRouter in
// particular - reach for their own native tool-call channel and it leaks out
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
 * "you ran out of room, write less at once" - the thing that actually fixes it.
 */
function looksTruncated(text) {
  return /<codeply:([a-z_]+)>(?![\s\S]*<\/codeply:\1>)/i.test(text);
}

/**
 * Best-effort recovery when the strict protocol did not match.
 *
 * gpt-oss-120b paraphrases the format - inventing a <toolcall> wrapper,
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
  else if (has('items')) name = 'todo';
  else if (has('question') && has('options')) name = 'ask_user';
  else if (has('server') && has('tool')) name = 'mcp';
  else if (has('to') && has('subject')) name = 'gmail_send';
  else if (has('channel') && has('text')) name = 'slack_post_message';
  else {
    const m = text.match(LOOSE_NAME_TAG);
    if (m) name = NAME_ALIASES[m[1].toLowerCase().replace(/[_-]/g, '')] ?? NAME_ALIASES[m[1].toLowerCase()];
    if (!name && has('command')) name = 'run';
    else if (!name && has('pattern')) name = 'search';
    // fetch_image and browser_check both take <url> now - <wait> only appears on browser_check.
    else if (!name && has('url') && has('wait')) name = 'browser_check';
    else if (!name && has('urls')) name = 'view_images'; // <urls> (plural) only appears on view_images
    else if (!name && has('url')) name = 'fetch_image';
    else if (!name && has('ref') && has('query')) name = 'supabase_sql';
    else if (!name && has('path')) name = 'read_file';
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
 * literal text here - same root cause as the Harmony `<|tool_call>` leak
 * above (a different model reaching for its own trained tool-call format
 * because the proxy declares no tools), just a different shape:
 *   <tool_call>read_file<arg_key>path</arg_key><arg_value>drop.html</arg_value></tool_call>
 * The previous approach - reject it and ask for the real tags via
 * FORMAT_CORRECTION - turned out not to work on this model: it kept writing
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
    // `end` is where this block closes in the reply, so the loop can cut the
    // stored reply right after the last block it actually runs.
    const end = m.index + m[0].length;
    if (!spec) { calls.push({ name, args: {}, unknown: true, end }); continue; }
    const args = extractParams(block, spec);
    // Single-param actions tolerate a bare body: <codeply:read_file>x.js</...>
    if (spec.length && Object.keys(args).length === 0 && block.trim()) {
      args[spec[0]] = block.trim();
    }
    calls.push({ name, args, end });
  }

  if (calls.length > 0) {
    // Whatever follows the last block was written before any result came
    // back: at best a restated plan, at worst an invented outcome ("done, the
    // tests pass"). It is never shown and never kept.
    const trailing = text.slice(lastIndex).trim();
    return { prose: prose.trim(), calls, recovered: false, malformed: false, truncated: false, trailing };
  }
  prose += text.slice(lastIndex);

  const poolside = parsePoolsideCalls(text);
  if (poolside.calls.length > 0) {
    return { prose: poolside.prose.trim(), calls: poolside.calls, recovered: false, malformed: false, truncated: false };
  }

  const truncated = looksTruncated(text);

  // Don't let the salvage path guess at a call built from a truncated block -
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

function gitOutput(cwd, cmd) {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  } catch { return ''; }
}

// Instruction files the user keeps for agents. The nearest project-level file
// wins (walking up from cwd, stopping at the git root), so a repo with both an
// AGENTS.md and a parent folder's AGENTS.md doesn't get both stacked in. The
// user-wide one in ~/.codeply is always added on top. Same lookup order idea
// as opencode's session/instruction.ts.
const INSTRUCTION_FILES = ['CODEPLY.md', 'AGENTS.md', 'CLAUDE.md'];
const MAX_INSTRUCTION_CHARS = 8000;

function readCapped(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return '';
    return text.length > MAX_INSTRUCTION_CHARS
      ? `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n[… truncated, read ${file} for the rest]`
      : text;
  } catch { return ''; }
}

export function findInstructionFiles(cwd) {
  const found = [];
  const root = gitOutput(cwd, 'git rev-parse --show-toplevel');
  const stopAt = root ? path.resolve(root) : path.parse(cwd).root;
  let dir = path.resolve(cwd);
  outer: while (true) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) { found.push(file); break outer; }
    }
    if (dir === stopAt || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  const globalFile = path.join(os.homedir(), '.codeply', 'AGENTS.md');
  if (fs.existsSync(globalFile)) found.push(globalFile);
  return found;
}

function instructionsSection(cwd) {
  const blocks = findInstructionFiles(cwd)
    .map((file) => ({ file, text: readCapped(file) }))
    .filter((b) => b.text)
    .map((b) => `Instructions from: ${b.file}\n${b.text}`);
  for (const b of plugins.instructionBlocks(cwd)) blocks.push(`Instructions from plugin ${b.plugin}:\n${b.text}`);
  if (!blocks.length) return '';
  return `PROJECT INSTRUCTIONS\nThe user wrote these for agents working here. Follow them; they override your defaults.\n\n${blocks.join('\n\n')}`;
}

/** A compact snapshot of the project, so the agent starts oriented. */
export function buildProjectContext(cwd) {
  const lines = [`Working directory: ${cwd}`, `Platform: ${process.platform}`, `Date: ${new Date().toISOString().slice(0, 10)}`];
  // What `run` really executes under, so the model writes commands for that
  // shell instead of assuming bash.
  lines.push(process.platform === 'win32'
    ? 'Shell for run: cmd.exe (chain with &&; no heredocs, no $(...); for PowerShell use powershell -NoProfile -Command "..."; for multi-line content use write_file)'
    : `Shell for run: ${process.env.SHELL ? path.basename(process.env.SHELL) : 'sh'}`);

  const branch = gitBranch(cwd);
  if (branch) {
    lines.push(`Git branch: ${branch}`);
    // Uncommitted changes are usually what the user is in the middle of, and
    // recent commits say what just happened - both cheap and often the fastest
    // way to know where to look.
    const status = gitOutput(cwd, 'git status --short').split('\n').filter(Boolean);
    if (status.length) {
      lines.push(`Uncommitted changes (${status.length}):`, ...status.slice(0, 25));
      if (status.length > 25) lines.push(`… and ${status.length - 25} more`);
    } else {
      lines.push('Working tree clean.');
    }
    const log = gitOutput(cwd, 'git log --oneline -5');
    if (log) lines.push('Recent commits:', log);
  }

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
// training has a dedicated channel for function calls - phrasing this as tool
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

<codeply:todo>
<items>
[x] read index.html and styles.css
[>] add the pricing section
[ ] check it on desktop and mobile
</items>
</codeply:todo>

(todo: your checklist for a task with 3+ steps. Send the WHOLE list every time,
one item per line: [ ] pending, [>] in progress (only one), [x] done, [-] dropped.
Mark an item [x] only after a tool result confirmed it, never because you meant
to do it. If something failed, mark it [-] and add a revised item.)

<codeply:ask_user>
<question>Which database should the app use?</question>
<options>
SQLite file (Recommended)
Supabase
Plain JSON file
</options>
</codeply:ask_user>

(ask_user: only for a real decision the user must make and you can't infer:
the user taps an option or types their own answer. Up to 5 short options,
recommended first. Never for things you can find out by reading the project.)

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
<context>3</context>
</codeply:search>

(search options: <context> 0-5 shows that many lines around each hit, often
enough to edit from without a separate read_file. <files_only>true</files_only>
lists just the matching files and hit counts. Leave out <pattern> and give only
<glob>, like <glob>*.test.js</glob>, to find files by name.)

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

(edit_file option: <all>true</all> replaces EVERY exact occurrence of the
search text, for a rename across one file. Without it the search text must
match exactly one place.)

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
<viewport>mobile</viewport>
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

<codeply:supabase_api>
<method>GET</method>
<path>/v1/projects</path>
</codeply:supabase_api>

<codeply:supabase_sql>
<ref>abcdefghijklmnopqrst</ref>
<query>
create table if not exists todos (id bigint generated always as identity primary key, title text not null, done boolean default false);
</query>
</codeply:supabase_sql>

<codeply:vercel_api>
<method>GET</method>
<path>/v9/projects</path>
</codeply:vercel_api>

<codeply:design_reference_search>
<term>to-do list</term>
<category>productivity</category>
</codeply:design_reference_search>

<codeply:view_images>
<urls>https://example.com/screenshot1.jpg,https://example.com/screenshot2.jpg</urls>
</codeply:view_images>

<codeply:web_search>
<query>vite 6 breaking changes</query>
</codeply:web_search>

<codeply:web_fetch>
<url>https://vite.dev/guide/migration</url>
</codeply:web_fetch>

(web_search finds pages, web_fetch reads one as text. Use them for current docs,
error messages you do not recognise, or anything after your training. Search
first, then fetch the best result. Never invent a URL you did not get from a
search or the user.)

<codeply:lsp>
<operation>references</operation>
<path>src/api.ts</path>
<symbol>fetchUser</symbol>
</codeply:lsp>

(lsp: code navigation for TypeScript/JavaScript projects. operation is one of
definition, references, implementation, hover (type and docs), documentSymbol
(outline of a file), workspaceSymbol (give <query>). Point at a spot with <line>
(1-based) plus <symbol> (the name on that line) or <character>. Prefer it over
search when you need the real definition or every real use of a name, for
example before renaming or changing a function's signature.)

<codeply:apply_patch>
<patch>
*** Begin Patch
*** Update File: src/app.js
@@ function start()
 const port = 3000;
-app.listen(port);
+app.listen(port, () => console.log('up'));
*** Add File: src/config.js
+export const port = 3000;
*** Delete File: old.js
*** End Patch
</patch>
</codeply:apply_patch>

(apply_patch: several file changes in one call, approved once. Every change line
starts with " " (context), "-" (remove) or "+" (add). "@@ text" anchors a hunk
to a line. Use it when one change touches 2+ files or many spots; use edit_file
for one spot. Copy context and removed lines exactly from a read.)

<codeply:plan_exit>
<path>.codeply/plans/add-dark-mode.md</path>
</codeply:plan_exit>

(plan_exit: Plan mode only. After writing the plan file, call this to ask the user
whether to switch to Build mode and carry it out.)

RULES
- Write ONE action block per reply, then stop and wait for its result. The one
  exception is looking around: up to 4 read_file / list_dir / search blocks may
  go in the same reply, and they all run before you get the results back
  together. Anything that changes something (write_file, edit_file, run, ...)
  is always alone in its reply.
- Stop writing the moment your action block closes. You have not seen its
  result yet, so anything you write after it is a guess, and it is discarded
  unread. Never write "[tool result" yourself; results only come from the program.
- Do not waste steps. Every action block costs the user several seconds, so never
  perform one whose answer you already have:
  · If the user gave a full path, read it directly - do not list_dir first.
  · After a successful edit_file or write_file, do NOT read the file back. The
    result already confirms it applied. Only re-read a part you have not seen.
  · Do not re-read a file that is already earlier in this conversation.
- When the result comes back, keep going on your own. Do not ask the user what to do next while you still have obvious work left.
- If an action fails, do not apologize or re-explain what you were trying to do - that wastes a whole reply and fixes nothing. Look at the actual error, and on your very next reply either fix the real cause or try something genuinely different. If the same action has now failed more than once for the same reason, that reason is not going to change on a third identical attempt - stop and re-read the file, or the error, or rethink the approach instead of repeating it.
- WORKAROUNDS: when something fails because of the tool or the environment rather than your code (the shell chokes on a heredoc or quotes, a command is missing, a command line is too long, a port is taken, a path is wrong), do not repeat the same approach with small tweaks. Switch to a different way to reach the same goal: write the file with write_file instead of echo/heredoc, put a long or multi-line command in a script file and run that, use another command that does the same job, or install what is missing. Say in one short sentence what you are switching to and why, then do it.
- read_file before you edit_file. "search" must be copied verbatim from what you just read - never from memory, never with the line-number prefixes the reader adds.
- LONG FILES: do not read a big file top to bottom to find one spot. search for a
  distinctive name first (with <context>), then read_file just that region with
  <offset>/<limit> (offset is the 0-based line to start at), then edit_file it.
  If an edit_file fails, its error shows the closest matching lines with numbers:
  copy from those instead of re-reading the whole file.
- Before an action block write at most one short sentence (or nothing). Don't narrate plans, apologize, or restate what you just did; the user sees every action anyway. Save the explanation for your final answer.
- Keep "search" as narrow as the change actually is. When removing something, search should span exactly the thing being removed - not "from here to the end of the file" just because that was easy to copy. A wider span deletes whatever sits between your intended target and wherever you stopped, silently, even when it renders fine and reports no errors. If two things need removing and something unrelated sits between them, that is two edit_file calls, not one wide one.
- edit_file for changes to an existing file. write_file only for new files or a genuine full rewrite.
- Prefer run for anything you can check mechanically.
- run executes a real shell command on the user's own machine, in their own project directory, with their own git/gh credentials already configured - the exact same terminal they'd get typing it themselves. That includes git add, git commit, git push, gh pr create, npm install, or anything else. Never tell the user you don't have terminal or network access, or that you can't run a command - if it's a shell command, write a <codeply:run> action block and run it for real. Do not just describe what the command would do.
- If a task needs a CLI that turns out not to be installed, install it yourself with the platform's own package manager (winget on Windows, brew on macOS, apt/apt-get on Linux) via run before falling back to a manual workaround - do not immediately hand the user a "go do this in a browser" set of steps just because a binary is missing; installing it is itself a shell command. The one thing you genuinely cannot do unattended is an interactive auth step a CLI requires after installing (e.g. gh auth login opening a browser for a device code) - if the install succeeds but the tool then reports it isn't authenticated, that specific login step is the only part to ask the user for, not the whole task.
- Deploying to Vercel, creating a Supabase project, or creating a new GitHub repo and pushing to it are NOT CLI tasks here - do not install or shell out to the vercel CLI, the supabase CLI, or gh repo create for these. Use vercel_deploy, supabase_create_project, and github_create_repo instead: they call the connected account directly (once the user has connected it from Connect Apps), with no separate CLI login step and no "go create an empty repo on github.com first." If one reports its integration isn't connected, say so plainly and point the user to Connect Apps (account menu) - do not fall back to the CLI/manual route as a workaround, and do not install the vercel/supabase CLI to route around a missing connection.
- FULL SUPABASE ACCESS: when Supabase is connected (see CONNECTED SERVICES), supabase_api reaches the entire Supabase Management API (https://api.supabase.com, paths start with /v1/) - list projects (GET /v1/projects), read API keys (GET /v1/projects/{ref}/api-keys?reveal=true), manage auth config, storage buckets, edge functions, secrets, branches, and more. supabase_sql runs SQL directly against a project's Postgres database - create and alter tables, write RLS policies, seed data, inspect schemas (select from information_schema). Always look up the real project ref first (GET /v1/projects) instead of guessing it. Read requests run immediately; changes ask the user first. Enable RLS and add policies on any table that holds user data.
- FULL VERCEL ACCESS: when Vercel is connected, vercel_api reaches the entire Vercel REST API (https://api.vercel.com, paths start with a version like /v9/) - projects (GET /v9/projects), deployments and their status/logs (GET /v6/deployments, GET /v13/deployments/{id}, GET /v3/deployments/{id}/events), env vars (/v10/projects/{id}/env), domains (/v10/projects/{id}/domains). The team id is added for you. Use vercel_deploy to ship a folder, then vercel_api to confirm the deployment reached READY and to read its build logs if it failed - do not report a deployment as live until you've seen it succeed.
- Tool results are the only source of truth about what happened. A failed result (non-2xx status, non-zero exit code, "did not apply") means it did not happen - never describe it as done.
- Creating a remote repo, pushing code, enabling Pages, or deploying anything are exactly the kind of claim covered by "never report success you did not verify" above - and the easiest one to get wrong, because each step's own command can silently no-op or partially fail while a LATER step still appears to succeed. Concretely: run whoami equivalents (gh api user, gh auth status) to get the real signed-in username BEFORE building any URL with it - never guess a username from the OS account name, the folder name, or anything the user said earlier that could be stale; after gh repo create or git push, treat the command's own exit code and printed output as the only source of truth for whether it worked, not your prior turn's summary of what you intended to do - a command you ran two turns ago having succeeded is not evidence this turn's retry did too; and never hand the user a repository/deployment URL you have not just confirmed resolves (curl -I it, or read it back from the command's own output) - a plausible-looking URL built from a guessed username/slug is a fabrication even if the pattern is usually right.
- gmail_send and slack_post_message send a real email or a real Slack message the moment they run - there is no draft state, no "preview" mode. Only use them when the user actually asked for that email/message to go out, never speculatively, never as a way to "show" them what it would say. If gmail_search or a prior message makes clear Gmail/Slack isn't connected, say so plainly and stop - do not retry hoping it connects itself, and do not claim you sent something when the tool reported it wasn't connected.
- vercel_deploy, supabase_create_project, supabase_delete_project, and github_create_repo are the same category as gmail_send/slack_post_message above: real, immediate action the moment they run - a live production deployment, a newly provisioned cloud database with its own bill, a brand-new repository pushed with the user's code. Only use them when the user actually asked for that outcome, never speculatively "to check if it would work." If one reports its integration isn't connected, say so plainly and stop rather than retrying or working around it. supabase_delete_project is the sharpest of these - it permanently destroys a database with no undo - so only reach for it when the user has clearly asked to delete or remove a specific project, never as cleanup for something that merely looks unused.
- Every image in generated markup must be a local file, downloaded with fetch_image. NEVER write an <img> or CSS background-image pointing straight at loremflickr.com, picsum.photos, or any other live generator URL - those are redirect services that return a DIFFERENT random photo on every single request, so the page shows a different (sometimes completely unrelated) image on every reload, every redeploy, every visitor. Always fetch_image the URL to a real path under assets/ first, then reference that local path in the markup. If the user hasn't given you specific photos and the site needs placeholder imagery, fetch_image from https://loremflickr.com/<width>/<height>/<keyword1>,<keyword2> - it pulls a real tagged photo matching those keywords, no API key needed. Pick keywords that actually describe THAT section's subject (a tea shop's hero: 'tea,leaves' or 'matcha,ceremony', not generic filler) - never use a source that returns fully random, unrelated stock photos (e.g. picsum.photos) on a themed site; a beach or a crowd photo under a tea brand's "Our Heritage" section is worse than no image. If a downloaded placeholder turns out to be a broken/static-noise "no match" image or is visibly unrelated to its section once you look at the page, delete it and fetch_image again with more specific keywords - do not leave a wrong or corrupted image in place.
- If a SKILLS entry below is a clear match for the task, use_skill it before starting - its instructions take priority over your own default approach for that kind of work. Do not use_skill speculatively; only when a listed skill actually matches what you are about to do. A name under LIKELY RELEVANT TO THIS REQUEST, if that section is present, was matched against your actual request from the full library - treat it exactly the same way: use_skill it before starting unless it's obviously a false match, do not silently ignore it in favor of guessing your own approach.
- EXCEPTION - this one is not speculative: if the task is to build or restyle any page a human will look at in a browser (a landing page, a small-business site, a portfolio, a dashboard, any HTML/CSS/UI), use_skill 'premium-web-design' before writing markup, even if the brief sounds tiny or mundane ("a site for a tea shop"). A plain-sounding brief is not permission for a flat, default-Bootstrap-looking result - Codeply's bar is that every generated page reads as deliberately designed. Skip this only if the user explicitly asked for something minimal/utilitarian/no-frills.
- EXCEPTION - this one is MANDATORY, not speculative, and comes before you write any markup for that same kind of task (a page or app screen a human will look at): call design_reference_search on the core screen(s) the app needs (an onboarding flow, a checkout, a settings screen, a to-do list's main view - whatever the brief actually calls for) before designing it from memory. It is a local library (no external account, no login, no network dependency) so it is always available - do not skip this step, and do not substitute your own guess at what that kind of screen "usually" looks like. Real shipped apps solve layout/hierarchy/empty-state problems in ways worth matching, not just imitating the vibe of. Only if it reports the library itself is missing on this machine should you say that plainly to the user once and continue from your own judgment.
- CALLING design_reference_search IS NOT THE SAME AS USING IT. It returns a list of screenshot URLs - that is raw material, not a design brief, and the search result text alone tells you nothing about what those screens actually look like. fetch_image does NOT show you the image either - it only downloads it to disk, silently, no vision, so calling it on a reference screenshot accomplishes nothing here. Before you write markup, call view_images with 2-4 of the returned screenshot URLs (from different apps, not all from result #1) - that is the only tool that actually attaches the image for you to look at: the real layout structure, spacing, type scale, color choices, empty states, and component patterns those apps ship with. Build FROM specific things you saw in those images, not from a generic idea of what that kind of app "usually" looks like. If you searched but did not view_images any of the results, you did not reference real apps this turn - say that plainly in your summary ("I designed this from my own judgment, not a specific reference") rather than claiming you drew from real app patterns. This applies retroactively too: if the user later asks what reference you used, answer from what you actually did in this conversation (did you view_images any screenshots, and which apps), never from a guess or a vague assumption that you probably did - being wrong about your own prior actions is worse than admitting you skipped the step.
- design_reference_search searches a private library built ahead of time (914 real apps, 6,433 screenshots from official App Store listings, covering productivity/finance/shopping/social/travel/food_delivery/health_fitness/education/entertainment/real_estate). A category filter narrows results; term alone searches across all categories. Same fetch_image requirement applies - see the rule above.
- EXCEPTION - also not speculative, and it is the LAST thing you do before replying, not something you might get to: if you wrote or edited any HTML/CSS/JS/frontend file this turn, browser_check the actual page that changed (not just the file you touched - file:///<absolute path> for a static file, or http://localhost:<port> if the project needs a server, start one with run first if nothing is serving yet) BEFORE telling the user it's done. A page you have not opened is a page you do not know works. When it's available, the result includes an actual screenshot of the page as it just rendered, not only a text extraction - look at that image before judging the page correct; a layout that's visually broken, a section that's misaligned, or an image that rendered as a broken-icon placeholder won't always show up as a console error or missing text, so text-only reasoning is not enough. Read the report like a bug filed against you: an error names a file and often a line, and the screenshot shows you what a user would actually see - go fix whichever is wrong, then browser_check the same page again, and repeat until both the report and the screenshot come back clean. Do not call two checks "the same" or "different" from memory or assumption - judge each one from what that check actually returned. A fix in a shared file (a stylesheet, a component several pages import) can affect pages you did not start from - browser_check those too before you finish. Skip this only if browser_check reports itself unavailable (say so once, then continue from the source) or the task has no page to render (a CLI script, a backend-only route).
- Writing style: never use em dashes (the long dash character) in your replies. Use a comma, a period, or a plain hyphen instead.
- browser_check takes an optional <viewport>: desktop (default), tablet (768px), mobile (390px), or WIDTHxHEIGHT. After building or restyling a page, check it at desktop AND mobile. A NOT RESPONSIVE line means it scrolls sideways on phones: fix it (flexible widths, wrapping, media queries, a viewport meta tag) and check mobile again.
- If the user asks for a screenshot, or to see / show them a page, browser_check that page: the screenshot it takes is sent to the user in this chat automatically (on their PC and their phone). Say in one line that the screenshot is above; never claim a screenshot you didn't take.
- You are one agent and you do all of the work yourself, one step at a time. There is no one to delegate to and no background worker - never say you've handed something off.
- The SKILLS list below is a subset. If the task is a specific kind of specialized work (a particular framework, a particular deliverable type) that doesn't clearly match anything listed, try list_skills with a one- or two-word query before assuming there's no skill for it - there are 281 in total, not just the ones shown.
- STACK CHOICE - when the user asks you to build a new app/tool/site from scratch and does not say what to build it with (no "in React", "as an Electron app", "using Vite", etc.), do not silently default to a multi-file React project or an Electron shell - those add a build step, a node_modules install, and a packaging story the user did not ask for. Instead, ask one short question (with ask_user when it is available, otherwise as prose with no action block): whether they want a single self-contained HTML file (open it straight in a browser, nothing to install) or a specific framework/Electron/React setup instead, and briefly say why a single file is the lighter default. Wait for their answer before writing any code. Skip this ask only when the user already named a stack, is clearly extending/matching an existing project's stack (react/electron files already in the folder), or explicitly said to just decide for them.
- When the task is finished, reply with prose only and NO action block. That ends your turn. End with a short, plain-English close: what you actually changed (only files you really wrote or edited), how you verified it (only checks you really ran, and their result), and anything left undone or unverified. Never list a file, a check, or a result that doesn't appear in a tool result from this conversation.`;

const VERIFY_RULES = `VERIFYING YOUR WORK
You are not done when the code is written. You are done when it is checked.
- After editing JS/TS, run a syntax check (e.g. node --check <file>).
- If the project has a test/lint/build script, run the relevant one.
- After editing any HTML/CSS/frontend file, browser_check the page it changed. This is not optional when the capability is available - console errors, broken images, and a blank render are exactly as real a failure as a failing test, and reading source code does not catch them; only opening the page does. When the check returns a screenshot, actually look at it - that is the real verification, not the text report around it. Never guess or assume what the page looks like from having generated the markup; judge it from what you were just shown.
- If a command fails, read the error, fix the cause, and run it again. Repeat until it passes or you have a specific reason it cannot.
- Never report success for something you did not verify. If you could not verify it, say exactly that.`;

const MODE_PROMPT = {
  Build: `You are Codeply, an autonomous coding agent working in the user's terminal.

Do the work the user asked for, end to end. Explore the project before assuming anything about it - read the actual files, do not guess at their contents or invent APIs. Make the change, then verify it.

${VERIFY_RULES}

LARGE REWRITES
One enormous reply can exceed the service's limits and fail outright. For a big
redesign or a file over ~200 lines, work in stages instead: write_file once with
the full structure and the main sections, then use edit_file to flesh out or
restyle one section per step. Each reply stays a manageable size and you keep a
working file at every point.

Keep prose short. A sentence about what you are about to do, then the action block. At the end, a two or three line summary of what changed. No filler, no restating the request back.`,

  Plan: `You are Codeply, working in Plan mode in the user's terminal.

Investigate and produce a concrete plan. You MAY read, list, search, fetch web pages, and run read-only commands to ground the plan in what is actually there. You MUST NOT change the project: the only file you may write is your plan, under .codeply/plans/.

Workflow:
1. Explore first. If a real decision is the user's to make, ask_user before planning around a guess.
2. Write the plan to .codeply/plans/<short-slug>.md with write_file (a new file each time, a short kebab-case slug). Start with a one-line goal, then what you found (the specific files and functions involved), then numbered steps with concrete paths and names, then how it will be verified. Flag anything genuinely ambiguous instead of picking silently.
3. Call plan_exit with that path. The user is asked whether to switch to Build mode. If they say yes you become the builder and carry the plan out; if they say no, keep refining the plan with them.
4. Your final message summarises the plan in a few lines and names the plan file.`,

  Ask: `You are Codeply, working in Ask mode in the user's terminal.

Answer the user's question. Read files, search, and list to ground your answer in this specific codebase rather than in generalities. Do not write or edit files in this mode.

Be concise and concrete. Quote the relevant code and cite it as path:line. If the answer is not in the codebase, say so plainly rather than inventing one.`,
};

const READ_ONLY_MODES = new Set(['Plan', 'Ask']);

/** Files an apply_patch text adds, updates or moves to (for gates that run before the tool does). */
function patchTargets(text) {
  return [...String(text || '').matchAll(/^\*\*\* (?:Add File|Update File|Move to):\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

/**
 * Skills add capability without adding weight proportional to the whole
 * library: only a curated subset's name + capped description goes in here -
 * see lib/skills.js for why the bundled set (281 skills, ~3.4MB) can't be
 * injected in full on every request without the skill library itself becoming
 * the majority of the token cost. The rest is one list_skills query away.
 */
function buildSkillIndex(userMessage, cwd) {
  const all = skills.listSkills(cwd);
  const daily = skills.formatSkillIndex(all);
  if (!daily) return null;
  const rest = all.length - all.filter((s) => s.daily).length;
  let out = `SKILLS\nOptional playbooks for specific kinds of work. Load one with use_skill ` +
    `when its description clearly matches the current task. This is a subset - ` +
    `${rest} more exist; search them with list_skills if nothing here fits:\n${daily}`;

  // Computed fresh from the actual request, not a fixed list - this is what
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

/**
 * Which external accounts are connected right now, so the agent knows what it
 * can actually reach instead of guessing (or claiming access it doesn't have).
 */
function connectedServicesSection() {
  const lines = [];
  const describe = (name, label, detail) => {
    let connected = false;
    try { connected = config.isIntegrationConnected(name); } catch {}
    lines.push(`- ${label}: ${connected ? `connected${detail ? ` (${detail})` : ''}` : 'not connected'}`);
  };
  let vercelUser = '', githubUser = '', gmailUser = '';
  try { vercelUser = config.getIntegration('vercel').userName; } catch {}
  try { githubUser = config.getIntegration('github').userName; } catch {}
  try { gmailUser = config.getIntegration('gmail').email; } catch {}
  describe('supabase', 'Supabase', 'full Management API via supabase_api, SQL via supabase_sql');
  describe('vercel', 'Vercel', [vercelUser, 'full REST API via vercel_api'].filter(Boolean).join(' - '));
  describe('github', 'GitHub', githubUser);
  describe('gmail', 'Gmail', gmailUser);
  describe('slack', 'Slack', '');
  return `CONNECTED SERVICES\n${lines.join('\n')}\nA service marked "not connected" cannot be used - tell the user to connect it from Connect Apps rather than attempting it.`;
}

const ROLE_INTRO = (role) =>
  `CURRENT ROLE: ${role.tagline}\nYou are still Codeply - the single agent doing all of this work yourself. For this task you are working in the ${role.tagline} role; the guide below is the standard to hold your work to. It is a way of working, not a separate agent: never mention handing off or delegating.`;

/**
 * @param {string} mode        Build | Plan | Ask
 * @param {string} cwd
 * @param {string} userMessage used to pick relevant skills
 * @param {object} [opts]
 * @param {string} [opts.roleId]  a role from lib/subagents.js (frontend, backend, ...) to take on this turn
 * @param {string} [opts.goal]    the overall objective when running under /goal
 */
const MAX_MCP_TOOLS_LISTED = 80;

/** Which MCP servers are connected and what their tools do. */
function mcpServersSection(list, native) {
  if (!Array.isArray(list) || !list.length) return '';
  const lines = [];
  let shown = 0;
  for (const s of list) {
    if (s.error) { lines.push(`- ${s.name}: NOT CONNECTED (${s.error.slice(0, 160)})`); continue; }
    lines.push(`- ${s.name}${s.instructions ? ` - ${s.instructions.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
    for (const t of s.tools) {
      if (shown++ >= MAX_MCP_TOOLS_LISTED) break;
      const params = Object.keys(t.inputSchema?.properties || {});
      lines.push(`    ${t.name}(${params.join(', ')}): ${String(t.description || '').replace(/\s+/g, ' ').slice(0, 150)}`);
    }
  }
  const how = native
    ? 'Each tool above is also available to you directly as mcp__<server>__<tool>.'
    : 'Call one with <codeply:mcp> <server>name</server> <tool>tool</tool> <args>{"param": "value"}</args> </codeply:mcp> (args is a JSON object).';
  return `MCP SERVERS\nTools from the user's connected MCP servers. ${how}\n${lines.join('\n')}`;
}

export function buildSystemPrompt(mode, cwd, userMessage, opts = {}) {
  const parts = [MODE_PROMPT[mode] || MODE_PROMPT.Build];
  // The role guide goes right after the base framing and before the tool
  // reference, so it colors how every tool gets used.
  const role = opts.roleId ? rolesLib.getSubagent(opts.roleId) : null;
  if (role) parts.push('', ROLE_INTRO(role), role.persona);
  if (opts.goal) {
    parts.push('', `GOAL MODE\nYou are working autonomously toward this goal until it is fully achieved:\n"${opts.goal}"\n` +
      'Keep going without asking the user questions - make sensible, conventional decisions yourself and note them in your summary. ' +
      'Only stop to ask if you are truly blocked (missing credentials, an irreversible choice only the user can make).');
  }
  // Native mode swaps the tag examples for a short note; the tools themselves
  // arrive as function definitions. The RULES apply either way.
  parts.push('', opts.native ? `${NATIVE_FORMAT}\n\n${TOOL_REFERENCE.slice(TOOL_REFERENCE.indexOf('RULES\n'))}` : TOOL_REFERENCE);
  parts.push('', connectedServicesSection());
  if (mode === 'Plan') {
    parts.push('', 'MODE RESTRICTION: this is Plan mode. write_file and edit_file only work on plan files under .codeply/plans/ (*.md); everything else is disabled and returns an error. run is limited to read-only commands. Call plan_exit when the plan file is written.');
  } else if (READ_ONLY_MODES.has(mode)) {
    parts.push('', 'MODE RESTRICTION: write_file and edit_file are disabled. Using them returns an error. run is limited to read-only commands.');
  } else if (mode === 'Build') {
    parts.push('', 'PLANS: if the user points you at a plan file under .codeply/plans/, read it and carry it out step by step, keeping its checklist in todo. plan_enter switches to Plan mode; use it only when the user asks to plan first, or the request is large and ambiguous enough that building without a plan would be a gamble. It asks the user before switching.');
  }
  const skillIndex = buildSkillIndex(userMessage, cwd);
  if (skillIndex) parts.push('', skillIndex);
  const instructions = instructionsSection(cwd);
  if (instructions) parts.push('', instructions);
  const mcpSection = mcpServersSection(opts.mcp, opts.native);
  if (mcpSection) parts.push('', mcpSection);
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
// image - .length and .startsWith exist on arrays too, just meaning
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
// push above). Screenshots are large - a single one in base64 can outweigh
// the whole char budget on its own - so they must be just as trimmable as
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

function trimTranscript(messages, budget = CONTEXT_CHAR_BUDGET) {
  let total = messages.reduce((n, m) => n + contentLength(m.content), 0);
  if (total <= budget) return messages;

  const kept = [...messages];
  // index 0 is the system prompt; never touch the last 6 messages.
  for (let i = 1; i < kept.length - 6 && total > budget; i++) {
    if (kept[i].role === 'user' && isToolResult(kept[i].content)) {
      total -= contentLength(kept[i].content);
      const head = toolResultText(kept[i].content).slice(0, 200);
      kept[i] = { role: 'user', content: `${head}\n[… older tool output dropped to save context]` };
      total += contentLength(kept[i].content);
    }
  }
  return kept;
}

function transcriptLength(messages) {
  return messages.reduce((n, m) => n + contentLength(m.content), 0);
}

// ─── Compaction ─────────────────────────────────────────────────────────────
//
// Dropping old tool output (trimTranscript) is enough most of the time. When
// the transcript is STILL over budget after that, the middle of the turn is
// replaced by a structured summary written by the model itself, so the goal,
// decisions and file paths survive instead of just falling off the end.
// The summary template is adapted from opencode (packages/core/src/session/
// compaction.ts), MIT License, Copyright (c) 2025 opencode.

const KEEP_RECENT_MESSAGES = 6;
const SUMMARY_SOURCE_CHARS = 2000; // per message fed to the summarizer

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made, ONLY if a tool result below confirms it; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty. Terse bullets, not paragraphs.
- Preserve exact file paths, symbols, commands, error strings and identifiers.
- A change counts as Completed only if a [tool result] in the conversation shows it succeeded. Something the assistant only said it would do, or said it did without a matching result, goes under Active.
- Do not mention the summary process.`;

function summarySource(messages) {
  return messages.map((m) => {
    const text = typeof m.content === 'string' ? m.content : toolResultText(m.content);
    const cut = text.length > SUMMARY_SOURCE_CHARS ? `${text.slice(0, SUMMARY_SOURCE_CHARS)} [...]` : text;
    return `${m.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${cut}`;
  }).join('\n\n');
}

/**
 * Replace messages[1 .. length-KEEP_RECENT_MESSAGES) with one summary message,
 * in place. The system prompt, the user's request and the latest steps stay.
 * @returns {Promise<boolean>} whether anything was compacted
 */
/**
 * Used when the summarizer call fails or comes back empty: a plain summary
 * built from what the tools really did. Worse prose than the model's, but it
 * can never invent anything, and it still frees the room. (Hermes Agent does
 * the same, MIT, Nous Research.)
 */
function fallbackSummary(userMessage, actions) {
  const changed = [...new Set(actions.filter((a) => a.ok && /^(write_file|edit_file)$/.test(a.tool)).map((a) => a.label))];
  const failed = actions.filter((a) => !a.ok || (a.exitCode !== undefined && a.exitCode !== 0)).slice(-8);
  return [
    '## Objective', `- ${String(typeof userMessage === 'string' ? userMessage : '').slice(0, 400) || '(see request)'}`,
    '', '## Work State', '### Completed',
    ...(changed.length ? changed.map((f) => `- changed ${f}`) : ['- (none)']),
    '', '### Blocked',
    ...(failed.length ? failed.map((a) => `- ${a.tool} ${a.label} failed${a.exitCode !== undefined ? ` (exit ${a.exitCode})` : ''}`) : ['- (none)']),
    '', '## Steps so far', ...actions.slice(-25).map((a) => `- ${a.tool} ${a.label}${a.ok ? '' : ' (FAILED)'}`),
  ].join('\n');
}

async function compactTranscript(messages, userMessage, signal, route, { actions = [], todos = [] } = {}) {
  const start = 1;
  const end = messages.length - KEEP_RECENT_MESSAGES;
  if (end - start < 4) return false;
  const prompt = [
    'You are a context summarization agent. Produce a structured summary so another coding agent can continue this work. ' +
    'Do not continue the conversation or answer questions in it.',
    `The user's request for this turn:\n${typeof userMessage === 'string' ? userMessage : ''}`,
    `Here is the conversation so far:\n\n<conversation>\n${summarySource(messages.slice(start, end))}\n</conversation>`,
    SUMMARY_TEMPLATE,
  ].join('\n\n');
  let result = null;
  try { result = await ai.chat([{ role: 'user', content: prompt }], { signal, route }); } catch {}
  if (signal?.aborted) return false;
  let summary = result?.success ? String(result.data?.choices?.[0]?.message?.content || '').trim() : '';
  // Any action block in a summary would be read as a request later on.
  summary = summary.replace(/<\/?codeply:[a-z_]+>/gi, '');
  if (!summary) summary = fallbackSummary(userMessage, actions);
  const open = formatTodos(todos, { openOnly: true });
  messages.splice(start, end - start, {
    role: 'user',
    content: `[context summary] Reference only: earlier steps of this turn, summarized to save room. Their tool ` +
      'results are gone, so re-read a file if you need its exact content. Your actions all still work: keep going ' +
      'from "Next Move" with action blocks, and do not redo what is listed as completed.\n\n' + summary +
      (open ? `\n\n[Your open task list, kept across the summary]\n${open}` : ''),
  });
  return true;
}

/**
 * Once old tool output has been dropped, the model can no longer see what it
 * already did, which is exactly when it starts redoing steps or "remembering"
 * work that never happened. A compact record of this turn's real actions,
 * straight from the tool results, is sent along with every trimmed request.
 */
function actionLedger(actions, todos = []) {
  if (!actions.length) return null;
  const rows = actions.slice(-40).map((a, i) =>
    `${i + 1}. ${a.tool} ${a.label}${a.ok ? '' : ' (FAILED)'}${a.exitCode !== undefined ? ` exit ${a.exitCode}` : ''}`);
  const open = formatTodos(todos, { openOnly: true });
  return {
    role: 'user',
    content: `[system] Record of what actually ran so far this turn (older output was trimmed). ` +
      `This is the ground truth; anything not listed here did not happen:\n${rows.join('\n')}` +
      (open ? `\n\nOpen items on your task list:\n${open}` : ''),
  };
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
  'Write the action block as literal text in your message - the tags exactly as shown in the OUTPUT FORMAT section - and nothing else.';

// ─── Native tool calling: which models get it ──────────────────────────────
// Auto (the hosted model behind a proxy that declares no tools) stays on text
// actions. User-added models and the CLI's own providers use native calls
// unless their entry says toolMode: 'text', or CODEPLY_TOOLS=text is set.
// A model that rejects tools is remembered for the rest of the session.
const nativeUnsupported = new Set();
const MUTATING_ACTIONS = new Set(['write_file', 'edit_file', 'apply_patch', 'fetch_image', 'gmail_send', 'slack_post_message', 'vercel_deploy', 'supabase_create_project', 'supabase_delete_project', 'github_create_repo']);

/**
 * Native function names for MCP tools (mcp__server__tool, within the 64-char
 * [A-Za-z0-9_-] limit APIs enforce) and the maps between them and the
 * engine's single <codeply:mcp> action.
 */
function mcpNativeNames(list) {
  const schemas = [];
  const fromNative = {}; // native name -> { server, tool }
  const toNative = {};   // "server/tool" -> native name
  const clean = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
  for (const s of list || []) {
    if (s.error) continue;
    for (const t of s.tools) {
      let name = `mcp__${clean(s.name)}__${clean(t.name)}`.slice(0, 64);
      for (let n = 2; fromNative[name]; n++) name = `${name.slice(0, 60)}_${n}`;
      fromNative[name] = { server: s.name, tool: t.name };
      toNative[`${s.name}/${t.name}`] = name;
      const params = t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
      schemas.push({ type: 'function', function: { name, description: `[${s.name}] ${String(t.description || t.name).slice(0, 900)}`, parameters: params } });
    }
  }
  return { schemas, fromNative, toNative };
}

function routeKey(route) {
  if (route?.custom) return `custom:${route.custom.id || route.custom.model}`;
  if (route?.auto) return 'auto';
  try { const c = config.getConfig(); return `cli:${c.provider}:${c[c.provider]?.model || ''}`; } catch { return 'cli'; }
}

function wantsNativeTools(route) {
  if (process.env.CODEPLY_TOOLS === 'text') return false;
  if (route?.auto) return false;
  if (route?.custom) return route.custom.toolMode !== 'text';
  let c;
  try { c = config.getConfig(); } catch { return false; }
  return !!c && !!c.provider && c.provider !== 'codeply' && c.toolMode !== 'text';
}

async function callModel(messages, promptText, signal, route, tools = null, mcpToNative = null) {
  const meta = promptText ? { promptText } : undefined;
  if (tools) {
    // Native mode: same engine history, translated at the edge (native-tools.mjs).
    const result = await ai.chat(toNativeMessages(messages, parseReply, mcpToNative), { meta, signal, route, tools });
    return { result, messages };
  }
  let result = await ai.chat(messages, { meta, signal, route });
  if (result.success || !isNativeToolCallError(result.error)) return { result, messages };

  const corrected = [...messages, { role: 'user', content: NO_NATIVE_TOOLS_REMINDER }];
  result = await ai.chat(corrected, { meta, signal, route });
  return { result, messages: corrected };
}

/**
 * House style: no em dashes in anything the user reads. The prompt asks for
 * that too, but models slip, so prose is cleaned before it's shown. Fenced
 * code is left exactly as written.
 */
function withoutEmDashes(text) {
  return text.split(/(```[\s\S]*?```)/).map((part, i) => (i % 2 === 1 ? part
    : part.replace(/ \u2014 /g, ', ').replace(/\u2014/g, '-'))).join('');
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
 * @param {Function} [o.browser]    async (url, {wait}) => report - optional; only a host with a
 *                                  real browser (the Codeply Craft desktop app) provides this.
 *                                  Its absence (plain CLI) is what makes browser_check gracefully
 *                                  report itself unavailable rather than erroring the whole turn.
 * @param {object}   [o.route]      per-turn model route: {auto:true} for the hosted model, or
 *                                  {custom:<model entry>} for a user-added model (see ai.js chat()).
 *                                  Omitted = the stored CLI provider config.
 * @param {string[]} [o.images]     data: URLs of images pasted alongside this message - only sent
 *                                  on THIS turn (not replayed into history on later turns); silently
 *                                  ignored by any model/provider that doesn't accept vision input.
 * @param {AbortSignal} o.signal    a real AbortSignal - it is handed straight to fetch()
 *                                  in ai.js, which requires an actual instance, not a
 *                                  look-alike {aborted} object.
 * @param {string}   [o.roleId]     a role from lib/subagents.js (frontend, backend, security, ...)
 *                                  the agent takes on for this turn - its guide is injected into
 *                                  the system prompt. Unknown/omitted = no role guide.
 * @param {string}   [o.goal]       the overall objective when running under /goal.
 * @param {number}   [o.maxSteps]   step budget for this turn (default MAX_STEPS).
 * @param {boolean}  [o.verifyOnly] a checking turn (task verification pass, /goal check): its
 *                                  replies describe work done in EARLIER turns, so the
 *                                  "claims an edit it didn't make this turn" check is skipped.
 * @yields {{type:string, ...}} text | reasoning | tool_start | tool_end | done | error | aborted
 */
export async function* runAgent({ userMessage, history, mode, cwd, approve, browser, images, signal, route, roleId, goal, maxSteps, verifyOnly }) {
  let readOnly = READ_ONLY_MODES.has(mode);
  const stepBudget = Math.max(1, maxSteps || MAX_STEPS);
  // OpenAI-shaped content array only when there's actually an image to carry -
  // every ordinary turn keeps the plain string content every other code path
  // (trimTranscript, prompt caching, dedup keys) already assumes.
  const userContent = images && images.length
    ? [{ type: 'text', text: userMessage }, ...images.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } }))]
    : userMessage;
  // Native function calling when the model supports it (see native-tools.mjs).
  const nativeKey = routeKey(route);
  let native = wantsNativeTools(route) && !nativeUnsupported.has(nativeKey);
  // MCP servers the user configured for this project (connections are reused).
  let mcpList = [];
  if (Object.keys(mcpLib.loadServers(cwd)).length) {
    try { mcpList = await mcpLib.listServers(cwd); } catch {}
    const down = mcpList.filter((s) => s.error);
    if (down.length) yield { type: 'notice', level: 'warn', text: `MCP: couldn't connect to ${down.map((s) => s.name).join(', ')}. ${down[0].error.slice(0, 160)}` };
  }
  const mcpNames = mcpNativeNames(mcpList);
  // Plan mode keeps write_file/edit_file (only the plan file is writable, enforced
  // in tools.mjs); plan_exit exists only in Plan and plan_enter only in Build.
  const schemasFor = (m) => {
    const ro = READ_ONLY_MODES.has(m);
    const entries = Object.entries(PARAMS).filter(([n]) => {
      if (n === 'plan_exit') return m === 'Plan';
      if (n === 'plan_enter') return m === 'Build';
      if (ro && MUTATING_ACTIONS.has(n)) return m === 'Plan' && (n === 'write_file' || n === 'edit_file');
      return true;
    });
    return [...buildToolSchemas(Object.fromEntries(entries)), ...mcpNames.schemas];
  };
  let toolSchemas = schemasFor(mode);
  const messages = [
    { role: 'system', content: buildSystemPrompt(mode, cwd, userMessage, { roleId, goal, native, mcp: mcpList }) },
    ...history,
    { role: 'user', content: userContent },
  ];

  // fileState: path -> mtime when this turn last read/wrote it (see tools.mjs).
  const ctx = { cwd, approve, browser, signal, mode, route, fileState: new Map(), ask: typeof approve?.ask === 'function' ? approve.ask : null };
  const recentCallKeys = [];      // executed calls, in order, for the stuck-loop guard
  const lastResultFor = new Map(); // call key -> its most recent result
  const transcript = [{ role: 'user', content: userMessage }];
  let malformedRetries = 0;
  let truncatedRetries = 0;
  let hallucinationRetries = 0;
  let stallNudges = 0;
  let budgetWarned = false;
  const openProblems = new Map(); // file -> syntax problems from its latest write/edit
  const failuresByTool = new Map(); // tool -> consecutive failures (any args)
  // What really happened this turn, straight from tool results - the ground
  // truth every completion claim is checked against, and what the host shows
  // the user as the turn's actual changes.
  const actions = [];            // [{ tool, label, ok, exitCode }]
  const succeededTools = new Set();
  let unverifiedEdits = new Set();  // files changed since the last PASSING check (run exit 0 / browser_check)
  let uncheckedEdits = new Set();   // files changed since the last check ATTEMPT of any outcome
  let lastRun = null;            // { command, exitCode } of the most recent run
  let verifyNudges = 0;
  let codeBlockNudged = false;
  let madeAnyEdit = false; // true once a write_file/edit_file actually succeeds this turn - gates the check below
  const writtenBasenames = new Set(); // basenames of files actually write_file'd/edit_file'd this turn - feeds the overclaim check below

  // A prompt instruction alone ("call view_images before designing") was not
  // reliable enough - real runs showed the model calling
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
  //    call within one turn - same tool, same arguments - is a real, common
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
  const DEDUPABLE = new Set(['read_file', 'list_dir', 'search', 'use_skill', 'list_skills', 'web_fetch', 'web_search']);
  const servedCalls = new Map();     // callKey -> message index of its result
  const readIndexByPath = new Map(); // resolved path -> message index of its read_file result
  // Consecutive edit_file failures per path - a weak model that keeps
  // guessing at search text instead of re-reading will otherwise loop
  // through several apologetic retries in a row without ever converging.
  // Cleared the moment that path gets a real read_file or a successful edit.
  const failedEditsByPath = new Map();
  const MAX_EDIT_FAILURES_BEFORE_FORCE_READ = 2;
  // resolved path -> next unseen line offset, once a read_file call comes back
  // with more of the file left. A model re-requesting "the rest of this file"
  // doesn't reliably track and restate the right offset itself - left to that,
  // a long file often just gets re-shown from the top every time instead of
  // actually advancing. Consulted (and rewritten) right before a read_file
  // call executes, below; cleared once a path's edited, same as readIndexByPath.
  const readProgressByPath = new Map();

  // A model that keeps investigating without ever committing to an action -
  // reading file after file, re-checking things it already looked at, never
  // reaching write_file/edit_file/run - otherwise burns the whole MAX_STEPS
  // budget on research alone and fails with nothing to show for it (the
  // observed failure this guards against: several read_file calls in a row,
  // no edit, straight into "Stopped after 24 steps"). DEDUPABLE's own
  // "unchanged, reusing that result" nudge above only catches an EXACT
  // repeat of the same call; this also has to count a DEDUPED call's own
  // "step" toward the streak (it costs nothing extra, but still, correctly,
  // is a step spent with nothing new to show) or a model that keeps
  // blindly re-requesting the same thing would burn the whole loop that way
  // without ever tripping this guard. Any tool not in this set - including a
  // failed write/edit attempt, which is still a real attempt to act -
  // resets the streak; only read-only, no-side-effect calls extend it.
  const NON_PROGRESS_TOOLS = new Set(['read_file', 'list_dir', 'search', 'use_skill', 'list_skills', 'view_images', 'design_reference_search', 'browser_check', 'web_fetch', 'web_search', 'lsp']);
  const MAX_READ_ONLY_STREAK = 5;
  let readOnlyStreak = 0;
  function readOnlyStreakNote() {
    readOnlyStreak++;
    if (readOnlyStreak < MAX_READ_ONLY_STREAK) return '';
    readOnlyStreak = 0;
    return ` [system] That's ${MAX_READ_ONLY_STREAK} read-only calls in a row with nothing written or run. Stop investigating - either make the actual change now (write_file/edit_file) based on what you've already seen, or state plainly what's blocking you. Do not call another read-only tool this step.`;
  }

  const callKey = (name, args) => `${name}:${JSON.stringify(args)}`;

  for (let step = 0; step < stepBudget; step++) {
    if (signal.aborted) { yield { type: 'aborted' }; return; }

    const budget = contextBudgetFor(route);
    let outgoing = trimTranscript(messages, budget);
    if (transcriptLength(outgoing) > budget && await compactTranscript(messages, userMessage, signal, route, { actions, todos: ctx.todos || [] })) {
      // Message positions moved, so the index-based caches below point at the
      // wrong entries now. They are only shortcuts; starting them over is safe.
      servedCalls.clear();
      readIndexByPath.clear();
      yield { type: 'notice', level: 'info', text: 'Summarized earlier steps of this task to make room.' };
      outgoing = trimTranscript(messages, budget);
    }
    if (outgoing !== messages) {
      const ledger = actionLedger(actions, ctx.todos || []);
      if (ledger) outgoing = [...outgoing, ledger];
    }
    if (signal.aborted) { yield { type: 'aborted' }; return; }

    const stepStarted = Date.now();
    let attempt = await callModel(outgoing, userMessage, signal, route, native ? toolSchemas : null, mcpNames.toNative);
    // The model or its endpoint turned out not to do function calling: drop
    // to text actions for the rest of this turn (and remember it for later
    // turns), with the text-format system prompt.
    if (native && !attempt.result.success && !signal.aborted && TOOLS_UNSUPPORTED.test(String(attempt.result.error || ''))) {
      native = false;
      nativeUnsupported.add(nativeKey);
      messages[0] = { role: 'system', content: buildSystemPrompt(mode, cwd, userMessage, { roleId, goal, native: false, mcp: mcpList }) };
      outgoing = [messages[0], ...outgoing.slice(1)];
      yield { type: 'notice', level: 'info', text: 'This model does not support native tool calls, so Codeply switched to text actions.' };
      attempt = await callModel(outgoing, userMessage, signal, route);
    }
    const stepMs = Date.now() - stepStarted;
    // A real fetch abort (see the signal wiring in ai.js) lands here as a
    // failed result, not a thrown exception - check the abort flag itself
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
    if (attempt.messages !== outgoing) {
      messages.push(attempt.messages[attempt.messages.length - 1]);
    }

    // gpt-oss/Laguna put chain-of-thought in a separate field; content can be
    // null while it's populated. Surfaced as its own event - not appended to
    // `reply` and not shown inline - so the UI can offer it as an optional,
    // collapsed "thought for Xs" the user opens on demand instead of dumping
    // raw reasoning into the chat unconditionally.
    const reasoning = result.data?.choices?.[0]?.message?.reasoning || '';
    if (reasoning.trim()) {
      yield { type: 'reasoning', text: reasoning.trim(), ms: stepMs };
    }

    const replyMsg = result.data?.choices?.[0]?.message || {};
    let reply = replyMsg.content ?? '';
    if (Array.isArray(replyMsg.tool_calls) && replyMsg.tool_calls.length) {
      // Native calls become ordinary action blocks from here on.
      const conv = toolCallsToTags(reply, replyMsg.tool_calls, PARAMS, mcpNames.fromNative);
      reply = conv.text;
      if (conv.problems.length && !reply.includes('<codeply:')) {
        messages.push({ role: 'assistant', content: reply || '(tool call)' });
        messages.push({ role: 'user', content: `[system] Your tool call could not be run: ${conv.problems.join('; ')}. Call one of the provided tools with valid arguments.` });
        continue;
      }
    }
    if (!reply.trim()) {
      messages.push({
        role: 'user',
        content: '[system] Your last reply was empty. Either write one action block as text, or give your final answer.',
      });
      continue;
    }
    messages.push({ role: 'assistant', content: reply });

    const { prose, calls, recovered, malformed, truncated } = parseReply(reply);

    if (calls.length === 0) {
      // Protocol debris first: a truncated or malformed reply's raw text is
      // fumbled tag syntax, not an answer, and must never reach the user.
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

      // ── Claim audit ──────────────────────────────────────────────────────
      // A final answer is checked against what the tools actually did BEFORE
      // any of it is shown. Corrections are silent: the false claim never
      // reaches the screen, the model is sent back to either do the work or
      // restate only what's true.
      //
      // 1. Claims a file change. Two shapes: nothing was written this turn at
      //    all, or something was but the claim names more files than were
      //    actually touched ("I've created index.html, styles.css and app.js"
      //    after only index.html was written).
      //    Skipped for read-only and checking turns, whose answers legitimately
      //    describe changes made in earlier turns.
      if (!readOnly && !verifyOnly && HALLUCINATED_COMPLETION.test(prose)) {
        const overclaimed = madeAnyEdit
          ? extractClaimedFilenames(prose).filter((f) => !writtenBasenames.has(f))
          : [];
        if (!madeAnyEdit || overclaimed.length > 0) {
          if (hallucinationRetries < MAX_HALLUCINATION_RETRIES) {
            hallucinationRetries++;
            messages.push({ role: 'user', content: madeAnyEdit ? overclaimCorrection(overclaimed) : HALLUCINATED_ACTION_CORRECTION });
            continue;
          }
          // Out of retries (it may be describing an earlier turn's work):
          // let it through, flagged, rather than failing the whole run.
          yield { type: 'notice', level: 'warn', text: 'Heads up: this reply describes file changes that were not made in this turn. Check the "What actually happened" card for what really changed.' };
        }
      }

      // 2. Claims it ran/tested/verified something, or deployed/pushed it,
      //    with no tool that could have done so succeeding this turn.
      const claimedVerify = CLAIM_VERIFIED.test(prose) && ![...VERIFY_TOOLS].some((t) => succeededTools.has(t));
      const claimedShip = CLAIM_SHIPPED.test(prose) && ![...SHIP_TOOLS].some((t) => succeededTools.has(t));
      if (claimedVerify || claimedShip) {
        if (hallucinationRetries < MAX_HALLUCINATION_RETRIES) {
          hallucinationRetries++;
          messages.push({
            role: 'user',
            content: unbackedClaimCorrection(claimedShip ? 'deployed, pushed or published something' : 'ran, tested or verified something'),
          });
          continue;
        }
        // Out of retries: let the answer through, but never silently.
        yield { type: 'notice', level: 'warn', text: 'Heads up: this summary mentions checks or deployments that no tool actually performed this turn. Treat those claims as unverified.' };
      }

      // 3. Verification loop - changed code/pages must be checked before the
      //    turn can end (Build mode only; Plan/Ask never edit).
      if (!readOnly && verifyNudges < MAX_VERIFY_NUDGES) {
        // The last command failed and the answer doesn't own up to it.
        if (lastRun && lastRun.exitCode !== 0 && !/(fail|error|couldn'?t|could not|unable|not (?:pass|work)|broken|exit(?:ed)? (?:with )?code)/i.test(prose)) {
          verifyNudges++;
          messages.push({ role: 'user', content: failedCommandCorrection(lastRun.command.slice(0, 120), lastRun.exitCode) });
          continue;
        }
        // Files changed since the last time anything was checked at all.
        const needsCheck = [...uncheckedEdits].filter((f) => VERIFIABLE_EXT.test(f));
        if (needsCheck.length) {
          verifyNudges++;
          messages.push({ role: 'user', content: verifyBeforeDoneCorrection(needsCheck.slice(0, 6)) });
          yield { type: 'verifying', files: needsCheck };
          continue;
        }
      }

      // 4. Pasted a big code block instead of applying it (asked once).
      if (!readOnly && !madeAnyEdit && !codeBlockNudged) {
        const longestBlock = Math.max(0, ...[...prose.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].split('\n').length));
        if (longestBlock >= 15) {
          codeBlockNudged = true;
          messages.push({ role: 'user', content: CODE_INSTEAD_OF_EDIT_CORRECTION });
          continue;
        }
      }
    }

    if (prose) {
      const shown = withoutEmDashes(prose);
      // interim: narration that accompanies an action (shown folded as "Thinking");
      // otherwise it's the final answer, shown as a normal message.
      yield { type: 'text', text: shown, interim: calls.length > 0 };
      transcript.push({ role: 'assistant', content: shown });
    }

    if (calls.length === 0) {
      // No action block, and every check above passed: the turn is finished.
      yield {
        type: 'done',
        steps: step + 1,
        madeAnyEdit,
        writtenFiles: [...writtenBasenames],
        actions,
        unverifiedFiles: [...unverifiedEdits],
      };
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
    // line 1 - see readProgressByPath above. Only fills in what the model
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
        content: `[tool result: ${call.name}] Blocked - ${mode} mode cannot modify files. Describe the change instead, or tell the user to press tab for Build mode.`,
      });
      yield { type: 'tool_end', name: call.name, args: call.args, ok: false, summary: `blocked in ${mode} mode` };
      continue;
    }

    if (referenceSearchPending && (call.name === 'write_file' || call.name === 'edit_file') && UI_FILE_EXT.test(call.args.path || '')) {
      messages.push({
        role: 'user',
        content: `[tool result: ${call.name}] Blocked - you searched for real-app references and got real hits back, but never called view_images ` +
          `to actually look at any of the screenshot URLs. Call view_images now with 2-4 of those URLs (from different apps), THEN write ${call.args.path || 'the file'}.`,
      });
      yield { type: 'tool_end', name: call.name, args: call.args, ok: false, summary: 'blocked - reference screenshots not viewed yet' };
      continue;
    }

    // A repeat of an earlier read-only call, same tool and same arguments,
    // carries zero new information - reuse the earlier result instead of
    // spending tokens to resend it. This is skipped for read_file specifically
    // when the file was edited since (see the invalidation below): the whole
    // point there is to force a fresh read, not to serve stale content.
    if (DEDUPABLE.has(call.name) && servedCalls.has(callKey(call.name, call.args))) {
      messages.push({
        role: 'user',
        content: `[tool result: ${call.name}] Unchanged since your earlier identical call - reusing that result, not re-run. Nothing new to see; move on.${readOnlyStreakNote()}`,
      });
      yield {
        type: 'tool_end', name: call.name, args: call.args, ok: true,
        meta: { deduped: true }, summary: 'unchanged - reused earlier result',
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
    // them solely from a text description - that blind verification was
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

    // Ground truth for the claim audit above and for the host's "what
    // actually happened" summary.
    const exitCode = typeof out.meta?.exitCode === 'number' ? out.meta.exitCode : undefined;
    actions.push({
      tool: call.name,
      label: String(out.meta?.label || call.args.path || call.args.command || '').slice(0, 200),
      ok: !!out.ok,
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
    if (out.ok) {
      succeededTools.add(call.name);
      if ((call.name === 'write_file' || call.name === 'edit_file' || call.name === 'fetch_image') && !out.meta?.noop && call.args.path) {
        const rel = String(call.args.path).replace(/\\/g, '/');
        unverifiedEdits.add(rel);
        uncheckedEdits.add(rel);
      } else if (call.name === 'run') {
        lastRun = { command: String(call.args.command || ''), exitCode: exitCode ?? 0 };
        uncheckedEdits = new Set();
        if (lastRun.exitCode === 0) unverifiedEdits = new Set();
      } else if (call.name === 'browser_check') {
        uncheckedEdits = new Set();
        unverifiedEdits = new Set();
      }
    }

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
        // A fresh read is exactly the course-correction we'd otherwise force -
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
        // wrong, not just old - collapse it in place rather than leaving
        // outdated content sitting in the transcript for the model to
        // (mis)reason from, and drop it from the dedup cache so a genuinely
        // fresh read_file after this point is not short-circuited by it.
        const abs = resolvePath(call.args.path, cwd).abs;
        const stale = readIndexByPath.get(abs);
        if (stale) {
          messages[stale.msgIndex] = {
            role: 'user',
            content: `[tool result: read_file] ${call.args.path} - superseded by the ${call.name} below; that earlier content no longer matches the file. Re-read if you need to see it again.`,
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
          content: `[note] That edit_file call on ${call.args.path} has now failed ${failures} times in a row - the search text you're guessing at does not match the file. Do not apologize or re-explain what you were trying to do. Call read_file on ${call.args.path} right now, look at its actual current content, then make the edit with search text copied exactly from it.`,
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

  yield {
    type: 'error',
    error: `Stopped after ${stepBudget} steps without finishing.` +
      (madeAnyEdit ? ` Changed so far: ${[...writtenBasenames].join(', ')}.` : ' No files were changed.') +
      ' Send a follow-up to continue, or narrow the request.',
    actions,
  };
}

export { MAX_STEPS };
