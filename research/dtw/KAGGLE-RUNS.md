# Kaggle runs: failures, causes, fixes

## 2026-10-31, first runs of the realistic-data model selection

Both kernels ended in `ERROR` on a Tesla T4 (15 GB). Logs fetched with
`KaggleApi().kernels_logs(...)`: one request per kernel. (`kaggle kernels
output` pages through every output file, 20 per request, before it writes the
log; with the cloned repository in `/kaggle/working` that is hundreds of
requests, which is why earlier log downloads were slow and then rate-limited.)

| Kernel | Failed at | Cause | Model or data at fault? |
|---|---|---|---|
| `codeply-real-encoders` | first training step of Ettin-150M seed 1 | `torch.OutOfMemoryError: CUDA out of memory` (14.5 GB in use): batch 32 of realistic inputs up to 1,462 tokens, no gradient checkpointing, no FlashAttention on T4 | No |
| `codeply-real-lfm3-lora` | `get_peft_model` | `ImportError: Found an incompatible version of torchao. Found version 0.10.0, but only versions above 0.16.0 are supported` (PEFT probes torchao while dispatching LoRA layers) | No |

The same training command on the same frozen split runs on CPU (32-example
dry run), so data loading and the split are fine.

## Fixes (configuration preserved)

* **Encoders:** `--bs 8 --accum 4` (effective batch 32, as pre-registered),
  `--grad-ckpt`, `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`.
  `train_encoder.py` gained `--accum` and `--grad-ckpt`; the log now records
  peak GPU memory.
* **LFM3 LoRA:** `pip uninstall -y torchao` before training (LoRA does not use
  it); micro-batch 4 with gradient accumulation 4 (effective batch 16, as in
  `ml/finetune/config-lfm3.yaml`).

These are operational changes (memory and dependencies). Learning rate,
epochs, effective batch, seeds, data and evaluation are unchanged, so they
are not protocol deviations in the sense of `MODEL-SELECTION-PROTOCOL.md` §6;
they are recorded here so the runs can be compared.

## 2026-10-31, run 2 (version 2 of both kernels)

| Kernel | Got to | Failed at | Cause | Fix |
|---|---|---|---|---|
| `codeply-real-encoders` | Ettin-150M s1 epoch 1 trained (peak GPU 7.2 GB, memory fix works); validation after epoch 1: kind 0.67, certainty 0.85, span F1 0.04 | `fit_temperature` after the first validation | bug in `train_encoder.py`: logits on the GPU, labels on the CPU (`RuntimeError: Expected all tensors to be on the same device`). CPU-only tests could not catch it | both moved to the CPU before the temperature search |
| `codeply-real-lfm3-lora` | model loaded, LoRA attached (torchao fix works) | first backward pass | `CUDA out of memory` allocating 2.94 GB: the 128K-vocabulary logits for micro-batch 4 × ~2K tokens | micro-batch 1 × accumulation 16 (effective 16, unchanged) + `expandable_segments` |

Both kernels relaunched as version 3.

## 2026-10-31, run 3 (version 3)

| Kernel | Result |
|---|---|
| `codeply-real-encoders` | **Ettin-150M seeds 1-3 trained and exported** (peak GPU 7.2 GB, ~21 min each). Validation (realistic val split, best epoch): kind 0.764 / 0.736 / 0.747, certainty 0.853 / 0.870 / 0.863, gate 0.885 / 0.868 / 0.868, exact-span F1 0.051 / 0.060 / 0.072. Merge accuracy reads 0.0 because the validation split has no merge examples after the cross-split fix (0 of 0), not because merges fail. **Ettin-400M seed 1: CUDA out of memory at micro-batch 8.** The notebook's final zip cell never ran |
| `codeply-real-lfm3-lora` | still running at the time of writing |

**Low exact-span F1 needs checking** before anyone reads it as a model
failure: it is exact token-boundary agreement with Claude's evidence spans,
which are often whole clauses; the harness F1 (value words) is the metric
that counts. Evaluate the checkpoints in the harness first.

Fixes for the next runs: clone the repository and llama.cpp under `/tmp`, so
the kernel output holds only artifacts (the output listing of run 3 starts
with thousands of repository files, which is what made every log and output
download slow and rate-limited); copy each run's heads, config, log and GGUFs
to `/kaggle/working/runs/<run>` as soon as it finishes; Ettin-400M at
micro-batch 2 × accumulation 16 (effective 32).

## 2026-10-31, run 4 (encoders version 4: Ettin-400M seed 1 only)

`ONLY_RUNS=real-ettin400-s1`, micro-batch 2 × accumulation 16 (effective 32,
as pre-registered), gradient checkpointing. **Completed** at 19:25 UTC:
peak GPU 8.8 GB, 3 epochs in 61 min. Validation (realistic val split) by
epoch:

| Epoch | Kind | Certainty | Gate | Importance MAE | Exact-span F1 |
|---|---|---|---|---|---|
| 1 | 0.668 | 0.846 | 0.878 | 0.123 | 0.068 |
| 2 | 0.812 | 0.890 | 0.878 | 0.096 | 0.084 |
| 3 (exported) | 0.808 | 0.877 | 0.885 | 0.096 | 0.095 |

The Ettin-150M seeds reached kind 0.74-0.76 and certainty 0.85-0.87 on the
same split. With the repository cloned under `/tmp`, the output listing was
one page and the artifacts downloaded in one pass (no rate limiting). Saved
to `dtw-artifacts/real-ettin400-s1`; harness evaluation via
`research/dtw/run-protocol-evals.sh` step 4. Single seed: the protocol's
seed requirement for a selection claim is not met by this run alone.

## 2026-11-01, LFM3 LoRA run 3 (version 3): stopped by the 12-hour limit

Started 16:36 UTC, `CANCEL_ACKNOWLEDGED` at the 12 h limit. Seed 1 reached
optimizer step 330 of 512 (epoch 2 of 2) after 42,755 s: **~124 s per step
of 16 examples × ~1,450 tokens**. Nothing was saved: the script wrote the
adapter and the merged model only at the end. Training loss was falling
normally (0.0-0.27 at steps 270-330). Three faults, none in the data or the
configuration:

| Fault | Evidence | Fix |
|---|---|---|
| **Emulated bf16 on the T4** (the main cause of the speed) | `train_lora.py` chose bf16 when `torch.cuda.is_bf16_supported()` is true; that function also returns true when bf16 is only emulated (`including_emulation=True` by default; the T4 is compute capability 7.5). Observed ~124 s per step against an estimated 15-30 s with fp16 tensor cores | bf16 only on capability ≥ 8; otherwise fp16 base weights, fp32 adapter weights and optimizer state, fp16 autocast with loss scaling (`GradScaler`) |
| **Validation loss NaN** (`{"step": 200, "val_loss": NaN}`) | train dropped examples whose answer lies beyond `max_seq_len` 2048 (4,096 → 4,072); val did not, and one example with no supervised token makes the mean NaN | the same filter on val, with the dropped counts printed. Training was not affected |
| **The export would have failed** after training | `export_gguf.sh` calibrates the INT4 importance matrix on `ml/data/out/sft-val.jsonl`, which the notebook never wrote (it exports SFT to `/tmp`) | the notebook copies the realistic val prompts there |

Operational changes in the notebook: the kernel has **two T4s** and run 3
used one, so seeds 1 and 2 now train at the same time, one GPU each; the
run directory is under `/kaggle/working/lora` and the script saves the
adapter after every epoch, so a time limit keeps progress; f16 GGUFs go to
`/tmp`, only Q4_K_M and Q8_0 are kept, and the merged weights are deleted
after export (the adapter stays).

Effective batch (16), learning rate, epochs, LoRA rank and targets,
`max_seq_len`, prompt style, seeds, data and evaluation are unchanged. The
precision change (emulated bf16 → fp16 with loss scaling) is a numerical
change, not a configuration change; it is recorded here so that the result
can be compared. The same `train_lora.py` fixes apply to the production
fine-tuning path and should be ported there.

CPU smoke test of the patched script (SmolLM2-135M, realistic SFT data, 2
steps): train/val counts printed, finite val loss, epoch checkpoint
written, merge and save succeed.

## 2026-11-01, run 5 (encoders version 5: Ettin-400M seeds 2 and 3)

Owner decision: three seeds before judging the 400M lead. Same settings
as seed 1 (micro-batch 2 × 16, gradient checkpointing). **Completed**
09:04 UTC; both seeds peak GPU 8.8 GB, ~63 min each. Validation (exported
epoch 3): seed 2 kind 0.819, certainty 0.860, gate 0.898; seed 3 kind
0.825, certainty 0.870, gate 0.885 (seed 1: 0.808 / 0.877 / 0.885).
Artifacts fetched in one listing page.

## 2026-11-01, LFM3 LoRA run 4 (version 4): trained, export cut by the 12-hour limit

**The fp16 fix worked**: ~28 s per optimizer step (run 3: ~124 s), both
seeds in parallel on the two T4s, 508 steps each in ~4 h (seed 1 14,491 s,
seed 2 14,236 s). Final val loss 0.1125 (seed 1) and 0.1129 (seed 2), no
NaN (the val filter works). Merged models saved for both seeds.

The export then ran out of time: llama.cpp in the notebook is built
without CUDA, so the importance-matrix calibration (200 chunks × 2,048
tokens of val prompts) ran on the CPU: 2 h 53 min for seed 1. Seed 1 had
reached its Q4_K_M quantization when Kaggle stopped the kernel at 12 h
(`CANCEL_ACKNOWLEDGED`); no GGUF reached the output.

Fix: `real-lfm3-export.ipynb` (kernel `codeply-real-lfm3-export`), export
only, reading the merged models from this run's output; llama.cpp built
with CUDA (sm_75) and `IMATRIX_ARGS='-ngl 99'` (new optional hook in
`export_gguf.sh`, empty by default), so the calibration runs on the GPU.
Same calibration text (realistic val prompts), same 200 chunks, same
Q4_K_M and Q8_0 outputs. Training is not repeated.

Export v1 (kernel source) was rejected: Kaggle does not accept a cancelled
run as a kernel source. The final adapters (129 MB each) were downloaded
and uploaded as the private dataset `codeply-real-lfm3-lora-adapters`; the
notebook merges them as `train_lora.py` does. Export v2 then failed while
building llama.cpp with CUDA (`ggml-cuda` links `CUDA::cuda_driver`, not
found in Kaggle's image). v3: `GGML_CUDA_NO_VMM=ON` (that link exists only
for CUDA virtual memory management) plus the driver stub path, with a
fallback to the CPU build (~3 h per seed, within the 12 h limit).

Export v3: the CUDA build worked (`-ngl 99`), then the adapter merge
failed importing peft/transformers in the notebook's own process
(`ImportError: cannot import name '_slice' from 'numpy._core.umath'`: the
pip installs earlier in the notebook had replaced numpy under the running
process). v4 runs the merge in a fresh Python process, after checking the
imports there (and reinstalling numpy cleanly if they fail).

Export v4: failed with `NameError: adapters` — my edit for v4 removed the
lines that find and unpack the adapters (a bug in the notebook, not in
Kaggle or the data). v5 restores them; the adapter discovery was
dry-run locally against a simulated Kaggle input (tar archive) before the
push.

The v5 push was refused: **weekly GPU quota of 30 hours reached** (runs
1-5, LoRA runs 1-4, export v1-v4). v5 therefore runs as a **CPU session**
(no GPU quota; 12 h limit): the notebook detects that there is no GPU and
builds llama.cpp for the CPU, so the importance matrix takes ~3 h per seed
as in LoRA run 4 (same 200 chunks, same calibration text); expected ~6.5 h
in total.

Export v5 (CPU session): no GPU detected, CPU build, both adapters found
(Kaggle had unpacked the dataset); the merge then failed on the same
torchao/PEFT incompatibility as LoRA run 1 (`torchao 0.10`, PEFT needs >
0.16), which the export notebook did not yet handle. v6 uninstalls torchao
before the merge, as the LoRA notebook does.

Export v6: torchao fixed; loading the base model then failed
(`layer_types entries must be one of ('full_attention',
'sliding_attention', 'conv'); got ['linear_attention', …]`): the export
notebook had the newest transformers, not the versions the training run
used (`ml/finetune/requirements.txt`: transformers 5.22.1, peft 0.21.2).
Checked locally: transformers 5.22.1 loads LFM3's own config code
(layer types conv / full_attention / sliding_attention). v7 installs that
requirements file before the merge and pins LFM3 to revision `ac2586a3`
(2026-10-28, the revision current when run 4 trained).
