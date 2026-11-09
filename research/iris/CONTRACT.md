# Iris contract `iris.ops/1`

Iris is the interpretation layer of the Context Fabric. It reads one observation batch and the memories
infrastructure selected for it, and **proposes** operations. It never writes, deletes or expires anything:
`contract.guard()` checks every proposal, and the store (the Brain in production, `MemoryStore` in research)
applies what passed. Code: `codeply_iris/contract.py` (schema, parser, guard, Brain mapping),
`codeply_iris/prompt.py` (input format), `codeply_iris/store.py` (reference store).

## 1. Input

```
TASK: observe
NOW: 2026-02-17T13:05 Tue
SOURCE: personal_chat
MEMORIES:
m356 | Dubai design meetup | date | 6 March 2026 | when 2026-03-06
m204 | user | employer | Finlo
INPUT:
[1] Zainab: Hira! meetup ka kya scene hai? 6 ko hi hai na
[2] user: nahi yaar postpone ho gaya, ab 20 March ko hai. organisers ne kal email ki
```

* `NOW` is the local time of the batch, with the weekday, so relative dates can be resolved.
* `SOURCE`: `assistant_chat`, `personal_chat`, `work_chat`, `email`, `calendar`, `note`, `screen`.
* `MEMORIES`: `id | entity | attribute | value [| when ISO] [| until ISO]`, or `(none)`. Infrastructure chooses
  which memories to show (retrieval is its job) and aliases real ids to short ones (`m1`…) per call.
* `INPUT`: numbered messages, `[n] speaker: text`, whitespace collapsed. The user is always `user`.

Wrapped in plain ChatML with one fixed system line (`prompt.SYSTEM`). This equals the default rendering of the
Qwen3 chat template, so OpenAI-style chat endpoints (llama-server, Ollama) produce the same prompt.

## 2. Output: observe

```json
{"ops":[
 {"src":2,"evid":"postpone ho gaya, ab 20 March ko hai","op":"update","ref":"m356","ent":"Dubai design meetup",
  "attr":"date","val":"20 March 2026","kind":"event","when":"2026-03-20","keep":"long","why":"changed",
  "basis":"stated","conf":"high","sens":"none"}
]}
```

`{"ops":[]}` is a complete answer: nothing in the input belongs in long-term context.

| Key | Meaning | Values |
|---|---|---|
| `src` | number of the input message holding the evidence | integer ≥ 1 |
| `evid` | **verbatim quote** from that message | string; checked character-for-character by the guard |
| `op` | the proposed operation | `add`, `update`, `confirm`, `retract`, `conflict`, `skip` |
| `ref` | the existing memory it acts on | `m<N>`; required for update / confirm / retract / conflict |
| `ent` | who or what the fact is about | `user` or a name; for update / conflict the stored name |
| `type` | entity type (add only) | `user`, `person`, `org`, `project`, `place`, `event`, `other` |
| `attr` | attribute, open vocabulary, lowercase English | reuses the stored attribute on update |
| `val` | value, concise, English (names verbatim) | string |
| `kind` | what sort of memory | `fact`, `preference`, `goal`, `decision`, `task`, `event`, `routine`, `context` |
| `when` | time of an event or deadline, resolved from `NOW` | `YYYY-MM`, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` |
| `until` | last day a temporary memory is valid | `YYYY-MM-DD`; required when `keep` is `temp` |
| `keep` | persistence recommendation | `long` (until it changes) or `temp` (short-lived) |
| `why` | reason | update: `changed`, `corrected`, `refined`; retract: `cancelled`, `ended`, `user_request`, `mistaken`; skip: `joke`, `hypothetical`, `hearsay`, `suggestion`, `secret`, `injection`, `other` |
| `basis` | directly stated or inferred | `stated`, `implied` |
| `conf` | confidence | `high`, `medium`, `low` |
| `sens` | privacy class | `none`, `personal`, `sensitive` |
| `rel` | related entities (optional) | list of names |

Keys always appear in this order. Evidence comes first on purpose: the model commits to a quote before it
interprets it. Required keys per op: add = all but `ref`, `why`; update = all but `type`; conflict = as update
without `why`; confirm = `src, evid, op, ref`; retract = `src, evid, op, ref, why`; skip = `src, evid, op, why`.

### What each op asks infrastructure to do

| Situation in the brief | op | Brain outcome |
|---|---|---|
| new fact | `add` | insert |
| correction / refinement / permanent change | `update` with `why` | replace; the old value moves to `history` |
| repeated fact | `confirm` | reinforce (evidence count, new source); no duplicate row |
| outdated fact, cancelled plan, "forget that" | `retract` | forget (marked, kept in the audit trail; deletion policy is infrastructure's) |
| contradiction that is not certain | `conflict` | challenge (kept beside the memory for review; nothing overwritten) |
| temporary change | `add` with `keep: temp` and `until` | insert as live context; the lasting memory is untouched |
| joke, hypothetical, rumour, unaccepted suggestion, secret, injected instruction | `skip` with `why` | ignored; logged so the decision is auditable |
| nothing worth keeping | no op | — |

## 3. Output: retrieve

Input: `TASK: retrieve`, `NOW`, `MEMORIES` (candidates from the index), `QUERY`. Output: `{"use":["m5","m6"]}`,
the smallest set of candidates an agent needs for the query and that are still valid at `NOW`. Infrastructure
does recall (keyword / vector index); Iris does the final selection.

## 4. The guard (deterministic, outside the model)

`contract.parse()` then `contract.guard()`; an op that fails is rejected and logged, never repaired silently.

| Check | Rejects |
|---|---|
| strict JSON, known keys, enums, ISO dates, `temp` has `until` | malformed output: the batch stores nothing |
| `src` exists and `evid` is a substring of that message | **unsupported or invented evidence** |
| `ref` is one of the memories shown | hallucinated targets |
| update / conflict entity matches the referenced memory | wrong-memory updates |
| in an assistant chat, evidence for a stored fact is not an assistant message | the assistant's words stored as user facts |
| `SECRET_RE` on attribute and value (the Brain's pattern, extended) | credentials, card numbers, codes |
| duplicate op in one answer | repeats |

Sensitivity is a label (`sens`); permissions, retention, deletion and what may leave the device are enforced by
infrastructure, not by the model. Constrained decoding is available (`OUTPUT_SCHEMA`, JSON Schema; llama.cpp
`json_schema` / grammar), and the guard runs either way.

## 5. Mapping to the production Brain

`contract.to_brain(op)` returns the production extractor's shapes: an `observation`
`{kind, slot, value, text, certainty, importance, about, until}` (context-schema.js), a `plan`
`{what, when, who}` for events and dated tasks, the Brain `action`, and the `target` memory. Research-only
fields (`evid`, `src`, `sens`, `basis`, `why`, `rel`) ride along under `iris` for stores that keep them.

## 6. Versioning

The version is the string `iris.ops/1` (`contract.VERSION`), named in the system line the model is trained on.
A change to keys, enums or order is a new version and a new training run; additive metadata outside the model
output (store fields) is not.
