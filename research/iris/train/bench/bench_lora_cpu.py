import time, torch, sys
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model
path = sys.argv[1]; mode = sys.argv[2]; L = int(sys.argv[3]); B = int(sys.argv[4])
torch.manual_seed(0)
dtype = torch.bfloat16 if mode == "bf16w" else torch.float32
m = AutoModelForCausalLM.from_pretrained(path, torch_dtype=dtype)
n = sum(p.numel() for p in m.parameters())
cfg = LoraConfig(r=32, lora_alpha=64, lora_dropout=0.0, target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"], task_type="CAUSAL_LM")
m = get_peft_model(m, cfg)
tr = sum(p.numel() for p in m.parameters() if p.requires_grad)
opt = torch.optim.AdamW([p for p in m.parameters() if p.requires_grad], lr=1e-4)
x = torch.randint(1000, 50000, (B, L))
m.train()
ts = []
for i in range(4):
    t = time.time()
    if mode == "amp":
        with torch.autocast("cpu", dtype=torch.bfloat16):
            out = m(input_ids=x, labels=x)
    else:
        out = m(input_ids=x, labels=x)
    out.loss.backward(); opt.step(); opt.zero_grad()
    ts.append(time.time() - t)
best = min(ts[1:])
import resource
print(f"{path.split('/')[-1]} mode={mode} L={L} B={B} params={n/1e6:.0f}M trainable={tr/1e6:.1f}M step={best:.2f}s tok/s={B*L/best:.0f} loss={out.loss.item():.2f} rssGB={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e6:.1f}")
