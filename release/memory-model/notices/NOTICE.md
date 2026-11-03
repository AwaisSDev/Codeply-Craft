# NOTICE: Codeply memory model v1 (`codeply-memory-lfm3-v1-Q4_K_M.gguf`)

Ship this file and `LFM-OPEN-LICENSE-v1.0.txt` with the model file, in
every channel (private or public). Draft: wording to be confirmed by counsel
(`LEGAL-AND-PRIVACY-QUESTIONS.md`, A2 and B2).

## Base model

This model is a Derivative Work of **LFM3-1.7B** by Liquid AI, licensed
under the **LFM Open License v1.0** (copy enclosed;
`LFM-OPEN-LICENSE-v1.0.txt`, fetched from
`huggingface.co/LiquidAI/LFM3-1.7B` at revision
`ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7`, SHA-256
`4d28ca14dedc0b3d0fcc2b3339f0e79931faa33874f3d24f522183a8fc70068c`).
Commercial use is subject to the licence's Section 5 (revenue threshold).

**Modified by Codeply:** the weights were changed by LoRA fine-tuning for
memory extraction, merged into the base weights, converted to GGUF and
quantized to Q4_K_M with an importance matrix.

## Training data

This model was trained on data that contains information from:

* **WildChat-1M** (Allen Institute for AI), made available under the Open
  Data Commons Attribution License (ODC-BY 1.0),
  https://huggingface.co/datasets/allenai/WildChat-1M
* **MultiWOZ 2.2**, MIT License
* **Topical-Chat** (Amazon), Community Data License Agreement – Sharing 1.0
* **Roman Urdu Data Set** (UCI Machine Learning Repository), CC BY 4.0

Training labels were generated with Claude (Anthropic).
