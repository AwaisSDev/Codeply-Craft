# Iris in Codeply: integration design

All changes land on an integration branch behind a setting (`context.iris = off | shadow | on`), never on main
without the owner. `shadow` runs Iris next to the current extractor and logs both without writing, for comparison on
staff machines.

## 1. Seams (existing code, read-only map 2026-11-09)

| Seam | Today | Iris |
|---|---|---|
| `context-model.js` provider `extract({events, known, now, tz, projects})` | rules / cloud / local LFM3 | new provider `iris` (local llama-server, `iris.v1` grammar); builds the request (local ids), calls, `admit()`s, maps back |
| `brain.setLearner(fn)` | routes exchanges to the Context Engine | unchanged; Iris sits behind the engine |
| `brain.observe(raw, src)` | single write gate (value match, challenger, history, locks) | stays the gate; new op-aware entry `brain.apply(item, src)` for reinforce / refine / update / correct / conflict / expire / link by id |
| `brain.setRetriever(fn)` + `contextBlock({... semantic})` | cosine z-scores | Iris `retrieve` picks (relevance, stale, share) feed `contextBlock`; block shows memory ids |
| Challenger / `review = 1` | user resolves on the Brain page | Iris `resolve` proposes; the user still confirms anything that replaces a locked memory |
| `context-tiers.js` (logprob confidence, 5:1) | memory model | reused; thresholds recalibrated for Iris on val |
| `rollback-memories.mjs` | undoes the memory model's writes | every Iris write tagged `iris_run`; same tool undoes it |
| Life store items | never become memories | Context Engine collectors feed calendar / mail / call summaries as events (sources the user enabled) |

## 2. Brain schema (additive, nullable)

`memories`: `entity_id, about, basis, privacy, privacy_category, valid_from, valid_to, evidence_quote, evidence_event,
iris_op, iris_conf, iris_run`. New tables: `entities (id, type, name, created_at)`, `entity_aliases (entity_id,
alias)`, `links (a, b, kind, created_at, iris_run)`, `iris_runs (id, at, model, request_hash, output, admitted,
dropped, ms)`. Old rows and old code keep working; `prune()` also runs on a daily timer.

## 3. Runner (Node, in the Context Engine)

```js
// context-iris.js (sketch): one batch in, admitted operations out
async function irisObserve(batch, brain, runtime) {
  const cands = await recall(batch, brain);              // entities + BM25 + vectors -> <= 30 memories
  const { request, toStore } = localize(batch, cands);   // m1.., e1.., ev1.. ; keeps the map
  const raw = await runtime.complete(prompt(request), { grammar: IRIS_V1_GRAMMAR, temperature: 0, logprobs: true });
  const { admitted, report } = admit(raw, request);      // port of irisarch/contract.py, same tests
  log(report);
  for (const it of admitted.items || []) brain.apply(unlocalize(it, toStore), { product: 'iris', run: report.run });
  return report;
}
```

The JavaScript `admit` is a port of `contract.py` and runs the same test vectors (exported from the Python tests as
JSON), so the two cannot drift.

## 4. Privacy routing

Iris is local only. Requests are built after `context-redact`; secrets never reach it. `retrieve` with
`frontier: true` drops everything not `share: yes` and all `private` / `secret` items in `contextBlock`, whatever the
model says (E52 boundary).

## 5. Rollout

`off` → `shadow` on staff machines (compare against the current extractor for a week; counts only in reports, as the
memory model's opt-in report) → `on` for staff with the stop-and-rollback triggers of the memory model's plan
(> 25 % of writes forgotten or corrected, any secret stored, duplicates > 1 in 10, failures > 1 %, p95 > 30 s).
