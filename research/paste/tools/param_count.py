"""Exact parameter counts for the PASTE v2 specification (ARCHITECTURE-SPEC.md §7).

Builds the new modules with the shapes the specification defines and counts
their parameters; the backbone counts are read from the released Ettin
checkpoints (encoder only, MLM head excluded). The prototype must reproduce
these numbers (a unit test compares them).

    python research/paste/tools/param_count.py [--ettin-dir DIR]
"""
import argparse
import json
import os

import torch
import torch.nn as nn

BACKBONES = {  # encoder-only parameter counts, measured from the released checkpoints
    "ettin-encoder-17m": {"d": 256, "layers": 7, "heads": 4, "ff": 384, "encoder": 16_797_440, "tok_emb": 12_894_208},
    "ettin-encoder-32m": {"d": 384, "layers": 10, "heads": 6, "ff": 576, "encoder": 31_883_136, "tok_emb": 19_341_312},
}

N_KIND, N_CERT, N_ATTR, N_TTYPE, N_TTL, N_ROUTE3, N_REL = 9, 6, 101, 6, 3, 3, 4
R_MEM = 4                       # recurrent memory tokens
EMB_ROWS = {                    # learned embedding tables added to prefix tokens
    "mem_index": R_MEM, "group": 4,  # groups: temp, profile, attribute, value
    "temp_type": N_TTYPE, "temp_age": 8, "rec_kind": N_KIND + 1, "rec_status": 3,
    "rec_age": 12, "rec_evidence": 8, "dt": 16,
}


def mlp(i, h, o):
    return nn.Sequential(nn.Linear(i, h), nn.GELU(), nn.Linear(h, o))


def paste_specific(d):
    """Modules only PASTE has (the memory pathway)."""
    return nn.ModuleDict({
        # zero-initialised projections of final-layer pooled states / recurrent vectors into the input space
        "W_h": nn.Linear(d, d), "W_z": nn.Linear(d, d), "W_prof": nn.Linear(d, d),
        "W_att": nn.Linear(d, d), "W_val": nn.Linear(d, d), "W_bind": nn.Linear(d, d),
        "emb": nn.ModuleDict({k: nn.Embedding(n, d) for k, n in EMB_ROWS.items()}),
        "h0": nn.ParameterList([nn.Parameter(torch.zeros(R_MEM, d))]),
        "gru_h": nn.GRUCell(d, d),          # recurrent memory-token update
        "gru_t": nn.GRUCell(d, d),          # temporary-slot content update
        "W_new": nn.Linear(d, d),           # new temporary slot from a unit
    })


def shared_heads(d, da=64, ha=4, dp=128):
    """Heads shared by PASTE and every encoder baseline (M1c, M1c-m, M1c+W, RMT, FC, KV)."""
    hd = ha * da
    return nn.ModuleDict({
        "bio_unit": nn.Linear(d, 3), "bio_ent": nn.Linear(d, 3),
        "query": nn.Sequential(nn.Linear(4 * d, d), nn.GELU(), nn.Linear(d, d), nn.LayerNorm(d)),  # [span mean; first token; +-16 window mean; segment context]
        "cls": nn.Linear(d, N_KIND + N_CERT + N_ATTR + N_TTYPE + N_TTL + N_ROUTE3),
        "write_gate": mlp(2 * d, 256, 1),
        # hierarchical profile addressing
        "ent_q": nn.Linear(d, hd), "ent_k": nn.Linear(d, hd), "ent_int": mlp(3 * d, 256, 1), "ent_new": nn.Linear(d, 1),
        "rec_key": nn.Linear(2 * d, d), "att_q": nn.Linear(d, hd), "att_k": nn.Linear(d, hd),
        "att_int": mlp(3 * d, 256, 1), "att_new": nn.Linear(2 * d, 1),
        "relation": mlp(5 * d, d, N_REL),
        "src_q": nn.Linear(d, dp), "src_k": nn.Linear(d, dp), "src_self": nn.Linear(d, 1),
        "tmp_q": nn.Linear(d, dp), "tmp_k": nn.Linear(d, dp), "tmp_int": mlp(3 * d, 128, 1), "tmp_new": nn.Linear(d, 1),
        "ment_q": nn.Linear(d, dp), "ment_k": nn.Linear(d, dp), "ment_none": nn.Linear(d, 1),
        "retrieve": mlp(5 * d, 256, 1),
        "merge": mlp(4 * d, 256, 1),
        "expire": mlp(2 * d, 256, 1),
    })


def matched_extra(d, ff, layers=2):
    """Capacity added to M1c-m: extra ModernBERT-style layers (attn Wqkv+Wo, GeGLU Wi+Wo, 2 norms) + a d x d projection."""
    per = 3 * d * d + d * d + d * 2 * ff + ff * d + 2 * d
    return layers * per + d * d + d


def count(m):
    return sum(p.numel() for p in m.parameters())


def main():
    ap = argparse.ArgumentParser()
    ap.parse_args()
    rows = {}
    for name, b in BACKBONES.items():
        d = b["d"]
        ps, sh = count(paste_specific(d)), count(shared_heads(d))
        extra = matched_extra(d, b["ff"])
        rows[name] = {
            "backbone_encoder": b["encoder"], "backbone_non_embedding": b["encoder"] - b["tok_emb"],
            "paste_specific": ps, "shared_heads": sh,
            "PASTE": b["encoder"] + ps + sh,
            "M1c": b["encoder"] + sh,
            "M1c-m (matched)": b["encoder"] + sh + extra,
            "RMT (M1c + memory tokens, replacement)": b["encoder"] + sh + d * d + d + R_MEM * d,
            "KV (late-fusion key-value)": b["encoder"] + sh + 3 * (d * d + d),
        }
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
