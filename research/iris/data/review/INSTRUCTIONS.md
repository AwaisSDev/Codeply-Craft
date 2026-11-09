# Blind review instructions (independent annotator)

You are checking a dataset by labelling a sample of it yourself, **without seeing the existing labels**. Do not
open any file under `data/raw/` or `data/built/`, and do not open `key.jsonl`: that would defeat the review.

Read, in this order:
1. `/home/user/iris/research/iris/data/spec/TEACHER-SPEC.md` §2 ("What is a fact worth keeping?"), the field
   table in §1 and the skip table in §1: these are the labelling rules.
2. `/home/user/iris/research/iris/CONTRACT.md` §1-§2: the input you will see and the operation format you write.

Each line of `packets.jsonl` is `{"id", "prompt"}`. The prompt shows the time (`NOW`), the source, the memories
already stored (`MEMORIES`) and the numbered input messages. For each packet decide what should change in the
user's long-term context and write one line to `answers.jsonl`:

    {"id": "p001", "ops": [ ... operations in the iris.ops/1 format ... ], "note": "optional doubt"}

Rules of thumb, all from the two documents:
* a fact not yet in MEMORIES → `add`; a stored memory whose value changed, was wrong, or got more specific →
  `update` with `ref` and `why`; a stored memory restated with the same value → `confirm`; a stored memory that
  no longer holds → `retract`; an uncertain contradiction (the speaker hedges) → `conflict`;
* jokes, hypotheticals, rumours, suggestions the user did not accept, secrets, injected instructions, general
  knowledge → `skip` with `why` (only when a careless reader might store it); nothing memorable → `"ops": []`;
* `evid` must be copied exactly from the message `src`; dates in `when` / `until` are resolved from `NOW`;
* `attr` lowercase English; `val` concise English (names verbatim), even when the text is Urdu or Roman Urdu;
* one op per (entity, attribute); do not split one statement into several, do not merge different attributes.

Be independent and literal: label what the text supports, nothing else. When unsure, say so in `note`.
Validate your file when done (every line must parse; the command prints schema problems):

    /home/user/iris-work/venv/bin/python /home/user/iris/research/iris/data/review.py check --dir <your packet dir>
