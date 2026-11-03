"""Paired bootstrap over plans with Holm correction (EVALUATION-PROTOCOL.md §6).

Input: per-episode count records from paste.evaluate (one list per system and seed). Episodes are grouped by plan
id (both wordings of a plan share a plan id), and resampled together.
"""
import collections
import random

OPS = ("WRITE", "UPDATE", "MERGE_INTO", "FORGET", "FORGET_PROFILE", "MERGE")


def plan_id(ep_id):
    return ep_id                                  # wordings share the plan id; the wording is a separate file


def _pe(rows):
    tp = sum(sum(r["tp"].get(k, 0) for k in OPS) for r in rows)
    fp = sum(sum(r["fp"].get(k, 0) for k in OPS) for r in rows)
    fn = sum(sum(r["fn"].get(k, 0) for k in OPS) for r in rows)
    return 2 * tp / max(1, 2 * tp + fp + fn)


def _fpm(rows):
    return 100 * sum(r["false_writes"] for r in rows) / max(1, sum(r["segments"] for r in rows))


def by_plan(per_ep_lists):
    """per_ep_lists: list over seeds (and wordings) of per-episode records -> {plan: [records...]} per seed."""
    out = []
    for lst in per_ep_lists:
        d = collections.defaultdict(list)
        for r in lst:
            d[plan_id(r["id"])].append(r)
        out.append(d)
    return out


def paired_bootstrap(sys_a, sys_b, metric="PE", n=10_000, seed=0):
    """sys_a, sys_b: lists over seeds of per-episode records (same plans). Returns (delta, lo, hi, p_one_sided)
    for the seed-mean metric difference a - b."""
    f = _pe if metric == "PE" else _fpm
    A, B = by_plan(sys_a), by_plan(sys_b)
    plans = sorted(set.intersection(*[set(d) for d in A + B]))
    def seed_mean(D, sample):
        return sum(f([r for p in sample for r in d[p]]) for d in D) / len(D)
    delta = seed_mean(A, plans) - seed_mean(B, plans)
    rng = random.Random(seed)
    boots = []
    for _ in range(n):
        s = [plans[rng.randrange(len(plans))] for _ in plans]
        boots.append(seed_mean(A, s) - seed_mean(B, s))
    boots.sort()
    lo, hi = boots[int(0.025 * n)], boots[int(0.975 * n) - 1]
    p = sum(b <= 0 for b in boots) / n
    return delta, lo, hi, p


def holm(pvals, alpha=0.05):
    """Holm step-down: returns {name: reject} for one-sided p-values."""
    order = sorted(pvals.items(), key=lambda kv: kv[1])
    out, m = {}, len(order)
    for i, (k, p) in enumerate(order):
        if p <= alpha / (m - i):
            out[k] = True
        else:
            for k2, _ in order[i:]:
                out[k2] = False
            break
    return out
