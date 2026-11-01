# PASTE Phase 3: CPU prototype and unit tests

Date 2026-11-01. Branch `research/paste-architecture`. Status: **prototype built from
`ARCHITECTURE-SPEC.md`; T1-T12 pass. Nothing has been trained beyond a
four-segment toy episode.** No dataset generation, API call or Kaggle job was
made in this phase.

Everything here establishes that the architecture **runs as specified**. It
says nothing about whether PASTE is accurate: the heads are untrained.

## 1. What was built (all under `research/paste/`)

| File | Implements (spec section) |
|---|---|
| `paste/modernbert.py` | ModernBERT encoder reimplemented to control positions and masks; loads Ettin weights unchanged (§4.4-4.5) |
| `paste/model.py` | Memory pathway (§4.1-4.3); prefix assembly, shared position 0, global prefix tokens (§4.4); batched encoder pass; deterministic decision procedure (§5.13); GRU transitions (§5.11-5.12) |
| `paste/heads.py` | All shared heads (§5.1-5.11): unit query, classification, write gate, source/PROMOTE pointer, hierarchical profile addressing, relation, mention pointer, temporary addressing, RETRIEVE, record-pair MERGE, expiry |
| `paste/losses.py` | Core losses (§6.1), with the cost-weighted gate loss (3:1); auxiliary L_idc and L_rec (off by default); a teacher-forced episode runner with truncated BPTT (§6.2) |
| `paste/brain_sim.py` | Deterministic Brain simulator mirroring `brain.js` `observe` (§10.1), with provenance |
| `paste/adapter.py` | Experimental adapter (§11): pure step function, session reset, deterministic expiry, capacity, JSON + base64 serialisation |
| `paste/text.py` | Tokenisation with offsets, field-token selection, time buckets, UNTIL resolver |
| `tests/` | T1-T12 + S1 (training sanity) |
| `tools/param_count.py`, `tools/bench_cpu.py` | Spec parameter counts; CPU latency/memory benchmark |

**Not built in this phase.** These are later phases by plan; none of them is
needed for T1-T12:

* the M1c / M1c-m / M1c+W / RMT / KV / FC baselines;
* the closed-loop scheduled-sampling trainer (§6.3);
* calibration (§6.6);
* the dataset loader and the evaluation harness.

The baselines are built before any training run, because the central test
needs them trained under identical conditions.

## 2. Test results

**Final full run:** `results/phase3/test-run.txt`, **25 passed, 0 failed**, in 64 s.

Environment: Python 3.13.18, torch 2.15.0+cpu, transformers 5.22.1,
tokenizers 0.23.3, 4 threads, base commit `2ba15d7b`.

**Reproduce:**

```bash
cd research/paste
pip install torch --index-url https://download.pytorch.org/whl/cpu && pip install -r requirements.txt
PASTE_HF_CACHE=~/.cache/paste-hf python -m pytest tests -v -s
```

The first run downloads Ettin-17M and Ettin-32M from Hugging Face; both are
public and MIT-licensed.

| Test | Result | Measured |
|---|---|---|
| **T1** encoder = HF ModernBertModel | PASS (32M, 17M) | Against HF-SDPA: **0.0** max abs diff at lengths 7, 64, 65, 150 and 300 (with padding). Against HF-eager: equal to HF's own eager-vs-SDPA gap (32M ≤ 8.9e-4, 17M ≤ 3.7e-5). Window ±1 changes outputs by 2-5, so the window semantics are confirmed |
| **T2** masked prefix = encoder | PASS | 4.6e-5 against the plain encoder (max \|h\| 114); prefix-content change under mask: **0.0** (bitwise) |
| **T3** permutation equivariance | PASS, **after a tolerance clarification (C3)** | fp64: ≤ 6.7e-14 on every output. fp32: decision outputs ≤ 1.9e-6; hidden states ≤ 1.5e-5 |
| **T4** addressing | PASS (4 cases) | Joint distribution sums to 1 (logsumexp 0.0); factorisation exact (0.0); empty store, user-only store and a profile without user records all give a valid Ω with NEW-ENTITY |
| **T5** separation | PASS (4 cases) | Gate closed: **0** WRITE/UPDATE/MERGE_INTO/PROMOTE, but **15 MERGE proposals** (see D1). Gate open: 5 PROMOTEs, and every temp-sourced write came with a PROMOTE. Session change resets h and drops SESSION items; UNTIL and 14-day expiry work |
| **T6** write gate | PASS (2) | g = 0.49: 0 persistent proposals; g = 0.50: 45. Loss gradient on the false-positive side = **3.0000×** plain BCE |
| **T7** contradiction | PASS (2) | SAME → MERGE_INTO; UPDATE / CORRECTION → UPDATE; CONTRADICTION → UPDATE(challenge). Simulator: challenged, then replaced on the 2nd challenge |
| **T8** serialisation | PASS, **after two test fixes** | Exact round trip of the state (1 item + h, 10.5 KB JSON); next step identical from either copy; identical whether run alone or in the suite |
| **T9** determinism | PASS, **after an implementation fix** | Two fresh models, and a warm-cache rerun, give identical outputs over 6 segments. Added test: a record's cached encoding is bitwise independent of what it is encoded with, and outputs with a cold cache equal outputs with a cache warmed in a different order |
| **T10** checkpoint/restore | PASS | 6 segments uninterrupted = 3 + JSON checkpoint + 3 in a fresh model (identical) |
| **T11** parameter counts | PASS (32M, 17M) | **39,256,598 / 20,699,030**: exactly the spec. Encoder 31,883,136; heads 4,535,702; memory pathway 2,837,760 |
| **T12** Brain simulator | PASS | added, ignored (jokes, hypotheticals, quotes, secrets), reinforced, confirmed, replaced, challenged, kept (locked), merged, forgotten, evicted |
| S1 training sanity (extra) | PASS, **after a test fix** | Toy episode loss 149 → 5.2 in 42 steps (two unclipped steps, then clip 1.0; criterion < 0.2 × initial). Every module receives gradient. 1.2 s per 4-segment training step on CPU |

### 2.1 Failures on the way, and what was done about each

| Test | First-run failure | Cause | Action |
|---|---|---|---|
| T1 (exploratory check, before the test file) | 1.1e-3 > 1e-4 against HF | Not a bug: HF's own eager path differs from HF-SDPA by the same amount (eager softmax in float32; hidden values up to ~41). Our encoder equals HF-SDPA bitwise | Clarification C1 |
| T3 | max 1.53e-5 > spec's 1e-5 (fp32) | Float32 summation order. The same test in float64 gives ≤ 6.7e-14, so the architecture is exactly equivariant | Clarification C3: the property is tested in fp64 (1e-10); fp32 decision outputs keep the 1e-5 limit; hidden states use 1e-6 × max\|h\|. **The literal spec check fails in fp32; this is reported, not hidden** |
| T8 | "needs a non-empty temporary state" | The untrained model created no temporary items, so the round trip was not exercised | Test now starts from a state seeded with 3 items and a non-zero h |
| S1 | GRU_T gradient 0 after step 1 | The toy episode updated an item in its **last** segment, so GRU_T's output never reached a loss | A 4th segment that reads and closes the item was added; GRU_T then gets gradient (8.9e-2) |
| T8 / T9 (**implementation bug**) | The first full-suite run gave T8 a different number of temporary items (1) than running its file alone (2) | Cached contextual record states were computed in padded batches, and differed by up to 4.6e-5 depending on which texts shared a batch. Decisions therefore depended on cache history, which violates I4 | `_ctx` now encodes each cache miss alone at its exact length. New T9 test covers batch composition and cache warm-up order. Cost: slower cold path (§5) |
| T8 (test bug) | After the fix, still 1 vs 2 | T8 seeded h with the **global** RNG, whose state depends on earlier tests | Seeded generator; alone and in the suite now agree (1 item, 10,514 bytes) |

## 3. Design issues found (documented; **design not changed**)

### D1. MERGE (record pairs) bypasses the write gate: invariant I1 contradicts §5.10

I1 says persistent proposals come only from the write gate or FORGET. §5.10
gives record-pair MERGE its own head and threshold θ_M. T5 shows the
consequence: with the gate forced shut, the untrained model still proposed
15 merges over 5 segments. A merge deletes one record and folds its evidence
into the other, so a wrong merge is a false persistent change.

| Option | Effect |
|---|---|
| (a) Amend I1's wording: MERGE is a persistent proposal with its own threshold, calibrated at the same 3:1 cost as θ_W | No behaviour change; keeps the head; makes the invariant true |
| (b) Allow MERGE only when the segment also has a PERSIST unit (gate ≥ θ_W) addressed to one of the two records | Ties consolidation to explicit evidence in the segment; may miss merges revealed indirectly |
| (c) Drop pair-MERGE; express merges only as MERGE_INTO from units | Smallest design; loses "these two existing records are the same" |

**Recommendation: (a) for the first training runs, with MERGE precision
reported separately.** If merge false positives are material on validation,
move to (b). This needs your decision because it changes an invariant.

### D2. Head inputs have large scale; the heads start saturated

Ettin's final-layer states reach |h| ≈ 100 (rms ≈ 6). The pair, relation,
retrieve and interaction heads take elementwise products (v_j ⊙ v_k, c ⊙ v,
q ⊙ k), so initial logits are large. On the toy episode:

* initial loss is 149, of which ~100 per segment is the MERGE term and 10-24
  the RETRIEVE term;
* step-0 gradient norm is 4.6e4.

With the spec's clipping (1.0) training still converges. A one-off
comparison (not committed code; both arms clipped from step 0, so the numbers
differ from S1), with a parameter-free LayerNorm on encoder outputs before the
heads:

| | Step 0 loss | Step 0 grad norm | Step 10 loss | Step 41 loss |
|---|---|---|---|---|
| Spec (raw states) | 149 | 4e4 | 1.6 | 0.001 |
| Normalised | 18.6 | 7e2 | 1.2 | 0.001 |

| Option | Effect |
|---|---|
| (a) Keep the spec; rely on clipping | Proven to train on the toy; risk of slow early learning of saturated heads on real data |
| (b) Add a parameter-free LayerNorm on encoder outputs before every head | 0 new parameters; T11 unchanged; applies identically to M1c (shared heads), so the central test stays fair |
| (c) Rescale head initialisation | More tuning, same aim as (b) |

**Recommendation:** pre-register (a) against (b) as a 1-seed validation
choice in the Phase 5 CPU pilot, decided by the validation primary metric
before any multi-seed run. Both PASTE and M1c use the winner. This needs
your approval because it changes the head equations.

## 4. Clarifications (ambiguities resolved without changing the design)

| ID | Ambiguity | Resolution |
|---|---|---|
| C1 | T1's 1e-4 tolerance: against which HF path? | HF-SDPA (same kernel): 1e-4, achieved 0.0. HF-eager: must not exceed HF's own eager-vs-SDPA gap + 1e-5 |
| C2 | §4.1 "every metadata table zero-initialised" vs symmetry | Kind, status, age, evidence, temporary type/age and Δt tables: zero. Group embeddings, memory-index embeddings and h₀: N(0, 0.02²). Memory tokens share position 0; zeroing those three would leave the r = 4 memory tokens identical forever (r = 4 would act as r = 1) |
| C3 | T3's 1e-5 in fp32 | §2.1 above |
| C4 | Classification for promoted content | For PERSIST units, kind, certainty and attribute come from q*_u (the temporary item when PROMOTE), not from the span "yes, remember that". Spec §5.2 names q_u, §5.4 defines q*_u; this uses q* where the payload is built |
| C5 | A temporary item that is updated and predicted to expire in the same segment | An updated or promoted item is not expired by the learned head in that segment |
| C6 | When the session reset happens | At the start of the first segment of the new session (the adapter learns the session change only then). Equivalent to spec §5.12's reset after the last segment |
| C7 | Unspecified details | Bucket edges: Δt = 1 + ⌊log₂(1 + minutes)⌋ (cap 15); record age = ⌊log₂(1 + days)⌋ (cap 11); temporary age = ⌊log₂(1 + segments)⌋ (cap 7); evidence = min(e, 7). UNTIL resolver: today/tomorrow/this or next week/"until 5pm", UTC; fallback now + 24 h (as `brain.js`); 14-day cap. BIO: an I without a preceding B opens a span. Attribute classes: 100 placeholders + OTHER until `DATASET-DESIGN.md` defines the ontology. User profile text: "the user" |
| C8 | L_rec probe parameters | Training-only head; outside the §7 count. Its entity-role vocabulary waits for the dataset |

## 5. CPU latency and memory (untrained weights; fp32; 4 threads; this container)

Files: `results/phase3/bench-cpu-*.json`. Inputs:

* a 91-token segment (two turns);
* T = 8 temporary items;
* E = min(16, K/4) profiles;
* "warm" means the records were already encoded (cached), the normal case
  between segments; "cold" means every record is encoded in this call.

**Realistic decoding (3 units, 2 mentions)**, `--fixed-units 3`, p50
(p95 in brackets). Measured after the cache fix of §2.1:

| Backbone | K | Prefix + segment tokens | Step, warm | Step, cold | Encoder only, PASTE input | Encoder only, M1c-length input (records as text) |
|---|---|---|---|---|---|---|
| Ettin-32M | 8 | 30 + 91 | **30 ms** (48) | 69 ms (110) | 16 ms | 29 ms (275 tokens) |
| Ettin-32M | 32 | 84 + 91 | **40 ms** (54) | 224 ms (282) | 23 ms | 64 ms (599 tokens) |
| Ettin-32M | 128 | 284 + 91 | **113 ms** (164) | 926 ms (1,083) | 34 ms | 367 ms (1,875 tokens) |
| Ettin-17M | 8 | 30 + 91 | 18 ms (26) | 43 ms (57) | 9 ms | 15 ms |
| Ettin-17M | 32 | 84 + 91 | 30 ms (57) | 151 ms (202) | 10 ms | 25 ms |
| Ettin-17M | 128 | 284 + 91 | 79 ms (102) | 449 ms (652) | 15 ms | 167 ms |

**Cold-path trade-off (from the I4 fix).** Encoding each new record alone
made the cold step slower. At 32M, K = 128, it went from 266 ms (batched,
history-dependent) to 926 ms. A cold step happens only when many records are
new at once, e.g. the first call of a conversation. Between segments usually
0-2 records change, which is close to the warm case.

Options, for Phase 7, with no semantic change:

* encode new records in batches of **equal-length** texts only, and verify
  bitwise equality with single encoding;
* pre-encode records when the Brain writes them, so they are always cached.

**Memory:**

| Item | Ettin-32M | Ettin-17M |
|---|---|---|
| Peak RSS | 482 MB (496 MB at K = 128) | 366 MB (426 MB at K = 128) |
| of which Python + torch baseline | 222 MB | 222 MB |
| Serialised temporary state (8 items + h) | 26.2 KB JSON | 18.0 KB JSON |

**How to read these numbers:**

* The **M1c column is encoder-only, a lower bound**. M1c is not built yet.
  H4 compares end-to-end steps of trained models in a later phase. At K = 32,
  PASTE's whole warm step (40 ms) is already below M1c's encoder pass alone
  (64 ms).
* **With the untrained tagger**, the model marks ~85 of 91 tokens as units,
  and the warm step takes 219 / 340 / 507 ms at K = 8 / 32 / 128. Head cost
  scales with the number of units, so these numbers are not representative.
  They are kept in `bench-cpu-ettin-encoder-32m.json`.
* **Head overhead at K = 128** (113 ms warm against a 34 ms encoder pass)
  comes from Python loops:
  * per-profile addressing;
  * O(K²) merge-pair candidate selection;
  * addressing computed twice per unit (q and q*).
  These are optimisation targets for Phase 7, with no change in semantics.
* The container is noisy: the same encoder measurement varied by up to ~1.7×
  between runs (e.g. the M1c-length encoder pass at K = 8: 49 ms in one run,
  29 ms in another). p95 is reported for that reason, and H4 will use
  interleaved repeated runs.

## 6. What Phase 3 does and does not establish

**Established:**

* the specified architecture is implemented with exactly the specified
  parameter counts;
* the encoder is exactly Ettin;
* the memory set is permutation-equivariant;
* addressing is a valid, factorised distribution;
* the write gate, PROMOTE and session rules hold structurally;
* the Brain simulator follows `brain.js`;
* state round-trips exactly;
* inference is deterministic;
* gradients reach every module, and the losses can fit a toy episode.

**Not established:**

* any accuracy;
* whether recurrence is learned on real sequences;
* the H4 latency comparison against a built M1c;
* behaviour of the closed-loop trainer.

These need the dataset (Phase 4) and training (Phase 5).

## 7. Decisions needed before Phase 5 training

1. **D1:** amend I1 (option a), gate MERGE on a PERSIST unit (b), or drop
   pair-MERGE (c).
2. **D2:** approve the pre-registered 1-seed validation choice between raw
   and normalised head inputs, applied identically to PASTE and M1c.

Phase 4 (dataset) does not depend on either and can start when you say so.
