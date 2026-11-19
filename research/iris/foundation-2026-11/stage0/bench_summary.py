#!/usr/bin/env python3
"""Summarise llama-bench JSON files (stage 0) into bench.json, with per-session time estimates for the wave-A runs.

llama-bench command (per model, this container, 4 threads, llama.cpp 7a4117e):
    llama-bench -m <gguf> -t 4 -p 512,2048 -n 128 -r 2 -o json > bench-<name>.json

Per-session estimate = prompt tokens / pp2048 rate + generated tokens / tg128 rate, with the zero-shot prompt length
measured for each tokenizer (model_verification.json, val mean) and 350 generated tokens (mean of the 10 Qwen3-0.6B
parity sessions was 387; the old zero-shot run 274). Session-equivalents per system: 240 observe (open + closed) +
64 retrieve at 0.4 + 30 unconstrained = 296 (EVAL-PLAN §7).

    python3 foundation-2026-11/stage0/bench_summary.py <dir with bench-*.json>
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROMPT_TOKENS = {"Qwen3-0.6B": 1225, "Qwen3-1.7B": 1225, "Qwen3.5-2B": 1227, "gemma-4-E2B": 1212, "Qwen3-4B-Instruct-2507": 1225}
GEN_TOKENS = 350
SESSION_EQUIV = 296


def main(d):
    out = {"llama_cpp": "7a4117eef97e (2026-11-19)", "threads": 4, "machine": "this container, 4 vCPU Xeon (AVX-512/AMX), 15 GB",
           "assumptions": {"generated_tokens_per_session": GEN_TOKENS, "session_equivalents_per_system": SESSION_EQUIV}, "models": {}}
    for f in sorted(Path(d).glob("bench-*.json")):
        try:
            rows = json.loads(f.read_text())
        except ValueError:
            continue
        name = f.stem[len("bench-"):]
        r = {}
        for x in rows:
            r["pp%d" % x["n_prompt"] if x["n_gen"] == 0 else "tg%d" % x["n_gen"]] = round(x["avg_ts"], 1)
        key = next((k for k in PROMPT_TOKENS if name.startswith(k)), None)
        pt = PROMPT_TOKENS.get(key, 1225)
        sec = pt / r["pp2048"] + GEN_TOKENS / r["tg128"]
        out["models"][name] = {"file_GiB": round(rows[0]["model_size"] / 2**30, 2), "params_in_gguf_B": round(rows[0]["model_n_params"] / 1e9, 2),
                               **r, "est_seconds_per_zero_shot_session": round(sec, 1),
                               "est_cpu_hours_per_system": round(sec * SESSION_EQUIV / 3600, 2),
                               "est_seconds_per_finetuned_batch": round(600 / r["pp512"] + 200 / r["tg128"], 1)}
    out["wave_a_cpu_hours"] = round(sum(m["est_cpu_hours_per_system"] for m in out["models"].values()), 1)
    (HERE / "bench.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
