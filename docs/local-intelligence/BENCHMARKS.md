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

<!-- cache-section -->
