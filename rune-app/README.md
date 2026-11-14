# Codeply 4.0 on Rune

The native desktop UI for Codeply 4.0, built with [Rune](https://github.com/anomalyco/rune), a GPU UI
framework written in Rust. It is a shell: the engine stays in Node (`codeply-cli/` and `craft-dsh/`),
and this app talks to it over the local HTTP and SSE server in `codeply-cli/lib/server.mjs`. The
Electron app at the repo root is unchanged and keeps working.

Phase 1 builds the views of the 4.0 prototype (`design/workspace/`): Agents (the board, and the
default), Office (the same team as a pixel-art office), Chat, Code, Pull requests and Apps, plus
Settings. Each has its own icon in the left rail.

| | |
|---|---|
| Rune | `anomalyco/rune` at `b9c8a78e50ef80991e6a565d89116bc09ddd8a3a` (`dev`, 13 Nov 2026) |
| Rust | 1.99.1 (Rune's pinned toolchain; `rust-toolchain.toml` here pins the same) |
| Binary | `codeply`, 41.8 MB release (33.3 MB stripped), Linux x86-64 |

## Build and run

```bash
cd rune-app
cargo build --release
target/release/codeply
```

Linux needs `libxkbcommon-dev` and `libwayland-dev` to build, and `libxkbcommon-x11-0` to open a
window. Without a GPU, install `mesa-vulkan-drivers` and run with
`VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`. Windows needs only the MSVC build tools
rustup asks for. See Rune's README ("Depending on Rune") for the rest.

The app's own flags come after Rune's:

```bash
target/release/codeply --scene chat
```

`--scene` opens on a view: `board`, `appearance`, `office`, `office-drawer`, `office-inbox`,
`chat`, `chat-thread`, `code`, `prs`, `apps`, `settings`.

### Windows build

`.github/workflows/rune-windows.yml` builds `codeply.exe` on a Windows runner (MSVC) for every push
to `rune-v4` that touches `rune-app/`, and uploads `Codeply-Rune-windows-x64.zip` to the
`rune-windows-latest` pre-release. To check that a change still builds for Windows from Linux:

```bash
sudo apt-get install mingw-w64
rustup target add x86_64-pc-windows-gnu
cargo build --release --target x86_64-pc-windows-gnu --features live
```

### The engine (DSH), started for you

By default the app starts Codeply's engine itself and talks to it over local HTTP and SSE. The
engine is `sidecar/engine.mjs`, built into the binary and written to `~/.codeply/rune/` at launch.
It runs with the Node and the `codeply-cli` that the installed Codeply app ships
(`resources/dsh-runtime/node.exe` and `resources/codeply-cli`), so nothing else is installed:

- chats run on DSH (craft-dsh) through `codeply-cli/lib/dsh-acp.mjs`: one engine per project
  folder, one DSH session per chat, resumed after a restart; if DSH can't start, that reply runs
  on Classic and says so;
- the model is Haze 2 through dsh-acp's loopback bridge, signed in with the Codeply app's account
  (`~/.codeply/auth.json`), so no token reaches the engine;
- the API is `codeply serve`'s (`/session`, `/session/:id/message`, `/event` with Last-Event-ID,
  `/permission/:id`), plus `text_delta` events for DSH's streamed replies;
- it listens on 127.0.0.1 on a port picked per launch, every request needs a per-launch secret,
  and it exits when the app does (the app holds its stdin).

`src/engine.rs` finds the engine: `CODEPLY_CLI_PATH`, else the installed app's `resources/`
(`%LOCALAPPDATA%\Programs\Codeply Craft`, Program Files, the uninstall entry's InstallLocation,
`/Applications`, `/opt`), else a source checkout above the binary. Without one the app shows the
sample data and says why. `--store mock` forces the sample data; headless runs use it unless
`--store engine` is given.

Models: the composer's model chip opens a menu of Haze 2 (the default) and the models you added,
with the picked model's effort; Settings > Models lists them, adds your own (any OpenAI-compatible
base URL, model id and key, tested with a real request first, "Use on my phone" sync as in the
Electron app), and finds what Ollama has pulled. The list is `~/.codeply/config.json`, the Electron
app's file, served by `sidecar/ext-models.mjs`; `routeFor` in `engine.mjs` runs each turn on the
picked model, on DSH (through the bridge's `/haze`, as `dsh-chat.js` does) and on Classic. Keys
never come back to the app: it gets `hasKey` and a short preview. Not carried over: the ChatGPT
plan sign-in (Electron's menu dropped it too) and Claude Code (an agent tool, not a model).

What the engine covers: the Chat sidebar, transcripts (streaming), sending from every composer
(Wisp and each helper get a chat of their own), and approvals. Agents, Board, Office, Pull requests
and Apps still show sample data: the engine has no API for them yet. Shape and colour picks aren't
saved yet.

`--store live --server URL --token PW` talks to a `codeply serve` you run yourself instead.

## How it's put together

```
src/
  main.rs          AppSpec, scenes, flags
  app.rs           state and handlers (views, drawer, composers, Escape, Ctrl K)
  shell.rs         titlebar with the Ctrl K search, the 60 pt rail, sidebar, main area
  theme.rs         tokens from styles.css (surfaces as the 4.0 prototype deepens them)
  ui.rs            buttons, pills, segments, composer, sidebar rows, motion helpers
  bot.rs           Wisp and helpers at interface sizes (port of design/icons/codeply-icons.js)
  icons/pack.rs    icons.js ported to Rune icons (generated: node tools/gen-icons.mjs)
  model.rs         what the views show (Snapshot)
  store/           Store trait, MockStore, LiveStore (feature "live")
  views/           office, office_art, board, chat, warp, code, prs, apps, settings
  tests.rs         the app driven through Rune's headless runtime
```

- **Icons.** `tools/gen-icons.mjs` reads `icons.js` and writes Rust statics, resolving names the
  way `icon()` does (`oai-*` and Codex icons filled, the rest 2-unit round strokes). Each draws at
  its grid size (24, or 20 for the 20-grid OAI set) so edges land on whole pixels. Interface icons
  take the text colour; only agents have colour. App logos are 14 simple-icons (CC0), vendored in
  `tools/simple-icons/` instead of fetched from a CDN.
- **Bots.** Flat, solid colour, one silhouette each: Wisp's hexagon (Codeply blue, upright white
  pill eyes), and for helpers a circle, squircle, cloud, rounded triangle, drop or pebble. Helper
  eyes follow the Grok bot (as measured by the open-source bloub recreation): two white capsules set
  toward where the bot looks, leaning with its gaze, the far one narrower. Eyes are alive: they
  drift between glances and blink (0.18 s), eased out with no overshoot, on `Live` values, so the
  view never rebuilds for them. State shows in the eyes: rolled up while thinking, narrowed while
  waiting, shut asleep, and a small hop while working. The "more" button on an agent's row in
  the Agents list opens its Appearance, where you pick its shape and colour; every view follows,
  the Office's pixel sprites included. Settings > Your team shows the whole team read-only. Accessories (beret, bow tie, headphones,
  glasses and more) are drawn and available, but the default team wears none.
- **The Office** is pixel art drawn in code (`views/office_art.rs`), my own, not from a sprite
  sheet: wood floors, a checkered kitchen, a carpeted lounge, wallpapered walls with windows,
  posters and a clock, desks with monitors, bookshelves, plants, a coffee machine and fridge, a
  sofa on a rug, a beanbag, and the Needs you counter with a queue display. It is 300 x 180 art
  pixels, one per 4 units of the prototype's 1200 x 720 office, so every room and agent sits where
  `views.js` puts it. It scales by a whole number of device pixels with nearest-neighbour, so art
  pixels stay square. Each agent is a small canvas redrawn only when its frame changes, on an 8 fps
  clock that runs only while Office is showing:
  - working: at a desk, hopping, eyes glancing, its monitor glowing with code;
  - thinking: at the coffee machine with a steaming mug, eyes rolled up, glancing side to side;
  - waiting: at the Needs you counter, swaying, with a "Needs your OK" bubble;
  - sleeping: on the sofa, eyes shut, breathing, z's drifting up;
  - walking: Docs walks the corridor from the Studio to the kitchen and back (the prototype's
    16 s path), on whole art pixels, looking where it goes.

  Hover an agent for its current action; click it for its drawer (live session or latest chat,
  and a compact composer). Escape, the close button or a click on the office closes it.
- **Motion.** Views and list rows enter with ease-out (0.28 s, no bounce) and rows stagger by
  35 ms. Rune springs are interruptible by design. Reduced motion holds the Office still and Rune
  turns travel into fades.

## Checking it headlessly

```bash
tools/snap.sh                        # every scene at 1440 x 900 into screenshots/rune-v5/
python3 tools/side-by-side.py        # prototype | Rune into screenshots/side-by-side/
```

`screenshots/prototype/` holds the target: the HTML prototype at 1440 x 900, captured with
`tools/prototype-shots.js` (Playwright) after `node design/serve.js 5197`. Fonts differ a little:
the prototype on Linux falls back to the system UI font, Rune to its bundled Inter.

`cargo test` drives the real view through Rune's runtime: every scene lays out, the rail switches
views, clicking an agent opens its drawer and Escape closes it, the walker moves, and a drawer
message lands in the session. The live store has an opt-in test against a running engine:

```bash
CODEPLY_SERVER=http://127.0.0.1:4777 CODEPLY_TOKEN=... cargo test --features live -- --ignored
```

## Memory

Resident memory (VmRSS) of the release build with the mock store, 20 s after opening, sitting
still, in a 1440 x 900 window. Measured on Linux under Xvfb with Mesa's software Vulkan
(lavapipe), because this machine has no GPU. `tools/rss.sh` repeats it.

| View | RSS | of which lavapipe's code (LLVM) | lavapipe's "GPU memory" (memfd) | the rest |
|---|---|---|---|---|
| Office | 175 MB | 64 MB | 33 MB | 78 MB |
| Chat | 183 MB | 64 MB | 33 MB | 86 MB |
| Code | 171 MB | 64 MB | 30 MB | 77 MB |
| Rune's `hello` example, same setup | 135 MB | 64 MB | 6 MB | 66 MB |

On a real GPU, lavapipe's 64 MB of LLVM goes and its "GPU memory" moves to the card, but the real
driver's own user-space part comes in, so expect roughly 90 to 130 MB. That is inside the 100 to
150 MB target and well under the Electron app's 370 MB, but it is an estimate until it is measured
on Windows with a GPU (phase 2). Memory stays flat over two minutes of the Office animating.

One finding from measuring: a single `.rotate()` on an 8 pt square (the bubble's tail) cost 33 MB
of heap here, because Rune draws turned elements through an offscreen layer. The tail is now a
vector triangle.

## Known Rune gaps, and what phase 1 does about them

- **No webview.** Wisp's browser, agent tabs and the Design tab need a Chromium view opened on
  demand. Settings has a placeholder card for where they will go. Nothing is faked.
- **Loops.** Rune's periodic motion is opacity, rotation, one-way slides (in fractions of the
  element's size, wrapping) and opacity or scale keyframes. There is no there-and-back offset loop,
  so a bob or sway can't be a loop. The Office draws those as pixel frames on its own clock and
  moves the bubble with a `Live` value; list bots hop with a scale keyframe instead of a lift.
- **Image filtering is bilinear only.** There is no nearest-neighbour (`image-rendering:
  pixelated`), so pixel art is scaled up on the CPU by whole device pixels and redrawn when the
  size or display scale changes.
- **Text input exists.** Every composer and the Ctrl K search are real Rune text fields with IME,
  undo and selection. The search field doesn't search yet.
- **Linux window frame.** Rune's custom titlebar removes the native title bar on Windows and draws
  real caption buttons; Linux keeps its native frame. The app draws Windows-style stand-ins only
  in headless renders, so screenshots match the prototype.
- **Windows without a working GPU.** Rune opens each window on its CPU renderer and hands it to
  a GPU swap chain a moment later. On a PC with no graphics card (WARP or the basic display
  driver) that hand-over drew broken frames: text and icons gone, the content shrunk, clicks
  falling through. On Windows the app now stays on Rune's CPU renderer (`RUNE_CPU_FIRST=only`, set
  at the start of `main`); `CODEPLY_GPU=1` restores the GPU path. Nothing in the UI needs the GPU
  (the Chat home's cards are solid instead of frosted for this), and the window opens maximized,
  since Rune has no API for the display's size. The hand-over bug is Rune's to fix.
- **Fonts.** The UI font is "Segoe UI Variable Text", then Segoe UI, SF Pro Text and Rune's
  bundled Inter. Monospace (editor, terminal, diffs only) follows the system's.

## Licenses

Rune is MIT (`licenses/rune-MIT.txt`). The binary includes Inter, which Rune bundles (SIL OFL 1.1,
`licenses/Inter-OFL.txt`). The vendored app logos are simple-icons 13.0.0, CC0
(`licenses/simple-icons-CC0.txt`). This crate is MIT like the rest of the repo.
