"""The Decide model: classification heads over token states.

The heads are the same whatever produces the token states: a fine-tuned
encoder (Ettin / mmBERT, `DecideEncoder`) or a frozen LFM3 read through
llama.cpp (`train_lfm3_heads.py`).

Heads
  tag       per token: O, B-OBS, I-OBS, B-PLAN, I-PLAN (event tokens only)
  kind      per observation span: 9 kinds
  certainty per observation span: 6
  about     per observation span: user / person / project
  importance per observation span: 0..1
  merge     per observation span: NEW or one of the known memories [m1]..[mK]
  relation  per (span, target memory): same / different
  gate      per input: anything to keep at all
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

TAGS = ["O", "B-OBS", "I-OBS", "B-PLAN", "I-PLAN"]
KINDS = ["preference", "fact", "routine", "style", "decision", "idea", "requirement", "todo", "context"]
CERTS = ["stated", "implied", "temporary", "joking", "hypothetical", "quoting"]
ABOUTS = ["user", "person", "project"]
RELS = ["same", "different"]


class DecideHeads(nn.Module):
    def __init__(self, hidden, inner=512, dropout=0.1):
        super().__init__()
        self.tag = nn.Sequential(nn.Dropout(dropout), nn.Linear(hidden, len(TAGS)))
        self.span = nn.Sequential(nn.Dropout(dropout), nn.Linear(3 * hidden, inner), nn.GELU())
        self.kind = nn.Linear(inner, len(KINDS))
        self.cert = nn.Linear(inner, len(CERTS))
        self.about = nn.Linear(inner, len(ABOUTS))
        self.imp = nn.Linear(inner, 1)
        self.pair = nn.Sequential(nn.Dropout(dropout), nn.Linear(3 * hidden, inner), nn.GELU())
        self.pair_score = nn.Linear(inner, 1)
        self.pair_rel = nn.Linear(inner, len(RELS))
        self.new = nn.Linear(hidden, 1)
        self.gate = nn.Sequential(nn.Dropout(dropout), nn.Linear(hidden, 1))

    @staticmethod
    def pool(h, a, b):
        """Mean of token states a..b-1 (b > a)."""
        return h[a:b].mean(0)

    def span_vec(self, h, ctx, a, b):
        return torch.cat([self.pool(h, a, b), h[a], ctx])

    def span_out(self, h, ctx, a, b):
        z = self.span(self.span_vec(h, ctx, a, b))
        return {"kind": self.kind(z), "cert": self.cert(z), "about": self.about(z), "imp": torch.sigmoid(self.imp(z)).squeeze(-1)}

    def merge_out(self, h, a, b, mems):
        """Logits over [NEW, m1..mK] and relation logits per memory. mems: list of (start, end) token ranges."""
        s = self.pool(h, a, b)
        logits = [self.new(s).squeeze(-1)]
        rels = []
        for (ma, mb) in mems:
            m = self.pool(h, ma, mb)
            z = self.pair(torch.cat([s, m, s * m]))
            logits.append(self.pair_score(z).squeeze(-1))
            rels.append(self.pair_rel(z))
        return torch.stack(logits), (torch.stack(rels) if rels else None)


def example_loss(heads, h, ctx, ex, tag_ids, event_mask, weights):
    """Loss for one example. h: [T, H] token states; ctx: [H] whole-input vector."""
    out = {}
    tag_logits = heads.tag(h)
    m = event_mask.bool()
    out["tag"] = F.cross_entropy(tag_logits[m], tag_ids[m], weight=weights.get("tag"))
    span_losses, merge_losses = [], []
    for sp in ex["tok_spans"]:
        if sp["type"] != "obs":
            continue
        a, b = sp["a"], sp["b"]
        o = heads.span_out(h, ctx, a, b)
        span_losses.append(
            F.cross_entropy(o["kind"][None], torch.tensor([KINDS.index(sp["kind"])]), weight=weights.get("kind"))
            + F.cross_entropy(o["cert"][None], torch.tensor([CERTS.index(sp["certainty"])]), weight=weights.get("cert"))
            + 0.5 * F.cross_entropy(o["about"][None], torch.tensor([ABOUTS.index(sp["about"])]))
            + 2.0 * (o["imp"] - sp["importance"]) ** 2)
        if ex["tok_mems"]:
            logits, rels = heads.merge_out(h, a, b, ex["tok_mems"])
            tgt = sp["merge"] + 1  # 0 = NEW
            l = F.cross_entropy(logits[None], torch.tensor([tgt]))
            if tgt > 0 and sp["relation"] in RELS:
                l = l + F.cross_entropy(rels[tgt - 1][None], torch.tensor([RELS.index(sp["relation"])]))
            merge_losses.append(l)
    out["span"] = torch.stack(span_losses).mean() if span_losses else h.new_zeros(())
    out["merge"] = torch.stack(merge_losses).mean() if merge_losses else h.new_zeros(())
    out["gate"] = F.binary_cross_entropy_with_logits(heads.gate(ctx).squeeze(-1), torch.tensor(float(ex["gate"])))
    out["total"] = out["tag"] + out["span"] + out["merge"] + 0.5 * out["gate"]
    return out


def decode_tags(tag_ids, event_mask):
    """BIO tags -> [(type, a, b)] token ranges (b exclusive)."""
    spans, cur = [], None
    for i, t in enumerate(tag_ids):
        if not event_mask[i]:
            if cur:
                spans.append(cur)
                cur = None
            continue
        name = TAGS[t]
        if name.startswith("B-") or (name.startswith("I-") and (cur is None or cur[0] != name[2:])):
            if cur:
                spans.append(cur)
            cur = [name[2:], i, i + 1]
        elif name.startswith("I-"):
            cur[2] = i + 1
        else:
            if cur:
                spans.append(cur)
            cur = None
    if cur:
        spans.append(cur)
    return [tuple(s) for s in spans]


class DecideEncoder(nn.Module):
    """A Hugging Face encoder (ModernBERT family) with the Decide heads."""

    def __init__(self, name):
        super().__init__()
        from transformers import AutoModel
        self.backbone = AutoModel.from_pretrained(name)
        self.heads = DecideHeads(self.backbone.config.hidden_size)

    def states(self, input_ids, attention_mask):
        h = self.backbone(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        return h
