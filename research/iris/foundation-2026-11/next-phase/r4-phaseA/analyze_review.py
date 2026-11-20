#!/usr/bin/env python3
"""R4 Phase A analysis, committed before any review export existed. Read-only; writes analysis-v1.json.

Joins every export in reviews/ (schema r4-phaseA-review/1, packets v1 with the expected sha256) with key-v1.json.
Per stratum, per author (opus / sonnet), per origin (teacher label / model output) and per language:
  * decision distribution (remember / update / retract / skip / unsure);
  * agreement of the human decision with the proposal's operation
    (add~remember, update~update, retract~retract, skip~skip; confirm / conflict count as "other"); unsure excluded;
  * the details verdict distribution (correct / partly / wrong / not applicable);
  * for teacher labels: human-measured label error rate = share where the human decision disagrees with the label's
    operation or the details are judged wrong, with a Wilson 95 % interval;
  * for model "false memories" (strict_incorrect content ops): share a human judges remember-worthy with correct or
    partly-correct details (metric / convention penalty, not a model error).
Overlap items reviewed by two or more reviewers: raw agreement and Cohen's kappa on the decision.
Exports that do not match the packet sha256 are refused, not mixed in.

    cd research/iris && python3 foundation-2026-11/next-phase/r4-phaseA/analyze_review.py
"""
import json, math
from collections import Counter, defaultdict
from pathlib import Path
HERE = Path(__file__).resolve().parent
KEY = json.loads((HERE / "key-v1.json").read_text())
SHA = KEY["meta"]["sha256"]
OPMAP = {"add": "remember", "update": "update", "retract": "retract", "skip": "skip"}


def wilson(k, n):
    if not n:
        return None
    p, z = k / n, 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 3), round(c + h, 3)]


def kappa(pairs):
    if not pairs:
        return None
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return round((po - pe) / (1 - pe), 3) if pe < 1 else None


exports, refused = [], []
for p in sorted((HERE / "reviews").glob("*.json")) if (HERE / "reviews").exists() else []:
    j = json.loads(p.read_text())
    if j.get("schema") != "r4-phaseA-review/1" or j.get("packets", {}).get("sha256") != SHA:
        refused.append(p.name)
        continue
    exports.append((p.name, j))
rows = []
for name, j in exports:
    who = j.get("reviewer_id") or j.get("reviewer_label") or name
    for d in j["decisions"]:
        k = KEY["key"].get(d["item"])
        if k and d.get("decision"):
            rows.append({"reviewer": who, **d, **{f"k_{a}": b for a, b in k.items()}})
out = {"exports": [n for n, _ in exports], "refused": refused, "reviewers": sorted({r["reviewer"] for r in rows}), "decisions": len(rows)}


def summarise(rs):
    dec = Counter(r["decision"] for r in rs)
    det = Counter(r.get("details") for r in rs)
    sure = [r for r in rs if r["decision"] != "unsure"]
    agree = sum(1 for r in sure if OPMAP.get(r["k_original_op"]["op"]) == r["decision"])
    res = {"n": len(rs), "decision": dict(dec), "details": dict(det),
           "agree_with_proposal_op": [agree, len(sure), wilson(agree, len(sure))]}
    teach = [r for r in sure if r["k_origin"] == "teacher_label"]
    if teach:
        err = sum(1 for r in teach if OPMAP.get(r["k_original_op"]["op"]) != r["decision"] or r.get("details") == "wrong")
        res["teacher_label_error_rate"] = [err, len(teach), wilson(err, len(teach))]
    fm = [r for r in sure if r["k_strict_status"] == "strict_incorrect" and r["k_original_op"]["op"] in ("add", "conflict")]
    if fm:
        ok = sum(1 for r in fm if r["decision"] == "remember" and r.get("details") in ("correct", "partly"))
        res["model_false_memory_judged_correct"] = [ok, len(fm), wilson(ok, len(fm))]
    return res


out["overall"] = summarise(rows) if rows else None
for dim in ("stratum", "author", "origin", "lang"):
    g = defaultdict(list)
    for r in rows:
        g[r[f"k_{dim}"]].append(r)
    out[f"by_{dim}"] = {k: summarise(v) for k, v in sorted(g.items())}
by_item = defaultdict(dict)
for r in rows:
    by_item[r["item"]][r["reviewer"]] = r["decision"]
pairs = [tuple(sorted(v.values())[:2]) for v in by_item.values() if len(v) >= 2]
out["overlap"] = {"items_with_two_reviewers": len(pairs), "raw_agreement": round(sum(a == b for a, b in pairs) / len(pairs), 3) if pairs else None,
                  "cohen_kappa": kappa(pairs)}
(HERE / "analysis-v1.json").write_text(json.dumps(out, indent=1) + "\n")
print(json.dumps({k: out[k] for k in ("exports", "refused", "decisions", "overlap")}, indent=1))
