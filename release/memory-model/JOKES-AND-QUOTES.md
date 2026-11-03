# Jokes and quotations: failure analysis (task 4)

Data: the per-example results of the fine-tuned LFM3 LoRA (seeds 1, 2;
adapter applied at load time) and production LFM3 on Benchmark-520, whose
`joking` (46 examples) and `quoting` (40) tasks are built to test this.
No tuning on Benchmark-520: it is only read here.

## What happens

| Benchmark-520 | LoRA s1 | LoRA s2 | Production LFM3 |
|---|---|---|---|
| Jokes stored as memorable (false memories) | 22 / 45 | 15 / 45 | 15 / 45 |
| Quotes stored as memorable | 18 / 39 | 14 / 39 | 16 / 39 |
| Brain action correct, joking task | 47 / 91 | 49 / 91 | 56 / 91 |
| Brain action correct, quoting task | 43 / 77 | 46 / 77 | 48 / 77 |
| Real memories in those examples found | 29 / 46, 23 / 38 | 26 / 46, 20 / 38 | 30 / 46, 22 / 38 |

The fine-tuned model **never learned the `joking` and `quoting` labels**:
over the 44 gold jokes and 35 gold quotes it predicts `joking` twice and
`quoting` at most once; jokes and quotes come out as `stated` (most),
`temporary` or `implied`. When it avoids a false memory it is by leaving
the item out, not by labelling it.

Cause: the training data. Joking and quoting are 15 and 11 of 2,600 train
observations (0.6 % and 0.4 %); val has 2 and 0, test-real 2 and 4. Claude
labelled them correctly where they occur; there are simply too few.

## How serious

* **Same rate as production.** Seed 2 equals production on jokes (15 / 45)
  and is better on quotes (14 vs 16); seed 1 is worse on both (22, 18).
  The seed mean (18.5, 16) is within noise of production (15, 16).
  Shipping the fine-tuned model does not make this failure worse on
  average, but does not fix it.
* **Rare in real traffic.** On realistic data (test-real, natural-300)
  jokes and quotes are ~1-2 % of observations; Benchmark-520 deliberately
  over-represents them (86 of 520 examples).
* **Visible when it happens.** A joke stored as a fact ("the user is a
  millionaire") is the kind of error users notice. With the three tiers
  (`TIERS.md`), a memory the model is unsure of goes to pending instead of
  permanent storage, which limits the damage only if the model's
  confidence is lower on these items; that is measured there.

## Mitigations considered

* **Deterministic cue guard (rejected).** A rule that routes an
  observation to pending when its message contains joke cues (lol, jk,
  haha, emoji, /s) or quote cues (quotation marks, "my dad says",
  "according to"). Measured on the train and val splits only: 0 of the 15
  train jokes and 0 of the 2 val jokes contain a joke cue (real jokes are
  dry), and the quote cue fires on 30 % of true memorable observations in
  train (733 / 2,464; WildChat users paste quoted text). It would bury real
  memories and catch almost no jokes.
* **More training data (recommended, v2).** Add a few hundred labelled
  joking and quoting examples (both "store nothing" and "store the real
  fact next to the quote" cases), retrain, re-evaluate the full protocol.
  Needs labelling (the realistic data was labelled with the Claude API,
  which is paid: owner decision) and a GPU session (free Kaggle quota
  resets weekly). This is a new model version, not a patch.

## Decision

Not a ship-blocker for v1 (no worse than the production model, rare in
real traffic), recorded as a known limitation. The proper fix is a v2
retrain with joke and quote coverage.
