# Iris experiment log

Append-only. Times are UTC. Machine for everything below unless stated: this session's container, 4 CPU cores
(Intel Xeon, AMX / AVX-512 bf16), 15 GB RAM, no GPU; torch 2.15 (CPU), transformers 5.22, peft 0.21, llama.cpp
from the llama-cpp-python 0.3.36 source tree. Validation is used for decisions; test only where marked FINAL.

| # | Date | What | Data | Result | Status |
|---|---|---|---|---|---|
| I1 | 2026-11-09 | Audit of repositories and research branches | — | AUDIT.md. No Iris model existed; IrisBench v0 blocked by render fidelity (31-38 % renders with extra facts); strongest earlier model (LFM3 LoRA) and PASTE / M1c weights unreachable from here | done |
| I2 | 2026-11-09 | CPU LoRA throughput, candidates | random tokens, seq 768 | Qwen3-0.6B: 329 tok/s (batch 2, bf16, 11.1 GB), 260 tok/s (batch 1, 6.6 GB); fp32 144 tok/s. Qwen3.5-0.8B: 132 tok/s, 10.6 GB (reference DeltaNet kernels). `train/bench/RESULTS.md` | done |
| I3 | 2026-11-09 | Foundation selection | I2 + licence / language / runtime review | **Qwen3-0.6B** (FOUNDATION.md); Qwen3-1.7B is the GPU upgrade path | decided |
| I4 | 2026-11-09 | First attempt at teacher data: 17 shards in parallel | — | **Failed**: all 17 authors hit the account rate limit before writing anything. Restarted as one author at a time (owner instruction: one agent, Opus 5.5, medium effort) | superseded |
| I5 | 2026-11-09 | Teacher shard `tr01` (single author) | 14 episodes, 70 sessions, 227 facts, 21 % empty sessions, 36 skips, 42 queries; en 8, Roman Urdu 3, mixed 2, Urdu 1 | validator: 0 errors, 0 warnings. Author's doubts recorded in DATASET notes (corrected vs changed when a calendar disagrees with chat; long-lived `context`; kinship words as implied relations) | done |
| I6 | 2026-11-09 | Drill generator `data/synth.py` | 160 episodes, train only | 0 rejected by the validator; 22 % empty sessions; all skip types; Roman Urdu 35 % | done |
| I7 | 2026-11-09 | Trainer smoke test | drills + part of tr01 | loss 4.35 → 1.92 in 10 steps; stop and `--resume` continue from the saved step | done |
