"""ModernBERT encoder reimplemented so PASTE controls positions and masks (spec §4.4-4.5).

Weights are Ettin's released `model.*` tensors (MLM head dropped). With no prefix and
default positions it must equal Hugging Face `ModernBertModel` (test T1).
"""
import math
import os

import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import PasteConfig


def _rope_cache(positions: torch.Tensor, dim: int, theta: float):
    inv = 1.0 / (theta ** (torch.arange(0, dim, 2, dtype=torch.float32, device=positions.device) / dim))
    f = positions[..., None].float() * inv                     # [B, N, dim/2]
    emb = torch.cat([f, f], dim=-1)
    return emb.cos(), emb.sin()


def _rotate_half(x):
    h = x.shape[-1] // 2
    return torch.cat([-x[..., h:], x[..., :h]], dim=-1)


def _apply_rope(q, k, cos, sin):
    cos, sin = cos[:, None], sin[:, None]                       # [B, 1, N, dim]
    qf, kf = q.float(), k.float()
    return ((qf * cos) + _rotate_half(qf) * sin).to(q.dtype), ((kf * cos) + _rotate_half(kf) * sin).to(k.dtype)


class Layer(nn.Module):
    def __init__(self, cfg: PasteConfig, idx: int):
        super().__init__()
        d = cfg.d
        self.attn_norm = nn.Identity() if idx == 0 else nn.LayerNorm(d, eps=cfg.norm_eps, bias=False)
        self.Wqkv = nn.Linear(d, 3 * d, bias=False)
        self.Wo = nn.Linear(d, d, bias=False)
        self.mlp_norm = nn.LayerNorm(d, eps=cfg.norm_eps, bias=False)
        self.Wi = nn.Linear(d, 2 * cfg.ff, bias=False)
        self.Wo_mlp = nn.Linear(cfg.ff, d, bias=False)
        self.h, self.hd = cfg.heads, d // cfg.heads

    def forward(self, x, mask, cos, sin):
        B, N, d = x.shape
        qkv = self.Wqkv(self.attn_norm(x)).view(B, N, 3, self.h, self.hd)
        q, k, v = (t.transpose(1, 2) for t in qkv.unbind(2))   # [B, h, N, hd]
        q, k = _apply_rope(q, k, cos, sin)
        a = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, scale=self.hd ** -0.5)
        x = x + self.Wo(a.transpose(1, 2).reshape(B, N, d))
        inp, gate = self.Wi(self.mlp_norm(x)).chunk(2, dim=-1)
        return x + self.Wo_mlp(F.gelu(inp) * gate)


class ModernBert(nn.Module):
    def __init__(self, cfg: PasteConfig):
        super().__init__()
        self.cfg = cfg
        self.tok = nn.Embedding(cfg.vocab, cfg.d)
        self.emb_norm = nn.LayerNorm(cfg.d, eps=cfg.norm_eps, bias=False)
        self.layers = nn.ModuleList(Layer(cfg, i) for i in range(cfg.layers))
        self.final_norm = nn.LayerNorm(cfg.d, eps=cfg.norm_eps, bias=False)

    def embed(self, ids: torch.Tensor) -> torch.Tensor:
        """LN0(Emb(ids)): the layer-0 input map (spec §3)."""
        return self.emb_norm(self.tok(ids))

    def build_masks(self, pos, valid, prefix, block=None):
        """Boolean attention masks [B, 1, N, N] for global and local layers (spec §4.4).

        block (optional, [B, N] long): tokens with block ids b > 0 and b' > 0, b != b', do not attend to each other
        (parallel rows, A3); block 0 attends and is attended as usual."""
        keyok = valid[:, None, None, :]
        full = keyok.expand(-1, 1, pos.shape[1], -1)
        near = (pos[:, :, None] - pos[:, None, :]).abs() <= self.cfg.local_window // 2
        glob = prefix[:, :, None] | prefix[:, None, :]
        local = (near | glob)[:, None] & keyok
        if block is not None:
            bq, bk = block[:, :, None], block[:, None, :]
            ok = ((bq == bk) | (bq == 0) | (bk == 0))[:, None]
            full, local = full & ok, local & ok
        return full, local

    def forward(self, x0, pos, valid, prefix=None, block=None):
        """x0: [B, N, d] layer-0 inputs; pos: [B, N] positions; valid: [B, N] bool; prefix: [B, N] bool;
        block: [B, N] long or None (see build_masks)."""
        if prefix is None:
            prefix = torch.zeros_like(valid)
        full, local = self.build_masks(pos, valid, prefix, block)
        hd = self.cfg.d // self.cfg.heads
        cg, sg = _rope_cache(pos, hd, self.cfg.rope_theta_global)
        cl, sl = _rope_cache(pos, hd, self.cfg.rope_theta_local)
        x = x0
        for i, layer in enumerate(self.layers):
            g = self.cfg.is_global(i)
            x = layer(x, full if g else local, cg if g else cl, sg if g else sl)
        return self.final_norm(x)

    def encode_ids(self, ids, valid=None):
        """Plain encoder over token ids (no prefix), positions 0..N-1 as in HF."""
        if valid is None:
            valid = torch.ones_like(ids, dtype=torch.bool)
        pos = torch.arange(ids.shape[1], device=ids.device)[None].expand_as(ids)
        return self.forward(self.embed(ids), pos, valid)

    # ---- weights ---------------------------------------------------------------
    def load_ettin(self, state_dict: dict):
        m = {"tok.weight": "model.embeddings.tok_embeddings.weight", "emb_norm.weight": "model.embeddings.norm.weight",
             "final_norm.weight": "model.final_norm.weight"}
        for i in range(self.cfg.layers):
            p = f"model.layers.{i}."
            if i > 0:
                m[f"layers.{i}.attn_norm.weight"] = p + "attn_norm.weight"
            m.update({f"layers.{i}.Wqkv.weight": p + "attn.Wqkv.weight", f"layers.{i}.Wo.weight": p + "attn.Wo.weight",
                      f"layers.{i}.mlp_norm.weight": p + "mlp_norm.weight", f"layers.{i}.Wi.weight": p + "mlp.Wi.weight",
                      f"layers.{i}.Wo_mlp.weight": p + "mlp.Wo.weight"})
        own = self.state_dict()
        missing = [k for k in own if k not in m]
        if missing:
            raise KeyError(f"unmapped parameters: {missing}")
        self.load_state_dict({k: state_dict[v] for k, v in m.items()}, strict=True)
        return self


def ettin_files(name: str):
    """Paths to the released checkpoint and tokenizer (downloaded once into PASTE_HF_CACHE)."""
    from huggingface_hub import hf_hub_download
    cache = os.environ.get("PASTE_HF_CACHE") or os.path.expanduser("~/.cache/paste-hf")   # empty means unset
    repo = f"jhu-clsp/{name}"
    return (hf_hub_download(repo, "pytorch_model.bin", cache_dir=cache),
            hf_hub_download(repo, "tokenizer.json", cache_dir=cache))


def load_backbone(cfg: PasteConfig) -> ModernBert:
    w, _ = ettin_files(cfg.backbone)
    sd = torch.load(w, map_location="cpu", weights_only=True)
    return ModernBert(cfg).load_ettin(sd)
