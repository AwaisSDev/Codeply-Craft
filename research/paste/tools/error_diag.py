"""Closed-loop error taxonomy on validation (validation only; any system).

Replays val episodes exactly as paste.evaluate does (same proposals, matching and execution) and classifies every
unmatched prediction (false positive) by cause, against the closed-loop gold of its segment and the raw gold ops:

  WRITE            no_gold_unit (span matches no gold unit text) | wrong_entity | wrong_attribute | value_mismatch |
                   duplicate (gold for the unit is UPDATE / MERGE_INTO / recovered WRITE on an existing fact) |
                   route_not_persist (span is a gold TEMP / IGNORE / FORGET unit)
  UPDATE/MERGE_INTO/FORGET  wrong_target | gold_is_write | value_mismatch (UPDATE) | no_gold_unit | other
  FORGET_PROFILE   gold_forget_dropped (the segment's gold FORGET was dropped because the system never wrote the fact)
                   | gold_forget_record (gold FORGET of an existing record) | other
  MERGE            other

    python tools/error_diag.py --run RUN_DIR --val V.jsonl [--limit 100] [--theta 0.9] --out OUT.json
"""
import argparse
import collections
import json
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from paste.adapter import PasteAdapter  # noqa: E402
from paste.config import PasteConfig  # noqa: E402
from paste.evaluate import OPS, Replay, execute, match_segment, model_propose, value_f1  # noqa: E402
from paste.modernbert import ettin_files  # noqa: E402
from paste.text import Text  # noqa: E402
from paste.train import load_eps, make_model  # noqa: E402


def unit_of(seg, text):
    """The gold unit whose text best overlaps the predicted evidence text (token F1 >= 0.5), else None."""
    best, bf = None, 0.0
    for u in seg["units"]:
        f = value_f1(text or "", u.get("text") or "")
        if f > bf:
            best, bf = u, f
    return best if bf >= 0.5 else None


def classify(p, seg, cl_gold, rep):
    op = p["op"]
    text = p.get("evidence", {}).get("text", "")
    u = unit_of(seg, text) if text else None
    raw = seg["gold_ops"]
    if op == "WRITE":
        if u is None:
            return "no_gold_unit"
        if u.get("route") != "PERSIST":
            return f"route_{u.get('route', 'none').lower()}"
        g = [g for g in cl_gold if g.get("unit") == u.get("tag")]
        if not g:
            g_raw = [g for g in raw if g.get("unit") == u.get("tag")]
            return "persist_unit_no_closed_loop_gold" if not g_raw else f"gold_{g_raw[0]['op'].lower()}_dropped"
        g = g[0]
        if g["op"] != "WRITE" or g.get("recovered"):
            return "duplicate" if g["op"] != "WRITE" else "recovered_write_mismatch"
        if p.get("new_entity") and not g.get("new_entity"):
            return "wrong_entity:pred_new_gold_existing"
        if not p.get("new_entity") and g.get("new_entity"):
            return "wrong_entity:pred_existing_gold_new"
        if not p.get("new_entity") and rep.gold_entity(p["entity"]) != g["entity"]:
            ge = g["entity"]
            pe = rep.gold_entity(p["entity"])
            if pe == "user" or ge == "user":
                return "wrong_entity:user_vs_other"
            same_rel = pe.split(":")[0] == ge.split(":")[0]
            return "wrong_entity:same_relation" if same_rel else "wrong_entity:other_profile"
        if p["payload"]["attribute"] != g["attribute"]:
            return "wrong_attribute"
        if value_f1(p["payload"]["value"], g["value"]) < 0.5:
            return "value_mismatch"
        return "wrong_entity:new_mention_mismatch" if p.get("new_entity") else "other"
    if op in ("UPDATE", "MERGE_INTO", "FORGET"):
        if u is None:
            return "no_gold_unit"
        g = [g for g in cl_gold if g.get("unit") == u.get("tag")]
        if not g:
            return f"route_{u.get('route', 'none').lower()}" if u.get("route") != "PERSIST" else "persist_unit_no_closed_loop_gold"
        g = g[0]
        if g["op"] == "WRITE":
            return "gold_is_write"
        if g["op"] != op:
            return f"gold_is_{g['op'].lower()}"
        if g.get("target") != p.get("target"):
            return "wrong_target"
        return "value_mismatch" if op == "UPDATE" else "other"
    if op == "FORGET_PROFILE":
        gf = [g for g in raw if g["op"] == "FORGET"]
        if gf:
            dropped = [g for g in gf if rep.by_provenance(g["fact"]) is None]
            return "gold_forget_dropped" if dropped else "gold_forget_record"
        if any(g["op"] == "FORGET_PROFILE" for g in raw):
            return "wrong_profile"
        return "no_forget_in_segment"
    return "other"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--val", nargs="+", required=True)
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--theta", type=float, default=0.9)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if any("frozen" in v or "/test-" in v or "/stress-" in v for v in a.val):
        raise SystemExit("validation data only")
    torch.set_num_threads(a.threads)
    conf = json.load(open(os.path.join(a.run, "config.json")))
    cfg = PasteConfig.from_run(conf)
    text = Text(ettin_files(cfg.backbone)[1])
    m = make_model(conf["system"], cfg, text)
    m.load_state_dict(torch.load(os.path.join(a.run, "final.pt"), weights_only=False, map_location="cpu")["model"])
    m.eval()
    thr = dict(cfg.thresholds, write=a.theta, merge=max(a.theta, cfg.thresholds["merge"]))
    res = {}
    for vf in a.val:
        propose = model_propose(PasteAdapter(m, text, thresholds=thr))
        fp, tp, fn = collections.Counter(), collections.Counter(), collections.Counter()
        for ep in load_eps([vf])[:a.limit]:
            rep, state = Replay(ep), None
            for seg in ep["segments"]:
                gold = rep.closed_loop_gold(seg)
                with torch.no_grad():
                    ops, state = propose(rep, seg, rep.rows(), state)
                t, f, n, fw, pairs = match_segment(rep, seg, ops, gold)
                matched = {id(p) for p, _ in pairs}
                for p in ops:
                    if id(p) not in matched and p["op"] in OPS:
                        fp[(p["op"], classify(p, seg, gold, rep))] += 1
                tp.update(t); fn.update(n)
                execute(rep, ops, pairs)
        out = collections.defaultdict(dict)
        for (op, why), c in sorted(fp.items(), key=lambda kv: -kv[1]):
            out[op][why] = c
        res[os.path.basename(vf)] = {"fp_by_cause": out, "tp": dict(tp), "fn": dict(fn), "episodes": min(a.limit, len(load_eps([vf])))}
        print(os.path.basename(vf), json.dumps(out), flush=True)
    json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
