# Integrating Iris into Codeply

Iris is the interpretation component of the Context Fabric. Everything else stays where it is.

```
 collectors ──► context engine ──► Iris (local model) ──► guard ──► Brain / life store ──► retrieval ──► agents
 (events)        batching,          proposes ops           checks     applies, audits,       index +      get context
                 redaction,         with evidence          every op   expires, deletes       Iris select
                 privacy routing
```

| Concern | Owner |
|---|---|
| What a batch means; new vs update vs duplicate vs retraction; what to ignore; sensitivity label; which candidate memories a task needs | **Iris** |
| Storage, ids, history, indexing and search, permissions, user-controlled deletion, retention and expiry, source tracking, scheduling, privacy routing, audit log | **infrastructure** (Brain, life store, context engine) |
| Whether a proposed op is acceptable | **the guard** (deterministic; `contract.guard` / `parseAndGuard`) |

Iris never performs an irreversible operation. `retract` asks the store to mark a memory as no longer valid;
what "forget" does to the row is the Brain's policy.

## 1. Run the model

Iris ships as a GGUF file and runs on Codeply's managed `llama-server` (`local-runtime.js`), like the current
local model. No Python is needed at runtime.

```
llama-server -m iris-1-Q8_0.gguf --host 127.0.0.1 --port 8080 -c 8192 --parallel 1
```

The model is trained on plain ChatML with one fixed system line, which is what the server's default chat
template produces, so `/v1/chat/completions` works without template flags. Use temperature 0.

Register it like any Codeply-trained model:

```
node scripts/context/fetch-model.mjs codeply-iris-1 --from /path/to/iris-1-Q8_0.gguf --license Apache-2.0
```

## 2. JavaScript: a drop-in provider

`integration/iris-provider.js` implements the provider contract of `codeply-cli/lib/context-model.js`
(`info()`, `available()`, `extract({events, known, now, tz})`). It is self-contained and is **not wired into
production**; wiring is one line where providers are created, once the owner approves:

```js
const { createIrisProvider } = require('./iris-provider.js');
const iris = createIrisProvider({ ensure: () => localRuntime.ensure('codeply-iris-1') });   // or { baseUrl }
const r = await runExtraction(iris, { events, known, now, tz });
```

`extract()` returns production's answer shape, so `runExtraction()` and `checkExtraction()` keep working:

* `answer.observations`, `answer.plans`: what the existing Brain path consumes today.
* `answer.iris.ops`: the guarded operations, each with `action` (insert / replace / reinforce / forget /
  challenge), `target` (the Brain memory id, mapped back from the per-call alias), `evid` + `src`, `sens`,
  `conf`, `basis`, `why`. A store that understands operations should apply these instead of re-deriving the
  action from slot matching: that is where update, duplicate and retraction accuracy comes from.
* `answer.iris.rejected`: operations the guard refused, with the reason. Log them; never apply them.
* `answer.iris.valid`: false when the model's JSON was malformed. The batch then stores nothing.

Two behaviours to keep when wiring:
1. **Local only.** The provider refuses a non-local URL. Sensitive batches already go only to local backends;
   Iris is one.
2. **`known` selection.** Pass the memories relevant to the batch (the engine's existing retrieval, up to 40).
   Iris can only update, confirm or retract what it is shown; a memory that is not shown may be re-added, and the
   Brain's own duplicate check remains the backstop.

Test: `node research/iris/integration/iris-provider.test.mjs` (stubbed server), or with
`IRIS_URL=http://127.0.0.1:8080/v1` against a live one.

## 3. Python: the reference runtime

```python
from codeply_iris.infer import Iris
from codeply_iris.store import MemoryStore

iris = Iris.load("iris-1-Q8_0.gguf")          # starts llama-server ($IRIS_LLAMA_SERVER or PATH); or a merged HF dir
store = MemoryStore()

out = iris.observe(now="2026-03-02T09:15", source="personal_chat", memories=store.view("2026-03-02"),
                   messages=[{"who": "Dana", "text": "are you still vegetarian?"},
                             {"who": "user", "text": "yep. and the offsite moved to 14 March btw"}])
for op in out["ops"]:
    store.apply(op, session="batch-1")        # the store, not the model, changes state
print(out["rejected"])                        # refused by the guard, with reasons

use = iris.retrieve(now="2026-03-05T10:00", memories=store.view("2026-03-05"), query="Plan my week")["use"]
```

`integration/example.py` runs this end to end. `MemoryStore` is the reference for store semantics (history on
update, retraction without erasure, temp expiry, append-only log); production uses the Brain.

## 4. Operating notes

* **Batching and streaming.** One call per observation batch, as the engine batches today. For long
  conversations, call per window of new messages with the current memories: updates are incremental by
  construction (each call reads the store the previous calls produced).
* **Retrieval.** Recall comes from the index (keyword / embeddings); pass its top candidates to
  `iris.retrieve` for the final selection, and apply the sensitivity boundary at context assembly (E53) using
  the stored `sens` label.
* **Constrained decoding.** Optional (`constrain: true` / `json_schema`): it guarantees syntax, not truth. The
  guard runs either way and is what protects the store.
* **Failure handling.** Malformed JSON, an invented quote, an unknown target, a secret-like value: rejected and
  logged, nothing stored. A model timeout: the batch is retried or dropped by the engine as today.
* **Privacy.** `sens` is a label for infrastructure to enforce. `skip … secret` means the model saw a credential
  and proposes not to store it; the guard additionally blocks secret-like values whatever the model says.
* **Rollback.** Iris is a provider choice. Switching back to the previous provider is the rollback; ops are
  logged with their batch, so writes from a period can be undone by the Brain's existing undo.

## 5. Not done here

Nothing in `codeply-cli/`, the desktop app or any release branch was changed. Wiring the provider, a Brain
method that applies ops directly (instead of slot matching), a catalog entry with the GGUF checksum, and the
opt-in rollout used for memory model v1 are owner decisions.
