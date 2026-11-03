# Brain duplicates: diagnosis and a proposed minimal fix (2026-11-03)

Not applied to production. The fix is on branch `codeply-brain-value-match`
(one commit on top of `codeply-memory-model-integration`) for the owner to
review.

## What the duplicate cases showed

The 4 duplicate cases (`integration/cases.jsonl`) seed the Brain with a
known memory, then send a conversation that mentions it again. Re-run on the
release candidate with the observations recorded
(`integration-s1-duplicates-observations.json`; actions identical to the
frozen run):

| Case | Known memory (slot = value) | Model's observation (slot = value) | Brain action | Cause |
|---|---|---|---|---|
| dup-01 | diet = vegetarian | diet = vegetarian | reinforced ✓ | – |
| dup-02 | pet = **a** dog named Sheru | pet = dog named Sheru | **replaced** ✗ | **Brain**: values compared exactly; an article made them "different", so a confirmed memory was replaced by the same fact and its evidence reset to 1 |
| dup-03 | reply style = short bullet points | current location = on mobile (temporary) | added ✗ | **Model**: did not repeat the known preference; stored the new temporary context instead (correct in itself) |
| dup-04 | city = Islamabad | home neighborhood = lives near F-9 Park, Islamabad | added ✗ | **Design question**: a new, more specific fact in a different slot; storing it is defensible; the known city is simply not reinforced |

So one of three failures is a Brain bug, one is model behaviour and one is
a judgement about what "duplicate" should mean.

## The proposed fix (dup-02 only)

`brain.js`: two values are the same if they are equal as now, **or** equal
after dropping a tiny list of filler words (`a`, `an`, `the`, `my`, `our`,
possessive `'s`) and plural endings (the Brain's existing `stem`). Word
order, negations, numbers and every other word still count. The same
comparison is used to recognise a repeated challenger. 16 lines; no schema
change; the change log records the reinforcement as before.

Must-stay-different pairs, all tested (`scripts/brain-value-match-test.mjs`,
15 checks): Lahore / Karachi, likes coffee / no coffee, coffee / no coffee,
2 cats / 3 cats, dog named Sheru / dog named Moti, short / long bullet
points, Lahore / Lahore to Karachi, Islamabad / near F-9 Park, Islamabad.
Existing suites unchanged: `brain-test.mjs` (159 checks),
`context-test.mjs`, `memory-model-test.mjs` all pass.

Integration suite with the fix, same model (`integration-s1-valuematch.json`):
**42 / 48** (frozen run 41 / 48). The only change is dup-02 (now
reinforced); no other case changed. Duplicates 2 / 4, still below the
0.75 gate, which is **not** changed.

## Not proposed (and why)

* **Cross-slot merging** (dup-04: "lives near F-9 Park, Islamabad" reinforcing
  "city = Islamabad"): needs fuzzy matching across slots, which is where
  wrong merges come from ("my sister lives in Islamabad"). Better left to a
  later design with its own tests.
* **Making the model repeat known facts** (dup-03): a model change (v2
  training data), not a Brain change. Its cost: pending memories are
  promoted less often by being seen again (`TIERS.md`, trade-off point 3).
* **Embedding similarity for values**: larger, slower, harder to audit than
  a rule a reviewer can read in one screen.

## Owner decision needed

Merge `codeply-brain-value-match` with the integration branch, or not. It
changes how the production Brain treats every source (not only this
model), so it needs explicit approval.
