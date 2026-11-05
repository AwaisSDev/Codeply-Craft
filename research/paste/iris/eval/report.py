"""One IrisBench report for a prediction file (open or closed loop): extraction metrics (iris.eval.extraction,
overall and per source) and pipeline metrics (iris.eval.pipeline) under the three privacy policies.

    python -m iris.eval.report --lives L.jsonl --pred P.jsonl --out R.json [--rendered R.jsonl]
Events whose LLM render failed verification are excluded for every system (they have no verified text).
"""
import argparse
import collections
import json

from . import extraction as X
from . import pipeline as PL


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lives", required=True)
    ap.add_argument("--pred", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rendered", help="with --ground: verified renders, to rebuild the event text")
    ap.add_argument("--ground", action="store_true",
                    help="drop observations with no meaningful word in the event text (production's grounding guard), keeping Iris fields")
    a = ap.parse_args()
    preds = collections.defaultdict(dict)
    meta = {}
    for r in map(json.loads, open(a.pred)):
        if r.get("event_id") and not r.get("error"):
            preds[r["life_id"]][r["event_id"]] = r["output"]
            meta = {"system": r.get("system"), "model": r.get("model")}
    lives = [json.loads(l) for l in open(a.lives)]
    lives = [l for l in lives if l["life_id"] in preds]
    if a.ground:
        from iris.baselines.production import _ground_terms
        from iris.baselines.run import event_text
        from iris.eval.pipeline import terms
        rend = {(r["life_id"], r["event_id"]): r for r in map(json.loads, open(a.rendered)) if r.get("ok")}
        for life in lives:
            for ev in life["events"]:
                out = preds[life["life_id"]].get(ev["event_id"])
                if not out:
                    continue
                k = (life["life_id"], ev["event_id"])
                src = set(terms(event_text(ev, rend.get(k)) if (ev["render"] != "llm" or k in rend) else ""))
                out["observations"] = [o for o in out.get("observations", []) if isinstance(o, dict) and
                                       any(w in src for w in _ground_terms(o))]
        meta["grounded"] = True
    ex, by_src, pipe = [], collections.defaultdict(list), {p: [] for p in ("none", "labels", "regex")}
    for life in lives:
        P = preds[life["life_id"]]
        for ev in life["events"]:
            if ev["event_id"] in P:
                c = X.score_event(ev, P[ev["event_id"]])
                ex.append(c); by_src[ev["source"]].append(c)
        for pol in pipe:
            pipe[pol].append(PL.score_life(life, P, policy=pol))
    rep = {**meta, "lives": len(lives), "events_scored": len(ex),
           "extraction": X.summarise(ex, len(ex)),
           "extraction_by_source": {s: {k: v for k, v in X.summarise(c, len(c)).items() if k in ("events", "precision", "recall", "f1", "false_memory_share")}
                                    for s, c in sorted(by_src.items())},
           "pipeline": {pol: {k: v for k, v in PL.summarise(rs).items() if k != "counts"} for pol, rs in pipe.items()}}
    json.dump(rep, open(a.out, "w"), indent=1)
    e, p = rep["extraction"], rep["pipeline"]["none"]
    print(json.dumps({"system": meta.get("system"), "model": meta.get("model"), "events": len(ex), "F1": e["f1"], "P": e["precision"],
                      "R": e["recall"], "false_mem_share": e["false_memory_share"], "state_acc": p["state_accuracy"],
                      "task_recall": p["task_context_recall"], "leaks": p["leaks"], "leaks_labels": rep["pipeline"]["labels"]["leaks"],
                      "leaks_regex": rep["pipeline"]["regex"]["leaks"]}))


if __name__ == "__main__":
    main()
