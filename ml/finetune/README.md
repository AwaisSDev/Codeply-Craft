# Fine-tuning Codeply's context model (on a rented GPU)

Nothing here trains in the development container (4 CPU cores, no GPU). The
pipeline was checked end to end there with `--smoke` (a 135M model, 2 steps
on CPU); the real run needs a GPU.

## 1. Data

```bash
node ml/data/generate.mjs && node ml/data/export-sft.mjs   # ml/data/out/sft-train.jsonl, sft-val.jsonl
```

8,000 training examples of about 680 tokens each (prompt + answer, compact
prompt), so about 5.4M tokens per epoch, of which only the answers (about
10 %) carry loss.

## 2. Machine

One 24 GB GPU is enough for LoRA on a 1–2B model in bf16 (an RTX 4090,
L4, A10G or L40S). Rough time: 2 epochs of 5.4M tokens on an RTX 4090 /
L40S class GPU is well under an hour. Budget a few dollars per run on
on-demand cloud GPUs. Estimate from throughput, not measured here.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r ml/finetune/requirements.txt
huggingface-cli login            # only if the base model is gated (Llama, Gemma); Qwen3 is not
```

## 3. Train

```bash
python ml/finetune/train_lora.py --config ml/finetune/config.yaml
```

* Base: `Qwen/Qwen3-1.7B` (Apache-2.0, dense, GQA, 32K native context); see
  `docs/local-intelligence/MODEL-SELECTION.md` for why, and for the 1B
  alternatives (`meta-llama/Llama-3.2-1B-Instruct`, `Qwen/Qwen3-0.6B`).
  Change `base_model` and, for non-Qwen models, `chat_template_kwargs: {}`.
* LoRA r=32 on all attention and MLP projections, lr 2e-4, cosine, 2 epochs,
  effective batch 16. Loss only on the assistant JSON.
* `chat_template_kwargs.enable_thinking: false` must match what the runtime
  sends (`CATALOG[...].extra` in `local-runtime.js`), or the trained model
  sees a different prompt than the one it runs with.
* Watch `val_loss` in `runs/.../train-log.jsonl`; stop early if it rises.

## 4. Export to GGUF, INT4 and INT8

```bash
LLAMA_CPP=~/llama.cpp ml/finetune/export_gguf.sh ml/finetune/runs/codeply-context-v1/merged codeply-context-v1
```

Produces `f16`, `Q4_K_M` (INT4, with an importance matrix computed on the
runtime prompts of the validation set) and `Q8_0` (INT8).

## 5. Evaluate and gate

Back on any machine with the runtime (a CPU is fine):

```bash
node scripts/context/fetch-model.mjs codeply-context-v1 --from runs/.../gguf/codeply-context-v1-Q4_K_M.gguf
node ml/eval/run.mjs --provider local:codeply-context-v1 --set test --style compact
node ml/eval/run.mjs --provider local:codeply-context-v1 --set gold --style compact
node ml/finetune/gate.mjs ml/results/local_codeply-context-v1-test-compact.json ml/results/local_codeply-context-v1-gold-compact.json
```

The gate (`gate.mjs`) is the release bar: validity ≥ 99 %, F1 ≥ 0.80 (≥ 0.75
on unseen phrasing), certainty ≥ 85 %, false memories ≤ 10 %, noise
rejection ≥ 90 %, memory actions ≥ 85 %, zero leaked secrets, zero followed
injections, p95 ≤ 30 s per batch on 4 cores. Compare with the off-the-shelf
baseline in `ml/results/RESULTS.md`; a fine-tuned model that does not beat
it clearly is not worth shipping.

Models whose id starts with `codeply-` get the compact prompt automatically
(`context-desktop.js`), the one they were trained on.

## 6. Ship

Upload the `Q4_K_M` GGUF to Codeply's storage, add it to `CATALOG` in
`local-runtime.js` with its SHA-256, licence (inherits the base model's) and
`extra` request settings, and point `fetch-model.mjs` at Codeply's URL.

## Training our own 1B from scratch?

Not recommended. A dense 1B pre-training run needs on the order of 1–2
trillion tokens to be competitive (hundreds to thousands of GPU-days), and
the result would be a weaker general model than the open ones we can
fine-tune for a few dollars. The specialisation is in the data and the
fine-tune, not the pre-training. Revisit only if no open model with an
acceptable licence fits the size and quality bar.
