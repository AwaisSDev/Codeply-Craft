"""Heads shared by PASTE and every encoder baseline (spec §5.1-§5.11; counts in §7).

Parameter shapes follow tools/param_count.py exactly (test T11).
"""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import ATTRS, CERTS, KINDS, RELS, ROUTE3, TTLS, TTYPES, PasteConfig

CLS_SPLITS = [("kind", len(KINDS)), ("cert", len(CERTS)), ("attr", len(ATTRS)),
              ("ttype", len(TTYPES)), ("ttl", len(TTLS)), ("route3", len(ROUTE3))]


def mlp(i, h, o):
    return nn.Sequential(nn.Linear(i, h), nn.GELU(), nn.Linear(h, o))


class Bilinear(nn.Module):
    """bil(q,k) = 1/H sum_h <W_q^h q, W_k^h k> / sqrt(d_h)   (spec §5.5)."""

    def __init__(self, d_in_q, d_in_k, heads, dim):
        super().__init__()
        self.q, self.k, self.h, self.dh = nn.Linear(d_in_q, heads * dim), nn.Linear(d_in_k, heads * dim), heads, dim

    def forward(self, q, k):  # q: [..., dq], k: [M, dk] -> [..., M]
        qh = self.q(q).view(*q.shape[:-1], self.h, self.dh)
        kh = self.k(k).view(k.shape[0], self.h, self.dh)
        return torch.einsum("...hd,mhd->...m", qh, kh) / (self.h * math.sqrt(self.dh))


class Interaction(nn.Module):
    """int(q,k) = w^T GELU(W [q; k; q*k] + b) + b'."""

    def __init__(self, d, hidden):
        super().__init__()
        self.net = mlp(3 * d, hidden, 1)

    def forward(self, q, k):  # q: [d], k: [M, d] -> [M]
        qq = q.expand(k.shape[0], -1)
        return self.net(torch.cat([qq, k, qq * k], -1)).squeeze(-1)


class SharedHeads(nn.Module):
    def __init__(self, cfg: PasteConfig):
        super().__init__()
        d, da, ha, dp = cfg.d, cfg.addr_dim, cfg.addr_heads, cfg.ptr_dim
        self.cfg = cfg
        self.bio_unit, self.bio_ent = nn.Linear(d, 3), nn.Linear(d, 3)
        self.query = nn.Sequential(nn.Linear(4 * d, d), nn.GELU(), nn.Linear(d, d), nn.LayerNorm(d))
        self.cls = nn.Linear(d, sum(n for _, n in CLS_SPLITS))
        self.write_gate = mlp(2 * d, 256, 1)
        # hierarchical profile addressing (§5.5)
        self.ent_bil, self.ent_int, self.ent_new = Bilinear(d, d, ha, da), Interaction(d, 256), nn.Linear(d, 1)
        self.rec_key = nn.Linear(2 * d, d)
        self.att_bil, self.att_int, self.att_new = Bilinear(d, d, ha, da), Interaction(d, 256), nn.Linear(2 * d, 1)
        self.relation = mlp(5 * d, d, len(RELS))
        # pointers (§5.4, §5.7, §5.11)
        self.src_bil, self.src_self = Bilinear(d, d, 1, dp), nn.Linear(d, 1)
        self.tmp_bil, self.tmp_int, self.tmp_new = Bilinear(d, d, 1, dp), Interaction(d, 128), nn.Linear(d, 1)
        self.ment_bil, self.ment_none = Bilinear(d, d, 1, dp), nn.Linear(d, 1)
        # per-record / pair / temporary-item heads (§5.9-5.11)
        self.retrieve, self.merge, self.expire = mlp(5 * d, 256, 1), mlp(4 * d, 256, 1), mlp(2 * d, 256, 1)

    # ---- unit query (§5.1) ------------------------------------------------------------
    def unit_query(self, seg, start, end):
        """seg: [n, d] segment token states; span [start, end) in segment-token indices."""
        n = seg.shape[0]
        w = self.cfg.window
        span = seg[start:end].mean(0)
        win = seg[max(0, start - w):min(n, end + w)].mean(0)
        c = seg.mean(0)
        return self.query(torch.cat([span, seg[start], win, c])), c

    def item_query(self, z, c):
        """q*_u for a promoted temporary item: Query([z; z; z; c]) (§5.4)."""
        return self.query(torch.cat([z, z, z, c]))

    def classify(self, q):
        out, i = {}, 0
        logits = self.cls(q)
        for name, n in CLS_SPLITS:
            out[name] = logits[..., i:i + n]
            i += n
        return out

    def gate(self, q, c):
        return self.write_gate(torch.cat([q, c], -1)).squeeze(-1)

    def source(self, q, items):  # logits over [SELF] + items
        s = self.src_self(q)
        if items.shape[0] == 0:
            return s
        return torch.cat([s, self.src_bil(q, items)])

    # ---- hierarchical addressing (§5.5) -----------------------------------------------
    def address(self, q, prof, att, val, rec_prof):
        """Returns log-probabilities over Omega = [records (K)] + [NEW-ATTR(e) (E)] + [NEW-ENT].

        prof: [E, d] profile states; att, val: [K, d]; rec_prof: [K] long, profile index of each record.
        """
        E, K = prof.shape[0], att.shape[0]
        s_ent = torch.cat([self.ent_bil(q, prof) + self.ent_int(q, prof), self.ent_new(q)]) if E else self.ent_new(q)
        log_ae = F.log_softmax(s_ent, -1)                        # [E + 1]
        out_rec = torch.full((K,), float("-inf"))
        out_new = torch.empty(E)
        if K:
            key = self.rec_key(torch.cat([att, val], -1))       # kappa_j
            s_rec = self.att_bil(q, key) + self.att_int(q, key)  # [K]
        for e in range(E):
            s_newattr = self.att_new(torch.cat([q, prof[e]])).reshape(1)
            idx = (rec_prof == e).nonzero().flatten() if K else torch.zeros(0, dtype=torch.long)
            scores = torch.cat([s_rec[idx], s_newattr]) if len(idx) else s_newattr
            la = F.log_softmax(scores, -1)
            if len(idx):
                out_rec = out_rec.index_put((idx,), log_ae[e] + la[:-1])
            out_new[e] = log_ae[e] + la[-1]
        return torch.cat([out_rec, out_new, log_ae[-1:]])

    def address_flat(self, q, prof, att, val, rec_prof):
        """Ablation A1 / KV: a flat pointer. One softmax over Omega with bilinear scores only (no entity stage, no
        interaction MLP); no new parameters. Same output layout as address()."""
        E, K = prof.shape[0], att.shape[0]
        parts = []
        if K:
            parts.append(self.att_bil(q, self.rec_key(torch.cat([att, val], -1))))
        if E:
            parts.append(torch.stack([self.att_new(torch.cat([q, prof[e]])).squeeze(-1) for e in range(E)]))
        parts.append(self.ent_new(q))
        return F.log_softmax(torch.cat(parts), -1)

    def relation_logits(self, q, a, v):
        return self.relation(torch.cat([q, a, v, q * v, (q - v).abs()]))

    def mention(self, q, ments):  # logits over mentions + NONE (last)
        none = self.ment_none(q)
        return torch.cat([self.ment_bil(q, ments), none]) if ments.shape[0] else none

    def temp_address(self, q, items):  # logits over items + NEW (last)
        new = self.tmp_new(q)
        if items.shape[0] == 0:
            return new
        return torch.cat([self.tmp_bil(q, items) + self.tmp_int(q, items), new])

    def retrieve_logits(self, prof_of_rec, att, val, c):
        cc = c.expand(att.shape[0], -1)
        return self.retrieve(torch.cat([prof_of_rec, att, val, cc, cc * val], -1)).squeeze(-1)

    def merge_logits(self, pairs, att, val, prof_of_rec, c):
        if not pairs:
            return torch.zeros(0)
        j, k = torch.tensor([p[0] for p in pairs]), torch.tensor([p[1] for p in pairs])
        cc = c.expand(len(pairs), -1)
        x = torch.cat([val[j] * val[k], (att[j] - att[k]).abs(), prof_of_rec[j] * prof_of_rec[k], cc], -1)
        return self.merge(x).squeeze(-1)

    def expire_logits(self, items, c):
        if items.shape[0] == 0:
            return torch.zeros(0)
        return self.expire(torch.cat([items, c.expand(items.shape[0], -1)], -1)).squeeze(-1)
