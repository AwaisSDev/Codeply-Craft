"""Teacher-forced component metrics (diagnostic; validation data only).

End-to-end PE stays at its floor until every stage works at once (span, gate, attribute, address, entity), so short
runs need component-level signal. Gold spans and the gold store are given; each head is scored on its own:

  span_f1     exact-match F1 of decoded unit spans vs gold unit spans (BIO tagger)
  gate_acc    write gate at 0.5 vs gold route == PERSIST, over gold units
  attr_acc    attribute argmax on PERSIST units
  route3_acc  TEMP/IGNORE/FORGET argmax on non-PERSIST units
  addr_acc    argmax of the address distribution == gold omega (PERSIST and FORGET units)

Works for PASTE and every baseline (same SharedHeads / DecisionMixin interface).
"""
import collections

import torch

from .config import ROUTE3
from .data import segment_gold


@torch.no_grad()
def tf_metrics(model, adapter, episodes):
    was = model.training
    model.eval()
    c = collections.Counter()
    for ep in episodes:
        model.clear_cache()
        for seg in ep["segments"]:
            s_in, gold = segment_gold(adapter, seg, None)
            enc = model.encode([s_in])[0]
            tags = model.heads.bio_unit(enc.seg).argmax(-1).tolist()
            tags[0] = tags[-1] = 0
            pred = set(model.decode_bio(tags))
            gs = {tuple(u["span"]) for u in gold["units"]}
            c["span_tp"] += len(pred & gs); c["span_pred"] += len(pred); c["span_gold"] += len(gs)
            for u in gold["units"]:
                persist = u["route"] == "PERSIST"
                out = model.unit_outputs(enc, u["span"])
                c["gate_n"] += 1
                c["gate_ok"] += int((torch.sigmoid(out["gate"]).item() >= 0.5) == persist)
                if persist:
                    c["attr_n"] += 1
                    c["attr_ok"] += int(int(out["cls_s"]["attr"].argmax()) == u["attr"])
                else:
                    c["r3_n"] += 1
                    c["r3_ok"] += int(ROUTE3[int(out["cls"]["route3"].argmax())] == u["route"])
                if (persist or u["route"] == "FORGET") and "omega" in u:
                    lp = out["addr"] if persist else out["addr_q"]
                    c["addr_n"] += 1
                    c["addr_ok"] += int(int(lp.argmax()) == u["omega"])
    model.train(was)
    f = lambda a, b: round(c[a] / c[b], 4) if c[b] else None
    p, r = f("span_tp", "span_pred"), f("span_tp", "span_gold")
    return {"span_f1": round(2 * p * r / (p + r), 4) if p and r else 0.0, "span_precision": p, "span_recall": r,
            "gate_acc": f("gate_ok", "gate_n"), "gate_majority": round(1 - c["r3_n"] / c["gate_n"], 4) if c["gate_n"] else None,
            "attr_acc": f("attr_ok", "attr_n"), "route3_acc": f("r3_ok", "r3_n"), "addr_acc": f("addr_ok", "addr_n"),
            "units": c["gate_n"]}
