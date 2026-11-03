"""Dataset loader: episode records (data/build.py) -> StepInputs and gold for the losses (spec §6).

Teacher-forced form (gold store, gold temporary items); the closed-loop trainer (Phase 5) swaps in the stores its
own operations produce. Temporary-item vectors are carried by item id across segments.
"""
import torch

from .config import ATTRS, CERTS, KINDS, RELS, TTLS, TTYPES
from .losses import segment_loss

_DAY = 86400.0


def segment_gold(adapter, seg, rep=None):
    """StepInput builder + gold dict for one segment (indices follow adapter.build's ordering).

    rep: a paste.evaluate.Replay holding the model's own store (closed-loop training, spec §6.3). Gold targets are
    then remapped through provenance: a fact the model never wrote becomes NEW-ATTR / NEW-ENT (FORGET: nothing).
    """
    st = {"version": 1, "session_id": None, "last_at": None, "seg_index": seg["index"], "h": None, "items": [], "next_item": 1}
    st["items"] = [dict(it, z=torch.zeros(adapter.m.cfg.d)) for it in seg["temp_before"]]
    if rep is None:
        src_rows = seg["store_before"]
        fact_to_row = {r["id"]: r["id"] for r in src_rows}
        ent_key = lambda e: e
    else:
        src_rows = list(rep.sim.records.values())
        fact_to_row = {r.get("provenance"): r["id"] for r in src_rows if r.get("provenance") not in (None, "spurious")}
        rev = {v: k for k, v in rep.alias.items()}
        ent_key = lambda e: rev.get(e, e)
    rows = [{"id": r["id"], "entity": r["entity"], "profile_text": r.get("profile_text") or r["entity"], "attribute": r["attribute"],
             "value": r["value"], "kind": r.get("kind"), "status": r["status"], "evidence": r["evidence"], "locked": r.get("locked", False)}
            for r in src_rows]
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
            if tg["type"] == "record" and fact_to_row.get(tg["fact"]) in rec_index:
                g["omega"] = rec_index[fact_to_row[tg["fact"]]]
                if u.get("rel"):
                    g["rel"] = RELS.index(u["rel"])
            elif tg["type"] == "record" and u["route"] == "FORGET":
                g["omega"] = K + E                                  # nothing to forget in the model's own store
            else:                                                   # NEW-ATTR if the entity has a profile, else NEW-ENT
                ek = ent_key(tg["entity"]) if tg["type"] != "record" else ent_key(u["entity"])
                g["omega"] = K + prof_index[ek] if ek in prof_index else K + E
                if g["omega"] == K + E and u["route"] == "PERSIST" and tg["type"] == "record":
                    tg = {"type": "new_ent"}                        # a recovered write about an unknown profile needs a mention
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
    retrieve = {fact_to_row.get(r["fact"]) for r in seg["retrieve"]}
    expire = {x["item"] for x in seg["expire"]}
    gold = {"unit_bio": bio, "ent_bio": ebio, "units": units, "ment_spans": [sp for sp in ments if sp],
            "retrieve": [1 if r["id"] in retrieve else 0 for r in rows],
            "merge_pos": [tuple(sorted((rec_index[fact_to_row[a]], rec_index[fact_to_row[b]]))) for mg in seg["merges"]
                          for a, b in [mg["facts"]] if fact_to_row.get(a) in rec_index and fact_to_row.get(b) in rec_index],
            "expire": [1 if it["id"] in expire else 0 for it in seg["temp_before"]]}
    gold["_offs"] = offs
    return s_in, gold


def episode_loss_teacher_forced(model, adapter, ep, k_bptt=4, window=8, closed_loop=False, bio_w=1.0, terms=None):
    """Loss over an episode: h and temporary-item vectors carried by id, truncated BPTT (spec §6.2).

    closed_loop=True: the persistent store is the one the model's own decoded operations build (executed by the
    Brain simulator through paste.evaluate.Replay); temporary items stay teacher-forced (DECISIONS 2026-11-03).
    terms: optional dict; per-term loss sums and a segment count ("_n") are accumulated into it for logging."""
    from .evaluate import Replay, match_segment, execute
    rep = Replay(ep) if closed_loop else None
    h, z, total, n = None, {}, 0.0, 0
    prev_session = None
    for i, seg in enumerate(ep["segments"]):
        if seg["session_id"] != prev_session and prev_session is not None:
            h = None
        prev_session = seg["session_id"]
        if i % k_bptt == 0:
            h = None if h is None else h.detach()
            z = {k: v.detach() for k, v in z.items()}
        s_in, gold = segment_gold(adapter, seg, rep)
        s_in.h = h
        for t, it in zip(s_in.temps, seg["temp_before"]):
            t.z = z.get(it["id"], torch.zeros(model.cfg.d))
        enc = model.encode([s_in])[0]
        L = segment_loss(model, enc, gold, bio_w=bio_w)
        total = total + sum(L.values()); n += 1
        if terms is not None:
            for k, v in L.items():
                terms[k] = terms.get(k, 0.0) + float(v.detach())
            terms["_n"] = terms.get("_n", 0) + 1
        if rep is not None:                                       # the model's own operations build its next store
            with torch.no_grad():
                rows = rep.rows()
                text, _ = None, None
                from .text import segment_text
                stext, _ = segment_text(seg["turns"])
                offs = gold["_offs"]
                def seg_text_of(span, offs=offs, stext=stext):
                    chars = [o for o in offs[span[0]:span[1]] if o[1] > o[0]]
                    return stext[chars[0][0]:chars[-1][1]] if chars else ""
                pm = [{"key": "user", "text": "the user"}]
                seen = {"user"}
                for r in rows:
                    if r["entity"] not in seen:
                        seen.add(r["entity"]); pm.append({"key": r["entity"], "text": r["profile_text"]})
                out = model.decide(s_in, enc, seg_text_of, [{"id": r["id"]} for r in rows], pm,
                                   [dict(it) for it in seg["temp_before"]], adapter.th)
                cl_gold = rep.closed_loop_gold(seg)
                _, _, _, _, pairs = match_segment(rep, seg, out["operations"], cl_gold)
                execute(rep, out["operations"], pairs)
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
