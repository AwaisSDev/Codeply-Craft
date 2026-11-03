"""Dataset loader: episode records (data/build.py) -> StepInputs and gold for the losses (spec §6).

Teacher-forced form (gold store, gold temporary items); the closed-loop trainer (Phase 5) swaps in the stores its
own operations produce. Temporary-item vectors are carried by item id across segments.
"""
import torch

from .config import ATTRS, CERTS, KINDS, RELS, TTLS, TTYPES
from .losses import segment_loss

_DAY = 86400.0


def segment_gold(adapter, seg):
    """StepInput builder + gold dict for one segment (indices follow adapter.build's ordering)."""
    st = {"version": 1, "session_id": None, "last_at": None, "seg_index": seg["index"], "h": None, "items": [], "next_item": 1}
    st["items"] = [dict(it, z=torch.zeros(adapter.m.cfg.d)) for it in seg["temp_before"]]
    rows = [{"id": r["id"], "entity": r["entity"], "profile_text": r["profile_text"], "attribute": r["attribute"],
             "value": r["value"], "kind": r["kind"], "status": r["status"], "evidence": r["evidence"], "locked": r.get("locked", False)}
            for r in seg["store_before"]]
    s_in, text, offs, profiles_meta = adapter.build({"turns": seg["turns"], "at": seg["at"], "session_id": seg["session_id"]}, rows, st)
    tx = adapter.text
    n = len(s_in.seg_ids)
    K, E = len(rows), len(profiles_meta)
    rec_index = {r["id"]: j for j, r in enumerate(rows)}
    prof_index = {p["key"]: e for e, p in enumerate(profiles_meta)}
    temp_index = {it["id"]: i for i, it in enumerate(seg["temp_before"])}

    def tok_span(cs):
        try:
            return tx.char_to_token_span(offs, *cs)
        except ValueError:
            return None                      # span truncated away by the 256-token limit

    bio, ebio = [0] * n, [0] * n
    ments = []
    for m in seg["mentions"]:
        sp = tok_span(m["char_span"])
        ments.append(sp)
        if sp:
            ebio[sp[0]] = 1
            for i in range(sp[0] + 1, sp[1]):
                ebio[i] = 2
    units = []
    for u in seg["units"]:
        sp = tok_span(u["char_span"])
        if sp is None:
            continue
        bio[sp[0]] = 1
        for i in range(sp[0] + 1, sp[1]):
            bio[i] = 2
        g = {"span": sp, "route": u["route"], "kind": KINDS.index(u["kind"]), "cert": CERTS.index(u["cert"]),
             "attr": ATTRS.index(u["attr"]) if u["attr"] in ATTRS else ATTRS.index("OTHER")}
        tg = u.get("target")
        if tg:
            if tg["type"] == "record":
                g["omega"] = rec_index[tg["fact"]]
            elif tg["type"] == "new_attr":
                g["omega"] = K + prof_index[tg["entity"]]
            else:
                g["omega"] = K + E
        if u.get("rel"):
            g["rel"] = RELS.index(u["rel"])
        if u["route"] == "PERSIST":
            g["src"] = temp_index[u["src"]] if u.get("src") else -1
            if tg and tg["type"] == "new_ent":
                mi = u.get("mention")
                live = [k for k, sp_ in enumerate(ments) if sp_]
                g["mention"] = live.index(mi) if mi is not None and ments[mi] else len(live)
        if u["route"] == "TEMP":
            g["ttype"], g["ttl"] = TTYPES.index(u["ttype"]), TTLS.index(u["ttl"])
            g["tmp"] = len(temp_index) if u["tmp"] == "NEW" else temp_index[u["tmp"]]
        units.append(g)
    retrieve = {r["fact"] for r in seg["retrieve"]}
    expire = {x["item"] for x in seg["expire"]}
    gold = {"unit_bio": bio, "ent_bio": ebio, "units": units, "ment_spans": [sp for sp in ments if sp],
            "retrieve": [1 if r["id"] in retrieve else 0 for r in rows],
            "merge_pos": [tuple(sorted((rec_index[a], rec_index[b]))) for mg in seg["merges"] for a, b in [mg["facts"]]],
            "expire": [1 if it["id"] in expire else 0 for it in seg["temp_before"]]}
    gold["_offs"] = offs
    return s_in, gold


def episode_loss_teacher_forced(model, adapter, ep, k_bptt=4, window=8):
    """Teacher-forced loss over an episode: h and temporary-item vectors carried by id, truncated BPTT (spec §6.2)."""
    h, z, total, n = None, {}, 0.0, 0
    prev_session = None
    for i, seg in enumerate(ep["segments"]):
        if seg["session_id"] != prev_session and prev_session is not None:
            h = None
        prev_session = seg["session_id"]
        if i % k_bptt == 0:
            h = None if h is None else h.detach()
            z = {k: v.detach() for k, v in z.items()}
        s_in, gold = segment_gold(adapter, seg)
        s_in.h = h
        for t, it in zip(s_in.temps, seg["temp_before"]):
            t.z = z.get(it["id"], torch.zeros(model.cfg.d))
        enc = model.encode([s_in])[0]
        L = segment_loss(model, enc, gold)
        total = total + sum(L.values()); n += 1
        if hasattr(model, "gru_h"):                              # PASTE: GRU-gated memory tokens
            h = model.gru_h(enc.mem, h if h is not None else model.h0)
        else:                                                    # baselines: RMT replacement, or no latent state
            h = model.train_transition(enc, h)
        if not hasattr(model, "W_new"):                          # temporary items are text rows: no vectors to carry
            continue
        units = {u["tag"]: u for u in seg["units"]}
        for op in seg["temp_ops"]:
            if op["op"] in ("T-WRITE", "T-UPDATE") and op.get("unit") in units:
                u = units[op["unit"]]
                try:
                    sp = adapter.text.char_to_token_span(gold["_offs"], *u["char_span"])
                except ValueError:
                    continue
                q, _ = model.heads.unit_query(enc.seg, *sp)
                if op["op"] == "T-WRITE":
                    z[op["item"]] = model.W_new(q)
                elif op["item"] in z:
                    z[op["item"]] = model.gru_t(q[None], z[op["item"]][None])[0]
            elif op["op"] in ("T-EXPIRE", "PROMOTE"):
                z.pop(op["item"], None)
    return total / max(1, n), n
