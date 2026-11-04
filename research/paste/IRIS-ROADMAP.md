# Iris 1 research roadmap: from PASTE to context management

Status 2026-11-04: **proposal for owner review. Nothing here is implemented, nothing changes production, the
checkpoints or the pre-registered central test (2026-11-07), and no paid compute or API spend is assumed.** Every
experiment below is gated; decisions that need the owner are listed at the end.

Target (owner, 2026-11-04): Iris continuously understands and updates the user's context, protects their privacy, and
makes the right information available to the right agent at the right time; about 2B parameters; continuous
operation on ordinary PCs, cloud machines and possibly phones.

## 1. Which capabilities PASTE learns, and which belong to the surrounding infrastructure

PASTE (spec v2.2, ~38M parameters on Ettin-32M) reads one conversation segment at a time, plus the stored memories as
one vector each, profile rows and 4 recurrent tokens, and proposes operations on a Brain store. Its output space is
fixed by `paste/config.py`:

| Iris responsibility (owner's A-G) | What PASTE has today | Gap |
|---|---|---|
| A. Observation and extraction | BIO span finder over the segment; route PERSIST / TEMP / IGNORE / FORGET; **value = a copied span** | conversations only (no documents, screen, calendar); trained on short user turns |
| B. Structured memory | entity (profile addressing: user, existing profile, or new from a mention), **attribute = 101-way closed softmax** (100 fixed names + OTHER), 9 kinds, 6 certainty labels | open attributes; stable names/folders; source references are kept only by the simulator, not the model; no entity-entity relations; no time fields beyond temporary-item expiry |
| C. Understanding and updating | WRITE / UPDATE / MERGE_INTO / FORGET / FORGET_PROFILE / MERGE with addressing to the target record; relation SAME / UPDATE / CORRECTION / CONTRADICTION; Brain-side challenge logic for locked memories | cross-source connection (the investor-meeting / calendar / friend example); event and schedule reasoning; recurring patterns |
| D. Retrieval | retrieve head scores stored memories for the current segment | no keyword/embedding index, no graph traversal, no context budget; E50: not better than chance on public chats |
| E. Proactive awareness | temporary items with TTL (PLAN, TASK, PENDING, ...) | no commitments model, no notification policy |
| F. Privacy routing | none in the model; `BrainSim` drops secret-looking values with a regex | sensitivity classes, permission boundary, per-agent sharing |
| G. Orchestration | none | local vs specialised agent vs frontier model decision |

**Belongs in the model (Iris):** extraction; typing (fact / preference / plan / commitment / suggestion / hypothetical);
entity resolution and linking; deciding update vs new vs duplicate vs contradiction; sensitivity labelling;
relevance scoring of candidate memories. **Belongs in infrastructure (deterministic, auditable):** the store and its
schema, indexes (BM25 + vectors + graph), source and evidence storage, permission enforcement (the model labels, the
infrastructure enforces), scheduling and notification delivery, conflict checks that are pure rules (two events at
the same time), and the orchestration policy (a small learned router at most, with hard rules for sensitive data).
PASTE is a component candidate for the "extraction and update" and "relevance scoring" parts, not for Iris as a
whole.

## 2. What E50 shows, and what it does not

**Shows (one seed, validation checkpoints, oracle setting):**
* Out of distribution, neither system ranks stored memories for a question better than chance (PASTE below chance,
  −0.042 [−0.068, −0.015]; M1c at chance).
* Both write a memory from most answer-bearing turns (84-88 %), but store about 170 memories per 100 turns, and the
  answer is stored for only 5-7 % of questions: extraction precision collapses.
* Qualitatively, attributes from the closed vocabulary are misapplied to real content (a question about degree
  options becomes "degree: computer science") and values are fragments.
* The training distribution differs sharply from real chats (measured 2026-11-04):

| | our training data | LongMemEval (oracle) |
|---|---|---|
| user turns carrying a fact to keep | **73 %** of segments | **15 %** of user turns are evidence |
| median user turn | 15 words | 42 words |
| median assistant reply | 4 words | 356 words |

  A model trained where nearly every turn has a fact learns to write nearly every turn.

**Does not show:**
* That the architecture cannot work: data, the closed attribute vocabulary and model size are confounded (one
  experiment cannot separate them; §6 proposes the separating ablations).
* Retrieval quality proper: the retrieve head was trained to score memories for a conversational segment, never for
  a question; the store it ranks is mostly noise, so retrieval cannot succeed whatever the ranker.
* Anything about LongMemEval QA accuracy (no answering model) or about real usefulness to agents.
* How the 3-seed central models behave (pre-registered run follows the central test).

**Status:** E50 is kept as a negative result (EXPERIMENTS.md); the pre-registered LongMemEval run on the frozen central
checkpoints and a LoCoMo run (CC BY-NC 4.0, internal research only, approved 2026-11-04) follow the central test.

## 3. Are the synthetic data and the fixed attribute vocabulary fundamentally limiting?

**Fixed vocabulary: yes, by construction.** A 101-way softmax cannot express "attended the Data Analysis webinar",
"midterm target grade: A", "brand palette: teal and coral", or a project name; anything outside the list becomes OTHER
or a wrong nearby attribute (E50). It also cannot preserve existing user-defined names. The owner's requirements
(stable named memories, folders, open categories) need an **open-vocabulary attribute** with canonicalisation against
names already in the store.

**Value as a copied span: limiting** for normalised values (dates, times, amounts), multi-span facts and anything
inferred.

**Synthetic data: limiting in its current form, not in principle.** The generator's world model (entities, look-alike
names, updates, corrections, temporary items, multilingual turns) is an asset: it gives exact gold for updates and
contradictions that public datasets lack. What breaks transfer is the surface: dense fact-bearing short user turns,
almost no assistant text, one source type. The fix is a realistic surface on top of a richer world model (§4), not
abandoning synthesis.

**Model size:** unknown. At 32M parameters an encoder with heads may be too small for open-vocabulary extraction from
long, noisy text; the target size (≈2B) changes this (§7).

## 4. Realistic-data training strategy

Constraints kept: no WildChat or WildChat-derived data (owner, 2026-11-02); licensed or synthetic data only; private
data stays private.

1. **Life simulator v2 (gold source).** Extend the generator from "facts about people" to a user's life over weeks:
   entities and relationships (person-person, person-organisation, project, event), commitments with times and status
   (confirmed / tentative / suggested / declined), goals with progress (marks, targets), preferences that change,
   documents and calendar entries, and sensitivity labels (payment data, identity documents, health, secrets). Every
   observation has exact gold: extraction targets, update links, conflicts, sensitivity, and what a given agent task
   needs.
2. **Realistic surface.** Render the simulator's events into the sources Iris will see: user-assistant chats in which
   personal facts are incidental (base rate ~10-20 % of turns, long assistant replies), chats with friends and
   colleagues, calendar and document snippets, short screen-text excerpts. Options: (a) a local open-weights
   instruction model (Apache-2.0 / MIT licence) on Kaggle GPU: free, but competes with the central test for quota;
   (b) an API model: needs owner approval of budget. Programmatic templates alone reproduce the E50 problem.
3. **Licensed public dialogue for surface diversity** (no gold needed): see §5 table (licence-verified).
4. **Evaluation data never used for training:** LongMemEval (MIT) and LoCoMo (NC) stay evaluation-only; IrisBench test
   splits are frozen like the central test.

## 5. Public datasets (licences verified from primary sources; see table)

*Licence verification in progress (2026-11-04); this table is filled from primary sources before the plan is final. Until then no public dataset other than LongMemEval (MIT) and LoCoMo (CC BY-NC 4.0, internal evaluation only) is used.*

## 6. End-to-end evaluation: IrisBench (proposed)

One benchmark for the whole pipeline, with gold at every layer, built from the life simulator (frozen test worlds)
plus public sets for external validity. Each metric is computed on the system's own closed-loop state.

| Layer | Metric (gold from the simulator) | Public check |
|---|---|---|
| Extraction | fact-level precision / recall / F1; matching = entity + attribute (alias table from the simulator; open-vocabulary attributes matched by canonical id) + value; **hallucination rate** (facts with no source support); **misattribution rate** (right value, wrong entity or attribute) | LoCoMo observation annotations (if present; see §5) |
| Typing | confusion over fact / preference / plan / commitment / suggestion / intention / hypothetical / joke | — |
| Structure | duplicate rate; stable-name reuse (new fact attached to the existing named memory) | — |
| Updating | current-state accuracy after changes; stale-memory rate; contradiction detection P/R; temporal validity (from / to) | LongMemEval knowledge-update questions |
| Connection | cross-source entity linking accuracy; conflict detection P/R (overlapping commitments, as in the 7 PM example) | — |
| Retrieval | for each agent task with a gold context set: recall at a token budget, precision, evidence (source) correctness; latency | LongMemEval / LoCoMo evidence recall (E50 metric) |
| Privacy | **leak rate** of sensitive items into frontier-bound context (target 0), over-blocking rate, per-agent permission violations | — |
| Proactive | notification precision / recall / timeliness on gold commitments, deadlines, goals | — |
| Downstream usefulness | task success of an agent given Iris context vs no context vs full history; first with a local open model as the agent (no API), later an API agent with approval | LongMemEval / LoCoMo QA (API, owner approval) |
| Efficiency | latency per event (p50 / p95), RAM, energy per day of observations at realistic event rates | — |

Baselines on IrisBench: rules + regex; M1c-family; PASTE; a zero-shot small open instruction model emitting structured
operations; later the fine-tuned Iris candidates. Reporting follows the central test's standards (pre-registration,
frozen tests, 3 seeds, paired bootstrap, per-seed values).

## 7. Reaching ≈2B parameters within inference-memory limits

Design principle: **do not run the 2B model on every event.** Most observations contain nothing worth storing (15 %
evidence rate on LongMemEval).

* **Cascade.** (1) An always-on small encoder (tens to a few hundred million parameters; PASTE-derived) labels every
  event: worth extracting? sensitive? which entities? It also produces embeddings for the index. (2) The ≈2B
  generative extractor runs only on flagged events, conditioned on the event plus a small retrieved set of existing
  memories, and emits structured operations (open-vocabulary JSON, validated by the store's schema). (3) Retrieval for
  agents is index + small reranker, not the 2B model reading thousands of memories.
* **Where PASTE's ideas carry over.** Memories as compact learned tokens with a re-encoding cache cut the cost of
  conditioning on existing knowledge (the smoke benchmark measured PASTE at 0.58x M1c's p50 at 32 memories on a loaded
  machine; to be re-measured on the frozen checkpoints). Operation-level outputs with explicit target ids are the right
  interface for updates and contradictions. The open question, which the central test plus E50 sharpen, is whether
  learned memory tokens generalise; text memories may be the safer default for the 2B extractor, with compressed tokens
  as a measured optimisation.
* **Memory arithmetic (estimates, to be measured).** 2B parameters at 4-bit ≈ 1.0-1.3 GB; at 16-bit ≈ 4 GB. KV cache
  for short inputs (one event + ~30 memories, ~2-4k tokens) is in the tens to low hundreds of MB depending on the
  attention layout. The small encoder adds ~0.1-0.5 GB. A 2-3 GB resident budget on a PC is plausible; phones need the
  extractor on demand or a smaller variant.
* **Measured, not assumed:** throughput at realistic event rates, p95 latency, battery and RAM on target devices are
  part of IrisBench (§6).

## 8. Proposed experiments, in order (each needs the owner's go-ahead before implementation)

| # | Experiment | Question | Compute | Gate |
|---|---|---|---|---|
| P0 | Central test (pre-registered), then LongMemEval (pre-registered) and LoCoMo on the frozen checkpoints | does PASTE beat M1c on our benchmark; how both transfer | T4 quota from 2026-11-07; CPU | in progress, approved |
| X1 | Error analysis of E50 / LoCoMo stores (no training) | how much is false writing on non-fact turns, attribute misfiling, entity errors, value fragments | CPU | none (analysis) |
| X2 | Iris memory schema v0 + IrisBench v0 (simulator v2, frozen test worlds, metrics of §6) | the yardstick for everything else | CPU + text rendering (local model on Kaggle GPU, or API) | owner: rendering route and budget |
| X3 | Zero-shot small open instruction models (≈0.5B, 1.5B, ~3B) emitting structured operations on IrisBench v0 + LoCoMo | how far an off-the-shelf generative model at the target size gets; sets the bar | Kaggle GPU (few hours) | owner: GPU hours after the central test |
| X4 | Data ablation: retrain PASTE and M1c (closed vocabulary) on realistic-surface data | how much of E50 is data | Kaggle GPU / CPU | after X2 |
| X5 | Vocabulary ablation: open-vocabulary attribute (copied attribute phrase + canonicalisation to stored names) vs closed | how much is the vocabulary | as X4 | after X2 |
| X6 | Fine-tuned ≈1-2B extractor (text memories vs compressed memory tokens) | the Iris 1 extractor candidate | GPU (external budget likely) | owner: compute |
| X7 | Cascade: small always-on gate + extractor | recall lost vs compute saved | CPU | after X6 |
| X8 | Privacy classifier and leak-rate tests; retrieval index + reranker; proactive policy | infrastructure components with learned parts | CPU | after X2 |
| X9 | Downstream usefulness with a local agent model, later an API agent | does Iris context make agents better | GPU / API | owner: API budget |

## 9. Decisions for the owner

1. Rendering realistic text for the simulator: local open model on Kaggle GPU (free, competes with central-test
   quota; would start after the central runs) or an API budget (amount to be proposed with a pilot cost estimate).
2. GPU budget for X3 / X6 beyond Kaggle's free quota (X6 at ≈1-2B likely needs more than 30 h/week).
3. Whether IrisBench may later include consented real data from the team (privacy review first).
4. Whether the Iris memory schema should match the production Brain's current row format or define a new one
   (production stays untouched either way; this only fixes the research interface).
