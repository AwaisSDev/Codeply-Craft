"""Budget-bounded, resumable API realisation of a plan file in chunks (DECISIONS.md 2026-11-03).

Each chunk is sized so its worst case fits the ledger's remaining budget. Stops at --target realised plans or when
the next chunk would be smaller than --min-chunk. Re-running continues where it stopped (done ids are read back
from the chunk directories).

    python -m data.api_chunks --plans P.jsonl --out DIR --ledger L.json --target 3000 --max-tokens 4500
"""
import argparse
import json
import os
import subprocess
import sys

PRICE_IN, PRICE_OUT = 4.00, 20.00          # Opus 5.5, USD per 1M tokens; batch halves it


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plans", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--target", type=int, default=3000)
    ap.add_argument("--max-tokens", type=int, default=4500)
    ap.add_argument("--max-chunk", type=int, default=900)
    ap.add_argument("--min-chunk", type=int, default=50)
    ap.add_argument("--margin-usd", type=float, default=1.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    plans = [json.loads(l) for l in open(a.plans)][:a.target]
    k = 0
    while True:
        done = set()
        for d in sorted(os.listdir(a.out)):
            p = os.path.join(a.out, d, "batch.json")
            if os.path.exists(p):
                done |= set(json.load(open(os.path.join(a.out, d, "ids.json"))))
        k = len([d for d in os.listdir(a.out) if d.startswith("chunk-")])
        todo = [p for p in plans if p["id"] not in done]
        led = json.load(open(a.ledger))
        pending = [b for b in led["batches"] if b.get("actual_usd") is None]
        if pending:                                              # an earlier chunk was submitted but not collected
            b = pending[0]
            subprocess.run([sys.executable, "-m", "data.realize_api", "collect", "--plans", os.path.join(b["out"], "plans.jsonl"),
                            "--model", "claude-opus-5-5", "--ledger", a.ledger, "--out", b["out"]], check=True)
            continue
        left = led["budget_usd"] - led["spent_usd"] - a.margin_usd
        per_ep_worst = (4000 * PRICE_IN + a.max_tokens * PRICE_OUT) / 1e6 / 2
        n = min(a.max_chunk, len(todo), int(left / per_ep_worst))
        print(f"done {len(done)}, todo {len(todo)}, budget left ${left:.2f}, next chunk {n}", flush=True)
        if n < a.min_chunk or not todo:
            print("stopping: target reached or budget exhausted", flush=True)
            break
        d = os.path.join(a.out, f"chunk-{k:02d}")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "plans.jsonl"), "w") as f:
            for p in todo[:n]:
                f.write(json.dumps(p) + "\n")
        json.dump([p["id"] for p in todo[:n]], open(os.path.join(d, "ids.json"), "w"))
        subprocess.run([sys.executable, "-m", "data.realize_api", "run", "--plans", os.path.join(d, "plans.jsonl"), "--model",
                        "claude-opus-5-5", "--effort", "medium", "--max-tokens", str(a.max_tokens), "--max-usd",
                        f"{left:.2f}", "--ledger", a.ledger, "--out", d], check=True)
        subprocess.run([sys.executable, "-m", "data.realize_api", "collect", "--plans", os.path.join(d, "plans.jsonl"),
                        "--model", "claude-opus-5-5", "--ledger", a.ledger, "--out", d], check=True)


if __name__ == "__main__":
    main()
