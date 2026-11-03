"""End-to-end CPU latency of trained systems, interleaved (EVALUATION-PROTOCOL §4 efficiency; spec §8, §10.5).

Each repetition times one adapter.step (encode + heads + decoding + transition) per system, on the same segment and
the same store, round-robin, so drift in machine load hits every system equally. Settings at each K in
{8, 32, 128} (E = min(16, K/4) profiles, T = 8 temporary items, 4 threads, fp32):

  steady (primary, spec §8): PASTE's record cache is warm and 2 records change value each step, so 2 records
          are re-encoded, as in deployment ("usually 0-2 per segment"); text systems re-read everything anyway;
  cold:   PASTE's cache is cleared before every step;
  warm:   no record changes.

Reports p50 / p95 ms per system and setting, and PASTE / M1c ratios (§10.5: p50 at K = 32 must be <= 1.5x M1c).

    python tools/bench_systems.py --runs PASTE=RUN_DIR M1c=RUN_DIR [M1c+W=RUN_DIR] [--reps 30] --out OUT.json
"""
import argparse
import json
import os
import statistics
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from bench_cpu import SEG, T0, store  # noqa: E402
from paste.adapter import PasteAdapter  # noqa: E402
from paste.config import PasteConfig  # noqa: E402
from paste.modernbert import ettin_files  # noqa: E402
from paste.text import Text  # noqa: E402
from paste.train import make_model  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", required=True, help="NAME=RUN_DIR")
    ap.add_argument("--reps", type=int, default=30)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    systems = {}
    for spec in a.runs:
        name, d = spec.split("=", 1)
        conf = json.load(open(os.path.join(d, "config.json")))
        cfg = PasteConfig.from_run(conf)
        text = Text(ettin_files(cfg.backbone)[1])
        m = make_model(conf["system"], cfg, text)
        m.load_state_dict(torch.load(os.path.join(d, "final.pt"), weights_only=False, map_location="cpu")["model"])
        systems[name] = (m.eval(), PasteAdapter(m, text))
    res = {"threads": a.threads, "reps": a.reps, "runs": dict(s.split("=", 1) for s in a.runs), "results": []}
    for K in (8, 32, 128):
        E = min(16, max(2, K // 4))
        recs = store(K, E)
        states = {}
        for name, (m, ad) in systems.items():
            st = ad.empty_state()
            for i in range(8):
                st["items"].append({"id": f"t{i}", "type": "TASK", "ttl": "SESSION", "until": None, "created_at": T0,
                                    "created_seg": 0, "text": f"pending task number {i}: call the bank about the card",
                                    "z": torch.zeros(m.cfg.d)})
            st.update(session_id="s1", last_at=T0 - 60, seg_index=3)
            states[name] = ad.serialize(st)
        for setting in ("steady", "warm", "cold"):
            times = {n: [] for n in systems}
            for rep in range(a.reps + 3):
                if setting == "steady":                     # two records change value: re-encoded by PASTE
                    for j in (rep % K, (rep + 7) % K):
                        recs[j] = dict(recs[j], value=f"{recs[j]['value'].split(' #')[0]} #{rep}")
                for name, (m, ad) in systems.items():
                    if setting == "cold":
                        m.clear_cache()
                    with torch.no_grad():
                        t = time.perf_counter(); ad.step(SEG, recs, states[name]); dt = time.perf_counter() - t
                    if rep >= 3:                             # warm-up
                        times[name].append(dt * 1000)
            row = {"K": K, "E": E, "setting": setting}
            for n, ts in times.items():
                ts = sorted(ts)
                row[n] = {"p50_ms": round(statistics.median(ts), 1), "p95_ms": round(ts[int(0.95 * (len(ts) - 1))], 1)}
            if "PASTE" in times and "M1c" in times:
                row["PASTE/M1c_p50"] = round(row["PASTE"]["p50_ms"] / row["M1c"]["p50_ms"], 3)
            res["results"].append(row)
            print(json.dumps(row), flush=True)
    json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
