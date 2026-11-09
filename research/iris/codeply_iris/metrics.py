"""IrisBench v1 scoring.

Everything is counted per example and summed, so any slice (language, source, long inputs) and a cluster
bootstrap over episodes use the same code. Definitions (IRISBENCH.md has the rationale):

* content op      = add / update / conflict (asserts a value for an entity)
* strict match    = predicted and gold content ops agree on the entity and on the value (token-F1 >= 0.5, or
                    the same resolved date); one-to-one, best pairs first
* false memory    = a predicted content op with no strict gold match that is not merely a re-statement of a
                    memory already in the store (those are counted as duplicates)
* hard negative   = a labelled skip (joke, hypothetical, hearsay, suggestion, secret, injection, other)
"""
import random
from collections import Counter

from .contract import PERSISTENT_OPS, norm, same_entity
from .store import same_value, tokens, value_sim


def _date(w):
    return (w or "")[:10]


def resolve_entity(name, universe):
    """Map a predicted entity name onto the known names; None when it is ambiguous or unknown."""
    n = norm(name)
    for u in universe:
        if norm(u) == n:
            return u
    cands = [u for u in universe if same_entity(name, u)]
    return cands[0] if len(cands) == 1 else None


def evid_overlap(a, b):
    ta, tb = set(tokens(a)) or set(norm(a).split()), set(tokens(b)) or set(norm(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))


def content_score(p, g):
    """Similarity of two content ops' values (0 when they do not denote the same fact)."""
    vs = value_sim(p.get("val", ""), g.get("val", ""))
    if p.get("when") and g.get("when") and _date(p["when"]) == _date(g["when"]) and vs >= 0.2:
        vs = max(vs, 0.6)
    return vs if vs >= 0.5 else 0.0


def score_observe(pred, gold, memories, rejected=()):
    """Counts for one observe example. pred: guarded ops; gold: derive_ops output; memories: shown to the model;
    rejected: [(op, reason)] from the guard (for the grounding / hallucination counts)."""
    c = Counter()
    mem = {m["id"]: m for m in memories}
    universe = list({m["ent"] for m in memories} | {g["ent"] for g in gold if "ent" in g})
    p_content = [o for o in pred if o["op"] in PERSISTENT_OPS]
    g_content = [o for o in gold if o["op"] in PERSISTENT_OPS]
    g_confirm = [o for o in gold if o["op"] == "confirm"]
    g_skip = [o for o in gold if o["op"] == "skip"]

    # one-to-one matching of content ops, best first
    cands = []
    for i, p in enumerate(p_content):
        ent_p = resolve_entity(p["ent"], universe) or p["ent"]
        for j, g in enumerate(g_content):
            s = content_score(p, g)
            if s:
                ent_ok = norm(ent_p) == norm(g["ent"])
                cands.append((s + (0.5 if ent_ok else 0) + (0.05 if p["src"] == g["src"] else 0), i, j, ent_ok))
    cands.sort(reverse=True)
    used_p, used_g, pairs = set(), set(), []
    for _, i, j, ent_ok in cands:
        if i in used_p or j in used_g:
            continue
        used_p.add(i)
        used_g.add(j)
        pairs.append((p_content[i], g_content[j], ent_ok))
    matched_keys = {}
    for p, g, ent_ok in pairs:
        c["value_matched"] += 1
        if not ent_ok:
            c["misattributed"] += 1
            continue
        c["tp"] += 1
        matched_keys[id(p)] = g.get("key")
        c[f"gold_{g['op']}_matched"] += 1
        op_ok = p["op"] == g["op"] and p.get("ref") == g.get("ref")
        c[f"op_ok_{g['op']}"] += op_ok
        for f in ("kind", "keep", "basis", "conf", "sens"):
            c[f"{f}_n"] += 1
            c[f"{f}_ok"] += p.get(f) == g.get(f)
        if g.get("when"):
            c["when_n"] += 1
            c["when_ok"] += _date(p.get("when")) == _date(g["when"])
            if "T" in g["when"]:
                c["time_n"] += 1
                c["time_ok"] += p.get("when") == g["when"]
        elif p.get("when"):
            c["when_spurious"] += 1
        if g.get("until"):
            c["until_n"] += 1
            c["until_ok"] += p.get("until") == g["until"]
        if g["op"] == "update" and p["op"] == "update":
            c["why_n"] += 1
            c["why_ok"] += p.get("why") == g.get("why")
        gr, pr = {norm(x) for x in g.get("rel", [])}, {norm(x) for x in p.get("rel", [])}
        c["rel_tp"] += len(gr & pr)
        c["rel_pred"] += len(pr)
        c["rel_gold"] += len(gr)
    c["pred_content"] = len(p_content)
    c["gold_content"] = len(g_content)
    for g in g_content:
        c[f"gold_{g['op']}"] += 1

    # unmatched predicted content ops: duplicate of an existing memory, a stored hard negative, or other
    strict_p = {id(p) for p, g, ok in pairs if ok}
    for p in p_content:
        if id(p) in strict_p:
            continue
        ent_p = resolve_entity(p["ent"], universe) or p["ent"]
        dup = any(norm(m["ent"]) == norm(ent_p) and same_value(m["val"], p["val"], m.get("when"), p.get("when"))
                  for m in memories)
        if dup:
            c["dup_restated"] += 1
            continue
        c["false_memory"] += 1
        if any(p["src"] == s["src"] and evid_overlap(p["evid"], s["evid"]) >= 0.5 for s in g_skip):
            c["false_from_skip"] += 1

    # confirm (duplicate detection): by ref
    g_refs = {o["ref"] for o in g_confirm}
    p_refs = {o["ref"] for o in pred if o["op"] == "confirm"}
    c["confirm_tp"] += len(g_refs & p_refs)
    c["confirm_gold"] += len(g_refs)
    c["confirm_pred"] += len(p_refs)
    for r in g_refs - p_refs:
        m = mem.get(r)
        if m and any(p["op"] == "add" and same_entity(p["ent"], m["ent"]) and value_sim(p["val"], m["val"]) >= 0.5
                     for p in p_content):
            c["dup_created"] += 1                      # re-added a fact the store already holds
        elif any(p.get("ref") == r and p["op"] == "update" for p in p_content):
            c["confirm_as_update"] += 1
    # retract: by ref
    gr = {o["ref"] for o in gold if o["op"] == "retract"}
    pr = {o["ref"] for o in pred if o["op"] == "retract"}
    c["retract_tp"] += len(gr & pr)
    c["retract_gold"] += len(gr)
    c["retract_pred"] += len(pr)
    # hard negatives
    p_skip = [o for o in pred if o["op"] == "skip"]
    for s in g_skip:
        c["skip_gold"] += 1
        c[f"skip_gold_{s['why']}"] += 1
        hit = [p for p in p_skip if p["src"] == s["src"] and evid_overlap(p["evid"], s["evid"]) >= 0.5]
        if hit:
            c["skip_tp"] += 1
            c["skip_why_ok"] += any(p["why"] == s["why"] for p in hit)
        stored = any(p["src"] == s["src"] and evid_overlap(p["evid"], s["evid"]) >= 0.5 for p in p_content)
        c["skip_stored"] += stored
        c[f"skip_stored_{s['why']}"] += stored
    c["skip_pred"] += len(p_skip)
    # session level: should anything change?
    gold_change = bool(g_content or gr)
    pred_change = bool(p_content or pr)
    c["sessions"] += 1
    c["empty_gold"] += not gold_change
    c["empty_ok"] += (not gold_change) and (not pred_change)
    c["decision_ok"] += gold_change == pred_change
    # grounding
    c["ops_emitted"] += len(pred) + len(rejected)
    for _, reason in rejected:
        c[f"rej_{reason}"] += 1
    return c, matched_keys


def score_retrieve(pred_ids, gold_ids):
    p, g = set(pred_ids), set(gold_ids)
    return Counter({"ret_tp": len(p & g), "ret_pred": len(p), "ret_gold": len(g), "ret_n": 1,
                    "ret_exact": int(p == g), "ret_full_recall": int(g <= p)})


def _div(a, b):
    return a / b if b else float("nan")


def _f1(tp, pred, gold):
    p, r = _div(tp, pred), _div(tp, gold)
    f = 2 * p * r / (p + r) if tp and pred and gold else (0.0 if (pred or gold) else float("nan"))
    return p, r, f


def summarise(c):
    """Counts -> the IrisBench metric table (a flat dict; NaN when a metric has no cases)."""
    p, r, f = _f1(c["tp"], c["pred_content"], c["gold_content"])
    cp, cr, cf = _f1(c["confirm_tp"], c["confirm_pred"], c["confirm_gold"])
    rp, rr, rf = _f1(c["retract_tp"], c["retract_pred"], c["retract_gold"])
    relp, relr, relf = _f1(c["rel_tp"], c["rel_pred"], c["rel_gold"])
    qp, qr, qf = _f1(c["ret_tp"], c["ret_pred"], c["ret_gold"])
    upd_gold = c["gold_update"] + c["gold_conflict"]
    upd_ok = c["op_ok_update"] + c["op_ok_conflict"]
    return {
        "extraction_precision": p, "extraction_recall": r, "extraction_f1": f,
        "false_memory_share": _div(c["false_memory"] + c["misattributed"], c["pred_content"]),
        "false_memories_per_100_sessions": 100 * _div(c["false_memory"] + c["misattributed"], c["sessions"]),
        "hard_negative_stored": _div(c["skip_stored"], c["skip_gold"]),
        "update_accuracy": _div(upd_ok, upd_gold),                      # right op + right target, of all gold updates
        "update_accuracy_when_found": _div(upd_ok, c["gold_update_matched"] + c["gold_conflict_matched"]),
        "contradiction_resolution": _div(c["op_ok_update"] + c["op_ok_conflict"] + c["retract_tp"], upd_gold + c["retract_gold"]),
        "change_type_accuracy": _div(c["why_ok"], c["why_n"]),
        "temporal_date_accuracy": _div(c["when_ok"], c["when_n"]),
        "temporal_datetime_accuracy": _div(c["time_ok"], c["time_n"]),
        "temporal_until_accuracy": _div(c["until_ok"], c["until_n"]),
        "entity_linking_accuracy": _div(c["tp"], c["value_matched"]),
        "relation_f1": relf, "relation_precision": relp, "relation_recall": relr,
        "persistence_accuracy": _div(c["keep_ok"], c["keep_n"]),
        "store_decision_accuracy": _div(c["decision_ok"], c["sessions"]),
        "empty_session_accuracy": _div(c["empty_ok"], c["empty_gold"]),
        "retrieval_precision": qp, "retrieval_recall": qr, "retrieval_f1": qf,
        "retrieval_exact_set": _div(c["ret_exact"], c["ret_n"]),
        "duplicate_detection_recall": cr, "duplicate_detection_precision": cp,
        "duplicates_created_rate": _div(c["dup_created"] + c["dup_restated"], c["confirm_gold"] + c["sessions"] * 0),
        "retraction_f1": rf, "retraction_precision": rp, "retraction_recall": rr,
        "ungrounded_evidence_rate": _div(c["rej_ungrounded_evidence"] + c["rej_bad_src"], c["ops_emitted"]),
        "guard_rejection_rate": _div(sum(v for k, v in c.items() if k.startswith("rej_")), c["ops_emitted"]),
        "output_validity": _div(c["valid_outputs"], c["outputs"]),
        "skip_recall": _div(c["skip_tp"], c["skip_gold"]),
        "kind_accuracy": _div(c["kind_ok"], c["kind_n"]), "sensitivity_accuracy": _div(c["sens_ok"], c["sens_n"]),
        "basis_accuracy": _div(c["basis_ok"], c["basis_n"]), "confidence_accuracy": _div(c["conf_ok"], c["conf_n"]),
        "n_sessions": c["sessions"], "n_gold_content": c["gold_content"], "n_pred_content": c["pred_content"],
        "n_gold_updates": upd_gold, "n_gold_confirms": c["confirm_gold"], "n_gold_retracts": c["retract_gold"],
        "n_hard_negatives": c["skip_gold"], "n_queries": c["ret_n"],
    }


def bootstrap(per_episode, keys, n=2000, seed=0):
    """Cluster bootstrap over episodes. per_episode: {episode_id: Counter}. Returns {metric: (lo, hi)} (95 %)."""
    rng = random.Random(seed)
    ids = sorted(per_episode)
    if len(ids) < 2:
        return {}
    samples = {k: [] for k in keys}
    for _ in range(n):
        tot = Counter()
        for _ in ids:
            tot.update(per_episode[rng.choice(ids)])
        s = summarise(tot)
        for k in keys:
            if s[k] == s[k]:
                samples[k].append(s[k])
    out = {}
    for k, v in samples.items():
        if len(v) >= n // 2:
            v.sort()
            out[k] = (v[int(0.025 * len(v))], v[int(0.975 * len(v)) - 1])
    return out


def paired_bootstrap(a, b, keys, n=2000, seed=0):
    """95 % CI of metric(a) - metric(b) over the same resampled episodes. a, b: {episode_id: Counter}."""
    rng = random.Random(seed)
    ids = sorted(set(a) & set(b))
    out = {}
    if len(ids) < 2:
        return out
    diffs = {k: [] for k in keys}
    for _ in range(n):
        ta, tb = Counter(), Counter()
        for _ in ids:
            e = rng.choice(ids)
            ta.update(a[e])
            tb.update(b[e])
        sa, sb = summarise(ta), summarise(tb)
        for k in keys:
            d = sa[k] - sb[k]
            if d == d:
                diffs[k].append(d)
    for k, v in diffs.items():
        if len(v) >= n // 2:
            v.sort()
            out[k] = (v[int(0.025 * len(v))], v[int(0.975 * len(v)) - 1])
    return out


def end_state(store_rows, ledger):
    """Compare a closed-loop store with the teacher's final ledger.

    ledger: {key: {"ent", "val", "when", "live": bool, "past": [old values]}}. Each live memory is classified as
    current (matches a live fact's current value; one memory per fact), duplicate (a second memory for a fact
    already matched), stale (holds a superseded or retracted value), or false (matches nothing).
    """
    c = Counter()
    live_facts = {k: f for k, f in ledger.items() if f["live"]}
    universe = list({f["ent"] for f in ledger.values()})
    matched = set()
    cands = []
    for i, m in enumerate(store_rows):
        ent = resolve_entity(m["ent"], universe) or m["ent"]
        for k, f in live_facts.items():
            if norm(ent) == norm(f["ent"]):
                s = content_score(m, f)
                if s:
                    cands.append((s, i, k))
    cands.sort(reverse=True)
    used = set()
    for s, i, k in cands:
        if i in used or k in matched:
            continue
        used.add(i)
        matched.add(k)
    for i, m in enumerate(store_rows):
        if i in used:
            c["state_current"] += 1
            continue
        ent = resolve_entity(m["ent"], universe) or m["ent"]
        if any(norm(ent) == norm(f["ent"]) and content_score(m, f) for f in live_facts.values()):
            c["state_duplicate"] += 1
        elif any(norm(ent) == norm(f["ent"]) and any(content_score(m, {"val": v, "when": w}) for v, w in f["past"])
                 for f in ledger.values()) or any(
                norm(ent) == norm(f["ent"]) and content_score(m, f) for f in ledger.values() if not f["live"]):
            c["state_stale"] += 1
        else:
            c["state_false"] += 1
    c["state_gold"] = len(live_facts)
    c["state_rows"] = len(store_rows)
    return c


def summarise_state(c):
    p, r, f = _f1(c["state_current"], c["state_rows"], c["state_gold"])
    return {"state_precision": p, "state_recall": r, "state_f1": f,
            "state_stale_share": _div(c["state_stale"], c["state_rows"]),
            "state_duplicate_share": _div(c["state_duplicate"], c["state_rows"]),
            "state_false_share": _div(c["state_false"], c["state_rows"]),
            "n_state_gold": c["state_gold"], "n_state_rows": c["state_rows"]}
