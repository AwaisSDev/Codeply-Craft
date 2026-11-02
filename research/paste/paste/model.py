"""PASTE v2 model: memory pathway (spec §4), heads (§5), decision procedure (§5.13), transition (§5.12).

Data passed in (built by `paste.adapter` or the training data loader):
  StepInput  one segment plus the memory it is read with.
  State      carried between segments: h (r x d) and temporary items (§2.3).
Nothing here writes to the Brain (invariant I5): `decide` returns proposals.
"""
import math
from dataclasses import dataclass, field

import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import (ATTRS, CERTS, GROUPS, KINDS, N_DT, N_REC_AGE, N_REC_EV, N_REC_KIND, N_TEMP_AGE, RELS,
                     ROUTE3, STATUSES, TTLS, TTYPES, PasteConfig)
from .heads import SharedHeads
from .modernbert import ModernBert


# ---------------------------------------------------------------------------------------------
@dataclass
class RecordIn:
    ids: list            # tokens of rho_j = "<profile> · <attribute>: <value>"
    att: list            # token indices of the attribute field
    val: list            # token indices of the value field
    prof: int            # index into StepInput.profiles
    kind: int = len(KINDS)   # "unknown" row
    status: int = 0
    age: int = 0
    ev: int = 1


@dataclass
class ProfileIn:
    ids: list
    idx: list            # token indices pooled (all non-special tokens)


@dataclass
class TempIn:
    ids: list
    idx: list
    z: torch.Tensor      # [d]
    ttype: int
    tage: int


@dataclass
class StepInput:
    seg_ids: list
    profiles: list = field(default_factory=list)   # profile 0 is always the user (§2.2)
    records: list = field(default_factory=list)
    temps: list = field(default_factory=list)
    h: torch.Tensor = None                        # [r, d]
    dt: int = 0
    history: list = field(default_factory=list)   # [(same_session, seg_ids)] for text-window baselines only


@dataclass
class Encoded:
    mem: torch.Tensor     # [r, d]  h~
    tmp: torch.Tensor     # [T, d]  z~
    prof: torch.Tensor    # [E, d]  pi~
    att: torch.Tensor     # [K, d]  a~
    val: torch.Tensor     # [K, d]  v~
    seg: torch.Tensor     # [n, d]  t~
    rec_prof: torch.Tensor  # [K] long


# ---------------------------------------------------------------------------------------------
class DecisionMixin:
    """Decoding shared by PASTE and every encoder baseline: identical heads and decision procedure (A2).
    Needs self.heads (SharedHeads) and self.cfg; operates on an Encoded, whatever memory pathway produced it."""

    # ---- per-segment decisions (§5.13) and transition (§5.11-5.12) ------------------------
    @staticmethod
    def decode_bio(tags):
        """Greedy BIO decoding over segment tokens; an I without a preceding B/I opens a span."""
        spans, start = [], None
        for i, t in enumerate(tags):
            if t == 1 or (t == 2 and start is None):
                if start is not None:
                    spans.append((start, i))
                start = i
            elif t == 0 and start is not None:
                spans.append((start, i)); start = None
        if start is not None:
            spans.append((start, len(tags)))
        return spans

    def merge_pairs(self, enc: Encoded):
        """Candidate pairs: all pairs within a profile + the top cross-profile pairs by cos(kappa) (§5.10)."""
        K = enc.att.shape[0]
        if K < 2:
            return []
        rp = enc.rec_prof.tolist()
        within = [(j, k) for j in range(K) for k in range(j + 1, K) if rp[j] == rp[k]]
        key = F.normalize(self.heads.rec_key(torch.cat([enc.att, enc.val], -1)), dim=-1)
        sim = key @ key.T
        cross = sorted(((sim[j, k].item(), j, k) for j in range(K) for k in range(j + 1, K) if rp[j] != rp[k]), reverse=True)
        return within + [(j, k) for _, j, k in cross[:self.cfg.merge_cross_pairs]]

    def unit_outputs(self, enc: Encoded, span, src=None):
        """Every head output for one unit. src: None = decide; -1 = SELF; i = temporary item i."""
        hd = self.heads
        q, c = hd.unit_query(enc.seg, *span)
        src_logits = hd.source(q, enc.tmp)
        s = src if src is not None else int(src_logits.argmax()) - 1
        qs = q if s < 0 else hd.item_query(enc.tmp[s], c)
        return {"q": q, "c": c, "qs": qs, "src": s, "src_logits": src_logits, "gate": hd.gate(q, c),
                "cls": hd.classify(q), "cls_s": hd.classify(qs),
                "addr": hd.address(qs, enc.prof, enc.att, enc.val, enc.rec_prof),
                "addr_q": hd.address(q, enc.prof, enc.att, enc.val, enc.rec_prof),
                "tmp": hd.temp_address(q, enc.tmp)}

    @torch.no_grad()
    def decide(self, s: StepInput, enc: Encoded, seg_text_of, records_meta, profiles_meta, temps_meta, th=None,
               gate_override=None):
        """Deterministic decoding of one segment (§5.13). Returns proposals; never executes them.

        seg_text_of(span) -> text of a token span; *_meta carry ids/keys for the payloads.
        gate_override: fixed gate probability (test T5).
        """
        th = th or self.cfg.thresholds
        hd = self.heads
        n = enc.seg.shape[0]
        tags = hd.bio_unit(enc.seg).argmax(-1).tolist()
        tags[0] = tags[-1] = 0                                  # [CLS], [SEP]
        etags = hd.bio_ent(enc.seg).argmax(-1).tolist()
        etags[0] = etags[-1] = 0
        units, ments = self.decode_bio(tags), self.decode_bio(etags)
        ment_vecs = torch.stack([enc.seg[a:b].mean(0) for a, b in ments]) if ments else torch.zeros(0, self.cfg.d)
        K, E = enc.att.shape[0], enc.prof.shape[0]
        ops, temp_ops, per_record = [], [], {}
        prio = {"FORGET": 0, "FORGET_PROFILE": 0, "UPDATE": 1, "MERGE_INTO": 2, "MERGE": 3}
        c_seg = enc.seg.mean(0)

        def propose(op):
            tgt = op.get("target")
            if tgt is None:
                ops.append(op); return
            cur = per_record.get(tgt)
            if cur is None or prio[op["op"]] < prio[cur["op"]]:
                per_record[tgt] = op

        licence = {}                                            # profile index -> max gate of gated PERSIST units (D1)
        for span in units:
            u = self.unit_outputs(enc, span)
            g = torch.sigmoid(u["gate"]).item() if gate_override is None else gate_override
            text = seg_text_of(span)
            if g >= th["write"]:
                p_src = F.softmax(u["src_logits"], -1)[u["src"] + 1].item()
                lp = u["addr"]
                w = int(lp.argmax()); p_w = lp[w].exp().item()
                cls = u["cls_s"]
                payload = {"kind": KINDS[int(cls["kind"].argmax())], "certainty": CERTS[int(cls["cert"].argmax())],
                           "attribute": ATTRS[int(cls["attr"].argmax())],
                           "value": temps_meta[u["src"]]["text"] if u["src"] >= 0 else text}
                conf = g * p_src * p_w
                ev = {"span": span, "text": text}
                lic = int(enc.rec_prof[w]) if w < K else (w - K if w < K + E else None)
                if lic is not None:
                    licence[lic] = max(licence.get(lic, 0.0), g)
                if w < K:
                    rel = RELS[int(hd.relation_logits(u["qs"], enc.att[w], enc.val[w]).argmax())]
                    if rel == "SAME":
                        propose({"op": "MERGE_INTO", "target": records_meta[w]["id"], "payload": payload, "confidence": conf, "evidence": ev})
                    else:
                        propose({"op": "UPDATE", "target": records_meta[w]["id"], "subtype": rel, "challenge": rel == "CONTRADICTION",
                                 "payload": payload, "confidence": conf, "evidence": ev})
                elif w < K + E:
                    ops.append({"op": "WRITE", "entity": profiles_meta[w - K]["key"], "new_entity": False,
                                "payload": payload, "confidence": conf, "evidence": ev})
                else:
                    ml = hd.mention(u["qs"], ment_vecs)
                    mi = int(ml.argmax())
                    name = seg_text_of(ments[mi]) if mi < len(ments) else None
                    ops.append({"op": "WRITE", "entity": None, "new_entity": True, "mention": name,
                                "payload": payload, "confidence": conf, "evidence": ev})
                if u["src"] >= 0:
                    temp_ops.append({"op": "PROMOTE", "item": u["src"], "confidence": conf})
                continue
            p3 = F.softmax(u["cls"]["route3"], -1) * (1 - g)
            r = ROUTE3[int(p3.argmax())]
            if r == "TEMP":
                tl = u["tmp"]; ti = int(tl.argmax())
                if ti == enc.tmp.shape[0]:
                    temp_ops.append({"op": "T-WRITE", "q": u["q"], "text": text, "ttype": TTYPES[int(u["cls"]["ttype"].argmax())],
                                     "ttl": TTLS[int(u["cls"]["ttl"].argmax())], "confidence": p3.max().item()})
                else:
                    temp_ops.append({"op": "T-UPDATE", "item": ti, "q": u["q"], "text": text, "confidence": p3.max().item()})
            elif r == "FORGET" and p3[ROUTE3.index("FORGET")].item() >= th["forget"]:
                lp = u["addr_q"]; w = int(lp.argmax())
                conf = p3[ROUTE3.index("FORGET")].item() * lp[w].exp().item()
                if w < K:
                    propose({"op": "FORGET", "target": records_meta[w]["id"], "confidence": conf, "evidence": {"span": span, "text": text}})
                elif w < K + E:
                    ops.append({"op": "FORGET_PROFILE", "entity": profiles_meta[w - K]["key"], "confidence": conf,
                                "evidence": {"span": span, "text": text}})
        retrieval = []
        if K:
            pr = torch.sigmoid(hd.retrieve_logits(enc.prof[enc.rec_prof], enc.att, enc.val, c_seg))
            retrieval = [{"id": records_meta[j]["id"], "score": pr[j].item()} for j in range(K) if pr[j].item() >= th["retrieve"]]
            pairs = self.merge_pairs(enc)
            if pairs:
                pm = torch.sigmoid(hd.merge_logits(pairs, enc.att, enc.val, enc.prof[enc.rec_prof], c_seg))
                rp = enc.rec_prof.tolist()
                for (j, k), p in zip(pairs, pm.tolist()):
                    g_lic = max(licence.get(rp[j], 0.0), licence.get(rp[k], 0.0))
                    if p >= th["merge"] and g_lic >= th["write"]:       # D1: own threshold AND the write gate
                        a, b = records_meta[j]["id"], records_meta[k]["id"]
                        if a not in per_record and b not in per_record:
                            per_record[a] = {"op": "MERGE", "target": a, "with": b, "confidence": p * g_lic}
        ops.extend(per_record.values())
        if enc.tmp.shape[0]:
            pe = torch.sigmoid(hd.expire_logits(enc.tmp, c_seg))
            for i, p in enumerate(pe.tolist()):
                if p >= th["expire"]:
                    temp_ops.append({"op": "T-EXPIRE", "item": i, "confidence": p})
        return {"operations": ops, "temp_ops": temp_ops, "retrieval": retrieval, "units": units, "mentions": ments}



# ---------------------------------------------------------------------------------------------
class PasteModel(DecisionMixin, nn.Module):
    def __init__(self, cfg: PasteConfig, encoder: ModernBert):
        super().__init__()
        self.cfg, self.enc = cfg, encoder
        d = cfg.d
        self.heads = SharedHeads(cfg)
        # memory pathway (PASTE-only; §4, §5.11-5.12)
        self.W_h, self.W_z, self.W_prof = nn.Linear(d, d), nn.Linear(d, d), nn.Linear(d, d)
        self.W_att, self.W_val, self.W_bind = nn.Linear(d, d), nn.Linear(d, d), nn.Linear(d, d)
        self.emb = nn.ModuleDict({
            "mem_index": nn.Embedding(cfg.r_mem, d), "group": nn.Embedding(len(GROUPS), d),
            "temp_type": nn.Embedding(len(TTYPES), d), "temp_age": nn.Embedding(N_TEMP_AGE, d),
            "rec_kind": nn.Embedding(N_REC_KIND, d), "rec_status": nn.Embedding(len(STATUSES), d),
            "rec_age": nn.Embedding(N_REC_AGE, d), "rec_evidence": nn.Embedding(N_REC_EV, d),
            "dt": nn.Embedding(N_DT, d)})
        self.h0 = nn.Parameter(torch.zeros(cfg.r_mem, d))
        self.gru_h, self.gru_t = nn.GRUCell(d, d), nn.GRUCell(d, d)
        self.W_new = nn.Linear(d, d)
        self._init_memory_pathway()
        self._ctx_cache = {}

    def _init_memory_pathway(self):
        std = self.cfg.init_std
        for lin in (self.W_h, self.W_z, self.W_prof, self.W_att, self.W_val, self.W_bind):   # zero-init (§4.1-4.3)
            nn.init.zeros_(lin.weight), nn.init.zeros_(lin.bias)
        for name in ("temp_type", "temp_age", "rec_kind", "rec_status", "rec_age", "rec_evidence", "dt"):
            nn.init.zeros_(self.emb[name].weight)                                       # metadata tables: zero (§4.1)
        # Clarification C2 (PHASE3-REPORT): group and memory-index embeddings and h0 start N(0, std^2).
        # The memory tokens share position 0; identical initial values would never become distinct.
        for name in ("group", "mem_index"):
            nn.init.normal_(self.emb[name].weight, std=std)
        nn.init.normal_(self.h0, std=std)

    def memory_pathway_parameters(self):
        mods = [self.W_h, self.W_z, self.W_prof, self.W_att, self.W_val, self.W_bind, self.emb,
                self.gru_h, self.gru_t, self.W_new]
        return [p for m in mods for p in m.parameters()] + [self.h0]

    # ---- cached contextual pooling (stop-gradient, once per record version) ---------------
    def clear_cache(self):
        self._ctx_cache = {}

    @torch.no_grad()
    def _ctx(self, texts):
        """Final-layer states of each id list, computed without gradient and cached by content.

        Each text is encoded alone at its exact length. Batching cache misses with padding made the cached
        states depend on which texts happened to share a batch (max diff 4.6e-5), so decisions depended on
        cache history (found in Phase 3; violates I4). Encoding alone makes them bitwise history-independent.
        """
        for t in {tuple(t) for t in texts}:
            if t not in self._ctx_cache:
                self._ctx_cache[t] = self.enc.encode_ids(torch.tensor([t]))[0].clone()
        return [self._ctx_cache[tuple(t)] for t in texts]

    def _static_all(self, s: StepInput):
        """Every static pooled embedding of a step from ONE embedding lookup (a lookup per record made the backward
        pass build a dense 19M-element embedding gradient per call; Phase 4 speed measurement). Same values."""
        spans, ids = [], []
        for ids_, idx in ([(t.ids, t.idx) for t in s.temps] + [(p.ids, p.idx) for p in s.profiles]
                          + [(r.ids, r.att) for r in s.records] + [(r.ids, r.val) for r in s.records]):
            sel = [ids_[i] for i in idx]
            spans.append((len(ids), len(ids) + len(sel))); ids.extend(sel)
        n_seg = len(s.seg_ids)
        emb = self.enc.embed(torch.tensor(ids + list(s.seg_ids)))
        pooled = [emb[a:b].mean(0) for a, b in spans]
        T, E, K = len(s.temps), len(s.profiles), len(s.records)
        return (pooled[:T], pooled[T:T + E], pooled[T + E:T + E + K], pooled[T + E + K:], emb[len(ids):len(ids) + n_seg])

    # ---- input assembly (§4.1-4.4) ------------------------------------------------------
    def prefix(self, s: StepInput, static=None):
        e = self.emb
        g = e["group"].weight
        st_t, st_p, st_a, st_v, _ = static if static is not None else self._static_all(s)
        h = s.h if s.h is not None else self.h0
        mem = self.W_h(h) + e["mem_index"].weight + e["dt"].weight[s.dt]
        parts = [mem]
        if s.temps:
            st = torch.stack(st_t)
            z = torch.stack([t.z for t in s.temps])
            tt = torch.tensor([t.ttype for t in s.temps]); ta = torch.tensor([t.tage for t in s.temps])
            parts.append(st + self.W_z(z) + e["temp_type"](tt) + e["temp_age"](ta) + g[0])
        prof_static = prof_ctx = None
        if s.profiles:
            prof_static = torch.stack(st_p)
            ctx = self._ctx([p.ids for p in s.profiles])
            prof_ctx = torch.stack([c[p.idx].mean(0) for c, p in zip(ctx, s.profiles)])
            parts.append(prof_static + self.W_prof(prof_ctx) + g[1])
        if s.records:
            rp = torch.tensor([r.prof for r in s.records])
            a0 = torch.stack(st_a)
            v0 = torch.stack(st_v)
            ctx = self._ctx([r.ids for r in s.records])
            aL = torch.stack([c[r.att].mean(0) for c, r in zip(ctx, s.records)])
            vL = torch.stack([c[r.val].mean(0) for c, r in zip(ctx, s.records)])
            mu = (e["rec_kind"](torch.tensor([r.kind for r in s.records])) + e["rec_status"](torch.tensor([r.status for r in s.records]))
                  + e["rec_age"](torch.tensor([r.age for r in s.records])) + e["rec_evidence"](torch.tensor([r.ev for r in s.records])))
            bind = 0.5 * prof_static[rp] + self.W_bind(prof_ctx[rp])
            parts.append(a0 + bind + self.W_att(aL) + mu + g[2])
            parts.append(v0 + bind + self.W_val(vL) + mu + g[3])
        return torch.cat(parts)

    def encode(self, batch, prefix_masked=False):
        """Batched encoder pass. prefix_masked=True hides every prefix token from the segment (test T2)."""
        seqs, plens, nlens = [], [], []
        for s in batch:
            static = self._static_all(s)
            p = self.prefix(s, static)
            seg = static[4]
            seqs.append(torch.cat([p, seg])); plens.append(p.shape[0]); nlens.append(seg.shape[0])
        B, N, d = len(batch), max(x.shape[0] for x in seqs), self.cfg.d
        x0 = torch.zeros(B, N, d)
        pos = torch.zeros(B, N, dtype=torch.long)
        valid = torch.zeros(B, N, dtype=torch.bool)
        pre = torch.zeros(B, N, dtype=torch.bool)
        for i, (x, P, n) in enumerate(zip(seqs, plens, nlens)):
            x0[i, :P + n] = x
            pos[i, P:P + n] = torch.arange(1, n + 1)
            valid[i, :P + n] = True
            pre[i, :P] = True
            if prefix_masked:
                valid[i, :P] = False
        H = self.enc(x0, pos, valid, pre)
        out = []
        for i, s in enumerate(batch):
            r, T, E, K = self.cfg.r_mem, len(s.temps), len(s.profiles), len(s.records)
            o = 0
            def take(k):
                nonlocal o
                t = H[i, o:o + k]; o += k
                return t
            mem, tmp, prof, att, val = take(r), take(T), take(E), take(K), take(K)
            seg = H[i, plens[i]:plens[i] + nlens[i]]
            if self.cfg.head_norm:                       # D2: parameter-free LayerNorm on head inputs (mem feeds GRU_H, not a head)
                ln = lambda t: F.layer_norm(t, t.shape[-1:]) if t.numel() else t
                tmp, prof, att, val, seg = ln(tmp), ln(prof), ln(att), ln(val), ln(seg)
            out.append(Encoded(mem, tmp, prof, att, val, seg, torch.tensor([x.prof for x in s.records], dtype=torch.long)))
        return out

    @torch.no_grad()
    def next_h(self, enc: Encoded, h_prev):
        """h_s = GRU_H(h~, h_{s-1}) row by row (§5.12)."""
        return self.gru_h(enc.mem, h_prev)

    @torch.no_grad()
    def new_item_vector(self, q):
        return self.W_new(q)

    @torch.no_grad()
    def update_item_vector(self, q, z):
        return self.gru_t(q[None], z[None])[0]
