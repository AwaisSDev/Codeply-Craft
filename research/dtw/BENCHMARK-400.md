# Benchmark-520: the hand-written release benchmark

`research/dtw/benchmark/bench.jsonl`: 520 examples (the mission asked for
400+), in the evaluation harness's format, every extracted memory and plan
with exact character spans. It is the release authority for Decide-then-Write
and every other extraction backend. The generated datasets
(`ml/data/out/`) are unchanged.

## How it was made

* **Guide first** (`benchmark/GUIDE.md`): file format, label semantics (the
  product's own: `brain.KINDS`, `brain.CERTAINTY`, importance bands, the
  merge rules of `brain.observe`), six fixed "now" anchors (three time zones,
  every weekday, with a 15-day calendar each) and date rules matching prompt
  v2 ("Saturday" = the next Saturday after today, "till 5" = the next 17:00,
  "this week" = Sunday 23:59).
* **Seven independent writers**, each a separate model instance with its own
  category list, told to write the way real people type and never to look at
  the generator's templates (`ml/data/`) or at each other's files.
* **A validator** (`benchmark/validate.py`) every part had to pass with zero
  errors: field and enum checks; evidence and time text must be exact
  substrings of the event (offsets are computed by the validator, not
  written by hand); merge targets must exist and use the known memory's slot
  (and value, for "same"); plan weekdays and "tomorrow" checked against the
  anchor calendar; outside text (email) can be at most `implied` and can
  never set the user's own preference; memorable items need importance ≥ 0.4
  (the guard's floor); secrets never in an observation.
* **Review**: a random sample read by hand; no near-duplicates across writers
  (sequence ratio > 0.85: none); writers' doubts recorded (below).
* **Blind second annotation** of a stratified sample of 100 (§4).
* One fake API key was reformatted (it matched OpenWeather's real key format
  and GitHub push protection blocked it); the example still tests secret
  leakage.

## Composition

| | Count |
|---|---|
| Examples | 520 |
| Languages | English 364, Roman Urdu 65, mixed (code-switching) 91 |
| Anchors | A 102, B 96, C 81, D 77, E 76, F 88 (three time zones) |
| Observations | 747: 551 memorable (stated 420, implied 84, temporary 47), 196 to reject (joking 62, hypothetical 68, quoting 66) |
| Plans | 160 |
| Examples with nothing to keep | 49 |
| Examples with known memories | 170; 141 observations with a merge target |
| Event length | median 190 characters; long conversations 600-2,500 |

| Failure category (mission) | Where | Examples |
|---|---|---|
| Jokes | `joking` + traps in other parts | 46 + |
| Hypotheticals | `hypothetical` | 40 + |
| Quotations | `quoting`, `heard`, `external` | 40 + 21 + 21 |
| Meetings vs plans | `plan` (incl. routines that are not plans, undecided and cancelled meetings) | 51 + |
| Temporary context | `temporary` | 36 + |
| Memory merges | `duplicate` | 33 + |
| Contradictions | `contradiction` (stated replace, implied challenge, traps that must not update) | 45 + |
| Certainty labels | every part; stated vs implied cases in `cv` | all |
| Roman Urdu | `lang: ur` | 65 |
| Mixed-language | `lang: mixed` | 91 |
| Long conversations | `long` (600-2,500 chars, 2-6 items, mid-chat corrections) | 40 |
| Noise | `noise` | 33 |
| Safety | `secret` 11, `injection` 11 | 22 |
| Coverage of every kind | preference, dislike, fact, person, decision, idea, requirement, todo, routine, style | 92 |

("+" = more examples of the category appear inside other parts' examples.)

## Format additions (harness-compatible)

Every observation and plan carries
`evidence: {event, start, end, text}` and, where a time applies,
`time: {event, start, end, text}`; merged observations carry
`merge: {target: "mK", relation: "same" | "different"}`; known memories have
ids `m1..m8`. The harness ignores these fields; Decide-then-Write's span
alignment (`data/align.py`) uses `evidence` directly.

## Inter-annotator agreement

A second annotator (a fresh model instance with only the guide and the
inputs: no access to the labels) labelled a stratified sample of 100
examples. Agreement with the benchmark labels, with the harness's matching
(`benchmark/agreement/agreement.mjs`, raw: `agreement/agreement-results.json`):

| Unit | n | Agreement | Cohen's κ |
|---|---|---|---|
| Item detection (F1 between annotators) | 152 vs 160 items | 0.955 | – |
| Memorable item detection (F1) | 113 vs 120 | 0.944 | – |
| Keep vs reject (on matched items) | 149 | 1.000 | 1.000 |
| Certainty (on matched) | 149 | 0.973 | 0.956 |
| Kind (on matched) | 149 | 0.879 | 0.846 |
| Per-example decision (none, plan, top certainty) | 100 | 0.970 | 0.955 |
| Plans found (F1) / same date when matched | 36 vs 37 | 0.959 / 0.943 | – |

**Caveat that matters**: both annotators are instances of the same model
family. Their agreement is an **upper bound**: two people would disagree more,
especially on kind (preference vs fact vs routine), stated vs implied, and
ambiguous end times. The benchmark measures what it measures well (the
contrasts it was written to test); before it becomes the final release
authority, a human-labelled subset (EXPERIMENT-ROADMAP D3, 2-3 person-days)
and the real-world set (D4) are needed.

## Known label judgement calls

Recorded by the writers and the second annotator; left as written, listed so
that disagreements in results can be read against them:

* End times without an explicit hour ("till Sunday night" → 23:59 that day;
  "raat 12 baje tak" → 00:00 next day; "till payday on the 28th" →
  00:00 that day).
* Undecided or proposed meetings: no plan (one hypothetical `idea`
  observation); cancelled meetings: nothing.
* A parcel delivery window, a discharge date, an exam: plans.
* Inferred facts (a user "applied to Brightlane", "has a thesis") labelled
  `implied` at 0.45-0.6: a strict system may legitimately skip them.
* Jokes and hypotheticals that touch a known memory: some carry a merge
  target with relation "different" (the brain ignores them anyway), some do
  not; the harness's memory-action metric treats both the same.
* New facts about a known person sharing the person's slot without a merge
  (they add, not replace).

## How to use it

```bash
node ml/eval/run.mjs --provider <backend> --set bench --set-file research/dtw/benchmark/bench.jsonl --threads 4 --out research/dtw/results
node research/dtw/eval/analyze.mjs research/dtw/benchmark/bench.jsonl <baseline run> <run> ...
```

Rebuild from the parts: `python3 research/dtw/benchmark/validate.py --build research/dtw/benchmark/bench.jsonl research/dtw/benchmark/parts/*.jsonl`.
The writers' source files are kept in `benchmark/parts/src/`.

Never train, tune prompts, or pick thresholds on this set. The time
resolver, the heads' temperatures and every Decide-then-Write setting were
developed on generated validation data and the old 39-example gold set only.
