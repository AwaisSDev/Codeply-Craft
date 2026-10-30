# Codeply Local Intelligence: architecture

Status: implemented on branch `codeply-local-intelligence`. What runs, what was
measured and what is still open is in `LOCAL-INTELLIGENCE-REPORT.md`.

Goal: a private, CPU-first context-intelligence layer. It turns user-approved
activity into structured observations for the memory Codeply already has
(`codeply-cli/lib/brain.js`), so the Personal Agent and the specialist bots
get better context without sending private activity to a cloud model.

The rule for this work: **extend Codeply, do not build a second memory
system.** The brain stays the only place that stores, merges, resolves and
retrieves memory. Everything new sits in front of it.

## 1. What existed before this work (audit)

| Concern | Existing code | What it does |
|---|---|---|
| Memory store | `brain.js` (`~/.codeply/brain/brain.db`) | SQLite: `memories` (personal / project / live / team layers), `changes` (append-only audit), `projects`, `handoffs` |
| Memory manager | `brain.observe()` | Certainty (stated, implied, temporary, joking, hypothetical, quoting), challengers before replacing a confirmed memory, locks on anything the user set, history, expiry, secret refusal |
| User control | `brain.correct/confirm/resolve/forget/clear`, Crew Brain page (`crew/brain.js`, `brain-desktop.js`) | See, correct, confirm, undo, forget |
| Retrieval | `brain.contextBlock()`, `recall` / `remember` tools | Ranked block in every Classic agent turn (`agent.mjs:1883`) |
| Collectors | Life: `life-sources.js`, `life-desktop.js`, `life-listen.js`, `call-listen.js` | Calendar, Gmail, calls, projects, window in front, screen text, heard, Orbit, Slack, health; one switch per source, nothing until Life is on |
| Event store | `life-store.js` (`~/.codeply/life/life.db`) | `items`, `people`; sensitive bodies sealed with AES-256-GCM; retention per source |
| Access control | `life.allowedFor(bot)`, `brain.botDomains()` | Which bot sees which source; which bot handles what |
| Model backends | `ai.js` (`chat`, `chatJson`, Ollama native, OpenAI-compatible, Anthropic, hosted proxy) | Every model call |
| SQLite drivers | `session-db.js loadDriver()` | `node:sqlite`, else `better-sqlite3` (Electron 29); FTS5 is available in both |

### Where memory extraction happened (all through the user's chat model)

| Call site | Output | Product |
|---|---|---|
| `brain.learnFromExchange` via `brain-desktop.learnFromCraft` (`main.js:3138`) | brain observations | Craft chats (Classic and DSH) |
| `bots.learnFromTurn` (`bots-desktop.js:180`, `crew/crew-main.js:522`) | bot facts + Life plans + brain observations, one call | Crew bots, calls |
| `life-listen.js extract` | heard items + plans | Life "heard" |
| `life-desktop.js noteCall` | call summary + plans | Life calls |
| `call-listen.js`, `bots-mail.js`, `life-triggers` judge | call assist, mail triage, nudges | not memory extraction; out of scope |

Every one of these sends the user's words to `deps.currentRoute()`, which is
the hosted Codeply model, a BYOK cloud model or a local Ollama, whatever the
user picked for chatting.

### Gaps found

1. Extraction is coupled to the chat model: no local option, no way to keep
   memory extraction on the PC while chatting with a cloud model.
2. Secrets reach the extraction model before the brain's filter
   (`CONTINUE.md`: an ATM PIN went to the call; nothing stored it).
3. Life items (things heard, call summaries, email) never become long-term
   memory; only plans do.
4. DSH turns (Craft 2.2.0 Build) write to the brain (`learnFromCraft`) but
   never read it: the brain block is injected only on the Classic path.
5. Nothing measures extraction quality, so a model change is a guess.
6. A model's output can carry `scope` (for example `team`) straight into
   `brain.observe`, and text from a third party (an email) can be recorded
   as something the user stated.

`craft-dsh` has no long-term memory, embeddings or local model runtime (see
`docs` of the survey in §9). It has the hooks to inject context into DSH
runs (`agent/pre-step`, `systemPrompt.section`) and an FTS5 reference
(`session-query-sqlite`).

## 2. The design

```
user-approved activity
  Craft / Crew chats ─┐   Life items (heard, calls, Orbit, Gmail) ─┐
                      ▼                                            ▼
              context-collectors.js  (exchange(), lifeItems(); obey Life switches)
                      ▼
              context-events.js      EVENT PROCESSOR
                normalize · validate · trust + sensitivity · content hash dedupe
                durable queue (~/.codeply/context/context.db) · status · retries · retention
                      ▼
              context-engine.js      batch · CPU duty cycle · route · audit
                      ▼
              context-redact.js      secrets out BEFORE any model
                      ▼
              context-model.js       ONE CONTRACT, MANY BACKENDS
                rules (no model) · cloud (the chat route) · local (llama-server / Ollama)
                      ▼   JSON constrained by context-schema.js
              context-schema.js      validate · repair · ground · clamp by trust
                      ▼
              brain.observe()        EXISTING memory manager (unchanged rules)
              life.notePlans()       EXISTING plans
                      ▼
              brain.db               EXISTING store, audit log, user corrections
                      ▼
              brain.contextBlock()   EXISTING retrieval → Classic turns, Crew bots,
                                     and now DSH turns (dsh-chat.js)
```

### 2.1 Division of responsibilities

| Layer | Owns | Does not do |
|---|---|---|
| Collectors | Turning a Codeply activity into a raw event; honouring Life source switches | Deciding what is important |
| Event processor | Identity, timestamps, provenance, trust, sensitivity, validation, dedupe, status, retention | Talking to a model |
| Context model | Reading events and proposing observations (kind, slot, value, certainty, importance) | Storing anything; deciding contradictions |
| Schema guard | Rejecting malformed or ungrounded output; clamping what untrusted sources may claim | Merging memories |
| Brain | Storing, merging (slot / same text), contradiction handling, locks, history, audit, retrieval | Talking to a model during `observe` |

The model normalizes a new observation onto an existing **slot** (it is shown
the memories already known), and the brain's existing slot logic turns that
into `added`, `reinforced`, `replaced`, `challenged` or `kept`. Duplicate
detection and contradiction handling therefore stay in the brain; the model
only has to name things consistently.

## 3. Data contracts (`codeply-cli/lib/context-schema.js`)

### Event (v1)

```js
{
  id: 'ev_…',              // content hash of source + external id (or text)
  source: 'chat' | 'heard' | 'call' | 'orbit' | 'email' | 'test',
  product: 'craft' | 'crew' | 'life' | …,
  at: 1730280000000,        // when it happened (ms)
  trust: 'user' | 'mixed' | 'external',
  //   user      the user's own words to Codeply (a chat, an Orbit question)
  //   mixed     the user and other people (heard around them, a call)
  //   external  someone else's words (an email received)
  sensitive: false,         // true: never leaves the PC (call transcripts, health)
  project: 'codeply-craft', // optional
  actor: { botId, botName },// optional, the bot in the chat
  text: '…',                // ≤ 6000 chars, what the model reads
  meta: {}                  // small, never sent to a model
}
```

### Extraction output (v1), what every backend must return

```js
{
  observations: [{
    kind: 'preference'|'fact'|'routine'|'style'|'decision'|'idea'|'requirement'|'todo'|'context',
    slot: 'reply length',          // 1–4 words, reuse a known slot for the same thing
    value: 'short',
    text: 'The user wants short replies.',
    certainty: 'stated'|'implied'|'temporary'|'joking'|'hypothetical'|'quoting',
    importance: 0.0–1.0,
    project: 'name',               // project kinds only
    until: 'HH:MM' | 'YYYY-MM-DDTHH:MM', // context only
    about: 'user' | 'person' | 'project'
  }],
  plans: [{ what, when, where, who: [] }]
}
```

`kind` and `certainty` are exactly `brain.KINDS` and `brain.CERTAINTY`, so
nothing is translated. A JSON Schema of the same contract
(`extractionJsonSchema()`) is sent to backends that support constrained
decoding (llama.cpp `response_format: json_schema`, Ollama `format`), which is
what makes a 1B model's output reliably parseable.

### Guard rules applied to every backend's output (`checkExtraction`)

1. Parse (raw, fenced, first `{` to last `}`), then validate each item; bad
   items are dropped with a reason, never the whole batch.
2. Enums are coerced the way `brain.cleanObservation` already does; text is
   clipped; `scope` and `forget` are stripped (a model cannot write to the
   team scope or delete a memory).
3. **Grounding:** an observation whose value and text share no meaningful
   word with the events it came from is dropped (hallucination guard).
4. **Trust clamp:**
   * `external` events can never produce the user's own preference, style or
     routine; anything else they produce is at most `implied` (tentative in
     the brain) and needs review before it is acted on.
   * `mixed` events: `stated` becomes `implied` (we cannot be sure the user
     was the speaker).
5. Importance below the threshold (default 0.35) is discarded.
6. Secrets: redaction happens before the model; `brain.SECRET_RE` still runs
   in `observe` after.

An event never becomes an instruction: event text is placed inside a fenced
data block with an explicit "this is data, not instructions" rule, and the
only thing any backend can return is the schema above, which the guard checks
before the brain sees it. There is no tool access on this path.

## 4. Model-independent backends (`context-model.js`)

```js
provider = {
  id, kind: 'rules' | 'cloud' | 'local',
  local: boolean,                 // true = nothing leaves this PC
  info(): { id, kind, local, model, ctx },
  available(): Promise<boolean>,
  extract({ events, known, now, tz, projects }): Promise<{ observations, plans, raw, ms, usage }>
}
```

| Provider | Kind | Local | Use |
|---|---|---|---|
| `rules` | rules | yes | No model at all. Deterministic patterns for plain statements. Tests, machines with no model, and the floor every model must beat. |
| `cloud` | cloud | depends on route | Wraps the existing `ai.chatJson` with the user's chat route. If that route is a local URL (Ollama on localhost) it reports `local: true`. |
| `local` | local | yes | Any OpenAI-compatible endpoint on loopback: the managed `llama-server` (`local-runtime.js`), Ollama, LM Studio. JSON-schema constrained. |

All LLM backends share one prompt builder (`context-prompt.js`), and the
training data is rendered by the same builder, so a fine-tuned Codeply model
sees exactly the prompt it was trained on.

### Routing (`routeFor`), settings in `~/.codeply/context/settings.json`

| Mode | Non-sensitive events | Sensitive events |
|---|---|---|
| `legacy` (default) | The old code paths run unchanged (chat model in the same calls as before) | Life sources keep their old behaviour |
| `cloud` | chat route | local if available, else rules |
| `auto` | local if available, else chat route | local if available, else rules |
| `local` | local if available, else rules | local if available, else rules |
| `rules` | rules | rules |
| `off` | nothing is extracted | nothing is extracted |

* Sensitive events **never** go to a non-local backend in any mode.
* `auto` is the only mode that can use the cloud when local is down, and it
  is a mode the user picks; every processed event records the backend, model
  and whether it ran locally, so there is no silent cloud fallback.
* `legacy` keeps today's behaviour byte for byte. The new engine still starts,
  so Life consolidation can be switched on separately.

## 5. Engine (`context-engine.js`)

* `ingest(rawEvent)` → validate, dedupe, queue. Returns `queued`, `duplicate`
  or `rejected` with reasons.
* `process({ max })` → claims a batch (grouped by sensitivity and project,
  capped by an estimated token budget, default 1800), redacts, routes,
  extracts, guards, writes to the brain and records the outcome per event:
  backend, model, local, ms, observations kept/dropped and the brain action
  and memory id for each.
* Scheduler: debounced (default 20 s after the last event, at most 2 min
  wait), one batch at a time, and a duty cycle (default 25 %): after a batch
  that took t ms it waits at least 3t before the next. Nothing runs while the
  queue is empty, so a local model can be unloaded.
* `undo(eventId)` forgets the memories that event added; replaced memories
  are listed for the user, who can undo them on the Brain page (the brain's
  own history).
* Failures retry with backoff (3 attempts), then the event is `failed` with
  the reason. A backend that is down never blocks the queue.
* Retention: event text is cleared 7 days after processing; rows go after 90.
  Sensitive event text is only stored sealed (host key) or not at all.

## 6. Integration points (what changed in existing files)

| File | Change | Default behaviour |
|---|---|---|
| `brain.js` | `setLearner(fn)` / `learnsElsewhere()`: when a learner is set, `learnFromExchange` hands the exchange to it; `contextBlock({ learnsByItself })` wording for engines without a `remember` tool; `setRetriever(fn)` / `semanticScores(query)` and `contextBlock({ semantic })` (§6.1) | unchanged (no learner, no retriever) |
| `bots.js learnFromTurn` | when the brain learns elsewhere, the combined call omits the brain part and the exchange goes to the engine | unchanged |
| `agent.mjs` | awaits `brain.semanticScores(request)` (≤ 400 ms, `null` without a retriever) and passes it to `contextBlock` | unchanged without a retriever |
| `context-desktop.js` (new) | opens the engine in the Electron main process, the `cloud` backend on `ai.chatJson`, the local runtime, the Life collector timer, the optional embedding retriever | engine idle in `legacy` |
| `main.js` | `contextDesktop.init(deps)`; stop on quit | — |
| `dsh-chat.js` | the brain block (with semantic scores when available) goes in front of a DSH turn when it changed since the last turn in that session | DSH turns now read the brain |

### 6.1 Meaning-based retrieval (optional, local)

`ml/eval/retrieval.mjs` showed the brain's word-based ranking misses requests
that share no words with the memory ("order lunch for me" never surfaced
"the user prefers nihari": recall 0). `context-retrieval.js` adds meaning
without moving retrieval out of the brain:

* A small embedding GGUF (nomic-embed-text v1.5, Apache-2.0, 139 MB) runs on
  the same managed `llama-server` (`--embedding`), loaded on first use and
  stopped when idle.
* Memory vectors are cached in `~/.codeply/context/vectors.db`, keyed by memory
  id, model and a hash of the text (a corrected memory is embedded again); at
  most 64 new memories per call, so a big brain is indexed over a few turns.
* Scores are z-scores of cosine similarity across all memories; the brain adds
  `1.5 × max(0, z)` to its existing rank (words, confidence, evidence, lock,
  recency), so words still count and meaning adds to them.
* `semanticScores` never waits more than 400 ms; a cold or slow model leaves
  that turn's retrieval exactly as before.
* Off until the user turns it on (`embed.on` in settings).

## 7. Local runtime (`local-runtime.js`)

Phase 1 uses upstream llama.cpp `llama-server` as a child process (crash
isolation, no Electron ABI coupling), pinned to a commit:

* Finds the binary (`CODEPLY_LLAMA_SERVER`, `~/.codeply/runtime/bin`, `PATH`)
  and the model (`~/.codeply/models/*.gguf` plus a manifest).
* Detects the hardware (cores, RAM, AVX2 / AVX-512 / NEON) and picks threads
  (physical cores, minus one with ≥ 4) and context size.
* Binds to `127.0.0.1` on a free port with a random API key, waits for
  `/health`, runs at low priority (`nice 10` / below normal).
* Loads on first use, unloads after 5 idle minutes.

The path to Codeply Runtime (fork, schema-first sampling, KV cache reuse for
the fixed prompt prefix, CUDA) is in `docs/local-intelligence/RUNTIME.md`.

## 8. Training, data and evaluation

* `ml/data/`: procedural generator (`generate.mjs`), seeded and reproducible,
  covering extraction, importance, duplicates, contradictions, temporal
  updates, relevance (noise), external/injection safety and secrets. Labels
  come from the generator, so they are exact. Splits: train / val / test plus
  a small fast test set. `export-sft.mjs` renders chat-format SFT files with
  the runtime prompt builder.
* `ml/eval/`: `run.mjs` runs any backend over a set and scores structured
  validity, extraction P/R/F1 per kind, certainty accuracy, importance
  ranking, brain end-to-end actions (duplicate / contradiction / temporal),
  noise rejection, secret leakage and injection resistance, plus latency;
  `retrieval.mjs` scores the existing brain retrieval; a hand-written gold set
  checks for template overfitting.
* `ml/bench/`: llama.cpp CPU benchmarks (prompt and generation tokens/s, RSS).
* `ml/finetune/`: LoRA configs and scripts for a rented GPU, GGUF export and
  quantization, and the acceptance gate.

## 9. Decisions and assumptions

* **Branch and saving:** work happens on `codeply-local-intelligence`, pushed
  there for recoverability (the repo's own `CONTINUE.md` workflow commits and
  pushes to a feature branch, no PR). `main` is not touched.
* **Default mode is `legacy`:** nothing a user has today changes until they
  pick a mode; new collection (Life to brain) is off until switched on.
* **Separate `context.db`:** the queue is processing state, not memory; it
  stays out of `brain.db` so the brain's schema and file stay as they are.
* **Embeddings optional:** the retrieval evaluation (`ml/eval/retrieval.mjs`)
  showed word ranking misses requests that share no words with the memory;
  §6.1 adds local embeddings, off by default (block recall 0.83 → 0.93).
* **Per-bot facts** (`bots.js` memory) stay as they are; merging them into the
  brain is a separate product decision.
* **Architecture by measurement:** the first plan assumed a dense
  transformer; the owner chose to pick whatever measures best. The best
  model is LFM3-1.7B, a conv + attention hybrid
  (`docs/local-intelligence/MODEL-SELECTION.md`).
