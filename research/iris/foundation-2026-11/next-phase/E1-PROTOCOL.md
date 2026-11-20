# E1: control diagnosis, protocol (pre-registered 2026-11-20, before any E1 run)

Status: **written, not run.** No Kaggle job is launched until the owner approves this protocol. Nothing here changes
the five pilot criteria, the seed-1 outcome (`pilot/PILOT-S1-RESULTS.md`), any committed result, or any existing
training, evaluation or production code. E1 is diagnostic: **no Photon model is selected or adopted from E1.**

## 0. Question

Why does the pilot Qwen3-1.7B control (open-loop F1 0.292, closed 0.164) score far below the historical 1.7B runs r2 /
r3 (open 0.404 / 0.420, closed 0.311 / 0.333) on the same validation data with the same scorer
(`NEXT-PHASE-ASSESSMENT.md` §1, M1-M7)? E1 measures how much of that gap comes from the **inference stack** (backend,
quantisation, constrained decoding), evaluated on each adapter in its own training format. What remains is attributed to
the **training recipe as a bundle** (data incl. drills, epochs, template, r3's self-output data). E1 does not split
that bundle; that would be stage 2 (§7), which needs separate approval.

## 1. Artifacts (exact; verified by sha256 before use; a mismatch stops the run, §6)

| Id | What | Source | sha256 |
|---|---|---|---|
| **A-r2** | Qwen3-1.7B LoRA r2, `best/` (step 400, val loss 0.2135) | Kaggle dataset `awaissididique/codeply-iris-adapters-v1`, `iris-1.7b-r2/adapter_model.safetensors` | `c590bfae5d598f3f6c45acabbab126635d39ab0fa89bbadb4df206b9c24b4fba` (`results/gpu-r2/ADAPTERS.sha256`) |
| **A-r3** | Qwen3-1.7B LoRA r3, `best/` (init from r2, self-output + replay) | same dataset, `iris-1.7b-r3/adapter_model.safetensors` | `f80b023e303c9b2c6612211b7155d76df723dc1f36acf33b7ef628c63899e555` |
| **A-p** | Pilot control Qwen3-1.7B seed 1, `best/` (= final, step 208) | kernel output `awaissididique/codeply-iris-pilot-train`, `runs/pilot-qwen3-1.7b-s1/best/adapter/adapter_model.safetensors` | `d1b25b1b2ec92b98885cecd7dde3ac8c3c7bcc4f5de6b39ef9cce78d758742a6` |
| **G-p-Q4** | Pilot control Q4_K_M GGUF used in the seed-1 evaluation | kernel output `awaissididique/codeply-iris-pilot-export` | `b9a5e56c69afb0989fcda2047770a5de761f2fc3c77154000784f3c2fdac51c2` |
| Base | `Qwen/Qwen3-1.7B` | Hugging Face, revision `70d244cc86ccca08cf5af4e1e306ecf908b1ad5e` (the pilot pin) | per-file sha256 written to the manifest |
| llama.cpp | server + quantize + convert | kernel output `awaissididique/codeply-iris-wave-a-check`, commit `7a4117eef97ed6419241da2384b2b1c011ecd763` | binaries' sha256 written to the manifest |
| Val data | `data/built/val.jsonl`, `data/raw/val/va01-02` | dataset `codeply-iris-pilot-src` (re-uploaded only if unchanged) | built val `0ae331732c7fcf609304b0069c61e0b0162e9617d5c3041fca820d8b7e38aee3` |
| Reference results (read-only) | committed r2 / r3 / pilot outputs | `results/gpu-r2/val/iris-1.7b-r{2,3}/`, `results/foundation-2026-11/pilot-s1/qwen3-1.7b/` | git |

**New artifacts, built by a new CPU export kernel `codeply-iris-e1-export`** (no GPU quota). It uses the same procedure
as the pilot export (`scripts/kaggle/pilot_export/export_pilot.py`: streaming per-shard merge computed in fp32,
saved fp16, assertion that every adapter module was matched → `convert_hf_to_gguf.py --outtype f16` →
`llama-quantize Q4_K_M`). It is a new script; the existing export script is not modified.

| Id | Built from | Note |
|---|---|---|
| G-r2-F16, G-r2-Q4 | A-r2 + Base | new |
| G-r3-Q4 | A-r3 + Base | new (r3 gets only the two anchor cells) |
| G-p-F16 | A-p + Base | new (the seed-1 F16 intermediate was deleted after quantising) |
| G-p-Q4re | A-p + Base, re-exported | **check only**: sha256 compared with G-p-Q4. The Q4 cells use the original G-p-Q4 either way; a mismatch is reported, not substituted |

**Known unknown, reported up front:** the r2 / r3 training config records `base: Qwen/Qwen3-1.7B` without a revision.
E1 uses the pinned revision for every adapter. Silent drift between revisions would show up in the reproduction gate
(§6, G2).

**Environment:** the historical r2 / r3 evaluation ran on Kaggle T4 with torch 2.11.0+cu130, transformers 5.23.0, peft
0.21.3. E1 pins transformers 5.23.0 and peft 0.21.3 for the Transformers cells (the pilot's peft 0.22.0 is recorded
if the pin is unavailable, and reported as a deviation). Versions actually used are written to each cell's manifest.

## 2. Inference setups

All cells run open loop and/or closed loop on the full validation split (24 episodes; 120 observe sessions + 64 retrieve
queries per loop), with `--system iris` (`prompt.SYSTEM`, the contract system prompt), greedy decoding (temperature 0,
`do_sample=False`), repetition penalty 1.0, observe cap 900 new tokens, retrieve cap 160, context 8192, the same
contract parser and guard (`contract.parse`, `contract.guard`), the same scorer and the same closed-loop store.

| Setup | Engine | Weights | Decoding | Logprobs |
|---|---|---|---|---|
| **T** "full precision" | Transformers `HFBackend` (unchanged historical code path) | base fp16 + LoRA merged (`merge_and_unload`) | unconstrained | captured by the E1 runner from `generate(..., output_scores=True)` (§2.2) |
| **F16-U / F16-C** | llama-server, pinned commit, `-ngl 99`, `--threads 4` | GGUF F16 | unconstrained / JSON-Schema constrained (top-level `json_schema`) | from the server (chat path) |
| **Q4-U / Q4-C** | same | GGUF Q4_K_M | unconstrained / constrained | from the server (chat path) |

**Deviation, stated now:** "full precision" is fp16, not bf16 or fp32. The T4 (sm_75) has no bf16, and fp16 is what
r2 / r3 were evaluated with historically. An fp32 cell is not run (2x time, and not the historical reference).

### 2.1 Prompt format: each adapter in its own training format

| Adapter | Trained on | T cells | GGUF cells |
|---|---|---|---|
| A-r2, A-r3 | raw ChatML from `prompt.chatml(user, SYSTEM)`, **no think block** | `Iris(HFBackend)` raw path, `answer_prefix=""` (identical to the historical run) | chat path with a custom Jinja template (`--server-arg=--chat-template-file`) that renders exactly `prompt.chatml(user, SYSTEM)` |
| A-p | official Qwen3 template, `enable_thinking=false` (empty `<think>\n\n</think>\n\n` block) | `Iris(HFBackend, answer_prefix="<think>\n\n</think>\n\n")` on the raw path | chat path, model's own template, `--template-kwargs '{"enable_thinking": false}'` (identical to seed 1) |

**Template gates (before any cell runs; failure stops that adapter's cells, §6):**
* **TG1 (r2 / r3 GGUF):** for 10 fixed validation sessions (first 10 by id), `/apply-template` output equals
  `prompt.chatml(user, SYSTEM)` byte for byte.
* **TG2 (pilot T):** for the same 10 sessions, `prompt.chatml(user, SYSTEM) + "<think>\n\n</think>\n\n"` equals
  `tokenizer.apply_chat_template(..., add_generation_prompt=True, enable_thinking=False)` byte for byte (the existing
  `pilot/template_parity.py` check, re-run inside the kernel).
* **Pre-declared fallback for TG1 only:** if the custom template cannot match, r2 GGUF cells run on the raw completion
  path (`ServerBackend`, same string, constraint supported, **no logprobs**). P@60 is then reported as N/A for those
  cells. The fallback is reported as a deviation, never silently.

### 2.2 The E1 runner (new code, nothing existing modified)

A new script, `foundation-2026-11/next-phase/e1_run.py`, imports `codeply_iris` and calls the existing
`evaluate.open_loop` / `evaluate.closed_loop`. It adds only:
(a) the pilot `answer_prefix` for T cells;
(b) a thin subclass of `HFBackend` that calls the same `generate` with `output_scores=True, return_dict_in_generate=True`
and returns per-token `[token, logprob]` in the same shape the server path produces, so that `confidence.op_scores` and
P@60 work in T cells. Greedy outputs do not depend on score capture.
**Check SC1:** on the first 10 sessions, text with and without score capture must be identical. If it is not, T-cell
P@60 is reported as N/A, and the T cells run without capture.

`evaluate.py`, `infer.py`, `train.py`, the scorer and the contract are not touched. The kernel refuses any split other
than `val`, and the uploaded dataset contains no test file (the existing kernels already assert this).

## 3. Cells

Primary = open loop (exact per-session comparison, no store feedback). Closed loop only where it decides the reading.

| # | Adapter | Setup | Loop | Purpose |
|---|---|---|---|---|
| 1 | A-r2 | T | open | **reproduction gate G2** (historical: open F1 0.404) |
| 2 | A-r2 | F16-U | open | backend effect on r2 |
| 3 | A-r2 | F16-C | open | constraint at F16 |
| 4 | A-r2 | Q4-U | open | quantisation (unconstrained) |
| 5 | A-r2 | Q4-C | open | full pilot stack on r2 |
| 6 | A-p | T | open | **pilot adapter without the pilot stack** |
| 7 | A-p | F16-U | open | backend effect on pilot |
| 8 | A-p | F16-C | open | constraint at F16 |
| 9 | A-p | Q4-U | open | quantisation (unconstrained) |
| 10 | A-p | Q4-C (G-p-Q4) | open | **reproduction gate G3** (committed seed 1: open F1 0.292) |
| 11 | A-r3 | T | open | r3 anchor (historical 0.420) |
| 12 | A-r3 | Q4-C | open | r3 under the pilot stack |
| 13 | A-r2 | T | closed | historical closed anchor (0.311) |
| 14 | A-r2 | Q4-C | closed | r2 under the pilot stack, closed |
| 15 | A-p | T | closed | pilot adapter without the pilot stack, closed |
| 16 | A-p | Q4-C | closed | reproduction of seed-1 closed (0.164) |
| X1 | A-p | Q4-C, **no** think block | open | *exploratory, format swap* |
| X2 | A-r2 | Q4-C, **with** think block | open | *exploratory, format swap* |

X1 / X2 evaluate an adapter in a format it was **not** trained on. They show format sensitivity, not H3 (H3 concerns
training with the think block). They are reported in a separate section, never used in §5's decomposition, and are run
last, only if the time cap allows.

## 4. Metrics (all cells; identical code)

Computed by `report_run.report` and the existing scorer, on strict matching (entity match + value token-F1 ≥ 0.5 or
same date). Strict metrics are primary.

* **Precision, recall, F1** (strict, content ops).
* **False memories per 100 sessions.**
* **P@60:** precision of the 60 most confident content ops (mean value-token logprob, A4 ranking, deterministic ties).
  N/A where logprobs are unavailable (§2.1 fallback, SC1 failure); stated per cell, never imputed.
* **F0.5.**
* **Valid output** (share of observe sessions parsing to a contract-valid answer), plus the cap-hit share.
* **End-state F1** (closed-loop cells only; the final store against the gold end state), plus the end-state false share.
* **Diagnostic counts for the M3 behaviour:** sessions with no store op, skips on labelled facts, skips on labelled
  skips, content-op volume.
* **Retrieval F1** (the 64 queries) is reported but not decomposed.
* **Equal-volume precision (A4 definition)** for the r2-vs-pilot pairs in matched setups. Secondary.

**Guard rules R1-R4 are not applied in any E1 metric.** If they are measured at all, it is with
`pilot/infra_rules.py` on the E1 outputs, written to a separate file `E1-GUARD-RULES-SECONDARY.json`, and they are not
mentioned in the decomposition.

**Statistics:** 95 % paired cluster bootstrap over the 24 validation episodes, 2,000 resamples, seed 0, as in seed 1.
Every difference below is paired on the same episodes. The hardware noise floor from stage 1 is about 0.05 on P@60
(CPU vs GPU); differences smaller than that are not interpreted on P@60.

## 5. Comparisons: which are valid, which are confounded

Let F(adapter, setup) be open-loop F1. Analogous tables are reported for false / 100, recall, precision and the M3
counts.

| Comparison | Isolates | Valid? | Residual confounders |
|---|---|---|---|
| (a, T) vs (a, F16-U), same adapter | **backend** (Transformers vs llama.cpp, incl. GGUF conversion) | yes | numerics of the two engines; chat path vs raw path for r2 (TG1 makes the token string identical, so the only remaining difference is tokenisation of the same string; reported) |
| (a, F16-U) vs (a, Q4-U) | **quantisation** | yes | none known |
| (a, F16-U) vs (a, F16-C); (a, Q4-U) vs (a, Q4-C) | **constrained decoding** | yes | none known |
| (a, T) vs (a, Q4-C) | **whole inference stack** | yes (sum of the above) | as above |
| (A-p, Q4-C) vs committed seed 1 | **reproducibility** of the seed-1 pipeline | yes | Kaggle hardware non-determinism (measured by this check) |
| (A-r2, T) vs committed r2 | **reproducibility** of the historical number | yes | base revision, library versions (§1) |
| (A-r2, s) vs (A-p, s), same setup s | **training recipe as a bundle** | **confounded** | data (drills, 1,255 vs 826 examples), epochs (3 vs 2), template (raw vs think block), checkpoint step, and the interaction of each with the setup. **Not attributable to any single factor in E1** |
| Difference-in-differences: [F(r2,T) − F(r2,Q4-C)] − [F(p,T) − F(p,Q4-C)] | does the stack hurt the pilot adapter **more** than r2 (H2 for this adapter) | yes, as an interaction | the template / data difference may cause the different sensitivity; E1 can show the interaction exists, not why |
| (A-r3, ·) | same as r2, plus self-output training | confounded with r2 | descriptive anchor only |
| X1 / X2 | format sensitivity of a trained adapter | **exploratory only** | train / eval format mismatch by construction |
| Any E1 cell vs the 4B or Gemma pilot | — | **not part of E1** | different model; no selection |

**Gap decomposition (pre-registered):**
* Total gap G = F(r2, T) − F(p, Q4-C).
* Stack share for the pilot adapter: S = F(p, T) − F(p, Q4-C), split into backend [F(p,T) − F(p,F16-U)], quantisation
  [F(p,F16-U) − F(p,Q4-U)] and constraint [F(p,Q4-U) − F(p,Q4-C)]. The three parts sum to S exactly.
* Recipe share: Tr = F(r2, T) − F(p, T) = G − S.
* Reported: S / G and Tr / G with bootstrap intervals (ratio computed per resample), each component with its interval,
  and the same decomposition on false / 100 and recall. The closed-loop version uses cells 13-16 (backend,
  quantisation and constraint are not split there).

**Pre-registered readings (diagnostic labels, not adoption criteria):**
* **"Stack-dominated"**: S / G ≥ 0.5 (point) and the lower bound of S > 0.
* **"Recipe-dominated"**: Tr / G ≥ 0.5 (point), the lower bound of Tr > 0, and S's interval includes 0 or S < 0.03.
* **"Mixed"**: neither.
* **A component is "material"** if its 95 % interval excludes 0 and |ΔF1| ≥ 0.03 (or |Δ false / 100| ≥ 10, roughly
  half the between-system SE measured in seed 1).
* The reading is applied to open loop. Closed loop is reported next to it. If the two disagree in label, the report
  says so and labels the result "mixed".

## 6. Gates, stopping conditions, failure reporting

Run order (one GPU kernel `codeply-iris-e1-eval`, 2 x T4, two worker queues):
* **GPU0:** gates → 1 → 6 → 13 → 15 → 11.
* **GPU1:** gates → 10 → 2-5 → 7-9 → 12 → 14 → 16 → X1 → X2.

| Id | Condition | Action |
|---|---|---|
| G0 | any sha256 in §1 mismatches, or an artifact is missing | **stop before any cell**; report which; no substitution |
| G1 | TG1 / TG2 template gate fails | TG2: stop the A-p T cells (6, 15), continue the others. TG1: use the pre-declared raw-path fallback (§2.1), reported |
| G2 | cell 1 (r2, T, open) F1 outside 0.404 ± 0.02, or valid output outside 0.942 ± 0.03 | **stop all T cells** after cell 1 and report drift (the T cells cannot be interpreted). GGUF cells may finish; the report labels the decomposition "not computable" |
| G3 | cell 10 (pilot, Q4-C, open) F1 outside 0.292 ± 0.02 | report the drift; continue. The decomposition uses the E1 re-run values, never a mix with the committed ones |
| SC1 | score capture changes T-cell text | run T cells without capture; P@60 N/A in T cells |
| T1 | kernel wall time reaches 3 h 30 min | stop launching new cells; finish the running ones; report what is missing |
| E | any cell crashes, OOMs or returns < 120 observe results | report it as failed with its log; it is not re-run with different settings without approval |
| R | Kaggle refuses the session or the quota is short | report; no fallback to other hardware |

Every cell writes `MANIFEST-*.json` (adapter / GGUF sha256, command, versions, template id, decoding, timings). Failed
and skipped cells are listed in the report with a reason. Stage 2 (§7) is **not** started by any outcome.

## 7. Out of scope (needs a separate approval)

* **Stage 2:** retrain the 1.7B to split the recipe bundle, e.g. pilot format + r2 data + 3 epochs, or r2 format + the
  826 teacher examples + 2 epochs. About 40 min of training + 15 min of evaluation per arm.
* Any change of E2's design. E1's outcome only informs what is proposed for E2 (`E1-DECISION-MEMO.md`). E2 gets its own
  protocol.
* Test split, model adoption, the contract, production Codeply, PASTE, Pollen.

## 8. Compute (estimates from measured pilot times; reported against actuals)

| Step | Where | Estimate |
|---|---|---|
| Export: merge + F16 + Q4 for r2, r3, pilot; re-export check | Kaggle **CPU** kernel (seed-1 export: 26 min for three models incl. a 4B) | ~30-45 min, no GPU quota |
| Gates (sha, template, SC1) | GPU kernel | ~10 min |
| T cells: 1, 6, 11 (open) and 13, 15 (closed), 1.7B fp16 greedy, batch 1, est. 20-30 tok/s on T4 | GPU0 | ~25-35 min each ⇒ ~2.5 h |
| GGUF cells: 2-5, 7-10, 12 (open), 14, 16 (closed); seed-1 1.7B Q4-C: p50 2.1 s per closed session; F16 ~1.5x slower | GPU1 | ~5-10 min each ⇒ ~1.5 h |
| X1, X2 | GPU1 | ~10 min |
| **Kernel wall time** | | **~2.5-3 h; hard cap 3 h 30 min (T1)** |
| **GPU quota** | | **~2.5-3 session-h** (up to ~6 h if Kaggle bills each T4). Quota resets 21 Nov (30 h). Kaggle queueing (10-20 min seen) is extra |

If the T-cell estimate proves too low after cell 1 (more than 45 min), the run continues under cap T1, and the report
lists which cells did not run. Cells are not shortened (no `--limit`).

## 9. Deliverables

`results/foundation-2026-11/e1/<adapter>-<setup>-<loop>/` (preds, details, results, manifests).
`foundation-2026-11/next-phase/E1-RESULTS.md` (decomposition tables, gates, deviations, failed cells), and
`E1-DECOMPOSITION.json` (the analysis script is committed with it). Committed and pushed. Historical results are not
overwritten.
