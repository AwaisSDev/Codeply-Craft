# Iris 1.7B r4: proposal for review (2026-11-15)

Phase 3 and 4 of the brief. **Nothing here has been run.** No training, no API data generation and no GPU job
starts until you approve this plan, the API budget and the GPU hours (Section 8). Evidence references point to
`AUDIT-REPORT-r4.md` (§ numbers).

## 1. Goal and honest expectation

A fresh fine-tune of Qwen3-1.7B that beats r2 and r3 on closed-loop precision and F1 with the six-op `iris.ops/1`
contract and the deterministic evidence guard unchanged. Realistic: closed-loop strict F1 **0.40-0.48** on val
(r3: 0.333). 0.50 is a stretch. 0.8 is not reachable in this iteration: label agreement between careful annotators
is 0.80 (Opus labels) to 0.93-0.98 (Sonnet labels) under the same strict match (§6).

## 2. What changes, and the evidence for each

| Change | Evidence | Expected effect |
|---|---|---|
| **Fresh runs only, 2 epochs, best checkpoint by val loss on the full val** | val loss flat after ~epoch 1.9; r3 val loss rose after step 100; r3 − r2 not significant (§5.5) | less memorisation, fair comparison |
| **Repair the Opus-labelled train shards** (`tr01-03`) with an independent verifier pass; new files, originals kept | 7 of 40 reviewed sessions had label errors (§6); 0.36 vs 0.48 F1 on Opus- vs Sonnet-labelled val (§5.4) | fewer contradictory targets for value granularity |
| **Spec v2 codifies existing label conventions** (value phrasing for common attributes, storage threshold, when `conflict` applies), derived from the Sonnet shards that already agree with val | 51 % of false memories are the right statement with a different value or entity; 40 % are unlabelled statements (§5.3) | higher add precision; v2 conventions match val labels instead of moving away from them |
| **Contrastive "do not store" negatives drawn from ordinary statements** (trivia, small talk, transient details next to memory-worthy ones), not more joke / hypothetical traps | skip traps are 4 % of false memories; trivia and unlabelled statements are 40 % (§5.3) | precision |
| **Targeted shards for the contract's weak ops:** update / correction / confirm chains over 5-6 sessions, retraction with look-alike negatives, **conflict** examples | conflict has 0 gold examples in train and val; retract precision 0.32 / 0.11; confirm recall 0.21 (§5.1) | update, retract, conflict, confirm |
| **Coverage shards:** Roman Urdu and Urdu script; screen / OCR and email noise; multi-topic sessions with other speakers' facts | Urdu-script 6 of 144 train episodes; screen ~4 % of train, closed F1 0.12; email closed 0.26 (§5.4) | multilingual and source robustness (val slices stay small: descriptive only) |
| **Drills cut from 35 % to 0 %** (10 % as an ablation arm) | I11: drill-heavy model did not transfer; drills have no email / calendar / screen | realism |
| **Self-output stage with corrected targets** (ablation arm, not default) | the real closed-loop gap is updating its own memories: 50 % of 42 linked updates (§5.2); r3's targets re-labelled the model's paraphrased rows as `add` | closed-loop update accuracy |
| **Constrained decoding** as a reported variant for every system | ~10 % of sessions lose ops to schema drops (§5.3) | validity ≥ 0.97 for free |
| **Bigger val, reviewed test, seed replicates, batched eval** | closed F1 CI ±0.057 on 24 episodes; one seed; unreviewed Opus test (§7) | decisions that survive noise |

**Kept unchanged:** `iris.ops/1`, `contract.guard`, `store.derive_ops` (the IrisBench gold rule), every existing
file under `data/raw`, `data/built` and `results`, the r2 / r3 adapters.

## 3. Dataset v2 (all new files)

Layout: `data/raw-v2/{train,val,test}` (new folder; existing shards are copied in byte-for-byte, repaired shards
get new names) built to `data/built-v2/`. The existing `data/raw` and `data/built` stay as they are.

| Split | Content | Episodes |
|---|---|---|
| train | `tr04-06` (Sonnet, unchanged) | 42 |
| | `tr01v-03v`: `tr01-03` after verifier repair (Sonnet verifier proposes corrections against spec v2, a second agent adjudicates, every change logged in `data/review/repair-r4/`) | 42 |
| | `tr07` update / correction / confirm chains, including updates to facts first stated in other words | 14 |
| | `tr08` retractions and cancellations with look-alike negatives; `conflict` (uncertain contradictions) | 14 |
| | `tr09` storage threshold: long chatty sessions, mostly trivia, with implied facts that *are* memory-worthy | 14 |
| | `tr10` Roman Urdu and Urdu script, all source types | 14 |
| | `tr11` screen / OCR text and noisy email (forwards, signatures, newsletters) | 14 |
| | `tr12` multi-topic sessions, other people's facts, attribution | 14 |
| | `syn01` drills: excluded (arm C adds 10 %) | 0 |
| | **Train total** | **168** (~1,650 examples, ~1.4 M tokens per epoch; drill-free) |
| val | `va01`, `va02` (unchanged) + `va03`, `va04` (new Sonnet, blind-reviewed, include conflict, Urdu, screen) | **52** |
| test | see decision D1 (Section 8) | 28 or 42 |

Rules for every new shard: disjoint name pools (existing validator); unique injection texts; invented org and
project names checked against all other splits (extends the build check that missed "Ledgerline" and "Project
Kestrel"); validator-gated authoring with `author_api.py` as in I13 / I14; a 40-session blind review of each new
val shard (accept if agreement F1 ≥ 0.80 and ≤ 10 % error sessions, the existing DATASET.md rule) and a 40-session
sample review of the new train shards. **No test file is read to design any of this.** Every addition is
justified by the contract and val evidence above.

## 4. r4 training configuration

Base recipe (only the data differs from r2, so data effects are measurable):

```
base Qwen/Qwen3-1.7B, fresh LoRA r=32, alpha=64, dropout=0.05, q/k/v/o/gate/up/down
epochs=2, lr=1e-4 (cosine after warm-up, as now), warmup_steps=30, accum=8, max_tokens=2048, weight_decay=0
eval_every=50 on all val-v2 observe + retrieve examples, keep best/ by val loss, seeds 1, 2, 3
data: data/built-v2/train.jsonl (no drills)
```

Arms (one seed each, then the winner gets three):

| Arm | Change from base | Question |
|---|---|---|
| A | none | does data v2 beat the r2 recipe? |
| B | lr 5e-5 | does a lower lr reduce memorisation without losing recall? |
| C | + 10 % drills | do drills help format or hurt transfer? |
| S | stage 2 on the winner: 1 epoch on self-output data (from the winner's epoch-1 checkpoint run on train episodes, targets re-derived with evidence-anchored linking, as in `closed_gap.py`) + 50 % replay, lr 5e-5 | does training on its own stores fix the update weakness? |

## 5. Evaluation (amendment to IrisBench §4, dated, before any r4 run)

* **Systems, same splits, same decoding and batching:** nothing, rules, untrained Qwen3-1.7B (zero-shot, full
  instructions and one example), r2 (seed 1 adapter + the r2 recipe at seeds 2 and 3), r3, r4 (3 seeds). Each in
  open and closed loop, unconstrained and constrained.
* **Primary (unchanged from IrisBench §4):** test, closed loop: extraction F1, false-memory share, end-state F1.
  r4 "beats" a system when the 95 % paired cluster-bootstrap interval (2,000 resamples over episodes) is above 0 for
  both F1s and below 0 for false-memory share.
* **Seeds:** counts pooled over the three seeds per episode before bootstrapping; per-seed values also reported.
* **Success labels (in addition to the rule above):** closed-loop strict F1 ≥ 0.45, false-memory share ≤ 0.50,
  output validity ≥ 0.97 (constrained or not, stated). Update accuracy is reported with its n. It is not a gate
  (20-57 gold updates are too few).
* **Secondary:** precision, recall, wrong-fact share, update accuracy, contradiction resolution, per-op table,
  open loop, evidence-linked closed loop (§5.2), slices by language / source / session index, `va01-e01` excluded
  as a sensitivity check.
* **Test hygiene:** test is run once per frozen system at the end with `--final`. Arms, checkpoints and decoding
  are chosen on val only.

## 6. Experiment plan and decision rules

| Stage | What | Gate to continue |
|---|---|---|
| 0. Engineering (no spend) | batched generation across sessions and episodes; constrained-decoding variant; evidence-linked score and per-op / bootstrap report in `evaluate.py` (new outputs; primary unchanged); `raw-v2` build path; extended name check | unit tests pass; batched r3 on Kaggle reproduces the cached unbatched r3 val metrics within 0.01 (one ~30 min GPU smoke test) |
| 1. Data (API) | repair `tr01-03`; author `tr07-12`, `va03-04`; reviews | validator 0 errors; review thresholds met |
| 2. Baselines + noise floor (GPU) | on val-v2: zero-shot 1.7B, r2, r3; r2 recipe at seeds 2 and 3 | seed spread (max − min closed F1 across the three r2 seeds) is known |
| 3. Arms A, B, C (GPU) | one seed each on val-v2 | an arm replaces A only if it beats A on closed strict F1 by more than the r2 seed spread without raising false-memory share; otherwise A |
| 4. Winner × seeds 2, 3; arm S | | S is kept only if its closed F1 gain over the winner exceeds the seed spread |
| 5. Freeze, then test once | log a freeze row in EXPERIMENTS.md, run every system on test with `--final` | report regardless of outcome |

If r4 does not beat r3 on val after stage 4, the plan stops and reports. No extra arms get added in search of a win.

## 7. Compute and cost

GPU (Kaggle 2 x T4; two runs in parallel per session, one per GPU). Basis: 1.7B trains at ~625 tok/s; data v2 is
~1.4 M tokens per epoch, so about 90 min per 2-epoch run with val checks; batched eval is assumed to be ~3x faster
than the measured ~14 s per session (verified in stage 0).

| Stage | Session hours |
|---|---|
| 0 smoke test | 0.5 |
| 2 baselines + 2 seed runs | ~3.5 |
| 3 arms A-C | ~4 |
| 4 two seeds + arm S | ~2.5 |
| 5 test, all systems | ~2 |
| **Total** | **~12.5 (budget 16 with contingency; ~25 if batching fails)** |

Spread over two quota weeks if needed, scheduled around your PASTE kernels. The PASTE kernels are never stopped or
changed.

API (Sonnet 5.5, validator-gated; measured ~$4.3 per 14-episode shard in I13 / I14):

| Item | Cost |
|---|---|
| repair pass `tr01-03` | ~$8 |
| 6 train shards `tr07-12` | ~$26 |
| 2 val shards `va03-04` | ~$9 |
| test review / new test shard (D1) | $0-9 |
| **Total** | **~$43-52** (a smaller tier drops `tr12` and `va04`: ~$34) |

Blind reviews run as in-session annotator agents, as before (no API spend).

## 8. Decisions needed from you

* **D1. Test set.** Test (`te01`, `te02`) is Opus-authored and was never reviewed; Opus labels showed ~17 % sessions
  with errors. Options: **(a, recommended)** blind-review the test labels now, before any model sees them, and write
  corrections to new files (`te01r`, `te02r`); primary = reviewed test; add one new reviewed Sonnet shard `te03`
  reported separately. (b) keep test as is (primary = original labels, noisier). (c) both (a) and (b), with the
  original labels as primary.
* **D2. API budget:** full tier (~$50) or smaller tier (~$34).
* **D3. GPU:** up to 16 session hours over ~2 weeks. How much quota is left this week after the PASTE runs?
* **D4. Source of "42 / 12 / 28".** Which report showed it? (It matches the Opus-only shard count; no file in this
  repository states it.)
* **D5. Go / no-go** on stage 0 (engineering, free) right away and on stages 1-5 after D1-D3.
