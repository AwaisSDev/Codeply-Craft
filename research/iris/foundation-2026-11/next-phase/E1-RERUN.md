# E1 Transformers re-run: deviations and preflight (2026-11-20)

Owner decision of 2026-11-20: re-run only the five crashed Transformers cells. The approved changes:
* fix the missing torchao uninstall;
* run import and adapter-loading checks before GPU execution;
* preserve the GGUF outputs;
* keep the remaining GPU budget as a hard limit;
* change no prompts, decoding, scoring or model artifacts;
* if preflight fails, stop.

## Deviations from `E1-PROTOCOL.md`, recorded before the run's results

1. **Setup step added:** `pip uninstall -y torchao` before peft is imported. This is the historical r2 / r3 kernel's
   own step (`scripts/kaggle/run.py`). The protocol's runner, cells, prompts, decoding, scoring, artifacts and gates are
   unchanged (`e1_run.py` and `e1_expected.json` are byte-identical to the v1 run).
2. **Separate kernel** `codeply-iris-e1-eval-t` (Transformers cells only). The v1 kernel `codeply-iris-e1-eval` and its
   GGUF outputs stay untouched on Kaggle, and they are committed under `results/foundation-2026-11/e1/`. The re-run
   writes only `r2-T`, `p-T` and `r3-T`.
3. **GPU assignment.** The protocol ran all Transformers cells on GPU0 in one queue: 1 → 6 → 13 → 15 → 11. To fit the
   remaining budget, they are split:
   * GPU0: SC1 → 1 → 13;
   * GPU1, after SC1: 6 → 15;
   * cell 11 goes to whichever GPU frees first.

   Cell 6 therefore runs **concurrently** with cell 1, before G2 is known. The G2 rule is kept by enforcement: if cell
   1 misses G2, every running Transformers cell is killed and none is started. A cell 6 result is then reported as
   "not interpretable", not used.
4. **Hard limit:** 6,100 s of kernel time. The approved 3.5 GPU-hours minus the 6,197 s used by v1 leaves 6,403 s;
   about 5 min of that is kept as margin for container start-up. At the limit no cell starts, running cells are killed,
   and incomplete cells are reported, not re-run.
5. **New preflight gates** (added on the owner's instruction):
   * `env`: torchao absent after the uninstall, and the transformers and peft pins exact;
   * `preflight_adapters`: r2, r3 and the pilot adapter each load with peft, merge and generate 4 tokens;
   * `preflight_TG2`: the Transformers-path prompt for the pilot equals the official template, 15 / 15.

   Any failure stops the kernel before any cell.

## Preflight evidence before GPU execution

| Where | Result |
|---|---|
| Local CPU venv (torch 2.15 cpu, transformers 5.23.0, peft 0.21.3) | with torchao 0.10.0: the exact Kaggle error reproduced; after uninstall: r2, r3, pilot each load (196 / 196 LoRA modules), merge and generate |
| Kaggle CPU kernel `codeply-iris-e1-preflight-t` (same script, CPU mode, no GPU quota; 156 s) | torchao 0.10.0 found and removed; pins exact; base files at `70d244cc` verified; the three adapters load, merge, generate; TG2 15 / 15. **PREFLIGHT PASSED** |
| GPU kernel | the same checks again before SC1 (results in `E1-RESULTS.md` §7 after the run) |
