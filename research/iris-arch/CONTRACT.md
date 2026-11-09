# `iris.v1`: the Iris output contract

Code: `irisarch/contract.py` (schema, `validate`, `verify_evidence`, `parse`, `admit`, `to_v0`, `to_brain_observation`).
Tests: `tests/test_contract.py`. Versioned: any change to fields or semantics bumps `iris.v2`; the runner refuses a
model whose declared version it does not know.

## Request (what the runner sends; ids are local to the request)

```json
{"mode": "observe", "now": "2026-11-09T10:05+05:00", "tz": "Asia/Karachi",
 "events":   [{"id": "ev1", "source": "assistant_chat", "at": "...", "trust": "user", "text": "..."}],
 "memories": [{"id": "m1", "kind": "decision", "slot": "atlas launch date", "value": "December", "entity": "Atlas",
               "text": "...", "status": "confirmed", "updated": "..."}],
 "entities": [{"id": "e1", "name": "Atlas", "type": "project"}]}
```

`retrieve` requests carry `task` (+ `frontier: true|false`) and `memories`; `resolve` requests carry one memory with
its history and challengers plus the new events.

## Response (what Iris returns; JSON only, grammar-constrained)

```json
{"v": "iris.v1", "mode": "observe",
 "items": [{"op": "update", "ref": "m1",
            "entity": {"id": "e1", "name": "Atlas", "type": "project"}, "about": "project",
            "kind": "decision", "attribute": "atlas launch date", "value": "January",
            "text": "The Atlas launch moved to January.",
            "certainty": "stated", "basis": "stated", "confidence": 0.93,
            "valid": {"from": "2026-11-09"}, "privacy": {"level": "personal"},
            "persist": "store", "reason": "launch date changed",
            "evidence": [{"event": "ev1", "quote": "the Atlas launch moved to January"}]}],
 "plans": [], "relations": []}
```

| Field | Values | Meaning |
|---|---|---|
| `op` | add, reinforce, refine, update, correct, conflict, expire, link, ignore | ARCHITECTURE.md §4.3 |
| `ref` | a memory id from the request | required for reinforce, refine, update, correct, conflict, expire, link |
| `entity` | `{id?, name, type}` | `id` only for entities in the request's roster; a new entity has none |
| `about` / `kind` / `certainty` | Brain enums (`brain.js`) | unchanged from production |
| `attribute` | open text ≤ 80 (= Brain `slot`) | reuse the existing slot name when the memory exists |
| `basis` | stated, inferred | said outright vs concluded; `inferred` caps confidence at 0.9 |
| `valid` | `{from?, to?, temporary?}` ISO 8601 | validity interval; temporary changes end |
| `privacy` | `{level: public/personal/private/secret, category?}` | label only; enforcement is code |
| `persist` | store, session, ignore, reject | recommendation; the tier policy decides |
| `evidence` | ≤ 4 `{event, quote}` | verbatim quote from the named event; required except for ignore and link |
| `related`, `link` | ids, same_as / part_of / about / updates / contradicts / depends_on | for `link` |
| `reason` | ≤ 160 chars | short, for audit and the user's "why do you know this" |

Retrieve returns `picks[] {ref, relevance, why, stale?, share: yes/local_only/no}`, `conflicts[] {refs, note}`,
`missing[]`.

## Rules enforced by code (`validate`)

* ops that need a `ref` have one; `add` never has one; value-writing ops carry the full memory fields;
* joking / hypothetical / quoting information is never written (only `ignore`);
* secret-looking content must be labelled `secret`, and secrets are never `store`d;
* `basis: inferred` ≤ 0.9 confidence; temporary items with no end are `session`, not `store`;
* dates are ISO 8601; modes and their fields match.

## Grounding (`verify_evidence`)

Every quote must occur (whitespace / case folded) in the event it names; every event, memory and entity id must
come from the request; a `stated` value must appear in its own quotes (else it is `inferred`). The model cannot cite
or touch anything it was not shown.

## Failure handling (`admit`)

Unparseable or wrong-envelope output admits nothing; each failing item is dropped on its own and reported, never
repaired. The Context Engine logs `dropped` per run (`iris_runs`), retries a fully failed batch once, then falls
back to the rules extractor for that batch.
