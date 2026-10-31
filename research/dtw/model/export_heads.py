"""Export trained Decide heads for the Node runtime: heads.bin (float32,
little-endian, concatenated) + heads.json (tensor names, shapes, offsets,
labels, temperatures).

  python export_heads.py <run dir> [out dir]
"""
import json
import os
import sys

import numpy as np
import torch


def main():
    run = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else run
    sd = torch.load(os.path.join(run, "heads.pt"), map_location="cpu")
    cfg = json.load(open(os.path.join(run, "config.json")))
    tensors, off, blobs = {}, 0, []
    for name, t in sd.items():
        a = t.detach().float().numpy().astype("<f4")
        tensors[name] = {"shape": list(a.shape), "offset": off}
        off += a.size
        blobs.append(a.ravel())
    os.makedirs(out, exist_ok=True)
    np.concatenate(blobs).tofile(os.path.join(out, "heads.bin"))
    meta = {k: cfg[k] for k in ("base", "hidden", "tags", "kinds", "certs", "abouts", "rels", "temperature")}
    meta["ctx"] = cfg.get("ctx", "cls")
    meta["tensors"] = tensors
    json.dump(meta, open(os.path.join(out, "heads.json"), "w"), indent=1)
    print(f"{len(tensors)} tensors, {off} floats -> {out}")


if __name__ == "__main__":
    main()
