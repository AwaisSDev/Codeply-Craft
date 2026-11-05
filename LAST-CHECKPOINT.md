# Last Checkpoint

Branch `last-checkpoint`: every feature from every branch, in one place, before a review and a
security audit, and only then `main`. Built 2026-11-06. The research on local models and context
stays on its own branches and is not here.

## How it was built

1. Start from `test-all`. It already held almost every branch: checked with
   `git rev-list --count test-all..<branch>` for every branch on GitHub and on this PC.
2. Merge `claude/user-token-consumption-4u7ukg` (the app records prompt-cache tokens in usage).
   One conflict in `codeply-cli/lib/ai.js`, where `wisp-claude-code` had touched the same lines:
   kept the new totals (prompt_tokens is all input on every route) plus OpenAI's `cached_tokens`
   field. A follow-up fixes the debug cache log (`CODEPLY_CACHE_LOG`), which double counted.
3. Tests: `wisp-test`, `claude-code-test`, `cache-test`, `engine-test` all pass.

## Every branch and where it went

### Included (all of its commits are in this branch)

| Branch | What it is |
|---|---|
| `test-all` | The base: Codeply 2.3.0, the top bar, one tab, Design mode, Settings, Wisp and specialists, talk_to, Codeply Labs identity |
| `main` | Everything shipped |
| `wisp-claude-code` | Wisp hands coding to Claude Code on the user's own plan; warm prompt cache |
| `wisp-main-agent` | Wisp as the main agent, phone schedules and bots with the PC off |
| `link-chips` | Bare links show as the site's icon and name |
| `phone-screenshots` | Screenshots in the phone chat |
| `rich-chat-ui` | Rich, interactive chat replies, reader text settings |
| `claude/user-token-consumption-4u7ukg` | Prompt-cache tokens in usage telemetry (merged here) |
| `ci/dsh-build` | The DSH engine shipped inside the app with Node 24 |
| `testing` | Converter wheel (drag + Shift), Design fixes |
| `mobile-ui-refresh` | Phone status bar fix |
| `claude/tasteful-design-layer-vk5sq8` | The taste design layer |
| `launch-prep` | Responsive checks in the browser panel |
| `next/*` (Codeply-Craft-Next: `codeply-brain`, `main`, `reel-agent-editor`, `test-all`) | Life bots, screen context, Motion build |
| `voicetest/voice-mode` (craft-voice-test) | Voice mode |
| Local: `codeply-brain`, `life-bots`, `cloud-handoff`, `design`, `voice-mode`, `reel-agent-editor`, convert wheel and other worktree branches | Already in `test-all` |
| Local: `worktree-agent-a6cb54b6c05ced5f1` | Share masking and other fixes; already in as `0413cc79` (same change, different commit) |

### Left out on purpose: research, new models, context

| Branch | Why |
|---|---|
| `codeply-local-intelligence` | Local context layer (LFM3, redaction, collectors): research |
| `codeply-li-architecture-research` | Architecture research |
| `codeply-li-dtw-experiment` | Memory model experiment |
| `codeply-memarch-research` | Memory architecture research (Ettin) |
| `research/paste-architecture` | PASTE model design |
| `codeply-memory-model`, `codeply-memory-model-integration`, `codeply-brain-value-match` | The memory model release and its Brain integration (196 commits) |
| `dtw-artifacts` | Trained model weights (orphan branch) |
| `claude/wonderful-feynman-y2ldw2` | Secrets guard for the Brain, built on the local intelligence branch. **Bring this in with the context work: it is a security fix.** |

### Left out: not code, or parked

| Branch | Why |
|---|---|
| `craft-sessions` | Chat sync data (`Craft live/*.json`), not code. Never merge. |
| `devin-cli-rebuild` | Unfinished, untested CLI rebuild in its own folder (`devin-rebuild/`). Add it if you want it kept. |
| `unlimited-ocr-prototype` (local) | Unfinished OCR prototype, parked. |

## Next steps (in order)

1. **Review**: run the app from this branch and click through every feature.
2. **Security audit**: `/security-review` on `main...last-checkpoint`. Look hardest at:
   - Claude Code handoff (`claude-code-desktop.js`, `codeply-cli/lib/claude-code.js`): what it may run, and its approvals
   - talk_to and specialists (`wisp-desktop.js`)
   - Settings IPC (`settings:get` / `settings:set` in `main.js`)
   - Design mode's folder (`designDir` in `main.js`): writes only inside Documents/Codeply Designs
   - The phone's Connected apps OAuth and `supabase/functions/integration-status`
   - Telemetry: counts only, never content
3. **Release order for the token change**: the database columns and the `track` function are already live
   (2026-11-06), so the app can ship this whenever `main` is updated.
4. Merge into `main`. Pushing `main` deploys the phone app (`scripts/vercel-ignore.sh`), and a version
   tag runs the desktop release.
