# Iris foundation study: zero-shot IrisBench evaluation plan (pre-registered 2026-11-19)

Committed **before** any candidate model is run. Changes after the first candidate result get a dated amendment
below, never an edit. Exact per-model settings are in `run_config.json`. Why these models: `REPORT.md`.

## 1. What this evaluation can and cannot decide

It screens foundations on what a zero-shot run can show: format and quote compliance, precision when the model
does store something, abstention quality (log-probability ranking), Urdu and Roman Urdu reading, and the runtime
cost on the reference CPU. It **does not decide the fine-tuning foundation on its own**: zero-shot F1 at this
size is near zero (Qwen3-0.6B: 0.021 on the old val). The decision is a matched LoRA pilot (§8), which needs
separate approval. Nothing here trains a model or reads the test split.

## 2. Data (fixed)

* Validation only: `data/built/val.jsonl` sha256 `0ae331732c7f…` (24 episodes, 120 observe + 64 retrieve examples)
  and `data/raw/val/{va01,va02}.jsonl` for closed loop. Both are reproduced byte-for-byte by
  `python -m codeply_iris.build --raw data/raw --seed 1` (verified 2026-11-19).
* Test (`te01`, `te02`) is not read, uploaded or evaluated in this study.
* Sensitivity analysis (pre-registered): every primary metric also without `va01-e01`, which shares "Ledgerline"
  with train (audit r4 §3).
* `data/built` and `data/raw` are not modified. Do not use the separate `AwaisSDev/codeply-iris` repository's data:
  it is an older, incomplete snapshot (REPORT §1.5).

## 3. Systems

| Wave | System | Role |
|---|---|---|
| A | Qwen3.5-2B, Gemma 4 E2B-it, Qwen3-4B-Instruct-2507 | the three candidates to test first |
| A | Qwen3-0.6B, Qwen3-1.7B (zero-shot, same prompt and backend) | baselines; the 0.6B result on the old val is superseded, not reused |
| B | Qwen3.5-4B, Qwen3.5-0.8B, Granite 4.2 3B, Ministral-3-3B-Instruct-2512, LFM3-1.7B | second wave; LFM3 as production's model and reference, not as a foundation |
| C | LFM2.5-2.6B (reasoning on, budget 1,024 tokens, open loop only) | diagnostic: does reasoning lower false memories, and at what latency |
| — | rules, nothing | already re-run on this val (`results/foundation-2026-11/val24-*`) |
| — | Iris 1.7B r2 / r3, 0.6B r2 / r3 | fine-tuned references: committed val results (HF fp16, T4, unconstrained). Reported next to the zero-shot table, **never ranked against it**. Optional: export 1.7B r3 to GGUF Q8_0 on Kaggle and run it through this exact backend |
| excluded | Aion-1.0-Instruct-2.3B | not runnable on stock llama.cpp (GGUF arch `aion` unknown) or stock transformers. Re-add when upstream supports it |
| optional | Tiny Aya Global | research-only Urdu reference (CC-BY-NC, gated); never a foundation |

## 4. Fixed settings (identical for every system)

| Setting | Value | Note |
|---|---|---|
| Task text | `prompt.observe_prompt` / `prompt.retrieve_prompt`, unchanged | |
| System prompt | `prompt.ZERO_SHOT_SYSTEM` **v1.1** = v1 plus one sentence after the `evid` line: *"Copy the quote from the message text only: never include the [n] number or the speaker name."* Retrieve system unchanged | v1 caused 84 of 91 rejected quotes in the only zero-shot run (REPORT §1.3). Decided from that val diagnosis, before any candidate is run, the same text for every model. v1 is kept and run once more for Qwen3-0.6B and Qwen3-1.7B so the change is measured, not assumed |
| Contract and guard | `iris.ops/1`, `contract.guard` unchanged; the evidence check stays character-exact | |
| Chat formatting | each model's **own chat template** (GGUF-embedded, llama-server `--jinja`) via `/v1/chat/completions`; system + user messages, no few-shot turns beyond the example inside the system prompt | the current backend hard-codes ChatML and Qwen's `<|im_end|>`, which would be wrong for Gemma, Granite and Ministral. Stage 0 checks parity for Qwen3 |
| Thinking | off where a switch exists: `chat_template_kwargs: {"enable_thinking": false}`. Any `<think>…</think>` in the answer is stripped before parsing, **for every model**, and counted (`think_leak_rate`). Generated thinking tokens count in latency | Qwen3.5-4B, Granite 4.2, LFM3 and Qwen3 think by default; LFM3's switch is documented as inconsistent |
| Decoding | greedy (temperature 0, top-k 1), seed 0, max tokens 900 (observe) / 160 (retrieve), no repetition or presence penalty | the same for every model, even where vendors recommend sampling |
| Structured output | **primary: JSON-Schema-constrained** (`contract.OUTPUT_SCHEMA` / `USE_SCHEMA` as `response_format`), open and closed loop. **Secondary: unconstrained**, open loop, first 6 val episodes (30 sessions), for native format and quote compliance | constrained decoding isolates content from formatting |
| Log-probabilities | top-1 token log-prob for every generated token (`logprobs: true`) | for the abstention metric (§5) |
| Weights | Q4_K_M from the repository in `run_config.json`; Gemma 4 E2B: Google's QAT Q4_0. sha256 of every GGUF is recorded at download | one quantisation family for all. Q8_0 sensitivity re-run for the top model only |
| Runtime | llama.cpp `llama-server`, one pinned commit (recorded with `--version`), CPU build (`GGML_NATIVE`), `-t 4 -c 8192 --parallel 1`, `cache_prompt: false` | reference machine: this container (4 vCPU Xeon, AVX-512 / AMX, 15 GB) |
| Prompt cache | off | so latency is per session, as in production |

Everything above goes into a run manifest per system (`results/foundation-2026-11/<system>/MANIFEST.json`):
code commit, data hashes, GGUF sha256, llama.cpp version, the full settings, wall time.

## 5. Metrics (every one per system, open and closed loop unless stated)

**Primary for this study (closed loop, constrained):**

1. **False memories per 100 sessions** (the user-facing count, not a share).
2. **Precision at matched coverage, P@60**: rank every predicted content op by its score (mean token log-prob over the
   op's `val` tokens; ties by order), take the top 60 (≈ 1/6 of the 369 closed-loop gold content ops), and compute
   strict precision. A model that emits fewer than 60 content ops gets no P@60 and is marked "under-covering". This
   stops a silent model from winning on precision. Also reported: the full risk-coverage curve and its area.
3. **F0.5** of content ops (precision-weighted).

**Reported in full (IRISBENCH §3 and the r4 brief):** precision, recall, F1, wrong-fact (false-memory) share;
false memories per 100 sessions; exact-evidence compliance (ungrounded quotes / emitted ops, before the guard, and
the speaker-label pattern); update and contradiction resolution (right op + right target), retract precision and
recall, confirm recall, duplicates created; `conflict` (n = 0 in val: reported as untestable); skip recall, why
accuracy, traps stored by kind; temporal (date, date-time, `until`) on matched ops, and date-caused false memories;
entity linking (value matched, wrong entity); end-state precision / recall / F1 and stale / duplicate / false
shares (closed); retrieval P / R / F1; output validity and schema drops; think-leak rate.

**Breakdowns:** by operation type; by false-memory category (the `failure_analysis.py` taxonomy: unlabelled
statement, same statement / different value, date, entity, attribution, trap); by miss type (untouched vs near
miss; implied vs stated; user vs other speaker); by language (**English, Urdu script, Roman Urdu, mixed**: 14 / 2 /
6 / 2 episodes, so Urdu script and mixed are descriptive only); by source; by session index (closed); by input
length and store size; by label source (va01 Opus vs va02 Sonnet).

**Cost:** p50 / p95 seconds per observe session, prompt and generated tokens, peak RSS, and llama-bench (`-p 512,2048
-n 128 -t 4`, plus `-d 2048` for decode at depth), all on the reference CPU.

**Statistics:** 95 % paired cluster bootstrap over episodes (2,000 resamples, seed 0), as in IRISBENCH §4. Every
comparison is against zero-shot Qwen3-1.7B on the same settings.

## 6. Additional probe: gold-target likelihood (no generation)

For every system: teacher-forced loss of the **gold** observe answers on val (the targets `build.py` derives),
rendered with each model's chat template, in bits per character so that tokenizers are comparable, by language.
It measures how natural the Iris answer is to each base model before training, which correlates with how easily it
fine-tunes. It is not a quality score. HF transformers, bf16, CPU or one T4; forward passes only.

## 7. Stages, gates and compute

| Stage | What | Gate to continue | Compute (estimates unless marked) |
|---|---|---|---|
| **0. Engineering** (no spend) | `ChatServerBackend` (`/v1/chat/completions`, template kwargs, `response_format`, logprobs, think stripping); `ZERO_SHOT_SYSTEM_V11` next to v1; run manifest; P@k, F0.5, per-100-session counts and the taxonomy in a new report script (existing `evaluate.py` outputs unchanged); unit tests. **Parity:** Qwen3-0.6B, 10 val sessions, raw-ChatML path vs chat path, greedy, must give identical text. **llama-bench** of every wave-A/B GGUF | tests pass; parity holds; every model loads in the pinned llama.cpp | ~1-2 h CPU; ~20 GiB of GGUF downloads |
| **1. Wave A** | 5 systems, open + closed (constrained) + 30-session unconstrained screen; v1 re-runs for the two baselines | none (always reported) | ~12 CPU-h here, or ~2-2.5 Kaggle T4-h |
| **1b. Likelihood probe** | §6 for wave A and B | — | ~2-3 CPU-h or ~0.5 T4-h |
| **2. Wave B** | 5 systems, same | started only after wave A is written up | ~14 CPU-h, or ~3 T4-h |
| **3. Wave C** | LFM2.5-2.6B, open loop, reasoning budget 1,024 | — | ~3.5 CPU-h |
| **4. Write-up** | ranking table, every breakdown, decision on the pilot candidates | — | — |

Per-session estimates behind the hours (zero-shot ≈ 1,200 prompt + ≈ 250 generated tokens, 4 threads), scaled from
the measured Qwen3-4B Q4_K_M anchor (78 tok/s prompt, 6.8 tok/s generation) and the measured Qwen3-0.6B Q8_0 run
(15.8 s): Qwen3.5-0.8B ~10 s, Qwen3-0.6B ~15 s, LFM3-1.7B ~18 s, Qwen3-1.7B ~24 s, Qwen3.5-2B ~26 s, Gemma 4 E2B ~30 s,
Ministral 3B ~45 s, Granite 4.2 3B ~47 s, Qwen3-4B-2507 ~52 s, Qwen3.5-4B ~55 s. ~296 session-equivalents per
system (240 observe, 64 retrieve at ~0.4x, 30 unconstrained). The `qwen35` and `gemma4` CPU kernels are unmeasured,
so stage 0's llama-bench replaces these numbers before stage 1 starts. Kaggle T4 estimates assume llama.cpp CUDA at
~5x the CPU speed. Kaggle GPU quota is shared with PASTE; PASTE kernels are never stopped or changed.

**Pre-registered selection rule for the LoRA pilot** (applied after stage 4, val only): advance at most three
foundations. A foundation qualifies when, against zero-shot Qwen3-1.7B, (a) the 95 % interval of Δ false memories
per 100 sessions (closed) has an upper bound ≤ 0, **and** (b) the interval of Δ P@60 or Δ F0.5 (closed) is above 0.
Among qualifiers: rank by P@60, then F0.5, then p95 latency. Urdu-script and Roman-Urdu slices are reported next to
each qualifier, not gated (n too small). If nothing qualifies, the write-up says so. The owner then decides between
a pilot of Qwen3.5-2B alone (structural reasons, REPORT §6.2) and no pilot. No extra candidates are added in search
of a win.

## 8. After this plan (needs separate approval; not started)

**Matched LoRA pilot:** the r4 data (or, before it exists, the current train split), the r2 recipe at 2 epochs,
seed 1, for Qwen3-1.7B and the qualifying foundations; evaluated on val with this backend after GGUF export.
Estimate: 1.7B ~50 min per run on one T4 (r2 measured 71 min for 3 epochs). Qwen3.5-2B ~75 min, **if** its DeltaNet
CUDA kernels work on the T4 (smoke test first). Gemma 4 E2B: QLoRA, ~2 h, with an fp16-overflow check (Gemma on T4 has
no bf16). Qwen3-4B: ~2 h. Evaluation ~30 min per loop per model with batched generation. Total ~6-8 T4-hours for
three foundations, one seed. The foundation decision uses closed-loop F1, false memories per 100 sessions and
end-state F1 with the IRISBENCH §4 rule.

## 9. Reproduction

```
cd research/iris
python3 foundation-2026-11/failure_analysis.py      # error analysis of committed runs (no model)
python3 foundation-2026-11/verify_models.py         # model facts, GGUF headers, tokenizers (network)
python3 -m codeply_iris.evaluate --system rules   --split val --out results/foundation-2026-11/val24-rules [--closed-loop]
python3 -m codeply_iris.evaluate --system nothing --split val --out results/foundation-2026-11/val24-nothing [--closed-loop]
# stage 1+ commands are added with the stage-0 backend, one per system, from run_config.json
```

## Amendments

### A1 (2026-11-19, after stage 0; before any candidate result)

Stage 0 is done (`stage0/CHANGES.md`). These amendments change **how** settings are sent, not what is measured.
Primary metrics, data, prompt v1.1, systems and the selection rule are unchanged.

1. **Structured output on the chat path** is sent as llama-server's top-level `json_schema` field, not
   `response_format`; `response_format` fails on the pinned build. Same schema (`contract.OUTPUT_SCHEMA` /
   `USE_SCHEMA`).
2. **Reasoning format `auto`, not `none`.** With `none`, thinking off and a schema, llama.cpp 7a4117e fails to
   initialise the grammar sampler (HTTP 400). With `auto` the server returns reasoning separately; it is stored in
   the cache (`reasoning`), counted in `think_chars` and in latency, and never parsed. Any `<think>` block left in the
   content is stripped by `split_think`, identically for every model.
3. **Pinned runtime:** llama.cpp `7a4117eef97ed6419241da2384b2b1c011ecd763` (2026-11-19), CPU build, `GGML_NATIVE`.
   Wave-A GGUF sha256: `stage0/bench/GGUF-SHA256SUMS` (checked by `run_wave_a.sh` before running).
4. **Exact commands:** `run_wave_a.sh`. The prompt-v1 continuity runs for the two baselines are open loop only.
5. **Compute, from llama-bench on the reference CPU** (`stage0/bench.json`; estimates for full sessions assume
   350 generated tokens):

   | System | File | pp2048 tok/s | tg tok/s | Est. s / zero-shot session | Est. CPU-h (296 session-equiv.) | Est. s / fine-tuned batch |
   |---|---|---|---|---|---|---|
   | Qwen3-0.6B | 0.36 GiB | 399 | 49.7 | 10 | 0.8 | 4.9 |
   | Qwen3-1.7B | 1.03 GiB | 218 | 17.2 | 26 | 2.1 | 13.8 |
   | Qwen3.5-2B | 1.18 GiB | 226 | 14.5 | 30 | 2.4 | 16.8 |
   | Gemma 4 E2B (QAT Q4_0) | 3.10 GiB | 450 | 18.9 | 21 | 1.7 | 11.8 |
   | Qwen3-4B-Instruct-2507 | 2.32 GiB | 79 | 7.8 | 60 | 5.0 | 31.5 |

   Wave A: **~12.1 CPU-hours** for the five systems, **+~1.5 h** for the two v1 continuity runs: **~13.5 h**
   sequential on this container. Gemma 4 E2B is the fastest candidate despite the largest file (per-layer
   embeddings are lookups); Qwen3.5-2B runs at about Qwen3-1.7B's speed on CPU (its DeltaNet layers have native
   llama.cpp kernels; only the earlier *training* benchmark used slow reference kernels).
6. **Secondary diagnostics added** (not decision metrics): entity-relaxed F1, reported with its measured agreement
   with manual judgement (precision 0.65, recall 0.81; `stage0/metric_audit.json`); the stage-0 taxonomy in
   `report_run.py` (span-overlap trap rule, "should have acted on a stored memory"). The strict `hard_negative_stored`
   keeps its pre-registered definition and is known to miss a trap quote that continues the labelled one.
7. **Smoke runs** (one val episode, scratch output, not results) passed through the full evaluator; see
   `stage0/CHANGES.md` §4.

### A2 (2026-11-19, Kaggle check; before any wave-A result)

Owner decision: wave A runs on Kaggle T4 instead of the reference CPU. Data, prompts, decoding, schema, metrics,
systems and the selection rule are unchanged. Evidence: `stage1-kaggle/KAGGLE-CHECK.md`.

1. **Hardware of record for quality metrics: Kaggle 2 x Tesla T4** (sm_75, driver 580, CUDA 13.0), llama.cpp 7a4117e
   built with CUDA, all layers on the GPU (`--server-arg=-ngl --server-arg=99`). Every wave-A system runs on this
   hardware; CPU and GPU results are never mixed in a comparison (they differ at near-tie tokens; GPU runs are
   deterministic across the two T4s).
2. **Latency of record stays the reference CPU** (stage-0 llama-bench); GPU timings are planning figures only.
3. **Exact commands: `scripts/kaggle/wave_a_run/run.py`** (the `run_wave_a.sh` commands plus `-ngl 99`, split over the
   two GPUs; it re-verifies GGUF sha256 and refuses to run without a T4 or with any test file present).
4. **Reported in addition, per system:** the share of observe sessions stopped at the 900-token cap.
5. **Optional hardware noise floor** (no quota): Qwen3-1.7B, full val, open loop, on the reference CPU, compared with its
   GPU run.
