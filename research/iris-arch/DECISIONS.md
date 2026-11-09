# Iris architecture decisions (iris-arch branch)

| # | Date | Decision | Evidence / reason |
|---|---|---|---|
| D1 | 2026-11-09 | One generative model (Qwen3.5-2B), three modes, not encoder heads or PASTE | LoRA generator beat Decide-then-Write by ≈ 0.24 F1 under a pre-registered protocol (`research/dtw/LORA-RESULTS.md`); memarch: data quality beats architecture; E50: neither PASTE nor M1c ranks memories above chance on LongMemEval |
| D2 | 2026-11-09 | Base: Qwen3.5-2B, Apache-2.0; fallback Gemma 4 E2B by a pre-registered smoke-test rule | LFM3 free only < US$10 M revenue (open legal B1); SmolLM3 lacks Urdu; Qwen3.5-2B: hybrid Gated DeltaNet, 262 K context, 201 languages, llama.cpp GDN kernels ([model card](https://ztlshhf.pages.dev/Qwen/Qwen3.5-2B-Base/blob/main/README.md?code=true), [GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF), [LFM3 licence](https://huggingface.co/LiquidAI/LFM3-1.7B), [Gemma 4 Apache-2.0](https://the-decoder.com/googles-gemma-4-is-now-available-with-apache-2-0-licensing-for-the-first-time/)); licences re-checked on model cards before release |
| D3 | 2026-11-09 | Output = typed operations against memory ids, with verbatim evidence checked by code | production false memories 25-42 %; slot drift duplicates (dup-03/04); merge-by-id from DTW |
| D4 | 2026-11-09 | The model never writes; `admit()` + `brain.observe/apply` decide | owner rule: deterministic infra enforces storage, permissions, deletion |
| D5 | 2026-11-09 | Labels from the life simulator; teacher only renders and writes hard slices, always verified | teacher output not automatically correct; E58: model checkers catch 0.68 of flawed renders |
| D6 | 2026-11-09 | No WildChat-derived data in Iris training | 81 % of the memory model's data is WildChat; owner kept it out of the public repo; legal T7 |
| D7 | 2026-11-09 | Own-history training round (anti exposure bias) before any DPO | mission requirement; closed-loop is the production condition |
| D8 | 2026-11-09 | Privacy boundary in code at context assembly | E52: 32 / 100 frontier tasks leaked; boundary → 0 with recall 0.956 |
| D9 | 2026-11-09 | Exact labelled-text overlap across splits is a hard gate; value novelty is measured, not required | sim v2 keeps a test-only value tail by design (`pools.split_values`); the gate fired only on placeholder renders (DATA.md §4) |
