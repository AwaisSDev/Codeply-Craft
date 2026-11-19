#!/usr/bin/env python3
"""Foundation-study report for one evaluated system (EVAL-PLAN §5). Read-only; replays cached generations.

Primary (closed loop): false memories per 100 sessions, P@60 (precision of the 60 highest-scored content ops; needs
the chat backend's log-probabilities), F0.5. Everything else in EVAL-PLAN §5 is reported alongside: strict IrisBench
metrics (unchanged code), per-op tables, the false-memory taxonomy (stage-0 version, below), slices, quote
compliance, think leaks, latency.

Taxonomy changes against failure_analysis.py (stage-0 audit, inspect_labels.json): a stored skip trap is detected
when the quotes overlap by >= 0.3, one contains the other, or their character spans overlap in the message (the
0.5 rule missed a planted injection whose quote continued the teacher's); an unmatched op on the same statement as a gold confirm / retract is its own category ("should
have acted on a stored memory") instead of "statement the teacher did not label".

    python3 foundation-2026-11/report_run.py results/foundation-2026-11/<system> [--split val] [--k 60]
"""
import argparse
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
from codeply_iris import build, confidence, contract, metrics  # noqa: E402
from codeply_iris.contract import squash  # noqa: E402
from codeply_iris.store import MemoryStore, derive_ops, same_value  # noqa: E402


def overlaps(a, b, t=0.3, text=None):
    """Same statement: token overlap >= t, one quote inside the other, or (given the message text) the two quotes'
    character spans overlap in the message. The span rule catches a model quoting the continuation of a sentence
    whose start the teacher quoted (stage-0 inspection item unlabelled-15, a planted injection)."""
    a, b = squash(a), squash(b)
    if metrics.evid_overlap(a, b) >= t or (a and b and (a in b or b in a)):
        return True
    if text and a and b:
        m = squash(text)
        i, j = m.find(a), m.find(b)
        if i >= 0 and j >= 0 and i < j + len(b) and j < i + len(a):
            return True
    return False


def classify(p, r):
    text = r["messages"][p["src"] - 1]["text"] if 1 <= p["src"] <= len(r["messages"]) else None
    for g in r["gold"]:
        if g["op"] == "skip" and g["src"] == p["src"] and overlaps(p["evid"], g["evid"], text=text):
            return "stored a skip trap"
    w = D.who(r["messages"], p["src"])
    if w == "assistant":
        return "quote from an assistant message"
    same = [g for g in r["gold"] if g["src"] == p["src"] and overlaps(p["evid"], g["evid"], 0.5)]
    content = [g for g in same if g["op"] in contract.PERSISTENT_OPS]
    if content:
        g = max(content, key=lambda g: metrics.value_sim(p.get("val", ""), g.get("val", "")))
        ent_ok = contract.norm(metrics.resolve_entity(p["ent"], [g["ent"]]) or p["ent"]) == contract.norm(g["ent"])
        val_ok = metrics.content_score(p, g) > 0
        if val_ok and not ent_ok:
            return "same value, different entity"
        gw, pw = g.get("when"), p.get("when")
        if ent_ok and gw and (not pw or pw[:10] != gw[:10]):
            return "same statement, date wrong or missing"
        return "same statement, different value / slot"
    if any(g["op"] in ("confirm", "retract") for g in same):
        return "should have acted on a stored memory"
    if w != "user" and not str(w).startswith(("email from user", "note", "calendar", "screen")) and p["ent"] == "user":
        return "other speaker's statement attributed to the user"
    return "statement the teacher did not label"


def scored_ops(rec, hit):
    """[(score, strict_correct)] for the guarded content ops of one session."""
    pairs, up, ug = D.pairs_of(rec["pred"], rec["gold"], rec["memories"])
    ok = {id(p) for p, g, e in pairs if e}
    content = [o for o in rec["pred"] if o["op"] in contract.PERSISTENT_OPS]
    lp = (hit or {}).get("logprobs")
    answer = (hit or {}).get("answer", (hit or {}).get("raw", ""))
    scores = confidence.op_scores(answer, lp, content) if lp else [None] * len(content)
    return [(s, id(o) in ok) for s, o in zip(scores, content)]


def records(run, split, loop):
    preds = {r["id"]: r for r in D.load_jsonl(run / f"preds-{split}-{loop}.jsonl")}
    recs = []
    if loop == "open":
        val = {e["id"]: e for e in D.load_jsonl(ROOT / "data" / "built" / f"{split}.jsonl") if e["task"] == "observe"}
        for k, ex in val.items():
            hit = preds.get(k)
            if hit is None:
                continue
            parsed = contract.parse(hit.get("answer", hit.get("raw", "")))
            ops, rej = contract.guard(parsed["ops"], ex["messages"], ex["memories"], ex["source"])
            rej = [(o, f"schema_{w}") for o, w in parsed["dropped"]] + rej
            c, _ = metrics.score_observe(ops, ex["gold"], ex["memories"], rej)
            c["outputs"] += 1
            c["valid_outputs"] += bool(parsed["ok"])
            rec = D.session_record(k, c, ops, rej, ex["gold"], ex["memories"], ex["messages"], ex["lang"], ex["source"], ex["sid"], ex["episode"])
            rec["hit"] = hit
            recs.append(rec)
        return recs
    eps, _ = build.load_raw(str(ROOT / "data" / "raw"), split)
    for ep in eps:
        store = MemoryStore()
        for s in ep["sessions"]:
            key = f"{ep['id']}-s{s['sid']}"
            hit = preds.get(key)
            if hit is None:
                break
            rows = store.view(s["now"][:10])
            gold = derive_ops(s, rows)
            shown = [{k: v for k, v in m.items() if k != "key"} for m in rows]
            parsed = contract.parse(hit.get("answer", hit.get("raw", "")))
            ops, rej = contract.guard(parsed["ops"], s["messages"], shown, s["source"])
            rej = [(o, f"schema_{w}") for o, w in parsed["dropped"]] + rej
            c, keys = metrics.score_observe(ops, gold, rows, rej)
            c["outputs"] += 1
            c["valid_outputs"] += bool(parsed["ok"])
            rec = D.session_record(key, c, ops, rej, gold, rows, s["messages"], ep["lang"], s["source"], s["sid"], ep["id"])
            rec["hit"] = hit
            recs.append(rec)
            for o in ops:
                store.apply({k: v for k, v in o.items() if not k.startswith("_")}, session=s["sid"], key=keys.get(id(o)))
    return recs


def report(recs, k):
    t = D.agg(recs)
    n = len(recs)
    s = metrics.summarise(t)
    tax, scored = Counter(), []
    quote = Counter()
    for r in recs:
        _, up, _ = D.pairs_of(r["pred"], r["gold"], r["memories"])
        for p in up:
            if any(contract.norm(m["ent"]) == contract.norm(p["ent"]) and same_value(m["val"], p["val"], m.get("when"), p.get("when"))
                   for m in r["memories"]):
                continue
            tax[classify(p, r)] += 1
        scored += scored_ops(r, r.get("hit"))
        for o, why in r["rejected"]:
            if why == "ungrounded_evidence" and isinstance(o, dict) and 1 <= o.get("src", 0) <= len(r["messages"]):
                pre = squash(r["messages"][o["src"] - 1]["who"]).lower() + ":"
                quote["speaker label in quote" if squash(o["evid"]).lower().startswith(pre) else "paraphrased / other"] += 1
    hits = [r["hit"] for r in recs if r.get("hit")]
    ms = [h.get("ms", 0) for h in hits]
    false_n = int(t["false_memory"])
    p_at_k = confidence.precision_at_k(scored, k) if any(x is not None for x, _ in scored) else None
    _, area = confidence.risk_coverage(scored) if any(x is not None for x, _ in scored) else (None, None)
    return {
        "sessions": n,
        "primary": {"false_memories_per_100_sessions": round(100 * false_n / n, 1) if n else None,
                    f"precision_at_{k}": None if p_at_k is None else round(p_at_k, 3),
                    "under_covering": len(scored) < k, "content_ops": len(scored),
                    "f0_5": round(confidence.f_beta(t["tp"], t["pred_content"], t["gold_content"]), 3),
                    "risk_coverage_area": None if area is None else round(area, 3)},
        "strict": {m: (round(v, 3) if isinstance(v, float) and v == v else v) for m, v in s.items()
                   if m in ("extraction_precision", "extraction_recall", "extraction_f1", "false_memory_share",
                            "update_accuracy", "contradiction_resolution", "temporal_date_accuracy", "entity_linking_accuracy",
                            "duplicate_detection_recall", "duplicates_created_rate", "retraction_precision", "retraction_recall",
                            "skip_recall", "hard_negative_stored", "empty_session_accuracy", "output_validity",
                            "ungrounded_evidence_rate", "guard_rejection_rate")},
        "by_operation": D.op_table(t), "skip_traps": D.skip_table(t),
        "false_memory_taxonomy": dict(tax.most_common()), "ungrounded_quote_patterns": dict(quote),
        "think": {"sessions_with_reasoning": sum(1 for h in hits if h.get("think_chars")),
                  "sessions_stopped_while_reasoning": sum(1 for h in hits if h.get("think_closed") is False),
                  "mean_reasoning_chars": round(statistics.mean([h.get("think_chars", 0) for h in hits]), 1) if hits else None},
        "latency_s": {"p50": round(statistics.median(ms) / 1000, 1) if ms else None,
                      "p95": round(sorted(ms)[int(0.95 * (len(ms) - 1))] / 1000, 1) if ms else None},
        "tokens": {"prompt_mean": round(statistics.mean(h.get("prompt_tokens", 0) for h in hits)) if hits else None,
                   "generated_mean": round(statistics.mean(h.get("new_tokens", 0) for h in hits)) if hits else None},
        "slices": {"language": D.by(recs, lambda r: r["lang"]), "source": D.by(recs, lambda r: r["source"]),
                   "label_source": D.by(recs, lambda r: "Opus (va01)" if r["episode"].startswith("va01") else "Sonnet (va02)"),
                   "session_index": D.by(recs, lambda r: r["sid"])},
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--split", default="val")
    ap.add_argument("--k", type=int, default=60)
    ap.add_argument("--exclude-episode", action="append", default=[], help="sensitivity analysis (EVAL-PLAN §2)")
    a = ap.parse_args(argv)
    run = Path(a.run)
    out = {"run": str(run), "k": a.k, "excluded_episodes": a.exclude_episode}
    for loop in ("open", "closed"):
        if (run / f"preds-{a.split}-{loop}.jsonl").exists():
            recs = [r for r in records(run, a.split, loop) if r["episode"] not in a.exclude_episode]
            out[loop] = report(recs, a.k)
    suffix = "-excl-" + "-".join(a.exclude_episode) if a.exclude_episode else ""
    (run / f"foundation-report-{a.split}{suffix}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False, default=str) + "\n")
    for loop in ("open", "closed"):
        if loop in out:
            print(loop, json.dumps(out[loop]["primary"]), json.dumps({k: out[loop]["strict"].get(k) for k in ("extraction_precision", "extraction_recall", "extraction_f1")}))


if __name__ == "__main__":
    main()
