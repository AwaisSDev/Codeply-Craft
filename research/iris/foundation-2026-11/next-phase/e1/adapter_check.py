"""Import + adapter-loading check for the E1 Transformers cells (no generation beyond 4 tokens)."""
import json, sys, time, importlib.util
out = {"torchao_present": importlib.util.find_spec("torchao") is not None}
if out["torchao_present"]:
    import torchao; out["torchao_version"] = torchao.__version__
import torch, transformers, peft
out["versions"] = {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__}
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
base = sys.argv[1]; adapters = dict(a.split("=", 1) for a in sys.argv[2:])
tok = AutoTokenizer.from_pretrained(base)
dev = "cuda" if torch.cuda.is_available() else "cpu"
model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float16 if dev == "cuda" else torch.bfloat16)
out["adapters"] = {}
for name, path in adapters.items():
    t = time.time()
    try:
        m = PeftModel.from_pretrained(model, path)
        n = sum(1 for n_, _ in m.named_modules() if n_.endswith("lora_A"))
        merged = m.merge_and_unload()
        ids = tok("<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n", return_tensors="pt", add_special_tokens=False)["input_ids"].to(dev)
        merged.to(dev)
        g = merged.generate(ids, max_new_tokens=4, do_sample=False)
        out["adapters"][name] = {"ok": True, "lora_modules": n, "seconds": round(time.time() - t, 1)}
        model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float16 if dev == "cuda" else torch.bfloat16)
    except Exception as e:  # noqa: BLE001
        out["adapters"][name] = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}
out["pass"] = all(v["ok"] for v in out["adapters"].values()) and len(out["adapters"]) == len(adapters)
print(json.dumps(out))
sys.exit(0 if out["pass"] else 4)
