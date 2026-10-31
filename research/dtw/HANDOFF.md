# Decide-then-Write: handoff (read this first in a new session)

Branch `codeply-li-dtw-experiment`. Mission: the approved Decide-then-Write
implementation (see `DECIDE-THEN-WRITE-IMPLEMENTATION.md`, `BENCHMARK-400.md`).
Production code and `main` stay untouched.

## State on 2026-10-31

* Done and committed: Benchmark-520 (+ blind second annotation), Decide model,
  heads in JS, time resolver, provider, Kaggle notebooks, results for
  Ettin-150M s1 (bench F1 0.306, gold 0.681, test-mini 1.000; INT4 0.300) and
  rules on the bench.
* `research/dtw/resume.sh` rebuilds the CPU environment and runs every
  remaining CPU experiment. It is safe to re-run: results already committed in
  `research/dtw/results/` are skipped, and trained models are restored from the
  orphan branch `dtw-artifacts` (heads + GGUF; big files split into `.partNN`)
  instead of retrained. Results are committed and pushed after each evaluation,
  models after each training.

  ```bash
  W=<scratchpad>/dtw setsid nohup research/dtw/resume.sh > <scratchpad>/dtw-resume.log 2>&1 < /dev/null &
  ```

## Main finding so far, and the next step

Ettin-150M trained on the 8,000 generated (templated) examples learns the
templates (test-mini 1.000) and over-tags real text (bench P 0.19, R 0.73).
The bottleneck is training-data realism, not the backbone, so every encoder vs
LFM3 comparison on generated data alone is unfair to the encoders.

Agreed next step (owner, 2026-10-31): build a realistic training set.

1. Public dialogue datasets with real human language, converted to our schema,
   licences checked for commercial use: PersonaChat + Dialogue NLI, Multi-Session
   Chat, CommitmentBank / FactBank (certainty), SARC / iSarcasm (jokes),
   MultiWOZ / SNIPS (plans), Roman Urdu / code-mixed sets.
2. Keep "nothing to remember" examples (labelled drop); remove only junk
   and duplicates.
3. Claude labels each example in the benchmark schema (kinds, certainty,
   evidence spans, merges, plans), using `benchmark/GUIDE.md` as the
   labelling guide, via the Message Batches API with structured outputs.
   `benchmark/validate.py` rejects anything whose spans or dates do not check
   out; hand-check ~100.
4. Pick the labeller by measurement: run Sonnet 5.5 (effort high) and Opus 5.5
   (effort high) on Benchmark-520 (testing the labeller only, never training
   on it), use Sonnet for the bulk if it is close, Opus for validator rejects
   and hard categories (Roman Urdu, contradictions).
5. Retrain Ettin-150M / 400M / mmBERT on it; fine-tune LFM3 on the same data
   (Kaggle); score everything on Benchmark-520, which is never trained on.

Environment variables expected: `ANTHROPIC_API_KEY` (labelling),
optionally `KAGGLE_USERNAME` + `KAGGLE_KEY` (GPU notebooks) and `HF_TOKEN`
(model uploads). The `GH_TOKEN` in the 2026-10-31 environment was invalid;
pushing works through the session's git proxy with the repo attached.
