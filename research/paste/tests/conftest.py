import os
import sys

import pytest
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("PASTE_HF_CACHE", os.path.expanduser("~/.cache/paste-hf"))
torch.set_num_threads(4)

from paste.adapter import PasteAdapter  # noqa: E402
from paste.config import PasteConfig  # noqa: E402
from paste.model import PasteModel  # noqa: E402
from paste.modernbert import ettin_files, load_backbone  # noqa: E402
from paste.text import Text  # noqa: E402


def build_model(backbone="ettin-encoder-32m", seed=0, perturb=False):
    """Fresh PASTE model. perturb=True gives every zero-initialised memory-pathway parameter random values,
    standing in for a trained model so tests cannot pass merely because those parameters are zero."""
    torch.manual_seed(seed)
    cfg = PasteConfig.for_backbone(backbone)
    m = PasteModel(cfg, load_backbone(cfg)).eval()
    if perturb:
        g = torch.Generator().manual_seed(1000 + seed)
        with torch.no_grad():
            for p in m.memory_pathway_parameters():
                p.add_(torch.randn(p.shape, generator=g) * 0.05)
    return m


@pytest.fixture(scope="session")
def text():
    return Text(ettin_files("ettin-encoder-32m")[1])


@pytest.fixture(scope="session")
def model():
    return build_model(perturb=True)


@pytest.fixture(scope="session")
def adapter(model, text):
    return PasteAdapter(model, text)


T0 = 1_780_000_000.0   # a fixed epoch time for reproducible examples


def seg(text_user, at=T0, session="s1", assistant=None):
    turns = [{"speaker": "user", "text": text_user}]
    if assistant:
        turns.append({"speaker": "assistant", "text": assistant})
    return {"turns": turns, "at": at, "session_id": session}


STORE = [
    {"id": "m1", "entity": "user", "attribute": "home city", "value": "Karachi", "kind": "fact", "status": "confirmed", "evidence": 2, "updated_at": T0 - 86400 * 3},
    {"id": "m2", "entity": "sister:Ayesha", "profile_text": "Ayesha (sister)", "attribute": "home city", "value": "Karachi", "kind": "fact", "status": "confirmed", "evidence": 1, "updated_at": T0 - 86400},
    {"id": "m3", "entity": "coworker:Ali", "profile_text": "Ali (coworker)", "attribute": "favourite drink", "value": "tea", "kind": "preference", "status": "tentative", "evidence": 1, "updated_at": T0},
    {"id": "m4", "entity": "user", "attribute": "diet", "value": "vegetarian", "kind": "preference", "status": "confirmed", "evidence": 3, "updated_at": T0 - 86400 * 30},
]
