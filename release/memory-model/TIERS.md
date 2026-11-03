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

