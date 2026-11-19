#!/usr/bin/env python3
"""CPU vs GPU parity for the Kaggle move (EVAL-PLAN amendment A2). Read-only.

Compares, per model, the committed CPU reference run (parity-cpu/<model>, this container, llama.cpp 7a4117e CPU build)
with the GPU runs from the Kaggle check kernel (parity-gpu-a / parity-gpu-b: the same commands on T4 GPU 0 and GPU 1):
  prompt tokens identical      the same prompt reached the model (template, prompt version, data)
  answer identical             byte-identical generated answer
  ops identical                identical parsed operations after the contract parser
  metrics identical            identical IrisBench counts for the two episodes (strict metric code)
  GPU A == GPU B               run-to-run determinism on the GPU
Writes parity_report.json next to this script.

    python3 foundation-2026-11/stage1-kaggle/compare_parity.py <kaggle check output dir>/check
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
from codeply_iris import contract  # noqa: E402

MODELS = ["qwen3-0.6b", "qwen3-1.7b", "qwen3.5-2b", "gemma-4-e2b", "qwen3-4b-2507"]
KEYS = ("extraction_precision", "extraction_recall", "extraction_f1", "false_memory_share", "output_validity", "retrieval_f1")


def load(d):
    p = Path(d) / "preds-val-open.jsonl"
    return {json.loads(l)["id"]: json.loads(l) for l in p.read_text().splitlines() if l.strip()} if p.exists() else {}


def metrics(d):
    p = Path(d) / "result-val-open.json"
    return json.loads(p.read_text())["metrics"] if p.exists() else {}


def same_metrics(a, b):
    out = {}
    for k in KEYS:
        x, y = a.get(k), b.get(k)
        out[k] = (x == y) or (x != x and y != y)
    return all(out.values()), {k: (a.get(k), b.get(k)) for k in KEYS}


def compare(ref, other):
    ids = sorted(set(ref) & set(other))
    ans = lambda r: r.get("answer", r.get("raw", ""))
    return {"examples": len(ids), "missing": sorted(set(ref) ^ set(other)),
            "prompt_tokens_identical": sum(ref[i].get("prompt_tokens") == other[i].get("prompt_tokens") for i in ids),
            "answer_identical": sum(ans(ref[i]) == ans(other[i]) for i in ids),
            "ops_identical": sum(contract.parse(ans(ref[i]))["ops"] == contract.parse(ans(other[i]))["ops"] for i in ids),
            "first_divergent": [i for i in ids if ans(ref[i]) != ans(other[i])][:5]}


def main(check_dir):
    check = Path(check_dir)
    rep = {}
    for m in MODELS:
        cpu = HERE / "parity-cpu" / m
        ga, gb = check / "parity-gpu-a" / m, check / "parity-gpu-b" / m
        c, a, b = load(cpu), load(ga), load(gb)
        ok_ca, m_ca = same_metrics(metrics(cpu), metrics(ga))
        rep[m] = {"cpu_vs_gpu": compare(c, a), "gpu_a_vs_gpu_b": compare(a, b), "metrics_cpu_eq_gpu": ok_ca,
                  "metrics_cpu_vs_gpu": m_ca, "metrics_gpu_a_eq_b": same_metrics(metrics(ga), metrics(gb))[0]}
        x = rep[m]
        print(f"{m:14s} cpu~gpu answers {x['cpu_vs_gpu']['answer_identical']}/{x['cpu_vs_gpu']['examples']} "
              f"ops {x['cpu_vs_gpu']['ops_identical']} prompts {x['cpu_vs_gpu']['prompt_tokens_identical']} metrics_eq {ok_ca} | "
              f"gpuA~gpuB answers {x['gpu_a_vs_gpu_b']['answer_identical']}/{x['gpu_a_vs_gpu_b']['examples']} metrics_eq {x['metrics_gpu_a_eq_b']}")
    (HERE / "parity_report.json").write_text(json.dumps(rep, indent=1, default=str) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
