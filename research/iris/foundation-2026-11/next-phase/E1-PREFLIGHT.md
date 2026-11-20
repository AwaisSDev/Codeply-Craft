# E1 preflight (2026-11-20), before any GPU evaluation

Owner decision of 2026-11-20: E1 is approved with preflight checks; the CPU export and integrity checks run first; GPU
evaluation only if they pass. This file records each check, its evidence and its status. Nothing in the protocol's
cells, metrics, gates or criteria was changed.

## 1. Artifact hashes (verified locally, and again inside both kernels)

| Artifact | Expected sha256 | Local check | Kernel check |
|---|---|---|---|
| r2 adapter (`codeply-iris-adapters-v1`, `iris-1.7b-r2/`) | `c590bfae…4fba` | **match** (downloaded 2026-11-20) | export G0, eval G0 |
| r3 adapter (`iris-1.7b-r3/`) | `f80b023e…e555` | **match** | export G0, eval G0 |
| pilot control adapter (`codeply-iris-pilot-train`, best) | `d1b25b1b…42a6` | **match** (local copy of the kernel output) | export G0, eval G0 |
| pilot Q4_K_M GGUF (`codeply-iris-pilot-export`) | `b9a5e56c…51c2` | **match** | export G0, eval G0 |
| `data/built/val.jsonl` | `0ae33173…aee3` | **match** | export G0, eval G0 |
| `data/raw/val/va01.jsonl`, `va02.jsonl` | `141f48ee…`, `417a2aab…` (= the seed-1 manifest) | **match** | export G0, eval G0 |
| raw ChatML template `e1/chatml_raw.jinja` | `109ba71e…2138` | written for E1 | export G0 |
| llama.cpp | commit `7a4117eef97ed6419241da2384b2b1c011ecd763` | local CPU build reports `7a4117e` | export: built from that commit (`git rev-parse` checked); eval: `--version` of the CUDA build must contain `7a4117e` |

All expected values are in `e1/e1_expected.json`; the kernels stop (G0) on any mismatch or missing file.

## 2. Historical base-model revision (r2 / r3)

**Not recorded anywhere.** Searched: the r2 / r3 training configs (`base: Qwen/Qwen3-1.7B` only), the adapters'
`adapter_config.json` (`revision: null`, peft 0.21.3) and README (`base_model: Qwen/Qwen3-1.7B`), the safetensors
metadata (`{"format": "pt"}`), the historical kernel log (`results/gpu-r2/kernel-log.json`: no download lines, no
snapshot hash), the historical result files (no manifest existed then), the audit-r4 run manifest (data only). The
historical kernel (`scripts/kaggle/run.py`) loaded `Qwen/Qwen3-1.7B` from Hugging Face without a revision, i.e. `main`
at run time. The adapters dataset was created 2026-11-14 06:40 UTC. The pilot also used `main` without a recorded
revision (its config has no revision; `70d244cc` in the protocol was the `main` hash at the time, not a recorded pin;
corrected here).

**What can be established** (Hugging Face API, fetched 2026-11-19 and 2026-11-20; `e1/e1_expected.json` keeps the full
commit list):

* `main` = `70d244cc86ccca08cf5af4e1e306ecf908b1ad5e`, committed 2025-07-26 ("Create LICENSE"), the newest of 18
  commits. Every training run here (r2 / r3 2026-11-13/14, pilot 2026-11-20) is later.
* The weights (`model-0000{1,2}-of-00002.safetensors`, LFS sha256 `169ad53e…`, `912becff…`), `config.json`,
  `generation_config.json`, `tokenizer.json`, `vocab.json`, `merges.txt` and `model.safetensors.index.json` are
  **byte-identical in every revision since the weights were uploaded** (commit `8d4744f9`, 2025-04-28): checked via the
  tree API at `8d4744f9`, `0060bc56` and `70d244cc`.
* The only content change after the upload: `tokenizer_config.json` on 2025-05-19, a chat-template edit that only
  affects non-string message content and tool-call handling. For string messages (all E1 prompts) the rendered text
  is identical. The raw ChatML path of r2 / r3 does not use the chat template at all. Two files
  (`added_tokens.json`, `special_tokens_map.json`) were deleted on 2025-04-28, 18 minutes after upload; their content
  is also in `tokenizer.json`.

**Classification.**
* The exact revision **ref** used by r2 / r3 is **inferred, not recorded**: `main` at run time, which the commit
  history shows was `70d244cc` from 2025-07-26 onwards. A history rewrite on Hugging Face cannot be excluded from the
  public API.
* The base **content** that matters to the reproduction (weights, config, tokenizer) is **the same in every revision
  that ever existed**. So every comparison is unaffected whichever revision was used. E1 loads the base at
  `70d244cc` explicitly and verifies every file hash (export and eval G0).
* Reported wording: "r2 / r3 base revision not recorded; base content established by hash equivalence across all
  revisions". The G2 reproduction is reported as a reproduction **of the historical number with the same base
  content**, not as a verified reproduction of a recorded configuration. If G2 fails, the revision cannot be the
  cause, so the report looks at library versions and hardware instead.

## 3. Environment

| Item | Historical r2 / r3 evaluation | Seed-1 pilot | E1 |
|---|---|---|---|
| torch | 2.11.0+cu130 | Kaggle image | Kaggle image (recorded; a different version is reported as a deviation, not replaced) |
| transformers | 5.23.0 | 5.23.0 | 5.23.0 (pinned) |
| peft | 0.21.3 | 0.22.0 | 0.21.3 (pinned, = r2 / r3's `peft_version`) |
| accelerate | not recorded | 1.16.0 | 1.16.0 |
| llama.cpp | — | `7a4117e` | `7a4117e` |
| GPU | 2 x T4 | 2 x T4 | 2 x T4 (kernel stops without two T4s) |

## 4. Templates, decoding, scoring (consistency with the protocol)

* **Template gates passed locally** (CPU llama-server at `7a4117e`, tokenizer at `70d244cc`; 10 observe + 5 retrieve
  validation prompts, first by id):
  * TG1, raw ChatML template vs `prompt.chatml`: 15 / 15 identical;
  * TG2, `prompt.chatml + empty think block` vs the official template (HF) and vs the server with the pilot GGUF:
    15 / 15 and 15 / 15;
  * token ids, server vs HF tokenizer: 15 / 15 for both formats.

  The kernels re-run the gates on the exported files.
* **Decoding:** T cells use the unchanged `HFBackend.generate` (greedy, repetition penalty 1.0, `<|im_end|>` stop, fp16
  autocast; the cap comes from `evaluate`: 900 observe / 160 retrieve). GGUF cells use the unchanged
  `ChatServerBackend` (temperature 0, top-k 1, seed 0, repeat penalty 1.0, no prompt cache), `--threads 4 -ngl 99`,
  context 8192, identical to seed 1.
* **Scoring:** the unchanged `evaluate.open_loop` / `closed_loop` and `report_run.py` (12 replay tests reproduce the
  committed results).
* **Log-probability capture in T cells** (`e1_run.py`): a logits processor that records the chosen token's
  log-probability and returns the scores unchanged.
  * CPU smoke on the r2 adapter (48-token generations, not an E1 result): text identical with and without capture.
  * Token-to-text alignment exact (0 failures on 186 strings incl. Urdu script).
  * Cached records score with `confidence.op_scores`; `report_run.py` runs on the output.
  * SC1 repeats the identity check on the GPU before any T cell.
* **Test split:** not in the source dataset (`codeply-iris-e1-src`: code, `val.jsonl`, `raw/val`, E1 scripts only;
  no train, no test); both kernels assert it.

## 5. Deviations so far

1. Protocol §1 called `70d244cc` "the pilot pin". It was the `main` hash, not a recorded pin (§2). Corrected here; no
   effect on the runs, since the content is identical in every revision.
2. Run-time hard stop: the GPU kernel stops starting cells **and kills running cells** at 3 h 25 min of kernel time
   (owner instruction: 3.5 GPU-hour hard stop, kept below it to allow for container start-up). The protocol said
   running cells would finish; the owner's hard stop takes precedence. Killed cells are reported as incomplete.
3. SC1 is run once, on the r2 adapter (the capture code is adapter-independent).

## 6. CPU export (`codeply-iris-e1-export`)

**Version 1 (failed, infrastructure; reported, not hidden).** Every integrity check passed inside the kernel:
* `G0_no_test`;
* the r2, r3 and pilot adapters (sha256 as above);
* the pilot Q4 GGUF;
* val (built + raw);
* the template;
* `G0_base`: all 12 files of `Qwen/Qwen3-1.7B@70d244cc` matched their recorded LFS sha256 / git blob sha1.

The kernel then failed while building llama.cpp, because the `llama-server` target needs the pinned web-UI archive
(the wave-A build finding), which this kernel did not carry. No GGUF was produced, and nothing was measured.

**Change for version 2 (execution plan, not protocol):**
* The export builds `llama-quantize` only, as the seed-1 export did.
* The template gates (TG1 / TG2 / token ids) run **locally** (CPU llama-server at `7a4117e`) on the actually exported
  GGUFs before the GPU kernel is launched, and again inside the GPU kernel before any cell (protocol G1).
