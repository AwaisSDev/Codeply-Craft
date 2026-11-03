"""Addressing diagnostics (RESEARCH.md queue item 1; validation data only).

Teacher-forced (gold store, gold spans). For every PERSIST unit with a gold address omega over
Omega = records (K) | NEW-ATTR(e) for each profile (E) | NEW-ENT:

  acc_by_type      argmax(addr) == omega, split by gold type (record / new_attr / new_ent)
  entity_acc       the entity factor: argmax over {profiles, NEW-ENT} of the summed probability
                   (records of e + NEW-ATTR(e)) equals the gold entity
  record_given_ent within the gold entity's options (its records + NEW-ATTR(e)), argmax equals omega
  rule_ref         gold entity + the model's predicted attribute -> that entity's record with the same attribute,
                   else NEW-ATTR(e) (NEW-ENT when the gold entity is new). A reference for how much of the record
                   factor is "does this profile already hold this attribute"
  rule_ref_gold_attr  the same rule with the gold attribute (upper reference)

    python tools/addr_diag.py --run RUN_DIR --val V.jsonl --limit 30
"""
import argparse
import collections
import json
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from paste.adapter import PasteAdapter  # noqa: E402
from paste.config import ATTRS, PasteConfig  # noqa: E402
from paste.data import segment_gold  # noqa: E402
from paste.modernbert import ettin_files  # noqa: E402
from paste.text import Text  # noqa: E402
from paste.train import load_eps, make_model  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--val", required=True)
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--threads", type=int, default=2)
    a = ap.parse_args()
    if "frozen" in a.val or "/test-" in a.val or "/stress-" in a.val:
        raise SystemExit("validation data only")
    torch.set_num_threads(a.threads)
    conf = json.load(open(os.path.join(a.run, "config.json")))
    cfg = PasteConfig(head_norm=conf.get("head_norm", False), flat_address=conf.get("flat_address", False))
    text = Text(ettin_files(cfg.backbone)[1])
    m = make_model(conf["system"], cfg, text)
    m.load_state_dict(torch.load(os.path.join(a.run, "final.pt"), weights_only=False)["model"])
    m.eval()
    ad = PasteAdapter(m, text)
    c = collections.Counter()
    with torch.no_grad():
        for ep in load_eps([a.val])[:a.limit]:
            m.clear_cache()
            for seg in ep["segments"]:
                s_in, gold = segment_gold(ad, seg, None)
                enc = m.encode([s_in])[0]
                K, E = enc.att.shape[0], enc.prof.shape[0]
                rec_prof = enc.rec_prof.tolist()
                rec_attr = [r["attribute"] for r in seg["store_before"]]
                assert len(rec_attr) == K
                for u in gold["units"]:
                    if u["route"] != "PERSIST" or "omega" not in u:
                        continue
                    om = u["omega"]
                    typ = "record" if om < K else ("new_attr" if om < K + E else "new_ent")
                    out = m.unit_outputs(enc, u["span"])
                    p = out["addr"].exp()
                    c[f"n_{typ}"] += 1
                    c[f"ok_{typ}"] += int(int(p.argmax()) == om)
                    # entity factor
                    ent_p = torch.zeros(E + 1)
                    for j in range(K):
                        ent_p[rec_prof[j]] += p[j]
                    ent_p[:E] += p[K:K + E]
                    ent_p[E] += p[K + E]
                    g_ent = rec_prof[om] if om < K else (om - K if om < K + E else E)
                    c["ent_ok"] += int(int(ent_p.argmax()) == g_ent)
                    c["n"] += 1
                    # record factor given the gold entity, and the rule references
                    if g_ent < E:
                        opts = [j for j in range(K) if rec_prof[j] == g_ent] + [K + g_ent]
                        best = max(opts, key=lambda j: float(p[j]))
                        c["rge_n"] += 1
                        c["rge_ok"] += int(best == om)
                        for name, attr in (("rule_pred", ATTRS[int(out["cls_s"]["attr"].argmax())]),
                                           ("rule_gold", ATTRS[u["attr"]])):
                            hit = [j for j in range(K) if rec_prof[j] == g_ent and rec_attr[j] == attr]
                            c[name] += int((hit[0] if hit else K + g_ent) == om)
                    else:
                        c["rule_pred"] += 1; c["rule_gold"] += 1      # NEW-ENT is given by the gold entity
                        c["rge_newent"] += 1
    f = lambda x, n: round(c[x] / c[n], 4) if c[n] else None
    res = {"units": c["n"],
           "acc_overall": round(sum(c[f"ok_{t}"] for t in ("record", "new_attr", "new_ent")) / max(1, c["n"]), 4),
           "acc_by_type": {t: f(f"ok_{t}", f"n_{t}") for t in ("record", "new_attr", "new_ent")},
           "n_by_type": {t: c[f"n_{t}"] for t in ("record", "new_attr", "new_ent")},
           "entity_acc": f("ent_ok", "n"), "record_given_entity_acc": f("rge_ok", "rge_n"),
           "rule_ref_pred_attr": f("rule_pred", "n"), "rule_ref_gold_attr": f("rule_gold", "n")}
    print(json.dumps(res, indent=1))
    json.dump(res, open(os.path.join(a.run, "addr-diag.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
