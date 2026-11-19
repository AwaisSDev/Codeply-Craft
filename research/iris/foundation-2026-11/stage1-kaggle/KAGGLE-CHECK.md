# Wave A on Kaggle T4: hardware checks, parity, runtime estimate (2026-11-19)

Validation work only. No full evaluation was run, nothing was trained, and the test split was not uploaded or
read: the source dataset `codeply-iris-wave-a-src` holds code plus the validation split, and every kernel asserts
that no test file is present. Kernels: `codeply-iris-wave-a-check` (version 5 succeeded), `codeply-iris-wave-a-parity`
(version 3 succeeded), `codeply-iris-llama-cuda-build` (CPU-only attempt, kept for the record). Outputs are copied
here (`check/`, `parity-gpu/`).

## 1. Hardware (measured, `check/hardware.json`)

| Item | Value |
|---|---|
| GPUs | **2 x Tesla T4**, 15,360 MiB each, compute capability 7.5 |
| Driver / CUDA | 580.178.04, CUDA 13.0 (nvcc 13.0.88) |
| CPU / RAM / disk | 4 vCPUs, 31 GB RAM, 20 GB working disk |
| Queue | 10-20 min in `QUEUED` before a T4 was assigned (three launches today); queue time uses no quota |

## 2. Build and compatibility

* llama.cpp **7a4117e** (the pinned commit), CUDA build for sm_75: llama-server and llama-bench. Kaggle-specific fixes,
  each committed: `CUDAToolkit_ROOT` and the driver library path (the image has no `libcuda` stub); the pinned UI asset
  archive shipped in the dataset (the Hugging Face "latest" UI no longer matches the commit; verified by tree hash);
  binaries copied out of the read-only input and versioned library names recreated (Kaggle's output store keeps
  regular files only). The CPU-only image has no CUDA toolkit, so the build must run in a GPU session.
* **Build time: 35 min, once.** The binaries and the five GGUFs (sha256-verified) are kept as the check kernel's output
  and reused by later kernels without rebuilding.
* **Every operation runs on the GPU.** Qwen3.5's gated DeltaNet has a CUDA kernel (the Ampere-only tensor-core variant
  is skipped on sm_75; the generic kernel runs), its conv channels (6,144) meet the CUDA kernel's multiple-of-128
  rule; the speeds and VRAM below confirm full offload. Gemma 4 keeps its per-layer embedding tables in host RAM by
  design (lookups), which is why it needs less VRAM than its file size.
* No model needs CPU offloading of layers.

## 3. VRAM and speed (measured on one T4, `-ngl 99 -c 8192`; `check/vram.json`, `check/bench-gpu.json`)

| Model | VRAM used (MiB) | of 15,360 | prompt tok/s (2,048) | generation tok/s | CPU generation tok/s (stage 0) |
|---|---|---|---|---|---|
| Qwen3-0.6B | 1,435 | 9 % | 9,786 | 268 | 49.7 |
| Qwen3-1.7B | 2,139 | 14 % | 4,658 | 139 | 17.2 |
| Qwen3.5-2B | 1,517 | 10 % | 4,318 | 120 | 14.5 |
| Gemma 4 E2B (QAT Q4_0) | 1,643 | 11 % | 8,846 | 105 | 18.9 |
| Qwen3-4B-Instruct-2507 | 3,743 | 24 % | 2,003 | 66.5 | 7.8 |

## 4. Parity (`parity_report.json`)

Same command as the committed CPU references (`parity-cpu/`): first two val episodes, open loop, constrained, prompt
v1.1, 15 examples per model. GPU pass A on T4 #0 and pass B on T4 #1, at the same time.

| Model | Prompt tokens identical CPU vs GPU | Answers identical CPU vs GPU | Ops identical CPU vs GPU | Metrics identical CPU vs GPU | **GPU 0 vs GPU 1** |
|---|---|---|---|---|---|
| Qwen3-0.6B | 15 / 15 | 4 / 15 | 9 / 15 | no | **15 / 15, metrics identical** |
| Qwen3-1.7B | 15 / 15 | 7 / 15 | 9 / 15 | no | **15 / 15, identical** |
| Qwen3.5-2B | 15 / 15 | 4 / 15 | 9 / 15 | no | **15 / 15, identical** |
| Gemma 4 E2B | 15 / 15 | 10 / 15 | 12 / 15 | no | **15 / 15, identical** |
| Qwen3-4B-2507 | 15 / 15 | 10 / 15 | 12 / 15 | yes | **15 / 15, identical** |

Reading:
* **Inputs are identical** (same prompt tokens everywhere): templates, prompt version, data and settings carried over.
* **The GPU is deterministic**: two T4s gave byte-identical outputs for every model. Wave A on T4 is reproducible.
* **CPU and GPU do not give the same outputs.** Divergence starts at near-tie tokens (the chosen token's probability
  is mostly 0.2-0.7) and the greedy continuation then differs; this is expected floating-point behaviour, not a bug.
  On these 2 episodes the metric moves noticeably for some models (Qwen3-1.7B F1 0.15 on CPU vs 0.05 on GPU, on 31
  gold facts). Consequences:
  1. Every wave-A system runs on the same hardware and build (T4, 7a4117e CUDA). Comparisons inside wave A are valid.
  2. CPU and GPU numbers are never mixed in one comparison. The committed r2 / r3 results (HF fp16) were already a
     different backend and stay reference-only.
  3. Hardware is a noise source that the episode bootstrap does not capture. Optional, free: run Qwen3-1.7B on the
     full val, open loop, on this container's CPU in parallel with wave A, and report the CPU-vs-GPU difference as a
     hardware noise floor next to the bootstrap intervals.
  4. Latency for deployment stays the CPU measurement (stage 0); GPU times are only for planning.
* **Output-length cap.** With the pre-registered 900-token cap, Qwen3.5-2B stopped at the cap in 3-4 of 10 sessions
  (it keeps adding ever smaller facts), Gemma in 1-2, the others in at most 1. A truncated answer stores nothing. The
  cap stays as registered (same for every model); the cap-hit rate is reported per system.

## 5. Runtime estimate for wave A on Kaggle

From the parity timings (both GPUs busy at once, 15 examples per model, including server start and GGUF hashing):
Qwen3-0.6B 29 s, Qwen3-1.7B 27 s, Qwen3.5-2B 79 s, Gemma 4 E2B 72 s, Qwen3-4B-2507 78 s. A "full" system is about
350 example-equivalents (open 184 + closed 120 + unconstrained screen ~46), a "v1" continuity run 184.

| GPU | Queue (`scripts/kaggle/wave_a_run/run.py`) | Estimate |
|---|---|---|
| T4 #0 | Qwen3-4B-2507, Gemma 4 E2B | ~50 min |
| T4 #1 | Qwen3.5-2B, Qwen3-1.7B, Qwen3-0.6B, Qwen3-1.7B v1, Qwen3-0.6B v1 | ~50 min |
| both | setup (copy binaries, verify 8.3 GB of GGUFs), reports | ~5 min |

**Session: about 1 hour; plan for up to 1.5 h** (long outputs and closed-loop variation). If Kaggle bills a 2 x T4
session at twice the rate (not verified here), that is up to 3 GPU-hours. Quota spent today on checks: about
0.8-1.0 GPU-hour (mostly the one-time build). **Wave A fits in the remaining ~11 hours before the 21 November reset.**

## 6. Backups (outside the temporary session)

| What | Where |
|---|---|
| Code and validation data | GitHub `Codeply-Craft@codeply-iris` (source of truth); Kaggle private dataset `codeply-iris-wave-a-src` (commit recorded in `COMMIT.txt`) |
| llama.cpp binaries, five GGUFs | output of kernel `codeply-iris-wave-a-check` (persisted by Kaggle with the kernel version); rebuildable from the pinned commit + UI archive, and the GGUFs re-downloadable from Hugging Face with pinned sha256 |
| Wave-A results, logs | written incrementally to `/kaggle/working/results` (kernel output), then downloaded and committed to GitHub under `results/foundation-2026-11/<system>/` with manifests and foundation reports |
| Interrupted session | every generation is cached (`preds-*.jsonl`); attaching the previous run's output resumes without regenerating |
| Credentials | never written to disk or the repository; passed to the Kaggle CLI through environment variables per command |
