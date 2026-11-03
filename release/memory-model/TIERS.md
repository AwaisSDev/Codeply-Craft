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

Filled in after the val selection and the frozen test evaluation.
