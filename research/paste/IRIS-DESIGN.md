# Iris 1: research and evaluation design (for owner review before implementation)

Status 2026-11-04: **design only.** Implements IRIS-ROADMAP.md under the owner's decisions of 2026-11-04 (DECISIONS.md):
local open model on Kaggle for realistic data (no API), no paid GPU (measure first), production Brain format as the
compatibility target, research isolated from production, HaluMem / PerLTQA / LoCoMo for internal evaluation kept
separate from commercially licensed data, consented team data later. The 2026-11-07 central test is unaffected.

Production facts below come from a read-only map of the codebase (file:line references in the session notes); they
are descriptions, not changes.

## 1. Where Iris plugs in (production today, read-only)

* **Brain** (`codeply-cli/lib/brain.js`): SQLite `memories` rows with `id, kind, scope, slot, value, text, status,
  confidence, evidence, locked, review, challenger, history, sources, domain, expires_at, created_at, updated_at,
  seen_at`. `slot` is **open-vocabulary** (normalised free text ≤ 80 chars). `observe()` decides insert / reinforce /
  replace / challenge; `SECRET_RE` rejects secrets; an append-only `changes` table audits every action.
* **Context engine** (`context-engine.js`, `context-schema.js`, `context-model.js`): events `{id, source, product, at,
  trust, sensitive, project, actor, text, meta, ...}` are batched and sent to an extractor that returns
  **observations** `{kind, slot, value, text, certainty, importance, project?, until?, about}` and **plans**
  `{what, when, where, who[]}`, under constrained JSON. A trust clamp and a grounding guard filter the output.
  Sensitive batches only go to a local backend.
* **Life store** (`life-store.js`, `life.js`, `life-triggers.js`): items from calendar, mail, calls, screen, tasks,
  health, etc.; a `people` table; triggers (`leaving, meeting, email, deadline, watched, activity`) with nudge limits.
* **Retrieval**: keyword overlap + confidence + evidence + recency, optional local embeddings; no graph.
* **Local model status** (LOCAL-INTELLIGENCE-REPORT.md): best candidate LFM3-1.7B Q4, F1 0.80 on generated tests,
  0.70 on hand-written gold, **42 % false memories**, p95 18 s per batch; no model passes the release gate yet.

**Consequence.** Iris 1's first job is the production extraction contract, done far more accurately, with far fewer
false memories, plus the fields production currently drops. That is measurable without touching production, and the
production local model is the baseline to beat.

## 2. Research memory schema v0 (Brain-compatible superset)

The research store keeps every Brain field with the same name and meaning, so any research memory can be written as a
Brain row by dropping the extra fields. Extra fields fill the gaps found in production.

**Observation (extractor output)**

| Field | Brain / production | Research addition and why |
|---|---|---|
| `kind` | same 10 kinds (`preference fact routine style decision idea requirement todo context lesson`) | — |
| `slot` | same (open-vocabulary, normalised) | canonicalisation against existing slots is scored (stable names) |
| `value`, `text` | same limits | `evidence_span` (char offsets in the source event) |
| `certainty` | same 6 values (production drops it after filtering) | **kept**: needed to tell facts from suggestions and quotes |
| `about` | same (`user / person / project`) | **`entity`**: canonical id + display name of the person / organisation / project (production stores person facts as `me` facts) |
| `importance` | same (production drops it) | kept |
| `until`, `project` | same | `valid_from`, `valid_to` for facts that change |
| — | — | **`op`**: `new / reinforce / update / contradict / duplicate / none` and **`target`** (memory id) |
| — | — | **`sensitivity`**: `public / personal / private / secret` (+ category: finance, identity, health, credentials, location, intimate) |
| — | — | **`source`**: event id, source type, trust (production records a one-way link only) |

**Plan / commitment** = production plan `{what, when, where, who[]}` + `status` (`confirmed / tentative / suggested /
declined / cancelled / done`) + `source` + `conflicts_with[]`.

**Relations** (new, research store only): edges `(entity_a, relation, entity_b, since, until, source)` for
person-person, person-organisation, person-project; memory-memory links `same_as, updates, contradicts, part_of`.

Iris outputs JSON in this schema; the store, not the model, enforces ids, merges and permissions.

## 3. IrisBench v0

### 3.1 Life simulator v2 (gold source)

Extends the existing generator (entities, look-alike names, updates, corrections, temporary items, Urdu / English mix).
A simulated **life** spans 2-6 weeks of one user:

* entities: user, 8-25 people with relations (family, friends, colleagues, investors, teachers), organisations,
  projects, places;
* facts and preferences with change events (new job, changed brand colours, updated academic goal, finished project);
* commitments and plans with times and status transitions (suggested → confirmed → moved → done / cancelled), including
  deliberate conflicts (two 7 PM commitments) and recurring routines (hydration, gym);
* goals with progress (marks, targets, preparation plans) and deadlines;
* sensitive material (card numbers, ID documents, health, passwords, private family matters) with true categories;
* agent tasks: "draft a design brief", "plan my week", "prepare for the investor meeting", each with the gold minimal
  context set and the items that must **not** be shared with a frontier model.

Every observation the simulator emits carries exact gold: the facts it introduces or changes (schema of §2), its
certainty (stated, suggested, joking, quoted, hypothetical), sensitivity, and links to earlier facts.

### 3.2 Realistic surface (local open model, no API)

Sources rendered: user ↔ assistant chats (personal facts incidental; ~10-20 % of user turns carry a fact; long
assistant replies), chats with friends and colleagues, calendar entries, email snippets, short screen text,
document excerpts. Base rates are set from LongMemEval and REALTALK statistics, not guessed.

Rendering contract (keeps the gold exact):
1. The simulator hands the renderer a **fact sheet** per conversation: facts that must be expressed (with their exact
   value strings and names), facts that must not appear, and the conversational purpose (the user is mostly asking
   for help with something else).
2. The renderer (open-weights instruct model) writes the conversation.
3. A **verifier** (deterministic, no model): every required value and name occurs verbatim; no forbidden value occurs;
   length and turn-count bounds hold; character spans are located for the gold. Failures are re-rendered (≤ 3 tries)
   or dropped and counted.
4. A second-pass **contradiction check** by the same local model on a sample (does the text state anything that
   conflicts with the fact sheet?), and a manual review of 100 conversations per release, recorded in EXPERIMENTS.

Model choice: permissively licensed only, so generated data stays commercially usable: Qwen3 (Apache-2.0: 4B, 8B,
14B), Phi-4 / Phi-4-mini (MIT), Mistral-Small-3.1 (Apache-2.0), OLMo-2 (Apache-2.0); licences read from the HF model
cards 2026-11-04. Chosen by measurement (§5): verifier pass rate x diversity x tokens per GPU- or CPU-hour.

### 3.3 Splits and freezing

`train / val / test / stress` lives with disjoint people, names, organisations and templates. Test and stress are
generated, hashed and frozen before any Iris model is trained (as for the central test), stored only privately.

### 3.4 Metrics (system's own closed-loop state, per layer)

| Layer | Metrics |
|---|---|
| Extraction | fact P / R / F1 (match: entity + canonical slot + value), **false-memory rate** (production's release-gate measure), hallucination (no source support), misattribution (wrong entity or slot) |
| Typing | certainty / kind confusion; suggestion-vs-commitment accuracy |
| Structure | slot reuse rate for existing names; duplicate rate |
| Updating | current-state accuracy; stale-memory rate; contradiction detection P / R; validity-interval accuracy |
| Connection | entity linking across sources; conflict detection P / R |
| Retrieval | gold-context recall at token budgets (500 / 1,000 / 2,000), precision, evidence correctness, latency |
| Privacy | **leak rate** of sensitive items into frontier-bound context (target 0); over-blocking; sensitivity-class accuracy |
| Proactive | nudge precision / recall / timeliness against gold commitments and deadlines (within production's nudge limits) |
| Downstream | agent task success with Iris context vs none vs full history; first with a local open model as agent, API only with approval |
| Efficiency | p50 / p95 latency per event and per batch, resident RAM, CPU time per simulated day |

Statistics as in the central test: pre-registered primary metrics (extraction F1 and false-memory rate; leak rate as
a hard constraint), 3 seeds, paired bootstrap over lives, per-seed values.

### 3.5 External and private evaluation, kept separate

* **Commercially licensed:** LongMemEval (MIT), REALTALK (Apache-2.0). Reported in one table.
* **Non-commercial (internal only):** LoCoMo (CC BY-NC 4.0), PerLTQA (CC BY-NC 4.0), HaluMem (CC BY-NC-ND 4.0).
  Reported in a separate table marked "non-commercial licence, internal research", never used for training, never
  redistributed. Unmodified private copies: `paste-data/public/noncommercial/` (licence and sha256 per set).
* **Consented team data (later):** written opt-in per person, per source; collected and kept only on the team
  member's machine or in a private encrypted store; redacted with production's `context-redact` rules plus manual
  review before any use; evaluation only; deletion on request; never sent to an API or a shared Kaggle session.

### 3.6 Baselines

1. Production rules extractor (from `context-schema.js`; logic re-implemented in research, production untouched).
2. Production local-model path: LFM3-1.7B Q4 with the production prompt (`context-prompt.js` v2), run locally.
3. M1c-family and PASTE (frozen central checkpoints; their closed vocabulary is mapped to slots).
4. Zero-shot open instruct models at 0.5B, 1.5-2B and ~4B with constrained JSON in the §2 schema.
5. Fine-tuned Iris candidates (later).

## 4. Iris 1 model directions (ranked by the evidence so far)

1. **Small generative extractor (≈1.5-2B, fine-tuned)** on the §2 contract, conditioned on the event plus ≤ 30
   retrieved memories as text (as production's prompt already does). Most direct path to the production contract and
   open-vocabulary slots.
2. **Always-on small encoder gate** (PASTE-derived) in front: worth extracting? sensitivity? entities? Cuts the 2B
   model's calls to the ~10-20 % of events that carry information.
3. **Compressed memory tokens (PASTE idea)** as a measured optimisation of the extractor's context cost, adopted only
   if IrisBench shows no quality loss (E50 is a warning about transfer).

## 5. Measurements before asking for any compute (owner: "measure first")

| Measurement | Where | Output |
|---|---|---|
| Generator throughput and verifier pass rate for 3 candidate models (Qwen3-4B, Qwen3-8B, Phi-4-mini) on 50 fact sheets | Kaggle free CPU (llama.cpp, quantised) and, after the central runs, Kaggle T4 | tokens/s, pass rate, cost per 1,000 conversations in CPU- or GPU-hours |
| Baseline extractor latency and RAM (LFM3-1.7B Q4, 0.5-4B zero-shot) on IrisBench events | this container's CPU, Kaggle CPU | p50 / p95 per event, resident memory |
| Fine-tuning cost of a 1.5-2B extractor on N examples | 1 T4 session, short run, after the central runs | tokens/s, time per epoch → GPU-hours for the full run |

Only after these numbers exist is any further compute requested, with the figures attached.
