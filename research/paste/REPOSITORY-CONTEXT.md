# PASTE: repository context (read before any implementation)

Date 2026-11-01. Branch `research/paste-architecture`. This report records
what earlier work exists, what PASTE will reuse, what it will avoid, and why.
Earlier work is treated as **research context, not a constraint** on PASTE's
architecture.

Tags: **[M]** checked in the repository in this session, **[R]** read from a
committed document and not re-measured.

## 1. Base commit

| | |
|---|---|
| Base branch | `codeply-memarch-research` |
| Base commit | `672696c0976111a84a791737395ac02e10fb18f6` (2026-11-01 12:34 UTC, "memarch: three-seed Ettin-400M, calibration/tiers results, WildChat audit summary") |
| Ancestry | `main` (`c43940e2`) → `codeply-local-intelligence` → `codeply-li-architecture-research` → `codeply-li-dtw-experiment` @ `30b228c6` → `codeply-memarch-research` [M] |

Why this base:

* It holds everything PASTE builds on: the PASTE v1 paper specification
  (`research/architecture/PASTE-FORMAL-SPECIFICATION.md`), the literature
  critique (`research/memarch/01`), the evaluation harness (`ml/eval/run.mjs`),
  the DTW provider and Kaggle notebooks (`research/dtw/`), and the Brain code.
* `research/dtw/data` and `research/dtw/benchmark` are byte-identical to the
  newer `codeply-li-dtw-experiment` tip (`a44320e8`) [M]. The DTW branch's
  later commits are calibration/tier results, which PASTE only reads.
* `main` lacks the harness and every research document.

**Isolation rule for this branch.** PASTE writes only under `research/paste/`.
Nothing under `research/dtw/`, `research/memarch/`, `research/architecture/`,
`ml/`, `codeply-cli/` or any production file is modified. No other branch is
merged, rebased or pushed to. The DTW evaluation continues on its own branch.

**Visibility.** `AwaisSDev/Codeply-Craft` is a **public** repository [M], and
pushing this branch publishes it, as earlier research branches were. No
credentials, private data or WildChat text will be committed.

## 2. What already exists that matters to PASTE

### 2.1 PASTE v1 already exists as a paper spec, with pre-registered rules

`research/architecture/PASTE-FORMAL-SPECIFICATION.md` (2026-10-31, not built):
Ettin-150M backbone; Gated-DeltaNet segment state in 3 layers;
16 typed profile slots read by attention in 2 layers; a controller that
predicts a segment type and a write gate; cosine addressing with collision
protection; profile slots initialised from Brain memories ("slots are a
cache of the Brain"). Its own decision rule: **PASTE is only worth building
if it beats M1c**, i.e. the same encoder run chunk by chunk with the Brain fed
forward as explicit known memories. The new brief's baselines 6-10 match this.
I adopt that rule.

### 2.2 The earlier critique says PASTE could not be tested on the existing data

From `research/memarch/00-STATE-OF-PLAY.md` §5 and `01-LITERATURE-AND-CRITIQUE.md` [R, spot-checked M]:

* Every existing example is an **independent snippet** (train mean 238 tokens,
  max 1,462). There are no per-user sequences. Known memories exist in only 235
  train examples, all constructed synthetically. On this data, segment
  recurrence and persistent state have **nothing to carry and nothing to be
  scored on**.
* No PASTE component is new as a mechanism. The closest prior art:
  * Transformer-XL, RMT on BERT, Block-Recurrent;
  * EntNet, LM2, Titans, Gated DeltaNet;
  * SOM-DST and TripPy (per-slot operations over an explicit state);
  * Keep Me Updated (PASS / REPLACE / APPEND / DELETE).
  "Type-conditioned decay" is a re-parameterisation of input-dependent gates.
* Production memory must stay **explicit and auditable** (the user can see,
  edit, undo and delete it). Latent persistent slots conflict with that unless
  they are rebuilt from the Brain on every call.
* About 5K labelled examples cannot teach a randomly initialised model
  language. BERT-base without pretraining scores GLUE 45.5 against 80.9
  pretrained. **Pretrained initialisation is required.**

**Consequence for PASTE.** The new brief asks for sequential, multi-segment
examples. That is the missing precondition. PASTE becomes testable only once
that dataset exists, and M1c must be evaluated on the same dataset.

### 2.3 Results PASTE inherits as context (not as targets)

From `00-STATE-OF-PLAY.md`, short inputs, F1 [R]:

| System | Benchmark-520 | test-real | Notes |
|---|---|---|---|
| Rules | 0.091 | 0.097 | |
| LFM3-1.7B QAD (production) | 0.575 | 0.300 | p50 4.8 s |
| Ettin-150M, realistic data, 3 seeds | 0.389 ± 0.012 | 0.341 ± 0.011 | p50 ~0.45 s |
| Ettin-400M, realistic data, 3 seeds | ~0.41 | 0.413 ± 0.012 | p50 ~1 s, ~750 MB |

These numbers are on WildChat-dominated test sets and a different task
format (span extraction). They are **not directly comparable** to PASTE's
sequential task. Section 4 explains how comparisons will be made.

## 3. What I will reuse

| Component | Where | How PASTE uses it |
|---|---|---|
| Brain memory vocabulary | `codeply-cli/lib/brain.js:60-85`, `:17`; `context-schema.js:86-124` | Kinds (preference, fact, routine, style, decision, idea, requirement, todo, context), certainty (stated, implied, temporary, joking, hypothetical, quoting), status (confirmed, tentative, temporary). PASTE's targets use these names, so its output maps onto `brain.observe()` input without translation |
| Brain action semantics | `brain.js:355-471` | Brain outcomes are added, reinforced, replaced, challenged, kept, ignored and forgotten. The brief's actions map onto them: WRITE→added, UPDATE→replaced/challenged, MERGE→reinforced, IGNORE→ignored, FORGET→forgotten. RETRIEVE is a read, not a Brain write. The mapping is documented in the spec, and the Brain stays the executor |
| Brain guard rules as **baseline**, not as model logic | `brain.js:87` (`SECRET_RE`), `:361`; `context-schema.js:157-218` | The deterministic rules baseline (brief baseline 1) is built from these rules. They are not copied into the network |
| Evaluation harness adapter interface | `ml/eval/run.mjs:66-97`, `context-model.js:3-7`, reference `research/dtw/runtime/dtw-provider.mjs` | A `module:` provider lets PASTE be scored **read-only** on Benchmark-520 as a short-input sanity check against existing numbers. Nothing in `ml/eval` is edited |
| Statistics | `research/dtw/eval/analyze.mjs` (paired bootstrap, McNemar) | Same methods, reimplemented in Python under `research/paste/` for the sequential metrics |
| Operating-point discipline | `research/dtw/CALIBRATION-PROTOCOL.md` (cost r·FP + FN, r ∈ {2, 3, 5}, 3 primary; owner decision) | Write thresholds are chosen on PASTE validation only, at 3:1. Every system is calibrated the same way, so architecture and threshold are never confounded |
| Kaggle workflow and its fixes | `research/dtw/notebooks/make_notebooks_real.py`, `KAGGLE-RUNS.md` | Clone under `/tmp`, verify data hashes before training, read logs with `kernels_logs()`, save artifacts at the end of each run. Starting settings: fp16 + GradScaler on T4 (not emulated bf16), gradient checkpointing, small micro-batches with accumulation, one seed per GPU |
| Artifact storage pattern | orphan branch `dtw-artifacts` (69 files, ~3.1 GB) | PASTE checkpoints go to a **new** orphan branch `paste-artifacts`. `dtw-artifacts` is not touched |
| Backbone | `jhu-clsp/ettin-encoder-32m` (MIT [M]: d 384, 10 layers, 6 heads, vocab 50,368, context 7,999) | ~32M parameters, of which ~19M are embeddings. With PASTE modules the total is ~35-40M, inside the 20-50M target. Ettin-17M is used for the smaller comparison. The same family gives a controlled, parameter-matched transformer baseline |
| Literature base | `research/memarch/01` (≈90 sources with arXiv ids) | Starting bibliography. Each claim is re-checked and extended through 2026 for `LITERATURE-REVIEW.md` |
| Clean-licence real text | `research/dtw/data/real/*.jsonl` rows whose `source.dataset` is MultiWOZ (MIT), Topical-Chat (CDLA-Sharing-1.0) or UCI Roman Urdu (CC BY 4.0) | Real human phrasing for segment content and distractors (~780 train rows). **Read only**: rows are copied into a new PASTE dataset, filtered by source, and the frozen files are never edited. Rows from the frozen val/test splits never enter PASTE training |

## 4. What I will avoid, and why

| Avoid | Why |
|---|---|
| **Any WildChat-derived example** (3,315 / 378 / 425 / 298 rows of train / val / test-real / natural-300, plus the 693 Claude rewrites that carry the WildChat source) | Licence (ODC-BY covers the database, not users' text), privacy (cross-split user overlap, 17 weak minors-score ids, residual PII) and moderation review are unresolved (`label/audit/WILDCHAT-AUDIT.md`, owner decision 2026-11-01). The brief forbids it. As a result, test-real and natural-300 are also **not** used to evaluate PASTE |
| Template-only training data | DTW lesson [R]: Ettin trained on 8,000 template examples scored 1.000 on template test data and collapsed on real text (natural-300 F1 0.015, noise kept out 0.014). Realistic data, not architecture, fixed it. PASTE data therefore needs lexical diversity, real-text segments, and held-out template families and entities. Evaluating on templates seen in training would only measure memorisation |
| Training from scratch | 5K-50K examples cannot teach language (§2.2). PASTE modules sit on a pretrained encoder and start as the identity (zero gates), so step 0 equals the baseline encoder |
| Persistent latent memory that outlives a call | Conflicts with the Brain's auditable store. Following PASTE v1 §2.5, persistent slots are **initialised from Brain memories each call**, and PASTE only *proposes* actions. Temporary state may persist between segments within one conversation, and it is never written to the Brain without an explicit write decision |
| Tuning on Benchmark-520 or any DTW frozen file | They are frozen for the DTW protocol. PASTE reads Benchmark-520 once, at the end, as a short-input check |
| Copying DTW numbers as PASTE baselines | Different task, data and metrics. Baselines are **retrained on the PASTE dataset** with the same backbone, budget and seeds |
| A llama.cpp/GGUF runtime | llama.cpp cannot run a delta-rule state or slot cross-attention (PASTE v1 §4). PASTE's CPU numbers come from PyTorch, with ONNX Runtime and int8 quantisation explored in Phase 7. Production-runtime work needs the owner's approval |
| Re-running LFM3 or Ettin-150M/400M on the new data in this phase | Expensive, and production-adjacent. Existing numbers are cited as context. Running them on the PASTE set is listed as optional, and needs approval if it costs Kaggle quota needed for PASTE seeds |

## 5. Lessons from earlier failures that change the plan

1. **Data realism beat architecture.** Every gain so far came from data:
   template → realistic data took natural-300 F1 from 0.015 to 0.241. PASTE's
   result will be read with that in mind. If a simple baseline matches PASTE
   on the new data, the report says so.
2. **Precision is the binding weakness** (about three predicted memories per
   real one). Persistent-write precision is a primary metric, with
   cost-weighted thresholds fixed on validation.
3. **Coverage gaps sink categories.** Train had 15 jokes and 11 quotes against
   62 and 66 in the benchmark. The PASTE generator sets per-category minimums
   for all 17 brief categories.
4. **Cross-split leakage.** DTW dropped 206 merge examples because their
   known memories came from another split. PASTE builds stores only from the
   same split and splits by **conversation family and entity set**.
5. **Kaggle:** T4 OOM at batch 32, emulated bf16, NaN from an unfiltered
   example, and a 12-hour limit with nothing saved. The fixes are listed in
   §3. PASTE checkpoints every epoch and pushes artifacts per run.
6. **Feeding a model its own predicted state multiplies errors**: SOM-DST
   2.47× [R]. PASTE's sequential evaluation runs **closed-loop** (the model's
   own previous decisions build the next store) as well as with the gold
   store, and reports both.

## 6. Open points that need the owner (not blocking Phase 2-3)

1. **Track B.** On 2026-11-01 you decided "closed-loop multi-session: not now,
   without real multi-session data". This brief asks for sequential
   multi-segment data. I read the brief as superseding that decision **for
   synthetic and licence-clean sequential data only**. No WildChat user
   linkage is used. Please confirm.
2. **Generation budget.** Diverse sequential data is best produced by an LLM
   writer plus programmatic counterfactuals, with deterministic validation.
   The writer would be the Claude API, on your key. I will estimate the cost
   from a small pilot and ask before any bulk spend. The fallback is a
   programmatic generator with heavy lexical variation (no API cost, higher
   memorisation risk).
3. **Kaggle quota.** Free T4 quota is about 30 GPU-hours a week. The plan
   (§7) fits inside one week's quota. Verifying the credentials only uses
   the API.
4. **Public visibility.** This branch lives in a public repo, as the
   earlier research branches do. Generated data and checkpoints would be
   public too, unless you want them elsewhere (for example a private Hugging
   Face repo, or a separate private GitHub repo).

## 7. Order of work (from the brief, adapted)

1. **Done:** repository inspection (this file), and branch created from `672696c0`.
2. Literature review and architecture hypotheses: re-verify and extend the
   memarch bibliography to 2026, including prior art for each PASTE mechanism.
3. Architecture spec v2 for a ~35-40M model on Ettin-32M, with the smallest
   set of mechanisms and the baselines fixed in advance.
4. Prototype plus unit tests on CPU (segment processing, addressing, slot
   update, temporary/persistent separation, write control, serialisation,
   determinism).
5. Sequential dataset: generator, validator, leakage checks, frozen test and
   stress sets with hashes. The frozen test set is not read until the final
   evaluation.
6. Pilot on CPU, then full training on Kaggle: PASTE and parameter-matched
   baselines, 3 seeds each.
7. Evaluation and ablations, checkpoint, `EVALUATION-REPORT.md`. Only then is
   Brain integration discussed.
