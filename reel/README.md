# Codeply Reel

A headless video editor and motion-graphics studio for AI agents, written in Rust. It is made for
commands, not mouse work. One process runs two open-source engines:

| Namespace | Engine | What it does |
|---|---|---|
| `cut.*` | [FilmCraft](https://github.com/storytold/filmcraft) (Premiere Pro-style) | import, bins, sequences, timeline edits, transitions, colour, audio, captions, export (H.264 / HEVC / ProRes / AV1 …, no FFmpeg) |
| `fx.*`  | [EffectCraft](https://github.com/storytold/effectcraft) (After Effects-style) | compositions, layers, keyframes, expressions, 300+ effects, 3D, tracking, render queue |
| `reel.*` | Codeply Reel | cross-engine commands, search, compact state, diffs, text frame probes |

Agents don't drag clips or read screenshots. They send a few short command lines and get
replies sized for a context window.

## Quick start

```sh
cd reel
cargo build --release            # first build compiles both engines (~800k lines), ~20–40 min
./target/release/reel help
```

```sh
# one shot; --ws keeps both projects in a folder between calls
reel run --ws ./proj 'cut.file.newSequence width=1920 height=1080 name=Main'
reel run --ws ./proj 'fx.comp.new name=Title width=1920 height=1080 duration=4 ; fx.layer.newText text="Hello" size=160 fill=#ffffff'
reel run --ws ./proj 'reel.fx2cut comp=Title track=V2 seconds=0 ; reel.probe engine=cut t=1'
reel run --ws ./proj 'cut.file.exportMedia path=out.mp4 wait=true _select=result.frames'
```

### Ways in

| Mode | Command | For |
|---|---|---|
| One shot | `reel run [--ws DIR] 'script'` (or `@file`, or `-` for stdin) | shell-driving agents, CI |
| Session | `reel sh [--ws DIR]`: one script per stdin line, one JSON reply per line | long agent loops, no process start-up cost |
| MCP | `reel mcp [--ws DIR]`: **two tools** (`run`, `look`) | Claude Code / any MCP client |
| HTTP | `reel serve [--port 7070] [--ws DIR]`: `POST /api/run` + dashboard at `/` | remote agents, humans watching |

```sh
claude mcp add reel -- /abs/path/reel/target/release/reel mcp --ws /abs/path/proj
curl -s -XPOST -H 'X-Reel: 1' http://127.0.0.1:7070/api/run --data-binary 'reel.find q=razor'
```

The HTTP server listens on `127.0.0.1` only, checks the `Host` header, and only accepts
`POST /api/run` with an `X-Reel: 1` header. A web page can't send that header to another
origin, so it can't drive the studio.

## The command language

```text
cmd key=value key2=[a,b] key3.sub=1      # values are JSON when they parse, else text
cmd {"key": "value"}                      # or a whole params object
{"cmd": "cut.timeline.razor", "params": {"seconds": 3.5}}   # or a JSON line
a ; b ; c                                 # several steps on one line
fx.layer.newShape kind=ellipse name=Ring
fx.prop.addKey layer=$1.layer path=transform/opacity time=0 value=0   # $1.layer = step 1's reply .layer, $-1 = previous step
```

- A bare command id (`timeline.razor`) goes to whichever engine has it. Ids that both engines
  have (`file.import`, …) must say `cut.` or `fx.`.
- A script stops at its first failing step and says which one:
  `{"ok":false,"at":3,"cmd":"…","err":"…","r":[results so far]}`.
- Meta params on any step: `_select=tracks.*.items.*.clip` keeps only those fields,
  `_budget=N` caps the reply's tokens (default 1500; `0` = no cap), and `_raw=true` turns
  pruning off.

### `reel.*` commands

| Command | Reply |
|---|---|
| `reel.find q=<words> [engine=cut\|fx] [limit=20]` | one line per matching command: `cut.timeline.razor \| Razor \| {"time":ticks,…}` |
| `reel.describe cmd=<id>` | full parameter doc for one command |
| `reel.state [_select=…]` | both projects, pruned (also sets the diff baseline) |
| `reel.diff` | only what changed since the last `state` / `diff`, as `[path, old, new]` |
| `reel.probe [engine] [t] [comp] [ascii=48]` | frame stats as text: luma mean/σ/min/max, mean RGB, % black/white/clear, 3×3 luma grid, top colours, detail, 64-bit perceptual hash, optional ASCII thumbnail |
| `reel.compare a=<hash> b=<hash>` | distance between two probe hashes: same / similar / different |
| `reel.frame out=x.png [engine] [t] [comp] [max]` | writes a PNG and replies with its path, not its pixels |
| `reel.fx2cut comp=<name\|id> [track] [seconds]` | renders an fx comp to ProRes 4444 (with alpha), imports it into the cut, and places it on the timeline (or makes a sequence from it) |
| `reel.save dir=` / `reel.open dir=` | `<dir>/cut.fcproj` + `<dir>/fx.ecproj` |
| `reel.log [n]`, `reel.reset`, `reel.help` | |

## Token economy

Measured on the end-to-end session in this repo (one sequence, one title comp):

| To learn… | The usual way | Reel | 
|---|---|---|
| what an edit changed | re-read the whole state: ~980 tokens | `reel.diff`: ~200 tokens (and it stays small as the project grows) |
| what a frame looks like | 1280×720 screenshot: ~1,200 vision tokens | `reel.probe`: ~60 tokens |
| whether two frames match | two screenshots | compare two `hash` fields |
| which command to use | every tool schema in context on every turn | 2 MCP tools (~400 tokens) + `reel.find` on demand |
| a 600-clip timeline | a reply that floods the context | an outline (`{"tracks":"[12]",…}`) and a hint to `_select` |

Every reply is pruned (no nulls, empty lists or long float tails). Added or removed objects in a
diff show only their scalar fields, and a list that only grew reports just the new items.

## Dashboard

`reel serve` serves a live dashboard for the people watching the agents: commands run, errors,
reply tokens per command, time per command, the command log with errors inline, a frame preview
that re-renders on every revision, the document summary, and a console. The dashboard's own
preview renders are not counted in the agent's numbers.

## Layout

```
reel/
  Cargo.toml              workspace; upstream engines pinned by git rev (+ effectcraft's hayro-syntax patch)
  crates/reel-core/       Studio (both sessions + routing + reel.* commands), DSL, compaction/diff, frame probes
  apps/reel/              the binary: run / sh / mcp / serve, and the embedded dashboard
```

Both engine sessions live on one worker thread (`reel_core::Handle`). Every front end sends
scripts to it over a channel, so the MCP server, the HTTP API and the shell all see the same
project. An engine panic becomes an `internal error` reply, and the session keeps running.

To update the engines, bump the `rev`s in `Cargo.toml` and run `cargo test`.
`crates/reel-core/tests/e2e.rs` runs a whole session through both engines: it builds a title
comp, bridges it into the cut and checks the picture hash matches, diffs, razors, exports an
MP4, and round-trips the workspace.

## Licence

MIT (see `../LICENSE`). FilmCraft and EffectCraft are © the ArtCraft Team and contributors,
under MIT OR Apache-2.0. See `NOTICE`. The ArtCraft name and logos are their trademarks and are
not used here.
