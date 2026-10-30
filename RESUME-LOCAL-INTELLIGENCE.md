# Resume prompt: Codeply Local Intelligence

Paste everything below the line into a new Claude Code session on this repo.

---

You are continuing Codeply's Local Intelligence project on branch
`codeply-local-intelligence` of `awaissdev/codeply-craft` (never `main`, no
PR unless asked). Commit and push to this branch after each step (the
container is ephemeral), and do not claim anything works without running it.

## State (2026-10-30): the CPU work is finished

Everything the earlier resume prompt listed is done. Read, in order:

1. `LOCAL-INTELLIGENCE-REPORT.md`: what was built, tests, every measured
   number, limitations, the open decision, next steps.
2. `docs/local-intelligence/MODEL-SELECTION.md`: why LFM3-1.7B, the prompt
   v2 decision, licences.
3. `docs/local-intelligence/BENCHMARKS.md`, `RUNTIME.md`, `SETUP.md`.
4. `LOCAL-INTELLIGENCE-ARCHITECTURE.md`, `ml/*/README.md`.

Owner decisions so far:
* Architecture is chosen by measurement; dense is not a requirement.
* Open: the LFM Open License's US$10M revenue threshold (report §6).

Rule from the owner: extend `codeply-cli/lib/brain.js`, never build a second
memory system.

## What is left (needs things this container does not have)

1. **GPU fine-tune** of LFM3-1.7B (`ml/finetune/config-lfm3.yaml`) and
   Qwen3-1.7B (`config.yaml`), then `test` (800) and `gold`, and the gate.
   Raise the gate's F1 bar above off-the-shelf LFM3 first (0.80 / 0.70).
2. **Teacher-model paraphrasing** of the training data (needs an API key).
3. **Settings UI** in the desktop app (IPC exists: `context:state`, `context:set`).
4. Codeply Runtime phase 2 and per-platform release builds (RUNTIME.md).

## Rebuild the environment (about 15 minutes)

```bash
cd ~ && git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && git checkout aa588a3463357ee990b314f41dda242869130704
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF
nice cmake --build build -j4 --target llama-server llama-bench llama-quantize llama-imatrix
mkdir -p ~/.codeply/runtime/bin && ln -sf ~/llama.cpp/build/bin/llama-server ~/.codeply/runtime/bin/llama-server
cd /home/user/Codeply-Craft/codeply-cli && npm ci && cd ..
# Node's fetch ignores HTTPS_PROXY in the cloud container: set these for the downloads.
export NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
for m in lfm3-1.7b-qad-q4 qwen2.5-1.5b-q4 qwen3-1.7b-q4 nomic-embed-v1.5; do node scripts/context/fetch-model.mjs $m; done
npm run test:context
```

## Rules that stay

* No PR, no push to `main`, attribution trailer on commits as before.
* Never run two model jobs at once on the 4 cores (it inflated latency once).
* Sensitive events never go to a non-local backend; no silent cloud
  fallback; model output always goes through `checkExtraction`.
* Do not attempt 1B training on CPU. The fine-tune scripts are for a
  rented GPU (`ml/finetune/README.md`).
* A prompt change bumps `PROMPT_VERSION`; results get `-p<N>` and the old
  numbers stay.
