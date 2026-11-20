#!/usr/bin/env python3
"""Read-only measurements behind the weak-control diagnosis (NEXT-PHASE-ASSESSMENT.md §1). No model, no GPU.

Compares the historical Qwen3-1.7B runs (r2, r3: HF fp16, unconstrained, raw ChatML, drills, 3 / 2+ epochs) with the
pilot control (Q4_K_M GGUF, constrained, official template with an empty think block, drill-free, 2 epochs) on the same
validation data, using committed generations only. Writes control_diagnosis.json.

    cd research/iris && python3 foundation-2026-11/next-phase/control_diagnosis.py
"""
import json, math, random, sys
from collections import Counter
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(ROOT / "audit-r4"))
import report_run as R  # noqa: E402
from codeply_iris import confidence, contract, metrics  # noqa: E402

RUNS = {"r2": "results/gpu-r2/val/iris-1.7b-r2", "r3": "results/gpu-r2/val/iris-1.7b-r3",
        "pilot-1.7b": "results/foundation-2026-11/pilot-s1/qwen3-1.7b", "pilot-4b": "results/foundation-2026-11/pilot-s1/qwen3-4b-2507",
        "pilot-gemma": "results/foundation-2026-11/pilot-s1/gemma-4-e2b"}
out = {}

# same validation subset for checkpoint selection
vex = [json.loads(l) for l in (ROOT / "data/built/val.jsonl").read_text().splitlines() if l.strip()]
random.Random(0).shuffle(vex)
spec = json.loads((HERE.parent / "pilot/example-ids.json").read_text())
out["checkpoint_val_subset_identical"] = [e["id"] for e in vex[:120]] == spec["val"]

# training: logged configs and validation loss
def vlog(p):
    return [(r["step"], r["val_loss"]) for r in (json.loads(l) for l in (ROOT / p).read_text().splitlines()) if "val_loss" in r]
out["training"] = {
    "r2": {**{k: json.loads((ROOT / "results/gpu-r2/train/iris-1.7b-r2/config.json").read_text())[k] for k in ("epochs", "train_examples", "total_steps", "train_tokens_per_epoch")},
           "val_loss": vlog("results/gpu-r2/train/iris-1.7b-r2/train-log.jsonl")},
    "pilot-1.7b": {"epochs": 2, "train_examples": 826, "total_steps": 208, "train_tokens_per_epoch": 683464,
                   "val_loss": [(50, 0.343), (100, 0.2464), (150, 0.2234), (200, 0.2185), (208, 0.2181)],
                   "val_loss_source": "Kaggle kernel codeply-iris-pilot-train output runs/pilot-qwen3-1.7b-s1/train-log.jsonl (PILOT-S1-RESULTS.md §5)"}}
tr = [json.loads(l) for l in (ROOT / "data/built/train.jsonl").read_text().splitlines() if l.strip()]
for grp, sel in (("drills", lambda e: e["shard"] == "syn01"), ("teacher", lambda e: e["shard"] != "syn01")):
    obs = [e for e in tr if e["task"] == "observe" and sel(e)]
    n = [sum(1 for o in json.loads(e["target"])["ops"] if o["op"] != "skip") for e in obs]
    ops = Counter(o["op"] for e in obs for o in json.loads(e["target"])["ops"])
    out["training"][f"targets_{grp}"] = {"observe": len(obs), "no_store_op_share": round(sum(x == 0 for x in n) / len(obs), 3),
                                          "store_ops_per_target": round(sum(n) / len(obs), 2),
                                          "op_mix": {k: round(v / sum(ops.values()), 3) for k, v in ops.most_common()}}

# behaviour on identical validation sessions (open loop)
beh = {}
for name, d in RUNS.items():
    recs = R.records(ROOT / d, "val", "open")
    c = Counter()
    wrong_skip_p = []
    for r in recs:
        c["sessions"] += 1
        c["no_store_op"] += not [o for o in r["pred"] if o["op"] != "skip"]
        for o in r["pred"]:
            c[f"op_{o['op']}"] += 1
        skips = [o for o in r["pred"] if o["op"] == "skip"]
        hit = r["hit"]
        sc = confidence.op_scores(hit.get("answer", ""), hit.get("logprobs"), skips) if hit.get("logprobs") else [None] * len(skips)
        for s, x in zip(skips, sc):
            on_fact = any(g["op"] in contract.PERSISTENT_OPS and g["src"] == s["src"] and metrics.evid_overlap(s["evid"], g["evid"]) >= 0.5 for g in r["gold"])
            on_skip = any(g["op"] == "skip" and g["src"] == s["src"] and metrics.evid_overlap(s["evid"], g["evid"]) >= 0.5 for g in r["gold"])
            c["skip_on_labelled_fact"] += on_fact
            c["skip_on_labelled_skip"] += on_skip
            if on_fact and x is not None:
                wrong_skip_p.append(round(math.exp(x), 3))
    rep = R.report(recs, 60)
    beh[name] = {**dict(c), "strict": {k: rep["strict"][k] for k in ("extraction_precision", "extraction_recall", "extraction_f1")},
                 "wrong_skip_confidence": sorted(wrong_skip_p)}
out["open_loop_behaviour"] = beh

# constrained vs unconstrained on the same 30 sessions (first 6 val episodes)
cu = {}
for name in ("qwen3-1.7b", "qwen3-4b-2507", "gemma-4-e2b"):
    unc = R.records(ROOT / f"results/foundation-2026-11/pilot-s1/{name}-unconstrained", "val", "open")
    eps = {r["episode"] for r in unc}
    con = [r for r in R.records(ROOT / f"results/foundation-2026-11/pilot-s1/{name}", "val", "open") if r["episode"] in eps]
    cu[name] = {tag: {k: R.report(rr, 60)["strict"][k] for k in ("extraction_precision", "extraction_recall", "extraction_f1", "output_validity")}
                for tag, rr in (("constrained", con), ("unconstrained", unc))}
for lab in ("iris-1.7b-r2", "iris-1.7b-r3"):
    rr = [r for r in R.records(ROOT / f"results/gpu-r2/val/{lab}", "val", "open") if r["episode"] in eps]
    cu[lab + " (hf fp16, unconstrained)"] = {k: R.report(rr, 60)["strict"][k] for k in ("extraction_precision", "extraction_recall", "extraction_f1", "output_validity")}
out["constrained_vs_unconstrained_30_sessions"] = {"episodes": sorted(eps), **cu}
(HERE / "control_diagnosis.json").write_text(json.dumps(out, indent=1) + "\n")
print(json.dumps({k: v for k, v in out.items() if k != "open_loop_behaviour"}, indent=1)[:3000])
for k, v in beh.items():
    print(k, {x: v.get(x) for x in ("no_store_op", "op_add", "op_skip", "skip_on_labelled_fact", "skip_on_labelled_skip")}, v["strict"])
