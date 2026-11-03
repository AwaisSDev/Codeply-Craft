# Automatic / pending / discard tiers for the memory model (task 6)

Pre-registered 2026-11-03 before any confidence of the exported model was
computed. Owner decisions that apply: cost ratio 3:1 initially (2:1 and 5:1
tested); low-confidence memories never go into permanent storage; no change
to production Brain without approval.

## Confidence

The LFM3 model has no classifier head, so its confidence comes from the
token log-probabilities of its own answer (`conf-provider.mjs`, the
production local backend plus `logprobs`). Per observation:

* `exist`: probability of the token that opens the observation (the model's
  decision to add it at all),
* `mean`: geometric-mean probability of the observation's tokens,
* `min`: lowest token probability inside it.

Greedy decoding with the JSON Schema is unchanged, so the answers are the
production answers; only the probabilities are added.

## Selection (frozen val split only, exported Q4_K_M model)

1. Run the confidence provider on val (478), test-real and Benchmark-520
   (recorded, not read for the selection).
2. For each confidence feature f ∈ {exist, mean, min} and r ∈ {2, 3, 5}:
   τa = the lowest grid value (0, 0.1, …, 0.9, 0.95, 0.97, 0.99) at which
   the automatic tier's val precision ≥ r/(r+1); τp = the lowest grid value
   < τa at which the val precision of the pending band [τp, τa) ≥ 1/3
   (assumption carried over from `research/dtw/TIERS-PROTOCOL.md`).
3. Feature: the one whose automatic tier keeps the most correct memories on
   val at r = 3 (ties: exist, then mean, then min).
4. Freeze (`release/memory-model/results/TIERS-FROZEN.json`, committed),
   then evaluate once on test-real and Benchmark-520: automatic precision,
   recall, cost against storing nothing, pending volume and precision.

If no threshold reaches the 3:1 break-even (0.75) on val, everything the
model is not certain of goes to pending, and the result is reported as is.

## Mapping onto the existing Brain (no new storage tier needed)

Brain already distinguishes `confirmed` (said plainly or seen twice) from
`tentative` ("not sure yet", shown to the assistant marked "not confirmed",
promoted by a second sighting or by the user's `confirm`). The tiers map:

| Tier | Condition | What the engine sends to `brain.observe` |
|---|---|---|
| Automatic | f ≥ τa | the observation unchanged (stated → confirmed) |
| Pending | τp ≤ f < τa | certainty forced to `implied` → stored `tentative` |
| Discard | f < τp | nothing (logged in the batch outcome) |

Jokes, quotes, hypotheticals and secrets are still filtered by Brain as now.

## Confirmation workflow for pending memories (design; production change, not applied)

1. **Never acted on silently.** A pending memory is stored `tentative`; the
   assistant sees it only as "(not confirmed)" in the "unsure" block and is
   instructed not to rely on it.
2. **Promotion by evidence.** Seen again in a *different* conversation
   (another batch), it becomes `confirmed` (Brain's existing evidence ≥ 2
   rule). Stated plainly by the user, it is confirmed at once.
3. **User confirmation.** The memory panel lists pending memories with
   Confirm / Edit / Forget (Brain's existing `confirm`, `correct`,
   `forget`). The assistant may ask at most one natural confirmation
   question per conversation, only when the memory is relevant to the
   current request.
4. **Expiry.** A pending memory not promoted within 30 days is deleted
   (new: Brain's `prune` does not expire tentative memories today).
5. **Audit.** Every tier decision is recorded in the batch outcome (tier,
   feature value, thresholds, model id), so it can be reviewed and the
   thresholds re-tuned.

Production changes this needs (prepared on the integration branch, not
merged): the local provider requests log-probabilities and attaches the
confidence; the engine applies the frozen thresholds; `prune` expires
stale tentative memories from the model.

## Results

Selection on val only (`select_tiers.py select --seed 1`, frozen in
`results/TIERS-FROZEN.json`, commit c7c1a139 before any test file was read).
Feature chosen: `exist` (probability of the observation's opening token).

| Ratio r | Break-even precision | τa (automatic) | τp (pending) | val automatic P / R |
|---|---|---|---|---|
| 2 | 0.67 | 0 (everything) | – | 0.776 / 0.479 |
| 3 | 0.75 | 0 (everything) | – | 0.776 / 0.479 |
| 5 | 0.83 | 0.95 | 0 (rest pending) | see `tiers-s1-val-selection.json` |

At r = 2 and r = 3 the model's precision on val is already above
break-even, so the rule stores everything automatically and there is no
pending tier. At r = 5 observations with exist ≥ 0.95 are automatic and the
rest are pending; nothing is discarded by confidence (the guard and the
Brain still drop secrets, ignored certainties and ungrounded values).

Frozen thresholds tested once (`select_tiers.py test --seed 1`,
`results/tiers-s1-test.json`):

| Config | Set | Automatic P / R | Pending per 100 inputs (P) | Cost at 3:1 | Store nothing |
|---|---|---|---|---|---|
| r = 3 | test-real | 0.792 / 0.563 | – | 322 | 366 |
| r = 3 | Benchmark-520 | 0.733 / 0.624 | – | 582 | 551 |
| r = 5 | test-real | 0.867 / 0.284 | 25.5 (0.73) | 310 | 366 |
| r = 5 | Benchmark-520 | 0.808 / 0.343 | 45.2 (0.66) | 497 | 551 |

Decision, as pre-registered: the 3:1 configuration ships, i.e. `tiers:
null` in the catalog (no confidence pass needed). On Benchmark-520 it costs
slightly more than storing nothing (582 vs 551; production LFM3 1,056). The
r = 5 configuration beats storing nothing on both sets; adopting it because
of these test numbers would be tuning on test, so it is the owner's choice
on principle ("wrong memories cost 5× a missed one"). To adopt it, set the
catalog `tiers` to `{ feature: 'exist', tauA: 0.95, tauP: 0 }`.


## 3:1 versus 5:1: the trade-off on validation data (2026-11-03)

Everything in this section comes from the **val** set (478 inputs, 311 gold
memories; `results/tiers-s1-val-selection.json`). No test number is used
to argue for either option; the frozen choice above is unchanged.

Per 100 inputs (extraction batches) on val:

| | 3:1 config (frozen, shipping) | 5:1 config (exist ≥ 0.95 automatic, rest pending) |
|---|---|---|
| Stored automatically | 40.2 | 17.6 |
| … of which wrong | **9.0** | **2.5** |
| Automatic precision / recall | 0.776 / 0.479 | 0.857 / 0.232 |
| Pending (tentative, 30-day expiry) | 0 | 22.6 (precision 0.713: 16.1 right, 6.5 wrong) |
| Correct memories if every pending one is confirmed | 31.2 | 31.2 (same set) |
| Correct memories if no pending one is ever confirmed or seen again | 31.2 | 15.1 |
| Cost at 3:1 (3·wrong + missed; store nothing = 311) | 291 | 275 |
| Cost at 5:1 (store nothing = 311) | **377 (worse than storing nothing)** | 299 |

The cost rows count pending memories as not stored (conservative: they are
shown to the assistant only as "not confirmed").

What this means:

1. **The choice is about which error the product prefers.** 3:1 stores
   about 9 wrong memories per 100 batches with no user effort. 5:1 cuts
   that to 2.5 and asks the user (or a second sighting) to settle 22.6
   pending ones per 100 batches, of which 7 in 10 are right.
2. **If wrong memories really cost 5× a missed one, the 3:1 config is
   worse than storing nothing on val** (377 vs 311); the 5:1 config is not
   (299). If they cost 3×, both beat storing nothing and 5:1 is slightly
   cheaper on val (275 vs 291).
3. **The pending tier's value depends on promotion.** If users rarely
   confirm and the same fact is rarely seen again, half of the correct
   memories (16.1 of 31.2) expire after 30 days. Promotion by recurrence is
   weakened today by the duplicate issue (`results/BRAIN-DEDUP.md`).
4. **The pre-registered rule is a precision floor, not a cost minimum.** It
   takes the lowest threshold whose precision reaches r/(r+1); at 3:1 that
   is "everything", although on val a threshold of 0.8 would cost less
   (269 vs 291). Changing the rule now would be decided after the test sets
   were read, so it is **not** done; if the owner wants a cost-minimising
   rule, it should be pre-registered and checked on data not yet used
   (e.g. opt-in feedback or a fresh labelled set).

Val cost curve for the chosen feature (`exist`), all thresholds:

| exist ≥ | Stored | Wrong | P | R | Cost 3:1 | Cost 5:1 |
|---|---|---|---|---|---|---|
| 0 - 0.5 | 192 | 43 | 0.776 | 0.479 | 291 | 377 |
| 0.6 | 180 | 37 | 0.794 | 0.460 | 279 | 353 |
| 0.7 | 169 | 33 | 0.805 | 0.437 | 274 | 340 |
| 0.8 | 150 | 27 | 0.820 | 0.395 | 269 | 323 |
| 0.9 | 120 | 20 | 0.833 | 0.322 | 271 | 311 |
| 0.95 | 84 | 12 | 0.857 | 0.232 | 275 | 299 |
| 0.97 | 58 | 8 | 0.862 | 0.161 | 285 | 301 |
| 0.99 | 23 | 3 | 0.870 | 0.064 | 300 | 306 |

**Recommendation for the opt-in release:** the 5:1 configuration. Opt-in
testers can confirm pending memories, wrong memories are the failure users
notice, and on val it never does worse than storing nothing at either
ratio. This is an owner decision on principle; the frozen 3:1 result stays
the documented default until the owner chooses.
