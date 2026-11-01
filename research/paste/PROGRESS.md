# PASTE progress

Branch `research/paste-architecture`, base `672696c0` (`codeply-memarch-research`).

## Current phase

Phase 3 (CPU prototype + unit tests T1-T12): **done**. See `PHASE3-REPORT.md`.
Waiting for owner decisions D1 (MERGE vs invariant I1) and D2 (head-input
scale) before Phase 5 training. Phase 4 (dataset) is not started; it waits
for the owner's go-ahead.

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
  pass), CPU benchmark, `PHASE3-REPORT.md`.

## Running jobs

None. (The owner paused once on 2026-11-01 for a usage limit; work resumed.) At most **2
research agents at a time** from now on (owner instruction).

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

1. Owner decisions D1 and D2.
2. Phase 4 dataset generator: programmatic first, then the API pilot
   (≤ ~100 episodes; cost estimate before any further spend).
3. Baselines (M1c, M1c-m, M1c+W, RMT, KV) and the closed-loop trainer,
   before any training run.

## Latest metrics

No trained model. Phase 3 measurements: see `PHASE3-REPORT.md` §2 and §5 (untrained weights; latency and memory only).

## Blockers

* Owner decisions D1 and D2 (`PHASE3-REPORT.md` §3 and §7). They block
  Phase 5 training, not Phase 4.
* Expensive training stays blocked by rule until the sequential dataset and
  the evaluation protocol are validated (owner decision 5).

## Owner decisions (2026-11-01, second round)

| # | Decision | What it permits | What it forbids |
|---|---|---|---|
| 1 | **Sequential data approved.** The earlier "Track B: not now" restriction is overridden for synthetic and properly licensed sequential data | Multi-segment and multi-session examples | Linking WildChat users; any WildChat-derived data. Temporary state and persistent Brain memory must stay separate |
| 2 | **Data budget: pilot first** | A small API-generated conversation pilot | Any API spend beyond the pilot before the owner has seen a cost estimate. API data must be **compared** with programmatic generation for diversity and quality, not assumed better |
| 3 | **Kaggle approved** | Up to one week of available **free** T4 quota | Paid compute or unexpected spending without asking. Checkpoints saved; jobs resumable |
| 4 | **Private data and checkpoints** | Code and research documents in the public repo | Generated datasets and checkpoints in public places; publishing real conversational data or potentially sensitive artifacts. Dataset licences verified before use |
| 5 | **Central scientific test**: PASTE against the same encoder run chunk by chunk with Brain memories fed forward (M1c) | | Treating M1c as an optional baseline. No expensive training before the sequential dataset and evaluation protocol are validated |

## Assumptions (reversible; recorded so they can be challenged)

| # | Assumption | Why | How to undo |
|---|---|---|---|
| A1 | "Brain memories fed forward" for M1c means **every Brain row the store would return for the conversation**, persistent and temporary (`status: temporary`, the Brain's `context` rows with expiry), rendered as text, up to the same capacity K that PASTE receives | Production Brain keeps temporary rows with `expiresAt`; omitting them would handicap the baseline | Re-run M1c with persistent rows only (reported as a variant) |
| A2 | M1c uses **the same heads, losses, data, seeds, step budget and calibration** as PASTE; only the memory pathway differs | Otherwise a PASTE win could come from heads that could be added to M1c | n/a (design rule) |
| A3 | M1c is also run parameter-matched (extra capacity until its count equals PASTE's) and with a raw-text window of the previous segments (M1c+W); the strongest of the three is the bar | The baseline gets the benefit of the doubt | Report each separately (always done) |
| A4 | "Private" storage = private Hugging Face repos (dataset and model) under the owner's account, plus private Kaggle datasets for training input; the public repo holds only code, documents, configs, manifests and SHA-256 hashes | HF token and Kaggle credentials were provided; both support private storage | Owner names another location |
| A5 | API pilot size: at most ~100 generated episodes, with the token count measured and costed before anything larger | "Small pilot" | Owner sets another size |
| A6 | Free Kaggle quota is treated as ~30 GPU-hours per week; the exact remaining quota is read from Kaggle before launching | Kaggle's stated weekly limit; not yet verified for this account | Correct once read from the account |
| A7 | No real conversational text enters generated datasets except rows from licence-verified sources (MultiWOZ MIT, Topical-Chat CDLA-Sharing-1.0, UCI Roman Urdu CC BY 4.0, plus sources the review verifies) | Owner decision 4 | Owner approves more sources |

## Decision log

| Date | Decision | Reversible | Why |
|---|---|---|---|
| 2026-11-01 | Base on `codeply-memarch-research` @ `672696c0` | yes | Holds the PASTE v1 spec, critique, harness and Brain code; DTW frozen data is identical to the DTW tip |
| 2026-11-01 | All PASTE files under `research/paste/`; checkpoints in private storage (A4), not in git | yes | Isolation from DTW and production; owner decision 4 |
| 2026-11-01 | No WildChat-derived rows for training, selection or evaluation | yes (if the audit clears it) | Licence, privacy and moderation unresolved; owner decision 1 |
| 2026-11-01 | Pretrained Ettin-32M backbone (MIT); no scratch training | yes | ~5K-50K examples cannot teach language |
| 2026-11-01 | M1c with shared heads is the central test (A1-A3) | no (owner decision 5) | Owner mandate; isolates the memory pathway |
