# Pilot: pass criteria (written before the pilot results)

Pilot `pilot1`: 50 examples from the candidate pool (`data/pool.jsonl`:
`sources/build.py --seed 1`, then `sources/scrub.mjs`, which stores only
text passed through Codeply's own redaction; 72 of 5,198 examples had
secrets such as pasted API keys), labelled with the owner's hybrid routing:

* stage 1, 40 examples drawn by source (WildChat 60 %, MultiWOZ 15 %,
  Topical-Chat 10 %, Roman Urdu 15 %): Sonnet 5.5 (effort high), except inputs
  with time words, which go to Opus 5.5 (effort high);
* stage 1b: any Sonnet answer with temporary context is labelled again by
  Opus, and Opus's label is kept;
* stage 2, 10 merge / contradiction examples built from stage-1 labels: the
  example's own memory is added as a known memory (same value: "same", 5) or
  replaced by an earlier value written by Sonnet 5.5 (effort low:
  "different", 5), plus 1-4 distractor memories from other examples; Opus
  labels them without seeing which memory was planted.

The full run starts only if every line below holds:

| Check | Pass |
|---|---|
| Labels returned (no refusals, truncations, unparsable answers) | ≥ 98 % |
| Checker pass (evidence quotes, kinds, certainty/context rule, until format, merge targets valid) | ≥ 95 % |
| Evidence spans resolve to character offsets in the raw source text | 100 % of kept examples |
| Plan dates: agree with the product's date resolver (`runtime/time-resolve.mjs`) where it resolves the quoted time text | ≥ 90 % |
| Temporary context: `until` agrees with the resolver where time text is quoted | ≥ 80 % (the resolver's defaults are coarse) |
| Merge examples: labeller points at the planted memory | ≥ 9 / 10 |
| Merge examples: relation (same / different) right | ≥ 8 / 10 |
| Negatives: examples with nothing to keep | 20-70 % of kept examples, and none of the reviewed empty ones should have kept something |
| Manual review of all 50 (`out/pilot1/REVIEW.md`): examples with a substantive error (wrong memory stored, important memory missed, wrong merge, wrong plan date) | ≤ 10 % |
| Provenance complete (dataset, licence, URL, revision, file SHA-256, original id) | 100 % |
| Cost per example | within 2x of the benchmark run's (Sonnet $0.003, Opus $0.010) |
