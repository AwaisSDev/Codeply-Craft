# Iris: technical audit of the existing Codeply research (2026-11-09)

Read-only inspection of both repositories and every research branch of `AwaisSDev/Codeply-Craft`, done before
any design decision. Tags: **[M]** measured or checked in this session, **[R]** read from a committed document.

## 1. What exists

| Branch (tip) | What it holds | Status |
|---|---|---|
| `main` | The product. `codeply-cli/lib/brain.js` (SQLite `memories`, `observe()` → insert / reinforce / replace / challenge, `SECRET_RE`, audit table) and `life-store.js`. No context engine, no model. | shipped |
| `codeply-local-intelligence` | Context engine (`context-engine.js`, `context-model.js`, `context-prompt.js` v2, `context-schema.js`, `context-retrieval.js`, `context-redact.js`), `ml/` harness, LoRA script, model catalog. Best local model LFM3-1.7B QAD Q4: F1 0.80 generated / 0.70 hand-written, **42 % false memories**, p95 18 s; no model passed the release gate. [R] | research |
| `codeply-li-architecture-research` | Architecture study; PASTE v1 paper spec. [R] | research |
| `codeply-li-dtw-experiment`, `codeply-memarch-research` | Decide-then-Write encoders (Ettin-150M / 400M) and **LFM3-1.7B LoRA**: F1 0.657 test-real / 0.653 Benchmark-520, false-memory rate 0.30, p50 5.5 s / p95 21.9 s on CPU. [R] | research |
| `codeply-memory-model` (+ `-integration`, `codeply-brain-value-match`) | "Memory model v1" release candidate = that LoRA, merged, Q4_K_M (1.10 GB), opt-in only, not merged to main. Weights in a private Kaggle dataset. Duplicates gate fails (2 / 4). [R] | frozen candidate |
| `research/paste-architecture` | PASTE vs M1c central experiment (pre-registered; GPU runs scheduled 2026-11-07, **no results committed**), and **Iris 1**: roadmap, schema v0 (`iris/schema.py`), life simulator v2, renderer + verifier, evaluators, production baseline ports, IrisBench v0 protocol (draft). [R] | Iris blocked on data |
| `dtw-artifacts` | README only at the tip (weights moved to private storage). [M] | — |
| `last-checkpoint` | Map of all branches; research deliberately left out of the product branch. [R] | — |

Definitions kept straight: **Iris** is the context-intelligence project. **PASTE** is a training / architecture
method under test. **M1c** is its comparison baseline (the same encoder reading Brain records as text), not a
method. **Pollen** is a separate model; nothing of it is in these repositories and nothing of it is used here.

## 2. Where Iris stood, and why

No Iris model had been trained. The plan (IRIS-IMPLEMENTATION-PLAN.md) was at step 3 of 8, blocked on data:

* IrisBench v0 fixes the gold first (life simulator) and then asks a local open model to render conversations
  that state exactly those facts. Every generator tried (Phi-4-mini, Qwen3-4B, Qwen3-30B-A3B) added or
  contradicted memory-worthy facts in **31-38 %** of renders, against a pre-registered limit of 5 %; an in-loop
  model checker brought the best candidate to 9 % on a fresh test (E56-E60). No validation data was rendered.
* E50: PASTE and M1c trained on dense synthetic turns do not transfer to real assistant chats (retrieval at or
  below chance on LongMemEval). Measured cause: 73 % of training segments carried a fact, against 15 % of user
  turns in real chats; 15-word turns against 42; 4-word assistant replies against 356.
* E55 (pilot): production as shipped stores mostly non-gold memories (false-memory share 0.98; render extras
  inflate this); zero-shot Qwen3-4B 0.92; rules 0.25.
* E52 / E53: with perfect memory, production-style context assembly leaks sensitive memories into 32 / 100
  frontier-bound tasks; a sensitivity boundary at assembly removes them at no recall cost.

## 3. What this work reuses

| Reused | From | How |
|---|---|---|
| Brain vocabulary and outcomes | `brain.js`, `iris/schema.py` | Iris ops map one-to-one onto insert / replace / reinforce / forget / challenge (`contract.to_brain`) |
| Production extraction prompt v2, rules extractor, output guard (research ports) | `research/paste/iris/baselines/production.py` | imported read-only as IrisBench baselines |
| Provider contract `extract({events, known, now})` | `context-model.js` | the integration module implements it |
| Lessons | E50, DtW, memarch | fact-sparse realistic text; operations with explicit targets; closed-loop evaluation; cost-weighted precision; template data never used for evaluation |
| Statistics | EVALUATION-PROTOCOL.md | paired cluster bootstrap over episodes, frozen test split, validation-only tuning |

## 4. What is redesigned, and why

| Earlier choice | Problem | Iris choice here |
|---|---|---|
| Gold first, then render text to match | renders add facts the gold lacks (31-38 %) | **text and labels written together** by a frontier teacher, checked by a deterministic validator and an independent blind re-labelling |
| Closed 101-way attribute vocabulary, copied-span values | cannot name new attributes; fragments (E50) | open-vocabulary `attr`, normalised `val`, plus a verbatim evidence quote that infrastructure verifies |
| Gold tied to one store state | a missed fact made later gold wrong | gold is a **function of the store**: the same labelled session yields correct ops for any store, including the model's own |
| Encoder with heads (32M-400M) | precision ceiling ~0.3-0.4 F1 on real text | small generative model with a strict JSON contract (the direction IRIS-DESIGN §4 ranked first) |
| 1.7B model on every batch | p50 5-12 s, p95 18-28 s on CPU | a 0.6B model: about a third of the latency and memory; the 1.7B sibling is a config switch away when a GPU is available |

## 5. What could not be reached from this session

* **Memory model v1 weights** (the strongest earlier baseline): private Kaggle dataset, no credentials here.
  Its published numbers are on its own benchmark (WildChat-derived, span extraction) and are not comparable.
* **PASTE vs M1c results**: none committed; that experiment and its test set are untouched.
* **Private data stores** (Hugging Face `paste-data`, `paste-checkpoints`): no token. Nothing private was read,
  and nothing private is in this branch.
* **GPU**: none. 4 CPU cores (AMX / AVX-512 bf16), 15 GB RAM. All training in this work ran on that CPU.

## 6. Constraints carried over

No WildChat-derived data. Non-commercial public sets (LoCoMo, PerLTQA, HaluMem) evaluation-only and not used
here. Production, frozen releases and `research/paste/` are not modified: everything new is under
`research/iris/` on the `codeply-iris` branch. `AwaisSDev/Codeply-Craft` is a **public** repository, so this
branch is public; it contains only fictional synthetic data, code and documents.
