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
