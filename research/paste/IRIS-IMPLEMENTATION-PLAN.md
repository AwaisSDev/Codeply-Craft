# Iris 1: implementation steps (for owner review)

Status 2026-11-04: **proposed, not started** (except step 0 measurements, which use free compute only and change no
code path of the central test). Design: IRIS-DESIGN.md. Every step: research code only under `research/paste/`
(an `iris/` package next to `paste/`), production untouched, frozen central-test assets untouched, no API or paid
compute, all outputs backed up through `paste.backup` (append-only, private HF) and restorable on any Kaggle
account (RESTORE.md).

| Step | What | Compute | Deliverable / test | Gate |
|---|---|---|---|---|
| 0 | **Measurements** (IRIS-DESIGN §5): generator throughput + verifier pass rate on 50 fact sheets for Qwen3-4B, Qwen3-8B, Phi-4-mini; baseline extractor latency / RAM | this container + free Kaggle CPU; T4 only after the central runs finish | EXPERIMENTS entry with tokens/s, pass rate, CPU/GPU-hours per 1,000 conversations | none (free, measurement only) |
| 1 | **Schema v0** as code: JSON Schema + validators for observation / plan / relation (IRIS-DESIGN §2); Brain-row converter (drop extra fields) with a round-trip test against the production row format (fixtures, no production import) | CPU | `iris/schema.py`, tests | owner review of this plan |
| 2 | **Life simulator v2** (programmatic, extends the PASTE generator): lives, change events, commitments with status and conflicts, goals, sensitivity, agent tasks with gold context; fact sheets for rendering | CPU | `iris/sim/`, unit tests for gold consistency; 20 inspected lives | step 1 |
| 3 | **Renderer + verifier** with the model chosen in step 0; resumable Kaggle notebooks (time guard, HF snapshots of every batch) | free Kaggle CPU; T4 after central runs (≤ the weekly free quota left over) | `iris/render/`; pilot of 200 conversations, pass rate, manual review of 100 (EXPERIMENTS) | step 0 numbers |
| 4 | **IrisBench v0 freeze**: train / val / test / stress lives; hashes; private storage; `IRISBENCH-PROTOCOL.md` with primary metrics pre-registered | CPU | frozen test (never on Kaggle), manifest | step 3 pilot accepted |
| 5 | **Evaluator** for all layers of IRIS-DESIGN §3.4 (closed loop, Brain-compatible store with relations and sensitivity) + adapters for LongMemEval / REALTALK (commercial table) and LoCoMo / PerLTQA / HaluMem (separate non-commercial table) | CPU | `iris/eval/`, tests; dry run on validation stand-ins as for the central test | step 4 |
| 6 | **Baselines** on IrisBench val + public sets: production rules extractor (re-implemented), LFM3-1.7B Q4 with the production prompt, M1c / PASTE frozen checkpoints, zero-shot 0.5B / 1.5-2B / 4B open models | CPU (+ T4 for the larger zero-shot if quota allows) | baseline table (EXPERIMENTS); the bar Iris must clear | step 5 |
| 7 | **Fine-tuning cost measurement** of a 1.5-2B extractor (short run) | 1 T4 session | GPU-hours for a full run; compute request only if it exceeds free quota | step 6 |
| 8 | Iris extractor training (generative, §2 contract) + small always-on gate (PASTE-derived) | free T4 quota; more only with an approved request | IrisBench val results; frozen test only under a pre-registered protocol | step 7 + owner approval if paid compute |

Order relative to the central test: the central runs keep priority on the T4 quota (from 2026-11-07); steps 1-2 and
5 are CPU work and run in parallel; steps 3 (on GPU), 6 (larger models), 7 and 8 use GPU only after the central runs
are done or with whatever free quota is left in a week.

Persistence (owner requirement): datasets, generated conversations, fact sheets, verifier logs, configs, checkpoints,
logs and results are snapshotted to the private HF repos (`paste-data` for data, `paste-checkpoints` for runs) at
every batch boundary; notebooks restore from HF on any account; frozen splits additionally recorded by sha256 in git.
