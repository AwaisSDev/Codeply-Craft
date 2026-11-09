import time, torch, sys, resource
import transformers
from transformers import AutoModelForCausalLM, AutoConfig
path = "Qwen/Qwen3.5-0.8B"
try:
    m = AutoModelForCausalLM.from_pretrained(path, torch_dtype=torch.bfloat16)
except Exception as e:
    print("AutoModelForCausalLM failed:", type(e).__name__, str(e)[:300]); 
    m = None
    for name in ("Qwen3_5ForCausalLM", "Qwen3_5ForConditionalGeneration"):
        if hasattr(transformers, name):
            try:
                m = getattr(transformers, name).from_pretrained(path, torch_dtype=torch.bfloat16); print("loaded with", name); break
            except Exception as e2: print(name, "failed:", str(e2)[:200])
    if m is None: sys.exit(1)
print(type(m).__name__, f"{sum(p.numel() for p in m.parameters())/1e6:.0f}M params")
names = sorted({n.split('.')[-1] for n, mod in m.named_modules() if isinstance(mod, torch.nn.Linear)})
print("linear module names:", names[:40])
from peft import LoraConfig, get_peft_model
tm = [n for n in names if n not in ("lm_head",)]
m = get_peft_model(m, LoraConfig(r=32, lora_alpha=64, target_modules=tm, task_type="CAUSAL_LM"))
opt = torch.optim.AdamW([p for p in m.parameters() if p.requires_grad], lr=1e-4)
x = torch.randint(1000, 50000, (1, 768)); m.train(); ts = []
for i in range(3):
    t = time.time(); out = m(input_ids=x, labels=x); out.loss.backward(); opt.step(); opt.zero_grad(); ts.append(time.time() - t)
print(f"Qwen3.5-0.8B LoRA bf16 L=768 B=1 step={min(ts[1:]):.2f}s tok/s={768/min(ts[1:]):.0f} rssGB={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e6:.1f}")
