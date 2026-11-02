"""Encoder baselines (spec §9.1; BASELINE-PLAN §1). All use the same Ettin encoder, SharedHeads and DecisionMixin as
PASTE; only the memory pathway differs (assumption A2).

TextMemoryModel ("M1c family"): the store is rendered as text after the segment and read jointly in every layer.
  M1c      window=0                        records + temporary items as text rows
  M1c-m    window=0, extra_layers=2        + 2 ModernBERT-style layers (zero-init residuals) + d x d projection
  M1c+W    window=2                        + raw text of the previous 2 segments of the session
  FC       window=None                     + every previous segment of the conversation (<= max_tokens, oldest dropped)
  RMT      window=0, memory_tokens=4       + 4 memory tokens carried by replacement (reset at each session)
KVModel ("KV"): the segment is encoded alone; records and temporary items are cached pooled vectors read only by the
  heads (late fusion), with flat addressing.

Fairness: PASTE receives record status and temporary-item type and age through embeddings, so M1c rows carry the
same information as words (DECISIONS.md 2026-11-02).
"""
import random

import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import STATUSES, TTYPES, PasteConfig
from .heads import SharedHeads
from .model import DecisionMixin, Encoded, StepInput
from .modernbert import Layer, ModernBert

AGE_WORDS = ["just now", "1 segment ago", "2-3 segments ago", "4-7 segments ago", "8-15 segments ago", "16-31 segments ago",
             "32-63 segments ago", "64+ segments ago"]
GAP_WORDS = ["start", "under a minute"] + [f"about {2 ** (k - 1)} minutes" for k in range(2, 16)]


class TextMemoryModel(DecisionMixin, nn.Module):
    def __init__(self, cfg: PasteConfig, encoder: ModernBert, text, window=0, extra_layers=0, memory_tokens=0, max_tokens=2048):
        super().__init__()
        self.cfg, self.enc, self.text = cfg, encoder, text
        self.window, self.max_tokens, self.r = window, max_tokens, memory_tokens
        self.heads = SharedHeads(cfg)
        self.extra = nn.ModuleList(Layer(cfg, 1) for _ in range(extra_layers))
        for lay in self.extra:                                  # identity at initialisation
            nn.init.zeros_(lay.Wo.weight); nn.init.zeros_(lay.Wo_mlp.weight)
        self.extra_proj = nn.Linear(cfg.d, cfg.d) if extra_layers else None
        if self.extra_proj is not None:
            nn.init.zeros_(self.extra_proj.weight); nn.init.zeros_(self.extra_proj.bias)
        if memory_tokens:
            self.W_m = nn.Linear(cfg.d, cfg.d)
            self.h0 = nn.Parameter(torch.randn(memory_tokens, cfg.d) * cfg.init_std)
        else:
            self.register_buffer("h0", torch.zeros(cfg.r_mem, cfg.d), persistent=False)
        self._tok = {}

    # ---- text pieces ----------------------------------------------------------------------
    def words(self, s):
        if s not in self._tok:
            ids, offs = self.text.encode(s)
            self._tok[s] = [i for i, o in zip(ids, offs) if o[1] > o[0]]
        return self._tok[s]

    def clear_cache(self):
        pass

    def encode(self, batch, prefix_masked=False):
        out = []
        for s in batch:
            out.append(self._encode_one(s))
        return out

    def _encode_one(self, s: StepInput):
        sep = s.seg_ids[-1]
        if self.window is None:                       # FC: the whole conversation so far
            hist = [ids for _, ids in s.history]
        elif self.window:                             # M1c+W: the previous `window` segments of this session
            hist = [ids for same, ids in s.history if same][-self.window:]
        else:
            hist = []
        rows = []                                    # (kind, index, token ids, field token positions)
        for e, p in enumerate(s.profiles):
            body = [p.ids[i] for i in p.idx]
            rows.append(("prof", e, body + [sep], list(range(len(body)))))
        for j, r in enumerate(s.records):
            body = r.ids[1:-1]
            st = STATUSES[r.status]
            tail = self.words(f" ({st})") if st != "confirmed" else []
            rows.append(("rec", j, body + tail + [sep], ([i - 1 for i in r.att], [i - 1 for i in r.val])))
        for i, t in enumerate(s.temps):
            head = self.words(f"{TTYPES[t.ttype].lower()}, {AGE_WORDS[t.tage]}:")
            body = [t.ids[k] for k in t.idx]
            rows.append(("tmp", i, head + body + [sep], list(range(len(head), len(head) + len(body)))))
        if self.training:
            random.shuffle(rows)                     # order carries no information (SOM-DST shuffles slots)
        gap = self.words(f"time since last message: {GAP_WORDS[min(s.dt, len(GAP_WORDS) - 1)]}") + [sep]
        mem_n = self.r
        seq, kinds = [], []
        # layout: [memory tokens] [CLS] segment [SEP] gap rows... [history (oldest dropped first)]
        seg = list(s.seg_ids)
        row_ids = gap + [t for _, _, ids, _ in rows for t in ids]
        budget = self.max_tokens - mem_n - len(seg) - len(row_ids)
        hist_ids = []
        for h_ids in reversed(hist):
            piece = self.words("earlier:") + list(h_ids[1:-1]) + [sep]
            if len(piece) > budget:
                break
            hist_ids = piece + hist_ids; budget -= len(piece)
        ids = seg + row_ids + hist_ids
        x_tok = self.enc.embed(torch.tensor(ids))
        if mem_n:
            h = s.h if s.h is not None else self.h0
            x = torch.cat([self.W_m(h[:mem_n]), x_tok])
        else:
            x = x_tok
        N = x.shape[0]
        pos = torch.arange(N)[None]
        valid = torch.ones(1, N, dtype=torch.bool)
        H = self.enc(x[None], pos, valid)[0]
        if len(self.extra):
            full = valid[:, None, None, :].expand(-1, 1, N, -1)
            from .modernbert import _rope_cache
            c, si = _rope_cache(pos, self.cfg.d // self.cfg.heads, self.cfg.rope_theta_global)
            Hx = H[None]
            for lay in self.extra:
                Hx = lay(Hx, full, c, si)
            H = Hx[0] + self.extra_proj(Hx[0])
        mem = H[:mem_n] if mem_n else torch.zeros(self.cfg.r_mem, self.cfg.d)
        base = mem_n
        seg_out = H[base:base + len(seg)]
        o = base + len(seg) + len(gap)
        E, K, T = len(s.profiles), len(s.records), len(s.temps)
        prof = torch.zeros(E, self.cfg.d); att = torch.zeros(K, self.cfg.d); val = torch.zeros(K, self.cfg.d)
        tmp = torch.zeros(T, self.cfg.d)
        prof_l, att_l, val_l, tmp_l = [None] * E, [None] * K, [None] * K, [None] * T
        for kind, idx, rids, fields in rows:
            blk = H[o:o + len(rids)]
            if kind == "prof":
                prof_l[idx] = blk[fields].mean(0)
            elif kind == "rec":
                att_l[idx], val_l[idx] = blk[fields[0]].mean(0), blk[fields[1]].mean(0)
            else:
                tmp_l[idx] = blk[fields].mean(0)
            o += len(rids)
        if E:
            prof = torch.stack(prof_l)
        if K:
            att, val = torch.stack(att_l), torch.stack(val_l)
        if T:
            tmp = torch.stack(tmp_l)
        if self.cfg.head_norm:
            ln = lambda t: F.layer_norm(t, t.shape[-1:]) if t.numel() else t
            tmp, prof, att, val, seg_out = ln(tmp), ln(prof), ln(att), ln(val), ln(seg_out)
        return Encoded(mem, tmp, prof, att, val, seg_out, torch.tensor([r.prof for r in s.records], dtype=torch.long))

    # ---- adapter hooks (text memory carries no latent state except RMT's memory tokens) --------
    @torch.no_grad()
    def next_h(self, enc, h_prev):
        return enc.mem.clone() if self.r else torch.zeros_like(h_prev)

    @torch.no_grad()
    def new_item_vector(self, q):
        return torch.zeros(self.cfg.d)

    @torch.no_grad()
    def update_item_vector(self, q, z):
        return z

    def train_transition(self, enc, h_prev):
        """Training-time transition with gradient (RMT: replacement; others: none)."""
        return enc.mem if self.r else None


class KVModel(DecisionMixin, nn.Module):
    """Learned key-value memory (brief baseline 7): the segment is encoded alone; profiles, records and temporary
    items are cached pooled encodings (stop-gradient, as in PASTE) projected by three learned maps and read only by
    the heads; addressing is flat."""

    def __init__(self, cfg: PasteConfig, encoder: ModernBert, text=None):
        super().__init__()
        import dataclasses
        self.cfg = dataclasses.replace(cfg, flat_address=True)
        self.enc, self.heads = encoder, SharedHeads(self.cfg)
        self.W_kv_prof, self.W_kv_att, self.W_kv_val = nn.Linear(cfg.d, cfg.d), nn.Linear(cfg.d, cfg.d), nn.Linear(cfg.d, cfg.d)
        self.register_buffer("h0", torch.zeros(cfg.r_mem, cfg.d), persistent=False)
        self._cache = {}

    def clear_cache(self):
        self._cache = {}

    @torch.no_grad()
    def _ctx(self, ids):
        t = tuple(ids)
        if t not in self._cache:
            self._cache[t] = self.enc.encode_ids(torch.tensor([ids]))[0].clone()
        return self._cache[t]

    def encode(self, batch, prefix_masked=False):
        out = []
        for s in batch:
            seg = self.enc.encode_ids(torch.tensor([s.seg_ids]))[0]
            d = self.cfg.d
            prof = torch.stack([self.W_kv_prof(self._ctx(p.ids)[p.idx].mean(0)) for p in s.profiles]) if s.profiles else torch.zeros(0, d)
            att = torch.stack([self.W_kv_att(self._ctx(r.ids)[r.att].mean(0)) for r in s.records]) if s.records else torch.zeros(0, d)
            val = torch.stack([self.W_kv_val(self._ctx(r.ids)[r.val].mean(0)) for r in s.records]) if s.records else torch.zeros(0, d)
            tmp = torch.stack([self.W_kv_val(self._ctx(t.ids)[t.idx].mean(0)) for t in s.temps]) if s.temps else torch.zeros(0, d)
            if self.cfg.head_norm:
                ln = lambda t: F.layer_norm(t, t.shape[-1:]) if t.numel() else t
                tmp, prof, att, val, seg = ln(tmp), ln(prof), ln(att), ln(val), ln(seg)
            out.append(Encoded(torch.zeros(self.cfg.r_mem, d), tmp, prof, att, val, seg,
                               torch.tensor([r.prof for r in s.records], dtype=torch.long)))
        return out

    @torch.no_grad()
    def next_h(self, enc, h_prev):
        return torch.zeros_like(h_prev)

    @torch.no_grad()
    def new_item_vector(self, q):
        return torch.zeros(self.cfg.d)

    @torch.no_grad()
    def update_item_vector(self, q, z):
        return z

    def train_transition(self, enc, h_prev):
        return None


def build(name, cfg, encoder, text):
    """Factory for the baselines named in BASELINE-PLAN §1."""
    if name == "M1c":
        return TextMemoryModel(cfg, encoder, text)
    if name == "M1c-m":
        return TextMemoryModel(cfg, encoder, text, extra_layers=2)
    if name == "M1c+W":
        return TextMemoryModel(cfg, encoder, text, window=2)
    if name == "FC":
        return TextMemoryModel(cfg, encoder, text, window=None)
    if name == "RMT":
        return TextMemoryModel(cfg, encoder, text, memory_tokens=4)
    if name == "KV":
        return KVModel(cfg, encoder, text)
    raise ValueError(name)
