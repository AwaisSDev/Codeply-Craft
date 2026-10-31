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

# Result of pilot1: FAIL (data mix), labeller quality passes

| Check | Result | Pass? |
|---|---|---|
| Examples | 43, not 50: only 7 stage-1 examples had a memory, so only 3 merge examples could be built | **fail** |
| Labels returned | 43 / 43 | pass |
| Checker | 43 / 43 | pass |
| Evidence spans resolve | 43 / 43 | pass |
| Plan dates vs resolver | 1 / 1 (too few plans to test) | untested |
| Temporary context `until` | 0 temporary items in the whole pilot | untested |
| Merge target / relation | 2 / 3, 2 / 3 (too few) | **fail** |
| Negatives | 36 / 43 = 84 % empty (limit 70 %) | **fail** |
| Manual review (all 43) | 1 clear miss (MultiWOZ: train trip on Thursday arriving by 18:30 not kept as a plan), 1 borderline (WildChat: "my boyfriend isn't ready for a relationship" left out; sensitive, defensible), 1 merge where Opus made a new memory instead of matching the planted one; empty answers checked one by one and all correct (code, homework, fiction and role-play prompts, comments about celebrities) | pass (≤ 3 / 43) |
| Provenance | 43 / 43 | pass |
| Cost | $0.0034 / example | pass |

Comparison arms (kept separate): Roman Urdu with Opus instead of Sonnet: 1
of 5 differs (Opus keeps an ambiguous "higher education at Cambridge", subject
unclear). Opus-routed examples with Sonnet instead: 1 of 6 differs (Sonnet
misses "MPI staff member", implied). Too few to conclude.

**Why it failed:** the pool, not the labeller. A random English WildChat
shard is mostly tasks (code, homework, stories, role-play prompts), and the
regex self-disclosure filter lets them through ("I", "my", "project" occur in
task prompts). The UCI Roman Urdu comments are about celebrities and
politics, Topical-Chat about media and facts: almost never about the user.
So there is too little to learn from, no temporary context, and too few
memories to build merge examples. Do not scale this pool.
