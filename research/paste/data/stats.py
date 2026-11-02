"""Episode statistics (DATASET-DESIGN.md §9).

    python -m data.stats <file.jsonl> [...] [--json out.json]

Token counts use the Ettin tokenizer. "M1c input" estimates the tokens M1c reads per segment: the segment plus
every record rendered as text plus every temporary item as text (spec §9.1); PASTE reads the segment plus
r + T + E + 2K prefix tokens.
"""
import argparse
import collections
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from data.plan import CATEGORIES  # noqa: E402

PERSISTENT = ("WRITE", "UPDATE", "MERGE_INTO", "FORGET", "FORGET_PROFILE", "MERGE")


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0


def summarise(eps, tok):
    seg_counts, sess_counts, seg_tok, m1c_tok, paste_tok, store_k, temp_t = [], [], [], [], [], [], []
    routes, ops, subtypes, cats, langs, deps = (collections.Counter() for _ in range(6))
    dep_by_kind = collections.defaultdict(collections.Counter)
    n_seg = real = lookalike_eps = merges = promote = 0
    for ep in eps:
        segs = ep["segments"]
        seg_counts.append(len(segs)); sess_counts.append(len({s["session_id"] for s in segs}))
        lookalike_eps += bool(ep.get("lookalike_names"))
        for s in segs:
            n_seg += 1
            langs[s["lang"]] += 1
            for c in s["categories"]:
                cats[c] += 1
            real += any(p.get("act") == "real" for p in s.get("plan", []))
            K, T = len(s["store_before"]), len(s["temp_before"])
            E = len({r["entity"] for r in s["store_before"]} | {"user"})
            store_k.append(K); temp_t.append(T)
            if tok is not None:
                n = len(tok.encode(s["text"]).ids)
                rec = sum(len(tok.encode(f"{r['profile_text']} · {r['attribute']}: {r['value']}").ids) - 1 for r in s["store_before"])
                tmp = sum(len(tok.encode(t["text"]).ids) - 1 for t in s["temp_before"])
                seg_tok.append(n); m1c_tok.append(n + rec + tmp); paste_tok.append(n + 4 + T + E + 2 * K)
            for u in s["units"]:
                routes[u["route"]] += 1
                if u["dep"]:
                    deps["1" if u["dep"] == 1 else "2-4" if u["dep"] <= 4 else ">=5"] += 1
                    dep_by_kind[u["category"]][u["dep"]] += 1
            for r in s["retrieve"]:
                if r["dep"]:
                    deps["1" if r["dep"] == 1 else "2-4" if r["dep"] <= 4 else ">=5"] += 1
            for x in s["expire"]:
                dep_by_kind["expire"][x["dep"]] += 1
            for o in s["gold_ops"]:
                ops[o["op"]] += 1
                if o["op"] == "UPDATE":
                    subtypes[o["subtype"]] += 1
                promote += "promote" in o
                merges += o["op"] == "MERGE"
    out = {
        "episodes": len(eps), "segments": n_seg,
        "segments_per_episode": {"mean": round(statistics.mean(seg_counts), 1), "p50": pct(seg_counts, .5), "max": max(seg_counts)},
        "sessions_per_episode": {"mean": round(statistics.mean(sess_counts), 2), "max": max(sess_counts)},
        "store_records_K": {"mean": round(statistics.mean(store_k), 1), "p95": pct(store_k, .95), "max": max(store_k)},
        "temporary_items_T": {"mean": round(statistics.mean(temp_t), 2), "max": max(temp_t)},
        "units_by_route": dict(routes), "gold_ops": dict(ops), "update_subtypes": dict(subtypes),
        "gold_persistent_ops": sum(ops[k] for k in PERSISTENT), "promotions": promote, "merges": merges,
        "segments_with_category": {c: cats[c] for c in CATEGORIES},
        "language_segments": dict(langs), "real_text_segments": real, "episodes_with_lookalike_names": lookalike_eps,
        "dependency_distance_units_and_retrievals": dict(deps),
    }
    if tok is not None:
        out["tokens_segment"] = {"mean": round(statistics.mean(seg_tok), 1), "p95": pct(seg_tok, .95), "max": max(seg_tok)}
        out["tokens_input_PASTE"] = {"mean": round(statistics.mean(paste_tok), 1), "p95": pct(paste_tok, .95), "max": max(paste_tok)}
        out["tokens_input_M1c_est"] = {"mean": round(statistics.mean(m1c_tok), 1), "p95": pct(m1c_tok, .95), "max": max(m1c_tok)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json")
    a = ap.parse_args()
    tok = None
    try:
        from tokenizers import Tokenizer
        from paste.modernbert import ettin_files
        tok = Tokenizer.from_file(ettin_files("ettin-encoder-32m")[1])
    except Exception as e:  # noqa: BLE001
        print(f"(no tokenizer: {e})", file=sys.stderr)
    res = {}
    for f in a.files:
        eps = [json.loads(l) for l in open(f)]
        res[os.path.basename(f)] = summarise(eps, tok)
    print(json.dumps(res, indent=1))
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
