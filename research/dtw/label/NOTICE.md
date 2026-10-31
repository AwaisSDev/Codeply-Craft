# Third-party data used in the labelled training set

The training examples in `data/` are excerpts of the datasets below, relabelled
by Claude (Anthropic) in Codeply's memory schema. Each example records its
source (`source.dataset`, `licence`, `url`, `revision`, `file`, `sha256`,
`original_id`). The relabelled data is a derived work of these datasets and
keeps their terms.

* **WildChat-1M**, Allen Institute for AI. Licence: ODC-BY 1.0
  (https://opendatacommons.org/licenses/by/1-0/). Zhao et al., "WildChat:
  1M ChatGPT Interaction Logs in the Wild", ICLR 2024.
  https://huggingface.co/datasets/allenai/WildChat-1M (revision
  7d6490e462285cf85d91eabea0f9a954fbddcd1f). Conversations were
  de-identified by the publishers; Codeply's own redaction runs on every
  example before labelling.
* **MultiWOZ 2.2**, Zang et al., "MultiWOZ 2.2: A Dialogue Dataset with
  Additional Annotation Corrections and State Tracking Baselines", 2020.
  Licence: MIT, Copyright (c) 2019 Paweł Budzianowski.
  https://github.com/budzianowski/multiwoz
* **Topical-Chat**, Amazon.com, Inc. or its affiliates. Licence: Community
  Data License Agreement – Sharing – Version 1.0 (CDLA-Sharing-1.0).
  Gopalakrishnan et al., "Topical-Chat: Towards Knowledge-Grounded
  Open-Domain Conversations", Interspeech 2019.
  https://github.com/alexa/Topical-Chat. Under CDLA-Sharing, publishing this
  data (or modified data) must keep the same licence; models trained on it
  are "Results" and are not restricted.
* **Roman Urdu Data Set**, Zareen Sharf, UCI Machine Learning Repository
  (dataset 458). Licence: CC BY 4.0. https://archive.ics.uci.edu/dataset/458
