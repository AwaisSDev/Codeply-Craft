# Evaluation

Every backend is scored through the same path the app uses: normalize the
events, redact, build the prompt, run the backend, apply the guard
(`checkExtraction`), and write to a fresh temporary brain.

```bash
node ml/eval/run.mjs --provider rules --set test
node ml/eval/run.mjs --provider local:qwen3-1.7b-q4 --set test-mini --threads 4
node ml/eval/run.mjs --provider openai --base-url http://127.0.0.1:11434/v1 --model qwen3:1.7b   # any local OpenAI-compatible server
node ml/eval/retrieval.mjs            # the brain's retrieval
node ml/eval/report.mjs > ml/results/RESULTS.md
node ml/finetune/gate.mjs ml/results/<run>.json
```

Sets: `test-mini` (92, every task 4 times; for CPU runs), `test` (800),
`val` (800), `gold` (39 hand-written, `gold.mjs`).

## Metrics

| Metric | Definition |
|---|---|
| Valid | The answer parsed and had an `observations` list |
| P / R / F1 | Over *memorable* observations (certainty stated, implied or temporary). A predicted one matches a gold one when at least half the gold slot+value words (or value words) appear in the prediction; one-to-one, greedy |
| F1 unseen | The same, only examples with held-out phrasing |
| Kind, Certainty | Accuracy on matched pairs |
| False mem. | Gold jokes, hypotheticals and quotes that the backend returned as memorable (lower is better) |
| Noise ok | Examples with nothing to keep where nothing memorable and no plan came back |
| Plans R | Gold plans found (by person or words); date and time accuracy are in the JSON |
| Mem. actions | For preference, decision, duplicate, contradiction, temporal and certainty tasks: a fresh brain is seeded with the example's known memories, the gold observations are applied (→ the brain's actions), then the backend's (→ its actions); the share of gold observations where both give the same action (added, reinforced, replaced, challenged, ignored) |
| Temporal | Live context matched with the same `until` |
| Imp. ρ | Spearman correlation of importance on matched pairs |
| Secrets | Secret values from the input that ended up in a memorable observation |
| Secrets (any) | `safety.secretsLeakedAny`: gold secrets anywhere in the guard's output (every observation, every field, and plans), not only memorable ones |
| Secrets (brain) | `safety.secretsInBrain`: gold secrets anywhere in a real brain after the guarded observations went in (twice, so challengers and history are exercised): stored memories with history and challengers, the change log, `contextBlock` and `recall` (SECURITY-SECRETS.md) |
| Injections | Injected instructions (in an email) whose words ended up in a memorable observation |
| ms p50/p95 | Wall time per example (one batch) |
| Peak MB | Peak resident memory of the llama-server process |
| CPU s/ex | CPU seconds the server used per example |

## Retrieval (`retrieval.mjs`)

Seeds a brain with 67 memories of one synthetic person (six projects, four
people, writing / coding / scheduling / lifestyle preferences, facts) and asks
22 agent-style requests. For each, "relevant" is every memory of the facet
the request is about.

| Metric | Definition |
|---|---|
| Block precision | Relevant memory lines in `contextBlock()` / all memory lines in it |
| Block recall | Relevant memories in the block / relevant memories |
| recall@10 | The `recall` tool's first 10 hits that are relevant / min(10, relevant) |

## Secret false positives (`secrets-fp.mjs`)

`node ml/eval/secrets-fp.mjs <set.jsonl> ...` puts each example's GOLD
answer through the redactor and the guard (no model): how many gold memories
and plans the secret checks would refuse, how many event texts without a
secret the redactor changes, and whether every gold secret is removed from
the input. Results are in SECURITY-SECRETS.md.

