# Public benchmark: LongMemEval (pre-registered secondary evaluation)

Status 2026-11-04: **pre-registered before any public-benchmark number exists.** Owner request (2026-11-04): add
benchmarking on public data, because the central test uses our own (frozen, private) benchmark. This evaluation is
**secondary**: it does not change the central test, its rules or its outcome (CENTRAL-TEST-PLAN, spec §10.5).

## Benchmark

* **LongMemEval** (Wu et al., ICLR 2025, arXiv:2410.10813), HF `xiaowu0162/longmemeval-cleaned`, **MIT licence**
  (dataset card, main branch). 500 questions over a user's chat history with an assistant; question types:
  single-session-user (70), single-session-assistant (56), single-session-preference (30), multi-session (133),
  knowledge-update (78), temporal-reasoning (133); 30 abstention questions (`_abs`). Evidence turns are marked
  (`has_answer`).
* Files and SHA-256 (downloaded 2026-11-04, kept off the repository in `~/paste-public/longmemeval/`):
  `longmemeval_oracle.json` 821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c;
  `longmemeval_s_cleaned.json` d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442.
* **Oracle** (only the evidence sessions, ~22 turns per question): primary public setting. **S** (~40 sessions,
  ~490 turns per question, mostly distractors): secondary, run if compute allows (measured, not assumed).
* LoCoMo (Maharana et al., 2024) is **not** used without an owner decision: its licence is reported as CC BY-NC 4.0.

## What is measured, and why without an LLM

PASTE and the M1c family do not answer questions; they write, update and forget memories and score stored memories
for retrieval. LongMemEval's official QA accuracy needs an answering LLM and a GPT-4o judge (API cost, and it would
measure the answering LLM as much as the memory). We use LongMemEval's evidence labels instead, with metrics that
need no LLM:

| Metric | Definition | Role |
|---|---|---|
| **Evidence Recall@10** (primary public metric) | At question time, the question is given to the system as a user turn; its retrieve head scores every stored memory; a question is a hit if any of the 10 highest-scoring memories was written, updated or reinforced from an evidence turn (`has_answer`) | the memory system's job end to end: did it store the answer-bearing information, and can it find it for the question |
| Evidence Recall@5 | same, top 5 | sensitivity |
| Answer-in-memory | some stored memory's text (profile, attribute, value) contains ≥ 80 % of the gold answer's normalised tokens | did the answer itself get stored |
| Evidence capture | share of evidence turns (user turns) that produced at least one stored memory | write recall |
| Memories per 100 turns | final store size / turns × 100 | store growth (noise) |

Scope: the **primary** set excludes single-session-assistant questions (they ask what the assistant said; the
systems are trained to store facts about the user and people they mention) and abstention questions (no evidence).
Both are reported separately. Results are also given per question type.

## Protocol (identical for every system)

* **Conversion**: every user turn plus the assistant reply that follows it is one segment (`turns`: user, then
  assistant, the assistant text cut to its first 600 characters); `at` = the session's date (+1 s per turn);
  `session_id` = LongMemEval session id. The store starts empty for every question. Encoder input is truncated at
  `seg_max` = 256 tokens as in training.
* **Closed loop**: the system's operations are executed by the same Brain simulator as in validation (`BrainSim`);
  new profiles are keyed by the system's own mention text. Each memory's source turns are tracked (write, update,
  reinforce, merge).
* **Rows per step**: all stored memories when ≤ 32, otherwise the 32 most recently updated (fixed rule, same for all
  systems; k_max = 32 as in the spec). At question time, memories are scored in chunks of 32 (by recency) and ranked
  by retrieve score.
* **Thresholds**: each checkpoint's frozen validation calibration (`calibration-full.json`); **nothing is tuned on
  LongMemEval.**
* **Checkpoints**: the central test's frozen runs (FROZEN-RUNS.json): PASTE, M1c, M1c-m, M1c+W, seeds 1-3.
* **Statistics**: seed-mean per system; PASTE − M1c and PASTE − M1c-m with 95 % paired bootstrap over questions
  (10,000 resamples), per-seed values listed. Descriptive only: no pass/fail rule is attached.
* An **exploratory** run with validation-phase checkpoints (equal budget: LC3000x2-PASTE, LC3000x2-M1c) may precede
  the central run to test the pipeline at scale; it is labelled exploratory and cannot change this protocol except
  for bug fixes, each recorded in DECISIONS.md.

## Limitations stated in advance

* Domain shift: the systems were trained on our synthetic personal-memory conversations; LongMemEval conversations
  are user requests to an assistant with incidental personal facts. Both systems face the same shift.
* These are memory-level metrics, not LongMemEval's official QA accuracy; numbers are **not comparable** to published
  LongMemEval QA results. An LLM-answered QA variant would need API budget and an owner decision.
