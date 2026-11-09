"""IrisBench v1 runner.

    python -m codeply_iris.evaluate --system iris --model <dir|gguf> [--adapter <lora dir>] --split val
                                    [--closed-loop] [--limit N] --out results/<name>

Systems: iris | zeroshot (same weights or the untrained foundation, long instructions) | rules | production
(--model = a GGUF chat model) | nothing.

Open loop (default): every session with the gold store before it (data/built/<split>.jsonl), plus retrieval.
Closed loop: sessions in order per episode, each system reading the store its own guarded operations built;
gold operations are re-derived against that store (a missed fact's later update becomes an add), and the final
store is compared with the teacher's ledger.

Generations are cached in <out>/preds-*.jsonl, so an interrupted run continues where it stopped. The test split
is refused unless --final is given: it is read once per frozen system.
"""
import argparse
import json
import resource
import statistics
import time
from collections import Counter, defaultdict
from pathlib import Path

from . import baselines, build, contract, metrics, prompt
from .store import MemoryStore, derive_ops

HEADLINE = ("extraction_f1", "extraction_precision", "extraction_recall", "false_memory_share", "hard_negative_stored",
            "update_accuracy", "contradiction_resolution", "temporal_date_accuracy", "entity_linking_accuracy",
            "relation_f1", "persistence_accuracy", "store_decision_accuracy", "empty_session_accuracy",
            "retrieval_precision", "retrieval_recall", "retrieval_f1", "duplicate_detection_recall",
            "duplicates_created_rate", "ungrounded_evidence_rate", "output_validity")


def is_long(ex):
    words = sum(len(m["text"].split()) for m in ex["messages"])
    return words >= 450 or len(ex["messages"]) >= 14


class Cache:
    def __init__(self, path):
        self.path = Path(path)
        self.data = {}
        if self.path.exists():
            for l in self.path.read_text(encoding="utf-8").splitlines():
                if l.strip():
                    r = json.loads(l)
                    self.data[r["id"]] = r
        self.f = self.path.open("a", encoding="utf-8")

    def get(self, key):
        return self.data.get(key)

    def put(self, key, rec):
        rec = {"id": key, **rec}
        self.data[key] = rec
        self.f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self.f.flush()
        return rec


def make_system(a):
    if a.system in ("iris", "zeroshot"):
        from .infer import Iris
        kw = {} if a.system == "iris" else {"system": prompt.ZERO_SHOT_SYSTEM, "retrieve_system": prompt.ZERO_SHOT_RETRIEVE_SYSTEM}
        return Iris.load(a.model, adapter=a.adapter, threads=a.threads, constrain=a.constrain, **kw)
    if a.system == "rules":
        return baselines.Rules()
    if a.system == "production":
        return baselines.Production(a.model, threads=a.threads)
    return None


def run_observe(system, kind, session, memories, names, cache, key):
    """Guarded ops for one session from any system. Returns (ops, rejected, valid, ms, raw)."""
    hit = cache.get(key)
    shown = [{k: v for k, v in m.items() if k != "key"} for m in memories]
    if kind == "nothing":
        return [], [], True, 0, ""
    if kind in ("rules", "production"):
        if hit is None:
            ops, info = system.ops(session, shown, names)
            hit = cache.put(key, {"ops": ops, "ms": info["ms"], "valid": info["valid"]})
        ops = [o for o in hit["ops"] if not (o["op"] in contract.REF_OPS and o["ref"] not in {m["id"] for m in memories})]
        return ops, [], hit["valid"], hit["ms"], ""
    if hit is None:
        raw, st = system.observe_raw(session["now"], session["source"], shown, session["messages"])
        hit = cache.put(key, {"raw": raw, **st})
    parsed = contract.parse(hit["raw"])
    ops, rejected = contract.guard(parsed["ops"], session["messages"], shown, session["source"])
    rejected = [(o, f"schema_{why}") for o, why in parsed["dropped"]] + rejected
    return ops, rejected, parsed["ok"], hit["ms"], hit["raw"]


def open_loop(a, system, out):
    examples = [json.loads(l) for l in Path(a.data, f"{a.split}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    if a.limit:
        eps = sorted({e["episode"] for e in examples})[:a.limit]
        examples = [e for e in examples if e["episode"] in eps]
    cache = Cache(out / f"preds-{a.split}-open.jsonl")
    per_ep, slices, lat = defaultdict(Counter), defaultdict(Counter), {"observe": [], "retrieve": []}
    details = (out / f"details-{a.split}-open.jsonl").open("w", encoding="utf-8")
    t0 = time.time()
    for n, ex in enumerate(examples, 1):
        if ex["task"] == "observe":
            names = sorted({m["ent"] for m in ex["memories"]} | {g["ent"] for g in ex["gold"] if "ent" in g})
            ops, rej, valid, ms, raw = run_observe(system, a.system, ex, ex["memories"], names, cache, ex["id"])
            c, _ = metrics.score_observe(ops, ex["gold"], ex["memories"], rej)
            c["outputs"] += 1
            c["valid_outputs"] += bool(valid)
            lat["observe"].append(ms)
            tags = ["lang:en" if ex["lang"] == "en" else "lang:multilingual", f"lang:{ex['lang']}", f"source:{ex['source']}",
                    "long_input" if is_long(ex) else "short_input",
                    "store>=12" if len(ex["memories"]) >= 12 else "store<12"]
            details.write(json.dumps({"id": ex["id"], "pred": ops, "rejected": [(o, r) for o, r in rej], "gold": ex["gold"],
                                      "counts": {k: v for k, v in c.items() if v}}, ensure_ascii=False) + "\n")
        else:
            ids = {m["id"] for m in ex["memories"]}
            if a.system in ("iris", "zeroshot"):
                hit = cache.get(ex["id"])
                if hit is None:
                    shown = [{k: v for k, v in m.items() if k != "key"} for m in ex["memories"]]
                    raw, st = system.retrieve_raw(ex["now"], shown, ex["query"])
                    hit = cache.put(ex["id"], {"raw": raw, **st})
                parsed = contract.parse_use(hit["raw"], ids)
                use, valid, ms = parsed["use"], parsed["ok"], hit["ms"]
            elif a.system == "nothing":
                use, valid, ms = [], True, 0
            else:
                use, valid, ms = baselines.keyword_retrieve(ex["memories"], ex["query"], k=a.keyword_k), True, 0
            c = metrics.score_retrieve(use, ex["gold_use"])
            c["ret_trap_used"] += len(set(use) & set(ex.get("trap", [])))
            c["ret_trap_n"] += len(ex.get("trap", []))
            lat["retrieve"].append(ms)
            tags = ["lang:en" if ex["lang"] == "en" else "lang:multilingual"]
        per_ep[ex["episode"]].update(c)
        for t in tags:
            slices[t].update(c)
        if n % 25 == 0:
            print(f"  {n}/{len(examples)} examples, {time.time() - t0:.0f}s", flush=True)
    return per_ep, slices, lat


def closed_loop(a, system, out):
    eps, _ = build.load_raw(a.raw, a.split)
    if a.limit:
        eps = eps[:a.limit]
    cache = Cache(out / f"preds-{a.split}-closed.jsonl")
    per_ep, state, lat = defaultdict(Counter), defaultdict(Counter), {"observe": []}
    stores = (out / f"stores-{a.split}-closed.jsonl").open("w", encoding="utf-8")
    t0 = time.time()
    for n, ep in enumerate(eps, 1):
        store = MemoryStore()
        for s in ep["sessions"]:
            today = s["now"][:10]
            rows = store.view(today)
            gold = derive_ops(s, rows)
            names = sorted({m["ent"] for m in rows} | {g["ent"] for g in gold if "ent" in g})
            ops, rej, valid, ms, _ = run_observe(system, a.system, s, rows, names, cache, f"{ep['id']}-s{s['sid']}")
            c, keys = metrics.score_observe(ops, gold, rows, rej)
            c["outputs"] += 1
            c["valid_outputs"] += bool(valid)
            per_ep[ep["id"]].update(c)
            lat["observe"].append(ms)
            for o in ops:
                clean = {k: v for k, v in o.items() if not k.startswith("_")}
                store.apply(clean, session=s["sid"], key=keys.get(id(o)))
        last = ep["sessions"][-1]["now"][:10]
        led = build.ledger(ep)
        for f in led.values():
            if f["live"] and f.get("keep") == "temp" and (f.get("until") or "9") < last:
                f["live"] = False
        rows = store.view(last)
        state[ep["id"]].update(metrics.end_state(rows, led))
        stores.write(json.dumps({"episode": ep["id"], "store": rows, "ledger": led}, ensure_ascii=False, default=str) + "\n")
        if n % 5 == 0:
            print(f"  {n}/{len(eps)} episodes, {time.time() - t0:.0f}s", flush=True)
    return per_ep, state, lat


def pct(v, p):
    v = sorted(v)
    return v[min(int(p * len(v)), len(v) - 1)] if v else 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--system", required=True, choices=("iris", "zeroshot", "rules", "production", "nothing"))
    ap.add_argument("--model", default="")
    ap.add_argument("--adapter", default="")
    ap.add_argument("--split", default="val", choices=("val", "test", "train"))
    ap.add_argument("--data", default="data/built")
    ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--out", required=True)
    ap.add_argument("--closed-loop", action="store_true")
    ap.add_argument("--constrain", action="store_true", help="GGUF only: decode under the JSON Schema")
    ap.add_argument("--limit", type=int, default=0, help="first N episodes only")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--keyword-k", type=int, default=3)
    ap.add_argument("--final", action="store_true", help="required for the test split")
    ap.add_argument("--label", default="")
    a = ap.parse_args(argv)
    if a.split == "test" and not a.final:
        raise SystemExit("The test split is evaluated once per frozen system: pass --final (and record it in EXPERIMENTS.md).")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    system = make_system(a)
    mode = "closed" if a.closed_loop else "open"
    t0 = time.time()
    if a.closed_loop:
        per_ep, state, lat = closed_loop(a, system, out)
        slices = {}
    else:
        per_ep, slices, lat = open_loop(a, system, out)
        state = {}
    total = Counter()
    for c in per_ep.values():
        total.update(c)
    summary = metrics.summarise(total)
    res = {"system": a.system, "label": a.label or a.system, "model": a.model, "adapter": a.adapter, "split": a.split, "mode": mode,
           "episodes": len(per_ep), "constrained": bool(a.constrain), "metrics": summary,
           "ci95": metrics.bootstrap(per_ep, HEADLINE),
           "slices": {k: {m: v for m, v in metrics.summarise(c).items() if m in HEADLINE or m.startswith("n_")} for k, c in sorted(slices.items())},
           "latency_ms": {k: {"p50": statistics.median(v) if v else 0, "p95": pct(v, 0.95), "mean": round(sum(v) / len(v)) if v else 0,
                              "n": len(v)} for k, v in lat.items()},
           "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
           "wall_minutes": round((time.time() - t0) / 60, 1),
           "per_episode": {k: dict(v) for k, v in per_ep.items()}}
    if state:
        st = Counter()
        for c in state.values():
            st.update(c)
        res["end_state"] = metrics.summarise_state(st)
        res["per_episode_state"] = {k: dict(v) for k, v in state.items()}
    (out / f"result-{a.split}-{mode}.json").write_text(json.dumps(res, indent=1, default=float) + "\n")
    show = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in summary.items() if k in HEADLINE and v == v}
    print(json.dumps({"system": res["label"], "split": a.split, "mode": mode, **show, **res.get("end_state", {})}, default=float))


if __name__ == "__main__":
    main()
