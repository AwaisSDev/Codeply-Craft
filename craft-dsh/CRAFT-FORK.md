# Craft's DSH engine

This folder is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, `LICENSE`), taken at commit `22ddee37` (2026-10-23). It is Craft's second engine: the title bar switches between Classic (`codeply-cli`) and DSH (this folder). Craft starts and shows it through `dsh-engine.js` in the app root.

Built on DeepSeek Harness. "DeepSeek Harness" is a registered trademark of DeepSeek, so this fork's name and visible brand are Craft's own (see `BRAND_GUIDELINES.md`). Third-party licenses stay as listed in `THIRD_PARTY_NOTICES.md`.

## What the fork changes

| Change | Where |
|---|---|
| Haze 2 model adapter: route `haze`, model `haze-2`, through Craft's loopback bridge | `packages/llm/llm-haze` (new) |
| Haze 2 is the default model; persona says Craft | `packages/bundle/web-app/cordis.patch.yml` |
| Codeply mark in place of the whale everywhere it falls back (sidebar, hero, wordmark) | `packages/client/ui-primitives/src/FishLogo.tsx`, `BrandWordmark.tsx`, `packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx` |
| Visible strings say Craft (all locales); hero line | `packages/client/**/locales*.ts`, `packages/client/locale/src/locales/*.ts` |
| Title, favicons, web manifest | `apps/web/index.html`, `apps/web/public/` |
| User-agent identifies as `codeply-craft-dsh` | `packages/llm/llm/src/attribution.ts` |
| Window title separator is a middle dot | `packages/client/ui-layout/src/client/DocumentTitle.tsx` |
| The default workspace is `Documents/Craft/default-workspace` | `packages/api/workspace-controller/src/default-directory.ts` |
| The model is told it is Craft (system prompt, Web GUI and checkout context, CLI help) | `packages/core/system-prompt/src/index.ts`, `packages/context/harness-dev-context/src/index.ts`, `packages/bundle/web-app/src/`, `packages/bundle/sdk-app/src/index.ts` |

## The Codeply harness: Classic Craft's add-ons on top

DSH's own core, loop and native tool calling stay as they are. What Classic Craft (`codeply-cli`) did better comes back as separate plugins under `packages/codeply/`, mounted at the end of `packages/bundle/web-app/cordis.patch.yml`. Each one only adds context through DSH's events (`tools/post-execute` additional context, `agent/turn-stopping` steering) or registers a command; none blocks or rewrites a DSH result.

| Package | What it adds | Ported from |
|---|---|---|
| `@codeply/dsh-edit-checks` | Syntax check after every `write` / `edit` / `str_replace_editor` (JS via `node --check`, JSON, TS/TSX via the project's TypeScript, CSS braces, Python `ast`); the turn can't quietly end while a changed file still fails | `codeply-cli/lib/diagnostics.js`, the verification loop in `agent.mjs` |
| `@codeply/dsh-edit-near-miss` | When `old_string` is not found, the closest real lines with line numbers; when it matches more than once, the lines where | `codeply-cli/lib/tools.mjs` nearestMatchHint |
| `@codeply/dsh-shell-hints` | One recovery hint for a failed `pwsh` / `bash` command, and a warning when exit 0 is masking a failure | `codeply-cli/lib/terminal-hints.js` (itself from Hermes Agent, MIT) |
| `@codeply/dsh-claim-check` | Sends the model back once when its answer claims file changes, tests or deploys no tool made this turn | the claim audit in `codeply-cli/lib/agent.mjs` |
| `@codeply/dsh-undo` | `/undo` puts back the last turn's files, reversing DSH's own per-turn workspace changes, and only when every file still holds what that turn left | Classic's per-message Undo (`codeply-cli/lib/snapshot.js`) |
| `@codeply/dsh-browser-check` | `browser_check`: the page opens in Craft's browser panel and the tool reports console errors, failed requests, broken images, sideways scroll and the visible text; registered only when Craft's bridge is present (`POST /browser-check`) | Classic's `browser_check` (`codeply-cli/lib/tools.mjs`), whose report code Craft reuses |
| `@codeply/dsh-design-tools` | `design_direction` and `design_lint` for the codeply-taste skill, run by Craft (with the real render in its browser) or the terminal app through the bridge (`POST /design/<tool>`); Classic's bundled skills reach the engine as `DSH_BUNDLED_SKILL_DIR` (`codeply-cli/skills`) | `codeply-cli/lib/design-tools.mjs`, `codeply-cli/skills/codeply-taste` |
| Config only | `CODEPLY.md` first among instruction files; `~/.codeply/AGENTS.md` and `~/.codeply/skills` through `DSH_AGENTS_HOME`, which Craft sets | Classic's instruction and skill lookup |

### Codeply Craft UI

| Change | Where |
|---|---|
| Atomic Craft mark and "Codeply Craft" in the sidebar and hero, no build badge | `packages/codeply/client-ui-brand-craft` (new) |
| Codeply account at the sidebar foot (DeepSeek's account plugin is not mounted); Browser button opening Craft's own browser | `packages/codeply/client-ui-craft-host` (new), Craft's `dsh-preload.js` |
| Web search with no key (Exa, then DuckDuckGo) | `packages/codeply/web-search` (new) |
| Permission picker: Always ask (read-only + ask), Ask once (workspace-write + ask, remembered per chat), Full access | `client/ui-permission-presets/src/client/locales.ts`, `packages/codeply/approval-memory` (new) |
| Only the Standard mode ships; the mode picker and Create plugin are hidden | `packages/bundle/web-app/package.json` (`dsh.bundle.patch`), `client/ui-agent-preset/src/client/index.ts` |
| No context meter (Haze routes between models with different windows) | `client/ui-conversation/src/client/skeleton/InputBar.tsx` |
| No Trajectory tab (the plugin stays mounted for attachments) | `client/ui-trajectory/src/client/index.ts` |
| Sidebar collapse is one motion: no fade-out and no rail slide-in; the shrinking column clips the labels, the rail swaps in at settle, and every rail icon sits on the same pixel as its expanded row (38px rhythm, New Session left-aligned) so nothing moves at the swap; 60 fps with no dropped frames. An instant collapse (the view got narrower, as when Craft's browser opens) swaps to the rail before the next paint, so clipped labels never flash | `client/ui-sidebar/src/client/SidebarRoot.tsx`, `SidebarRoot.module.css` |
| One motion curve app-wide: the shared token is a decelerating `cubic-bezier(0.2, 0, 0, 1)`, and a global rule puts every CSS transition on it (reduced motion still off); longer chat-row folds | `client/ui-theme/src/styles/base.css`, `client/ui-chat/src/client/chat/flow-motion.ts` |
| Full-text chat search; DeepSeek's model badge off | `packages/bundle/web-app/cordis.patch.yml` |
| Craft Cloud: a Cloud chip in the composer row switches the chat to the `craft-cloud` route, whose "model call" starts a Craft Cloud task (Classic's runner on GitHub Actions), streams its progress as the thinking text and returns its answer as the reply; `/cloud apply`, `/cloud status`, `/cloud cancel`. Uses a folder's Classic Cloud setup | `packages/codeply/craft-cloud` (new), `packages/codeply/client-ui-craft-host/src/client/CloudChip.tsx`; Craft's `dsh-engine.js` (`/cloud/*` bridge) and `cloud-desktop.js` |
| Running status: the atomic Craft mark turning, "Crafting for 2s ···" | `client/ui-chat/src/client/chat/RunningCraftMark.tsx`, `RunningStatus.tsx`, `ChatView.module.css`, `locale.ts` |
| No Preview badge beside the hero headline | `client/ui-conversation/src/client/skeleton/EmptyHero.tsx` |
| No Workspace Tree grouping: the sidebar groups by Workspace or shows one list; a saved tree choice reads as Workspace | `client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` |
| No Plugins row in the sidebar (More > Browse other plugins still opens the page) | `client/ui-plugin-manager/src/client/index.ts` |
| Accent colour in Settings > General: nine swatches that recolour the accent ramp (links, selection, active row, bubbles) in light and dark, kept per device | `packages/codeply/client-ui-craft-host/src/client/AccentRow.tsx` |
| Models are Haze 2 and your own: DeepSeek's adapters and its Models page are not mounted; Craft's Models page adds, tests and removes your own models (the same list as Classic's Add a model, keys kept by Craft), and they show in the picker under Your models, run through the Haze bridge | `packages/bundle/web-app/cordis.patch.yml`, `packages/codeply/client-ui-craft-host/src/client/OwnModelsSection.tsx`, `packages/llm/llm-haze` (`own` route); Craft's `dsh-engine.js` (`GET /models`, `modelId`), `dsh-preload.js`, `main.js` |

Not ported, because DSH already has its own: repeated-call detection, read-before-edit and stale-file guards, retries, compaction, todos, questions, plan mode, MCP, skills, plugins, web tools, LSP, subagents, goals, jobs, permission presets.

Left out of the fork: `.agents/`, `snapshots/` (except the two session fixtures host type-checks import), `website/`, `benchmarks/`, `.github/`, `docs/upgrade-guide/`, `docs/persistence-changes/`, DeepSeek's `.claude/` and `.gitlab-ci.yml`. `pnpm-workspace.yaml` drops the two workspace entries that pointed at removed folders, and the doc-site scripts and gate that built `website/` are removed.

Credit lines that name DeepSeek's own work (the file-icon artwork owner, the official brand plugin) are kept as they were.

## Testing without a full build

With a `.craft-dev` file in this folder (git-ignored), Craft starts the engine from source (`apps/cli/src/bin.ts` through tsx). Delete the file to use the built version; the installed app never does this.

- **Add-on and engine changes** (`packages/codeply/*` host plugins, `llm-haze`, bundle patches): restart the engine from Craft (switch to Classic and back to New). No build.
- **UI changes** (`packages/client/*`, `packages/codeply/client-*`): rebuild only that package, then the page reloads itself:

  ```sh
  pnpm exec tsc -b packages/client/ui-sidebar/tsconfig.json
  pnpm --filter @deepseek-ai/dsh-client-ui-sidebar run bundle
  ```

  (A package with a split config uses its `tsconfig.client.json`.)
- **A new host add-on that is loaded from `lib/`**: compile and bundle that one package:

  ```sh
  pnpm exec tsc -b packages/codeply/craft-cloud/tsconfig.json
  pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE host -F @codeply/dsh-craft-cloud
  ```
- **Craft's own files** (`main.js`, `app.js`, `dsh-engine.js`, the preloads): restart Craft.

DSH's own `pnpm run dev:web` watchers are not used: on an 8 GB PC they took about 2.5 GB, ran memory out, and served half-written bundles. A full build (`DSH_GATE_CONCURRENCY=1 pnpm run build`, about 3 minutes) is only needed before shipping or after many UI changes.

## Classic's chats on this harness

Craft's UI is Classic's again (the New tab and its Classic/New switch are retired). Classic's Build turns run on this engine over ACP: `dsh-chat.js` in the app root keeps one engine per project folder (at most two up), one DSH session per Craft chat (kept on the chat as `session.dsh` and resumed), routes the model through its own bridge (the model picked in Craft: Haze 2 or one of your own), answers `browser_check`, and turns DSH's events into the events Classic's chat already shows. The ACP client is `codeply-cli/lib/dsh-acp.mjs`, shared with the terminal app. Images, Plan and Ask, bots, goals and verification turns stay on Classic's agent for now, as does any turn when this engine can't start. `CODEPLY_CHAT_ENGINE=classic` turns the harness off.

## Running it

Needs Node 24.9 or newer and pnpm 11.

```sh
pnpm install
pnpm run build
```

Craft then starts it with `node apps/cli/lib/bin.js --profile web --no-open --host 127.0.0.1 --port 0`, `DSH_HOME=~/.codeply/dsh`, and the Haze bridge variables (`CODEPLY_HAZE_BRIDGE_URL`, `CODEPLY_HAZE_BRIDGE_TOKEN`).

The Claude Code subagent provider needs Claude Code installed and signed in on the PC; this fork does not bundle it.

## Not done yet

- Packaging: the installed app does not ship `craft-dsh` yet (it is excluded from the app files). It needs a Node 24 runtime or the single-exe build, plus `extraResources`.
- Craft-only features (Life, bots, the shared brain, phone relay, the design layer) are still Classic only. They move over as DSH plugins next.
