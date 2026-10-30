# Local runtime benchmarks (CPU)

Measured 2026-10-30 on the development container: Intel Xeon @ 2.80 GHz,
4 cores (no SMT), AVX-512 + VNNI, 16 GB RAM, no GPU. llama.cpp `aa588a3`,
built with `GGML_NATIVE=ON`. Nothing else ran on the CPU during a
measurement. Raw numbers: `ml/results/bench.json` (`node ml/bench/bench.mjs`)
and the `performance` block of each `ml/results/local_*.json`.

A user's laptop will differ: a recent 8-core laptop has more memory
bandwidth per core and should be faster at generation; an older 4-core
laptop without AVX-512 will be slower. These numbers rank the models and
show where the time goes; they are not a promise of user-facing latency.

## Raw speed (llama-bench)

`pp768` = reading 768 prompt tokens (about one batch of events after the
cached system prompt); `tg160` = writing 160 tokens (about one answer).
KV cache `q8_0`, flash attention on, 3 repetitions. Server RSS is a running
`llama-server` at the app's settings (ctx 4096, q8_0 KV) after one request.

| Model | File MB | Threads | Prompt tok/s | Generate tok/s | Server RSS MB | Start ms |
|---|---|---|---|---|---|---|
| lfm3-1.7b-q4 | 1041 | 2 | 52.5 | 9.6 | 1833 | 1822 |
| | | 3 | 67.1 | 13.7 | | |
| | | 4 | 102.4 | 17.8 | | |
| lfm3-1.7b-qad-q4 | 993 | 2 | 51.7 | 10.4 | 1889 | 1780 |
| | | 3 | 73.2 | 13.9 | | |
| | | 4 | 97.3 | 16.4 | | |
| lfm2.5-1.2b-q4 | 695 | 2 | 76.0 | 15.3 | 1242 | 1014 |
| | | 3 | 103.4 | 20.4 | | |
| | | 4 | 131.0 | 24.9 | | |
| qwen2.5-1.5b-q4 | 1060 | 2 | 51.2 | 11.5 | 1797 | 1773 |
| | | 3 | 74.7 | 15.5 | | |
| | | 4 | 90.2 | 18.7 | | |
| qwen3-1.7b-q4 | 1050 | 2 | 42.4 | 10.1 | 2006 | 2033 |
| | | 3 | 62.9 | 12.7 | | |
| | | 4 | 72.4 | 16.5 | | |
| gemma3-1b-q4 | 762 | 2 | 69.8 | 12.6 | 938 | 1270 |
| | | 3 | 88.5 | 18.2 | | |
| | | 4 | 106.9 | 20.2 | | |

* Every model runs in under 2.1 GB resident, so any of them fits next to
  the app on an 8 GB laptop. LFM2.5 and Gemma-3 are the lightest.
* Going from 2 to 4 threads roughly doubles prompt speed and adds 60–80 %
  to generation. The runtime's default (physical cores − 1, so 3 on this
  machine) keeps one core for the user at about 75 % of full speed.
* Start-up (load the GGUF, first `/health`) is 1–2 s: unloading the model
  after 5 idle minutes costs almost nothing.

## Where the time per batch goes

Per-example latency in the evaluation (`ms p50`, 4 threads, one batch of
events per example) is close to

```
uncached prompt tokens / prompt speed  +  answer tokens / generation speed
```

| Model | Prompt tokens | Reused from cache | Answer tokens | Predicted s | Measured p50 s |
|---|---|---|---|---|---|
| lfm3-1.7b-qad-q4 | 846 | 374 (44 %) | 153 | 4.9 + 9.3 = 14.2 | 15.3 |
| lfm2.5-1.2b-q4 | 883 | 412 (47 %) | 101 | 3.6 + 4.1 = 7.7 | 7.4 |
| qwen2.5-1.5b-q4 | 836 | 732 (87 %) | 90 | 1.2 + 4.8 = 6.0 | 6.6 |
| gemma3-1b-q4 | 860 | 750 (87 %) | 145 | 1.0 + 7.2 = 8.2 | 7.7 |

Two findings:

1. **Generation dominates.** Writing the answer is 60–80 % of the time on
   every model. LFM3 is the slowest per batch mostly because it writes more
   (153 tokens against 90 for Qwen2.5) at a lower generation speed. Shorter
   answers are the biggest lever: a fine-tuned model trained on compact
   answers, and grammar-aware skipping of forced JSON tokens (RUNTIME.md,
   phase 2).
2. **The hybrid LFM models reuse less of the cached system prompt** (about
   45 % against 87 %), so they re-read about 350 fixed tokens on every call.
   See the next section.

## Prompt cache on the hybrid models (fixed)

The system prompt (about 740 tokens) is the same on every call, so
`llama-server` should read it once and reuse its cached state
(`cache_prompt`). On the dense models it does. On the LFM models it reused
only the first ~330–370 tokens, because their non-attention state cannot be
rewound to an arbitrary point, only to a saved checkpoint:

| Model | Server flags | Reused per call | Prompt time per call |
|---|---|---|---|
| lfm3-1.7b-qad-q4 | default | ~330 of ~845 | 5.5 s |
| lfm3-1.7b-qad-q4 | `--swa-full` | **744** | **1.2 s** |
| lfm3-1.7b-qad-q4 | `-ub 128` | 0 | 8.8 s |
| lfm2.5-1.2b-q4 | default | ~370 of ~885 | 4.0 s |
| lfm2.5-1.2b-q4 | `--swa-full` | ~370 | 3.8 s |
| lfm2.5-1.2b-q4 | `-ub 128` | **751** | **1.3 s** |
| lfm2.5-1.2b-q4 | `-ub 64` | 0 | 7.6 s |

(5 consecutive real test-mini prompts at 4 threads; mean of calls 2–5.)

* **LFM3** has sliding-window attention layers (window 256). By default
  their cache only keeps the last window, so a prefix older than that cannot
  be reused. `--swa-full` keeps the whole window cache: +18 MB resident.
* **LFM2.5** has only short-convolution and full-attention layers. Its
  convolution state is checkpointed one micro-batch before the end of the
  prompt, so with the default 512-token micro-batch the checkpoint lands at
  ~370. With 128 it lands after the system prompt. The first (uncached) call
  is not slower.

Both are set per model in `CATALOG[...].serverArgs` (`local-runtime.js`),
so the app and the evaluation use them. End to end on test-mini,
lfm3-1.7b-qad-q4 went from p50 15.3 s / p95 22.5 s / 60 CPU s per example
to **p50 10.9 s / p95 18.0 s / 42 CPU s per example**, with the same answers
(F1 0.82 → 0.83, within run-to-run noise). The other results in
`RESULTS.md` (LFM3 Q4_K_M, LFM2.5) were measured before the fix; their
latency is pessimistic by about the same share.

## What this means for the product

* At 3 threads on a 4-core laptop, a batch of events takes 10–20 s for the
  best model (LFM3), using one core-minute or less. The engine's duty cycle
  (wait 3× a batch's time before the next) keeps the background load at 25 %
  of the cores it uses. That is acceptable for background memory, not for
  anything the user waits on.
* The 30 s p95 bar in the release gate (`ml/finetune/gate.mjs`) is met by
  every candidate after the cache fix.
* The next gains, in order: shorter answers (fine-tune on compact output),
  grammar-aware skipping of forced tokens, and a persistent prefix cache so
  even the first call after a start skips the system prompt (RUNTIME.md,
  phase 2).
