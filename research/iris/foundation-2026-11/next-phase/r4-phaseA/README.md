# R4 Phase A: blind human review (started 2026-11-20)

Owner decision of 2026-11-20: begin Phase A of `../R4-DATA-QUALITY-PROPOSAL.md`.
* No API credits are spent and no AI-labelled data is generated.
* Training data are not modified.
* The test split is not read.
* Original labels are kept separately from human decisions.

## Files

| File | Content | Shown to the reviewer |
|---|---|---|
| `make_review_sample.py` | deterministic stratified sampler (seed 20261120) | no |
| `packets-v1.json` | 280 items: opaque id, date, source, language, stored memories, messages, **one** proposed operation, overlap flag. Packet set sha256 `7ff84a85ef97303e4594f2d142aa7169e974926379a7bed9ed2b52dc62f6931c` | **yes** (the page loads it) |
| `key-v1.json` | per item: stratum, origin (teacher label / model output), model, author (Opus / Sonnet), shard, example id, the original operation verbatim, strict-match status, all labelled operations on the same message | **no** (never published) |
| `sample-summary-v1.json` | counts by stratum, sub-source, origin, author, language, split | no |
| `review.html` | the review interface, published privately at https://claude.ai/artifact/PVgxU3HUQRZihayABZ8Q9N | — |

## Sample (280 items, 71 in the second-reviewer overlap set)

| Stratum | Items | Sources |
|---|---|---|
| S1 false memories | 80 | model content ops scored strictly incorrect: Qwen3-4B pilot seed 1 (40), r2 (40); authors balanced |
| S2 updates | 40 | teacher updates 20 (+4 top-up); model updates scored wrong 16. Only 17 such model updates exist |
| S3 retractions | 30 | teacher 15, model 15 |
| S4 skip decisions | 60 | model stored a labelled skip 5 (only 6 exist); model skipped a labelled fact 15; teacher skips in training data 30 (Opus / Sonnet balanced); top-up teacher skips in validation 10 |
| S5 control: teacher adds | 40 | Opus 20, Sonnet 20 |
| S6 Roman Urdu / Urdu script / mixed | 30 | teacher 15, model 15 |

* Origin: 134 teacher labels, 146 model outputs.
* Author: 142 Opus, 138 Sonnet.
* Language: en 134, roman-ur 89, ur 24, mixed 33.
* Split: training and validation only.

Shortfalls (fewer model cases exist than the quota) were filled with teacher items of the same operation type. The
top-ups are listed in `sample-summary-v1.json`.

## Blinding

The page shows no author, model, stratum, origin or correctness. Each item shows one fixed field set (op, entity,
attribute, value, target memory, date, kind / keep, reason, related, source message, quote); empty fields read "—".
Item order is shuffled. Checked automatically:
* the packets contain no author or model name;
* the remaining word hits are conversation content.

Known residual: some field combinations (e.g. a reason on a skip) are more common for one origin. A reviewer could
guess the origin of some items, but cannot read it.

## Decisions

* **Per item:**
  * `decision`: remember / update / retract / skip / unsure;
  * `details` (the proposal's entity, attribute, value, target): correct / partly / wrong / not applicable;
  * optional corrections (entity, attribute, value, target memory);
  * explanation;
  * timestamps and a revision counter;
  * packet version and sha256.
* **Storage:** the artifact's database at `reviews/<reviewer id>/items/<item>`.
  * Each reviewer can read and write only their own decisions, so overlap reviews stay independent.
  * The artifact owner can read all reviewers' decisions.
  * Nobody can edit another reviewer's decisions.
  * If the store is unavailable, decisions are kept in the browser and the page says so.
* **Export:** "Export review file" saves `iris-r4a-review-v1-<label>-<timestamp>.json`. It has schema
  `r4-phaseA-review/1`, the packet version and sha256, the reviewer label and id, the storage mode and every decision.
  Exports are committed under `r4-phaseA/reviews/` unchanged.

## Analysis (after the review, not before)

* Join each export with `key-v1.json` by item id.
* Per stratum and per author, compute:
  * the human-vs-label agreement and the human-measured label error rate;
  * the share of model "false memories" a human judges correct (metric or convention penalty);
  * human-human agreement on the 71 overlap items.

The analysis script is written and committed before any export is read, so the analysis cannot be shaped by the
decisions. Nothing is written back to the training or validation data. Any correction becomes a proposal in a new,
versioned file.
