# Local intelligence: setup, configuration and API

## Turn it on (desktop app)

Nothing changes until a mode is picked. Settings live in
`~/.codeply/context/settings.json` and can be changed over IPC
(`context:set`) from any renderer:

```json
{
  "mode": "local",
  "model": "lfm3-1.7b-qad-q4",
  "localUrl": "", "localModel": "",
  "threads": 0, "ctx": 4096, "idleMinutes": 5,
  "minImportance": 0.35,
  "life": { "on": false, "sources": ["heard", "orbit", "calls", "gmail"] },
  "embed": { "on": false, "model": "nomic-embed-v1.5" }
}
```

| Key | Meaning |
|---|---|
| `mode` | `legacy` (default: the old code paths, unchanged), `cloud` (the chat route extracts, through the new guard and queue), `auto` (local model when it runs, else the chat route), `local` (local model, else rules; never the cloud), `rules` (no model), `off` (nothing is learned from chats) |
| `model` | An installed model id (`node scripts/context/fetch-model.mjs list`); empty = the first installed |
| `localUrl` / `localModel` | Use a server you already run instead (Ollama: `http://127.0.0.1:11434/v1`, `qwen3:1.7b`). Must be on this PC |
| `threads`, `ctx`, `idleMinutes` | Runtime: 0 threads = physical cores − 1; context size; stop the model after this many idle minutes |
| `minImportance` | Observations the model rates below this are not kept |
| `life` | Life items into long-term memory. Off by default; then only the sources listed **and** switched on in Life |
| `embed` | Meaning-based retrieval with a local embedding model |

Sensitive events (call summaries) are only ever read by a model on this PC,
in every mode.

## Install the runtime and a model

```bash
# llama.cpp (see RUNTIME.md for the pinned commit and release flags)
cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF && cmake --build build -j --target llama-server
mkdir -p ~/.codeply/runtime/bin && cp build/bin/llama-server ~/.codeply/runtime/bin/
# models (download from Hugging Face, hash recorded in ~/.codeply/models/manifest.json)
node scripts/context/fetch-model.mjs lfm3-1.7b-qad-q4   # the best model so far (MODEL-SELECTION.md)
node scripts/context/fetch-model.mjs nomic-embed-v1.5
```

`CODEPLY_LLAMA_SERVER` overrides the binary path, `CODEPLY_MODELS_DIR` the
model folder, `CODEPLY_CONTEXT_DB` the queue file.

## IPC (`context-desktop.js`)

| Channel | In | Out |
|---|---|---|
| `context:state` | – | settings, engine stats (queue counts, last run), runtime status (pid, RSS, starts), hardware, installed models, the last 30 events with backend, local or not, and brain actions (never their text) |
| `context:set` | settings patch | `{ ok, state }` or `{ ok: false, error }` (unknown mode, remote `localUrl`) |
| `context:process` | – | run up to 5 batches now |
| `context:undo` | event id | `{ forgotten: [memory ids], review: [memory ids] }` |

## Library API (`codeply-cli/lib`)

```js
const S = require('./context-schema.js');      // normalizeEvent, checkExtraction, extractionJsonSchema
const M = require('./context-model.js');       // createRulesProvider, createCloudProvider, createLocalProvider, runExtraction, routeFor
const EV = require('./context-events.js');     // openEventStore({ file, key })
const EN = require('./context-engine.js');     // createEngine({ store, brain, life, providers, settings })
const C = require('./context-collectors.js');  // exchangeEvent, lifeEvents
const RT = require('./local-runtime.js');      // hardware, models, createRuntime
const CR = require('./context-retrieval.js');  // createRetriever, llamaEmbedder

const engine = EN.createEngine({ store: EV.openEventStore(), brain: require('./brain.js'),
  providers: { rules: M.createRulesProvider(), local: M.createLocalProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:1.7b' }) },
  settings: () => ({ mode: 'local' }) });
engine.ingest({ source: 'chat', trust: 'user', text: 'User: I prefer pnpm\nAssistant: ok' });
await engine.process();
```

A new backend is any object with `info()`, `available()` and
`extract(input)` returning `{ answer }`; the guard and the brain do the rest.

## Tests

```bash
npm run test:context     # the context layer: 133 checks, no network, no model
npm run test:brain       # the brain, unchanged behaviour
npm run test:engine      # the agent loop
node scripts/life-test.mjs
```
