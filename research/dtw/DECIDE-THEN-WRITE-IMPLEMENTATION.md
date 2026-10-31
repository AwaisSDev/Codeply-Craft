# Decide-then-Write: the experimental implementation

Branch `codeply-li-dtw-experiment`. Everything lives in `research/dtw/`;
production code (`codeply-cli/`), the LFM3 pipeline and `main` are
untouched. The only shared file changed is the evaluation harness
(`ml/eval/run.mjs`), with two generic, backwards-compatible options (below).
Results of running it: `ENCODER-RESULTS.md`, `LFM3-CLASSIFIER-RESULTS.md`,
`HEAD-TO-HEAD.md`, `FINAL-DECISION.md`.

## 1. What it is

```
 events (normalised + redacted exactly as today) + now + known memories + projects
        │  runtime/dtw-input.mjs: one plain-text sequence; known memories as [m1]..[m8]
        ▼
 DECIDE  one encoder pass (llama-server --embedding --pooling none, GGUF)
        │  runtime/heads.mjs (the trained heads, in plain JS, microseconds):
        │    tag      per token: O / B-OBS / I-OBS / B-PLAN / I-PLAN
        │    span     per observation: kind (9) · certainty (6) · about (3) · importance
        │    merge    per observation: NEW or one of [m1]..[mK]; relation same / different
        │    gate     per input: anything to keep
        ▼
 EXECUTE (code, runtime/dtw-provider.mjs + runtime/time-resolve.mjs)
        │    plan `when` and context `until` from time expressions (English + Roman Urdu)
        │    merge by memory id: the target's slot (and value, when "same")
        │    value = the tagged span; text = the user's own clause; project from the event
        │    temporary ⇔ context consistency (the brain's rule)
        ▼
 WRITE   (optional, --dtw-writer lfm3) only for new memorable items and plans:
        │    LFM3 names the slot, normalises the value, writes the sentence, titles plans,
        │    in one schema-constrained call per batch
        ▼
 the extraction contract → checkExtraction (the existing guard) → brain.observe (unchanged)
```

## 2. Components

| File | What it does |
|---|---|
| `runtime/dtw-input.mjs` | Builds the encoder input; the single source of truth for training and runtime |
| `data/dump.mjs` | Dumps any harness-format set as Decide inputs, with the harness's own normalisation and redaction (`ml/eval/run.mjs eventsOf`) |
| `data/align.py` | Character spans for every target: exact `evidence` for the benchmark; value search (87 % verbatim) and word windows for the generated data. 99.8 % of 8,000 training examples fully aligned |
| `model/dtw_model.py` | The heads (`DecideHeads`), the multi-task loss, BIO decoding; `DecideEncoder` wraps any Hugging Face backbone (encoder, or causal with `causal=True`) |
| `model/train_encoder.py` | Full fine-tuning (or LoRA, or frozen backbone) on CPU or GPU; class-balanced losses; model selection on validation; temperature scaling for kind and certainty |
| `model/lfm3_features.py`, `model/train_lfm3_heads.py` | LFM3 + attached classifiers on CPU: frozen LFM3 token states from llama.cpp, then the same heads |
| `model/export_heads.py` | Heads → `heads.bin` + `heads.json` for Node |
| `model/parity.py` | llama.cpp vs PyTorch token states for a fine-tuned encoder |
| `runtime/heads.mjs` | The heads in JavaScript |
| `runtime/time-resolve.mjs` | Time expressions and their resolution |
| `runtime/dtw-provider.mjs` | The backend: `--provider module:research/dtw/runtime/dtw-provider.mjs` |
| `eval/analyze.mjs` | Head-to-head analysis with the harness's matching |
| `notebooks/*.ipynb` | Kaggle GPU runs (see `GPU-TRAINING.md`) |
| `run-queue.sh` | Every CPU experiment, in order |

## 3. Decisions and why

* **Spans, not generated values.** A value is the user's own words, so it is
  grounded by construction (the guard's "not in the events" check, which
  dropped 73 of LFM3's observations on test-mini, cannot fire).
* **Merge by id.** The merge head points at `[mK]`; the slot is copied from
  that memory, so the brain's slot logic reinforces, replaces or challenges
  exactly the memory the model chose. Slot drift (the cause of duplicate
  memories) cannot happen for merges.
* **Certainty decides storage.** Jokes, hypotheticals and quotes are still
  emitted with their certainty; the brain ignores them as it always has.
  Nothing new decides what is stored.
* **Dates in code.** Developed on generated validation data and the old
  39-example gold only (never on the benchmark): 66 / 66 plan dates and
  times right on validation; end times follow the guide's rules.
* **The writer is optional and narrow.** It never decides anything; it only
  words what the heads decided, so its tokens are counted separately as
  "generation that remains".
* **Same runtime.** The encoder runs in the existing llama.cpp build
  (`modern-bert`). Parity with PyTorch: mean token-state cosine 1.000,
  minimum 0.9986, tokenizer identical on 12 / 12 inputs. No new inference
  engine.

## 4. Harness changes (generic, backwards compatible)

* `--provider module:<file>`: an experimental backend in its own file
  (`createProvider(ctx) → { provider, runtimes }`); CPU seconds and peak RSS
  are summed over every server it runs.
* `--set-file <path>`: evaluate any set in the harness format.
Regression check: rules on the old gold set gives the same F1 (0.167).

## 5. What is deliberately not done

* No change to `brain.js`, the guard, the engine, prompts or settings.
* No new memory system; no new runtime; no new backbone.
* The benchmark was never used to train, tune thresholds or pick a model;
  model selection uses generated validation data.

## 6. Reproduce

```bash
# data
W=/tmp/dtw; mkdir -p $W
for s in train val test test-mini; do node research/dtw/data/dump.mjs ml/data/out/$s.jsonl > $W/$s.inputs.jsonl; python3 research/dtw/data/align.py $W/$s.inputs.jsonl $W/$s.spans.jsonl; done
# (the aligned files are also in research/dtw/data/out/*.gz)
# train (CPU: ~40 min for Ettin-150M on 4,000 examples x 2 epochs)
python research/dtw/model/train_encoder.py --model jhu-clsp/ettin-encoder-150m --train $W/train4k.spans.jsonl --val $W/val.spans.jsonl --out $W/runs/ettin150-s1 --epochs 2
# export (heads + GGUF) and evaluate: research/dtw/run-queue.sh does all of it
```
