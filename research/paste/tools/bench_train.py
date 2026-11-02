"""Training-speed measurement (BASELINE-PLAN §3, step 1): teacher-forced PASTE steps on generated *train-split*
episodes with throwaway weights. Nothing is saved. Also times the encoder forward+backward at M1c's input lengths
(records as text) as a lower bound for M1c, which is not built yet.

    python tools/bench_train.py --episodes 12 [--device cpu|cuda]
"""
import argparse
import json
import os
import statistics
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from data.build import make_plans, finalize  # noqa: E402
from data.realize_prog import ProgRealizer  # noqa: E402
from paste.adapter import PasteAdapter  # noqa: E402
from paste.config import PasteConfig  # noqa: E402
from paste.data import episode_loss_teacher_forced  # noqa: E402
from paste.model import PasteModel  # noqa: E402
from paste.modernbert import ettin_files, load_backbone  # noqa: E402
from paste.text import Text  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=12)
    ap.add_argument("--backbone", default="ettin-encoder-32m")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--out")
    a = ap.parse_args()
    torch.manual_seed(0)
    import copy, hashlib
    plans = make_plans("train", a.episodes, seed=424242)             # a throwaway train-split seed; never test
    eps = [finalize(p, ProgRealizer("train", int(hashlib.sha256(p["id"].encode()).hexdigest()[:8], 16)).realize(copy.deepcopy(p)),
                    "train", "programmatic", p["id"]) for p in plans]
    cfg = PasteConfig.for_backbone(a.backbone)
    m = PasteModel(cfg, load_backbone(cfg)).to(a.device)
    ad = PasteAdapter(m, Text(ettin_files(a.backbone)[1])); m.train()
    opt = torch.optim.AdamW([{"params": m.enc.parameters(), "lr": 5e-5},
                             {"params": list(m.heads.parameters()) + m.memory_pathway_parameters(), "lr": 5e-4}])
    times, segs = [], []
    for i, ep in enumerate(eps):
        m.clear_cache()
        t = time.perf_counter()
        loss, n = episode_loss_teacher_forced(m, ad, ep)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0)
        opt.step(); opt.zero_grad()
        if a.device == "cuda":
            torch.cuda.synchronize()
        if i >= 2:                                                   # warm-up excluded
            times.append(time.perf_counter() - t); segs.append(n)
    sps = sum(segs) / sum(times)
    # M1c lower bound: encoder forward+backward at the measured M1c input lengths (pilot API p50 ~175, p95 ~264)
    enc_t = {}
    for L in (76, 175, 264):
        ids = torch.randint(1000, 40000, (1, L), device=a.device)
        ts = []
        for k in range(6):
            t = time.perf_counter()
            out = m.enc.encode_ids(ids); out.float().pow(2).mean().backward()
            if a.device == "cuda":
                torch.cuda.synchronize()
            ts.append(time.perf_counter() - t)
        enc_t[L] = round(1000 * statistics.median(ts[2:]), 1)
    res = {"device": a.device, "threads": torch.get_num_threads(), "backbone": a.backbone, "episodes_timed": len(times),
           "segments_timed": sum(segs), "paste_segments_per_s": round(sps, 2),
           "paste_ms_per_segment": round(1000 / sps, 1),
           "encoder_fwd_bwd_ms_at_tokens": enc_t,
           "note": "batch = 1 episode; teacher forced; heads run per unit in Python; M1c not built: encoder-only numbers are a lower bound"}
    if a.device == "cuda":
        res["gpu"] = torch.cuda.get_device_name(0); res["peak_gpu_mb"] = round(torch.cuda.max_memory_allocated() / 2**20)
    print(json.dumps(res, indent=1))
    if a.out:
        json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
