"""CPU latency and memory of the PASTE prototype (Phase 3; spec §8, hypothesis H4 is tested later on trained models).

Measures, at 4 threads, fp32, untrained spec-initialised weights:
  * adapter.step end to end (encode + all heads + decoding + transition) at K in {8, 32, 128} records,
    cold (record cache empty: every record is encoded once) and warm (records cached, the normal case);
  * the encoder alone at the same total input length, and at the length M1c would need (records as text);
  * peak resident memory (VmHWM) and the serialized temporary-state size.
Untrained heads tag an arbitrary number of units; the count is reported because head cost scales with it.

    PASTE_HF_CACHE=... python tools/bench_cpu.py [--backbone ettin-encoder-32m] [--reps 15]
"""
import argparse
import json
import os
import resource
import statistics
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from paste.adapter import PasteAdapter  # noqa: E402
from paste.config import PasteConfig  # noqa: E402
from paste.model import PasteModel  # noqa: E402
from paste.modernbert import ettin_files, load_backbone  # noqa: E402
from paste.text import Text, segment_text  # noqa: E402

T0 = 1_780_000_000.0
ROLES = ["sister", "brother", "coworker", "manager", "friend", "neighbour", "cousin", "dentist", "landlord", "trainer",
         "teacher", "doctor", "partner", "mother", "father"]
NAMES = ["Ayesha", "Bilal", "Sara", "Omar", "Hina", "Ali", "Zara", "Usman", "Mina", "Faraz", "Nadia", "Kamran", "Iqra", "Hamza", "Sana"]
ATTRS = [("home city", "Lahore"), ("favourite drink", "green tea"), ("birthday", "12 March"), ("employer", "Atlas Labs"),
         ("diet", "vegetarian"), ("phone model", "Pixel 9"), ("gym days", "Monday and Thursday"), ("allergy", "peanuts")]


def rss_peak_mb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmHWM"):
                return int(line.split()[1]) / 1024


def store(K, E):
    out = []
    for j in range(K):
        e = j % E
        ent = "user" if e == 0 else f"{ROLES[(e - 1) % len(ROLES)]}:{NAMES[(e - 1) % len(NAMES)]}"
        a, v = ATTRS[j % len(ATTRS)]
        out.append({"id": f"m{j}", "entity": ent, "profile_text": "the user" if e == 0 else f"{NAMES[(e-1) % len(NAMES)]} ({ROLES[(e-1) % len(ROLES)]})",
                    "attribute": f"{a} {j // len(ATTRS)}" if j >= len(ATTRS) else a, "value": v, "kind": "fact",
                    "status": "confirmed", "evidence": 1 + j % 3, "updated_at": T0 - 86400 * j})
    return out


SEG = {"turns": [{"speaker": "user", "text": "My sister Ayesha finally moved to Lahore last week, and since then I've switched "
                  "from coffee to green tea in the mornings. Also I'm calling the bank at 3pm today about my card, "
                  "remind me if I forget. Oh and my manager Bilal says the Atlas launch moved to Friday."},
                 {"speaker": "assistant", "text": "Got it. Good luck with the bank call, and congratulations to Ayesha on the move."}],
       "at": T0, "session_id": "s1"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backbone", default="ettin-encoder-32m")
    ap.add_argument("--reps", type=int, default=15)
    ap.add_argument("--fixed-units", type=int, default=0,
                    help="force the BIO taggers to emit this many units (and 2 mentions) instead of the untrained tagger's output")
    a = ap.parse_args()
    torch.set_num_threads(4)
    torch.manual_seed(0)
    base_rss = rss_peak_mb()
    cfg = PasteConfig.for_backbone(a.backbone)
    m = PasteModel(cfg, load_backbone(cfg)).eval()
    text = Text(ettin_files(a.backbone)[1])
    ad = PasteAdapter(m, text)
    if a.fixed_units:
        def tagger(starts, width):
            def f(x):
                t = torch.full((x.shape[0], 3), -10.0); t[:, 0] = 10.0
                for s0 in starts:
                    t[s0, :] = torch.tensor([-10.0, 10.0, -10.0])
                    for i in range(s0 + 1, min(s0 + width, x.shape[0] - 1)):
                        t[i, :] = torch.tensor([-10.0, -10.0, 10.0])
                return t
            return f
        m.heads.bio_unit.forward = tagger([10 + 25 * i for i in range(a.fixed_units)], 3)
        m.heads.bio_ent.forward = tagger([3, 40], 2)
    load_rss = rss_peak_mb()
    seg_ids, _ = text.encode(segment_text(SEG["turns"])[0], cfg.seg_max)
    # temporary state with T = 8 items
    st = ad.empty_state()
    for i in range(8):
        st["items"].append({"id": f"t{i}", "type": "TASK", "ttl": "SESSION", "until": None, "created_at": T0, "created_seg": 0,
                            "text": f"pending task number {i}: call the bank about the card", "z": torch.randn(cfg.d) * 0.1})
    st.update(session_id="s1", last_at=T0 - 60, seg_index=3, h=torch.randn(cfg.r_mem, cfg.d) * 0.1)
    st_json = ad.serialize(st)
    res = {"backbone": a.backbone, "fixed_units": a.fixed_units, "threads": torch.get_num_threads(), "segment_tokens": len(seg_ids),
           "params": sum(p.numel() for p in m.parameters()), "rss_mb_python_baseline": round(base_rss, 1),
           "rss_mb_after_load": round(load_rss, 1), "temp_state_json_bytes": len(json.dumps(st_json)), "runs": []}
    for K in (8, 32, 128):
        E = min(cfg.e_max, max(2, K // 4))
        recs = store(K, E)
        s_in, *_ = ad.build(SEG, recs, ad._prepare(ad.deserialize(st_json), SEG)[0])
        P = cfg.r_mem + len(s_in.temps) + len(s_in.profiles) + 2 * len(s_in.records)
        m1c_len = len(seg_ids) + sum(len(r.ids) - 1 for r in s_in.records) + sum(len(t.ids) - 1 for t in s_in.temps)
        cold, warm, units = [], [], []
        for i in range(a.reps + 2):
            m.clear_cache()
            t = time.perf_counter(); out = ad.step(SEG, recs, st_json); dt = time.perf_counter() - t
            if i >= 2:
                cold.append(dt)
            units.append(len(out["units"]))
        ad.step(SEG, recs, st_json)
        for i in range(a.reps):
            t = time.perf_counter(); ad.step(SEG, recs, st_json); warm.append(time.perf_counter() - t)
        def enc_only(n):
            ids = torch.randint(1000, 40000, (1, n)); ts = []
            with torch.no_grad():
                for i in range(a.reps + 2):
                    t = time.perf_counter(); m.enc.encode_ids(ids); ts.append(time.perf_counter() - t)
            return statistics.median(ts[2:])
        q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
        r = {"K": K, "E": len(s_in.profiles), "T": len(s_in.temps), "prefix_tokens": P, "paste_input_tokens": P + len(seg_ids),
             "m1c_input_tokens_est": m1c_len, "units_decoded": statistics.median(units),
             "step_ms_cold_p50": round(1000 * statistics.median(cold), 1), "step_ms_cold_p95": round(1000 * q(cold, 0.95), 1),
             "step_ms_warm_p50": round(1000 * statistics.median(warm), 1), "step_ms_warm_p95": round(1000 * q(warm, 0.95), 1),
             "encoder_only_ms_at_paste_len": round(1000 * enc_only(P + len(seg_ids)), 1),
             "encoder_only_ms_at_m1c_len": round(1000 * enc_only(m1c_len), 1), "rss_peak_mb": round(rss_peak_mb(), 1)}
        res["runs"].append(r)
        print(json.dumps(r))
    print(json.dumps({k: v for k, v in res.items() if k != "runs"}))
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", "results", "phase3"), exist_ok=True)
    with open(os.path.join(os.path.dirname(__file__), "..", "results", "phase3", f"bench-cpu-{a.backbone}{'-units' + str(a.fixed_units) if a.fixed_units else ''}.json"), "w") as f:
        json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
