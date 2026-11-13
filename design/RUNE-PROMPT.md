# Build Codeply 4.0 on Rune

You are building the native desktop UI for Codeply 4.0 with Rune (github.com/anomalyco/rune), the pre-release Rust GPU UI framework from the OpenCode team. Work in this repo (AwaisSDev/Codeply-Craft). First run `git fetch origin v4-design && git checkout v4-design`: that branch has the design files this brief points to. Then create a branch `rune-v4` from it, and open a draft PR into `v4-design` when phase 1 is done.

## What Codeply is
- Codeply is the app; Wisp is the personal agent inside it (a blue flat-topped rounded hexagon, #2f6bff, white pill eyes). Wisp leads a team of helper agents, which are the user's own Claude Code agents.
- The current app is Electron (index.html, app.js, styles.css, icons.js). It stays and must keep working. Do not change it.
- The engine is Node: `codeply-cli/` plus `craft-dsh/` (TypeScript, Node 24). It is NOT being rewritten. The Rune app is a native shell that talks to the engine as a sidecar over the local HTTP + SSE server in `codeply-cli/lib/server.mjs`.
- Rune has no webview. Browser surfaces (Wisp's browser, agent tabs, the Design tab) will later use a Chromium view opened only on demand. For now, leave a clean placeholder for them.

## The design to build (source of truth)
Read these first. They are a finished web prototype of exactly what to build:
- `design/workspace/index.html`, `design/workspace/views.js`, `design/workspace/views.css`: the shell and all five views.
- `design/icons/codeply-icons.js`: the Wisp bot drawing (hexagon, eyes, accessories: beret, headphones, glasses, sprout, antennae, cap).
- `icons.js` (repo root): the app's own interface icon pack. Port these SVG paths.
- `styles.css` (repo root): colour, radius and font tokens of the shipping app.
- `V4-UI-REFERENCES.md`: the design study and motion rules.

Run the prototype to see it: `node design/serve.js 5197`, then open `http://localhost:5197/workspace/`. Screenshot every view and keep those screenshots as your target.

## Phase 1 scope
1. Setup: install the Rust toolchain in this environment, clone anomalyco/rune, read its README, PLAN.md, examples and `rune-kit`. Pin the exact Rune commit you build against and note it in the README.
2. Create a `rune-app/` crate (Cargo workspace member) in this repo. Do not touch other folders except to add it to docs.
3. Shell: Windows-style titlebar with the Ctrl K search bar, a 60 px left rail (Office, Chat, Code, Pull requests, Apps, then Settings at the bottom), a contextual sidebar (hidden on Office), and the main area. Dark theme with the tokens from `styles.css`. UI font: Segoe UI Variable, then system sans.
4. Office (the default view): make it a pixel-art office in the spirit of "Star Office UI": warm wood floors, checkered kitchen tiles, a carpeted lounge, wallpapered back walls with windows and posters, desks with monitors, bookshelves, plants, a coffee machine, a sofa, a rug, and a "Needs you" counter. Draw your own art; do not copy any existing project's sprites. Rooms and positions match `views.js` (Studio, Wisp, Kitchen, Lounge, Needs you). Agents are the Wisp hexagon bots, pixel-rendered, each in its own colour with its accessory. State is shown by place and motion:
   - working: at a desk, hopping, monitor glowing with code;
   - thinking: at the coffee machine, three dots over the face, a steaming mug;
   - waiting: at the Needs you counter with a "Needs your OK" bubble, swaying;
   - sleeping: on the sofa, eyes closed, floating z's;
   - walking: moving along the corridor between rooms.
   Hovering an agent shows its current action. Clicking one slides in a right-hand drawer with its live session or latest chat (see `session()` in `views.js`) and a compact composer. Escape closes it. Keep an Office / Board toggle; Board is the list view.
5. The other views as static screens that match the prototype: Chat (home with the dithered warp art, the hexagon, "What should we build in launch-site?", composer and bento cards, plus a transcript view), Code (file tree, tabs, editor, terminal, agent pane), Pull requests (list, agent summary, diff, checks, merge), Apps (search across 34,000 apps, connected apps, popular apps, recent actions).
6. Data: a `Store` trait with a mock implementation that returns the prototype's sample data. Then read `codeply-cli/lib/server.mjs` and sketch a second implementation that calls the real endpoints and SSE stream. Wire it behind a flag; it is fine if it is partial in phase 1.
7. Icons: port `icons.js`. Draw each icon at its grid size (20 px for the 20-grid set, 24 px for the 24-grid set) on whole pixels, so they render sharp. Interface icons are monochrome; colour belongs only to the agents.

## Rules
- No em dashes anywhere: UI copy, comments, docs, commit messages. Use commas, colons or full stops.
- No monospace in UI rows, labels or buttons. Monospace only inside the code editor, terminal and diffs.
- No little status dots in pills, buttons or labels.
- Naming: only "Codeply" and "Codeply CLI". Wisp is the agent. Never call Codeply a personal agent.
- The repo is public and MIT. Keep license notices for Rune and anything you vendor. Never add secrets, API keys or private routing code (Haze) to this repo.
- Do not modify `craft-dsh/` core, the Electron app files, or `codeply-cli/` behaviour.
- Motion: ease-out for anything entering, list stagger of 30 to 40 ms, interruptible animations, respect reduced motion.

## Verify before you hand back
- Use Rune's headless mode to render every view to PNG at 1440 x 900. Put them in `rune-app/screenshots/` next to the matching prototype screenshots, compare side by side, and fix differences until they match closely.
- Measure idle memory of the Rune app (RSS) with the mock store and write the number in the README. For reference: the Electron app idles around 370 MB, the target is about 100 to 150 MB.
- `cargo build --release`, `cargo clippy` and `cargo test` pass.

## Deliverables
- Branch `rune-v4` with `rune-app/`, a README (build and run steps, pinned Rune commit, memory numbers, known Rune gaps such as webview and text input), the screenshots, and a draft PR whose description shows the side-by-side images.
- In the PR, list what you could not do in Rune and why, instead of working around it with hacks.
