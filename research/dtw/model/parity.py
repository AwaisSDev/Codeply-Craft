"""Do llama.cpp and PyTorch give the same token states for a fine-tuned encoder?

Sends the Hugging Face tokenizer's token ids to `llama-server --embedding
--pooling none` (so tokenisation cannot differ) and compares every token's
state with the PyTorch backbone's last_hidden_state. Also checks that
llama.cpp's own tokenizer gives the same ids.

  python parity.py <backbone dir> <port> [records.jsonl]
"""
import json
import sys
import urllib.request

import torch
from transformers import AutoModel, AutoTokenizer


def post(port, path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=300))


def main():
    bdir, port = sys.argv[1], int(sys.argv[2])
    texts = []
    if len(sys.argv) > 3:
        texts = [json.loads(l)["text"] for l in open(sys.argv[3], encoding="utf-8")][:12]
    else:
        texts = ["now 2026-10-29 09:10 (Thursday) Asia/Karachi\n[e1] chat · from user\nUser: oh sure, I LOVE 7am standups 🙃\nAssistant: Done."]
    tok = AutoTokenizer.from_pretrained(bdir)
    model = AutoModel.from_pretrained(bdir).eval()
    cos_all, same_tok = [], 0
    for t in texts:
        ids = tok(t)["input_ids"]
        with torch.no_grad():
            ref = model(input_ids=torch.tensor([ids])).last_hidden_state[0]
        res = post(port, "/embedding", {"content": [ids]})
        got = torch.tensor(res[0]["embedding"])
        if got.shape != ref.shape:
            print("shape", tuple(got.shape), tuple(ref.shape))
            n = min(len(got), len(ref))
            got, ref = got[:n], ref[:n]
        cos = torch.nn.functional.cosine_similarity(got, ref, dim=-1)
        cos_all.append(cos)
        lt = post(port, "/tokenize", {"content": t, "add_special": True})["tokens"]
        same_tok += int(lt == ids)
    c = torch.cat(cos_all)
    print(json.dumps({"texts": len(texts), "tokens": len(c), "cos_mean": round(c.mean().item(), 5), "cos_min": round(c.min().item(), 5),
                      "llama_tokenizer_identical": f"{same_tok}/{len(texts)}"}))


if __name__ == "__main__":
    main()
