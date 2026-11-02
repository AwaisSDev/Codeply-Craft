"""Training losses (spec §6.1) and a teacher-forced episode runner with truncated BPTT (§6.2).

Closed-loop scheduled sampling (§6.3) needs the dataset and the trainer; it is built in Phase 5 on top of
`episode_loss` (the store/temporary inputs it receives are then partly produced by the model itself).

Gold for one segment (prototype schema; DATASET-DESIGN.md fixes the final one):
  unit_bio, ent_bio : list[int] over segment tokens (0=O, 1=B, 2=I)
  units : list of dicts
      span (start, end) token span; route in {PERSIST, TEMP, IGNORE, FORGET}; kind, cert, attr (int)
      ttype, ttl (int, TEMP units); src (-1 SELF or temporary index, PERSIST units)
      omega (int index into Omega = records | NEW-ATTR(e) | NEW-ENT; PERSIST and FORGET units)
      rel (int, when omega is a record); mention (int index into ment_spans or len = NONE; NEW-ENT units)
      tmp (int temporary index, or len(temps) = NEW; TEMP units)
  ment_spans : list of token spans (gold entity mentions)
  retrieve : list[int] per record; merge_pos : list of (j, k); expire : list[int] per temporary item
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import ROUTE3

C_FP = 3.0      # owner decision: a false permanent memory costs 3x a miss


def gate_loss(logit, y, c_fp=C_FP):
    """-[y log g + c_fp (1-y) log(1-g)], computed stably from the logit (spec §6.1, L_gate)."""
    return -(y * F.logsigmoid(logit) + c_fp * (1 - y) * F.logsigmoid(-logit))


def _bce_balanced(logits, y):
    y = y.float()
    pos, neg = y.sum(), (1 - y).sum()
    w = torch.clamp(neg / pos.clamp(min=1), max=10.0) if pos > 0 else torch.tensor(1.0)
    return F.binary_cross_entropy_with_logits(logits, y, pos_weight=w)


def segment_loss(model, enc, gold):
    """Core losses for one encoded segment. Returns a dict of scalar terms (unweighted, lambda = 1)."""
    hd = model.heads
    L = {}
    gold = {k: v for k, v in gold.items() if not k.startswith("_")}
    L["tag"] = F.cross_entropy(hd.bio_unit(enc.seg), torch.tensor(gold["unit_bio"])) + \
        F.cross_entropy(hd.bio_ent(enc.seg), torch.tensor(gold["ent_bio"]))
    terms = {k: [] for k in ("cls", "gate", "addr", "rel", "src", "ment", "tmp")}
    ments = gold.get("ment_spans", [])
    ment_vecs = torch.stack([enc.seg[a:b].mean(0) for a, b in ments]) if ments else torch.zeros(0, model.cfg.d)
    K = enc.att.shape[0]
    for u in gold["units"]:
        persist = u["route"] == "PERSIST"
        out = model.unit_outputs(enc, u["span"], src=u.get("src", -1) if persist else -1)
        cls = out["cls_s"] if persist else out["cls"]
        t = [F.cross_entropy(cls["kind"], torch.tensor(u["kind"])), F.cross_entropy(cls["cert"], torch.tensor(u["cert"]))]
        if u["route"] in ("PERSIST", "TEMP"):
            t.append(F.cross_entropy(cls["attr"], torch.tensor(u["attr"])))
        if u["route"] == "TEMP":
            t += [F.cross_entropy(cls["ttype"], torch.tensor(u["ttype"])), F.cross_entropy(cls["ttl"], torch.tensor(u["ttl"]))]
        if not persist:
            t.append(F.cross_entropy(out["cls"]["route3"], torch.tensor(ROUTE3.index(u["route"]))))
        terms["cls"].append(sum(t))
        terms["gate"].append(gate_loss(out["gate"], torch.tensor(1.0 if persist else 0.0)))
        if persist or u["route"] == "FORGET":
            lp = out["addr"] if persist else out["addr_q"]
            terms["addr"].append(-lp[u["omega"]])
        if persist:
            terms["src"].append(F.cross_entropy(out["src_logits"], torch.tensor(u.get("src", -1) + 1)))
            if u["omega"] < K:
                terms["rel"].append(F.cross_entropy(hd.relation_logits(out["qs"], enc.att[u["omega"]], enc.val[u["omega"]]), torch.tensor(u["rel"])))
            if u["omega"] == len(out["addr"]) - 1:
                terms["ment"].append(F.cross_entropy(hd.mention(out["qs"], ment_vecs), torch.tensor(u.get("mention", len(ments)))))
        if u["route"] == "TEMP":
            terms["tmp"].append(F.cross_entropy(out["tmp"], torch.tensor(u["tmp"])))
    for k, v in terms.items():
        L[k] = torch.stack(v).mean() if v else torch.zeros(())
    c = enc.seg.mean(0)
    if K and "retrieve" in gold:
        L["ret"] = _bce_balanced(hd.retrieve_logits(enc.prof[enc.rec_prof], enc.att, enc.val, c), torch.tensor(gold["retrieve"]))
    pairs = model.merge_pairs(enc)
    if pairs and "merge_pos" in gold:
        pos = {tuple(p) for p in gold["merge_pos"]}
        y = torch.tensor([1.0 if p in pos else 0.0 for p in pairs])
        logit = hd.merge_logits(pairs, enc.att, enc.val, enc.prof[enc.rec_prof], c)
        w_pos = torch.clamp((1 - y).sum() / y.sum().clamp(min=1), max=10.0) if y.sum() > 0 else torch.tensor(1.0)
        L["mrg"] = -(w_pos * y * F.logsigmoid(logit) + C_FP * (1 - y) * F.logsigmoid(-logit)).mean()   # D1: 3:1 FP cost
    if enc.tmp.shape[0] and "expire" in gold:
        L["exp"] = F.binary_cross_entropy_with_logits(hd.expire_logits(enc.tmp, c), torch.tensor(gold["expire"]).float())
    return L


# ---- auxiliary objectives (off by default; ablations A6a / A6b) --------------------------------
def identity_contrastive(q_star, pos_profile, neg_profiles, temperature=0.1):
    """L_idc: InfoNCE between q*_u and its gold profile against look-alike profiles from other episodes."""
    cand = F.normalize(torch.cat([pos_profile[None], neg_profiles]), dim=-1)
    logits = cand @ F.normalize(q_star, dim=-1) / temperature
    return F.cross_entropy(logits[None], torch.tensor([0]))


class RecallProbe(nn.Module):
    """L_rec: from h_s predict a multi-hot of attribute classes and entity roles seen in segments s-3..s.

    Training-only head; not part of the deployed model or of the §7 parameter count.
    """

    def __init__(self, d, r, n_targets):
        super().__init__()
        self.lin = nn.Linear(r * d, n_targets)

    def forward(self, h, target_multi_hot):
        return F.binary_cross_entropy_with_logits(self.lin(h.reshape(-1)), target_multi_hot.float())


# ---- teacher-forced episode runner (§6.2) ---------------------------------------------------
def episode_loss(model, steps, k_bptt=4):
    """steps: list of (StepInput-without-h/temps-vectors builder, gold) in segment order.

    Each element is a dict {"make": fn(h, temp_vectors) -> StepInput, "gold": gold, "session_start": bool,
    "temp_ops": list of gold temporary operations [("NEW", unit_index) | ("UPDATE", item, unit_index) | ("DROP", item)]}.
    h and temporary-item vectors are carried with gradient for k_bptt segments, then detached.
    """
    h, zs, total, terms_sum = None, [], 0.0, {}
    for s_i, st in enumerate(steps):
        if st.get("session_start"):
            h = None
        if s_i % k_bptt == 0:
            h = None if h is None else h.detach()
            zs = [z.detach() for z in zs]
        s = st["make"](h, zs)
        enc = model.encode([s])[0]
        L = segment_loss(model, enc, st["gold"])
        seg_total = sum(L.values())
        total = total + seg_total
        for k, v in L.items():
            terms_sum[k] = terms_sum.get(k, 0.0) + float(v.detach())
        # transition with gradient (training form of §5.11-5.12)
        h_prev = h if h is not None else model.h0
        h = model.gru_h(enc.mem, h_prev)
        units = st["gold"]["units"]
        new_zs = list(zs)
        for op in st.get("temp_ops", []):
            if op[0] == "UPDATE":
                q, _ = model.heads.unit_query(enc.seg, *units[op[2]]["span"])
                new_zs[op[1]] = model.gru_t(q[None], zs[op[1]][None])[0]
        drop = {op[1] for op in st.get("temp_ops", []) if op[0] == "DROP"}
        new_zs = [z for i, z in enumerate(new_zs) if i not in drop]
        for op in st.get("temp_ops", []):
            if op[0] == "NEW":
                q, _ = model.heads.unit_query(enc.seg, *units[op[1]]["span"])
                new_zs.append(model.W_new(q))
        zs = new_zs
    n = len(steps)
    return total / n, {k: v / n for k, v in terms_sum.items()}
