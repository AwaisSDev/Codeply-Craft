"""Full calibration (EVALUATION-PROTOCOL §5), validation only, identical for every system. Used to freeze the
thresholds of central-test checkpoints (FROZEN-RUNS.json).

  1. theta_R (retrieve): teacher forced on the gold store, maximise retrieval F1 (read only: does not change the
     store, so no replay is needed).
  2. theta_W (write): closed-loop replay per grid point, minimise 3*FP + FN over persistent operations. Choices at
     2:1 and 5:1 are also recorded (protocol §5 "also reported").
  3. theta_F (forget): closed loop, given theta_W, same cost.
  4. theta_M (merge, D1): closed loop, given theta_W and theta_F, same cost; merges still need the write gate.
  theta_X (expire) stays at the analytic 0.5 for every system (deviation recorded in DECISIONS.md: closed-loop
  temporary items are the system's own and have no one-to-one gold labels, and expiry is a secondary metric).
  Temperatures for the gate and retrieve heads are fitted on teacher-forced val for reporting calibration (ECE)
  only; thresholds make them irrelevant to decisions.

Each closed-loop configuration is replayed once and cached by its threshold tuple.

    python -m paste.calibrate_full --run RUN_DIR --val V1.jsonl V2.jsonl [--limit 0] [--out calibration-full.json]
"""
import argparse
import json
import os

import torch
import torch.nn.functional as F

from .adapter import PasteAdapter
from .config import PasteConfig
from .data import segment_gold
from .evaluate import OPS, evaluate, model_propose
from .modernbert import ettin_files
from .text import Text
from .train import load_eps, make_model

G_W = (0.5, 0.8, 0.9, 0.95, 0.98)
G_F = (0.5, 0.7, 0.9)
G_M = (0.5, 0.7, 0.9, 0.95)
G_R = tuple(round(0.05 * i, 2) for i in range(1, 20))


def _f1(tp, fp, fn):
    return 2 * tp / max(1, 2 * tp + fp + fn)


def _ece(p, y, bins=10):
    e, n = 0.0, len(p)
    for b in range(bins):
        m = (p >= b / bins) & (p < (b + 1) / bins if b < bins - 1 else p <= 1)
        if m.any():
            e += m.sum().item() / n * abs(p[m].mean().item() - y[m].float().mean().item())
    return round(e, 4)


def _temperature(logits, y):
    t = torch.zeros(1, requires_grad=True)                   # log T
    opt = torch.optim.LBFGS([t], max_iter=100)
    def closure():
        opt.zero_grad()
        l = F.binary_cross_entropy_with_logits(logits / t.exp(), y.float())
        l.backward()
        return l
    opt.step(closure)
    return float(t.exp())


@torch.no_grad()
def teacher_forced_scores(model, adapter, episodes):
    """Gate logits vs PERSIST labels over gold units; retrieve logits vs gold retrieve labels over records."""
    g_l, g_y, r_l, r_y = [], [], [], []
    for ep in episodes:
        model.clear_cache()
        for seg in ep["segments"]:
            s_in, gold = segment_gold(adapter, seg, None)
            enc = model.encode([s_in])[0]
            for u in gold["units"]:
                g_l.append(float(model.unit_outputs(enc, u["span"])["gate"])); g_y.append(u["route"] == "PERSIST")
            if enc.att.shape[0]:
                lr = model.heads.retrieve_logits(enc.prof[enc.rec_prof], enc.att, enc.val, enc.seg.mean(0))
                r_l += lr.tolist(); r_y += gold["retrieve"]
    return torch.tensor(g_l), torch.tensor(g_y), torch.tensor(r_l), torch.tensor(r_y, dtype=torch.bool)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--val", nargs="+", required=True)
    ap.add_argument("--limit", type=int, default=0, help="first N episodes per val file (0 = all)")
    ap.add_argument("--tf-limit", type=int, default=200, help="episodes per val file for the teacher-forced part")
    ap.add_argument("--ckpt", default="final.pt")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--out", default="calibration-full.json")
    a = ap.parse_args()
    if any("frozen" in v or "/test-" in v or "/stress-" in v for v in a.val):
        raise SystemExit("calibration uses validation data only")
    torch.set_num_threads(a.threads)
    conf = json.load(open(os.path.join(a.run, "config.json")))
    cfg = PasteConfig.from_run(conf)
    text = Text(ettin_files(cfg.backbone)[1])
    model = make_model(conf["system"], cfg, text)
    model.load_state_dict(torch.load(os.path.join(a.run, a.ckpt), weights_only=False, map_location="cpu")["model"])
    model.eval()
    eps, tf_eps = [], []
    for v in a.val:
        e = load_eps([v])
        eps += e[:a.limit] if a.limit else e
        tf_eps += e[:a.tf_limit]
    out = {"run": a.run, "ckpt": a.ckpt, "val_files": a.val, "limit": a.limit, "tf_limit": a.tf_limit, "cost_ratio": 3.0}

    # 1. teacher-forced: theta_R and temperatures (reporting)
    g_l, g_y, r_l, r_y = teacher_forced_scores(model, PasteAdapter(model, text), tf_eps)
    p_r = torch.sigmoid(r_l)
    rows_r = []
    for th in G_R:
        pred = p_r >= th
        tp, fp, fn = int((pred & r_y).sum()), int((pred & ~r_y).sum()), int((~pred & r_y).sum())
        rows_r.append({"theta_R": th, "F1": round(_f1(tp, fp, fn), 4)})
    th_r = max(rows_r, key=lambda r: (r["F1"], -abs(r["theta_R"] - 0.5)))["theta_R"]
    temps = {}
    for name, (lg, y) in {"gate": (g_l, g_y), "retrieve": (r_l, r_y)}.items():
        if len(lg):
            T = _temperature(lg, y)
            temps[name] = {"T": round(T, 4), "ece_raw": _ece(torch.sigmoid(lg), y), "ece_scaled": _ece(torch.sigmoid(lg / T), y)}
    out["retrieve"] = {"grid": rows_r, "theta_R": th_r}
    out["temperature"] = temps
    print(json.dumps({"theta_R": th_r, "temperature": temps}), flush=True)

    # 2-4. closed loop, coordinate descent with caching
    cache = {}

    def run(w, f, m):
        key = (w, f, m)
        if key not in cache:
            thr = dict(cfg.thresholds, write=w, forget=f, merge=m, retrieve=th_r, expire=0.5)
            with torch.no_grad():
                s, _ = evaluate(eps, model_propose(PasteAdapter(model, text, thresholds=thr)))
            fp = sum(s["per_op"][k]["fp"] for k in OPS); fn = sum(s["per_op"][k]["fn"] for k in OPS)
            cache[key] = {"theta_W": w, "theta_F": f, "theta_M": m, "fp": fp, "fn": fn, "PE": s["PE"],
                          "FPM": s["FPM_per_100_segments"], "precision": s["precision"], "recall": s["recall"],
                          "merge_PR": s["merge_PR"], "forget_profile": s["per_op"]["FORGET_PROFILE"], "forget": s["per_op"]["FORGET"]}
            print(json.dumps(cache[key]), flush=True)
        return cache[key]

    cost = lambda r, c=3.0: c * r["fp"] + r["fn"]
    f0 = cfg.thresholds["forget"]
    rows_w = [run(w, f0, max(w, cfg.thresholds["merge"])) for w in G_W]
    best_w = min(rows_w, key=lambda r: (cost(r), r["theta_W"]))
    out["theta_W_at_cost"] = {f"{c:g}:1": min(rows_w, key=lambda r: (cost(r, c), r["theta_W"]))["theta_W"] for c in (2.0, 3.0, 5.0)}
    w = best_w["theta_W"]
    rows_f = [run(w, f, best_w["theta_M"]) for f in G_F]
    f = min(rows_f, key=lambda r: (cost(r), r["theta_F"]))["theta_F"]
    rows_m = [run(w, f, m) for m in G_M]
    best = min(rows_m, key=lambda r: (cost(r), r["theta_M"]))
    out["theta_M_at_cost"] = {f"{c:g}:1": min(rows_m, key=lambda r: (cost(r, c), r["theta_M"]))["theta_M"] for c in (2.0, 3.0, 5.0)}
    out["closed_loop"] = list(cache.values())
    out["chosen"] = {"write": w, "forget": f, "merge": best["theta_M"], "retrieve": th_r, "expire": 0.5,
                     "PE": best["PE"], "FPM": best["FPM"]}
    json.dump(out, open(os.path.join(a.run, a.out), "w"), indent=1)
    print(json.dumps({"chosen": out["chosen"]}), flush=True)


if __name__ == "__main__":
    main()
