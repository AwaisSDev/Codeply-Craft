# PASTE progress

Branch `research/paste-architecture`, base `672696c0` (`codeply-memarch-research`).

## Current phase (2026-11-03)

Phase 5 preparation. Data frozen (test/stress v2), train/val generated. Baselines, evaluator and trainer built
and tested. **Kaggle GPU quota is 0 h until 2026-11-07 (E18)**, so training runs on this container's CPU.

Running: train API wording, budget-bounded (`data/api_chunks.py`; log `~/paste-data/train/api-train.log`;
re-run the same command to resume).

Next actions, in order:

1. D2 pilot on CPU (PASTE and M1c × head_norm off/on; 2,000 train episodes, 1 epoch, seed 1), once the first
   train API chunk exists;
2. learning curve 1,500 / 3,000 / 6,000 for the 3,000-episode fallback;
3. closed-loop scheduled sampling in the trainer; calibration sweep; paired bootstrap;
4. on 2026-11-07, a Kaggle T4 throughput check, then the 3-seed central test.

## Protocol and baseline plan, summary (full text: EVALUATION-PROTOCOL.md, BASELINE-PLAN.md)

* **Central test:** PASTE vs M1c and M1c-m (parameter-matched).
  * Same Ettin-32M encoder, identical heads, losses, data, seeds {1,2,3}, budget, calibration and D2 choice.
  * M1c reads the Brain's records and temporary items as text; PASTE as soft tokens plus recurrent memory tokens.
* **Primary endpoint (PE):** micro-F1 of persistent operations (WRITE, UPDATE, MERGE_INTO, FORGET,
  FORGET_PROFILE, MERGE), in **closed loop**: each system reads the store its own operations built. Gold is
  re-expressed through provenance; a missed fact's later update becomes an expected WRITE. Matching:
  entity + attribute + value token-F1 ≥ 0.5 for writes; target + value for updates; target or pair otherwise.
  Seed-mean of 3 seeds, on frozen test, both wordings of the 600 plans pooled.
* **Co-primary:** false permanent memories (FPM) per 100 segments.
* **Statistics:** 95 % paired bootstrap over test plans (10,000 resamples, both wordings of a plan together),
  Holm over {M1c, M1c-m}.
* **Decision rule:**

  | Outcome | Condition |
  |---|---|
  | **Pass** | Both Holm CIs of PE(PASTE) − PE(baseline) > 0, **and** FPM(PASTE) ≤ 1.10 × FPM(baseline) (one-sided 95 % bound), **and** CPU p50 latency ≤ 1.5 × M1c at K = 32 |
  | Equivalent | Both CIs within ±1 F1 point |
  | Fail | A CI < 0 |
  | Inconclusive | Otherwise |

  M1c+W ≥ PASTE is reported as "a text window recovers the gain".
* **Thresholds:** calibrated on val only: write and merge at cost 3:1, forget 3:1, retrieve and expire max-F1.
* **Secondary metrics** (CIs, exploratory):
  * per-operation P/R/F1 and confusion; merge P/R separately (D1);
  * look-alike wrong-entity rate (H2); temporary-leak rate (H3); continuity by dependency distance 1 / 2-4 (H1);
  * expiry, retrieval and deletion P/R; end-of-episode store F1;
  * latency and RAM at K = 8 / 32 / 128;
  * generalisation (family C, unseen entities/values, Roman Urdu, real-text segments, stress, wording shift).
* **Baselines:** M1c, M1c-m, M1c+W, RMT, KV, FC, rules; existing DtW checkpoints and LFM3 zero-shot
  (optional, labelled).
* **Ablations:** flat addressing (A1), no memory tokens (A2), single pool (A3), no look-alike negatives (A4),
  teacher forcing only (A5), auxiliary losses (A6), 17M scale.
* **Data access:** test and stress are read only by `evaluate.py --final` after a system's checkpoint,
  thresholds and data hashes are committed. Never used for selection, calibration or the D2 choice.

## Resume instructions (a fresh container)

```bash
# 1. code
git clone https://github.com/AwaisSDev/codeply-craft && cd codeply-craft && git checkout research/paste-architecture
cd research/paste
# 2. environment (CPU)
python3 -m venv ~/paste-venv && ~/paste-venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
~/paste-venv/bin/pip install -r requirements.txt anthropic kaggle six
export PASTE_HF_CACHE=~/paste-cache/hf          # Ettin weights download here on first use
# 3. credentials: the owner's env file (never committed); then for API/HF/Kaggle calls:
#    set -a; . <owner env file>; set +a
#    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN   # inside Claude Code sessions, so calls reach api.anthropic.com
# 4. data (private): huggingface-cli download Awais1290/paste-data --repo-type dataset --local-dir ~/paste-data/hf
# 5. tests: ~/paste-venv/bin/python -m pytest tests -q      (expect 27 passed)
# 6. DtW clean real-text rows (read only): clone branch codeply-memarch-research into a worktree and
#    set PASTE_DTW_REAL=<worktree>/research/dtw/data/real
```

## Completed

* 2026-11-01: inspected `main`, `codeply-local-intelligence`,
  `codeply-li-architecture-research`, `codeply-li-dtw-experiment`,
  `codeply-memarch-research`, `dtw-artifacts` and
  `claude/wonderful-feynman-y2ldw2`. Wrote `REPOSITORY-CONTEXT.md`.
* 2026-11-01: owner answered the four open questions (below).
* 2026-11-01, Phase 2: `LITERATURE-REVIEW.md` (synthesis + 4 verified parts),
  `ARCHITECTURE-HYPOTHESES.md` (H0-H9 with recorded priors),
  `ARCHITECTURE-SPEC.md` (v2). Headline: no PASTE mechanism is new; my prior
  for the central test is ~30 %.
* 2026-11-01, Phase 3: CPU prototype (`paste/`), tests T1-T12 + S1 (25/25
  pass), CPU benchmark, `PHASE3-REPORT.md`. Approved by the owner.
* 2026-11-01: spec v2.1 (D1 merges pass the write gate; D2 head_norm pilot flag); 27/27 tests pass.
* 2026-11-02, Phase 4:
  * generator (`data/`), 100-episode pilot (programmatic + Opus 5.5 API, 95/100 valid, **$1.87** of the
    $8 cap);
  * drafts of 1,650 episodes, all valid; leakage 0; PII scan 0;
  * `DATASET-DESIGN.md`, `DATASET-AUDIT.md`, `EVALUATION-PROTOCOL.md`, `BASELINE-PLAN.md`;
  * pilot stored in the private HF dataset `Awais1290/paste-data` (verified private).

## Running jobs

None. At most **2 research agents at a time** (owner instruction). Experiments: `EXPERIMENTS.md`.

Literature history: the first five agents were stopped before producing any
output. Two fresh agents, restarted with the owner's approval, completed the
review and saved it section by section.

## Resume notes from the pause (now written into `ARCHITECTURE-SPEC.md`)

* Exact parameter counts: `tools/param_count.py`.
  * Ettin-32M backbone: PASTE **39.26M**, M1c (same heads) 36.42M,
    M1c-m (parameter-matched) 39.07M.
  * Ettin-17M backbone: PASTE 20.70M, M1c 19.43M.
  * Breakdown: PASTE-specific modules 2.84M (32M) / 1.27M (17M); shared heads
    4.54M / 2.63M.
* Measured CPU latency, encoder only (HF ModernBERT, fp32, 4 threads, this
  container), p50:

  | Tokens | Ettin-32M | Ettin-17M |
  |---|---|---|
  | 128 | 32 ms | 10 ms |
  | 212 | 45 ms | 11.5 ms |
  | 256 | 52 ms | 13.6 ms |
  | 512 | 118 ms | 21.5 ms |
  | 704 | 169 ms | 41 ms |
  | 960 | 196 ms | 85 ms |

  PASTE's input is ~212 tokens per segment (r=4, T=8, E=8, K=32, n=128); M1c's
  is ~704 (records as text); M1c+W's is ~960.
* Design of PASTE v2. **Store:** records arrive from the Brain on each call
  as soft tokens: one profile token per entity, plus attribute and value
  tokens per record. Each soft token is the pooled static embedding plus a
  zero-initialised projection of pooled final-layer states (stop-gradient,
  cached). All prefix tokens share position 0 and attend globally, so the
  encoder treats them as an unordered set.
* **Temporary state:** r=4 recurrent memory tokens, updated by a GRU and
  reset at session boundaries, plus ≤8 explicit temporary items (vector,
  text, type, TTL); expiry is learned plus TTL rules.
* **Units:** a unit is a value-bearing span. The query vector is built from
  [span mean; first token; ±16 window; segment context].
* **Persistent pathway:**
  * a cost-weighted write gate (3:1);
  * a source pointer, where PROMOTE comes from a temporary item;
  * hierarchical profile addressing, P(record) = P(entity) · P(record | entity),
    with NEW-ENTITY and NEW-ATTRIBUTE outcomes;
  * a relation head: same, update, correction, contradiction;
  * FORGET reuses the addressing; RETRIEVE is a per-record head; MERGE is a
    record-pair head.
* **Central test:** M1c with **identical heads**. Only the memory pathway
  differs; M1c's temporary items are text rows.
* **Baselines:** Rules, M1c, M1c-m, M1c+W, FC (full history), KV (late
  fusion), RMT (M1c + memory tokens). Existing DtW checkpoints are evaluated
  zero-shot.
* **Ablations:** flat addressing, no recurrence, single pool, no closed-loop
  training, auxiliary losses (identity contrastive, recall probe), 17M scale.
* **Primary endpoint:** closed-loop persistent-operation micro-F1 on the
  frozen test set. PASTE must beat M1c and M1c-m (paired bootstrap, Holm)
  with false permanent memories no worse than 1.1× and latency ≤1.5×.
  M1c+W is reported as the "text window suffices" check.

## Phase 3 status (2026-11-01)

* Prototype in `paste/` implemented from the spec.
* Exact parameter counts (39,256,598 / 20,699,030).
* **25/25 tests pass** (`results/phase3/test-run.txt`).

First-run failures, all reported:

| Failure | Cause |
|---|---|
| T3 spec tolerance in fp32 | Rounding: fp64 shows exact equivariance |
| T8 precondition | Test design |
| S1 toy episode | Test design |
| T8 history dependence | **Implementation bug** (cached record encodings depended on batch composition), fixed; its own test was seeded |

Design issues documented, **not changed**:

* D1: pair-MERGE bypasses the write gate (I1 vs §5.10);
* D2: large head-input scale saturates the heads at initialisation.

CPU, 32M, 3 units/segment, warm: 30 / 40 / 113 ms per segment at
K = 8 / 32 / 128; peak RSS 482-496 MB.

## Next action

After the owner's decisions:

1. Freeze test and stress (generate, hash into `results/FROZEN.json`, upload privately).
2. Generate train and val with the chosen generator mix (API spend only within the approved budget).
3. Build the loader, the baselines, the trainer and the evaluator (`BASELINE-PLAN.md` §2).
4. CPU and Kaggle throughput smoke runs; then the D2 pilot; then the central test.

## Latest metrics

No trained model. Data pilot: diversity, API vs programmatic: distinct-2 0.43 vs 0.22. Shortcut probe:
a template-trained bag-of-words model scores 0.97 on template text and 0.60 on API wording (majority 0.65);
see `DATASET-AUDIT.md` §5.

## Blockers

Owner decisions (`DATASET-AUDIT.md` §6):

1. generator mix and budget (A ≈ $152, B ≈ $95, C ≈ $37);
2. merge frequency 60 %;
3. no artificial long-range references;
4. approval of `EVALUATION-PROTOCOL.md` and `BASELINE-PLAN.md`, including the compute-budget gap
   (`BASELINE-PLAN.md` §3: the full central test does not fit one week of free T4 at the assumed
   throughput; options are listed).

## Decisions

All owner decisions, assumptions and the decision log are in `DECISIONS.md`.
