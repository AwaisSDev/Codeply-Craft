# Codeply Iris: architecture of the Context Fabric's intelligence layer

Status 2026-11-09: **architecture v1, design + contract code.** Branch `iris-arch` (from `research/paste-architecture`
@ 8fecd680). Nothing in production, in the PASTE vs M1c central experiment, in `release/memory-model/` or in any frozen
file is changed. Pollen is out of scope.

Companion files: [CONTRACT.md](CONTRACT.md) (output contract `iris.v1`, code in `irisarch/contract.py`),
[DATA.md](DATA.md) (dataset), [EVAL.md](EVAL.md) (IrisBench v1 for this design), [TRAINING.md](TRAINING.md)
(recipe and compute), [INTEGRATION.md](INTEGRATION.md) (Brain seams), [DECISIONS.md](DECISIONS.md) (this design's
decisions and the evidence for each).

---

## 1. What already exists (audit, 2026-11-09)

| Asset | Where | State | Use in Iris |
|---|---|---|---|
| Brain (SQLite `memories`, `observe()` single write gate, history / challenger / locked, `changes` audit) | `codeply-cli/lib/brain.js` (main) | production | **the store**: Iris proposes, `observe()` and new deterministic rules decide |
| Context Engine (event queue, batching, redaction, rules / cloud / local routing, schema guard) | `context-*.js` on `codeply-memory-model*` branches | integration branch, not on main | **the event bus and runner**: Iris registers as a local `provider.extract` |
| Memory model `lfm3-1.7b-memory-v1-q4` (LoRA on LFM3-1.7B, Q4_K_M GGUF, llama.cpp CPU) | `release/memory-model/` | release candidate, staff opt-in pending | **the strongest baseline**: F1 0.658 / 0.675, false memories 0.25 / 0.24, p95 15-19 s |
| Confidence tiers (logprob of each observation's first token, 5:1 frozen tiers, pending = tentative 30 days) | `context-tiers.js`, `TIERS-FROZEN.json` | integration branch | reused as is for `persist` + `confidence` |
| Research schema v0 (Brain superset: entity, op/target, sensitivity, validity, relations) | `research/paste/iris/schema.py` | research | `iris.v1` extends it; `to_v0()` keeps v0 tools working |
| Life simulator v2 (weeks of one user's life, exact gold for ops, plans, conflicts, sensitivity, agent tasks) | `research/paste/iris/sim/` | research, tested | **the gold source** for Iris data (DATA.md) |
| Renderer + verifier + meaning gate (local open model, fact sheets) | `research/paste/iris/render/` | research; ≤5 % bad-render rule not met yet (E59 4.3 %, E60 9 %) | reused for the realistic surface |
| IrisBench protocol (splits, per-layer metrics, leak rate as hard constraint) | `IRISBENCH-PROTOCOL.md` | draft, not frozen; no IrisBench number exists | completed in EVAL.md |
| Evaluation harnesses (`ml/eval/run.mjs`, `retrieval.mjs`, Benchmark-520, 48-case integration suite, malformed suite) | `ml/eval/`, `research/dtw/benchmark/` | frozen sets | baselines and regression gates |
| PASTE (39 M encoder + recurrent memory tokens) vs M1c | `research/paste/` | central test pending | not a dependency of Iris (see §9) |

What the evidence says (the decisions below follow from it):

1. **Data beats architecture.** Supervised fine-tuning on realistic labels beat every architecture change tried
   (memarch conclusion; the LFM3 LoRA beat the Decide-then-Write encoder by about +0.24 F1 under a pre-registered
   protocol). No new neural primitive is justified at Codeply's input sizes.
2. **The model must not be the store.** Production already has a sound write gate (`observe()`), history, locks and
   an audit log. Its gaps are what reaches it: false memories (25-42 %), jokes stored as facts, slot drift making
   duplicates, person facts stored as the user's, no ids in the context block, word-overlap retrieval, no
   sensitivity in the Brain, life events never becoming memories.
3. **Licensing and data are release blockers today.** LFM3 is free only below US$10 M revenue; 3,315 of the memory
   model's 4,096 training examples come from WildChat. Iris needs an Apache-2.0 base and data with no WildChat
   dependency.

## 2. Principles

* **One model, one contract, deterministic enforcement.** Iris interprets; code stores, permits, deletes, schedules
  and audits. The model never performs an irreversible operation; it proposes typed operations with evidence, and
  `admit()` drops anything that fails validation or grounding.
* **Evidence or nothing.** Every proposed memory carries a verbatim quote from an event it was shown, checked by code.
  A model that cannot quote cannot write. This turns "hallucinated memory" from a model property into a checkable
  property of every output.
* **Doing nothing is a first-class answer.** Most events carry nothing worth keeping (≈ 85 % of turns in LongMemEval).
  `items: []` and `op: ignore` are trained and scored as positives.
* **Operations over rows.** Iris says *add / reinforce / refine / update / correct / conflict / expire / link /
  ignore* against memory ids it was given (merge-by-id, from the DTW research), so slot drift cannot create duplicates.
* **Train on its own outputs.** The memories Iris sees in training include its own earlier (imperfect) writes, not
  only gold, so it learns to work with the state it will really have (exposure bias, see TRAINING.md §3).
* **Measure before scaling.** Every compute request comes with a measured smoke test (owner rule "measure first").

## 3. The Context Fabric, end to end

```
 sources                     Context Engine (deterministic)                    Iris (one model)        Brain (deterministic)
 ───────                     ─────────────────────────────                     ────────────────        ─────────────────────
 chats, Crew bots ─┐   ┌─► queue ─► batch (trust, sensitivity, project) ─┐
 email, calendar ──┼──►│    redact (context-redact) ─► privacy router ───┤
 calls, heard ─────┤   │    candidate recall: entity resolver (aliases)  │   observe(events, memories,   admit() ─► tiers ─► observe()
 screen, activity ─┤   │    + BM25 + vectors over memories (top-K ids) ──┼─► entities, now)  ─► iris.v1  ─► (validate,  (confidence)  history, locks,
 health, tasks ────┘   │                                                 │                               verify       store / pending  validity, audit
                       │                                                 │                               evidence)    / session / drop
                       │  ┌──────────── agent turn / proactive tick ─────┘
                       │  │ request ─► candidate recall (same indexes) ─► retrieve(task, memories) ─► picks + stale + conflicts + share
                       │  │                                                                           │
                       │  └─► context assembly: privacy boundary (frontier-bound? drop `share != yes`) ─► brain block WITH ids ─► agent
```

**Deterministic infrastructure** (exists or small additions, INTEGRATION.md):

| Concern | Owner | Notes |
|---|---|---|
| Event capture, queue, batching, duty cycle | Context Engine | exists (integration branch) |
| Redaction before any model | `context-redact.js` | exists; secrets never reach Iris or a teacher |
| Privacy routing (sensitive → local only) | Context Engine | exists; Iris is local, so it may see sensitive events |
| Candidate recall (what memories Iris sees) | new `iris-recall`: entity aliases + BM25 + vectors (`context-retrieval.js`) | Iris never searches the store itself |
| Storage, ids, merges, history, validity | Brain `observe()` + additive columns | Iris output is a proposal |
| Permissions, deletion, retention, `prune` | Brain + Life store | `prune` also on a timer (today: only when the Brain page opens) |
| Context assembly + frontier boundary | `contextBlock()` | adds ids, drops `share != yes` for frontier models (E52: 32/100 → 0 leaks) |
| Audit | Brain `changes` + an `iris_runs` log (request hash, output, admitted, dropped) | |

**Iris** does only interpretation: what is worth keeping, about whom, how it relates to what is known, how
confident, how sensitive, and what matters for the task at hand.

## 4. The Iris model

### 4.1 Foundation: Qwen3.5-2B (Apache-2.0)

| Candidate | Licence | Architecture | Fit | Verdict |
|---|---|---|---|---|
| **Qwen3.5-2B (Base + post-trained)** | Apache-2.0 | hybrid: 6 × (3 × Gated DeltaNet + 1 × gated attention), 24 layers | 262 K native context with linear-cost DeltaNet layers (long histories, low KV memory); 201 languages; JSON-capable; llama.cpp kernels for GDN; vision variant for screen text later | **selected** |
| Gemma 4 E2B | Apache-2.0 (with Gemma use terms to verify) | transformer, per-layer embeddings, multimodal | strong multilingual and on-device story | **pre-registered fallback** (§4.6) |
| LFM3-1.7B | LFM Open v1.0 (free only < US$10 M revenue) | conv + SWA + global attention hybrid | current memory model's base; known to fine-tune well | baseline only: licence blocks the product goal |
| SmolLM3-3B | Apache-2.0 | transformer | reproducible training; few languages (no Urdu) | rejected: Urdu / Roman Urdu are product requirements |
| Qwen3-1.7B / 4B | Apache-2.0 | transformer | proven in IrisBench pilots (4B zero-shot) | superseded by Qwen3.5 at the same size |
| Encoder + heads (Ettin / mmBERT, DTW) | MIT | encoder | 150 M-400 M, fast | rejected as the model: lost by ≈ 0.24 F1; cannot write open-vocabulary values |
| PASTE (39 M + memory tokens) | research | encoder + recurrent memory | central test pending | not the product model; candidate later as a measured pre-filter only |

Why 2B and not smaller or larger: the 1.7B LoRA already reaches F1 0.66 with a weaker data set; the 4B zero-shot
pilot shows the jump from fine-tuning is far larger than from size; 2B at Q4 fits the measured envelope (≈ 2 GB RAM,
background CPU use) on ordinary PCs and is the largest size realistic on phones. Sources: Qwen3.5-2B-Base model card
(Apache-2.0, 262,144 tokens), Unsloth GGUF builds and the llama.cpp gated-delta-net kernel; Gemma 4 Apache-2.0
announcements; LFM3 licence text (all read 2026-11-09, links in DECISIONS.md). Licences are re-checked on the
model cards before any weights are released.

### 4.2 One model, three modes

All three are the same weights, selected by the first line of the prompt. One request is one JSON object.

| Mode | Input | Output (`iris.v1`) | When |
|---|---|---|---|
| `observe` | ≤ 8 events (≤ 1,800 tokens, as today) + ≤ 30 candidate memories with ids + entity roster + now / tz | `items[]` (typed ops with evidence), `plans[]`, `relations[]` | every Context Engine batch |
| `retrieve` | a task or user message + ≤ 40 candidate memories with ids (from recall) + now | `picks[]` (id, relevance, why, stale, share), `conflicts[]`, `missing[]` | before an agent turn or proactive check |
| `resolve` | one memory's history + challengers + new evidence | `items[]` with one of reinforce / update / correct / conflict / expire | when the Brain has a challenger or a review flag |

Proactive awareness (nudges) stays rule-driven in `life-triggers.js` for v1; Iris supplies it the state it reads
(current plans, deadlines, conflicts). A proactive mode is a v2 decision, made only once IrisBench measures it.

### 4.3 What Iris must get right (the op semantics)

| Op | Meaning | Store effect (deterministic) |
|---|---|---|
| `add` | new information, nothing covers it | insert (tier decides confirmed / tentative) |
| `reinforce` | same value said again | evidence + 1, confidence up; no new row (fixes duplicates) |
| `refine` | same fact, more precise | value replaced, old value to history (not a past state) |
| `update` | the world changed (December → January) | old value closed `valid_to = now`, new value current; one record, full history |
| `correct` | an earlier value was wrong | old value marked erroneous in history; never shown as a past state |
| `conflict` | disagrees, unclear which is right | both kept, `review = 1`, challenger set; retrieval reports the conflict, never picks one silently |
| `expire` | no longer true, no replacement (cancelled, left the job) | `valid_to = now`, status inactive; still in history |
| `link` | same entity / part of / about / depends on | edge in the entity graph; no memory text changes |
| `ignore` | considered, deliberately not kept (joke, hypothetical, quote, someone else's suggestion, unreliable) | nothing; logged for audit and training |

`basis` (stated / inferred) and `certainty` (stated, implied, temporary, joking, hypothetical, quoting) are separate:
an implied commitment ("I'll send it by Friday") is `stated` evidence with an `inferred` todo. `valid.temporary`
with `valid.to` covers "I'm in Karachi this week": stored as session or with expiry, and the permanent home fact is
untouched. `persist` is the model's recommendation; the tier policy and the user's settings decide.

### 4.4 Prompt packing (input format)

Plain, compact, id-carrying text (the production prompt already conditions on retrieved memories as text, and the
LoRA result shows this works):

```
iris observe | now 2026-11-09T10:05+05:00 Asia/Karachi
entities: e1 Atlas (project) | e4 Sara Ahmed (person, colleague; alias "Sara A.")
memories:
m1 [decision · project:atlas · atlas launch date] The Atlas launch is in December. (confirmed, 0.9, 2026-10-20)
events:
ev1 assistant_chat 2026-11-09T10:00 user: Quick update: the Atlas launch moved to January. Sara is handling the deck.
```

Ids are short and local to the request (`m1`, `e4`, `ev1`); the runner maps them to store ids, so the model never
learns or leaks real ids. Output is JSON only, decoded under the `iris.v1` JSON Schema (llama.cpp grammar), temperature
0, no thinking. Context budget per request: ≤ 4 K tokens in v1 (fits the 8 K server context with room for output);
the 262 K window is headroom for `resolve` over long histories and for v2 long-conversation packing, not a v1
requirement.

### 4.5 Confidence and abstention

* `confidence` in the output is the model's estimate; the **admitted** confidence is the product's: the logprob of the
  item's `op` token (same method as the frozen tiers, `conf-provider.mjs`), recalibrated on IrisBench val with the
  same 5:1 cost rule as today.
* `basis: inferred` caps at 0.9 by contract; secrets are always `persist: reject`.
* Calibration is reported (ECE, reliability) per op, not only overall.

### 4.6 Runtime targets and the fallback rule

| Target | Value | Source of the bar |
|---|---|---|
| Format | GGUF Q4_K_M (+ Q8_0), llama.cpp, JSON Schema grammar | release/memory-model runtime |
| RAM | ≤ 2.2 GB resident | memory model ≈ 1.95 GB |
| Latency | observe p95 ≤ 15 s per batch on 4 CPU threads; retrieve p95 ≤ 3 s for 40 candidates | memory model p95 15.5-18.8 s; retrieve sits before a user-visible turn |
| Output validity | ≥ 99.5 % parseable + schema-valid (grammar decoding should make this ~100 %) | malformed suite 18/18 |

**Fallback, pre-registered:** if the Phase-0 smoke test (TRAINING.md §5) shows Qwen3.5-2B cannot be fine-tuned on the
available T4 (Gated DeltaNet training kernels in fp16 on sm_75) at ≥ 60 % of a same-size transformer's tokens/s, or
its zero-shot `iris.v1` validity on IrisBench val is < 90 % with grammar decoding, Iris uses **Gemma 4 E2B**. One
model is selected; the other is not trained.

## 5. Entities and linking

* The store keeps an **entity registry** (id, type, display name, aliases, relations), new in the Brain (additive
  table). Candidate recall resolves names in the events to registry ids by alias + fuzzy match and hands Iris the
  roster.
* Iris decides: is "Sara" the known Sara Ahmed (`entity.id e4`) or a new person (no id)? Does this fact belong to the
  user, another person or a project (`about`)? Production stores person facts as the user's; this fixes it.
* Look-alike names, nicknames and Roman Urdu spellings are a dedicated training slice (DATA.md §3).
* `link` with `same_as` merges two registry entries only after the deterministic layer checks no conflicting facts
  (two different birthdays) exist; otherwise it is stored as a conflict for the user.

## 6. Retrieval

Two stages, because similarity is not relevance:

1. **Recall (deterministic, fast):** entity hits from the request + BM25 + vector cosine (local embedding model,
   `context-retrieval.js`) + recency + project scope → top 40 ids. Target: gold-context recall@40 ≥ 0.95.
2. **Select (Iris `retrieve`):** reads the task and the 40 memories; returns what is relevant, what is stale
   (superseded or expired but still indexed), which memories conflict, what the task needs that memory lacks, and a
   `share` label per pick (`yes`, `local_only`, `no`).

The assembled block keeps memory ids (today's block has none, so agents cannot forget a done to-do). For a frontier
model the boundary drops every pick whose `share` is not `yes` and every item with privacy `private` / `secret`,
regardless of the model (E52: production ranking leaked a sensitive item into 32 of 100 frontier tasks; a boundary at
assembly brought it to 0 with recall 0.956).

## 7. Privacy

* Redaction runs **before** Iris and before any teacher; secrets (`SECRET_RE` + `context-redact`) never reach either.
* Iris labels `privacy.level` and `category`; the Brain gains the column; enforcement (who may read, frontier
  boundary, retention per category) is code.
* Iris runs locally, so sensitive events (calls, health) can be interpreted without leaving the machine.
* Training data: synthetic lives only; no private user data, no WildChat; consented team data only for evaluation,
  later, under the existing opt-in rules (IRIS-DESIGN §3.5). Teacher-labelled data carries the open question C3
  (provider terms for model-written labels) recorded in `LEGAL-AND-PRIVACY-QUESTIONS.md`.

## 8. Brain integration (summary; details in INTEGRATION.md)

* Iris is a **local provider** of the Context Engine (`provider.extract({events, known, now, tz, projects})`), a
  **retriever** (`brain.setRetriever`) and a **resolver** called on challengers. No rewrite.
* `observe()` stays the single write gate and gains op-aware paths (reinforce / update / correct / conflict / expire
  by id) behind a feature flag, with tests mirroring the existing value-match suite.
* Additive Brain columns: `entity_id, about, basis, privacy, privacy_category, valid_from, valid_to, evidence_quote,
  evidence_event, iris_op, iris_conf`; new tables `entities`, `entity_aliases`, `links`, `iris_runs`. Old rows keep
  working (columns nullable).
* Rollback reuses the memory model's tooling (`rollback-memories.mjs`): every Iris write is tagged and reversible.

## 9. What Iris deliberately does not use

* **PASTE / M1c**: the central test is still out and E50 found neither ranks memories above chance on LongMemEval.
  Iris does not depend on its result; if PASTE passes, it is a candidate *pre-filter* in front of Iris, measured on
  IrisBench, never a second product model.
* **A dedicated encoder gate** in v1: the Context Engine's rules + batching already cut traffic; a gate is added only if
  measured latency or energy requires it.
* **Compressed memory tokens**, **RL**, **new primitives**: no evidence they beat better data at this scale.

## 10. Milestones (each ends with a measured artefact)

| # | Milestone | Done when |
|---|---|---|
| A1 | Contract `iris.v1` + validator + grounding check + bridges | code + tests (this branch) ✅ |
| A2 | Data builder: life sim → `iris.v1` gold for observe / retrieve / resolve, with verifier and leakage checks | DATA.md checks pass on a pilot set |
| A3 | IrisBench v1 frozen (val / test / stress hashed, never on shared machines) | freeze file + hashes |
| B1 | Phase-0 smoke: Qwen3.5-2B tokens/s + memory on T4, zero-shot validity on val | numbers in EXPERIMENTS; fallback rule applied |
| B2 | Baselines on IrisBench val: production, memory model (LFM3 LoRA), Qwen3.5-2B zero-shot | table |
| B3 | SFT round 1 (gold histories) → round 2 (own-output histories) → optional DPO on false memories | val curves, 3 seeds |
| C1 | Test once, locked checkpoint and thresholds | report with CIs |
| C2 | Package: merged weights, GGUF Q4_K_M / Q8_0, model card, clean-environment load + inference + latency | release dir |
| C3 | Integration branch: provider, retriever, Brain op paths, rollback | integration suite ≥ memory model's 42/48 |
