"""T1: the ModernBERT reimplementation equals Hugging Face ModernBertModel (empty prefix).

Spec tolerance: max |diff| < 1e-4. Clarification C1 (PHASE3-REPORT): HF's own eager and SDPA paths differ by
~7e-4 on Ettin-32M at 300 tokens (hidden values reach ~41; eager computes softmax in float32), so the 1e-4
tolerance is applied against HF-SDPA (the same attention kernel), and the eager comparison must not exceed
HF's own eager-vs-SDPA gap by more than 1e-5.
"""
import pytest
import torch
from transformers import AutoModel

from paste.config import PasteConfig
from paste.modernbert import load_backbone


@pytest.mark.parametrize("name", ["ettin-encoder-32m", "ettin-encoder-17m"])
def test_t01_matches_hf(name):
    import os
    cache = os.environ["PASTE_HF_CACHE"]
    ours = load_backbone(PasteConfig.for_backbone(name)).eval()
    sdpa = AutoModel.from_pretrained(f"jhu-clsp/{name}", cache_dir=cache, attn_implementation="sdpa").eval()
    eager = AutoModel.from_pretrained(f"jhu-clsp/{name}", cache_dir=cache, attn_implementation="eager").eval()
    g = torch.Generator().manual_seed(7)
    for n in (7, 64, 65, 150, 300):          # 64/65 straddle the local half-window
        ids = torch.randint(5, 50000, (2, n), generator=g)
        valid = torch.ones_like(ids, dtype=torch.bool)
        valid[1, n - 3:] = False             # padding in the second row
        with torch.no_grad():
            o = ours.encode_ids(ids, valid)
            s = sdpa(input_ids=ids, attention_mask=valid.long()).last_hidden_state
            e = eager(input_ids=ids, attention_mask=valid.long()).last_hidden_state
        m = valid[..., None]
        d_sdpa = ((o - s).abs() * m).max().item()
        d_eager = ((o - e).abs() * m).max().item()
        d_hf = ((s - e).abs() * m).max().item()
        print(f"{name} n={n}: ours-sdpa {d_sdpa:.2e}  ours-eager {d_eager:.2e}  hf eager-sdpa {d_hf:.2e}  max|h| {s.abs().max():.1f}")
        assert d_sdpa < 1e-4
        assert d_eager <= d_hf + 1e-5
