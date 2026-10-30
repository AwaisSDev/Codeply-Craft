# Codeply Runtime: from llama.cpp to our own inference engine

Status: phase 1 is built and tested (`codeply-cli/lib/local-runtime.js`).
Measured numbers are in `docs/local-intelligence/BENCHMARKS.md`.

## Phase 1 (now): upstream llama.cpp as a managed child process

| Piece | Choice | Why |
|---|---|---|
| Engine | `llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT), built at commit `aa588a3` (2026-10-30) | Mature CPU kernels (AVX2, AVX-512, VNNI, NEON), GGUF, INT4/INT8 quantization, KV cache, optional CUDA/Metal/Vulkan in the same code |
| Integration | Child process on `127.0.0.1`, OpenAI-compatible HTTP | Crash isolation, no native Node module to rebuild for Electron's ABI, and the same API as Ollama / LM Studio, so the "local" backend works with all three |
| Security | Random port, random API key in a `0600` file (`--api-key-file`), never on the command line; loopback only; `--offline` (no downloads from inside the server) | Other local processes cannot use the model; nothing reaches the network |
| Scheduling | `--prio -1` plus `os.setPriority(pid, 10)`; threads = physical cores − 1 (≥ 4 cores), max 8; loaded on first use, stopped after 5 idle minutes | Background work must not slow the user down |
| Memory | `-c 4096`, KV cache `q8_0` (`-ctk q8_0 -ctv q8_0`), one slot (`-np 1`) | The KV cache was most of the RAM at the default context (see BENCHMARKS.md) |
| Output | JSON Schema in `response_format` → llama.cpp turns it into a grammar, so every token sampled is valid JSON for the extraction contract | A 1B model's free-form JSON is the main failure mode; constrained decoding removes it |
| Prompt cache | The system prompt is fixed and first, `cache_prompt: true` | The second call only processes the new events (measured: 869 of 870 tokens reused, 12.7 s → 0.6 s) |

### Building it

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
git checkout aa588a3463357ee990b314f41dda242869130704
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF
cmake --build build -j --target llama-server llama-bench llama-quantize llama-imatrix
mkdir -p ~/.codeply/runtime/bin && cp build/bin/llama-server ~/.codeply/runtime/bin/
```

`GGML_NATIVE=ON` tunes for the build machine, and the default build links llama.cpp as shared libraries next to the binary (`libllama.so`, `libggml*.so`); for shipping, add `-DBUILD_SHARED_LIBS=OFF` to get one self-contained `llama-server`. Release builds for users must
instead use `-DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON`,
which ships one CPU backend per instruction-set level (SSE4.2, AVX2,
AVX-512, ...) and picks the best at run time. Windows needs the MSVC or
clang build; macOS uses Metal by default (`-DGGML_METAL=ON`).

Then a model: `node scripts/context/fetch-model.mjs qwen3-1.7b-q4`.

### Optional CUDA

`-DGGML_CUDA=ON` in the same build; at run time add `-ngl 99` to the server
arguments (`createRuntime({ args: ['-ngl', '99'] })`). CPU stays the default
because most Codeply users have no supported GPU, and a 1B model at INT4 is
fast enough on CPU for background work.

## Phase 2: the Codeply Runtime fork

Fork llama.cpp (MIT: keep the licence and notices) as
`codeply-runtime`, keep upstream as a remote, and rebase monthly. What we
change, in order of value:

1. **A dedicated extraction endpoint.** `POST /extract` takes events and
   known memories, renders the trained prompt inside the runtime, applies
   the extraction grammar, and returns the JSON. The prompt and grammar ship
   with the model (GGUF metadata keys `codeply.prompt_version`,
   `codeply.schema`), so app and model can never disagree about them.
2. **Persistent prefix cache.** The system prompt's KV state saved to disk
   per model (`--slot-save-path` exists upstream; we make it automatic), so
   even the first call after a start skips the fixed prompt.
3. **Batch scheduler.** Several queued batches packed into one forward pass
   (llama.cpp's continuous batching with `-np 2..4`, tuned for CPU), and
   cancellation when the user becomes active (pause between tokens).
4. **Grammar-aware speculative decoding.** Much of the JSON (keys, enums) is
   forced by the grammar; skipping the model for forced tokens cuts
   generation time, which dominates on CPU (prompt processing is ~8× faster
   per token than generation here).
5. **Embeddings in the same process** for the memory index (one model file
   for extraction, a small one for embeddings, one runtime).
6. **Footprint:** strip the web UI, server tools and multimodal code from the
   build; the binary only needs text generation, embeddings and the grammar.

Not worth doing: rewriting tensor kernels, our own quantization formats, or a
new model file format. GGUF, `Q4_K_M` and `Q8_0` are the industry standard,
and llama.cpp's kernels are already tuned for every CPU we target.

## Phase 3: packaging

* Ship per-platform runtime builds (Windows x64, macOS arm64/x64, Linux x64)
  as a separate download the app fetches on first use, verified by SHA-256
  (like the model, `scripts/context/fetch-model.mjs`). The installer stays
  small.
* Models download from Codeply's own storage (a mirror of the evaluated
  GGUF), verified by hash, never from a URL a model or a user message names.

## What the 1B specialist model needs from the runtime

* Dense transformer with GQA (Qwen3 / Llama-style): supported as-is.
* 32K context: supported (`-c 32768`), but extraction batches are 1–3K
  tokens. Use 4K by default and only raise it for a consolidation job that
  really reads a long document. KV cache at 32K for Qwen3-1.7B (28 layers,
  8 KV heads of 128) is about 3.7 GB in f16 and about 2 GB in q8_0: too much
  to keep resident in the background.
* 128K context: needs RoPE scaling (YaRN) in the model config and
  `--rope-scaling yarn` at run time; llama.cpp supports it. Long-context
  quality must be evaluated separately; the hybrid architectures
  (Qwen3.5, LFM2.5) handle long context far more cheaply than a dense
  transformer, which is why MODEL-SELECTION.md tracks them.
