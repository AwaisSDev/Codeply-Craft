"""Label vocabularies and sizes, exactly as ARCHITECTURE-SPEC.md §2-§5 and §7 define them."""
from dataclasses import dataclass, field

# Brain vocabularies (codeply-cli/lib/brain.js:60-85, research/dtw/model/dtw_model.py)
KINDS = ["preference", "fact", "routine", "style", "decision", "idea", "requirement", "todo", "context"]
CERTS = ["stated", "implied", "temporary", "joking", "hypothetical", "quoting"]
IGNORED_CERTS = {"joking", "hypothetical", "quoting"}
# Attribute ontology: |A| = 100 classes + OTHER (spec §5.2). The class names are fixed in
# DATASET-DESIGN.md (Phase 4); until then the prototype uses positional placeholders.
ATTRS = [f"attr_{i:03d}" for i in range(100)] + ["OTHER"]
TTYPES = ["PLAN", "TASK", "CONTEXT", "REFERENCE", "FRAME", "PENDING"]
TTLS = ["SESSION", "UNTIL", "OPEN"]
ROUTE3 = ["TEMP", "IGNORE", "FORGET"]
RELS = ["SAME", "UPDATE", "CORRECTION", "CONTRADICTION"]
STATUSES = ["confirmed", "tentative", "locked"]
BIO = ["O", "B", "I"]
GROUPS = ["temp", "profile", "attribute", "value"]

N_REC_KIND = len(KINDS) + 1     # + "unknown" (spec §7: rec_kind table has |KINDS|+1 rows)
N_REC_AGE, N_REC_EV, N_TEMP_AGE, N_DT = 12, 8, 8, 16
MAX_TEMP_DAYS = 14              # brain.js MAX_TEMP_HOURS = 24 * 14


@dataclass
class PasteConfig:
    backbone: str = "ettin-encoder-32m"
    d: int = 384
    layers: int = 10
    heads: int = 6
    ff: int = 576
    vocab: int = 50368
    local_window: int = 128          # ModernBERT local_attention (total); half-window 64
    global_every: int = 3
    rope_theta_global: float = 160000.0
    rope_theta_local: float = 160000.0
    norm_eps: float = 1e-5
    r_mem: int = 4                   # recurrent memory tokens
    t_max: int = 8                   # temporary items
    e_max: int = 16                  # profiles
    k_max: int = 32                  # records passed per call (H4 measures beyond this)
    seg_max: int = 256               # segment tokens
    addr_heads: int = 4              # H_a
    addr_dim: int = 64               # d_a
    ptr_dim: int = 128               # source / temporary / mention pointers
    window: int = 16                 # +-16 token context window in the unit query
    merge_cross_pairs: int = 32      # cross-profile merge candidates (spec §5.10)
    init_std: float = 0.02
    head_norm: bool = False          # D2 pilot choice: parameter-free LayerNorm on encoder outputs read by heads
    thresholds: dict = field(default_factory=lambda: {
        "write": 0.5, "forget": 0.5, "retrieve": 0.5, "merge": 0.5, "expire": 0.5})

    @staticmethod
    def for_backbone(name: str) -> "PasteConfig":
        if name == "ettin-encoder-32m":
            return PasteConfig()
        if name == "ettin-encoder-17m":
            return PasteConfig(backbone=name, d=256, layers=7, heads=4, ff=384)
        raise ValueError(name)

    def is_global(self, layer: int) -> bool:
        return layer % self.global_every == 0
