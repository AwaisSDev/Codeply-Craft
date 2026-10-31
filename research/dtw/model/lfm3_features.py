"""Frozen LFM3 token states for the "LFM3 + attached classifiers" system.

Reads span records (align.py), asks a running `llama-server --embedding
--pooling none` (LFM3 GGUF) for each input's token states, and stores them as
float16 in one file with an index, plus the token character offsets.

  python lfm3_features.py <port> <records.jsonl> <out prefix> [limit]
"""
import json
import sys
import urllib.request

import numpy as np


def post(port, path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=600))


def piece_offsets(text, tokens):
    """Character offsets of token pieces (strings or byte lists) in text, via UTF-8 bytes."""
    b = text.encode("utf-8")
    b2c = [0] * (len(b) + 1)
    bi = 0
    for ci, ch in enumerate(text):
        n = len(ch.encode("utf-8"))
        for k in range(n):
            b2c[bi + k] = ci
        bi += n
    b2c[len(b)] = len(text)
    out, cur = [], 0
    for t in tokens:
        p = t["piece"]
        pb = bytes(p) if isinstance(p, list) else str(p).encode("utf-8")
        if not pb or (cur == 0 and str(p) in ("<|startoftext|>", "<s>", "[CLS]")):
            out.append((b2c[cur], b2c[cur]))
            continue
        at = cur
        if b[at:at + len(pb)] != pb:
            j = b.find(pb, cur)
            at = j if 0 <= j - cur < 8 else cur
        end = min(len(b), at + len(pb))
        out.append((b2c[at], b2c[end]))
        cur = end
    return out


def main():
    port, src, prefix = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    rows = [json.loads(l) for l in open(src, encoding="utf-8")]
    if limit:
        rows = rows[:limit]
    index, chunks, off = [], [], 0
    f = open(prefix + ".f16", "wb")
    for i, r in enumerate(rows):
        toks = post(port, "/tokenize", {"content": r["text"], "add_special": True, "with_pieces": True})["tokens"][:2048]
        offs = piece_offsets(r["text"], toks)
        emb = post(port, "/embedding", {"content": [[t["id"] for t in toks]]})
        H = np.asarray(emb[0]["embedding"], dtype=np.float16)
        f.write(H.tobytes())
        index.append({"id": r["id"], "offset": off, "n": int(H.shape[0]), "dim": int(H.shape[1]), "offsets": offs})
        off += H.size
        if (i + 1) % 100 == 0:
            print(f"{i + 1}/{len(rows)}", flush=True)
    f.close()
    json.dump(index, open(prefix + ".index.json", "w"))
    print("done", len(index))


if __name__ == "__main__":
    main()
