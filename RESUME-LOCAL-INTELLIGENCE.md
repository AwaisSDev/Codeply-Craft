# Resume prompt: Codeply Local Intelligence

Paste everything below the line into a new Claude Code session on this repo.

---

You are continuing Codeply's Local Intelligence project on branch
`codeply-local-intelligence` of `awaissdev/codeply-craft` (never `main`, no
PR unless asked). Work autonomously, commit and push to this branch after
each step (the container is ephemeral), and do not claim anything works
without running it.

## Read first (in this order)

1. `LOCAL-INTELLIGENCE-ARCHITECTURE.md`: design, contracts, routing, privacy rules, integration points.
2. `docs/local-intelligence/RUNTIME.md` and `docs/local-intelligence/SETUP.md`.
3. `ml/data/README.md`, `ml/eval/README.md`, `ml/finetune/README.md`.
4. `ml/results/RESULTS.md`: every evaluation so far.

Rule from the owner: extend `codeply-cli/lib/brain.js`, never build a second
memory system. The brain stores, merges, resolves and retrieves; the new
layer only feeds it (`brain.observe`) and scores for it (`brain.setRetriever`).

## What is done (all committed and tested)

* Context layer in `codeply-cli/lib/`: `context-schema.js` (event + extraction
  contract, the guard), `context-redact.js`, `context-prompt.js`,
  `context-model.js` (rules / cloud / local backends, `routeFor`),
  `context-events.js` (durable queue), `context-engine.js`,
  `context-collectors.js` (chats, Life), `context-retrieval.js` (embeddings),
  `local-runtime.js` (managed llama-server). Desktop host: `context-desktop.js`
  (wired in `main.js`). Small hooks in `brain.js`, `bots.js`, `agent.mjs`,
  `dsh-chat.js` (DSH turns now read the brain).
* Default mode is `legacy`: nothing changes for users until a mode is picked.
* Data: `ml/data/generate.mjs` (seed 7: train 8000 / val 800 / test 800 /
  test-mini 92, committed in `ml/data/out/`), `export-sft.mjs`, gold set
  `ml/eval/gold.mjs` (39 hand-written).
* Eval: `ml/eval/run.mjs` (has `--rescore`), `retrieval.mjs`, `report.mjs`.
* Fine-tune: `ml/finetune/train_lora.py` + `config.yaml` (smoke-tested on
  CPU), `export_gguf.sh` (GGUF → imatrix → Q4_K_M / Q8_0, tested end to end),
  `gate.mjs` (release bar).
* Tests: `npm run test:context` (130 checks, all pass). `npm run test:brain`
  passes. Known pre-existing failures, identical on `main`: engine-test 1
  (`findstr`, Windows only), life-test 2 (date dependent).

## Results so far (test-mini, 92 examples, 4-core Xeon, no GPU, off-the-shelf models)

| Model | F1 | Notes |
|---|---|---|
| lfm2.5-1.2b-q4 | 0.73 | certainty 93 %, but 83 % false memories, memory actions 38 % |
| qwen2.5-1.5b-q4 | 0.71 | fastest useful (p50 6.6 s), kind accuracy 42 % |
| qwen3-1.7b-q4 | 0.64 | best noise rejection (100 %), memory actions 66 %; latency inflated by contention |
| gemma3-1b-q4 | 0.61 | smallest RAM (1.06 GB) |
| llama3.2-1b-q4 | 0.54 | |
| qwen3.5-0.8b-q4 | 0.47 | over-extracts |
| qwen3-0.6b-q4 | 0.00 | always returns empty lists under the JSON Schema |
| rules (no model) | 0.45 on test, 0.17 on gold | precision 0.97 |

Every model: 0 secrets leaked, 0 of 4 injections followed (after the guard
fix in commit c6c2dbf2). All models fail on plans (put meetings in
observations or get dates wrong) and on temporal `until` times. That is what
fine-tuning is for. Retrieval: block recall 0.83 words only, 0.93 with
nomic-embed.

## The environment is gone: rebuild it first (about 15 minutes)

```bash
cd ~ && git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && git checkout aa588a3463357ee990b314f41dda242869130704
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF
nice cmake --build build -j4 --target llama-server llama-bench llama-quantize llama-imatrix
mkdir -p ~/.codeply/runtime/bin && ln -sf ~/llama.cpp/build/bin/llama-server ~/.codeply/runtime/bin/llama-server
cd /home/user/Codeply-Craft/codeply-cli && npm ci && cd ..
# models (fetch-model downloads from Hugging Face and records the hash)
for m in lfm3-1.7b-q4 lfm3-1.7b-qad-q4 lfm2.5-1.2b-q4 qwen2.5-1.5b-q4 qwen3-1.7b-q4 nomic-embed-v1.5; do node scripts/context/fetch-model.mjs $m; done
npm run test:context
```

Note: the llama.cpp build at that commit supports LFM3 (`src/models/lfm3.cpp`).

## What is left, in order

1. **Evaluate LFM3-1.7B** (released 2026-10-23, `LiquidAI/LFM3-1.7B-GGUF`,
   LFM Open License v1.0, tri-hybrid: 13 conv + 5 sliding + 6 global
   attention layers, 256K context). Both entries are in `CATALOG`; the run was
   stopped by the owner before it finished:
   `node ml/eval/run.mjs --provider local:lfm3-1.7b-q4 --set test-mini --threads 4`
   then the same for `lfm3-1.7b-qad-q4` (quantization-aware Q4_0). Run one at
   a time and nothing else on the CPU, or latency is wrong. Commit each result.
2. **Qwen3-0.6B without the schema**: is the empty output the grammar or the
   model? Add a `--no-schema` path for `local:` providers in `run.mjs` (the
   `openai` provider already has it) and compare.
3. **CPU benchmarks on an idle machine**: `node ml/bench/bench.mjs --models
   lfm3-1.7b-q4,lfm2.5-1.2b-q4,qwen2.5-1.5b-q4,qwen3-1.7b-q4,gemma3-1b-q4
   --threads 2,3,4` → `ml/results/bench.json`; write
   `docs/local-intelligence/BENCHMARKS.md`. Qwen3-1.7B latency in RESULTS.md
   was inflated by other jobs; rerun its eval alone if it stays a candidate.
4. **Prompt v2 experiment** on the two best models: add a plan example and a
   "context needs until" rule to `EXAMPLES` in `context-prompt.js`, bump
   `PROMPT_VERSION`, rerun test-mini and gold, compare. Keep v1 numbers.
5. **Gold set** for the two best models (`--set gold`).
6. **`docs/local-intelligence/MODEL-SELECTION.md`**: licences (Apache-2.0:
   Qwen, LFM Open License: Liquid, Llama 3.2 Community, Gemma terms),
   architecture (dense vs hybrid vs the owner's "dense 1B" target), RAM,
   speed, quality, and the recommended fine-tune base with reasons. The
   owner's spec says dense transformer; LFM3 is hybrid but built for local
   agents and cheap long context: present the trade-off, do not decide it
   silently.
7. **`LOCAL-INTELLIGENCE-REPORT.md`**: completed work, test results, measured
   numbers, limitations (procedural data, no GPU run, no cloud baseline because
   no API key, desktop UI for settings not built: settings are a JSON file
   and IPC), next steps (teacher-model paraphrasing of the dataset, GPU
   fine-tune, gate, Codeply Runtime fork phases).
8. Final: `npm run test:context`, `npm run test:brain`,
   `node scripts/engine-test.mjs`, `node scripts/life-test.mjs`; regenerate
   `ml/results/RESULTS.md` with `node ml/eval/report.mjs`; commit and push.

## Rules that stay

* No PR, no push to `main`, attribution trailer on commits as before.
* Never run two model jobs at once on the 4 cores.
* Sensitive events never go to a non-local backend; no silent cloud
  fallback; model output always goes through `checkExtraction`.
* Do not attempt 1B training here (no GPU). The fine-tune scripts are for a
  rented GPU (`ml/finetune/README.md`).
