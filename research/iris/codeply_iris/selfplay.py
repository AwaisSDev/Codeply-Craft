"""Self-output training data: teach Iris to read stores built from its own (imperfect) earlier answers.

    python -m codeply_iris.selfplay --model <merged dir | gguf> [--adapter <lora>] --raw data/raw \
        --out data/built/train-selfplay.jsonl [--shards tr01 tr02] [--limit 40]

A model trained only on gold stores sees, at inference, something it never saw in training: memories it wrote
itself, with missed facts, clumsy values, duplicates and false memories. This runs the current model in closed
loop over TRAIN episodes (never val or test), and for every session after the first writes a training example
whose input is the model's own store and whose target is re-derived from the teacher's labels against that
store (`store.derive_ops`): a fact the model missed earlier becomes an `add`, a value it got wrong becomes an
`update … corrected`, a false memory is simply left alone. Targets stay exact; only the history is the model's.
"""
import argparse
import json
from pathlib import Path

from . import build, contract, metrics, prompt
from .evaluate import Cache, run_observe
from .infer import Iris
from .store import MemoryStore, derive_ops


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--adapter", default="")
    ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--out", required=True)
    ap.add_argument("--shards", nargs="*", default=[], help="only these train shards (default: all teacher shards)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args(argv)
    eps, _ = build.load_raw(a.raw, "train")
    eps = [e for e in eps if (e["shard"] in a.shards if a.shards else not e["shard"].startswith("syn"))]
    if a.limit:
        eps = eps[:a.limit]
    system = Iris.load(a.model, adapter=a.adapter, threads=a.threads)
    out = Path(a.out)
    cache = Cache(out.with_suffix(".preds.jsonl"))
    n_ex, n_diff = 0, 0
    with out.open("w", encoding="utf-8") as f:
        for n, ep in enumerate(eps, 1):
            store = MemoryStore()
            for s in ep["sessions"]:
                today = s["now"][:10]
                rows = store.view(today)
                gold = derive_ops(s, rows)
                if s["sid"] > 1 and rows:
                    shown = [{k: v for k, v in r.items() if k != "key"} for r in rows]
                    ex = {"id": f"{ep['id']}-s{s['sid']}-self", "task": "observe", "split": "train", "episode": ep["id"],
                          "shard": ep["shard"], "sid": s["sid"], "variant": "self", "lang": ep["lang"], "source": s["source"],
                          "now": s["now"], "memories": rows, "messages": s["messages"],
                          "prompt": prompt.observe_prompt(s["now"], s["source"], shown, s["messages"]),
                          "target": contract.dumps(gold), "gold": gold}
                    f.write(json.dumps(ex, ensure_ascii=False) + "\n")
                    n_ex += 1
                    n_diff += any(r.get("key") is None for r in rows)
                names = sorted({m["ent"] for m in rows} | {g["ent"] for g in gold if "ent" in g})
                ops, rej, _, _, _ = run_observe(system, "iris", s, rows, names, cache, f"{ep['id']}-s{s['sid']}")
                _, keys = metrics.score_observe(ops, gold, rows, rej)
                for o in ops:
                    store.apply(o, session=s["sid"], key=keys.get(id(o)))
            if n % 5 == 0:
                print(f"  {n}/{len(eps)} episodes, {n_ex} examples", flush=True)
    print(f"wrote {n_ex} self-output examples ({n_diff} with at least one false memory in the store) to {out}")


if __name__ == "__main__":
    main()
