/**
 * Native function calling as a transport.
 *
 * Inside the engine everything stays in one format: the model's actions are
 * <codeply:name> blocks in its reply, and results come back as
 * "[tool result: name]" user messages. Every guard in agent.mjs (claim audit,
 * stuck detection, verification gates, batching) works on that format.
 *
 * For models with real function calling this module translates at the edge:
 *   - toNativeMessages(): engine history -> OpenAI-shaped history
 *     (assistant.tool_calls + role "tool" results), which ai.js sends as is to
 *     OpenAI-compatible APIs and converts for Anthropic and Ollama.
 *   - toolCallsToTags(): the model's tool calls -> <codeply:...> blocks, so
 *     the rest of the loop sees exactly what it would have seen in text mode.
 * Structured arguments mean no tag-format mistakes, and the model uses the
 * calling convention it was trained on.
 */

// What the model is told about each action. Parameters not listed as
// required are optional. Descriptions stay short: the system prompt's RULES
// section carries the detailed guidance.
export const TOOL_DOCS = {
  todo: { d: 'Replace your task checklist for a multi-step task. Send the whole list every time.', req: ['items'], p: { items: 'One task per line: "[ ] pending", "[>] in progress" (only one), "[x] done" (only after a tool confirmed it), "[-] dropped".' } },
  ask_user: { d: 'Ask the user a multiple-choice question when a real decision is theirs to make and cannot be inferred from the project.', req: ['question'], p: { question: 'The question, one sentence.', options: 'Up to 5 short answers, one per line, recommended first.' } },
  list_dir: { d: 'List a folder.', req: [], p: { path: 'Folder, relative to the project root. Default ".".' } },
  read_file: { d: 'Read a text file with line numbers.', req: ['path'], p: { path: 'File path.', offset: '0-based line to start at.', limit: 'Max lines (up to 600).' } },
  write_file: { d: 'Create a file or fully rewrite one. For changes to an existing file prefer edit_file.', req: ['path', 'content'], p: { path: 'File path.', content: 'The complete file content, verbatim.' } },
  edit_file: { d: 'Replace one exact block of an existing file.', req: ['path', 'search', 'replace'], p: { path: 'File path.', search: 'Existing text copied exactly from a read (no line-number prefixes), just enough to be unique.', replace: 'The replacement text.', all: '"true" to replace every occurrence (renames).' } },
  search: { d: 'Regex search across project files, or find files by name when only glob is given.', req: [], p: { pattern: 'Case-insensitive regex.', glob: 'Limit to paths like "**/*.ts", or alone to find files by name.', path: 'Folder or single file to search in.', context: 'Lines of surrounding code per hit (0-5).', files_only: '"true" to list matching files with hit counts.' } },
  run: { d: 'Run a shell command in the project folder on the user\'s machine.', req: ['command'], p: { command: 'The command line.' } },
  use_skill: { d: 'Load a skill\'s full instructions.', req: ['name'], p: { name: 'Skill name from the SKILLS list.' } },
  list_skills: { d: 'Search the full skill library.', req: ['query'], p: { query: 'One or two words.' } },
  fetch_image: { d: 'Download an image into the project.', req: ['url', 'path'], p: { url: 'Image URL.', path: 'Where to save it, e.g. assets/hero.jpg.' } },
  browser_check: { d: 'Open a page in a real browser and get errors plus a screenshot.', req: ['url'], p: { url: 'file:///absolute/path or http://localhost:port.', wait: 'Extra milliseconds to wait before capturing.', viewport: 'desktop (default), tablet, mobile, or WIDTHxHEIGHT.' } },
  gmail_send: { d: 'Send a real email now. Only when the user asked for it to go out. The user sees it on an editable card first and may change it or save it as a draft instead; the result says what really happened.', req: [], p: { to: 'Recipient address.', subject: 'Subject line.', body: 'Plain-text body.', draft: 'Optional: the id of a draft saved in Codeply (from drafts_list) to send; to/subject/body then come from it.' } },
  gmail_search: { d: 'Search the connected Gmail account. Leave query empty to list the newest mail.', req: [], p: { query: 'Gmail search syntax, e.g. "is:unread" or "from:x@y.com". Empty = newest mail.' } },
  gmail_draft: { d: 'Save an email as a draft without sending it: in Gmail\'s Drafts when Gmail is connected, otherwise in Codeply\'s own drafts.', req: [], p: { to: 'Recipient address (optional for a draft).', subject: 'Subject line.', body: 'Plain-text body.' } },
  drafts_list: { d: 'List the drafts saved in Codeply (ids, subject, recipient). Send one with gmail_send and its id as draft.', req: [], p: {} },
  calendar_list: { d: 'List events on the user\'s Google Calendar in a time range (default: today). Times are local.', req: [], p: { from: 'Start: today, tomorrow, 2026-10-03 or 2026-10-03T14:00. Default today.', to: 'End (a date means through that whole day). Default: end of the from day.', max: 'Most events to return (1-50, default 20).' } },
  calendar_add: { d: 'Add an event to the user\'s Google Calendar (asks the user first).', req: ['title', 'start'], p: { title: 'Event title.', start: 'Local start: 2026-10-03T14:00, or 2026-10-03 for an all-day event.', end: 'Local end. Default: one hour after start (all-day: the same day).', description: 'Notes for the event.', location: 'Where it is.', reminders: 'Popup reminders, minutes before, comma-separated, e.g. "10,60".' } },
  slack_post_message: { d: 'Post a real Slack message now. Only when the user asked for it.', req: ['channel', 'text'], p: { channel: 'Channel name or id.', text: 'Message text.' } },
  vercel_deploy: { d: 'Deploy a folder to the connected Vercel account (live, real).', req: [], p: { path: 'Folder to deploy. Default ".".' } },
  supabase_create_project: { d: 'Create a new Supabase project (billable, real).', req: ['name'], p: { name: 'Project name.' } },
  supabase_delete_project: { d: 'Permanently delete a Supabase project. Only when the user clearly asked.', req: [], p: { name: 'Project name.', ref: 'Project ref.' } },
  github_create_repo: { d: 'Create a GitHub repo in the connected account and push this folder to it.', req: ['name'], p: { path: 'Folder to push. Default ".".', name: 'Repository name.' } },
  design_reference_search: { d: 'Search the local library of real app screenshots for a kind of screen.', req: ['term'], p: { term: 'What the screen is, e.g. "checkout".', category: 'Optional category filter.' } },
  view_images: { d: 'Look at images (e.g. reference screenshots).', req: ['urls'], p: { urls: 'Comma-separated image URLs.' } },
  supabase_api: { d: 'Call the Supabase Management API.', req: ['method', 'path'], p: { method: 'GET, POST, PATCH, PUT or DELETE.', path: 'Path starting with /v1/.', body: 'JSON body.' } },
  supabase_sql: { d: 'Run SQL on a Supabase project database.', req: ['ref', 'query'], p: { ref: 'Project ref.', query: 'SQL.' } },
  vercel_api: { d: 'Call the Vercel REST API.', req: ['method', 'path'], p: { method: 'HTTP method.', path: 'Path like /v9/projects.', body: 'JSON body.' } },
  web_fetch: { d: 'Fetch a web page or API URL and get its content as readable text.', req: ['url'], p: { url: 'http:// or https:// URL.', format: '"text" (default, HTML converted to readable text), "html" or "raw".' } },
  web_search: { d: 'Search the web for current information (docs, errors, versions, news).', req: ['query'], p: { query: 'The search query.', num: 'Number of results (1-20, default 8).' } },
  apply_patch: { d: 'Change several files at once (add, update, delete, move) with one patch. Use it for multi-file changes; use edit_file for a single block.', req: ['patch'], p: { patch: 'The patch text: "*** Begin Patch", then "*** Add File: path" (lines start with +), "*** Update File: path" (optional "*** Move to: path", "@@ anchor line", then lines starting with " ", "-" or "+"), "*** Delete File: path", and "*** End Patch".' } },
  lsp: { d: 'Code navigation for TypeScript/JavaScript: find the real definition or every reference of a symbol, hover for its type, outline a file, or search symbols.', req: ['operation'], p: { operation: 'definition, references, implementation, hover, documentSymbol or workspaceSymbol.', path: 'File the symbol is in (not needed for workspaceSymbol).', line: '1-based line of the symbol.', character: '1-based column of the symbol (or give symbol instead).', symbol: 'The name on that line, e.g. fetchUser.', query: 'For workspaceSymbol: the name to look for.' } },
  plan_exit: { d: 'Plan mode only. Call after the plan file is written: asks the user whether to switch to Build mode and start implementing.', req: [], p: { path: 'The plan file, e.g. .codeply/plans/add-login.md. Default: the newest plan file.' } },
  plan_enter: { d: 'Build mode only. Ask the user to switch to Plan mode first, for a large or ambiguous task. Use sparingly.', req: [], p: { reason: 'Why planning first would help, one sentence.' } },
  ask_bot: { d: 'Hand one task to a teammate bot from the TEAM or BOTS list and wait for its result. Only one bot runs at a time.', req: ['bot', 'task'], p: { bot: 'The bot\'s name.', task: 'The one task, with all the context it needs (it sees nothing else).' } },
  mcp: { d: 'Call a tool on a connected MCP server.', req: ['server', 'tool'], p: { server: 'Server name from MCP SERVERS.', tool: 'Tool name on that server.', args: 'JSON object of the tool\'s arguments.' } },
};

/** OpenAI-style tool definitions for every action in `params` (name -> param list). */
export function buildToolSchemas(params) {
  return Object.entries(params).map(([name, list]) => {
    const doc = TOOL_DOCS[name] || { d: name.replace(/_/g, ' '), req: [], p: {} };
    const properties = {};
    for (const p of list) properties[p] = { type: 'string', description: doc.p[p] || p };
    return {
      type: 'function',
      function: {
        name,
        description: doc.d,
        parameters: { type: 'object', properties, required: doc.req.filter((r) => list.includes(r)) },
      },
    };
  });
}

/**
 * Engine history -> OpenAI-shaped native history.
 *
 * Each assistant reply with action blocks becomes one assistant message with
 * tool_calls, followed by exactly one "tool" message per call (APIs reject a
 * tool call with no answer). Results are matched to calls in order by name;
 * a call that got no result (skipped by a guard) gets a short stand-in, and
 * any notes that arrived in between go after the tool messages.
 *
 * @param {Array} messages      engine transcript
 * @param {Function} parse      agent.mjs parseReply
 */
export function toNativeMessages(messages, parse, mcpToNative = null) {
  // An engine <codeply:mcp> call goes out as the MCP tool's own function.
  const nativeCall = (c) => {
    if (c.name === 'mcp' && mcpToNative) {
      const fn = mcpToNative[`${c.args?.server}/${c.args?.tool}`];
      if (fn) return { name: fn, arguments: String(c.args?.args || '').trim() || '{}' };
    }
    return { name: c.name, arguments: JSON.stringify(c.args || {}) };
  };
  const out = [];
  let seq = 0;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role !== 'assistant' || typeof m.content !== 'string' || !m.content.includes('<codeply:')) {
      out.push(m);
      i++;
      continue;
    }
    const { prose, calls } = parse(m.content);
    if (!calls.length) { out.push(m); i++; continue; }
    const withIds = calls.map((c) => ({ ...c, id: `call_${++seq}` }));
    out.push({
      role: 'assistant',
      content: prose || '',
      tool_calls: withIds.map((c) => ({ id: c.id, type: 'function', function: nativeCall(c) })),
      // DeepSeek's thinking mode rejects a tool call whose reasoning is missing.
      ...(m.reasoning_content !== undefined ? { reasoning_content: m.reasoning_content } : {}),
    });
    // Collect everything up to the next assistant message.
    const answers = new Map();
    const notes = [];
    let j = i + 1;
    for (; j < messages.length && messages[j].role !== 'assistant'; j++) {
      const r = messages[j];
      const text = typeof r.content === 'string' ? r.content : (r.content.find?.((p) => p.type === 'text')?.text || '');
      const hit = /^\[tool result: ([a-z_]+)\]/.exec(text);
      const target = hit && withIds.find((c) => c.name === hit[1] && !answers.has(c.id));
      if (target) answers.set(target.id, r);
      else notes.push(r);
    }
    const images = [];
    for (const c of withIds) {
      const r = answers.get(c.id);
      if (!r) {
        out.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: '(not run - see the note that follows)' });
        continue;
      }
      if (typeof r.content === 'string') {
        out.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: r.content });
      } else {
        // Tool messages are text-only on most APIs: screenshots ride in a
        // user message right after the tool results.
        out.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: r.content.find((p) => p.type === 'text')?.text || '' });
        images.push(...r.content.filter((p) => p.type === 'image_url'));
      }
    }
    if (images.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Images from the tool results above:' }, ...images] });
    out.push(...notes);
    i = j;
  }
  return out;
}

/**
 * The model's native tool calls -> the <codeply:...> blocks the loop runs.
 * Unknown tools and unparseable arguments are reported back instead of run.
 * @returns {{ text: string, problems: string[] }}
 */
export function toolCallsToTags(content, toolCalls, params, mcpFromNative = null) {
  const blocks = [];
  const problems = [];
  for (const tc of toolCalls || []) {
    let name = tc.function?.name;
    const mcpTarget = mcpFromNative && mcpFromNative[name];
    if (!name || (!params[name] && !mcpTarget)) { problems.push(`unknown tool "${name}"`); continue; }
    let args;
    try { args = JSON.parse(tc.function.arguments || '{}'); }
    catch { problems.push(`${name}: arguments were not valid JSON`); continue; }
    if (mcpTarget) {
      args = { server: mcpTarget.server, tool: mcpTarget.tool, args: JSON.stringify(args || {}) };
      name = 'mcp';
    }
    const inner = params[name]
      .filter((p) => args[p] !== undefined && args[p] !== null)
      .map((p) => {
        const v = typeof args[p] === 'string' ? args[p] : JSON.stringify(args[p]);
        return `<${p}>\n${v}\n</${p}>`;
      })
      .join('\n');
    blocks.push(`<codeply:${name}>\n${inner}\n</codeply:${name}>`);
  }
  return { text: [String(content || '').trim(), ...blocks].filter(Boolean).join('\n'), problems };
}

// Replaces the tag examples in the system prompt when native tools are on.
export const NATIVE_FORMAT = `TOOLS
You act by calling the tools you have been given (native function calling).
Call a tool, then stop and wait: its result comes back to you. Up to 4 read_file /
list_dir / search calls may go in one reply and run together; anything that
changes something (write_file, edit_file, run, ...) goes alone. Before a call,
write at most one short sentence. When the task is finished, reply with text
only and no tool call; that ends your turn. In the rules below, "action block"
means a tool call.`;

/** Errors that mean "this model or endpoint does not do function calling". */
export const TOOLS_UNSUPPORTED = /does not support tools|tools? (?:are|is) not supported|not support(?:ed)? (?:function|tool)|function calling is not|unsupported parameter:? '?tools|unrecognized request argument.*tools|extra inputs are not permitted.*tools|unknown field .?tools|tool_choice.*not supported|no endpoints found that support tool use/i;
