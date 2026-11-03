# PASTE decisions

Every architectural, data and protocol decision, with its rationale and who made it. Owner decisions are
binding; mine are reversible unless marked otherwise. Moved out of `PROGRESS.md` on 2026-11-02 so the progress
log stays short.

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

## Owner decisions (2026-11-01, third round: after Phase 3)

| # | Decision |
|---|---|
| D1 | Record-pair MERGE needs its own threshold **and** the main write gate; 3:1 cost; merge P/R reported separately. Implemented as spec v2.1 §5.10 (a licensing gated PERSIST unit on one of the pair's profiles); tested (`test_t05_merge_needs_licensing_gated_unit`) |
| D2 | Pilot both raw and normalised head inputs (`head_norm`) for PASTE and M1c under identical conditions; select on validation; document before the main experiment |
| Phase 4 | Approved: generator + ~100-episode API pilot; estimate API cost before spending; ask before exceeding the approved budget; licensing and privacy rules unchanged |
| Kaggle | Not yet: first the dataset audit, episode statistics, evaluation protocol and baseline plan go to the owner for approval |
| API pilot model | Opus 5.5 only (owner's choice, 2026-11-02). A hard cap is enforced in code via worst-case arithmetic ($7.80 cap, $7.67 worst case); actual spend $1.87 |

## Decision log

| Date | Decision | Reversible | Why |
|---|---|---|---|
| 2026-11-01 | Base on `codeply-memarch-research` @ `672696c0` | yes | Holds the PASTE v1 spec, critique, harness and Brain code; DTW frozen data is identical to the DTW tip |
| 2026-11-01 | All PASTE files under `research/paste/`; checkpoints in private storage (A4), not in git | yes | Isolation from DTW and production; owner decision 4 |
| 2026-11-01 | No WildChat-derived rows for training, selection or evaluation | yes (if the audit clears it) | Licence, privacy and moderation unresolved; owner decision 1 |
| 2026-11-01 | Pretrained Ettin-32M backbone (MIT); no scratch training | yes | ~5K-50K examples cannot teach language |
| 2026-11-01 | M1c with shared heads is the central test (A1-A3) | no (owner decision 5) | Owner mandate; isolates the memory pathway |
| 2026-11-01 | D1: a record-pair MERGE needs its own threshold and a gated PERSIST unit on the pair's profile | owner | Phase 3 T5 showed merges bypassing the write gate |
| 2026-11-01 | D2: head_norm is a pre-registered pilot choice, selected on validation | owner | Saturated heads at initialisation (Phase 3) |
| 2026-11-02 | Pilot wording: Opus 5.5 only; hard cost cap in code | owner | $1.87 spent of $8 |
| 2026-11-02 | **Option B** generator mix: train 3,000 API + 3,000 programmatic; val, test and stress in API wording (test and stress also programmatic) | owner | Shortcut probe: template cues do not transfer (DATASET-AUDIT §5) |
| 2026-11-02 | Merge scenarios in 60 % of episodes | owner | More than 100 test merges for separate merge P/R; draft check: 108 per 300 test episodes |
| 2026-11-02 | 3,000-episode training fallback, if a validation learning curve supports it | owner | Compute budget (BASELINE-PLAN §3) |
| 2026-11-02 | No paid compute; measure training speed and check Kaggle quota first | owner | |
| 2026-11-02 | Autonomy: routine research and engineering decisions are mine; owner gates are paid compute, production, merging to main, and changes to the frozen protocol/test data | owner | Instruction of 2026-11-02 |
| 2026-11-02 | One embedding lookup per step (efficiency refactor; values unchanged) | me | Backward was 87 % of step time: one dense 19M-element embedding gradient per record lookup. 1,123 → 288 ms per segment on CPU; tests unchanged |
| 2026-11-02 | **Freeze test and stress data now**, before the owner signs off the protocol text | me | Freezing the *data* (seeded generation, hashing, private storage) is protocol-independent, and freezing earlier can only reduce the risk of contamination. The metrics and decision rules stay as written in EVALUATION-PROTOCOL.md until the owner approves or amends them; no model sees test data either way |
| 2026-11-02 | Frozen seeds: test 20261102, stress 20261103 (plans). Programmatic wording seeded from the episode id; API wording is Opus 5.5 at medium effort, batch, max 7,000 output tokens | me | Recorded before generation |
| 2026-11-03 | Option B split of train: plans 0-2,999 in API wording, plans 3,000-5,999 in programmatic wording (distinct plans; no plan in both) | me | Owner approved "3,000 API + 3,000 programmatic"; distinct plans avoid duplicate supervision |
| 2026-11-03 | Validation primary metric pooled over both wordings of the 600 val plans (as test pools both wordings of the 600 test plans) | me | Selection metric and test metric then match (EVALUATION-PROTOCOL §7) |
| 2026-11-03 | Remaining API batches: output ceiling 5,000 tokens; train submitted in chunks so every chunk's worst case fits the ledger | me | $68.23 left of $95; measured mean output ~1,180 tokens per episode |
| 2026-11-03 | Until the Kaggle GPU quota refreshes (2026-11-07), train on this container's CPU: first the pre-registered D2 pilot (reduced scale), then the 3,000 vs 6,000 learning curve. No paid compute, no TPU port | me | Quota is 0 h (E18); CPU throughput 288 ms per segment (E11) makes 18k-segment pilot runs feasible (~1.5-3 h each) |
| 2026-11-03 | D2 pilot and learning curve use teacher-forced training (identical across variants); closed-loop scheduled sampling (spec §6.3) is added before the 3-seed main runs | me | Both arms of each comparison are trained identically, so the head-input choice is not confounded; closed-loop training is also ablation A5, so its effect is measured separately |
| 2026-11-03 | Train API wording is budget-bound: chunks sized so each worst case fits the ledger; stop when less than 50 fit. Plans without valid API wording use their programmatic wording (same labels). No retries for train or val (val: 572/600 valid) | me | $56.90 left vs ~$57 expected for 3,000; the owner's $95 cap is binding |
| 2026-11-03 | **E21 D2 pilot declared uninformative and stopped after arm 1** (val PE 0.0 at 125 optimizer steps). It is recorded as failed, not deleted; no D2 choice is drawn from it | me | 2,000 episodes at accum 16 gave too few updates for heads trained from scratch; loss still falling; a 0.0-vs-0.0 comparison cannot select a variant |
| 2026-11-03 | Trainer options added, default behaviour unchanged: `--bio-weight` (B/I class weight in the BIO cross-entropies, O = 1) and `--warmup`; per-term loss means logged every checkpoint | me | E21 tagger predicted O for 93 % of B tokens; class-weighted token tagging is standard for sparse spans. Any value chosen is applied identically to PASTE and every baseline, so fairness is unaffected. Chosen on train/val only (E22 onwards) |
