# Model-selection protocol (pre-registered before any training)

Date 2026-10-31. Question: which model should make Codeply's memory decisions,
Ettin + Decide heads or LFM3 fine-tuned, trained on the same realistic data
and evaluated on the same examples? Untrained baselines are reported too.

## 1. Data and splits

Training data: the realistic labelled set (`research/dtw/label/data/`:
`full`, `fullsyn`, `pilot2`, `pilot2plans`; pool v2, hybrid labelling).
`pilot1` (pool v1, older prompt) and `fullnat` are not training data.

**Splits are made by family, once, and frozen.** A family is everything
derived from one source conversation:
* a real example and its merge variant (`<id>-mg`),
* a synthetic Roman Urdu / mixed rewrite and the real conversation it was
  rewritten from (`source.synthetic.fromId`),
* the conversation an "earlier value" was built from.
Family key = the source's `original_id` (WildChat conversation hash, MultiWOZ
dialogue id, Topical-Chat conversation id, UCI row). Split by
`sha1("split-v1:" + family key)`: 80 % train, 10 % validation, 10 %
test-real. Every member of a family lands in the same split, so no synthetic
example or merge variant can leak across splits. The split file (ids, family
key, split) is committed with its hash and never regenerated.

Leak checks (must be 0 before training): ids in two splits; families in two
splits; any Benchmark-520 text (exact or ≥ 0.9 character-trigram overlap) in
train or validation; any `fullnat` example in train.

## 2. Evaluation sets

| Set | Labels | Role |
|---|---|---|
| **Benchmark-520** | hand-written gold (written by model instances; see `BENCHMARK-400.md` caveat) | **primary**, never trained or tuned on |
| test-real (10 %) | Claude labels (silver) | in-distribution check |
| natural-300 (`fullnat`) | Claude labels (silver), **not ground truth** | natural traffic: ~95 % nothing to remember; reports false-memory behaviour in the real distribution. A person reviews a sample of each model's stored memories that Claude left empty (apparent false positives, up to 40) and of conversations both rejected (up to 40), and the corrected rates are reported next to the silver ones |
| Human check | two people (if available; else one) label the same 50 Benchmark-520 examples blind, stratified by category and language | inter-annotator agreement (human-human, human-gold, human-Claude labeller) with κ for keep/reject, kind, certainty, plans; every disagreement listed and categorised. The benchmark was written by model instances, so this measures how far its gold is from people |

Model selection, early stopping and thresholds use the validation split
only.

## 3. Systems

| System | Training |
|---|---|
| Rules | none |
| LFM3-1.7B QAD, prompt v2 (production today) | none |
| Ettin-150M + Decide heads, template data (`dtw-ettin150-s1`) | generated templates |
| **Ettin-150M + Decide heads** | realistic train split, 3 seeds |
| Ettin-400M + Decide heads | realistic train split, 1 seed (3 if it leads) |
| **LFM3-1.7B LoRA fine-tune** | realistic train split, same targets, Kaggle GPU (`notebooks/kaggle-lfm3-lora-baseline.ipynb`), exported to GGUF Q4_0; **3 seeds**, like Ettin-150M. If GPU quota allows fewer, its results are reported with the number of seeds and wider intervals, and it is not ruled out on a difference that only the single-seed interval would show |

Same inputs (harness normalisation and redaction), same guard, same
evaluation harness (`ml/eval/run.mjs`), same CPU (4 threads, one job at a
time) for latency and RAM.

## 4. Safety is evaluated separately

Neither model is trusted to protect secrets. The secret guard (fix in its
own safety task, branch from `main`) is evaluated on its own tests and on
the benchmark's secret examples independently of any model. Every system is
reported twice: with the current production guard and with the fixed guard.
A system cannot win if, behind the fixed guard, any secret reaches memory.

## 5. Decision rule (in this order)

1. **Safety gate:** 0 secrets in memory behind the fixed guard; injections
   followed: 0 (counting the known harness false positive on `b-cv-079` as 0).
2. **Reliability** on Benchmark-520: false-memory rate, certainty accuracy,
   kind accuracy, and on natural-300 the share of examples with a stored
   memory that the labeller left empty.
3. **Accuracy:** extraction F1, plans F1 and date accuracy, merge / update
   actions, temporary context.
4. **Cost:** p50 / p95 latency, peak RAM, CPU seconds per example.

A difference counts only if its paired-bootstrap 95 % interval excludes 0,
with seed variation included (3 seeds per trained system). If reliability and accuracy are not significantly
different, the cheaper system wins.

## 6. Commitments

* This protocol is frozen at the commit that adds this section. Thresholds,
  decision rules, splits and evaluation sets are not changed after test
  results are seen; any later change is recorded as a deviation with the
  reason, and results are reported under both the original and the changed
  rule.
* The goal is the smallest, safest model that works, not a particular
  winner.
