# Iris training recipe (v1) and compute

## 1. Method

Supervised fine-tuning of Qwen3.5-2B on `iris.v1` examples, all three modes mixed (observe ≈ 75 %, retrieve ≈ 20 %,
resolve ≈ 5 %), loss on the response only. LoRA r = 32, α = 64 on attention, Gated DeltaNet projections and MLP
(the memory model's LFM3 recipe: r32 / α64, 2 epochs, lr 2e-4, 2,048 tokens), merged into the base for release.
Grammar-constrained decoding at inference means the model is never trained on invalid JSON.

Why not more: the evidence (ARCHITECTURE.md §1) says data quality dominates. DPO and other extras are added only
for a measured failure (§3).

## 2. Curriculum

1. **Round 1, gold history.** Observe with the gold store (noise 0.3), retrieve, resolve. 2 epochs.
2. **Round 2, own history (anti exposure bias).** Run the round-1 checkpoint closed-loop over held-in training lives;
   its admitted outputs become the store; rebuild observe examples on that store with gold computed against it
   (the right op given *that* state: correct its own wrong value, link its own duplicate, leave unrelated memories).
   Mix 50 / 50 with round-1 data. 1 epoch. Repeat once if closed-loop val F1 still rises.
3. **Round 3, only if measured:** DPO on pairs (gold, the model's own false memory) when the false-memory share on val
   is above 0.15 after round 2; hard negatives from its own ungrounded items (`admit` drops).

## 3. Failure modes the recipe targets

| Failure (seen in production or the memory model) | Countermeasure |
|---|---|
| false memories 25-42 % | 50-70 % empty answers; evidence required; round 3 DPO if needed |
| jokes / quotes stored as facts | 5 % ignore slice (vs 26 examples before) |
| duplicates from slot drift | merge by id (`ref`), noisy-history `link same_as` |
| person facts stored as the user's | `about` + `entity` gold on every item |
| Roman Urdu misses | ≥ 15 % Urdu / Roman Urdu |
| conditioning on idealised history | round 2 own-history training |

## 4. Reproducibility

Fixed seeds (data, init, order), config files in `configs/`, every run logs tokens/s, loss, val metrics per half
epoch; checkpoints every 500 steps, resumable; backups append-only to the private HF repo (`paste/backup.py`).

## 5. Compute (measure first)

| Step | Where | Estimate (to be replaced by Phase-0 measurement) |
|---|---|---|
| Renders: 1,600 lives × ≈ 40 rendered events | Kaggle T4 / CPU with a local open model (decided 2026-11-04) | dominant cost; measured in E56-E60 per model |
| Phase-0 smoke test: tokens/s, memory, 200 steps | 1 T4 session | 1 h |
| SFT round 1: ≈ 8 K examples × ≈ 1.6 K tokens × 2 epochs ≈ 26 M tokens | T4 16 GB, fp16, LoRA, grad checkpointing | ≈ 3-5 h per seed if ≥ 1.5 K tok/s |
| Round 2 inference over ≈ 300 lives + 1 epoch | T4 | ≈ 3 h per seed |
| 3 seeds | T4 | ≈ 20-25 h total, within ≈ 30 h/week free Kaggle T4 quota |
| Evaluation: closed-loop val / test, all baselines | Kaggle CPU (5 parallel sessions) + this container | CPU-only, GGUF |

Risk: Gated DeltaNet training kernels (flash-linear-attention) on T4 (sm_75, no bf16). The Phase-0 smoke test decides;
the fallback rule in ARCHITECTURE.md §4.6 switches to Gemma 4 E2B if throughput is under 60 % of a same-size
transformer. No paid compute without the owner's approval.

## 6. Packaging

Merged fp16 weights + tokenizer + config, GGUF Q8_0 and Q4_K_M (importance matrix from val prompts), model card,
licence (Apache-2.0 base; data provenance; open legal question C3), the `iris.v1` grammar, `LOCK.json`, the release
evaluation, and a clean-environment check: fresh container, download, load in llama.cpp, run the contract tests and
20 IrisBench val requests, record latency and RAM.
