"""Op-level confidence from token log-probabilities, and the precision-at-coverage metrics (foundation study).

An op's score is the mean log-probability of the tokens that spell its `val` (or, for ops without a value, its
`op` and `ref`), located in the generated answer. Ranking every content op of a run by this score and keeping the
top k gives precision at matched coverage (P@k): a model cannot score well by storing almost nothing, and a model
that knows when it is unsure ranks its false memories last. Secondary metric, EVAL-PLAN §5; the strict IrisBench
metrics are unchanged.
"""
import json
import math


def token_spans(logprobs):
    """[(start, end, logprob)] character spans of the generated tokens in their concatenated text."""
    spans, pos = [], 0
    for tok, lp in logprobs or []:
        spans.append((pos, pos + len(tok), lp))
        pos += len(tok)
    return spans


def _value_text(op):
    if op.get("val") is not None:
        return json.dumps(op["val"], ensure_ascii=False)[1:-1]     # as it appears inside the JSON string
    return None


def op_scores(answer, logprobs, ops):
    """Mean token log-probability per op (same order as `ops`; None when the op cannot be located).

    `answer` is the text that was parsed; the joined tokens may carry extra leading reasoning or trailing
    whitespace, so the answer is located inside them first. Ops are searched left to right so that repeated
    values map to successive occurrences.
    """
    joined = "".join(t for t, _ in logprobs or [])
    base = joined.find(answer.strip()) if answer.strip() else -1
    if base < 0:
        return [None] * len(ops)
    spans = token_spans(logprobs)
    out, cursor = [], base
    for op in ops:
        needle = _value_text(op)
        if needle is None:
            needle = f'"{op["op"]}"'
        i = joined.find(needle, cursor)
        if i < 0:
            out.append(None)
            continue
        j = i + len(needle)
        lps = [lp for s, e, lp in spans if s < j and e > i]
        out.append(sum(lps) / len(lps) if lps else None)
        cursor = j
    return out


def precision_at_k(scored, k):
    """scored: [(score, correct_bool)] for every content op of a run. None when fewer than k ops exist."""
    if len(scored) < k:
        return None
    ranked = sorted(scored, key=lambda x: (-(x[0] if x[0] is not None else -math.inf)))
    return sum(1 for _, ok in ranked[:k] if ok) / k


def risk_coverage(scored):
    """[(coverage_ops, precision)] after each op, best-scored first; and the area under precision-vs-ops."""
    ranked = sorted(scored, key=lambda x: (-(x[0] if x[0] is not None else -math.inf)))
    curve, tp = [], 0
    for n, (_, ok) in enumerate(ranked, 1):
        tp += ok
        curve.append((n, tp / n))
    area = sum(p for _, p in curve) / len(curve) if curve else None
    return curve, area


def f_beta(tp, pred, gold, beta=0.5):
    if not tp:
        return 0.0
    p, r = tp / pred, tp / gold
    b2 = beta * beta
    return (1 + b2) * p * r / (b2 * p + r)


# ---- equal-volume precision (EVAL-PLAN amendment A4, criterion 3) -------------------------------------------------
NEG_INF = float("-inf")


def rank_key(op):
    """Total order: higher score first; an op without a score (None) ranks after every scored op; ties broken by the
    op's deterministic position key (episode id, session index, position in the answer[, resample draw])."""
    s = op["score"]
    return (-(s if s is not None else NEG_INF), op["key"])


def top_precision(ops, v):
    """Share of strict matches among the v highest-ranked ops (v >= 1)."""
    ranked = sorted(ops, key=rank_key)[:v]
    return sum(1 for o in ranked if o["correct"]) / v


def equal_volume(candidate, control, shortfall=0.5):
    """Precision of the two systems at the same storage volume V = min(n_candidate, n_control), each ranked by its own
    confidence. ops: [{"score": float|None, "correct": bool, "key": tuple}]. Deterministic for a given input."""
    nc, nk = len(candidate), len(control)
    v = min(nc, nk)
    out = {"n_candidate": nc, "n_control": nk, "volume": v,
           "unscored_candidate": sum(o["score"] is None for o in candidate) / nc if nc else None,
           "unscored_control": sum(o["score"] is None for o in control) / nk if nk else None,
           "volume_shortfall": bool(nk and nc < shortfall * nk)}
    if v == 0:
        out.update(precision_candidate=None, precision_control=None, difference=None)
        return out
    pc, pk = top_precision(candidate, v), top_precision(control, v)
    out.update(precision_candidate=pc, precision_control=pk, difference=pc - pk)
    return out
