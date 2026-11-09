# CPU LoRA throughput (this container: 4 cores, Intel Xeon with AMX / AVX-512 bf16, 15 GB RAM; torch 2.15 CPU)

LoRA r=32 on all attention and MLP projections, random tokens, forward + backward + AdamW step, best of 3.

| Model | Mode | Seq x batch | Step | Tokens/s | Peak RSS |
|---|---|---|---|---|---|
| Qwen3-0.6B | fp32 | 768 x 2 | 10.67 s | 144 | 13.6 GB |
| Qwen3-0.6B | fp32 weights + bf16 autocast | 768 x 2 | 4.79 s | 321 | 13.1 GB |
| Qwen3-0.6B | bf16 weights | 768 x 2 | 4.67 s | 329 | 11.1 GB |
| Qwen3-0.6B | bf16 weights | 768 x 1 | 2.96 s | 260 | 6.6 GB |
| Qwen3.5-0.8B | bf16 weights (reference DeltaNet / conv kernels) | 768 x 1 | 5.80 s | 132 | 10.6 GB |

    python bench_lora_cpu.py Qwen/Qwen3-0.6B bf16w 768 1
    python bench_qwen35_cpu.py

The trainer (`codeply_iris/train.py`) uses batch 1 with accumulation, bf16 base weights, fp32 LoRA weights
under autocast, and applies the LM head only at answer positions.
