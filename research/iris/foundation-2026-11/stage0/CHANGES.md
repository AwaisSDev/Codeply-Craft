# Stage 0 (no-cost): what changed, how it was verified (2026-11-19)

Scope approved by the owner: fix the evaluation pipeline including model-specific chat templates, audit the metric
that penalises correct paraphrases, manually inspect false memories, verify the code against known examples and
existing results, and document everything. **No candidate model was evaluated, nothing was trained, the test
split was not read.** The only model generations were: 10 parity sessions and one short template probe per wave-A
model (Qwen3-0.6B / 1.7B, Qwen3.5-2B, Gemma 4 E2B, Qwen3-4B-2507), plus a one-episode smoke run (§4). None of these
are scored as results.

## 1. Code changes (all additive; defaults reproduce earlier behaviour exactly)

| File | Change | Why |
|---|---|---|
| `codeply_iris/infer.py` | `ChatServerBackend`: llama-server `/v1/chat/completions` with the GGUF's own chat template (`--jinja`), `chat_template_kwargs`, top-level `json_schema`, greedy (temperature 0, top-k 1, seed 0), no prompt cache, per-token log-probabilities; `apply_template()` returns the exact prompt the server builds. `split_think()` removes a leading `<think>…</think>` block (unclosed block = empty answer). `ServerBackend._server_cmd()` factored out; `Iris.load(chat=True, …)`; `Iris.observe_raw/retrieve_raw` use the chat path when the backend has one. | The raw path hard-codes Qwen's ChatML and `<|im_end|>`, which is wrong for Gemma, Granite, Mistral and LFM. |
| | `--reasoning-format auto` (not `none`) | **llama.cpp bug found here** (commit `7a4117e`): with `none`, thinking off and any JSON Schema, the grammar sampler fails to initialise (HTTP 400 "Failed to initialize samplers"). With `auto` the server returns reasoning separately in `reasoning_content`; it is stored and measured (`think_chars`), never parsed. `response_format` also fails in the chat endpoint on this build; the top-level `json_schema` field works. |
| `codeply_iris/prompt.py` | `ZERO_SHOT_SYSTEM_V11` (v1 + one sentence on quoting without the `[n]` number or speaker name) and `ZERO_SHOT_PROMPTS = {"v1", "v1.1"}`. v1 unchanged (sha256 `655639bc…` pinned in a test). | EVAL-PLAN §4. |
| `codeply_iris/evaluate.py` | flags `--chat`, `--template-kwargs`, `--prompt-version` (default v1), `--no-logprobs`, `--server-arg`, `--max-new-tokens`; a `MANIFEST-<split>-<loop>.json` per run (args, code commit, data sha256, GGUF sha256, system-prompt sha256, llama-server version); cached answers parsed from `answer` when present, else `raw` (old caches have no `answer`). | reproducibility; chat path. |
| `codeply_iris/confidence.py` (new) | op-level score = mean token log-prob over the op's value tokens; `precision_at_k`, `risk_coverage`, `f_beta`. | EVAL-PLAN §5 primary metrics P@60 and F0.5. |
| `foundation-2026-11/report_run.py` (new) | per-system foundation report from cached generations: primary metrics, strict metrics (unchanged code), per-op, taxonomy, quote patterns, think leaks, latency, slices; `--exclude-episode` for the va01-e01 sensitivity run. | |
| | taxonomy fixes against `failure_analysis.py`: a stored skip trap is detected when quotes overlap ≥ 0.3, one contains the other, or their character spans overlap in the message; "same statement as a gold confirm / retract" is its own category. | inspection found a planted injection filed as "unlabelled" (quote continued the teacher's) and a duplicate filed as "unlabelled". |
| `tests/test_foundation.py` (new) | 26 tests, below. | |

Not changed: `contract.py` (iris.ops/1, guard), `store.py` (`derive_ops`), `metrics.py` (strict matcher), `build.py`,
any data, any committed result, `audit-r4/`, production, PASTE, Pollen.

## 2. Verification

| Check | Result |
|---|---|
| Existing unit tests (`tests/test_core.py`) | 11 / 11 pass |
| **Committed results reproduce through the modified evaluator** (open + closed loop, from cached generations, every metric compared): 1.7B r2, 1.7B r3, 0.6B r2, 0.6B r3, rules, nothing | **12 / 12 identical** |
| The regression test can fail | replacing one cached generation of 1.7B r3 with `{"ops":[]}` moves open F1 0.4195 → 0.4151 |
| Known matcher behaviour (hand-built cases from the inspection) | exact match counts; a paraphrase below token-F1 0.5 is one false memory **and** one miss (near_value-03); right value + other entity is "misattributed", not correct (entity-14); a shared date alone can value-match an invented fact (entity-12); a restatement of a stored memory is a duplicate, not false |
| Prompt v1 unchanged; v1.1 adds exactly one line | pass |
| Chat request body (greedy, uncached, schema, template kwargs, logprobs) | pass |
| `split_think`, `op_scores` (repeated values map in order), P@k (under-covering returns None), F0.5 | pass |
| `report_run.py` on a copy of 1.7B r3 | strict P / R / F1 / false-memory share equal the committed results, open and closed |
| **Parity, Qwen3-0.6B Q4_K_M, 10 val sessions, prompt v1, constrained**: raw ChatML path (every earlier zero-shot result) vs chat path | rendered prompt **identical 10 / 10**; parsed JSON and ops **identical 10 / 10**; output text identical 9 / 10 (one differs by a space inside the JSON: `}] }` vs `}]}`); log-prob tokens reproduce the answer 10 / 10 once the trailing whitespace the server trims is ignored (`parity.json`) |
| llama-bench, wave A (`bench.json`, `bench/`) | all five load and run in the pinned llama.cpp; speeds in EVAL-PLAN amendment A1 |
| Chat templates, wave A (`templates.json`) | for all five, the system and user text appear verbatim in the server's prompt; thinking is off (Qwen3 / Qwen3.5: empty think block in the prompt; Gemma 4: native system turn, no thinking; Qwen3-4B-2507: none); the first unconstrained tokens are bare JSON (no markdown fences) |

## 3. Metric audit and manual inspection (details: `metric_audit.json`, `inspect_labels.json`)

Sample: 78 of the 177 false memories of Iris 1.7B r3 (open loop), stratified by category, seed 20261119, every item
read with the cited message and all gold ops on it. Single annotator (Claude, this session), not blind to the model
output: treat the shares as estimates with wide intervals.

| What the "false memories" really are (exploratory estimate from 78 sampled, scaled to all 177) | Est. | Share |
|---|---|---|
| Wrong: invented, misread (study topics as personal facts, questions as facts, ignored self-corrections, inverted relations, wrong dates), misattributed | 80 | **45 %** |
| Correct, the same fact as a gold op, penalised by the matcher (entity naming 16 of 20 sampled "wrong-entity" items; paraphrases below token-F1 0.5; number words) | 40 | **23 %** |
| True but not worth storing (boilerplate, transient requests) | 33 | 19 % |
| Correct, memory-worthy, missing from the labels | 8 | 4 % |
| Partly right | 7 | 4 % |
| Stored a skip trap | 6 | 4 % |
| Should have confirmed a stored memory | 3 | 2 % |

Consequences:
* **Label omissions are small (≈ 4 %)**, not the 25-30 % the r4 audit estimated from a smaller sample. The
  "unlabelled statement" bucket is mostly genuine model error (13 of 25 sampled) and trivia (8 of 25).
* **The strict matcher understates 1.7B r3**: crediting the estimated 40 penalised correct facts gives open-loop
  precision ≈ 0.55 (strict 0.433) and recall ≈ 0.52 (strict 0.407). This is a calibration note, not a metric.
* **Relaxed matchers are not reliable judges** (agreement with the manual verdicts on the sample):
  `entity_relaxed` precision 0.65 / recall 0.81; `evidence_anchored` precision 0.51 / recall 1.00. Rescored open F1
  of 1.7B r3: strict 0.42, entity-relaxed 0.53, evidence-anchored 0.66. Neither replaces the strict metric; the
  entity-relaxed score is reported as a diagnostic with its measured judge precision.
* **Closed loop:** the r4 audit's "≈ 45 % of the open/closed gap is the metric" used evidence-anchored linking, which
  links a wrong or different fact about half the time here. That figure is an **upper bound**; with ~51 % of links
  being true paraphrases, the metric's share of the gap is roughly a quarter (rough estimate).
* **The strict trap metric (`hard_negative_stored`) has the same blind spot as the old taxonomy** for a quote that
  continues the labelled skip quote. Unchanged (pre-registered); the foundation report counts it separately.
* Entity naming is the largest single metric penalty. It is a **label-convention** problem ("user / father's health"
  vs the father's name; "Car fund" vs "user / car savings goal"), so it penalises every foundation equally and does not
  bias the foundation comparison. It matters for r4 data (spec v2 naming conventions).

## 4. One-episode smoke runs of the full pipeline

`python -m codeply_iris.evaluate --system zeroshot --chat --template-kwargs '{"enable_thinking": false}'
--prompt-version v1.1 --constrain --limit 1 --split val` (first val episode, 5 sessions), then `report_run.py --k 5`.
Output went to the scratchpad, not to `results/`. **These are pipeline checks, not results**, and are not used for
any decision.

| Check | Qwen3-0.6B (open + closed) | Gemma 4 E2B (open) |
|---|---|---|
| runs end to end through `evaluate.py` (cache, guard, scoring, result file) | yes | yes |
| manifest written (code commit, data sha256, GGUF sha256, prompt sha256, llama.cpp version) | yes | yes |
| reasoning text in answers | none | none |
| markdown-fenced JSON | none | none |
| op scores from log-probabilities, P@k / risk-coverage computed | yes (closed) | yes |
| p50 seconds per session (estimate from llama-bench) | 11.9 (10) | 17.4 (21) |

Seen in passing: on this one episode, Qwen3-0.6B with prompt v1.1 still put the speaker label in 17 rejected quotes.
Whether v1.1 helps at all is exactly what the planned v1 / v1.1 comparison measures.

The manifest records `+dirty` when the working tree has uncommitted changes. Wave A must run from a clean commit.
