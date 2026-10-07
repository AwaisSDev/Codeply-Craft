# Engine notes: OpenCode as the foundation

Craft's agent engine (`codeply-cli/lib`) builds on ideas and some code from
[OpenCode](https://github.com/sst/opencode) (MIT) and
[Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT). Adapted code
is marked in the source and credited in `codeply-cli/THIRD_PARTY_NOTICES.md`.
Keep those notices whenever code from either project is copied in.

Studied: OpenCode at commit `7f964bb` (2026-09-28), all of `packages/opencode`,
`core`, `llm`, `server`, `sdk`, `desktop`, `app`, `tui`, `session-ui`.

## How OpenCode is built (short version)

- One engine behind a local HTTP API (port 4096) plus an SSE event stream. TUI,
  web, the Electron desktop app, Slack and IDEs are all thin clients of it.
- Desktop is Electron: it forks the engine in a `utilityProcess` on a random
  loopback port with a per-launch password (`packages/desktop/src/main/sidecar.ts`).
- Sessions, messages and parts live in SQLite (drizzle). Code is Effect 4 beta
  and Bun, mid-migration from a v1 to a v2 API, so porting whole packages is
  expensive; porting ideas and self-contained pieces is cheap.
- The model uses native function calling (AI SDK). Craft uses a text tag
  protocol instead, so only the policies carry over, not the plumbing.

## Adopted in Craft (2026-09-29)

| Area | What | Where |
|---|---|---|
| Loop | Up to 4 read/list/search blocks run in one step; writes/runs stay alone | `agent.mjs` runAgent |
| Loop | Text after an action block is dropped (it was written before any result) | `parseReply` + loop |
| Loop | Identical call 3x in a row is skipped with ways around it; A,B,A,B cycles and same-tool failure streaks get a "diagnose first" note | `agent.mjs` (OpenCode doom loop, Hermes guardrails) |
| Loop | Step-budget checkpoint 5 steps before the end, then one no-actions summary call | `agent.mjs` (OpenCode max-steps, Hermes) |
| Loop | "Let me now..." with no action block is sent back to act | `agent.mjs` (Hermes stall nudge) |
| False claims | Invented `[tool result]` text caught; more "done" phrasings; claim check skipped after a shell command that could have made the change | `agent.mjs` claim audit |
| False claims | `cmd | tail` / `cmd || echo` hiding a failure is recorded as a failure | `terminal-hints.js` (Hermes) |
| Editing | Fallback matchers: indentation-shifted, escaped quotes, stray blank lines, first/last-line anchors with a Levenshtein check; refuses matches far bigger than asked | `edit-engine.js` (OpenCode replacers) |
| Editing | Near-miss error shows the closest real lines with numbers; duplicates list their lines; `<all>true</all>` replaces every occurrence | `tools.mjs` edit_file |
| Editing | Refuses to edit a file that changed on disk since it was read | `tools.mjs` (Hermes file state) |
| Editing | CRLF files stay CRLF after an edit (they used to be converted to LF) | `edit-engine.js` |
| Search | `<context>` lines, `<files_only>`, find-by-name with only `<glob>` | `tools.mjs` search |
| Shell | One recovery hint per failure (missing command incl. cmd/PowerShell wording, missing npm package, port in use, merge conflict, permissions, execution policy) | `terminal-hints.js` |
| Context | `CODEPLY.md` / `AGENTS.md` / `CLAUDE.md` loaded (nearest wins, up to git root) plus `~/.codeply/AGENTS.md`; git status and recent commits in the project snapshot | `agent.mjs` buildProjectContext |
| Context | When still over budget after trimming, the middle of the turn is summarized with a structured template (deterministic fallback if the summarizer fails); a ledger of real actions rides along on trimmed requests | `agent.mjs` compaction |
| Tasks | `todo` action: whole checklist each call, one item in progress, open items survive compaction | `tools.mjs`, `agent.mjs` |

### Second round (2026-09-29)

| Area | What | Where |
|---|---|---|
| Undo | Each Build message is snapshotted in a hidden git repo (`~/.codeply/snapshots`, never the project's own `.git`); a "Changed N files - Undo/Redo" row appears on desktop and phone. Undo is refused if a later message touched the same files. The model is told in history when its changes were undone | `snapshot.js`, `main.js` setCheckpointUndone, `app.js`/`mobile.js` renderCheckpoint (opencode snapshot/) |
| Output | Oversized tool output is saved in full to a temp file (swept after 7 days) and the model is told how to page through it; command output keeps both its start and its end | `tools.mjs` truncate |
| Read | "Did you mean" for missing files, binary files refused, 2000-char line cap, clear error for an offset past the end, CRLF shown cleanly | `tools.mjs` read_file (opencode read.ts) |
| Checks | After every write/edit a fast syntax check runs (JS via `node --check`, JSON, TS/TSX through the project's own `typescript`, CSS braces, Python `ast`); errors come back in the same result and the turn can't end while one stays unfixed | `diagnostics.js`, `agent.mjs` |
| Permissions | "Always allow" for shell commands is scoped by command name (`npm run dev`, `git checkout`), never all commands; subshells, redirects and risky commands never get the offer | `arity.js` + `arity-table.json` (opencode permission/arity.ts), `main.js` approve |
| Questions | `ask_user` action: multiple-choice question answered with one tap on desktop or phone, or typed; unattended runs (bypass, /goal) decide for themselves; answers go into later history | `tools.mjs`, `main.js`, `app.js`, `mobile.js` (opencode question tool) |
| Retry | 4 attempts, `Retry-After` / `retry-after-ms` honoured (capped 30s), +-25% jitter, Stop cancels a backoff wait | `ai.js` (opencode session/retry.ts) |

### Third round (2026-09-29)

| Area | What | Where |
|---|---|---|
| Native tool calling | Models with function calling get real tool definitions; history is converted to assistant.tool_calls + role "tool" results at the edge, and replies' tool calls become ordinary action blocks, so every guard still applies. Parallel reads work natively. Works for OpenAI-compatible APIs (streamed tool-call deltas), Anthropic (tool_use / tool_result) and Ollama. A model that rejects tools falls back to text actions, remembered per model. Auto stays on text. `toolMode: 'text'` on a model, or `CODEPLY_TOOLS=text`, forces text | `native-tools.mjs`, `ai.js`, `agent.mjs` |
| MCP | Own small client (no SDK): stdio and streamable HTTP, `~/.codeply/mcp.json` + `<project>/.codeply/mcp.json` in the Claude Desktop/Cursor `mcpServers` format. Tools are native functions `mcp__server__tool` with their real schemas (or one `mcp` action in text mode), listed in the prompt; anything not marked read-only asks first | `mcp.js`, `tools.mjs` mcp, `agent.mjs` |
| Type checking | Semantic errors from the project's own TypeScript + tsconfig/jsconfig, in a warm worker process per project (first check ~1-2s, then ~10ms); falls back to the syntax pass when slow or absent | `typecheck-worker.js`, `diagnostics.js` |
| Commands | `.codeply/commands/<name>.md` (and `~/.codeply/commands`) with description/mode frontmatter, `$ARGUMENTS` / `$1..$n`; they appear in the "/" menu; chat shows what was typed, the model gets the expansion | `commands.js`, `main.js`, `app.js` |
| Permissions file | `.codeply/permissions.json` allow/deny rules (`run:npm run *`, `edit_file:src/**`, `write_file:*.env`); deny wins even in bypass, every part of a chained command must be allowed, risky commands always ask | `permissions.js`, `main.js` approve |
| Workarounds | Hints for shell-syntax failures (heredoc on cmd/PowerShell, PS 5.1 `&&`, broken quoting, command line too long) that say to switch to write_file / a script file; a WORKAROUNDS rule in the prompt; the prompt names the real shell `run` uses | `terminal-hints.js`, `agent.mjs` |

Tests: `npm run test:engine` (102 checks). The new renderer cards were also
driven in the running app over the DevTools protocol (render, click an answer,
click Undo).

### Fourth round (2026-09-30)

| Area | What | Where |
|---|---|---|
| Tools | `web_fetch` (URL to readable text, 30s, 5MB cap, no binaries) and `web_search` (Exa MCP, DuckDuckGo fallback); both read-only and batchable | `web-tools.js`, `tools.mjs` (opencode webfetch/websearch) |
| Tools | `apply_patch`: one `*** Begin Patch` block that adds, updates (with `@@` anchors), moves and deletes several files, planned in memory first so a bad hunk changes nothing, one approval card listing every file, syntax/type check per file, CRLF kept | `apply-patch.js`, `tools.mjs` (opencode apply_patch) |
| Tools | `lsp`: definition, references, implementation, hover, documentSymbol, workspaceSymbol through the project's own TypeScript in the warm worker (JS/TS/JSX/TSX) | `typecheck-worker.js`, `diagnostics.js` navigate, `tools.mjs` |
| Plan mode | Plan writes `.codeply/plans/<slug>.md` (the only file Plan/Ask may write), then `plan_exit` asks "Yes, start building / No, keep planning"; Yes emits `mode_switch` and the same turn continues in Build. `plan_enter` (Build only) always asks | `tools.mjs`, `agent.mjs`, `app.js`/`mobile.js` mode_switch |
| Storage | Chats live in SQLite (session/message rows, only changed rows written, search across all messages) instead of rewriting one JSON file. Driver order: `node:sqlite` (Node 22.5+), then `better-sqlite3` (Electron 29 has no `node:sqlite`; `scripts/install-sqlite.js` fetches the Electron binary), then the JSON file. `craft-store.json` is imported once and kept as `.migrated`. Supabase sync is unchanged | `session-db.js`, `main.js` loadStore/saveStore, `sessions:search` IPC |
| Architecture | `codeply serve`: the engine as a local HTTP API + server-sent events (chats, messages, approvals, questions, undo, export, search), password required, loopback by default, browsers refused unless their origin is listed, `Last-Event-ID` replay. Same run pipeline pieces as the desktop app (`history.js` is shared). Runs on any machine you own, so it is also the building block for "my own cloud environment" | `server.mjs`, `bin/codeply.js`, `history.js` |

### Fifth round (2026-09-30): ecosystem

| Area | What | Where |
|---|---|---|
| Plugins | A plugin is a git repo or folder with `codeply-plugin.json` (also reads `plugin.json` and `.claude-plugin/plugin.json`), `commands/*.md`, `skills/<n>/SKILL.md`, `mcp.json`, `instructions.md`. Install from `owner/repo`, a git URL or a folder (optional `#ref`); user scope (`~/.codeply/plugins`) or project scope (overrides user). Commands become `/<plugin>:<cmd>`, MCP servers `<plugin>-<server>`, skills join the skill list. No executable hooks: only MCP servers can start a process, and install shows their exact commands and asks first. Sharing a plugin = pushing the folder to GitHub | `plugins.js`, `commands.js`, `skills.js`, `mcp.js`, `agent.mjs`; `codeply plugin ...`; desktop `/plugins` modal |
| GitHub agent | Comment `/codeply <request>` (or `/craft`, `@codeply`) on an issue or PR. Runs in the user's own GitHub Actions runner with their own model key (`CODEPLY_API_KEY`, `CODEPLY_PROVIDER`, `CODEPLY_MODEL`, `CODEPLY_BASE_URL`); nothing runs on Codeply servers. Issue: branch `codeply/issue-N-...` plus a PR ("Closes #N"). PR comment: pushes to the PR branch. `ask`/`plan` are read-only. Only OWNER/MEMBER/COLLABORATOR comments run, bots ignored, fork PRs read-only, the token and key are removed from the agent's environment, and the agent cannot run `git push` or `gh`. `codeply github install` writes the workflow | `github-agent.mjs`, `bin/codeply.js` |
| Sharing | Save a chat as Markdown or a self-contained web page, or create a secret gist (GitHub connection now asks for the `gist` scope; existing connections must reconnect). Keys, tokens, the home folder and the project path are masked first. Server: `/session/:id/export?format=md\|html` | `share.js`, `session:share` IPC, chat "..." menu |

Tests: `npm run test:engine` (201 checks, includes the SQLite store, plugins, the GitHub agent against a fake API and a local bare remote, sharing, and the server end to end).

Not done on purpose: subagents (one agent at a time), provider changes, plugin hooks.

Untested against real services: the GitHub agent has not run inside a real Actions job, and the desktop share menu and gist upload have not been driven in the running app.

### End-to-end publishing (2026-10-07)

| Area | What | Where |
|---|---|---|
| Flow | "Publish it": `publish_check` (stack, database signals, connections), `publish_connect` (one-click connect card, waits, resumes), `supabase_setup` (pick or create project, URL + anon key written where the stack reads them: `env.js`, `.env` VITE_, `.env.local` NEXT_PUBLIC_, ...), `supabase_schema` (SQL shown and approved, RLS added to new tables), `publish_deploy` (asks about GitHub once, project, env vars, SHA upload, polls until READY, live URL; build log back to the agent, one retry), `publish_github` (create or reuse repo, push with a one-time auth header, link Vercel) | `publish.js`, `skills/publish-website`, `agent.mjs` PUBLISHING rule |
| Safety | Refuses unless the user's message asks to publish; creating a project and going live ask first; never the service role key; `.env` git-ignored; tokens never in output, state or `.git/config` | `publish.js` |
| Desktop | Publish button, progress card (Database, Vercel, GitHub, Live), Connect button on the question card, token fallback in Connect Apps | `publish-ui.js/.css`, `main.js` connectToken + resolveConnectQuestions |
| Tests | Fake Vercel/Supabase/GitHub servers + local bare remote | `scripts/publish-test.mjs` |

## Worth doing next (from the study, not built yet)

1. UX: group consecutive reads into one "Gathered context" row, docked approvals,
   notifications only when the window is unfocused, queued follow-ups.
2. Undo in the CLI/TUI too (the snapshot module is host-agnostic).
3. Snapshot storage cleanup (`git gc --prune`) for projects not opened in a while.

## Not a source

`Downloads/claude-code-main` is the leaked Anthropic Claude Code source. Do not
read, port, paraphrase or compare against it. Claude Code's public docs are fine.
