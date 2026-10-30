# Context-intelligence dataset

Training and evaluation data for Codeply's context model: read events
(chat turns, things heard, emails) and return the observations worth keeping,
in the extraction contract (`codeply-cli/lib/context-schema.js`).

## Make it

```bash
node ml/data/generate.mjs            # train 8000, val 800, test 800, test-mini 92 (seed 7)
node ml/data/export-sft.mjs          # sft-train.jsonl / sft-val.jsonl, the exact runtime prompt
```

Same seed, same files. `train/val/test/test-mini.jsonl` and `stats.json` are
committed; the SFT exports (about 20 MB) are rebuilt from them.

## Example

```json
{"id":"val-00012","task":"contradiction","split":"val","unseen":false,
 "input":{"events":[{"source":"chat","trust":"user","text":"User: Update: switch my communication channel to voice notes.\nAssistant: Got it.","at":"…"}],
          "known":[{"kind":"preference","slot":"communication channel","value":"Slack","text":"…"}],
          "now":"2026-…","tz":"Asia/Karachi"},
 "target":{"observations":[{"kind":"preference","slot":"communication channel","value":"voice notes",
          "text":"The user prefers voice notes for communication channel.","certainty":"stated","importance":0.82,"about":"user"}],"plans":[]},
 "expect":{}}
```

## What it covers

| Task | What the model must learn | Share |
|---|---|---|
| preference, dislike | Lasting preferences, stated many ways | 9 % + 3 % |
| fact | Occupation, home city, pet, languages, diet | 8 % |
| person | Facts about people close to the user, kept as facts about *them* | 6 % |
| decision, idea, requirement | Project memory, with the project name | 9 % + 3 % + 3 % |
| todo, routine | Things to do, regular habits | 5 % + 3 % |
| temporary | Live context with an end time (`until`) | 6 % |
| joking, hypothetical, quoting | Labelled with that certainty and low importance, so the brain ignores them | 4 % + 4 % + 3 % |
| noise | Small talk and coding chatter: nothing to keep | 10 % |
| duplicate | A known memory said again: reuse its slot and value (the brain reinforces it) | 6 % |
| contradiction | A new value: said plainly (replaced) or in passing (implied, a challenger) | 7 % |
| secret | A PIN, password or key next to a real preference: only the preference (the input is redacted exactly as at runtime) | 4 % |
| injection | An email telling the assistant what to remember: nothing from the instruction, only the real meeting | 4 % |
| external, heard | Someone else's words, or speech around the user: at most `implied` | 3 % + 3 % |
| plan | Meetings with a date and time computed from "now" in the user's time zone | 5 % |
| urdu | Roman Urdu messages with English observations | 2 % |
| multi | 2–3 of the above in one message or batch | 8 % |

## Honest limits

* **Procedural.** The text comes from templates and value pools
  (`pools.mjs`), with light noise (casing, punctuation, the odd typo). It
  teaches the format, the certainty rules, slot reuse and the safety
  behaviour well. It does not cover the variety of real speech. The
  hand-written gold set (`ml/eval/gold.mjs`) measures that gap: rules score
  F1 0.45 on `test` and 0.17 on `gold`.
* **Held-out phrasing.** About 1 in 5 templates of each task never appears in
  `train`; examples in `val`/`test` that use one have `"unseen": true`.
* **No personal data.** Names, places and projects are invented; no real
  conversation was used.
* **Next step for quality:** a teacher model (a strong cloud model, run by
  someone with an API key) paraphrases the user lines of `train` while the
  labels stay fixed, and writes extra free-form examples that are then
  checked by the same guard (`checkExtraction`) before use. The hook for this
  is `ml/data/generate.mjs`: the label comes from the generator, only the
  surface text changes. Not done here: no API credentials were available in
  this environment.
