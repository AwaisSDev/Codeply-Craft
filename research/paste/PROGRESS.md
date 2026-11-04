# PASTE progress

Branch `research/paste-architecture`, base `672696c0` (`codeply-memarch-research`).

## Current phase (2026-11-03)

Phase 5 (training) on CPU. Data frozen (test/stress v2, private); train 6,000 (2,824 in API wording) and val 600
generated; API wording finished (**$91.96 of $95 spent; no further API spend**). **Kaggle GPU quota is 0 h until
2026-11-07 (E18)**, so training runs on this container's CPU (4 cores, ~6.5 segments/s).

Status:
* D2 = head_norm on (E24). **PASTE = spec v2.2 (profile rows, PR) adopted (E28):** full-val cross-fitted PE 0.610
  vs 0.389 (v2.1) and **0.688 (M1c)**; PR − M1c = −0.079 [−0.089, −0.068]. One seed, pilot scale, validation.
* Evaluator and training-gold cascade fixes (2026-11-03) are in; all comparisons from E28 on use them.
* Error taxonomy (`tools/error_diag.py`): shared errors (look-alike entities, add-vs-update, API-wording spans);
  PASTE-specific: wrong attribute (soft-token records hide attribute names).
* Central-test tooling ready: `paste.calibrate_full`, `paste.final_eval` (freeze + guarded test access),
  `paste.final_report` (§10.5 outcome), `tools/bench_systems.py`, Kaggle notebooks (smoke, training groups with
  calibration, CPU queues), private Kaggle dataset `paste-trainval` (train + val only). Plan: CENTRAL-TEST-PLAN.md.

Central-test preparation (2026-11-03, 21:10 UTC):
* **Procedure verified end to end (E30, `DRYRUN OK`)** on validation stand-ins: calibrate_full → freeze → commit →
  guarded final_eval (all 7 guard refusals exercised) → bench_systems → final_report, for all four systems.
* **Recipe rules fixed before the results** (DECISIONS 2026-11-03; `tools/choose_recipe.py`, tested;
  `scripts/recipe.sh` gathers every finished run). Groups from the recipe: `tools/make_groups.py` (tested).
* Recipe fields still pending on validation runs (CENTRAL-TEST-PLAN §2): variant, δ, LR per family, 3,000-fallback
  permission. Precision (AMP) waits on the T4 smoke test (GPU quota 0 h until 2026-11-07 00:00 UTC).

Results in (2026-11-04 00:50 UTC; validation, cross-fitted, one seed):
* **PASTE LR 1e-4: 0.695** vs 0.610 at 5e-5 (+0.086 [0.076, 0.095]); rule → PASTE LR 1e-4 (provisional until δ).
* **PASTE learning curve: 0.569 (1,500) → 0.610 (2,000) → 0.732 (3,000)**: still improving steeply.
* V1-PASTE −0.005 [−0.012, 0.002], V2-PASTE +0.018 [0.009, 0.027] vs V0 (variant decision needs M1c + S2).
* Kaggle CPU ≈ 3.0 segments/s (local 5.6); 6,000-episode run ≈ 5.3 h.
* **M1c LR 1e-4: 0.759** (+0.071 over 5e-5) → both families LR 1e-4 (provisional until δ).
* **Equal budgets, PASTE − M1c:** 1,500 −0.050; 2,000 −0.079; **3,000 −0.025 [−0.036, −0.015], FPM equal**;
  2,000 at LR 1e-4 −0.064. PASTE gains faster with data (+0.123 vs +0.069 from 2,000 to 3,000) but is below M1c
  at every measured budget.

Running on Kaggle CPU (5 at once; stateless check-ins `scripts/kaggle/sched_all.sh`): lc-paste-b, lc-m1c-b,
lc-paste-c (since 00:48), lc-m1c-c, var-v2-m1c (since 01:58). Not yet pushed: var-v1-m1c, var-v3-paste, var-v3-m1c,
var-v4-paste, var-v4-m1c, var-s2-paste. ETA all recipe runs ≈ 10:00-12:00 UTC 2026-11-04.

Next actions, in order:
1. When all runs are in: `scripts/recipe.sh results/recipe.json`; record the decisions (DECISIONS, plan §2,
   EXPERIMENTS: variants, LR, learning curve incl. "still improving?"); commit.
2. 2026-11-07 after 00:00 UTC: `kaggle quota`; T4 smoke (`paste-smoke`); precision rule; budget; `tools/make_groups.py`
   → `make_notebooks.py --runs groups.json --device cuda` at the then-current commit; push seed-1 groups first.
3. Download, freeze (`paste.final_eval --freeze`), commit FROZEN-RUNS.json, final_eval on test here, bench_systems,
   final_report (CENTRAL-TEST-PLAN §3).

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
# 5. tests: ~/paste-venv/bin/python -m pytest tests -q      (expect 39 passed)
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

* **Here (CPU):** `~/paste-runs/chain1.sh` (log `~/paste-runs/chain1.log`): full-val sweeps (θ_W 0.8/0.9/0.95/0.98) of
  E27 PASTE-PR, E24 PASTE-hnon, E24 M1c-hnon with the fixed evaluator, then `scripts/queue.sh` on
  `~/paste-runs/q/queue.txt`: training variants V1 (closed loop, per episode), V2 (per segment), V3 (record
  corruption), V4 (profile drop) for PASTE-PR and M1c, then S2-PASTE (seed noise). Resumable: rerun the chain.
* **Kaggle CPU (private kernels, free):** `paste-lc-paste-a`, `paste-lc-m1c-a` (learning curve 1,500 / 3,000),
  `paste-lr-paste`, `paste-lr-m1c` (encoder LR 3e-5 / 1e-4). Outputs: `kaggle kernels output awaissididique/<slug>`
  (runs.tgz). Queues in `scripts/kaggle/queues/`. Still to push: lc-*-b (6,000) and lc-*-c (3,000 x 2).
* At most 2 research agents at a time (owner instruction).

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

See *Current phase* above.

## Latest metrics

Validation only; never test.

| Run | Setup | val PE | Notes |
|---|---|---|---|
| E21 | PASTE, head_norm off, 125 steps | 0.0 | undertrained |
| E22 | PASTE, head_norm off, 300 steps | 0.0016 | heads at chance |
| E23 | PASTE, head_norm on, 300 steps | **0.1315** | 50 val episodes; component metrics in EXPERIMENTS.md |

Data pilot: API vs programmatic distinct-2 0.43 vs 0.22; the shortcut probe does not transfer (DATASET-AUDIT §5).

## Blockers

None. Owner gates that remain: paid compute, API spend beyond $95, merging to main, changes to the frozen
protocol or test data.

## Decisions

All owner decisions, assumptions and the decision log are in `DECISIONS.md`.
