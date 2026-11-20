# Matched LoRA pilot: Qwen3-4B-Instruct-2507 vs Gemma 4 E2B vs Qwen3-1.7B (proposal, 2026-11-20)

**Status: for approval. Nothing here has been run.** No training, no dataset change, no change to any existing
result, no test access. The owner chose the three systems after wave A: Qwen3-4B-Instruct-2507 (primary candidate),
Gemma 4 E2B (challenger), Qwen3-1.7B (incumbent control). Goal: higher memory precision and fewer false memories for
Qwen3-4B **without giving up useful recall**.

Files: `inspect_4b.py` → `inspect_4b_sample.jsonl`, `inspect_4b_labels.json` (manual reading), `infra_rules.py` →
`infra_rules.json` (deterministic-rule measurement). All read-only, on committed wave-A and r3 outputs.

## 1. Where zero-shot Qwen3-4B goes wrong (wave A, validation)

| Measure (closed loop unless noted) | Qwen3-4B | Note |
|---|---|---|
| False memories / 100 sessions | 150.8 | it stores the most of any system (263 content ops) |
| Skip traps stored (of 100 labelled) | **31** (open 26) | hypotheticals 46 %, hearsay 38 %, jokes 38 %, injections 31 %, secrets 16 %; fine-tuned 1.7B r3: 5-7 |
| `skip` ops emitted | 7-9 | it almost never uses the skip operation |
| Retractions | 0 of 7 (open 0 of 17) | never retracts correctly |
| Updates, right op + target | 7 of 10 (open 32 of 57) | already reasonable |
| Add recall | 15 % (open 19 %) | |
| Quote grounding | 96 % exact | not a problem |

False-memory taxonomy (`report_run.py`, closed): same statement with different value / slot 54, same value with a
different entity 36, statement not labelled 31, skip trap stored 28, date wrong or missing 27, other speaker's
statement 4.

**Manual reading** of a seeded, stratified sample of 42 of its 180 closed-loop false memories (single annotator, not
blind), scaled to all 180:

| What they really are | Est. share | Typical cases | Fixable by |
|---|---|---|---|
| Correct facts penalised by naming / granularity | **30 %** | generic entity `project`; snake_case attributes (`ielts_target_band`); fact stored on the user instead of the event or person; terse values ("7", "15000") | fine-tuning on label conventions |
| Wrong | **30 %** | **year rollover** (3 of 6 date items: "13 January" resolved to 2026 in a late-2026 conversation); wrong person; inverted direction (who covers whose shift); another speaker's question stored as the user's task; Urdu weekday misread; an update written into an unrelated stored memory; a self-written caption stored | fine-tuning; a few by guard rules |
| True but not worth storing | 18 % | transient status ("all pods green"), requests to the assistant, release notes on a screen | fine-tuning (storage threshold) |
| Skip trap stored | 12 % | hypotheticals ("maybe I'll…", "sochta hun…"), hearsay, planted instructions aimed at AI assistants | fine-tuning; guard rules for injections and secrets |
| Partly right | 11 % | missing `when`; value left in Urdu script (contract asks for English) | fine-tuning |

**Reading:** almost everything that makes zero-shot 4B imprecise is what supervised training on our labels teaches:
the storage threshold, skip decisions, label conventions, year resolution, retractions. The 1.7B fine-tune (r3)
already shows it: skip traps 5-7 % instead of 31 %, guard-rule hits near zero (below).

### Deterministic infrastructure (measured, `infra_rules.json`)

Four candidate guard rules taken from the contract and data spec, applied after `contract.guard` (closed loop replayed
with the rule inside the loop):

| Rule | Zero-shot 4B closed: false / 100, correct ops lost | Fine-tuned 1.7B r3 closed: false / 100, correct lost |
|---|---|---|
| none | 150.8 | 183.3 |
| R1 PIN-like attribute / value (current `SECRET_RE` has "pin code", not "pin") | 148.3, 0 lost | 183.3, 0 |
| R2 update must reuse the stored attribute (CONTRACT.md) | 135.0, **5 correct lost** | 182.5, 1 |
| R3 quote inside a sentence addressed to AI assistants | 143.3, 0 lost | 183.3, 0 |
| R4 another speaker's question stored about the user | 147.5, 0 lost | 180.8, 0 |
| all four | 123.3, 5 lost | 180.0, 1 |

* R1, R3 and R4 are near-free safety nets; R2 costs correct updates for zero-shot models and does almost nothing after
  fine-tuning.
* **Guard rules are not the lever for precision after fine-tuning** (r3: 183 → 180). They are worth adding to the
  product guard as defence in depth (secrets, injections), evaluated identically for every model as a **secondary**
  report. The primary pilot metrics keep the current guard, so the pilot compares models, not guards.
* Caveat: noticed and measured on validation; gains are optimistic.

### What prompting can do

For fine-tuned models the system line is fixed and short; prompting is not a lever. For zero-shot use, prompt v1.1
helped little (wave A). No prompt work is proposed for the pilot.

### Gemma 4 E2B in brief

Fewer ops (133 closed), weaker format compliance (valid 48 %), 20 % ungrounded quotes, the same convention and trap
problems at lower volume. Its zero-shot P@60 was about half of 4B's.

## 2. Proposed amendment A3 to the selection rule (not in force until approved)

> **A3 (proposed 2026-11-20, after wave A results; owner decision).** The wave-A selection rule of EVAL-PLAN §7 and
> its outcome (no qualifier) stay on record unchanged (`WAVE-A-RESULTS.md` §3).
>
> *Why the rule was unsuitable:* it required each candidate to have fewer closed-loop false memories than zero-shot
> Qwen3-1.7B. That baseline emitted no operation in 113 of 120 closed-loop sessions (14 content ops in total, none
> correct), so the only way to have fewer false memories was to store almost nothing, and its P@60 was undefined.
> The rule therefore rewarded silence, contradicting EVAL-PLAN §5, whose primary metrics were chosen so that a silent
> model cannot win. A baseline that does not attempt the task is not a usable reference for a false-memory comparison.
>
> *Replacement for entry into the pilot:* systems are ranked by closed-loop P@60 among those that are not
> under-covering. Gaps smaller than the measured hardware noise (0.05 P@60) do not separate systems. On wave A this
> gives Qwen3-4B-2507 (0.35) and Gemma 4 E2B (0.18); Qwen3.5-2B (0.10) is not advanced. The incumbent Qwen3-1.7B
> enters as the control by design, not by rule.
>
> *Disclosure:* this amendment was written after the wave-A results were known. It is an owner decision, not a
> pre-registered outcome, and is reported as such.

## 3. Training setup (identical for the three systems)

| Item | Setting | Why |
|---|---|---|
| Train data | `data/built/train.jsonl` as committed (sha256 `2fdd84f7…`), **teacher shards only** (tr01-tr06: 584 observe + 245 retrieve = 829 examples, ~687k tokens per epoch with the Qwen tokenizer); the 60 drill episodes (`syn01`) are excluded **at load time** | drills did not transfer (I11); the r4 proposal drops them; the dataset file is not modified |
| Identical examples | an example is kept only if it fits 2,048 tokens in **all three** tokenizers, so every model trains on exactly the same list (the list and its hash are written to each run) | different tokenizers would otherwise drop different examples |
| Validation | `data/built/val.jsonl` (sha256 `0ae33173…`), 120 examples for checkpoint selection, every 50 steps | as r2 |
| Test | not uploaded, not read; the Kaggle dataset keeps excluding it and every kernel asserts it is absent | |
| Formatting | each model's **own chat template**, the same system line (`prompt.SYSTEM`) and template switches as in evaluation: Qwen3-1.7B `enable_thinking=false`, Qwen3-4B-2507 none, Gemma 4 `enable_thinking=false`. Loss on answer tokens only; the answer ends with the template's own end-of-turn token | train and test formatting must match; the current trainer hard-codes Qwen ChatML |
| LoRA | r 32, alpha 64, dropout 0.05, on q, k, v, o, gate, up, down of the **language-model decoder layers only** (Gemma: not the per-layer-embedding projections, audio or vision towers) | same rank and placement for all; trainable parameters scale with model width, which is the usual matched choice |
| Optimisation | AdamW lr 1e-4, cosine after 30 warm-up steps, batch 1 x accumulation 8, 2 epochs, grad clip 1.0, weight decay 0, seed 1 | the r4 base recipe: r2's validation loss was flat after about 2 epochs |
| Precision on T4 | fp16 frozen weights, fp32 LoRA weights, fp16 autocast with GradScaler, gradient checkpointing (as I15/I16) | the T4 has no bf16 |
| Checkpoint | best by validation loss (each model's own loss; comparable only within a model) | as r2 |
| Seeds | seed 1 for all three; seeds 2 and 3 for any system that meets the criteria in §5, before adoption | the seed spread is unknown |
| Export | LoRA merged into the base, converted with the pinned llama.cpp (7a4117e), quantised to Q4_K_M; Q8_0 too for the winner | the deployed artifact is a Q4 GGUF |

Code changes needed before training (to be reviewed in the same way as stage 0): `train.py` encodes through the
model's chat template and takes `exclude_shards`, a shared example list, and `template_kwargs`; a chat-template parity
test (training prefix == the server's `/apply-template` output for the same messages); an export kernel (CPU, no GPU
quota); a pilot evaluation kernel (as wave A, with `prompt.SYSTEM` and the fine-tuned GGUFs).

Not comparable and kept only as history: r2 / r3 (HF fp16 backend, unconstrained, drills in the data, 3 epochs). The
matched control is the **retrained** Qwen3-1.7B under the pilot recipe.

## 4. Evaluation (the wave-A protocol, unchanged except the system line)

Kaggle 2 x T4, llama.cpp 7a4117e CUDA, each model's chat template, greedy, JSON-Schema constrained (primary),
900-token cap, validation only, open and closed loop, 30-session unconstrained screen; `report_run.py` and
`summarize_wave_a.py` (same metrics, same bootstrap: 2,000 resamples over 24 episodes, seed 0). Secondary: the four
guard rules of §1 applied to every model; the va01-e01 exclusion; manual reading of 40 false memories of the leading
model (same verdict scheme as stage 0 and §1). Latency of record: the reference CPU (llama-bench).

## 5. Success criteria (pre-registered by this proposal; closed loop, validation, fine-tuned vs fine-tuned)

Primary comparison: **Qwen3-4B vs Qwen3-1.7B**. Gemma 4 vs Qwen3-1.7B under the same criteria. 4B vs Gemma descriptive.

A candidate **beats the control** only when **all** hold (95 % paired episode-bootstrap intervals):

1. **Fewer false memories:** Δ false memories per 100 sessions, upper bound < 0.
2. **No recall sacrifice:** Δ strict recall, lower bound ≥ −0.03 (non-inferiority: at most 3 points below the control).
3. **Higher precision at equal volume:** precision of the candidate's N most confident content ops (N = the control's
   number of content ops) minus the control's precision, lower bound > 0. Both models are judged on the same amount
   of storage, so storing fewer memories cannot produce a win.
4. **Better end state:** Δ end-state F1 (closed loop), lower bound > −0.02.
5. **Larger than hardware noise:** the point estimates of criteria 1 and 3 exceed the measured CPU/GPU noise (5 false
   memories / 100 sessions, 0.05 precision).

How each part closes a loophole: criterion 1 alone could be met by storing less; criterion 2 forbids that; criterion 3
compares precision at the same storage volume; criterion 4 keeps the store itself from getting worse.

Then:
* Met with seed 1 → train seeds 2 and 3 for the candidate and the control; pool the seeds per episode (as in the r4
  proposal) and re-test. Adopt only if the pooled result still meets all five.
* Not met → report as is. No extra arms are added in search of a win.
* Reported against, not gated: the r4 targets (closed strict F1 ≥ 0.45, false-memory share ≤ 0.50), skip-trap storage,
  retraction precision and recall, year-resolution errors, Urdu-script / Roman-Urdu slices (descriptive), and CPU
  latency per batch (4B is about 2.3x the 1.7B cost).

## 6. Kaggle GPU estimate

Measured basis: r2 trained Qwen3-1.7B at 626 tok/s on one T4 (fp16, gradient checkpointing). Pilot data: about 1.37M
training tokens over 2 epochs. 4B and Gemma speeds are **estimates** scaled by compute per token, to be replaced by the
smoke test.

| Stage | Where | What | Estimate |
|---|---|---|---|
| P0 smoke | GPU, 1 session | download the three HF checkpoints; for each: template parity, 20 training steps in fp16 (finite loss, peak VRAM, tok/s); Gemma fp16 overflow check | ~0.6 h |
| P1 train, seed 1 | GPU, 2 x T4 | T4 #0: Qwen3-4B (~260 tok/s, ~1.5 h with validation checks); T4 #1: Qwen3-1.7B (~40 min) then Gemma 4 E2B (~450 tok/s, ~55 min) | ~1.8 h session |
| P2 export | **CPU kernel** (no GPU quota) | merge, convert, Q4_K_M (+ Q8_0) | ~1 h CPU |
| P3 evaluate | GPU, 2 x T4 | three fine-tuned systems, open + closed + unconstrained screen | ~0.8 h |
| **Total, seed 1** | | | **~3.2 GPU-session-hours** (up to ~6.4 if a 2-GPU session bills double) |
| Seeds 2-3 (only if §5 is met) | GPU | 4B + 1.7B, train and evaluate | ~+4 h |

Quota: about 10 h remain until the 21 November reset, then 30 h. Seed 1 fits now; seeds 2-3 would fall after the reset.

## 7. Risks

* **Gemma on T4:** 5.1B stored parameters (≈ 10 GB in fp16) and a history of fp16 activation overflow in Gemma
  models. The smoke test checks VRAM and finiteness. If it fails, the options are QLoRA (4-bit) for Gemma alone
  (reported as a deviation) or dropping Gemma from the pilot; no silent change.
* **Qwen3-4B memory:** about 8 GB of fp16 weights plus activations at 2,048 tokens; it should fit with gradient
  checkpointing, and the smoke test confirms it.
* **Data ceiling:** the pilot uses the current labels (Opus shards are noisier). It measures the foundation effect under
  today's data; r4 data work stays the main lever for false memories (REPORT §1).
* **One seed** until §5 is met; the bootstrap covers episodes, not training noise.

## 8. Decisions needed

1. Approve amendment A3 (§2) as written.
2. Approve the training setup (§3), evaluation (§4) and success criteria (§5).
3. Approve the code changes and smoke test (P0, ~0.6 GPU-h), then P1-P3 (~2.6 GPU-h) for seed 1.
4. Gemma fallback if the smoke test fails: QLoRA for Gemma (deviation) or drop Gemma.
5. Whether to add guard rules R1, R3, R4 to the product guard later (separate change; not part of the pilot metrics).
