"""Resumable trainer (spec §6; BASELINE-PLAN §2.3). Teacher-forced episodes with truncated BPTT, curriculum,
AdamW + warm-up + cosine, gradient clipping, gradient accumulation (16 episodes per step), periodic validation in
closed loop, atomic checkpoints with optimizer/scheduler/RNG state (a restarted run continues exactly).

    python -m paste.train --system PASTE --train A.jsonl[:n] B.jsonl[:n] --val V1.jsonl V2.jsonl --out RUN_DIR \
        --epochs 1 --seed 1 [--head-norm] [--val-limit 200] [--max-episodes 2000]
"""
import argparse
import json
import math
import os
import random
import time

import numpy as np
import torch

from .adapter import PasteAdapter
from .baselines import build
from .config import PasteConfig
from .data import episode_loss_teacher_forced
from .evaluate import evaluate, model_propose
from .tf_metrics import tf_metrics
from .model import PasteModel
from .modernbert import ettin_files, load_backbone
from .text import Text


def load_eps(specs):
    out = []
    for spec in specs:
        path, _, sl = spec.partition(":")
        rows = [json.loads(l) for l in open(path)]
        if sl:
            a, _, b = sl.partition("-")
            rows = rows[int(a or 0):int(b) if b else None]
        out += rows
    return out


def make_model(system, cfg, text):
    enc = load_backbone(cfg)
    return PasteModel(cfg, enc) if system == "PASTE" else build(system, cfg, enc, text)


def truncate(ep, k=4):
    """Curriculum: the first k segments of the first session only."""
    segs = [s for s in ep["segments"] if s["session_id"] == ep["segments"][0]["session_id"]][:k]
    return {**ep, "segments": segs}


def save(path, obj):
    tmp = path + ".tmp"
    torch.save(obj, tmp)
    os.replace(tmp, path)                 # atomic


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--system", required=True)
    ap.add_argument("--train", nargs="+", required=True, help="file[:from-to] episode slices")
    ap.add_argument("--val", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--max-episodes", type=int, default=0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--lr-enc", type=float, default=5e-5)
    ap.add_argument("--lr-new", type=float, default=5e-4)
    ap.add_argument("--accum", type=int, default=16)
    ap.add_argument("--curriculum", type=float, default=0.2)
    ap.add_argument("--closed-loop", type=float, default=0.0,
                    help="max share of closed-loop episodes; ramps 0 -> value between 40 %% and 80 %% of training (spec §6.3)")
    ap.add_argument("--head-norm", action="store_true")
    ap.add_argument("--flat-address", action="store_true")
    ap.add_argument("--val-limit", type=int, default=0, help="first N val episodes per val file")
    ap.add_argument("--ckpt-every", type=int, default=100, help="episodes between checkpoints")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--bio-weight", type=float, default=1.0, help="class weight of B/I tokens in the BIO losses (O = 1)")
    ap.add_argument("--val-tf", type=int, default=0, help="teacher-forced component metrics on the first N episodes of the first val file, at every checkpoint log")
    ap.add_argument("--corrupt-del", type=float, default=0.0, help="per-record drop rate of the gold store (teacher-forced episodes after the curriculum)")
    ap.add_argument("--corrupt-ins", type=float, default=0.0, help="per-segment probability of one spurious record in the gold store")
    ap.add_argument("--warmup", type=float, default=0.06, help="warm-up share of optimizer steps")
    a = ap.parse_args()
    if any(("frozen" in f or "/test-" in f or "/stress-" in f) for f in a.train + a.val):
        raise SystemExit("frozen test/stress data can never be used for training or validation")
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    json.dump(vars(a), open(os.path.join(a.out, "config.json"), "w"), indent=1)
    random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
    cfg = PasteConfig(head_norm=a.head_norm, flat_address=a.flat_address)
    text = Text(ettin_files(cfg.backbone)[1])
    model = make_model(a.system, cfg, text)
    ad = PasteAdapter(model, text)
    enc_params = list(model.enc.parameters())
    ids = {id(p) for p in enc_params}
    new_params = [p for p in model.parameters() if id(p) not in ids]
    opt = torch.optim.AdamW([{"params": enc_params, "lr": a.lr_enc}, {"params": new_params, "lr": a.lr_new}],
                            betas=(0.9, 0.98), weight_decay=0.01)
    train = load_eps(a.train)
    if a.max_episodes:
        train = train[:a.max_episodes]
    order = []
    rng = random.Random(a.seed)
    for _ in range(a.epochs):
        o = list(range(len(train))); rng.shuffle(o); order += o
    total_steps = math.ceil(len(order) / a.accum)
    warm = max(1, int(a.warmup * total_steps))
    lr_at = lambda step: (step + 1) / warm if step < warm else 0.5 * (1 + math.cos(math.pi * (step - warm) / max(1, total_steps - warm)))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_at)
    ck = os.path.join(a.out, "last.pt")
    pos, step = 0, 0
    if os.path.exists(ck):
        st = torch.load(ck, weights_only=False)
        model.load_state_dict(st["model"]); opt.load_state_dict(st["opt"]); sched.load_state_dict(st["sched"])
        pos, step = st["pos"], st["step"]
        random.setstate(st["py_rng"]); torch.set_rng_state(st["torch_rng"])
        print(f"resumed at episode {pos}/{len(order)}, step {step}", flush=True)
    log = open(os.path.join(a.out, "log.jsonl"), "a")
    t0, seg_count, run_loss, terms, gnorms = time.time(), 0, 0.0, {}, []
    tf_eps = load_eps([a.val[0]])[:a.val_tf] if a.val_tf else []
    pool = [r for ep in train[:300] for sg in ep["segments"] for r in sg["store_before"]] if a.corrupt_ins else []
    model.train()
    while pos < len(order):
        ep = train[order[pos]]
        if pos < a.curriculum * len(order):
            ep = truncate(ep)
        model.clear_cache()
        frac = pos / max(1, len(order))
        eps_cl = 0.0 if frac < 0.4 else a.closed_loop * min(1.0, (frac - 0.4) / 0.4)
        cl = random.Random(a.seed * 1_000_003 + pos).random() < eps_cl
        corrupt = None
        if (a.corrupt_del or a.corrupt_ins) and pos >= a.curriculum * len(order):
            corrupt = (random.Random(a.seed * 7919 + pos), a.corrupt_del, a.corrupt_ins, pool)
        loss, n = episode_loss_teacher_forced(model, ad, ep, closed_loop=cl, bio_w=a.bio_weight, terms=terms, corrupt=corrupt)
        (loss / a.accum).backward()
        seg_count += n; run_loss += float(loss.detach())
        pos += 1
        if pos % a.accum == 0 or pos == len(order):
            gnorms.append(float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)))   # pre-clip norm
            opt.step(); opt.zero_grad(); sched.step(); step += 1
        if pos % a.ckpt_every == 0 or pos == len(order):
            el = time.time() - t0
            rec = {"pos": pos, "of": len(order), "step": step, "loss": round(run_loss / max(1, a.ckpt_every), 4),
                   "seg_per_s": round(seg_count / max(el, 1e-9), 3), "lr_enc": sched.get_last_lr()[0], "time": time.time(),
                   "terms": {k: round(v / max(1, terms.get("_n", 1)), 4) for k, v in terms.items() if k != "_n"},
                   "grad_norm_median": round(float(np.median(gnorms)), 2) if gnorms else None,
                   "grad_norm_max": round(max(gnorms), 2) if gnorms else None}
            if tf_eps:
                rec["val_tf"] = tf_metrics(model, ad, tf_eps)
            log.write(json.dumps(rec) + "\n"); log.flush(); print(json.dumps(rec), flush=True)
            run_loss, terms, gnorms = 0.0, {}, []
            save(ck, {"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "pos": pos, "step": step,
                      "py_rng": random.getstate(), "torch_rng": torch.get_rng_state()})
    # closed-loop validation (default thresholds; calibration is a separate step)
    model.eval()
    res = {}
    for vf in a.val:
        eps = load_eps([vf])
        eps = eps[:a.val_limit] if a.val_limit else eps
        with torch.no_grad():
            summary, per_ep = evaluate(eps, model_propose(PasteAdapter(model, text)))
        res[os.path.basename(vf)] = summary
        json.dump(per_ep, open(os.path.join(a.out, f"val-per-episode-{os.path.basename(vf)}"), "w"))
    pooled_tp = sum(sum(r["per_op"][k]["tp"] for k in r["per_op"]) for r in res.values())
    pooled_fp = sum(sum(r["per_op"][k]["fp"] for k in r["per_op"]) for r in res.values())
    pooled_fn = sum(sum(r["per_op"][k]["fn"] for k in r["per_op"]) for r in res.values())
    res["pooled_PE"] = round(2 * pooled_tp / max(1, 2 * pooled_tp + pooled_fp + pooled_fn), 4)
    json.dump(res, open(os.path.join(a.out, "val.json"), "w"), indent=1)
    torch.save({"model": model.state_dict(), "config": vars(a)}, os.path.join(a.out, "final.pt"))
    print(json.dumps({"val_pooled_PE": res["pooled_PE"]}), flush=True)


if __name__ == "__main__":
    main()
